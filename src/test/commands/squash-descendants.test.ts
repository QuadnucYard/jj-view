/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { squashDescendantsCommand } from '../../core/commands/squash-descendants';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
let repo: TestRepo;
let ctx: FakeCommandContext;
beforeEach(() => {
    repo = new TestRepo(); repo.init();
    ctx = new FakeCommandContext(createMock<JjRepository>({
        jj: new JjService(repo.path, NO_OP_LOGGER), rootUri: Uri.file(repo.path),
        refresh: vi.fn().mockResolvedValue(undefined),
    }));
});
afterEach(() => repo.dispose());
test('squashes descendant content into the root and preserves its description', async () => {
    const ids = await buildGraph(repo, [
        { label: 'A', description: 'keep this', files: { 'a.txt': 'root' } },
        { label: 'B', parents: ['A'], files: { 'b.txt': 'child' } },
        { label: 'C', parents: ['B'], files: { 'c.txt': 'grandchild' }, isCurrentWorkingCopy: true },
    ]);
    ctx.host.ui.setNextWarningResponse('Squash');
    await squashDescendantsCommand(ctx, { revisions: [ids.A.changeId] });
    expect(ctx.host.ui.errorMessages).toEqual([]);
    expect(repo.getFileContent(ids.A.changeId, 'b.txt')).toBe('child');
    expect(repo.getFileContent(ids.A.changeId, 'c.txt')).toBe('grandchild');
    expect(await ctx.repo.jj.getDescription(ids.A.changeId)).toBe('keep this');
    expect(repo.getLog('all()', 'change_id')).not.toContain(ids.B.changeId);
    expect(repo.getLog('all()', 'change_id')).not.toContain(ids.C.changeId);
});
test('a leaf revision does not prompt or mutate', async () => {
    repo.new([], 'leaf'); const id = repo.getChangeId('@');
    ctx.host.ui.setNextWarningResponse('Squash');
    await squashDescendantsCommand(ctx, { revisions: [id] });
    expect(ctx.host.ui.warningMessages).toEqual([]);
    expect(repo.getLog('all()', 'change_id')).toContain(id);
});
test('rejects an immutable destination before showing confirmation', async () => {
    repo.new([], 'mutable child'); const id = repo.getChangeId('@');
    ctx.host.ui.setNextWarningResponse('Squash');
    await squashDescendantsCommand(ctx, { revisions: ['root()'] });
    expect(ctx.host.ui.warningMessages).toEqual([]);
    expect(ctx.host.ui.errorMessages).toHaveLength(1);
    expect(repo.getLog('all()', 'change_id')).toContain(id);
});
