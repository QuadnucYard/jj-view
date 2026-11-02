/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjMergeService } from '../core/jj-merge-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { getFsPathFromUri, Uri } from '../core/uri-utils';
import { VsCodeMergeContentProvider } from '../vscode/providers/vscode-merge-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

const { documents, showWarningMessage } = vi.hoisted(() => ({
    documents: [] as vscode.TextDocument[],
    showWarningMessage: vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
}));
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({ workspace: { textDocuments: documents }, window: { showWarningMessage } });
});

async function buildConflicts(repo: TestRepo, filenames = ['conflict.txt']) {
    const files = (content: string) =>
        Object.fromEntries(
            filenames.map((filename) => [filename, filenames.length === 1 ? content : `${filename}: ${content}`]),
        );
    return buildGraph(repo, [
        { label: 'base', files: files('base\n') },
        { label: 'left', parents: ['base'], files: files('left\n') },
        { label: 'right', parents: ['base'], files: files('right\n') },
        { label: 'first', parents: ['left', 'right'] },
        { label: 'new-left', parents: ['base'], files: files('new left\n') },
        { label: 'second', parents: ['new-left', 'right'] },
        { label: 'another-left', parents: ['base'], files: files('another left\n') },
        { label: 'third', parents: ['another-left', 'right'] },
    ]);
}

async function openConflict(repo: TestRepo, provider: VsCodeMergeContentProvider, filename: string, dirty: boolean) {
    const file = Uri.joinPath(Uri.file(repo.path), filename);
    const uris = ['base', 'left', 'right'].map((part) =>
        file.with({
            scheme: 'jj-merge-output',
            fragment: new URLSearchParams({ path: file.fsPath, part }).toString(),
        }),
    );
    for (const uri of uris) {
        const content = await provider.provideTextDocumentContent(uri);
        documents.push(createMock<vscode.TextDocument>({ uri, getText: () => content }));
    }
    const output = createMock<vscode.TextDocument>({ uri: file, isDirty: dirty, getText: () => 'my resolution\n' });
    documents.push(output);
    return { uris, output };
}

describe('VsCodeMergeContentProvider', () => {
    let repo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeMergeContentProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        repo = new TestRepo();
        repo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, host);

        const registeredRepo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!registeredRepo) {
            throw new Error('Failed to register repo in test');
        }

        const service = new JjMergeService(registeredRepo.jj);
        provider = new VsCodeMergeContentProvider(service);
    });

    afterEach(async () => {
        provider.dispose();
        documents.length = 0;
        vi.restoreAllMocks();
        await repositoryManager.dispose();
        await repo.dispose();
    });

    test.each(['clean', 'defer', 'approve'])('refreshes changed merge inputs with %s output handling', async (mode) => {
        const dirty = mode !== 'clean';
        const nodes = await buildConflicts(repo);
        repo.edit(nodes.first.changeId);
        const { uris, output } = await openConflict(repo, provider, 'conflict.txt', dirty);
        const changed: string[] = [];
        provider.onDidChange((uri) => changed.push(uri.toString()));
        repo.edit(nodes.second.changeId);
        let approve: ((value: string | undefined) => void) | undefined;
        const warning = showWarningMessage.mockImplementation(
            () =>
                new Promise<string | undefined>((resolve) => {
                    approve = resolve;
                }),
        );
        await provider.refresh(['conflict.txt'], repo.path);
        if (dirty) {
            expect(warning).toHaveBeenCalledTimes(1);
            expect(changed).toEqual([]);
            expect(await provider.provideTextDocumentContent(uris[1])).toBe('left\n');
            await provider.refresh(['conflict.txt'], repo.path);
            expect(warning).toHaveBeenCalledTimes(1);
            approve?.(mode === 'approve' ? 'Refresh Merge Inputs' : undefined);
            await Promise.resolve();
            expect(changed).toEqual(mode === 'approve' ? uris.map((uri) => uri.toString()) : []);
            expect(await provider.provideTextDocumentContent(uris[1])).toBe(
                mode === 'approve' ? 'new left\n' : 'left\n',
            );
        } else {
            expect(changed).toEqual(uris.map((uri) => uri.toString()));
            expect(await provider.provideTextDocumentContent(uris[1])).toBe('new left\n');
            changed.length = 0;
            await provider.refresh(['conflict.txt'], repo.path);
            expect(changed).toEqual([]);
            expect(warning).not.toHaveBeenCalled();
        }
        expect(output.getText()).toBe('my resolution\n');
    });

    test.each([false, true])('handles approval during capture with changed conflict=%s', async (changedConflict) => {
        const nodes = await buildConflicts(repo);
        repo.edit(nodes.first.changeId);
        const { uris, output } = await openConflict(repo, provider, 'conflict.txt', true);
        const approvals: ((action: string | undefined) => void)[] = [];
        showWarningMessage.mockImplementation(() => new Promise((resolve) => approvals.push(resolve)));
        const notifications: string[] = [];
        provider.onDidChange((uri) => notifications.push(uri.toString()));
        repo.edit(nodes.second.changeId);
        await provider.refresh(['conflict.txt'], repo.path);

        const repository = repositoryManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository was not registered');
        }
        const fs = repository.jj.system.fs;
        const read = fs.readTextFile.bind(fs);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let blocked = false;
        vi.spyOn(fs, 'readTextFile').mockImplementation(async (file) => {
            const content = await read(file);
            if (!blocked && content === 'base\n') {
                blocked = true;
                entered.resolve();
                await release.promise;
            }
            return content;
        });
        if (changedConflict) {
            repo.edit(nodes.third.changeId);
        }
        const refreshing = provider.refresh(['conflict.txt'], repo.path);
        await entered.promise;
        approvals[0]('Refresh Merge Inputs');
        await Promise.resolve();
        expect(notifications).toEqual([]);
        release.resolve();
        await refreshing;
        if (changedConflict) {
            expect(notifications).toEqual([]);
            expect(approvals).toHaveLength(2);
            approvals[1]('Refresh Merge Inputs');
            await Promise.resolve();
        }
        expect(notifications).toEqual(uris.map((uri) => uri.toString()));
        expect(await provider.provideTextDocumentContent(uris[1])).toBe(
            changedConflict ? 'another left\n' : 'new left\n',
        );
        expect(output.getText()).toBe('my resolution\n');
    });

    test('refreshes healthy files even when an earlier conflict capture fails', async () => {
        const nodes = await buildConflicts(repo, ['broken.txt', 'good.txt']);
        repo.edit(nodes.first.changeId);
        const broken = await openConflict(repo, provider, 'broken.txt', false);
        const good = await openConflict(repo, provider, 'good.txt', false);
        repo.edit(nodes.second.changeId);
        const repository = repositoryManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository was not registered');
        }
        const fs = repository.jj.system.fs;
        const read = fs.readTextFile.bind(fs);
        let fail = true;
        vi.spyOn(fs, 'readTextFile').mockImplementation(async (file) => {
            const content = await read(file);
            if (fail && content === 'broken.txt: base\n') {
                throw new Error('capture read failed');
            }
            return content;
        });
        const notifications: string[] = [];
        provider.onDidChange((uri) => notifications.push(uri.toString()));
        await expect(provider.refresh(['broken.txt', 'good.txt'], repo.path)).rejects.toThrow('broken.txt');
        expect(notifications).toEqual(good.uris.map((uri) => uri.toString()));
        expect(await provider.provideTextDocumentContent(good.uris[1])).toBe('good.txt: new left\n');
        expect(await provider.provideTextDocumentContent(broken.uris[1])).toBe('broken.txt: left\n');

        fail = false;
        notifications.length = 0;
        await provider.refresh(['broken.txt', 'good.txt'], repo.path);
        expect(notifications).toEqual(broken.uris.map((uri) => uri.toString()));
        expect(await provider.provideTextDocumentContent(broken.uris[1])).toBe('broken.txt: new left\n');
    });

    test.each([
        false,
        true,
    ])('recovers surviving merge documents after replacement with dirty=%s output', async (dirty) => {
        const nodes = await buildConflicts(repo);
        repo.edit(nodes.first.changeId);
        const { uris, output } = await openConflict(repo, provider, 'conflict.txt', dirty);
        provider.dispose();
        const repository = repositoryManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository was not registered');
        }
        provider = new VsCodeMergeContentProvider(new JjMergeService(repository.jj));
        const notifications: string[] = [];
        provider.onDidChange((uri) => notifications.push(uri.toString()));
        let approve: ((action: string | undefined) => void) | undefined;
        showWarningMessage.mockImplementation(
            () =>
                new Promise((resolve) => {
                    approve = resolve;
                }),
        );
        repo.edit(nodes.second.changeId);
        await provider.refresh(['conflict.txt'], repo.path);
        if (dirty) {
            expect(showWarningMessage).toHaveBeenCalledOnce();
            expect(notifications).toEqual([]);
            expect(await provider.provideTextDocumentContent(uris[1])).toBe('left\n');
            approve?.('Refresh Merge Inputs');
            await Promise.resolve();
        } else {
            expect(showWarningMessage).not.toHaveBeenCalled();
        }
        expect(notifications).toEqual(uris.map((uri) => uri.toString()));
        expect(await provider.provideTextDocumentContent(uris[1])).toBe('new left\n');
        expect(output.getText()).toBe('my resolution\n');
    });

    test('adopts only owned merge inputs and ignores editor line-ending normalization', async () => {
        const nodes = await buildConflicts(repo);
        repo.edit(nodes.first.changeId);
        const { uris } = await openConflict(repo, provider, 'conflict.txt', true);
        for (let index = 0; index < uris.length; index++) {
            const text = documents[index].getText().replace(/\n/g, '\r\n');
            documents[index] = createMock<vscode.TextDocument>({ uri: uris[index], getText: () => text });
        }
        const unreadable = (uri: Uri) =>
            createMock<vscode.TextDocument>({
                uri,
                getText: () => {
                    throw new Error('Unrelated document must not be adopted');
                },
            });
        const nested = Uri.joinPath(Uri.file(repo.path), 'nested', 'conflict.txt');
        documents.push(
            unreadable(
                nested.with({
                    scheme: 'jj-merge-output',
                    fragment: new URLSearchParams({ path: nested.fsPath, part: 'left' }).toString(),
                }),
            ),
        );
        documents.push(unreadable(uris[1].with({ scheme: 'jj-view' })));
        provider.dispose();
        const repository = repositoryManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository was not registered');
        }
        provider = new VsCodeMergeContentProvider(
            new JjMergeService(repository.jj),
            (uri) => getFsPathFromUri(uri) === getFsPathFromUri(uris[0]),
        );
        const changed: Uri[] = [];
        provider.onDidChange((uri) => changed.push(uri));
        await provider.refresh(['conflict.txt'], repo.path);
        expect(changed).toEqual([]);
        expect(showWarningMessage).not.toHaveBeenCalled();
        expect(await provider.provideTextDocumentContent(uris[1])).toBe('left\r\n');
    });

    test('handles missing query parameters gracefully', async () => {
        const uri = Uri.from({ scheme: 'jj-merge', path: '/test.txt' });
        const content = await provider.provideTextDocumentContent(uri);
        expect(content).toBe('');
    });

    test('clears cache without error', () => {
        expect(() => provider.clearCache()).not.toThrow();
        expect(() => provider.clearCache('some/path')).not.toThrow();
    });
});
