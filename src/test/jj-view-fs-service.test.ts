/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { JjViewFsService } from '../core/jj-view-fs-service';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('JjViewFsService Unit Tests', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let service: JjViewFsService;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, host);

        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        service = new JjViewFsService(repoManager);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        service.dispose();
        await repoManager.dispose();
        await repo.dispose();
    });

    it.each([
        'revision',
        'diff',
    ])('propagates %s read failures instead of returning an empty document', async (mode) => {
        const query = mode === 'revision' ? 'revision=invalid-revision' : 'base=invalid-revision&side=left';
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&${query}`,
        });
        await expect(service.readFile(uri)).rejects.toThrow();
    });

    it.each(['revision', 'diff'])('preserves a genuinely missing or empty file in %s mode', async (mode) => {
        const nodes = await buildGraph(repo, [{ label: 'initial', files: { 'empty.txt': '' } }]);
        const query =
            mode === 'revision' ? `revision=${nodes.initial.changeId}` : `base=${nodes.initial.changeId}&side=right`;
        for (const filename of ['empty.txt', 'missing.txt']) {
            const uri = Uri.from({
                scheme: 'jj-view',
                path: `/${filename}`,
                fragment: `root=${encodeURIComponent(repo.path)}&${query}`,
            });
            expect(await service.readFile(uri)).toEqual(new Uint8Array());
        }
    });

    it('retries concurrent virtual diff reads after repository and provider invalidation', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', files: { 'f.txt': 'before\n' } },
            { label: 'child', parents: ['initial'], files: { 'f.txt': 'after\n' } },
        ]);
        const repository = repoManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository was not registered');
        }
        const read = repository.jj.system.fs.readTextFile.bind(repository.jj.system.fs);
        let invalidated = false;
        vi.spyOn(repository.jj.system.fs, 'readTextFile').mockImplementation(async (file) => {
            if (!invalidated && file.endsWith('f.txt')) {
                invalidated = true;
                await repository.jj.clearCache();
                service.invalidateCache();
            }
            return read(file);
        });
        const uris = ['left', 'right'].map((side) =>
            Uri.from({
                scheme: 'jj-view',
                path: '/f.txt',
                fragment: `root=${encodeURIComponent(repo.path)}&base=${nodes.child.changeId}&side=${side}`,
            }),
        );
        const contents = await Promise.all(uris.map((uri) => service.readFile(uri)));
        expect(invalidated).toBe(true);
        expect(contents.map((content) => new TextDecoder().decode(content))).toEqual(['before\n', 'after\n']);
    });

    it('throws error when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-view:///outside/file.txt#root=/outside&revision=@');
        await expect(service.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('reads file content at a specific revision', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'version 1' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const bytes = await service.readFile(uri);
        expect(Buffer.from(bytes).toString('utf8')).toBe('version 1');
    });

    it('invalidates cache and emits onDidChangeFile', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'initial content' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        await service.readFile(uri);

        let firedUris: Uri[] = [];
        service.onDidChangeFile((uris) => {
            firedUris = uris;
        });

        const invalidated = service.invalidateCache();
        expect(invalidated.length).toBe(1);
        expect(firedUris.length).toBe(1);
        expect(firedUris[0].toString()).toBe(uri.toString());

        // A second invalidation without new reads or watchers should not fire
        firedUris = [];
        const secondInvalidation = service.invalidateCache();
        expect(secondInvalidation.length).toBe(0);
        expect(firedUris.length).toBe(0);
    });

    it('watch keeps URI notified across repeated cache invalidations', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'initial content' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const watcher = service.watch(uri);

        let fireCount = 0;
        service.onDidChangeFile(() => {
            fireCount++;
        });

        service.invalidateCache();
        expect(fireCount).toBe(1);

        service.invalidateCache();
        expect(fireCount).toBe(2);

        watcher.dispose();

        service.invalidateCache();
        expect(fireCount).toBe(2);
    });

    it('watch disposable is idempotent and does not prematurely unwatch shared URIs', async () => {
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const watcher1 = service.watch(uri);
        const watcher2 = service.watch(uri);

        let fireCount = 0;
        service.onDidChangeFile(() => {
            fireCount++;
        });

        // Dispose watcher 1 multiple times
        watcher1.dispose();
        watcher1.dispose();

        // Watcher 2 is still active, so invalidateCache should still notify uri
        service.invalidateCache();
        expect(fireCount).toBe(1);

        watcher2.dispose();
        service.invalidateCache();
        expect(fireCount).toBe(1);
    });

    it('stat returns monotonic mtime advancing on invalidateCache', () => {
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const statBefore = service.stat(uri);
        expect(statBefore.type).toBe(1);
        expect(statBefore.mtime).toBeGreaterThan(1700000000000 - 1);

        service.invalidateCache();
        const statAfter = service.stat(uri);
        expect(statAfter.mtime).toBe(statBefore.mtime + 1);
    });

    it('concurrent left and right diff reads resolve correct contents', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'v1\n' } },
            { label: 'second', description: 'second', parents: ['initial'], files: { 'f.txt': 'v2\n' } },
        ]);

        const leftUri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&base=${nodes.second.changeId}&side=left`,
        });
        const rightUri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&base=${nodes.second.changeId}&side=right`,
        });

        const [leftBytes, rightBytes] = await Promise.all([service.readFile(leftUri), service.readFile(rightUri)]);

        expect(Buffer.from(leftBytes).toString('utf8')).toBe('v1\n');
        expect(Buffer.from(rightBytes).toString('utf8')).toBe('v2\n');
    });
});
