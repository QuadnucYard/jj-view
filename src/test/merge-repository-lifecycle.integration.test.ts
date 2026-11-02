/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Api } from '../vscode/extension';
import { buildGraph, TestRepo } from './test-repo';

suite('Merge input repository lifecycle', function () {
    this.timeout(40000);
    let repo: TestRepo;
    let api: Api;

    async function setRepositoryFolder(present: boolean): Promise<void> {
        const uri = vscode.Uri.file(repo.path);
        const folders = vscode.workspace.workspaceFolders ?? [];
        const index = folders.findIndex((folder) => folder.uri.toString() === uri.toString());
        if (index >= 0 === present) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
                subscription.dispose();
                resolve();
            });
            const updated = present
                ? vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri })
                : vscode.workspace.updateWorkspaceFolders(index, 1);
            if (!updated) {
                subscription.dispose();
                reject(new Error('Failed to update repository workspace folder'));
            }
        });
        await api.repositoryManager.scanForRepositories();
    }

    setup(async () => {
        repo = new TestRepo();
        repo.init();
        const extension = vscode.extensions.getExtension<Api>('jj-view.jj-view');
        assert.ok(extension, 'Extension should be installed');
        api = await extension.activate();
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await setRepositoryFolder(false);
        await repo.dispose();
    });

    test('refreshes surviving merge inputs when the repository is rediscovered', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'base', files: { 'conflict.txt': 'base\n' } },
            { label: 'left', parents: ['base'], files: { 'conflict.txt': 'left\n' } },
            { label: 'right', parents: ['base'], files: { 'conflict.txt': 'right\n' } },
            { label: 'first', parents: ['left', 'right'] },
            { label: 'new-left', parents: ['base'], files: { 'conflict.txt': 'new left\n' } },
            { label: 'second', parents: ['new-left', 'right'] },
        ]);
        repo.edit(nodes.first.changeId);
        await setRepositoryFolder(true);
        const file = vscode.Uri.file(path.join(repo.path, 'conflict.txt'));
        const originalRepo = api.repositoryManager.getRepositoryForUri(file);
        assert.ok(originalRepo, 'Repository should be registered');
        await originalRepo.refresh({ forceSnapshot: true });
        const uris = ['base', 'left', 'right'].map((part) =>
            file.with({
                scheme: 'jj-merge-output',
                fragment: new URLSearchParams({ path: file.fsPath, part }).toString(),
            }),
        );
        const documents = await Promise.all(uris.map((uri) => vscode.workspace.openTextDocument(uri)));
        await vscode.window.showTextDocument(documents[1]);
        assert.strictEqual(documents[1].getText(), 'left\n');

        await setRepositoryFolder(false);
        assert.strictEqual(api.repositoryManager.getRepositoryForUri(file), undefined);
        assert.strictEqual(documents[1].isClosed, false, 'Input document must survive repository removal');
        repo.edit(nodes.second.changeId);
        let listener: vscode.Disposable | undefined;
        const updated = new Promise<void>((resolve) => {
            listener = vscode.workspace.onDidChangeTextDocument(({ document }) => {
                if (document.uri.toString() === uris[1].toString() && document.getText() === 'new left\n') {
                    resolve();
                }
            });
        });
        try {
            await setRepositoryFolder(true);
            const rediscovered = api.repositoryManager.getRepositoryForUri(file);
            assert.ok(rediscovered, 'Repository should be rediscovered');
            assert.notStrictEqual(rediscovered, originalRepo);
            await rediscovered.refresh({ forceSnapshot: true });
            await updated;
            assert.deepStrictEqual(
                documents.map((document) => document.getText()),
                ['base\n', 'new left\n', 'right\n'],
            );
        } finally {
            listener?.dispose();
        }
    });
});
