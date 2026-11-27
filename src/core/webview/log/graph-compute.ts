/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type Ancestor, GraphRowRenderer, NodeLine } from 'renderdag-ts';
import type { JjLogEntry } from '../../jj-types';
import { getColor } from '../themes.generated';
import type { GraphEdge, GraphLayout, GraphNode, GraphPoint, GraphRow } from './graph-model';
import { isElisionRow } from './graph-model';

function cleanupPoints(points: GraphPoint[]): GraphPoint[] {
    if (points.length <= 2) {
        return points;
    }
    const result: GraphPoint[] = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const prev = result[result.length - 1];
        const curr = points[i];
        const next = points[i + 1];

        const isCollinear = (prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y);

        if (!isCollinear) {
            result.push(curr);
        }
    }
    result.push(points[points.length - 1]);
    return result;
}

interface ActiveEdge {
    edge: GraphEdge;
    targetChangeId: string;
    currentLane: number;
    maxLane: number;
}

interface LayoutRow {
    row: GraphRow;
    id: string;
    parentIds: string[];
}

function buildLayoutRows(commits: JjLogEntry[]): LayoutRow[] {
    const layoutRows: LayoutRow[] = [];

    for (const commit of commits) {
        const parentChangeIds = commit.parents.map((parent) => parent.change_id);
        const directParents = new Set(parentChangeIds);
        const parents = commit.nearest_visible_ancestors ?? parentChangeIds;
        const elisions: LayoutRow[] = [];
        const parentIds = parents.map((parentId) => {
            if (directParents.has(parentId)) {
                return parentId;
            }
            const id = `elided-${parentId}`;
            elisions.push({ row: { type: 'elision', targetId: parentId }, id, parentIds: [parentId] });
            return id;
        });

        if (parents.length === 0 && directParents.size > 0) {
            // Reserve a row for the marker before the lane is reused by another commit.
            const id = `elided-${commit.change_id}-termination`;
            parentIds.push(id);
            elisions.push({ row: { type: 'elision' }, id, parentIds: [] });
        }

        layoutRows.push({ row: commit, id: commit.change_id, parentIds }, ...elisions);
    }

    return layoutRows;
}

/**
 * Computes the graph layout using renderdag-ts.
 * We use a single coordinate system where each commit i spans one row with fractional links:
 * - nodeY = i (Node placement row)
 * - linkY = i + 0.5 (Link/Transition row)
 */
export function computeGraphLayout(commits: JjLogEntry[], themeName: string = 'default'): GraphLayout {
    const headLog = commits.find((l) => l.is_current_working_copy);
    const headId = headLog ? headLog.change_id : '';

    const layoutRows = buildLayoutRows(commits);

    const renderer = new GraphRowRenderer<string>();

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const terminations: { x: number; y: number }[] = [];
    let activeEdges: ActiveEdge[] = [];
    let maxColumns = 0;

    layoutRows.forEach(({ row, id: changeId, parentIds }, rowIndex) => {
        const nodeY = rowIndex;
        const linkY = rowIndex + 0.5;
        const isElision = isElisionRow(row);
        const glyph = isElision ? '' : changeId === headId ? '@' : '○';
        const message = isElision ? '' : row.description || '';
        const renderParents = parentIds.map((id): Ancestor<string> => ({ type: 'Parent', id }));

        const rowData = renderer.nextRow(changeId, renderParents, glyph, message);
        maxColumns = Math.max(maxColumns, renderer.activeColumns ? renderer.activeColumns.length : 0);

        // 1. Determine current node position
        const nodeLane = rowData.nodeLine.indexOf(NodeLine.Node);
        if (nodeLane === -1) {
            return;
        }

        const nodeColor = getColor(nodeLane, themeName);
        if (isElision) {
            terminations.push({ x: nodeLane, y: nodeY });
        } else {
            nodes.push({
                commitId: row.commit_id,
                changeId: row.change_id,
                x: nodeLane,
                y: nodeY,
                color: nodeColor,
                isCurrentWorkingCopy: !!row.is_current_working_copy,
                workingCopies: row.working_copies,
                conflict: row.conflict,
                isEmpty: row.is_empty,
                isImmutable: row.is_immutable,
                isHidden: row.is_hidden,
            });
        }

        // 2. Process vertical segments through the node row (nodeY)
        activeEdges.forEach((ae) => {
            ae.edge.points.push({ type: 'node', x: ae.currentLane, y: nodeY });
        });

        // 3. Finish incoming edges or route them through an elision to a visible ancestor.
        activeEdges = activeEdges.filter((ae) => {
            if (ae.targetChangeId !== changeId) {
                return true;
            }
            if (ae.currentLane !== nodeLane) {
                ae.edge.points.push({ type: 'node', x: nodeLane, y: nodeY });
                ae.currentLane = nodeLane;
                ae.maxLane = Math.max(ae.maxLane, nodeLane);
                ae.edge.color = getColor(ae.maxLane, themeName);
            }
            if (isElision && row.targetId) {
                ae.targetChangeId = row.targetId;
                return true;
            }
            edges.push(ae.edge);
            return false;
        });

        // 4. Process horizontal segments and transitions in the link row (linkY)
        const nextActiveColumns = renderer.activeColumns;

        activeEdges.forEach((ae) => {
            const nextLane = nextActiveColumns.findIndex(
                (col) =>
                    (col.type === 'Parent' || col.type === 'Ancestor' || col.type === 'Reserved') &&
                    col.id === ae.targetChangeId,
            );

            if (nextLane !== -1) {
                if (nextLane !== ae.currentLane) {
                    ae.edge.points.push({ type: 'link', x: ae.currentLane, y: linkY });
                    ae.edge.points.push({ type: 'link', x: nextLane, y: linkY });
                    ae.currentLane = nextLane;
                    ae.maxLane = Math.max(ae.maxLane, nextLane);
                    ae.edge.color = getColor(ae.maxLane, themeName);
                } else {
                    ae.edge.points.push({ type: 'link', x: ae.currentLane, y: linkY });
                }
            }
        });

        // 5. Spawn new edges for parents (only for real commits!)
        if (!isElision) {
            parentIds.forEach((pId) => {
                const pLane = nextActiveColumns.findIndex(
                    (col) =>
                        (col.type === 'Parent' || col.type === 'Ancestor' || col.type === 'Reserved') && col.id === pId,
                );

                if (pLane !== -1) {
                    const maxLane = Math.max(nodeLane, pLane);
                    const color = getColor(maxLane, themeName);

                    const newEdge: GraphEdge = {
                        id: `${changeId}->${pId}`,
                        type: 'parent',
                        color,
                        isElided: pId.startsWith('elided-'),
                        points: [
                            { type: 'node', x: nodeLane, y: nodeY },
                            { type: 'link', x: nodeLane, y: linkY },
                            { type: 'link', x: pLane, y: linkY },
                        ],
                    };

                    activeEdges.push({
                        edge: newEdge,
                        targetChangeId: pId,
                        currentLane: pLane,
                        maxLane,
                    });
                }
            });
        }
    });

    // Terminate remaining active edges (history continues below)
    activeEdges.forEach((ae) => {
        ae.edge.points.push({ type: 'node', x: ae.currentLane, y: layoutRows.length });
        ae.maxLane = Math.max(ae.maxLane, ae.currentLane);
        ae.edge.color = getColor(ae.maxLane, themeName);
        edges.push(ae.edge);
    });

    const cleanedEdges = edges.map((e) => ({
        ...e,
        points: cleanupPoints(e.points),
    }));

    const width = Math.max(
        maxColumns,
        nodes.reduce((max, n) => Math.max(max, n ? n.x + 1 : 0), 0),
    );

    return {
        nodes,
        edges: cleanedEdges,
        terminations,
        width,
        height: layoutRows.length,
        rows: layoutRows.map(({ row }) => row),
    };
}
