/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('JjEditFsService Unit Tests', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let service: JjEditFsService;

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

        service = new JjEditFsService(repoManager);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        service.dispose();
        await repoManager.dispose();
        await repo.dispose();
    });

    it.each([
        { target: '@', state: 'queued' },
        { target: 'ancestor', state: 'queued' },
        { target: '@', state: 'completed' },
        { target: 'ancestor', state: 'completed' },
    ])('does not return a stale $target read after a newer save is $state', async ({ target, state }) => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', files: { 'file.txt': 'old source\n' } },
            { label: 'child', parents: ['initial'], files: { 'file.txt': 'working copy\n' } },
        ]);
        const revision = target === '@' ? '@' : nodes.initial.changeId;
        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: new URLSearchParams({ root: repo.path, revision }).toString(),
        });
        const repository = repoManager.getRepositoryForUri(uri);
        if (!repository) {
            throw new Error('Repository was not registered');
        }
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = () => {};
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let paused = false;
        const pause = async () => {
            if (!paused) {
                paused = true;
                entered();
                await blocked;
            }
        };
        const fs = repository.jj.system.fs;
        if (target === '@') {
            const read = fs.readBinaryFile.bind(fs);
            vi.spyOn(fs, 'readBinaryFile').mockImplementation(async (file) => {
                const content = await read(file);
                if (file.endsWith('file.txt')) {
                    await pause();
                }
                return content;
            });
        } else {
            const read = fs.readTextFile.bind(fs);
            vi.spyOn(fs, 'readTextFile').mockImplementation(async (file) => {
                const content = await read(file);
                if (file.endsWith('file.txt')) {
                    await pause();
                }
                return content;
            });
        }
        const reading = service.readFile(uri);
        await started;
        const saving = service.writeFile(uri, new TextEncoder().encode('new editor source\n'));
        try {
            if (state === 'completed') {
                await saving;
                // Let the writer finish clearing its active batch before releasing the old read.
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            release();
            expect(new TextDecoder().decode(await reading)).toBe('new editor source\n');
        } finally {
            release();
            await saving;
        }
    });

    it('reads file from historical revision', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'hello from initial' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const content = await service.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello from initial');
    });

    it('writes file changes into revision atomically', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'original' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        await service.writeFile(uri, Buffer.from('modified content\n', 'utf8'));

        const updated = await service.readFile(uri);
        expect(Buffer.from(updated).toString('utf8')).toBe('modified content\n');
    });

    it('advances stat mtime when invalidateCache is called', () => {
        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const statBefore = service.stat(uri);
        expect(statBefore.mtime).toBeGreaterThan(1700000000000 - 1);

        service.invalidateCache();
        const statAfter = service.stat(uri);
        expect(statAfter.mtime).toBe(statBefore.mtime + 1);
    });
});
