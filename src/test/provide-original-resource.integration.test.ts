/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Uri } from '../core/uri-utils';
import type { Api } from '../vscode/extension';
import type { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { createTestRepositoryContext, waitUntil } from './integration-test-utils';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

suite('JjScmProvider provideOriginalResource Integration Test', () => {
    let scmProvider: VsCodeScmProvider;
    let contextHelper: import('./integration-test-utils').TestRepositoryContext;
    let repo: TestRepo;

    setup(async () => {
        repo = new TestRepo();
        repo.init();

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
            append: () => {},
            replace: () => {},
            clear: () => {},
            show: () => {},
            hide: () => {},
            dispose: () => {},
            name: 'mock',
        });
        contextHelper = await createTestRepositoryContext(repo.path, outputChannel);
        scmProvider = contextHelper.scmProvider;
    });

    teardown(async () => {
        if (contextHelper) {
            await contextHelper.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('returns undefined for added file', async () => {
        const fileName = 'added.txt';
        repo.writeFile(fileName, 'new content');

        await scmProvider.refresh({ forceSnapshot: true });

        const fileUri = Uri.file(path.join(repo.path, fileName));
        const originalUri = await scmProvider.provideOriginalResource(fileUri);

        assert.strictEqual(originalUri, undefined, 'Should return undefined for added files');
    });

    test('returns undefined for untracked file', async () => {
        // Create an ignored file
        repo.writeFile('.jjignore', 'ignored.txt\n');
        // Manually write file without repo.writeFile (which snapshots)
        const ignoredPath = path.join(repo.path, 'ignored.txt');
        require('node:fs').writeFileSync(ignoredPath, 'ignored content');

        await scmProvider.refresh({ forceSnapshot: true });

        const fileUri = Uri.file(ignoredPath);
        const originalUri = await scmProvider.provideOriginalResource(fileUri);

        assert.strictEqual(originalUri, undefined, 'Should return undefined for untracked/ignored files');
    });

    test('returns jj-view URI for modified file', async () => {
        const fileName = 'modified.txt';
        const fileContentOriginal = 'original content\n';
        const fileContentModified = 'modified content\n';

        await buildGraph(repo, [
            {
                label: 'parent',
                description: 'parent',
                files: { [fileName]: fileContentOriginal },
            },
            {
                parents: ['parent'],
                files: { [fileName]: fileContentModified },
                isCurrentWorkingCopy: true,
            },
        ]);

        await scmProvider.refresh({ forceSnapshot: true });

        const fileUri = Uri.file(path.join(repo.path, fileName));
        const originalUri = await scmProvider.provideOriginalResource(fileUri);

        assert.ok(originalUri, 'Should return a URI for modified files');
        assert.strictEqual(originalUri.scheme, 'jj-view', 'Scheme should be jj-view');

        const query = new URLSearchParams(originalUri.fragment);
        assert.strictEqual(query.get('base'), '@', 'Base should be @ by default');
        assert.strictEqual(query.get('side'), 'left', 'Side should be left');
    });

    test('refreshes the original resource after committing an open file', async () => {
        const fileName = 'commit-baseline.txt';
        const originalContent = 'one\ntwo\nthree\n';
        const committedContent = 'ONE\ntwo\nthree\n';
        repo.writeFile(fileName, originalContent);
        repo.new(undefined, 'Update first line');
        repo.writeFile(fileName, committedContent);
        await scmProvider.refresh({ forceSnapshot: true });

        const document = await vscode.workspace.openTextDocument(Uri.file(path.join(repo.path, fileName)));
        const editor = await vscode.window.showTextDocument(document);
        const end = new vscode.Selection(2, 0, 2, 0);
        const goToNextChange = 'workbench.action.editor.nextChange';
        editor.selection = end;
        assert.ok(
            await waitUntil(async () => {
                await vscode.commands.executeCommand(goToNextChange);
                return editor.selection.active.line === 0;
            }, 5000),
            'Quick diff should navigate to the modified line before committing',
        );
        const originalUri = await scmProvider.provideOriginalResource(document.uri);
        assert.ok(originalUri);
        const originalDocument = await vscode.workspace.openTextDocument(originalUri);
        assert.strictEqual(originalDocument.getText(), originalContent);

        await vscode.commands.executeCommand('jj-view.commit');

        assert.strictEqual(repo.getFileContent('@-', fileName), committedContent);
        assert.strictEqual(vscode.window.activeTextEditor?.document, document);
        const api = vscode.extensions.getExtension<Api>('jj-view.jj-view')?.exports;
        const activeScm = api?.scmProviders.get(contextHelper.repository.rootUri.fsPath);
        assert.ok(activeScm);
        const refreshedUri = await activeScm.provideOriginalResource(document.uri);
        assert.strictEqual(refreshedUri?.toString(), originalUri.toString());
        await waitUntil(() => originalDocument.getText() === committedContent);
        assert.strictEqual(originalDocument.getText(), document.getText());

        editor.selection = end;
        assert.ok(
            await waitUntil(async () => {
                await vscode.commands.executeCommand(goToNextChange);
                if (editor.selection.isEqual(end)) {
                    return true;
                }
                editor.selection = end;
                return false;
            }, 5000),
            'Quick diff should have no remaining change to navigate to',
        );
    });
});
