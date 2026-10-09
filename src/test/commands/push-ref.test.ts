/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeService } from '../../core/code-forge-service';
import { createPushRefPayload, pushRefCommand, pushRefToRemoteCommand } from '../../core/commands/push-ref';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('badge ref push', () => {
    let repo: TestRepo;
    let jj: JjService;
    let ctx: FakeCommandContext;
    let remotes: TestRepo[];

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        repo.writeFile('file.txt', 'content');
        repo.describe('push target');
        jj = new JjService(repo.path, NO_OP_LOGGER);
        ctx = new FakeCommandContext(
            createMock<JjRepository>({
                jj,
                refresh: vi.fn().mockResolvedValue(undefined),
                codeForge: createMock<CodeForgeService>({ requestRefreshWithBackoffs: vi.fn() }),
            }),
        );
        remotes = [];
    });

    afterEach(async () => {
        await repo.dispose();
        for (const remote of remotes) {
            await remote.dispose();
        }
    });

    function addRemote(name: string): TestRepo {
        const remote = new TestRepo();
        remote.init();
        remotes.push(remote);
        repo.addRemote(name, remote.path);
        return remote;
    }

    test.each(['bookmark', 'tag'] as const)('pushes only the selected %s to the sole remote', async (kind) => {
        const remote = addRemote('upstream');
        repo.bookmark('release', '@');
        repo.bookmark('other', '@');
        repo.tag('release', '@');
        repo.tag('other', '@');
        await pushRefCommand(ctx, { kind, name: 'release' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
        expect(
            remote.listGitRefs().filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')),
        ).toEqual([kind === 'bookmark' ? 'refs/heads/release' : 'refs/tags/release']);
        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
        expect(ctx.repo.refresh).toHaveBeenCalled();
    });

    test.each([
        'bookmark',
        'tag',
    ] as const)('prefers the unique existing remote for a %s over origin or git.push', async (kind) => {
        const upstream = addRemote('upstream');
        const origin = addRemote('origin');
        repo.config('git.push', '"origin"');
        repo.bookmark('release', '@');
        repo.tag('release', '@');
        await jj.upload(
            undefined,
            'git',
            'push',
            '--remote',
            'upstream',
            kind === 'bookmark' ? '--bookmark' : '--tag',
            'exact:release',
        );
        repo.describe('push target after initial push');
        repo.new();
        repo.writeFile('next.txt', 'next');
        repo.describe('next target');
        if (kind === 'bookmark') {
            repo.bookmarkMove('release', '@');
        } else {
            repo.tagMove('release', '@');
        }
        await pushRefCommand(ctx, { kind, name: 'release' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
        expect(origin.listGitRefs('refs/heads/')).toEqual([]);
        expect(
            upstream.listGitRefs().filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')),
        ).toHaveLength(1);
        expect(ctx.host.ui.infoMessages).toContain(`Pushed ${kind} "release" to upstream.`);
    });

    test.each([
        'bookmark',
        'tag',
    ] as const)('asks when several remotes hold the same %s and cancellation does nothing', async (kind) => {
        addRemote('origin');
        addRemote('upstream');
        repo.bookmark('release', '@');
        repo.tag('release', '@');
        for (const remote of ['origin', 'upstream']) {
            await jj.trackRef(kind, 'release', remote);
            await jj.upload(
                undefined,
                'git',
                'push',
                '--remote',
                remote,
                kind === 'bookmark' ? '--bookmark' : '--tag',
                'exact:release',
            );
        }
        await pushRefCommand(ctx, { kind, name: 'release' });
        expect(ctx.host.ui.quickPickCalls[0].items.map((item) => item.description)).toEqual([
            `Has this ${kind}`,
            `Has this ${kind}`,
        ]);
        expect(ctx.repo.refresh).not.toHaveBeenCalled();
    });

    test('asks for a destination for a new bookmark in a multi-remote repository', async () => {
        const origin = addRemote('origin');
        const upstream = addRemote('upstream');
        repo.bookmark('release', '@');
        ctx.host.ui.setNextQuickPickResponse({ label: 'upstream', value: 'upstream' });
        await pushRefCommand(ctx, { kind: 'bookmark', name: 'release' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
        expect(ctx.host.ui.quickPickCalls[0].items).toContainEqual({
            label: 'upstream',
            value: 'upstream',
            description: 'New bookmark',
            detail: upstream.path.replaceAll('\\', '/'),
        });
        expect(origin.listGitRefs('refs/heads/')).toEqual([]);
        expect(
            upstream.listGitRefs().filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')),
        ).toEqual(['refs/heads/release']);
    });

    test('explicit remote selection always prompts even with a sole remote', async () => {
        const remote = addRemote('origin');
        repo.tag('release', '@');
        ctx.host.ui.setNextQuickPickResponse({ label: 'origin', value: 'origin' });
        await pushRefToRemoteCommand(ctx, { kind: 'tag', name: 'release' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(
            remote.listGitRefs().filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')),
        ).toEqual(['refs/tags/release']);
    });

    test.each(['bookmark', 'tag'] as const)('adds a chosen destination for an existing %s', async (kind) => {
        const origin = addRemote('origin');
        const upstream = addRemote('upstream');
        repo.bookmark('release', '@');
        repo.tag('release', '@');
        await jj.upload(
            undefined,
            'git',
            'push',
            '--remote',
            'origin',
            kind === 'bookmark' ? '--bookmark' : '--tag',
            'exact:release',
        );
        ctx.host.ui.setNextQuickPickResponse({ label: 'upstream', value: 'upstream' });
        await pushRefToRemoteCommand(ctx, { kind, name: 'release' });
        expect(ctx.host.ui.errorMessages).toEqual([]);
        const prefix = kind === 'bookmark' ? 'refs/heads/' : 'refs/tags/';
        expect(origin.listGitRefs(prefix)).toEqual([`${prefix}release`]);
        expect(upstream.listGitRefs(prefix)).toEqual([`${prefix}release`]);
        expect(ctx.host.ui.infoMessages).toContain(`Pushed ${kind} "release" to upstream.`);
    });

    test('reports no remotes and does not refresh', async () => {
        repo.bookmark('release', '@');
        await pushRefCommand(ctx, { kind: 'bookmark', name: 'release' });
        expect(ctx.host.ui.infoMessages).toContain('No Git remotes configured.');
        expect(ctx.repo.refresh).not.toHaveBeenCalled();
    });

    test('rejects stale local badges and ignores remote badges', async () => {
        const remote = addRemote('origin');
        await pushRefCommand(ctx, { kind: 'tag', name: 'missing' });
        repo.tag('release', '@');
        await pushRefCommand(ctx, { kind: 'tag', name: 'release', isRemote: true });
        expect(ctx.host.ui.infoMessages).toContain('Local tag "missing" no longer exists.');
        expect(
            remote.listGitRefs().filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')),
        ).toEqual([]);
        expect(ctx.repo.refresh).not.toHaveBeenCalled();
    });

    test('reports a push failure without refreshing or reporting success', async () => {
        addRemote('origin');
        repo.bookmark('release', '@');
        repo.describe('');
        await pushRefCommand(ctx, { kind: 'bookmark', name: 'release' });
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to push bookmark');
        expect(ctx.host.ui.infoMessages).toEqual([]);
        expect(ctx.repo.refresh).not.toHaveBeenCalled();
    });

    test('extracts the badge ref rather than an inherited revision', () => {
        expect(
            createPushRefPayload([
                { webviewSection: 'jj.tag', tagName: 'release', changeId: 'other', bookmarkName: 'inherited' },
            ]),
        ).toEqual({ kind: 'tag', name: 'release', isRemote: false });
        expect(
            createPushRefPayload([{ webviewSection: 'jj.bookmark', bookmarkName: 'release', isRemoteBookmark: true }]),
        ).toEqual({ kind: 'bookmark', name: 'release', isRemote: true });
        expect(createPushRefPayload([{ changeId: 'other' }])).toEqual({});
    });
});
