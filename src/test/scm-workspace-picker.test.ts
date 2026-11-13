/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { CodeForgeRegistry } from '../core/code-forge-registry';
import { commitCommand } from '../core/commands/commit';
import { setDescriptionCommand } from '../core/commands/describe';
import { getGraphCommandRepository } from '../core/host/graph-command-scope';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { JjViewFsService } from '../core/jj-view-fs-service';
import { Uri } from '../core/uri-utils';
import { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { resolveScmCommand } from '../vscode/scm-command-scope';
import { ScmWorkspacePicker } from '../vscode/scm-workspace-picker';
import { FakeCommandContext, FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { accessPrivate, createMock, createMockLogOutputChannel } from './test-utils';

describe('SCM workspace picker', () => {
    let disk: TestRepo;
    let feature: TestRepo;
    let manager: JjRepositoryManager;
    let host: FakeHostEnvironment;
    let current: VsCodeScmProvider;
    let picker: ScmWorkspacePicker;
    const providers = new Map<string, VsCodeScmProvider>();
    const log = createMockLogOutputChannel();
    const context = createMock<vscode.ExtensionContext>({ subscriptions: [] });

    beforeEach(async () => {
        disk = new TestRepo();
        disk.init();
        disk.writeFile('shared.txt', 'base\n');
        disk.snapshot();
        disk.new(undefined, 'main description');
        feature = disk.workspaceAdd('feature');
        feature.describe('feature description');
        feature.writeFile('shared.txt', 'feature content\n');
        disk.writeFile('shared.txt', 'main content\n');
        host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(disk.path));
        manager = new JjRepositoryManager(new CodeForgeRegistry(), log, host);
        const owner = await manager.maybeRegisterRepositoryContainingUri(Uri.file(disk.path));
        if (!owner) {
            throw new Error('Expected repository registration');
        }
        manager.setFocusedRepository(owner);
        current = new VsCodeScmProvider(context, owner, log, manager);
        providers.set(owner.rootUri.fsPath, current);
        picker = new ScmWorkspacePicker(
            owner,
            manager,
            current,
            (repo, model, label) => {
                current.dispose();
                current = new VsCodeScmProvider(
                    context,
                    repo,
                    log,
                    manager,
                    undefined,
                    undefined,
                    () => true,
                    model,
                    label,
                );
                providers.set(owner.rootUri.fsPath, current);
                return current;
            },
            log,
        );
        await picker.restore();
    });

    afterEach(async () => {
        picker.dispose();
        current.dispose();
        providers.clear();
        await manager.dispose();
        await disk.dispose();
    });

    test('shows one workspace and opens its own diff without changing graph or folders', async () => {
        const focused = manager.focusedRepository;
        const previous = current;
        host.ui.setNextQuickPickResponse({ label: 'feature' });
        await picker.pick();

        expect(previous.sourceControl.dispose).toHaveBeenCalledOnce();
        expect(providers.size).toBe(1);
        expect(current.repo.rootUri.fsPath).toBeSameFsPath(feature.path);
        expect(current.sourceControl.label).toContain('feature');
        expect(current.inputBoxValue).toBe('feature description');
        expect(manager.repositories).toHaveLength(1);
        expect(manager.focusedRepository).toBe(focused);
        expect(host.workspace.workspaceFolders).toHaveLength(1);
        expect(host.ui.quickPickCalls.at(-1)?.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ label: 'default', description: 'Selected' }),
                expect.objectContaining({ label: 'feature', detail: expect.stringContaining('feature') }),
            ]),
        );
        const group = accessPrivate<vscode.SourceControlResourceGroup>(current, '_workingCopyGroup');
        const row = group.resourceStates.find((state) => state.resourceUri.path.endsWith('/shared.txt'));
        expect(row).toBeDefined();
        const right = row?.command?.arguments?.[1];
        const left = row?.command?.arguments?.[0];
        if (!Uri.isUri(right) || !Uri.isUri(left)) {
            throw new Error('Expected diff URIs');
        }
        expect(fs.readFileSync(right.fsPath, 'utf8')).toBe('feature content\n');
        const view = new JjViewFsService(manager);
        try {
            expect(Buffer.from(await view.readFile(left)).toString()).toBe('base\n');
        } finally {
            view.dispose();
        }
        await manager.setFollowEditor(true);
        expect(manager.tryAutoSwitch(Uri.file(`${feature.path}/shared.txt`))).toBe(false);
        expect(manager.focusedRepository).toBe(focused);
    });

    test('preserves separate drafts and restores the selected workspace', async () => {
        current.sourceControl.inputBox.value = 'main draft';
        await picker.select('feature');
        current.sourceControl.inputBox.value = 'feature draft';
        await picker.select('default');
        expect(current.inputBoxValue).toBe('main draft');
        await picker.select('feature');
        expect(current.inputBoxValue).toBe('feature draft');
        picker.dispose();
        const owner = manager.repositories[0];
        current.dispose();
        current = new VsCodeScmProvider(context, owner, log, manager);
        picker = new ScmWorkspacePicker(
            owner,
            manager,
            current,
            (repo, model, label) => {
                current.dispose();
                current = new VsCodeScmProvider(
                    context,
                    repo,
                    log,
                    manager,
                    undefined,
                    undefined,
                    () => true,
                    model,
                    label,
                );
                return current;
            },
            log,
        );
        await picker.restore();
        expect(current.repo.rootUri.fsPath).toBeSameFsPath(feature.path);
        expect(current.sourceControl.label).toContain('feature');
    });

    test('routes input, title and resource actions to the selected workspace', async () => {
        const oldSourceControl = current.sourceControl;
        await picker.select('feature');
        expect(resolveScmCommand('jj-view.commit', [oldSourceControl], manager, providers, host)).toBeUndefined();
        host.documents.setActiveDocument(Uri.file(`${disk.path}/shared.txt`));
        current.sourceControl.inputBox.value = 'changed feature';
        const selected = resolveScmCommand('jj-view.setDescription', [], manager, providers, host);
        expect(selected?.repo).toBe(current.repo);
        if (!selected) {
            throw new Error('Expected selected SCM');
        }
        await setDescriptionCommand(new FakeCommandContext(selected.repo), { description: current.inputBoxValue });
        expect(feature.getDescription('@').trim()).toBe('changed feature');
        expect(disk.getDescription('@').trim()).toBe('main description');
        expect(resolveScmCommand('jj-view.new', [current.sourceControl], manager, providers, host)?.repo).toBe(
            current.repo,
        );
        const group = accessPrivate<vscode.SourceControlResourceGroup>(current, '_workingCopyGroup');
        expect(resolveScmCommand('jj-view.restore', [group], manager, providers, host)?.repo).toBe(current.repo);
        expect(resolveScmCommand('jj-view.restore', [group.resourceStates[0]], manager, providers, host)?.repo).toBe(
            current.repo,
        );
        expect(getGraphCommandRepository(manager, Uri.file(disk.path))).toBe(manager.repositories[0]);
        const mainId = disk.getWorkingCopyId();
        await commitCommand(new FakeCommandContext(selected.repo), { description: 'feature commit' });
        expect(disk.getWorkingCopyId()).toBe(mainId);
        expect(feature.getDescription('@-').trim()).toBe('feature commit');
    });

    test('leaves the current view and drafts intact on cancellation or missing workspace', async () => {
        current.sourceControl.inputBox.value = 'keep draft';
        const previous = current;
        host.ui.setNextQuickPickResponse(undefined);
        await picker.pick();
        expect(current).toBe(previous);
        host.ui.setNextQuickPickResponse({ label: 'missing' });
        await picker.pick();
        expect(current).toBe(previous);
        expect(current.inputBoxValue).toBe('keep draft');
        expect(host.ui.errorMessages[0]).toContain('Failed to switch SCM workspace');
    });

    test('rejects a deleted workspace and serializes rapid switches', async () => {
        await Promise.all([picker.select('feature'), picker.select('default')]);
        expect(current.repo.rootUri.fsPath).toBeSameFsPath(disk.path);
        // Keep the workspace registered in jj, but remove its working-copy marker.
        fs.renameSync(`${feature.path}/.jj`, `${feature.path}/.jj-missing`);
        await expect(picker.select('feature')).rejects.toThrow();
        expect(current.repo.rootUri.fsPath).toBeSameFsPath(disk.path);
    });

    test('supports a workspace outside Explorer and releases sessions when the owner closes', async () => {
        const external = new TestRepo();
        try {
            disk.workspaceAdd('outside', undefined, external.path);
            external.writeFile('outside.txt', 'outside edit');
            await picker.select('outside');
            expect(current.repo.rootUri.fsPath).toBeSameFsPath(external.path);
            expect(current.scmModel.snapshot?.workingCopyChanges.map((change) => change.path)).toContain('outside.txt');
            expect(manager.repositories).toHaveLength(1);
            const owner = manager.repositories[0];
            await manager.releaseWorkspaceRepositories(owner);
            expect(manager.getRepositoryForUri(Uri.file(`${external.path}/outside.txt`))).toBeUndefined();
        } finally {
            await external.dispose();
        }
    });
});
