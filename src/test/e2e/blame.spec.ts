/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from '@playwright/test';
import { ScopedTestRepo } from '../test-repo';
import { test } from './e2e-helpers';

test('JJ line blame renders and yields to Git inline blame', async ({ vscode }) => {
    using repo = new ScopedTestRepo();
    repo.init();
    repo.writeFile('blame.txt', 'inherited line\n');
    repo.describe('Blame origin');
    repo.new();
    const workspacePath =
        process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
    const { page } = await vscode.openWorkspace(
        { path: workspacePath },
        {
            'git.enabled': true,
            'git.blame.editorDecoration.enabled': false,
            'jj-view.blame.enabled': true,
            'jj-view.suppressGitColocationWarning': true,
        },
    );
    await vscode.evaluate(async (vscode, _api, root) => {
        await vscode.extensions.getExtension('vscode.git')?.activate();
        await vscode.commands.executeCommand('git.openRepository', root);
        await vscode.commands.executeCommand('git.refresh');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(`${root}/blame.txt`));
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 1, 0, 1);
    }, repo.path);
    const inlineContent = () =>
        page
            .locator('.monaco-editor .view-line span')
            .evaluateAll((spans) => spans.map((span) => getComputedStyle(span, '::after').content).join('\n'));
    await expect.poll(inlineContent).toMatch(/Test User,.*· Blame origin/);
    await vscode.executeCommand('jj-view.toggleLineBlame');
    await expect.poll(inlineContent).not.toMatch(/Test User,.*· Blame origin/);
    await vscode.executeCommand('jj-view.toggleLineBlame');
    await expect.poll(inlineContent).toMatch(/Test User,.*· Blame origin/);
    await vscode.evaluate(async (vscode) => {
        await vscode.workspace
            .getConfiguration('git')
            .update('blame.editorDecoration.enabled', true, vscode.ConfigurationTarget.Workspace);
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.selection = new vscode.Selection(0, 2, 0, 2);
        }
    });
    await expect.poll(inlineContent).toContain('Blame origin, Test User');
    await expect.poll(inlineContent).not.toMatch(/Test User,.*· Blame origin/);
    await vscode.evaluate(async (vscode) => {
        await vscode.workspace
            .getConfiguration('git')
            .update('blame.editorDecoration.enabled', false, vscode.ConfigurationTarget.Workspace);
    });
    await expect.poll(inlineContent).toMatch(/Test User,.*· Blame origin/);
    const gitEnabled = await vscode.evaluate((vscode) => vscode.workspace.getConfiguration('git').get('enabled'));
    expect(gitEnabled).toBe(true);
});
