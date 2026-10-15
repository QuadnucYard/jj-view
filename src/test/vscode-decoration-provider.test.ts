/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import type * as vscode from 'vscode';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjDecorationModel } from '../core/jj-decoration-model';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import type { JjStatusEntry } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { VsCodeDecorationProvider } from '../vscode/providers/vscode-decoration-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('VsCodeDecorationProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeDecorationProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(testRepo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, host);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        const model = new JjDecorationModel(repo.jj, testRepo.path);
        provider = new VsCodeDecorationProvider(model);
    });

    afterEach(async () => {
        provider.dispose();
        await repositoryManager.dispose();
    });

    test('decorates .jj files as Ignored', () => {
        const jjUri = Uri.file(`${testRepo.path}/.jj/repo`);
        const token = createMock<vscode.CancellationToken>({ isCancellationRequested: false });
        const decoration = provider.provideFileDecoration(jjUri, token);

        expect(decoration).toBeDefined();
        if (decoration && 'tooltip' in decoration) {
            expect(decoration.tooltip).toBe('Ignored');
        }
    });

    test('clears ignored cache cleanly', () => {
        expect(() => provider.clearIgnoredFileDecorationsCache()).not.toThrow();
    });

    test.each([
        { before: { status: 'added' }, after: { status: 'modified' }, badge: 'M' },
        { before: { status: 'modified', conflicted: true }, after: { status: 'modified' }, badge: 'M' },
        { before: { status: 'modified' }, after: { status: 'modified', conflicted: true }, badge: '!' },
        { before: { status: 'modified' }, after: undefined, badge: undefined },
    ] satisfies {
        before: Omit<JjStatusEntry, 'path'>;
        after: Omit<JjStatusEntry, 'path'> | undefined;
        badge: string | undefined;
    }[])('invalidates the exact SCM URI for status transition $before -> $after', async ({ before, after, badge }) => {
        const uri = Uri.joinPath(Uri.file(testRepo.path).with({ scheme: 'jj-scm' }), 'nested/file.txt').with({
            fragment: new URLSearchParams({ root: testRepo.path, 'jj-revision': 'working-copy' }).toString(),
        });
        const token = createMock<vscode.CancellationToken>({ isCancellationRequested: false });
        provider.updateScmAndTrackedStatus(new Map([[uri.toString(), { path: 'nested/file.txt', ...before }]]));
        expect(await provider.provideFileDecoration(uri, token)).toBeDefined();

        const changedUris: string[] = [];
        provider.onDidChangeFileDecorations((event) => {
            const uris = Array.isArray(event) ? event : event ? [event] : [];
            changedUris.push(...uris.map((changedUri) => changedUri.toString()));
        });
        provider.updateScmAndTrackedStatus(
            after ? new Map([[uri.toString(), { path: 'nested/file.txt', ...after }]]) : new Map(),
        );

        expect(changedUris).toEqual([uri.toString()]);
        expect((await provider.provideFileDecoration(uri, token))?.badge).toBe(badge);
    });

    test('does not apply working-copy conflicts to an unmatched SCM revision', async () => {
        const uri = Uri.joinPath(Uri.file(testRepo.path).with({ scheme: 'jj-scm' }), 'file.txt');
        const workingCopyUri = uri.with({ fragment: 'jj-revision=working-copy' });
        const ancestorUri = uri.with({ fragment: 'jj-revision=ancestor' });
        const conflict: JjStatusEntry = { path: 'file.txt', status: 'modified', conflicted: true };
        const ancestor: JjStatusEntry = { path: 'file.txt', status: 'added' };
        const token = createMock<vscode.CancellationToken>({ isCancellationRequested: false });

        provider.updateScmAndTrackedStatus(
            new Map([
                ['/file.txt', conflict],
                [workingCopyUri.toString(), conflict],
                [ancestorUri.toString(), ancestor],
            ]),
        );
        expect((await provider.provideFileDecoration(workingCopyUri, token))?.badge).toBe('!');
        expect((await provider.provideFileDecoration(ancestorUri, token))?.badge).toBe('A');

        provider.updateScmAndTrackedStatus(
            new Map([
                ['/file.txt', conflict],
                [workingCopyUri.toString(), conflict],
            ]),
        );
        expect(await provider.provideFileDecoration(ancestorUri, token)).toBeUndefined();
        expect(await provider.provideFileDecoration(uri, token)).toBeUndefined();
    });
});
