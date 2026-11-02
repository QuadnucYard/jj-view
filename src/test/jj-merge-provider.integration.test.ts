/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { JjMergeService } from '../core/jj-merge-service';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { Uri } from '../core/uri-utils';
import { VsCodeMergeContentProvider } from '../vscode/providers/vscode-merge-provider';
import { buildGraph, TestRepo } from './test-repo';

suite('JJ Merge Provider Integration Test', () => {
    let jj: JjService;
    let provider: VsCodeMergeContentProvider;
    let registration: vscode.Disposable;
    let repo: TestRepo;

    setup(async () => {
        repo = new TestRepo();
        repo.init();
        // JjService uses process.env
        jj = new JjService(repo.path, NO_OP_LOGGER); // JjService takes path
        const mergeService = new JjMergeService(jj);
        provider = new VsCodeMergeContentProvider(mergeService);
        registration = vscode.workspace.registerTextDocumentContentProvider('jj-merge-output', provider);
    });

    teardown(async () => {
        registration.dispose();
        provider.clearCache();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        provider.dispose();
        await repo.dispose();
    });

    test('refreshes already open merge input documents after switching conflicts', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'base', files: { 'conflict.txt': 'base\n' } },
            { label: 'left', parents: ['base'], files: { 'conflict.txt': 'left\n' } },
            { label: 'right', parents: ['base'], files: { 'conflict.txt': 'right\n' } },
            { label: 'first', parents: ['left', 'right'] },
            { label: 'new-left', parents: ['base'], files: { 'conflict.txt': 'new left\n' } },
            { label: 'second', parents: ['new-left', 'right'] },
        ]);
        repo.edit(nodes.first.changeId);
        const file = vscode.Uri.file(path.join(repo.path, 'conflict.txt'));
        const uris = ['base', 'left', 'right'].map((part) =>
            file.with({
                scheme: 'jj-merge-output',
                fragment: new URLSearchParams({ path: file.fsPath, part }).toString(),
            }),
        );
        const documents = await Promise.all(uris.map((uri) => vscode.workspace.openTextDocument(uri)));
        assert.deepStrictEqual(
            documents.map((document) => document.getText()),
            ['base\n', 'left\n', 'right\n'],
        );
        const editor = await vscode.window.showTextDocument(documents[1]);
        repo.edit(nodes.second.changeId);
        const changed = new Promise<void>((resolve) => {
            const listener = vscode.workspace.onDidChangeTextDocument(({ document }) => {
                if (document.uri.toString() === uris[1].toString() && document.getText() === 'new left\n') {
                    listener.dispose();
                    resolve();
                }
            });
        });
        await provider.refresh(['conflict.txt'], repo.path);
        await changed;
        assert.strictEqual(editor.document.getText(), 'new left\n');
        assert.strictEqual(documents[0].getText(), 'base\n');
        assert.strictEqual(documents[2].getText(), 'right\n');
    });

    test('Provider resolves conflict content', async () => {
        const fileName = 'conflict.txt';
        const filePath = path.join(repo.path, fileName);

        // 1. Base
        repo.writeFile(fileName, 'base\n');
        repo.describe('base');
        const baseId = repo.getChangeId('@');

        // 2. Left
        repo.new([], 'left');
        repo.writeFile(fileName, 'left\n');

        // 3. Right
        repo.new([baseId], 'right');
        repo.writeFile(fileName, 'right\n');

        // 4. Merge
        // Get left commit id
        const leftCommitId = repo.getChangeId(`children(${baseId}) & description(substring:left)`);
        const rightCommitId = repo.getChangeId(`children(${baseId}) & description(substring:right)`);

        repo.new([leftCommitId, rightCommitId], 'merge');

        // Construct URI to match JjScmProvider (relative path + query)
        const encodedPath = encodeURIComponent(filePath);
        const fileUri = Uri.file(filePath);
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        const virtualPath = path.posix.join('/', relativePath);

        const baseUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=base`,
        });
        const leftUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=left`,
        });
        const rightUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=right`,
        });

        // Open documents using VS Code API
        const baseDoc = await vscode.workspace.openTextDocument(baseUri);
        const leftDoc = await vscode.workspace.openTextDocument(leftUri);
        const rightDoc = await vscode.workspace.openTextDocument(rightUri);

        assert.strictEqual(baseDoc.getText().trim(), 'base');
        assert.strictEqual(leftDoc.getText().trim(), 'left');
        assert.strictEqual(rightDoc.getText().trim(), 'right');

        // Verify base document has content
        assert.ok(baseDoc.getText().length > 0, 'Base document should not be empty');
    });

    test('Provider handles URI with encoded path correctly', async () => {
        // Test specifically the encoding logic
        const fileName = 'file with spaces.txt';
        const filePath = path.join(repo.path, fileName);

        // Setup simple conflict
        repo.new();

        // Snapshot changes so they become part of the commit
        repo.writeFile(fileName, 'base');
        repo.describe('base');
        const baseId = repo.getChangeId('@');

        repo.new([], 'left');
        repo.writeFile(fileName, 'left');

        repo.new([baseId], 'right');
        repo.writeFile(fileName, 'right');

        const leftId = repo.getChangeId(`children(${baseId}) & description(substring:left)`);

        // This time explicitly use change ids
        repo.new([leftId, '@'], 'merge');

        const encodedPath = encodeURIComponent(filePath);
        const fileUri = Uri.file(filePath);
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        const virtualPath = path.posix.join('/', relativePath);

        const baseUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=base`,
        });

        const doc = await vscode.workspace.openTextDocument(baseUri);
        assert.strictEqual(doc.getText().trim(), 'base');
    });
});
