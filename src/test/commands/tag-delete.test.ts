/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deleteTagCommand } from '../../core/commands/tag-delete';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('deleteTagCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('deletes specified tag directly from payload', async () => {
        repo.tag('feature-1', '@');
        expect(await jj.getTags()).toContain('feature-1');

        await deleteTagCommand(ctx, { tagName: 'feature-1' });

        expect(await jj.getTags()).not.toContain('feature-1');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after tag delete' });
        expect(ctx.host.commands.executedCommands).toContainEqual({ commandId: 'jj-view.refreshGraph', args: [] });
        expect(ctx.host.ui.infoMessages[0]).toContain('Deleted tag "feature-1".');
    });

    test('prompts for tag when tagName is omitted', async () => {
        repo.tag('feature-1', '@');
        repo.tag('feature-2', '@');

        ctx.host.ui.setNextQuickPickResponse({ label: 'feature-1', value: 'feature-1' });

        await deleteTagCommand(ctx, {});

        expect(await jj.getTags()).not.toContain('feature-1');
        expect(await jj.getTags()).toContain('feature-2');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after tag delete' });
        expect(ctx.host.commands.executedCommands).toContainEqual({ commandId: 'jj-view.refreshGraph', args: [] });
    });

    test('shows information message when no local tags exist', async () => {
        await deleteTagCommand(ctx, {});

        expect(ctx.host.ui.infoMessages[0]).toContain('No tags to delete.');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('does nothing if user cancels tag selection prompt', async () => {
        repo.tag('feature-1', '@');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await deleteTagCommand(ctx, {});

        expect(await jj.getTags()).toContain('feature-1');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('handles errors during tag deletion and displays error', async () => {
        const brokenJj = new JjService(repo.path, NO_OP_LOGGER, { binaryPath: '/non/existent/jj' });
        const brokenRepo = createMock<JjRepository>({
            jj: brokenJj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const brokenCtx = new FakeCommandContext(brokenRepo);

        await deleteTagCommand(brokenCtx, { tagName: 'feature-1' });

        expect(brokenCtx.host.ui.errorMessages).toHaveLength(1);
        expect(brokenCtx.host.ui.errorMessages[0]).toContain('Failed to delete tag');
    });
});
