/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { buildGraph, TestRepo } from '../test-repo';
import { test } from './e2e-helpers';

test('Open diff retains content throughout repository refreshes', async ({ vscode }) => {
    const repo = new TestRepo();
    repo.init();
    const nodes = await buildGraph(repo, [
        { label: 'base', files: { 'diff-refresh.txt': 'before\n' } },
        { label: 'child', parents: ['base'], files: { 'diff-refresh.txt': 'after\n' } },
    ]);
    const { page } = await vscode.openWorkspace(repo, {}, {}, false, true);

    const result = await vscode.evaluate(
        async (vscode, api, revision, repoPath) => {
            if (typeof revision !== 'string' || typeof repoPath !== 'string') {
                throw new Error('Expected change ID and repository path');
            }
            await api.repositoryManager.scanForRepositories();
            const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
            const repository = api.repositoryManager.repositories.find(
                (candidate) => normalize(candidate.rootUri.fsPath) === normalize(repoPath),
            );
            if (!repository) {
                throw new Error('Repository was not opened');
            }
            api.repositoryManager.setFocusedRepository(repository);
            await repository.refresh({ forceSnapshot: true, reason: 'diff-refresh-setup' });
            await repository.awaitWatchersReady();
            const folder = vscode.Uri.file(repository.rootUri.fsPath);
            const file = vscode.Uri.joinPath(folder, 'diff-refresh.txt');
            const root = folder.fsPath;
            const leftUri = file.with({
                scheme: 'jj-view',
                fragment: new URLSearchParams({ root, base: revision, side: 'left' }).toString(),
            });
            const rightUri = leftUri.with({
                fragment: new URLSearchParams({ root, base: revision, side: 'right' }).toString(),
            });
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, 'Diff refresh regression');
            const left = await vscode.workspace.openTextDocument(leftUri);
            const right = await vscode.workspace.openTextDocument(rightUri);
            const read = () => ({ left: left.getText(), right: right.getText() });
            const initial = read();
            const observed: { left: string; right: string }[] = [];
            const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document === left || event.document === right) {
                    observed.push(read());
                }
            });
            try {
                for (let refresh = 0; refresh < 4; refresh++) {
                    await vscode.workspace.fs.writeFile(
                        vscode.Uri.joinPath(folder, 'unrelated.txt'),
                        new TextEncoder().encode(`unrelated change ${refresh}\n`),
                    );
                    await repository.refresh({ forceSnapshot: true, reason: 'diff-refresh-regression' });
                    observed.push(read());
                }

                // Observe every document update, including any intermediate empty/identical state.
                let disposeWaiter = () => {};
                const updated = new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Diff did not refresh to latest content')), 20000);
                    const listener = vscode.workspace.onDidChangeTextDocument(() => {
                        if (right.getText() === 'latest\n') {
                            resolve();
                        }
                    });
                    disposeWaiter = () => {
                        clearTimeout(timer);
                        listener.dispose();
                    };
                });
                try {
                    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('latest\n'));
                    await repository.refresh({ forceSnapshot: true, reason: 'diff-refresh-content-change' });
                    await updated;
                } finally {
                    disposeWaiter();
                }
                return { initial, observed, final: read() };
            } finally {
                subscription.dispose();
            }
        },
        nodes.child.changeId,
        repo.path,
    );

    expect(result.initial).toEqual({ left: 'before\n', right: 'after\n' });
    for (const content of result.observed) {
        expect(content.left).toBe('before\n');
        expect(['after\n', 'latest\n']).toContain(content.right);
    }
    expect(result.final).toEqual({ left: 'before\n', right: 'latest\n' });
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible();
    await expect(page.locator('.monaco-diff-editor .modified .view-lines:not(.line-delete)').first()).toContainText(
        'latest',
    );
});
