/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as sinon from 'sinon';
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

    test('saving a resolution in the merge editor does not warn that inputs are stale', async () => {
        await buildGraph(repo, [
            { label: 'base', files: { 'solution.rs': 'base\n' } },
            { label: 'left', parents: ['base'], files: { 'solution.rs': 'left\n' } },
            { label: 'right', parents: ['base'], files: { 'solution.rs': 'right\n' } },
            { label: 'merge', parents: ['left', 'right'] },
        ]);
        await setRepositoryFolder(true);
        const file = vscode.Uri.file(path.join(repo.path, 'solution.rs'));
        const repository = api.repositoryManager.getRepositoryForUri(file);
        assert.ok(repository);
        await repository.refresh({ forceSnapshot: true });
        const warnings = sinon.spy(vscode.window, 'showWarningMessage');
        try {
            await vscode.commands.executeCommand('jj-view.openMergeEditor', { resourceUri: file });
            const inputs = await Promise.all(
                ['base', 'left', 'right'].map((part) =>
                    vscode.workspace.openTextDocument(
                        file.with({
                            scheme: 'jj-merge-output',
                            authority: 'jj-merge',
                            fragment: `path=${encodeURIComponent(file.fsPath)}&part=${part}`,
                        }),
                    ),
                ),
            );
            assert.strictEqual(inputs.length, 3, 'The native merge editor must load all three inputs');
            const before = inputs.map((document) => document.getText());
            // _open.mergeEditor returns before its editor pane has initialized. Wait for
            // the native Accept All + Save actions to reach the actual result on disk.
            let saved = false;
            for (let attempt = 0; attempt < 50; attempt++) {
                await vscode.commands.executeCommand('merge.acceptAllInput1');
                await vscode.commands.executeCommand('workbench.action.files.save');
                if ((await repository.jj.system.fs.readTextFile(file.fsPath)) === 'left\n') {
                    saved = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.ok(saved, 'The native merge editor should save the accepted resolution');
            await repository.refresh({ forceSnapshot: true });
            assert.deepStrictEqual(await repository.jj.getConflictedFiles(), []);
            assert.strictEqual(await repository.jj.system.fs.readTextFile(file.fsPath), 'left\n');
            assert.deepStrictEqual(
                inputs.map((document) => document.getText()),
                before,
            );
            assert.strictEqual(
                warnings.getCalls().some((call) => call.args[0].includes('Merge inputs for solution.rs')),
                false,
            );
        } finally {
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            warnings.restore();
        }
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
