/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { buildGraph, ROOT_ID, TestRepo } from '../test-repo';
import {
    clickContextMenuItem,
    clickScmAction,
    expectFileInScmGroup,
    expectScmDescription,
    focusSCM,
    hoverAndClick,
    openScmDiff,
    openScmFile,
    openScmMerge,
    pickQuickPickItem,
    SCM_ACTIONS,
    save,
    selectLine,
    setScmDescription,
    test,
    waitForTab,
    waitForTree,
} from './e2e-helpers';

test.describe('SCM Pane E2E', () => {
    for (const viewMode of ['list', 'tree']) {
        for (const openDiffOnClick of [true, false]) {
            test(`Working copy opens reuse the active group with Git also visible in ${viewMode} view with openDiffOnClick ${openDiffOnClick}`, async ({
                vscode,
            }) => {
                const repo = new TestRepo();
                repo.init();
                await buildGraph(repo, [
                    { label: 'a', description: 'mixed ancestor A', files: { 'file.txt': 'A' } },
                    { label: 'b', parents: ['a'], description: 'mixed ancestor B', files: { 'file.txt': 'B' } },
                    { label: 'wc', parents: ['b'], files: { 'file.txt': 'WC' }, isCurrentWorkingCopy: true },
                ]);
                const workspacePath =
                    process.platform === 'win32'
                        ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
                        : repo.path;
                const { page } = await vscode.openWorkspace(
                    { path: workspacePath },
                    {
                        'git.enabled': true,
                        'scm.autoReveal': true,
                        'scm.repositories.selectionMode': 'multiple',
                        'workbench.tree.enableStickyScroll': false,
                        'jj-view.openDiffOnClick': openDiffOnClick,
                    },
                );
                await vscode.evaluate(
                    async (vscode, _api, root, mode) => {
                        await vscode.extensions.getExtension('vscode.git')?.activate();
                        await vscode.commands.executeCommand('git.openRepository', root);
                        await vscode.commands.executeCommand('git.refresh');
                        await vscode.commands.executeCommand(
                            mode === 'tree'
                                ? 'workbench.scm.action.setTreeViewMode'
                                : 'workbench.scm.action.setListViewMode',
                        );
                    },
                    workspacePath,
                    viewMode,
                );
                await focusSCM(page);
                await expect(page.getByRole('treeitem', { name: / Git$/ }).first()).toBeVisible();
                for (const groupName of [/mixed ancestor A/, /mixed ancestor B/, /Working Copy/]) {
                    // Git auto-reveal can scroll the virtualized tree to its physical-file row.
                    await page.getByRole('tree', { name: 'Source Control Management', exact: true }).hover();
                    await page.mouse.wheel(0, -1000);
                    const group = page
                        .getByRole('treeitem', { name: groupName })
                        .and(page.locator('[aria-level="2"]'))
                        .first();
                    await expect(group).toBeVisible();
                    const row = group.locator('xpath=following-sibling::div[@role="treeitem"][1]').first();
                    await expect(row).toHaveAttribute('aria-label', 'file.txt');
                    await row.click();
                    await page.waitForTimeout(1000);
                    expect(await vscode.evaluate((vscode) => vscode.window.tabGroups.all.length)).toBe(1);
                    const clickedContent = await vscode.evaluate((vscode) =>
                        vscode.window.activeTextEditor?.document.getText(),
                    );
                    expect(clickedContent).toBe(
                        openDiffOnClick
                            ? groupName.source.includes('ancestor A')
                                ? 'A'
                                : groupName.source.includes('ancestor B')
                                  ? 'B'
                                  : 'WC'
                            : 'WC',
                    );
                    if (openDiffOnClick) {
                        await page.getByRole('tree', { name: 'Source Control Management', exact: true }).hover();
                        await page.mouse.wheel(0, -1000);
                        await hoverAndClick(
                            row,
                            row.getByRole('button', { name: 'Open File in Working Copy', exact: true }),
                        );
                    }
                    await page.waitForTimeout(1000);
                    const editors = await vscode.evaluate((vscode) => ({
                        workingCopies: vscode.window.visibleTextEditors
                            .filter((editor) => editor.document.uri.scheme === 'file')
                            .map((editor) => editor.document.getText()),
                        groups: vscode.window.tabGroups.all.length,
                        autoReveal: vscode.workspace.getConfiguration('scm').get('autoReveal'),
                    }));
                    expect(editors).toEqual({ workingCopies: ['WC'], groups: 1, autoReveal: true });
                }
                // The target is the live native document: edits save to disk, not to a revision alias.
                await vscode.evaluate(async (vscode) => {
                    const target = vscode.window.visibleTextEditors.find(
                        (editor) => editor.document.uri.scheme === 'file',
                    );
                    if (!target) {
                        throw new Error('Working-copy editor was not opened');
                    }
                    const edit = new vscode.WorkspaceEdit();
                    edit.insert(target.document.uri, new vscode.Position(0, 0), 'edited ');
                    await vscode.workspace.applyEdit(edit);
                    await target.document.save();
                });
                expect(repo.readFile('file.txt')).toBe('edited WC');
                expect(repo.getFileContent('@-', 'file.txt')).toBe('B');

                // Opening from SCM must also leave an existing two-group layout intact.
                // Keep the working-copy file open and make an unrelated tab active.
                await vscode.evaluate(async (vscode) => {
                    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
                    await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
                });
                expect(await vscode.evaluate((vscode) => vscode.window.tabGroups.all.length)).toBe(2);
                await focusSCM(page);
                await page.getByRole('tree', { name: 'Source Control Management', exact: true }).hover();
                await page.mouse.wheel(0, -1000);
                const workingCopyGroup = page
                    .getByRole('treeitem', { name: /Working Copy/ })
                    .and(page.locator('[aria-level="2"]'))
                    .first();
                const workingCopyRow = workingCopyGroup
                    .locator('xpath=following-sibling::div[@role="treeitem"][1]')
                    .first();
                await expect(workingCopyRow).toHaveAttribute('aria-label', 'file.txt');
                await workingCopyRow.click();
                await expect
                    .poll(() =>
                        vscode.evaluate((vscode) => ({
                            groups: vscode.window.tabGroups.all.length,
                            content: vscode.window.activeTextEditor?.document.getText(),
                            diff:
                                vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
                                vscode.TabInputTextDiff,
                        })),
                    )
                    .toEqual({ groups: 2, content: 'edited WC', diff: openDiffOnClick });
                if (openDiffOnClick) {
                    await page.getByRole('tree', { name: 'Source Control Management', exact: true }).hover();
                    await page.mouse.wheel(0, -1000);
                    await hoverAndClick(
                        workingCopyRow,
                        workingCopyRow.getByRole('button', { name: 'Open File in Working Copy', exact: true }),
                    );
                    await expect
                        .poll(() =>
                            vscode.evaluate((vscode) => ({
                                groups: vscode.window.tabGroups.all.length,
                                file:
                                    vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
                                    vscode.TabInputText,
                                content: vscode.window.activeTextEditor?.document.getText(),
                            })),
                        )
                        .toEqual({ groups: 2, file: true, content: 'edited WC' });
                }
            });
        }
    }

    test('SCM clicks respect native group locking with commit details active', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'base' } },
            { label: 'wc', parents: ['base'], files: { 'file.txt': 'WC' }, isCurrentWorkingCopy: true },
        ]);
        const workspacePath =
            process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
        const { page } = await vscode.openWorkspace({ path: workspacePath }, { 'jj-view.openDiffOnClick': true });

        for (const locked of [false, true]) {
            await vscode.evaluate(async (vscode, _api, lockGroup) => {
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                await vscode.commands.executeCommand('workbench.action.joinAllGroups');
                await vscode.commands.executeCommand('jj-view.showDetails', '@');
                await vscode.commands.executeCommand(
                    lockGroup ? 'workbench.action.lockEditorGroup' : 'workbench.action.unlockEditorGroup',
                );
            }, locked);
            await expect
                .poll(() =>
                    vscode.evaluate((vscode) => {
                        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
                        return input instanceof vscode.TabInputCustom ? input.viewType : undefined;
                    }),
                )
                .toBe('jj-view.commitDetailsEditor');
            expect(await vscode.evaluate((vscode) => vscode.window.tabGroups.all.length)).toBe(1);

            await focusSCM(page);
            await openScmDiff(page, 'file.txt', /Working Copy/);
            await expect
                .poll(() =>
                    vscode.evaluate((vscode) => ({
                        groups: vscode.window.tabGroups.all.length,
                        content: vscode.window.activeTextEditor?.document.getText(),
                    })),
                )
                .toEqual({ groups: locked ? 2 : 1, content: 'WC' });
        }
    });

    for (const action of [SCM_ACTIONS.SquashFilesIntoParent, 'Restore']) {
        test(`Multi-child SCM folders offer all actions and apply ${action} to descendants`, async ({ vscode }) => {
            const repo = new TestRepo();
            repo.init();
            const files = ['src/first.txt', 'src/nested/deep/second.txt', 'src/nested/deep/third.txt', 'outside.txt'];
            await buildGraph(repo, [
                { label: 'base', files: Object.fromEntries(files.map((file) => [file, 'base'])) },
                {
                    label: 'wc',
                    parents: ['base'],
                    files: Object.fromEntries(files.map((file) => [file, 'changed'])),
                    isCurrentWorkingCopy: true,
                },
            ]);
            // Match VS Code's normalized Windows workspace URI.
            const workspacePath =
                process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
            const { page } = await vscode.openWorkspace({ path: workspacePath });
            await focusSCM(page);
            await vscode.evaluate(async (vscode) => {
                await vscode.commands.executeCommand('workbench.scm.action.setTreeViewMode');
            });
            const folder = await expectFileInScmGroup(page, /Working Copy/, 'src');
            const compressedFolder = page.getByRole('treeitem', { name: /^src[\\/]nested[\\/]deep$/ }).first();
            for (const row of [folder, compressedFolder]) {
                await row.hover();
                for (const title of [
                    'Restore',
                    SCM_ACTIONS.SquashFilesIntoAncestor,
                    SCM_ACTIONS.SquashFilesIntoParent,
                    SCM_ACTIONS.SquashFilesIntoChild,
                ]) {
                    await expect(row.getByRole('button', { name: title, exact: true })).toBeVisible();
                }
            }
            await clickScmAction(page, folder, action);
            await expect(async () => {
                const expected = action === 'Restore' ? 'base' : 'changed';
                expect(repo.getFileContent('@-', 'src/first.txt').trim()).toBe(expected);
                expect(repo.getFileContent('@-', 'src/nested/deep/second.txt').trim()).toBe(expected);
                expect(repo.getFileContent('@-', 'src/nested/deep/third.txt').trim()).toBe(expected);
                expect(repo.getDiffSummary('@')).not.toContain('src/');
                expect(repo.getFileContent('@-', 'outside.txt').trim()).toBe('base');
                expect(repo.getFileContent('@', 'outside.txt').trim()).toBe('changed');
            }).toPass({ timeout: 10000 });
        });
    }

    for (const viewMode of ['list', 'tree']) {
        for (const modifiedWorkingCopy of [false, true]) {
            test(`Open File in Working Copy keeps the selected row in ${viewMode} view with ${modifiedWorkingCopy ? 'modified' : 'empty'} working copy`, async ({
                vscode,
            }, testInfo) => {
                const repo = new TestRepo();
                repo.init();
                await buildGraph(repo, [
                    { label: 'a', description: 'ancestor A', files: { 'file.txt': 'A' } },
                    {
                        label: 'b',
                        parents: ['a'],
                        description: 'ancestor B',
                        files: { 'file.txt': 'B' },
                    },
                    {
                        label: 'wc',
                        parents: ['b'],
                        files: modifiedWorkingCopy ? { 'file.txt': 'C' } : undefined,
                        isCurrentWorkingCopy: true,
                    },
                ]);
                // VS Code normalizes Windows drive letters in workspace URIs.
                const workspacePath =
                    process.platform === 'win32'
                        ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
                        : repo.path;
                const { page } = await vscode.openWorkspace({ path: workspacePath }, { 'scm.autoReveal': true });
                await focusSCM(page);
                await vscode.evaluate(async (vscode, _api, mode) => {
                    await vscode.commands.executeCommand(
                        mode === 'tree'
                            ? 'workbench.scm.action.setTreeViewMode'
                            : 'workbench.scm.action.setListViewMode',
                    );
                }, viewMode);
                for (const group of modifiedWorkingCopy
                    ? [/ancestor A/, /ancestor B/, /Working Copy/]
                    : [/ancestor A/, /ancestor B/]) {
                    const row = await expectFileInScmGroup(page, group, 'file.txt');
                    await row.click();
                    await page.waitForTimeout(1000);
                    await expect(row).toHaveAttribute('aria-selected', 'true');
                    await hoverAndClick(
                        row,
                        row.getByRole('button', { name: 'Open File in Working Copy', exact: true }),
                    );
                    await expect(page.locator('.monaco-diff-editor')).not.toBeVisible();
                    // Allow native SCM's queued editor-reveal work to complete before asserting.
                    await page.waitForTimeout(1000);
                    await expect(row).toHaveAttribute('aria-selected', 'true');
                    await expect(row).toHaveClass(/focused/);
                    const editor = await vscode.evaluate((vscode) => ({
                        scheme: vscode.window.activeTextEditor?.document.uri.scheme,
                        content: vscode.window.activeTextEditor?.document.getText(),
                    }));
                    expect(editor).toEqual({ scheme: 'file', content: modifiedWorkingCopy ? 'C' : 'B' });
                }
                await testInfo.attach('selection-after-open', {
                    body: await page.screenshot(),
                    contentType: 'image/png',
                });
            });
        }
    }

    for (const viewMode of ['list', 'tree']) {
        for (const gitEnabled of [false, true]) {
            test(`SCM selection stays stable across file statuses and ancestor depths in ${viewMode} view with Git ${gitEnabled}`, async ({
                vscode,
            }, testInfo) => {
                testInfo.setTimeout(120000);
                const repo = new TestRepo();
                repo.init();
                await buildGraph(repo, [
                    {
                        label: 'base',
                        files: {
                            'modified.txt': 'base modified',
                            'restored.txt': 'base restored',
                            'missing.txt': 'base missing',
                            'old-name.txt': 'base rename',
                        },
                    },
                    {
                        label: 'a',
                        parents: ['base'],
                        description: 'status ancestor A',
                        files: {
                            'modified.txt': 'A modified',
                            'missing.txt': 'A missing',
                            'old-name.txt': 'A rename',
                            'added.txt': 'A added',
                        },
                    },
                ]);
                repo.deleteFile('restored.txt');
                repo.new(undefined, 'status ancestor B');
                repo.writeFile('modified.txt', 'B modified');
                repo.writeFile('missing.txt', 'B missing');
                repo.writeFile('restored.txt', 'B restored');
                repo.moveFile('old-name.txt', 'renamed.txt');
                repo.new(undefined, 'status ancestor C');
                repo.writeFile('modified.txt', 'C modified');
                repo.writeFile('missing.txt', 'C missing');
                repo.writeFile('restored.txt', 'C restored');
                repo.new(undefined, 'status working copy');
                repo.writeFile('modified.txt', 'WC modified');
                repo.deleteFile('missing.txt');

                const workspacePath =
                    process.platform === 'win32'
                        ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
                        : repo.path;
                const { page } = await vscode.openWorkspace(
                    { path: workspacePath },
                    {
                        'scm.autoReveal': true,
                        'git.enabled': gitEnabled,
                        'scm.repositories.selectionMode': 'multiple',
                    },
                );
                await focusSCM(page);
                if (gitEnabled) {
                    await vscode.evaluate(async (vscode, _api, root) => {
                        await vscode.extensions.getExtension('vscode.git')?.activate();
                        await vscode.commands.executeCommand('git.openRepository', root);
                        await vscode.commands.executeCommand('git.refresh');
                    }, workspacePath);
                    await page.getByRole('button', { name: 'Graph Section', exact: true }).click();
                    // This larger tree virtualizes Git's row below the viewport.
                    expect(
                        await vscode.evaluate((vscode, _api, root) => {
                            if (typeof root !== 'string') {
                                throw new Error('Expected repository path');
                            }
                            const git = vscode.extensions.getExtension<{
                                getAPI(version: 1): { repositories: { rootUri: { path: string } }[] };
                            }>('vscode.git');
                            return git?.exports
                                .getAPI(1)
                                .repositories.some((repo) => repo.rootUri.path === vscode.Uri.file(root).path);
                        }, workspacePath),
                    ).toBe(true);
                }
                await vscode.evaluate(async (vscode, _api, mode) => {
                    await vscode.commands.executeCommand(
                        mode === 'tree'
                            ? 'workbench.scm.action.setTreeViewMode'
                            : 'workbench.scm.action.setListViewMode',
                    );
                }, viewMode);
                const cases = [
                    { group: /status ancestor C/, file: 'modified.txt', diffContent: 'C modified' },
                    { group: /status ancestor B/, file: 'modified.txt', diffContent: 'B modified' },
                    { group: /status ancestor A/, file: 'modified.txt', diffContent: 'A modified' },
                    { group: /status ancestor A/, file: 'restored.txt', diffContent: '' },
                    { group: /status ancestor B/, file: 'restored.txt', diffContent: 'B restored' },
                    { group: /status ancestor A/, file: 'added.txt', diffContent: 'A added' },
                    { group: /status ancestor B/, file: 'renamed.txt', diffContent: 'A rename' },
                    { group: /status ancestor C/, file: 'missing.txt', diffContent: 'C missing' },
                    { group: /status ancestor B/, file: 'missing.txt', diffContent: 'B missing' },
                    { group: /status ancestor A/, file: 'missing.txt', diffContent: 'A missing' },
                    { group: /Working Copy/, file: 'missing.txt', diffContent: '' },
                    { group: /Working Copy/, file: 'modified.txt', diffContent: 'WC modified' },
                ];
                for (const scenario of cases) {
                    const row = gitEnabled
                        ? page
                              .locator(
                                  `//div[@role="treeitem"][@aria-level="3"][@aria-label="${scenario.file}"][(preceding-sibling::div[@role="treeitem"][@aria-level="2"])[last()][contains(@aria-label, "${scenario.group.source}")]]`,
                              )
                              .first()
                        : await expectFileInScmGroup(page, scenario.group, scenario.file);
                    if (gitEnabled) {
                        const scmTree = page.getByRole('tree', { name: 'Source Control Management', exact: true });
                        await scmTree.focus();
                        await page.keyboard.press('Home');
                        await expect(async () => {
                            if (!(await row.isVisible())) {
                                await scmTree.hover();
                                await page.mouse.wheel(0, 400);
                            }
                            await expect(row).toBeVisible({ timeout: 100 });
                        }).toPass({ timeout: 10000, intervals: [100] });
                    }
                    await expect(row).toBeVisible();
                    await row.click();
                    await expect(page.locator('.monaco-diff-editor').last()).toBeVisible();
                    // Editor auto-reveal is queued after the row click.
                    await page.waitForTimeout(750);
                    await expect(row).toHaveAttribute('aria-selected', 'true');
                    await expect(row).toHaveClass(/focused/);
                    expect(
                        await vscode.evaluate(
                            (vscode, _api, content) =>
                                vscode.window.visibleTextEditors.some(
                                    (editor) => editor.document.getText() === content,
                                ),
                            scenario.diffContent,
                        ),
                    ).toBe(true);
                    if (!gitEnabled) {
                        expect(
                            await vscode.evaluate((vscode) => vscode.window.activeTextEditor?.document.getText()),
                        ).toBe(scenario.diffContent);
                    }
                    await hoverAndClick(
                        row,
                        row.getByRole('button', { name: 'Open File in Working Copy', exact: true }),
                    );
                    await page.waitForTimeout(750);
                    await expect(row).toHaveAttribute('aria-selected', 'true');
                    await expect(row).toHaveClass(/focused/);
                    const workingFile = path.join(repo.path, scenario.file);
                    if (fs.existsSync(workingFile)) {
                        const editor = await vscode.evaluate(
                            (vscode, _api, root, file) => {
                                if (typeof root !== 'string' || typeof file !== 'string') {
                                    throw new Error('Expected file path');
                                }
                                const target = vscode.window.visibleTextEditors.find(
                                    (editor) =>
                                        editor.document.uri.toString() ===
                                        vscode.Uri.joinPath(vscode.Uri.file(root), file).toString(),
                                );
                                return { scheme: target?.document.uri.scheme, content: target?.document.getText() };
                            },
                            workspacePath,
                            scenario.file,
                        );
                        expect(editor).toEqual({ scheme: 'file', content: fs.readFileSync(workingFile, 'utf8') });
                    } else {
                        // Opening a deleted working-copy path must not recreate it or move SCM selection.
                        expect(fs.existsSync(workingFile)).toBe(false);
                    }
                }
                await testInfo.attach('file-status-selection', {
                    body: await page.screenshot(),
                    contentType: 'image/png',
                });
            });
        }
    }

    for (const viewMode of ['list', 'tree']) {
        test(`SCM selection stays stable for conflicted merge ancestors in ${viewMode} view`, async ({ vscode }) => {
            const repo = new TestRepo();
            repo.init();
            await buildGraph(repo, [
                { label: 'base', files: { 'conflict.txt': 'base' } },
                { label: 'left', parents: ['base'], description: 'left branch', files: { 'conflict.txt': 'left' } },
                { label: 'right', parents: ['base'], description: 'right branch', files: { 'conflict.txt': 'right' } },
                { label: 'merge', parents: ['left', 'right'], description: 'conflict merge' },
                { label: 'wc', parents: ['merge'], isCurrentWorkingCopy: true },
            ]);
            const workspacePath =
                process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
            const { page } = await vscode.openWorkspace({ path: workspacePath }, { 'scm.autoReveal': true });
            await focusSCM(page);
            await vscode.evaluate(async (vscode, _api, mode) => {
                await vscode.commands.executeCommand(
                    mode === 'tree' ? 'workbench.scm.action.setTreeViewMode' : 'workbench.scm.action.setListViewMode',
                );
            }, viewMode);
            for (const scenario of [
                { group: /left branch/, merge: false },
                { group: /right branch/, merge: false },
                { group: /Merge Conflicts/, merge: true },
            ]) {
                const row = await expectFileInScmGroup(page, scenario.group, 'conflict.txt');
                await row.click();
                await expect(page.locator(scenario.merge ? '.merge-editor' : '.monaco-diff-editor')).toBeVisible();
                await page.waitForTimeout(750);
                await expect(row).toHaveAttribute('aria-selected', 'true');
                await expect(row).toHaveClass(/focused/);
                await hoverAndClick(row, row.getByRole('button', { name: 'Open File in Working Copy', exact: true }));
                await page.waitForTimeout(750);
                await expect(row).toHaveAttribute('aria-selected', 'true');
                await expect(row).toHaveClass(/focused/);
            }
            expect(repo.readFile('conflict.txt')).toContain('<<<<<<<');
        });
    }

    test('Displays correct groups and populates SCM input', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' } },
            { label: 'conflict-side-1', parents: ['initial'], description: 'side 1', files: { 'file.txt': 'a' } },
            { label: 'conflict-side-2', parents: ['initial'], description: 'side 2', files: { 'file.txt': 'b' } },
            {
                label: 'merge',
                parents: ['conflict-side-1', 'conflict-side-2'],
                description: 'merge',
                isCurrentWorkingCopy: false,
            },
            {
                label: 'wc',
                parents: ['merge'],
                description: 'my working copy',
                files: { 'new-file.ts': 'console.log("hello");\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // Verify groups
        const mergeConflictsHeader = page.getByRole('treeitem', { name: 'Merge Conflicts' });
        const workingCopyHeader = page.getByRole('treeitem', { name: /Working Copy/ });

        // Extended timeout for merge conflict groups to remain stable under parallel CPU load.
        const GROUP_VISIBILITY_TIMEOUT = 10_000;

        await expect(mergeConflictsHeader).toBeVisible({ timeout: GROUP_VISIBILITY_TIMEOUT });
        await expect(workingCopyHeader).toBeVisible({ timeout: GROUP_VISIBILITY_TIMEOUT });

        // Verify ancestor groups (merge commit is empty, showing parents @-2^1 and @-2^2)
        await expect(page.getByRole('treeitem', { name: /@-2\^1:.*side 1/ })).toBeVisible({
            timeout: GROUP_VISIBILITY_TIMEOUT,
        });
        await expect(page.getByRole('treeitem', { name: /@-2\^2:.*side 2/ })).toBeVisible({
            timeout: GROUP_VISIBILITY_TIMEOUT,
        });

        // Verify SCM input is populated with working copy description
        await expectScmDescription(page, 'my working copy');
    });

    test('Top-Level Commands: Commit and New Change', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' }, isCurrentWorkingCopy: true },
        ]);
        const initialId = commits.initial.changeId;
        const workspaceRootId = repo.getParents(initialId)[0];

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        const scmInput = page.getByRole('treeitem', { name: 'Source Control Input' });

        // Set Description and Commit with robust helper inside a single retry-safe block
        await expect(async () => {
            await setScmDescription(page, 'Updated description explicitly', vscode);

            // Commit using button inside the Source Control view title bar
            const commitButton = page.getByRole('button', { name: 'Commit (Ctrl+Enter)' }).first();
            await commitButton.click();

            await expect(async () => {
                expect(repo.log()).toContain('Updated description explicitly');
            }).toPass({ timeout: 5000 });
        }).toPass({ timeout: 15000 });

        // Ensure wait for SCM refresh before next action
        await expect(scmInput).not.toContainText('Updated description explicitly', { timeout: 10000 });

        const prevWcId = repo.getWorkingCopyId();

        // Click New Change (+)
        const newButton = page.getByRole('button', { name: 'New', exact: true }).first();
        await expect(newButton).toBeVisible();
        await newButton.click();

        // Wait for UI to reflect empty input box and tree to update
        await waitForTree(repo, [
            expect.stringMatching(new RegExp(`^@ [a-z0-9]+ \\[${prevWcId}\\] \\(empty\\)$`)),
            { changeId: prevWcId, description: '(empty)', parents: initialId },
            { changeId: initialId, description: 'Updated description explicitly', parents: workspaceRootId },
            { changeId: workspaceRootId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Keyboard Shortcuts: Ctrl+S and Ctrl+Enter', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' } },
            { label: 'wc', parents: ['initial'], description: '', isCurrentWorkingCopy: true },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);
        let scmInput: Locator | undefined;

        // Set Description and Save with Control+S
        await expect(async () => {
            scmInput = await setScmDescription(page, 'Using keyboard shortcuts', vscode);
            await page.keyboard.press('Control+S');

            // Wait for input to be stable (picked up by the backend)
            expect(repo.getDescription('@').trim()).toBe('Using keyboard shortcuts');
        }).toPass({ timeout: 15000 });

        // Set Description and Commit with Control+Enter
        await expect(async () => {
            scmInput = await setScmDescription(page, 'Commit via keyboard', vscode);
            await page.keyboard.press('Control+Enter');

            // Wait for it to be committed and appear in log
            const log = repo.log();
            expect(log).toContain('Commit via keyboard');
        }).toPass({ timeout: 15000 });

        if (!scmInput) {
            throw new Error('scmInput not initialized');
        }
        await expect(scmInput).not.toContainText('Commit via keyboard', { timeout: 10000 });
    });

    test('Format on Save for SCM Set Description and Commit', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' } },
            { label: 'wc', parents: ['initial'], description: '', isCurrentWorkingCopy: true },
        ]);

        const { page } = await vscode.openWorkspace(repo, {
            'jj-view.commit.formatDescriptionOnSave': true,
        });

        await focusSCM(page);

        const longBody =
            'This is a very long body text that should be wrapped onto multiple lines when saved because it exceeds the limit of seventy-two characters.';
        const messageToFormat = `Title line\n\n${longBody}`;

        // 1. Test Set Description (Ctrl+S)
        // Use a toPass block for the entire operation to handle synchronization delays
        // between the renderer and extension host.
        await expect(async () => {
            await setScmDescription(page, messageToFormat, vscode);
            await page.keyboard.press('Control+S');

            const desc = repo.getDescription('@');
            const expectedDesc =
                'Title line\n\nThis is a very long body text that should be wrapped onto multiple lines\nwhen saved because it exceeds the limit of seventy-two characters.';
            expect(desc).toBe(expectedDesc);
            expect(desc.split('\n').length).toBeGreaterThan(2);

            // Wait for the UI input box to reflect the formatted text
            await expectScmDescription(page, expectedDesc);
        }).toPass({ timeout: 20000 });

        // 2. Test Commit (Ctrl+Enter)
        const longBody2 =
            'Another very long body text that should be wrapped onto multiple lines when committed from the SCM input box.';
        const messageToFormat2 = `Commit Title\n\n${longBody2}`;

        await expect(async () => {
            const scmInput2 = await setScmDescription(page, messageToFormat2, vscode);

            await page.keyboard.press('Control+Enter');
            await expect(scmInput2).not.toContainText('Commit Title', { timeout: 5000 });

            // Wait for it to be committed, formatted, and appear in log
            const log = repo.log();
            expect(log).toContain('Commit Title');
            // Find latest commit description (working copy is parent of the new commit)
            const desc = repo.getDescription('@-');
            const expectedDesc = `Commit Title\n\nAnother very long body text that should be wrapped onto multiple lines\nwhen committed from the SCM input box.`;
            expect(desc).toBe(expectedDesc);
            expect(desc.split('\n').length).toBeGreaterThan(2);
        }).toPass({ timeout: 20000 });
    });

    test('Group-Level Actions: Abandon Working Copy and Squash Ancestor', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'base', description: '', files: { 'base.txt': '0' } },
            { label: 'initial', parents: ['base'], description: '', files: { 'i.txt': '1', 'other.txt': '0' } },
            {
                label: 'ancestor',
                parents: ['initial'],
                description: 'ancestor change',
                files: { 'a.txt': '1', 'a2.txt': '2' },
            },
            { label: 'middle', parents: ['ancestor'], description: 'middle change', files: { 'm.txt': '1' } },
            {
                label: 'wc',
                parents: ['middle'],
                description: '',
                files: { 'w.txt': '1', 'w2.txt': '2' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 1. Abandon Working Copy
        await clickScmAction(page, /Working Copy/, SCM_ACTIONS.Abandon);

        // Assert via repo that wc change is abandoned. Poll until true.
        await expect(async () => {
            const isWcChangeStillPresent = repo.log().includes(commits.wc.changeId);
            expect(isWcChangeStillPresent).toBe(false);
        }).toPass({ timeout: 5000 });

        // 2. Squash Ancestor into Initial
        // ancestor change is @-2 now because middle is still there.
        await clickScmAction(page, /ancestor change/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Assert via repo that the ancestor was squashed into its parent (initial). Poll until true.
        await expect(async () => {
            const logAfterSquash = repo.log();
            // The ancestor's change ID should be gone
            expect(logAfterSquash).not.toContain(commits.ancestor.changeId);
            // The middle change should still be there
            expect(logAfterSquash).toContain('middle change');

            // Verify files in initial (it should have its own files + ancestor's files)
            const filesInInitial = repo.getFiles(commits.initial.changeId);
            expect(filesInInitial).toContain('i.txt');
            expect(filesInInitial).toContain('a.txt');
            expect(filesInInitial).toContain('a2.txt');
            expect(filesInInitial).toContain('base.txt'); // inherited from base
        }).toPass({ timeout: 10000 });
    });

    test('Squash into Ancestor (Revision and Files)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'base.txt': '0' } },
            { label: 'target', description: '', files: { 't.txt': '0' } },
            { label: 'middle', description: 'middle message', files: { 'm.txt': '0' } },
            {
                label: 'source',
                description: 'source message',
                files: { 's.txt': '0', 's2.txt': '0' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 1. Squash Revision into Ancestor
        // We'll squash 'middle' into 'target'
        await clickScmAction(page, /middle message/, SCM_ACTIONS.SquashRevisionIntoAncestor);
        // Pick 'target' by its unique short changeId from quickpick
        await pickQuickPickItem(page, commits.target.changeId.substring(0, 8));

        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(commits.middle.changeId);
            const targetFiles = repo.getFiles(commits.target.changeId);
            expect(targetFiles).toContain('t.txt');
            expect(targetFiles).toContain('m.txt');
        }).toPass({ timeout: 10000 });

        // Wait for SCM tree to settle: m.txt and t.txt should be in the same group
        await expectFileInScmGroup(page, /middle message/i, 'm.txt');
        await expectFileInScmGroup(page, /middle message/i, 't.txt');

        // 2. Squash Files into Ancestor
        // We'll squash s.txt from 'source' (WC) into 'base'
        // Hover over s.txt row and click squash into ancestor
        await clickScmAction(page, /^s\.txt\b/, SCM_ACTIONS.SquashFilesIntoAncestor);
        // Pick 'base' by its unique description / short changeId from quickpick
        await pickQuickPickItem(page, 'base commit');

        // Wait for SCM tree to show s.txt under base commit group
        await expectFileInScmGroup(page, /base commit/i, 's.txt');

        await expect(async () => {
            const baseFiles = repo.getFiles(commits.base.changeId);
            expect(baseFiles).toContain('s.txt');

            // Verify s.txt is no longer modified in the working copy
            const wcDiff = repo.getDiffSummary('@');
            expect(wcDiff).not.toContain('s.txt');
        }).toPass({ timeout: 10000 });
    });

    test('File-Level Actions: Discard Changes and Diff Editing (Right Side)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            {
                label: 'initial',
                description: 'initial',
                files: { 'file.txt': 'base', 'file2.txt': 'base2', 'file3.txt': 'base3' },
            },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'wc change',
                files: { 'file.txt': 'mod', 'file2.txt': 'mod2', 'file3.txt': 'mod3' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);
        // Discard Changes (file3.txt)
        const wcFile3Row = await expectFileInScmGroup(page, /Working Copy/i, 'file3.txt');
        const discardIcon = wcFile3Row.locator('.action-item', { has: page.locator('.codicon-discard') }).first();
        await hoverAndClick(wcFile3Row, discardIcon);

        // Assert the file was restored by polling
        await expect(async () => {
            expect(repo.getFileContent('@', 'file3.txt').trim()).toBe('base3');
        }).toPass({ timeout: 5000 });

        // File-Level Squash (file.txt)
        // Hover over file.txt in Working Copy and click Squash
        // file.txt and the group squash action share the same codicon-arrow-down icon
        const wcFileRow = await expectFileInScmGroup(page, /Working Copy/i, 'file.txt');
        const squashFileIcon = wcFileRow
            .getByRole('button', { name: 'Squash File(s) into Parent', exact: true })
            .first();
        await hoverAndClick(wcFileRow, squashFileIcon);

        // Assert via repo that file.txt changes were squashed into the parent commit
        await expect(async () => {
            const parentChanges = repo.getDiffSummary('@-');
            expect(parentChanges).toContain('A file.txt');
            const wcChanges = repo.getDiffSummary('@');
            expect(wcChanges).not.toContain('A file.txt');
        }).toPass({ timeout: 5000 });

        // Open Single File Diff (file2.txt)
        await openScmDiff(page, /file2\.txt/);

        // Edit the right side of the diff editor (the working copy)
        const rightEditor = page.locator('.monaco-diff-editor .editor.modified');
        await rightEditor.click();

        // Selecting all text and typing
        // Use toPass to retry the entire typing sequence since Monaco can be finicky
        await expect(async () => {
            await rightEditor.click();
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
            await page.keyboard.insertText('edited from diff');
            await expect(rightEditor).toContainText('edited from diff', { timeout: 1000 });
        }).toPass({ timeout: 5000 });

        // Verify file content on disk and in jj using toPass polling
        await expect(async () => {
            await rightEditor.click();
            await page.keyboard.press('Control+S');

            const diskContent = fs.readFileSync(path.join(repo.path, 'file2.txt'), 'utf8').trim();
            expect(diskContent).toBe('edited from diff');

            const content = repo.getFileContent('@', 'file2.txt').trim();
            expect(content).toBe('edited from diff');
        }).toPass({ timeout: 10000, intervals: [100, 250, 500] });

        // Create a chain (initial -> wc_commit -> new_wc) to verify squash into a non-immediate ancestor
        await focusSCM(page);
        const scmInputSquash = await setScmDescription(page, 'commit wc', vscode);
        await page.keyboard.press('Control+Enter');
        await expect(scmInputSquash).not.toContainText('commit wc', { timeout: 10000 });

        await expect(async () => {
            expect(repo.getParents('@').length).toBe(1);
            expect(repo.getDiffSummary('@')).toBe('');
        }).toPass({ timeout: 10000 });
        // Now we have initial -> wc_commit -> new_wc
        // Modify file3.txt in the new working copy
        repo.writeFile('file3.txt', 'new mod3');

        // Click the SCM refresh button and wait for file3.txt to appear in SCM Working Copy
        const refreshButton = page.getByRole('button', { name: 'Refresh' }).first();
        let newWcFileRow!: Locator;
        await expect(async () => {
            await refreshButton.click();
            newWcFileRow = await expectFileInScmGroup(page, /Working Copy/i, 'file3.txt', { timeout: 1000 });
        }).toPass({ timeout: 10000 });

        // Hover to reveal inline actions
        await newWcFileRow.hover();
        const squashIcon = newWcFileRow
            .getByRole('button', { name: 'Squash File(s) into Parent', exact: true })
            .first();
        await expect(squashIcon).toBeVisible();

        // The squashInto action should be visible since there are two mutable ancestors
        const squashIntoIcon = newWcFileRow.getByRole('button', { name: /Squash File\(s\) into Ancestor/ }).first();
        const quickPickInput = page.getByRole('listbox');
        await expect(async () => {
            const isVisible = await quickPickInput.isVisible();
            if (!isVisible) {
                await hoverAndClick(newWcFileRow, squashIntoIcon);
            }
            await expect(quickPickInput).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 15000 });

        const ancestor2Option = page.getByRole('option', { name: /initial/i });
        await ancestor2Option.click();
        await expect(quickPickInput).not.toBeVisible({ timeout: 5000 });

        // Verify the squash happened by waiting for there to be only ONE file3.txt row (the ancestor one)
        await expect(async () => {
            await expectFileInScmGroup(page, /initial/i, 'file3.txt');
            const rows = page.getByRole('treeitem', { name: 'file3.txt' });
            const count = await rows.count();
            expect(count).toBe(1);
        }).toPass({ timeout: 10000 });

        await expect(async () => {
            const wcChanges = repo.getDiffSummary('@');
            expect(wcChanges).not.toContain('file3.txt');

            // The ancestor should now have the change.
            expect(repo.getFileContent('@--', 'file3.txt').trim()).toBe('new mod3');
        }).toPass({ timeout: 5000 });
    });

    test('Additional Actions: Absorb, Edit, Show Details, Squash File to Child', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'base.txt': '1' } },
            {
                label: 'ancestor',
                parents: ['initial'],
                description: 'ancestor change',
                files: { 'f1.txt': '1', 'f2.txt': '1' },
            },
            // Working copy edit of the same file f1.txt (to test absorb) and a new one
            {
                label: 'wc',
                parents: ['ancestor'],
                description: 'wc change',
                files: { 'f1.txt': '2', 'f3.txt': '1' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 1. Absorb
        await clickScmAction(page, /Working Copy/, SCM_ACTIONS.Absorb);

        // Wait for SCM refresh to confirm absorb (the wc change for f1.txt is consumed into ancestor)
        await expect(async () => {
            expect(repo.getFileContent(commits.ancestor.changeId, 'f1.txt').trim()).toBe('2');
        }).toPass({ timeout: 5000 });

        // 2. Show Details
        await expect(async () => {
            await clickScmAction(page, /ancestor change/, SCM_ACTIONS.ShowDetails);
            await waitForTab(page, /^Commit: /);
        }).toPass({ timeout: 20000 });

        // Return focus to SCM View
        await focusSCM(page);

        // 3. Squash File to Child (Pull from Ancestor)
        await expect(async () => {
            const wcChanges = repo.getDiffSummary('@');
            if (!wcChanges.includes('A f2.txt')) {
                const ancestorF2Row = await expectFileInScmGroup(page, /ancestor/i, 'f2.txt');
                await clickScmAction(page, ancestorF2Row, SCM_ACTIONS.SquashFilesIntoChild);
            }
            expect(repo.getDiffSummary('@')).toContain('A f2.txt');

            // Also wait for the UI SCM tree to refresh.
            // In SCM tree under Working Copy group, there should be f2.txt
            await expectFileInScmGroup(page, /Working Copy/i, /f2\.txt/i);
        }).toPass({ timeout: 15000 });

        // 4. Edit (Make ancestor the working copy)
        await clickScmAction(page, /ancestor change/, SCM_ACTIONS.Edit);

        // Assert via repo that the working copy is now the ancestor
        await expect(async () => {
            const changeId = repo.getWorkingCopyId();
            expect(changeId).toBe(commits.ancestor.changeId);
        }).toPass({ timeout: 15000 });
    });

    test('Multi-File Diff and Diff Editing', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f1.txt': '1', 'f2.txt': '1' } },
            {
                label: 'ancestor',
                parents: ['initial'],
                description: 'ancestor change',
                files: { 'f1.txt': '2', 'f2.txt': '2' },
            },
            { label: 'wc', parents: ['ancestor'], isCurrentWorkingCopy: true },
        ]);

        const workspacePath =
            process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
        const { page } = await vscode.openWorkspace({ path: workspacePath });

        await focusSCM(page);
        // 1. Multi-File Diff
        await clickScmAction(page, /ancestor change/, SCM_ACTIONS.MultiFileDiff);

        // Wait for Multi-File Diff View to appear
        await waitForTab(page, /ancestor change/);

        // Wait for the diff editor inside the view
        await page.waitForSelector('.monaco-diff-editor');

        // Find the editor for f1.txt's right side
        const firstRightEditor = page.locator('.monaco-diff-editor .editor.modified').first();
        await firstRightEditor.click();

        // Navigate out of readonly and type new text
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText('edited from multi-diff');
        await page.keyboard.press('Control+S');

        // Ensure the ancestor commit was mutated with the diff edits
        await expect(async () => {
            const f1Content = repo.getFileContent(commits.ancestor.changeId, 'f1.txt');
            expect(f1Content.trim()).toBe('edited from multi-diff');
        }).toPass({ timeout: 5000 });
    });

    test('File Watcher automatically updates SCM decorations', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'tracked.txt': 'base', 'unmodified.txt': 'base' } },
            { label: 'wc', parents: ['initial'], isCurrentWorkingCopy: true },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // Wait for initial load
        const initialWcGroup = page.getByRole('treeitem', { name: /Working Copy/ });
        await expect(initialWcGroup).toBeVisible();

        // The vscode fixture already awaits change detection watchers to be ready,
        // so we don't need a long blind wait here.

        // 1. Modify tracked.txt via filesystem (File Watcher picks it up)
        repo.writeFile('tracked.txt', 'modified');

        // 2. Wait for it to appear with "Modified" decoration
        await expectFileInScmGroup(page, /Working Copy/i, 'tracked.txt');

        // 3. Create a completely untracked file and add it to .gitignore
        repo.writeFile('.gitignore', 'totally-untracked.txt\n');
        repo.writeFile('totally-untracked.txt', 'ignored content');

        // 4. Focus the File Explorer pane to see the ignored decoration
        await page.keyboard.press('Control+Shift+E');

        // 5. Wait for the File Explorer to show the ignored file decoration
        // Force a refresh first because VS Code file watchers can sometimes miss fast external writes in tests
        await page.keyboard.press('Control+Alt+E');

        // VS Code's explorer treeitem has its own aria-label of the filename, but its child element contains the decoration
        const treeItem = page.getByRole('treeitem', { name: 'totally-untracked.txt', exact: true });
        const ignoredLabel = treeItem.locator('.monaco-icon-label[aria-label*="Ignored"]');
        await expect(ignoredLabel).toBeVisible({ timeout: 15000 });
    });

    test('Squash File to Child on Grandparent Commits', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'base.txt': '1' } },
            {
                label: 'grandparent',
                parents: ['initial'],
                description: 'grandparent change',
                files: { 'gp.txt': '1' },
            },
            {
                label: 'parent',
                parents: ['grandparent'],
                description: 'parent change',
                files: { 'p.txt': '1' },
            },
            {
                label: 'wc',
                parents: ['parent'],
                description: 'wc change',
                files: { 'wc.txt': '1' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 3. Squash File to Child (Pull from Ancestor)
        await clickScmAction(page, /gp\.txt/, SCM_ACTIONS.SquashFilesIntoChild);

        // Assert via repo that gp.txt from grandparent was moved to parent, NOT the working copy
        await expect(async () => {
            const parentChanges = repo.getDiffSummary('@-');
            expect(parentChanges).toContain('A gp.txt');
            expect(parentChanges).toContain('A p.txt');

            const wcChanges = repo.getDiffSummary('@');
            expect(wcChanges).not.toContain('A gp.txt');
            expect(wcChanges).toContain('A wc.txt');
        }).toPass({ timeout: 5000 });
    });

    test('File-Level Actions: Discard Changes on Ancestor Commits', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            {
                label: 'initial',
                description: 'initial',
                files: { 'file_ancestor.txt': 'base' },
            },
            {
                label: 'ancestor',
                parents: ['initial'],
                description: 'ancestor change',
                files: { 'file_ancestor.txt': 'mod in ancestor' },
            },
            {
                label: 'wc',
                parents: ['ancestor'],
                description: 'wc change',
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        const ancestorFileRow = await expectFileInScmGroup(page, /ancestor/i, 'file_ancestor.txt');

        const discardIcon = ancestorFileRow.locator('.action-item', { has: page.locator('.codicon-discard') }).first();
        await hoverAndClick(ancestorFileRow, discardIcon);

        await expect(async () => {
            expect(repo.getFileContent(commits.ancestor.changeId, 'file_ancestor.txt').trim()).toBe('base');
        }).toPass({ timeout: 5000 });
    });

    test('File Click Behavior: openDiffOnClick = true (Default)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            {
                label: 'base',
                files: { 'modified.txt': 'base', 'deleted.txt': 'base', 'conflict.txt': 'base' },
            },
            {
                label: 'side1',
                parents: ['base'],
                files: { 'conflict.txt': 'side1' },
            },
            {
                label: 'side2',
                parents: ['base'],
                files: { 'conflict.txt': 'side2' },
            },
            {
                label: 'wc',
                parents: ['side1', 'side2'], // Create conflict
                description: 'wc change',
                files: { 'modified.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);
        fs.unlinkSync(path.join(repo.path, 'deleted.txt'));

        const workspacePath =
            process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
        const { page } = await vscode.openWorkspace(
            { path: workspacePath },
            {
                'jj-view.openDiffOnClick': true,
            },
        );

        await focusSCM(page);

        // 1. Click modified.txt -> should open diff editor
        const modifiedRow = await openScmDiff(page, /modified\.txt/i);

        // 2. Click deleted.txt -> should open diff editor
        await openScmDiff(page, /deleted\.txt/i);

        // 3. Click conflict.txt -> should open merge editor
        await openScmMerge(page, /conflict\.txt/i);

        // 4. Open File via inline button -> should open regular editor
        const openFileIcon = modifiedRow
            .getByRole('button', { name: 'Open File in Working Copy', exact: true })
            .first();
        await hoverAndClick(modifiedRow, openFileIcon);
        await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.monaco-diff-editor')).not.toBeVisible();
    });

    test('File Click Behavior: openDiffOnClick = false', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            {
                label: 'base',
                files: { 'modified.txt': 'base', 'deleted.txt': 'base', 'conflict.txt': 'base' },
            },
            {
                label: 'side1',
                parents: ['base'],
                files: { 'conflict.txt': 'side1' },
            },
            {
                label: 'side2',
                parents: ['base'],
                files: { 'conflict.txt': 'side2' },
            },
            {
                label: 'wc',
                parents: ['side1', 'side2'],
                description: 'wc change',
                files: { 'modified.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);
        fs.unlinkSync(path.join(repo.path, 'deleted.txt'));

        const workspacePath =
            process.platform === 'win32' ? repo.path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : repo.path;
        const { page } = await vscode.openWorkspace(
            { path: workspacePath },
            {
                'jj-view.openDiffOnClick': false,
            },
        );

        await focusSCM(page);

        // 1. Click modified.txt -> should open regular editor
        const modifiedRow = await openScmFile(page, /modified\.txt/i);
        await expect(page.locator('.monaco-diff-editor')).not.toBeVisible();

        // 2. Click deleted.txt -> should still open diff editor
        await openScmDiff(page, /deleted\.txt/i);

        // 3. Click conflict.txt -> should open merge editor
        await openScmMerge(page, /conflict\.txt/i);

        // 4. Open Changes via inline button (for modified file) -> should open diff editor
        const openChangesIcon = modifiedRow.getByRole('button', { name: 'Open Changes', exact: true }).first();
        await hoverAndClick(modifiedRow, openChangesIcon);
        await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 5000 });
    });

    test('Squash selection into parent via diff editor context menu', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const fileName = 'squash-selection-e2e.txt';
        const fileContentOriginal = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
        const fileContentPartiallyModified = 'line 1\nline 2 modified\nline 3\nline 4\nline 5\n';
        const fileContentFullyModified = 'line 1\nline 2 modified\nline 3\nline 4 modified\nline 5\n';

        const ids = await buildGraph(repo, [
            {
                label: 'root',
                files: { 'initial.txt': 'initial' },
            },
            {
                label: 'base',
                parents: ['root'],
                files: {
                    [fileName]: fileContentOriginal,
                    'other.txt': 'other original',
                },
            },
            {
                label: 'side',
                parents: ['base'],
                files: { 'side.txt': 'side' },
            },
            {
                label: 'wc',
                parents: ['base'],
                files: {
                    [fileName]: fileContentFullyModified,
                    'other.txt': 'other modified\n',
                },
            },
        ]);
        repo.edit(ids.wc.changeId);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 1. Open Diff Editor
        await openScmDiff(page, fileName, /Working Copy/);

        // 2. Select the FIRST modified line in the right side (line 2)
        const rightEditor = page.locator('.monaco-diff-editor .editor.modified');
        const line2 = await selectLine(page, rightEditor, 'line 2 modified');

        // 3. Open Context Menu on the selected line and click "Squash Selection into Parent"
        await line2.click({ button: 'right' });
        await clickContextMenuItem(page, /Squash Selection into Parent/i);

        // 4. Verify the change is moved to the parent in JJ
        await expect(async () => {
            const parentContent = repo.getFileContent('@-', fileName);
            const wcContent = repo.getFileContent('@', fileName);
            const wcDiffSummary = repo.getDiffSummary('@');

            // Parent should have the first modification
            expect(parentContent).toBe(fileContentPartiallyModified);

            // Working copy should still have BOTH modifications (because it's the head)
            expect(wcContent).toBe(fileContentFullyModified);

            // other.txt should still be modified
            expect(wcDiffSummary).toContain('other.txt');
        }).toPass({ timeout: 15000 });
    });

    test('Squash selection into parent via non-working copy diff editor context menu', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const fileName = 'squash-selection-non-wc-e2e.txt';
        const fileContentOriginal = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
        const fileContentPartiallyModified = 'line 1\nline 2 modified\nline 3\nline 4\nline 5\n';
        const fileContentFullyModified = 'line 1\nline 2 modified\nline 3\nline 4 modified\nline 5\n';

        const ids = await buildGraph(repo, [
            {
                label: 'root',
                files: { [fileName]: fileContentOriginal },
            },
            {
                label: 'parent',
                parents: ['root'],
                description: 'parent commit',
            },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child commit',
                files: { [fileName]: fileContentFullyModified },
            },
            {
                label: 'wc',
                parents: ['child'],
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 1. Open Diff Editor for the 'child' commit
        // The group name in SCM for 'child' will be its description 'child commit'
        await openScmDiff(page, fileName, /child commit/);

        // 2. Select the FIRST modified line in the right side (line 2)
        // In a non-WC diff, the right side is the 'child' commit
        const rightEditor = page.locator('.monaco-diff-editor .editor.modified');
        const line2 = await selectLine(page, rightEditor, 'line 2 modified');

        // 3. Open Context Menu on the selected line and click "Squash Selection into Parent"
        await line2.click({ button: 'right' });
        await clickContextMenuItem(page, /Squash Selection into Parent/i);

        // 4. Verify the change is moved to the parent in JJ
        await expect(async () => {
            const parentContent = repo.getFileContent(ids.parent.changeId, fileName);
            const childContent = repo.getFileContent(ids.child.changeId, fileName);

            // Parent should now have the squashed modification
            expect(parentContent).toBe(fileContentPartiallyModified);

            // Child should still have its original content (but only line 4 is now "new" relative to parent)
            expect(childContent).toBe(fileContentFullyModified);

            // Check diff of child to be sure
            const childDiff = repo.getDiff(ids.child.changeId, { git: true });
            expect(childDiff).toContain('+line 4 modified');
            expect(childDiff).not.toContain('+line 2 modified');
        }).toPass({ timeout: 15000 });
    });

    test('Closes diff editor automatically when the revision is squashed', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const fileName = 'squashed-diff-close-e2e.txt';
        const commits = await buildGraph(repo, [
            {
                label: 'initial',
                files: { [fileName]: 'initial content' },
            },
            {
                label: 'target',
                parents: ['initial'],
                description: 'target commit message',
                files: { [fileName]: 'modified content' },
            },
            {
                label: 'wc',
                parents: ['target'],
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusSCM(page);

        // 1. Open Diff Editor for the target commit
        await openScmDiff(page, fileName, /target commit message/);

        // 2. Verify tab is open
        const tab = page.getByRole('tab', { name: fileName });
        await expect(tab).toBeVisible();

        // 3. Squash target commit into parent using SCM action
        await clickScmAction(page, /target commit message/, SCM_ACTIONS.SquashRevisionIntoParent);

        // 4. Verify that the tab gets closed automatically
        await expect(tab).not.toBeVisible({ timeout: 15000 });

        // 5. Verify target is actually squashed (changeId no longer exists) in jj
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(commits.target.changeId);
        }).toPass({ timeout: 10000 });
    });

    test('Working copy diff editor reflects edits made in plain file editor tab', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        try {
            const fileName = 'diff-refresh-plain-file.txt';
            await buildGraph(repo, [
                {
                    label: 'initial',
                    description: 'initial commit',
                    files: { [fileName]: 'line 1\nline 2\n' },
                },
                {
                    label: 'wc',
                    parents: ['initial'],
                    isCurrentWorkingCopy: true,
                    files: { [fileName]: 'line 1\nline 2 modified\n' },
                },
            ]);

            const { page } = await vscode.openWorkspace(repo);

            await focusSCM(page);

            // 1. Open diff editor from SCM for the working copy file
            await openScmDiff(page, fileName, /Working Copy/);

            // Verify the modified text is currently in the diff editor's right side
            const rightEditor = page.locator('.monaco-diff-editor .editor.modified');
            await expect(rightEditor).toContainText('line 2 modified');

            // 2. Open the plain file in an editor tab beside the diff editor
            await vscode.openFileInEditor(path.resolve(repo.path, fileName), {
                viewColumn: 2,
                preview: false,
            });
            const plainEditor = page.locator('.editor-group-container.active .monaco-editor');
            await expect(plainEditor).toBeVisible();

            // 3. Edit the plain file
            await plainEditor.click();
            await selectLine(page, plainEditor, 'line 2 modified');
            await page.keyboard.press('End');
            await page.keyboard.type(' with extra edits');
            await save(page);

            // 4. Switch back to the diff editor tab
            const diffTab = page.getByRole('tab', { name: /diff-refresh-plain-file\.txt/ }).first();
            await expect(diffTab).toBeVisible();
            await diffTab.click();

            // 5. Assert the right-hand side of the diff editor immediately reflects the updated plain file content
            await expect(rightEditor).toContainText('line 2 modified with extra edits', { timeout: 10000 });
        } finally {
            await repo.dispose();
        }
    });
});
