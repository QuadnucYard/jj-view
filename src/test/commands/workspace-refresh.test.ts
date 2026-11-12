/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { workspaceRefreshCommand } from '../../core/commands/workspace-refresh';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('workspaceRefreshCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let ctx: FakeCommandContext;
    const refresh = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        ctx = new FakeCommandContext(createMock<JjRepository>({ jj, refresh }));
    });

    afterEach(async () => {
        vi.clearAllMocks();
        await repo.dispose();
    });

    test('snapshots only the target workspace and invalidates cached changes', async () => {
        const target = repo.workspaceAdd('feature');
        const other = repo.workspaceAdd('other');
        const mainId = repo.getLog('@', 'commit_id');
        const otherId = repo.getLog('other@', 'commit_id');
        expect(await jj.getChanges('feature@')).toEqual([]);
        fs.writeFileSync(path.join(target.path, 'target.txt'), 'target edit');
        fs.writeFileSync(path.join(other.path, 'other.txt'), 'other edit');
        fs.writeFileSync(path.join(repo.path, 'main.txt'), 'main edit');

        await workspaceRefreshCommand(ctx, { workspaceName: 'feature' });

        expect((await jj.getChanges('feature@')).map((change) => change.path)).toContain('target.txt');
        expect(repo.getLog('@', 'commit_id')).toBe(mainId);
        expect(repo.getLog('other@', 'commit_id')).toBe(otherId);
        expect(refresh).toHaveBeenCalledWith({ reason: 'workspace refresh command' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
    });

    test('refreshes the workspace selected from the picker', async () => {
        const target = repo.workspaceAdd('feature');
        fs.writeFileSync(path.join(target.path, 'target.txt'), 'target edit');
        ctx.host.ui.setNextQuickPickResponse({ label: 'feature', description: target.path });

        await workspaceRefreshCommand(ctx);

        expect(repo.listFiles('feature@')).toContain('target.txt');
        expect(refresh).toHaveBeenCalledOnce();
    });

    test('does nothing when selection is cancelled', async () => {
        const target = repo.workspaceAdd('feature');
        const targetId = repo.getLog('feature@', 'commit_id');
        fs.writeFileSync(path.join(target.path, 'target.txt'), 'pending');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await workspaceRefreshCommand(ctx);

        expect(repo.getLog('feature@', 'commit_id')).toBe(targetId);
        expect(refresh).not.toHaveBeenCalled();
    });

    test('reports an unavailable workspace without refreshing another workspace', async () => {
        const mainId = repo.getLog('@', 'commit_id');
        fs.writeFileSync(path.join(repo.path, 'main.txt'), 'pending');

        await workspaceRefreshCommand(ctx, { workspaceName: 'missing' });

        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to refresh workspace "missing"');
        expect(repo.getLog('@', 'commit_id')).toBe(mainId);
        expect(refresh).not.toHaveBeenCalled();
    });
});
