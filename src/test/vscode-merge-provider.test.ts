/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjMergeService } from '../core/jj-merge-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
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
        const nodes = await buildGraph(repo, [
            { label: 'base', files: { 'conflict.txt': 'base\n' } },
            { label: 'left', parents: ['base'], files: { 'conflict.txt': 'left\n' } },
            { label: 'right', parents: ['base'], files: { 'conflict.txt': 'right\n' } },
            { label: 'first', parents: ['left', 'right'] },
            { label: 'new-left', parents: ['base'], files: { 'conflict.txt': 'new left\n' } },
            { label: 'second', parents: ['new-left', 'right'] },
        ]);
        repo.edit(nodes.first.changeId);
        const file = Uri.joinPath(Uri.file(repo.path), 'conflict.txt');
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
