/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';
import { getFsPathFromUri, getRevisionFromUri, type Uri } from '../uri-utils';

export interface SquashHunkIntoParentPayload {
    uri?: Uri;
    ranges?: { startLine: number; endLine: number }[];
    revision?: string;
}

export interface SquashSelectionIntoParentPayload {
    uri?: Uri;
    ranges?: { startLine: number; endLine: number }[];
    revision?: string;
}

export interface SquashSelectionIntoAncestorPayload extends SquashSelectionIntoParentPayload {
    ancestorRevision?: string;
}

export async function squashSelectionIntoAncestorCommand(
    ctx: CommandContext, payload?: SquashSelectionIntoAncestorPayload,
): Promise<void> {
    if (!payload?.uri || !payload.ranges?.length) return;
    const revision = payload.revision || getRevisionFromUri(payload.uri) || '@';
    try {
        const ancestor = payload.ancestorRevision ?? await promptForRevision(ctx.host.ui, ctx.repo.jj, {
            placeHolder: 'Select which ancestor to squash into',
            revisionQuery: `${RevisionQuery.ancestorsExcluding(revision)} & mutable()`,
            repoRoot: ctx.repo.rootUri, nav: ctx.host.nav,
        });
        if (!ancestor) return;
        await ctx.host.documents.saveIfDirty(payload.uri);
        const relPath = path.relative(ctx.repo.jj.workspaceRoot, getFsPathFromUri(payload.uri));
        await ctx.repo.jj.squashSelectionIntoAncestor(relPath, payload.ranges, revision, ancestor);
        await ctx.repo.refresh({ reason: 'after squash selection into ancestor' });
        await ctx.host.commands.executeCommand('jj-view.refreshGraph');
    } catch (error: unknown) {
        await showJjError(ctx.host.ui, error, 'Failed to squash selection into ancestor', ctx.repo.jj, ctx.log);
    }
}

export async function squashHunkIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashHunkIntoParentPayload,
): Promise<void> {
    const uri = payload?.uri;
    const ranges = payload?.ranges;
    if (!uri || !ranges || ranges.length === 0) {
        return;
    }

    const relPath = path.relative(ctx.repo.jj.workspaceRoot, getFsPathFromUri(uri));
    const revision = payload?.revision || getRevisionFromUri(uri) || '@';

    try {
        await ctx.repo.jj.squashSelectionIntoParent(relPath, ranges, revision);
        await ctx.repo.refresh({ reason: 'after squash hunk into parent' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to squash hunk', ctx.repo.jj, ctx.log);
    }
}

export async function squashSelectionIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashSelectionIntoParentPayload,
): Promise<void> {
    const uri = payload?.uri;
    const ranges = payload?.ranges;
    if (!uri || !ranges || ranges.length === 0) {
        return;
    }

    const fsPath = getFsPathFromUri(uri);
    const relPath = path.relative(ctx.repo.jj.workspaceRoot, fsPath);
    const revision = payload?.revision || getRevisionFromUri(uri) || '@';

    try {
        await ctx.repo.jj.squashSelectionIntoParent(relPath, ranges, revision);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to squash selection', ctx.repo.jj, ctx.log);
    } finally {
        await ctx.repo.refresh({ reason: 'after squash selection into parent' });
    }
}
