/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTagCommand } from '../../core/commands/tag-create';
import { createCreateTagPayload } from '../../core/commands/tag-payload';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { ScopedTestRepo, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('createTagCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj, refresh: vi.fn().mockResolvedValue(undefined) });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => vi.clearAllMocks());

    test('creates a prompted tag at the selected revision and refreshes the graph', async () => {
        repo.describe('tag target');
        const revision = repo.getChangeId('@');
        repo.new();
        ctx.host.ui.setNextInputBoxResponse('  release  ');
        await createTagCommand(ctx, createCreateTagPayload([{ changeId: revision }]));
        expect(repo.getChangeId('release')).toBe(revision);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after tag create' });
        expect(ctx.host.commands.executedCommands).toContainEqual({ commandId: 'jj-view.refreshGraph', args: [] });
    });

    test('creates a tag using an explicit trimmed payload name', async () => {
        const revision = repo.getChangeId('@');
        await createTagCommand(ctx, createCreateTagPayload([{ changeId: revision, tagName: '  release  ' }]));
        expect(repo.getChangeId('release')).toBe(revision);
    });

    test('does nothing when the prompt is cancelled or blank', async () => {
        for (const response of [undefined, '   ']) {
            ctx.host.ui.setNextInputBoxResponse(response);
            await createTagCommand(ctx, { revision: repo.getChangeId('@') });
        }
        expect(await jj.getTags()).toEqual([]);
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('does nothing without a target revision', async () => {
        await createTagCommand(ctx, { tagName: 'release' });
        expect(await jj.getTags()).toEqual([]);
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('rejects duplicate local tags without moving their targets', async () => {
        repo.tag('release', '@');
        const original = repo.getChangeId('release');
        repo.new();
        await createTagCommand(ctx, { revision: repo.getChangeId('@'), tagName: 'release' });
        expect(repo.getChangeId('release')).toBe(original);
        expect(ctx.host.ui.errorMessages).toContain('A local tag with this name already exists.');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('service refuses to move an existing tag during creation', async () => {
        repo.tag('release', '@');
        const original = repo.getChangeId('release');
        repo.new();
        await expect(jj.createTag('release', repo.getChangeId('@'))).rejects.toThrow();
        expect(repo.getChangeId('release')).toBe(original);
    });

    test('allows a new local tag with the same name as a remote-only tag', async () => {
        using remote = new ScopedTestRepo();
        remote.init();
        remote.describe('remote release');
        remote.tag('release', '@');
        repo.addRemote('origin', remote.path);
        repo.fetchTags('origin');
        repo.trackTag('release', 'origin');
        await jj.deleteTag('release');
        const revision = repo.getChangeId('@');
        await createTagCommand(ctx, { revision, tagName: 'release' });
        expect(repo.getChangeId('release')).toBe(revision);
        expect(await jj.getTags()).toContainEqual({ name: 'release', remote: 'origin' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
    });

    test('reports creation failures without refreshing', async () => {
        await createTagCommand(ctx, { revision: 'missing-revision', tagName: 'release' });
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to create tag');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });
});
