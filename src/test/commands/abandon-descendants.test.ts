/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { abandonDescendantsCommand } from '../../core/commands/abandon-descendants';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('abandonDescendantsCommand', () => {
    let repo: TestRepo;
    let ctx: FakeCommandContext;
    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        ctx = new FakeCommandContext(createMock<JjRepository>({
            jj: new JjService(repo.path, NO_OP_LOGGER),
            rootUri: Uri.file(repo.path), refresh: vi.fn().mockResolvedValue(undefined),
        }));
    });
    afterEach(() => repo.dispose());
    test('abandons the root and descendants while preserving siblings', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A' }, { label: 'B', parents: ['A'] },
            { label: 'sibling' }, { label: 'C', parents: ['B'], isCurrentWorkingCopy: true },
        ]);
        ctx.host.ui.setNextWarningResponse('Abandon');
        await abandonDescendantsCommand(ctx, { revisions: [graph.A.changeId] });
        const visible = repo.getLog('all()', 'change_id');
        for (const label of ['A', 'B', 'C']) expect(visible).not.toContain(graph[label].changeId);
        expect(visible).toContain(graph.sibling.changeId);
    });
    test('cancellation preserves all revisions', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A' }, { label: 'B', parents: ['A'], isCurrentWorkingCopy: true },
        ]);
        await abandonDescendantsCommand(ctx, { revisions: [graph.A.changeId] });
        const visible = repo.getLog('all()', 'change_id');
        expect(visible).toContain(graph.A.changeId);
        expect(visible).toContain(graph.B.changeId);
    });
});
