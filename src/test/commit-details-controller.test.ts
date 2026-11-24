/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { CommitDetailsController } from '../core/controllers/commit-details-controller';
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../core/host/ipc/commit-details-schemas';
import { resolveRepository } from '../core/host/ui-helpers';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockWebviewClient, type MockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('CommitDetailsController Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let extraRepo: TestRepo | undefined;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let controller: CommitDetailsController;
    let client: MockWebviewClient<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        client = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });

        controller = new CommitDetailsController('@', repo, fakeHost);
        controller.addMessenger(client.webview);
    });

    afterEach(async () => {
        client.dispose();
        controller.dispose();
        await repositoryManager.dispose();
        await testRepo.dispose();
        await extraRepo?.dispose();
        extraRepo = undefined;
    });

    test('loads commit details and changes from real repository', async () => {
        testRepo.writeFile('file.txt', 'hello world\n');
        testRepo.describe('initial commit description');

        const log = await controller.load();

        expect(log).toBeDefined();
        expect(controller.logEntry).toBeDefined();
        expect(controller.logEntry?.description).toContain('initial commit description');
        expect(controller.changes?.length).toBeGreaterThan(0);
    });

    test('publishes freshly snapshotted files before the repository refresh', async () => {
        const repo = controller.repo;
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }
        await repo.watcher.dispose();
        await controller.load();
        writeFileSync(path.join(testRepo.path, 'on-open.txt'), 'not snapshotted yet\n');

        const refreshStarted = Promise.withResolvers<void>();
        const finishRefresh = Promise.withResolvers<void>();
        const subscription = repo.onDidStatusChange(() => {
            refreshStarted.resolve();
            return finishRefresh.promise;
        });
        const open = controller.open();
        try {
            const refreshReached = await Promise.race([
                refreshStarted.promise.then(() => true),
                open.then(() => false),
            ]);
            expect(refreshReached).toBe(true);
            expect(client.receivedMessages).toContainEqual({
                type: 'update',
                payload: expect.objectContaining({
                    files: expect.arrayContaining([expect.objectContaining({ path: 'on-open.txt' })]),
                }),
            });
        } finally {
            finishRefresh.resolve();
            subscription.dispose();
            await open;
        }
    });

    test('closing details during the revision lookup skips the workspace snapshot', async () => {
        await controller.repo?.watcher.dispose();
        const originalCommit = testRepo.getCommitId('@');
        writeFileSync(path.join(testRepo.path, 'preview-only.txt'), 'still unsnapshotted\n');

        const process = fakeHost.system.process;
        const execFile = process.execFile.bind(process);
        const closeOnLookup = vi.spyOn(process, 'execFile').mockImplementation(async (...args) => {
            const result = await execFile(...args);
            if (args[1].includes('log') && args[1].includes('@')) {
                controller.dispose();
            }
            return result;
        });
        try {
            await controller.open();
            expect(controller.isDisposed).toBe(true);
            expect(testRepo.getCommitId('@')).toBe(originalCommit);
        } finally {
            closeOnLookup.mockRestore();
        }
    });

    test('closing details during workspace resolution skips the named workspace snapshot', async () => {
        const repo = controller.repo;
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }
        await repo.watcher.dispose();
        const other = testRepo.workspaceAdd('other');
        const originalCommit = other.getCommitId('@');
        writeFileSync(path.join(other.path, 'preview-only.txt'), 'still unsnapshotted\n');
        controller.dispose();
        controller = new CommitDetailsController(other.getChangeId('@'), repo, fakeHost);

        const process = fakeHost.system.process;
        const execFile = process.execFile.bind(process);
        const closeOnWorkspaceRoot = vi.spyOn(process, 'execFile').mockImplementation(async (...args) => {
            const result = await execFile(...args);
            if (args[1].includes('--name') && args[1].includes('other')) {
                controller.dispose();
            }
            return result;
        });
        try {
            await controller.open();
            expect(controller.isDisposed).toBe(true);
            expect(other.getCommitId('@')).toBe(originalCommit);
        } finally {
            closeOnWorkspaceRoot.mockRestore();
            await other.dispose();
        }
    });

    test('opens historical details without broadcasting a repository refresh', async () => {
        const repo = controller.repo;
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }
        await repo.watcher.dispose();
        testRepo.writeFile('historical.txt', 'existing file\n');
        testRepo.new();
        controller.dispose();
        controller = new CommitDetailsController(testRepo.getChangeId('@-'), repo, fakeHost);
        const statuses = vi.fn();
        const subscription = repo.onDidStatusChange(statuses);
        try {
            await controller.open();
            expect(controller.changes?.map((file) => file.path)).toContain('historical.txt');
            expect(statuses).not.toHaveBeenCalled();
        } finally {
            subscription.dispose();
        }
    });

    test('disabling refresh on open leaves manual refresh available and preserves drafts', async () => {
        await controller.repo?.watcher.dispose();
        fakeHost.config.set('commit.refreshOnOpen', false);
        await controller.load();
        controller.updateDraft('unsaved draft');
        writeFileSync(path.join(testRepo.path, 'manual.txt'), 'not snapshotted yet\n');
        await controller.open();
        expect(controller.changes?.map((file) => file.path)).not.toContain('manual.txt');

        await controller.handleMessage({ type: 'refresh' });
        expect(controller.changes?.map((file) => file.path)).toContain('manual.txt');
        expect(controller.draftDescription).toBe('unsaved draft');
    });

    test('opening and manually refreshing snapshots a change in another workspace', async () => {
        const other = testRepo.workspaceAdd('other');
        const changeId = other.getChangeId('@');
        controller.dispose();
        controller = new CommitDetailsController(changeId, repositoryManager.repositories[0], fakeHost);
        controller.addMessenger(client.webview);
        try {
            writeFileSync(path.join(other.path, 'other-open.txt'), 'new file in unopened workspace\n');
            await controller.open();
            expect(controller.changes?.map((file) => file.path)).toContain('other-open.txt');

            writeFileSync(path.join(other.path, 'other-manual.txt'), 'another new file\n');
            await controller.handleMessage({ type: 'refresh' });
            expect(controller.changes?.map((file) => file.path)).toContain('other-manual.txt');
            expect(testRepo.getChangeId('@')).not.toBe(changeId);
        } finally {
            other.dispose();
        }
    });

    test('opens cached details while a refresh error notification is pending', async () => {
        const repo = controller.repo;
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }
        await repo.watcher.dispose();
        const other = testRepo.workspaceAdd('other');
        other.writeFile('cached.txt', 'already snapshotted\n');
        other.describe('Change in the unavailable workspace');
        const changeId = other.getChangeId('@');
        await other.dispose();

        const notification = Promise.withResolvers<string | undefined>();
        const showError = vi.spyOn(fakeHost.ui, 'showErrorMessage').mockReturnValue(notification.promise);
        controller.dispose();
        controller = new CommitDetailsController(changeId, repo, fakeHost);
        const open = controller.open();
        try {
            await vi.waitFor(
                () => {
                    expect(showError).toHaveBeenCalledWith(
                        expect.stringContaining('Failed to refresh change details'),
                        'Show Log',
                    );
                    expect(controller.changes?.map((file) => file.path) ?? []).toContain('cached.txt');
                },
                { timeout: 10000 },
            );
        } finally {
            notification.resolve(undefined);
            await open;
            showError.mockRestore();
        }
    });

    test('preserves draft description when reloading commit data', async () => {
        testRepo.writeFile('file.txt', 'hello\n');
        testRepo.describe('persisted description');

        await controller.load();
        expect(controller.draftDescription).toBe('persisted description');
        expect(controller.hasUnsavedDraft).toBe(false);
        expect(controller.getState()?.unsavedDraft).toBeUndefined();

        // User types a draft
        controller.updateDraft('in-progress draft editing');
        expect(controller.draftDescription).toBe('in-progress draft editing');
        expect(controller.hasUnsavedDraft).toBe(true);

        // Background reload happens
        await controller.load();
        expect(controller.draftDescription).toBe('in-progress draft editing');
        expect(controller.persistedDescription).toBe('persisted description');
        // The state payload keeps the persisted text as the baseline and
        // carries the draft separately so a remounted view can resume it.
        expect(controller.getState()?.description).toBe('persisted description');
        expect(controller.getState()?.unsavedDraft).toBe('in-progress draft editing');

        await controller.save();
        expect(controller.hasUnsavedDraft).toBe(false);
        expect(controller.getState()?.unsavedDraft).toBeUndefined();
    });

    test('saves commit description to real repository', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('old description');

        await controller.load();
        const saved = await controller.save('new updated description');

        expect(saved).toBe(true);
        expect(controller.draftDescription).toBe('new updated description');
        expect(controller.persistedDescription).toBe('new updated description');

        // Verify with real log on disk
        const log = testRepo.log();
        expect(log).toContain('new updated description');
    });

    test('handles descriptionChanged RPC message', async () => {
        const handled = await controller.handleMessage({
            type: 'descriptionChanged',
            payload: {
                description: 'typed from webview',
                selectionStart: 5,
                selectionEnd: 5,
            },
        });

        expect(handled).toBe(true);
        expect(controller.draftDescription).toBe('typed from webview');
    });

    test('replays initial state snapshot to newly attached messenger after load', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial commit for replay');

        await controller.load();

        const lateClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        controller.addMessenger(lateClient.webview);
        await Promise.resolve();

        expect(lateClient.receivedMessages).toHaveLength(1);
        expect(lateClient.receivedMessages[0]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                description: 'initial commit for replay',
            }),
        });

        lateClient.dispose();
    });

    test('fires onDidClose only when the last messenger detaches', async () => {
        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }
        const testController = new CommitDetailsController('@', repo, fakeHost);
        const closeListener = vi.fn();
        testController.onDidClose(closeListener);

        const client1 = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        const client2 = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });

        const sub1 = testController.addMessenger(client1.webview);
        const sub2 = testController.addMessenger(client2.webview);

        // Disposing first messenger does not fire onDidClose because client2 is still attached
        sub1.dispose();
        expect(closeListener).not.toHaveBeenCalled();

        // Disposing second messenger fires onDidClose
        sub2.dispose();
        expect(closeListener).toHaveBeenCalledTimes(1);

        client1.dispose();
        client2.dispose();
        testController.dispose();
    });

    test('loads commit details for a conflicted commit', async () => {
        testRepo.writeFile('file.txt', 'base content\n');
        testRepo.describe('base');

        testRepo.new(['@'], 'side 1');
        testRepo.writeFile('file.txt', 'side 1 content\n');

        testRepo.new(['@-'], 'side 2');
        testRepo.writeFile('file.txt', 'side 2 content\n');

        testRepo.new(['@-+', '@'], 'merge with conflict');

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }
        const conflictController = new CommitDetailsController('@', repo, fakeHost);
        const conflictClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        conflictController.addMessenger(conflictClient.webview);

        const log = await conflictController.load();
        expect(log).toBeDefined();
        expect(conflictController.logEntry?.conflict).toBe(true);

        const state = conflictController.getState();
        expect(state).toBeDefined();
        expect(state?.isConflict).toBe(true);
        expect(state?.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'file.txt',
                    conflicted: true,
                    conflictSides: 2,
                }),
            ]),
        );

        const updates = conflictClient.receivedMessages.filter((m) => m.type === 'update');
        expect(updates.length).toBeGreaterThanOrEqual(2);
        expect(updates[0]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                isConflict: true,
                files: expect.arrayContaining([
                    expect.objectContaining({
                        path: 'file.txt',
                        conflicted: true,
                        conflictSides: 2,
                    }),
                ]),
            }),
        });
        expect(updates[updates.length - 1]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                isConflict: true,
                isLoadingFiles: false,
                files: expect.arrayContaining([
                    expect.objectContaining({
                        path: 'file.txt',
                        conflicted: true,
                        conflictSides: 2,
                    }),
                ]),
            }),
        });

        conflictClient.dispose();
        conflictController.dispose();
    });

    test('loads commit details for a divergent commit', async () => {
        testRepo.writeFile('file.txt', 'v1\n');
        testRepo.describe('feature v1');
        const changeId = testRepo.getChangeId('@');
        const commitIdV1 = testRepo.getCommitId('@');

        testRepo.describe('feature v2', changeId);
        testRepo.bookmark('old-version', commitIdV1);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }

        const logs = await repo.jj.getLog({ revision: 'all()' });
        const divergentEntry = logs.find((l) => l.is_divergent);
        expect(divergentEntry).toBeDefined();
        if (!divergentEntry) {
            throw new Error('divergentEntry not found');
        }
        expect(divergentEntry.change_id).toContain('/');

        const divergentController = new CommitDetailsController(divergentEntry.change_id, repo, fakeHost);
        const log = await divergentController.load();
        expect(log).toBeDefined();
        expect(divergentController.logEntry?.change_id).toBe(divergentEntry.change_id);
        expect(divergentController.getState()?.changeId).toBe(divergentEntry.change_id);

        divergentController.dispose();
    });

    test('shows changed files before their line counts', async () => {
        testRepo.writeFile('big-file.txt', 'first line\nsecond line\n');
        testRepo.describe('fast metadata commit');
        const changeId = testRepo.getChangeId('@');

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }

        const detailsController = new CommitDetailsController(changeId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();

        const updates = detailsClient.receivedMessages.filter((m) => m.type === 'update');
        expect(updates.length).toBe(2);

        expect(updates[0]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                changeId,
                description: 'fast metadata commit',
                isLoadingFiles: false,
                files: [{ path: 'big-file.txt', status: 'added', conflicted: false }],
            }),
        });

        expect(updates[1]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                changeId,
                description: 'fast metadata commit',
                isLoadingFiles: false,
                files: expect.arrayContaining([
                    expect.objectContaining({
                        path: 'big-file.txt',
                        status: 'added',
                        additions: 2,
                        deletions: 0,
                    }),
                ]),
            }),
        });

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('initial payload shows metadata while files load and preserves dirty drafts', async () => {
        testRepo.writeFile('initial.txt', 'initial');
        testRepo.describe('persisted description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        detailsController.updateDraft('unsaved dirty description');

        const payload = await detailsController.getInitialPayload();
        expect(payload).toBeDefined();
        expect(payload?.changeId).toBe(commitId);
        expect(detailsController.draftDescription).toBe('unsaved dirty description');
        expect(payload?.isLoadingFiles).toBe(true);
        expect(payload?.files).toEqual([]);

        await detailsController.load();
        expect(detailsController.getState()?.files?.map((file) => file.path)).toEqual(['initial.txt']);
        expect(detailsController.getState()?.isLoadingFiles).toBe(false);
        expect(detailsController.draftDescription).toBe('unsaved dirty description');

        detailsController.dispose();
    });

    test('a slow line count cannot block or overwrite details for a rewritten commit', async () => {
        await controller.repo?.watcher.dispose();
        testRepo.writeFile('changed.txt', 'first line\n');
        testRepo.describe('original');
        const originalCommit = testRepo.getCommitId('@');

        const countsStarted = Promise.withResolvers<void>();
        const finishCounts = Promise.withResolvers<void>();
        const process = fakeHost.system.process;
        const execFile = process.execFile.bind(process);
        const delayCounts = vi.spyOn(process, 'execFile').mockImplementation(async (...args) => {
            const result = await execFile(...args);
            if (args[1].includes(originalCommit) && args[1].some((arg) => arg.includes('self.diff().stat()'))) {
                countsStarted.resolve();
                await finishCounts.promise;
            }
            return result;
        });

        const firstLoad = controller.load();
        let secondLoad: ReturnType<typeof controller.load> | undefined;
        try {
            const countsPending = await Promise.race([
                countsStarted.promise.then(() => true),
                firstLoad.then(() => false),
            ]);
            expect(countsPending).toBe(true);
            testRepo.writeFile('changed.txt', 'first line\nsecond line\n');
            testRepo.describe('rewritten');
            secondLoad = controller.load();
            await vi.waitFor(
                () => {
                    expect(controller.changes?.[0]?.additions).toBe(2);
                },
                { timeout: 10000 },
            );
        } finally {
            finishCounts.resolve();
            await Promise.all([firstLoad, secondLoad]);
            delayCounts.mockRestore();
        }
        expect(controller.changes?.[0]?.additions).toBe(2);
    });

    test('revert dispatches both update and updateDescription messages to reset webview state', async () => {
        testRepo.writeFile('initial.txt', 'initial');
        testRepo.describe('persisted description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();
        detailsController.updateDraft('unsaved user edits');
        expect(detailsController.draftDescription).toBe('unsaved user edits');

        detailsController.revert();
        expect(detailsController.draftDescription).toBe('persisted description');

        await new Promise((resolve) => setTimeout(resolve, 10));

        const updateDescMessage = detailsClient.receivedMessages.find((m) => m.type === 'updateDescription');
        expect(updateDescMessage).toEqual({
            type: 'updateDescription',
            payload: {
                description: 'persisted description',
                selectionStart: 0,
                selectionEnd: 0,
            },
        });

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('preserves in-flight edits typed while save is actively executing', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();
        detailsController.updateDraft('version 2 to save');

        // Start save
        const savePromise = detailsController.save();

        // While save is in flight, user types more
        detailsController.updateDraft('version 2 to save + concurrent edits');

        const saved = await savePromise;
        expect(saved).toBe(true);

        // Draft must NOT be purged!
        expect(detailsController.draftDescription).toBe('version 2 to save + concurrent edits');
        expect(detailsController.persistedDescription).toBe('version 2 to save');

        // Verify saveComplete message sent to webview has savedDraft
        const saveCompleteMsg = detailsClient.receivedMessages.find((m) => m.type === 'saveComplete');
        expect(saveCompleteMsg).toEqual({
            type: 'saveComplete',
            payload: {
                description: 'version 2 to save',
                savedDraft: 'version 2 to save',
            },
        });

        // Repository on disk has 'version 2 to save'
        expect(testRepo.log()).toContain('version 2 to save');

        // A second save now persists the remaining in-flight edits
        const secondSave = await detailsController.save();
        expect(secondSave).toBe(true);
        expect(detailsController.draftDescription).toBe('version 2 to save + concurrent edits');
        expect(detailsController.persistedDescription).toBe('version 2 to save + concurrent edits');
        expect(testRepo.log()).toContain('version 2 to save + concurrent edits');

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('coalesces concurrent save calls and saves latest draft sequentially', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        await detailsController.load();

        detailsController.updateDraft('draft 1');
        const save1 = detailsController.save();

        detailsController.updateDraft('draft 2');
        const save2 = detailsController.save();

        detailsController.updateDraft('draft 3');
        const save3 = detailsController.save();

        const results = await Promise.all([save1, save2, save3]);
        expect(results).toEqual([true, true, true]);

        expect(detailsController.draftDescription).toBe('draft 3');
        expect(detailsController.persistedDescription).toBe('draft 3');
        expect(testRepo.log()).toContain('draft 3');

        detailsController.dispose();
    });

    test('records edit on host when in-flight edits are present upon save completion', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const editRecordedListener = vi.fn();
        const detailsController = new CommitDetailsController(commitId, repo, fakeHost, {
            onEditRecorded: editRecordedListener,
        });

        await detailsController.load();
        detailsController.updateDraft('first draft to save');

        const savePromise = detailsController.save();
        detailsController.updateDraft('first draft to save + more typing');

        await savePromise;

        // Allow microtask to fire
        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });

        expect(editRecordedListener).toHaveBeenCalled();
        const lastCall = editRecordedListener.mock.calls[editRecordedListener.mock.calls.length - 1];
        expect(lastCall[0]).toEqual(
            expect.objectContaining({
                label: 'Edit Description',
            }),
        );

        detailsController.dispose();
    });

    test('dispatches jj-view.compareWithUploaded command on openCompareWithUploaded message', async () => {
        const executeSpy = vi.spyOn(fakeHost.commands, 'executeCommand');

        const handled = await controller.handleMessage({
            type: 'openCompareWithUploaded',
            payload: { changeId: '@' },
        });

        expect(handled).toBe(true);
        expect(executeSpy).toHaveBeenCalledWith('jj-view.compareWithUploaded', '@');
    });

    test('flushes pending debounced draft description before dispatching splitFiles', async () => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.writeFile('b.txt', 'b\n');
        testRepo.describe('initial description');
        const changeId = testRepo.getChangeId('@');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        const callOrder: string[] = [];
        const splitController = new CommitDetailsController(changeId, repoInstance, fakeHost);
        const splitClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        splitController.addMessenger(splitClient.webview);

        const setDescDisposable = fakeHost.commands.registerCommand(
            'jj-view.setDescription',
            async (desc: string, rev: string) => {
                callOrder.push(`setDescription:${rev}:${desc}`);
                await repoInstance.jj.describe(desc, rev);
                return desc;
            },
        );
        const splitBeforeDisposable = fakeHost.commands.registerCommand(
            'jj-view.splitFilesBefore',
            async (payload: { paths: string[]; revision?: string }) => {
                callOrder.push(`splitBefore:${payload.revision}:${payload.paths.join(',')}`);
                // Description must already be persisted on disk when split starts
                expect(testRepo.getDescription(changeId)).toBe('flushed draft before split');
            },
        );

        try {
            await splitController.load();

            // Type a new description (leaves 200ms debounce timer pending + unsaved draft)
            await splitController.handleMessage({
                type: 'descriptionChanged',
                payload: {
                    description: 'flushed draft before split',
                    selectionStart: 0,
                    selectionEnd: 0,
                },
            });
            expect(splitController.hasUnsavedDraft).toBe(true);

            const handled = await splitController.handleMessage({
                type: 'splitFiles',
                payload: {
                    changeId,
                    paths: ['a.txt'],
                    placement: 'before',
                },
            });

            expect(handled).toBe(true);
            expect(callOrder).toEqual([
                `setDescription:${changeId}:flushed draft before split`,
                `splitBefore:${changeId}:a.txt`,
            ]);
            expect(splitController.hasUnsavedDraft).toBe(false);
            expect(splitController.persistedDescription).toBe('flushed draft before split');
        } finally {
            setDescDisposable.dispose();
            splitBeforeDisposable.dispose();
            splitClient.dispose();
            splitController.dispose();
        }
    });

    test('awaits in-flight save and subsequent edits before executing splitFilesAfter', async () => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.writeFile('b.txt', 'b\n');
        testRepo.describe('original');
        const changeId = testRepo.getChangeId('@');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        const splitController = new CommitDetailsController(changeId, repoInstance, fakeHost);
        let releaseFirstSave!: () => void;
        const firstSaveGate = new Promise<void>((resolve) => {
            releaseFirstSave = resolve;
        });
        const events: string[] = [];
        let saveCount = 0;

        const setDescDisposable = fakeHost.commands.registerCommand(
            'jj-view.setDescription',
            async (desc: string, rev: string) => {
                saveCount++;
                events.push(`save-start:${saveCount}:${desc}`);
                if (saveCount === 1) {
                    await firstSaveGate;
                }
                await repoInstance.jj.describe(desc, rev);
                events.push(`save-end:${saveCount}:${desc}`);
                return desc;
            },
        );
        const splitAfterDisposable = fakeHost.commands.registerCommand(
            'jj-view.splitFilesAfter',
            async (payload: { paths: string[]; revision?: string }) => {
                events.push(`splitAfter:${payload.revision}:${payload.paths.join(',')}`);
            },
        );

        try {
            await splitController.load();

            splitController.updateDraft('first draft');
            const firstSavePromise = splitController.save();

            // Concurrent edit while first save is in flight
            splitController.updateDraft('second draft');

            const splitPromise = splitController.handleMessage({
                type: 'splitFiles',
                payload: {
                    changeId,
                    paths: ['a.txt', 'b.txt'],
                    placement: 'after',
                },
            });

            // Split must not start before both saves complete
            await Promise.resolve();
            expect(events).toEqual(['save-start:1:first draft']);

            releaseFirstSave();
            await Promise.all([firstSavePromise, splitPromise]);

            expect(events).toEqual([
                'save-start:1:first draft',
                'save-end:1:first draft',
                'save-start:2:second draft',
                'save-end:2:second draft',
                `splitAfter:${changeId}:a.txt,b.txt`,
            ]);
            expect(testRepo.getDescription(changeId)).toBe('second draft');
        } finally {
            setDescDisposable.dispose();
            splitAfterDisposable.dispose();
            splitController.dispose();
        }
    });

    test('aborts splitFiles when saving pending draft description fails', async () => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('initial');
        const changeId = testRepo.getChangeId('@');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        const splitController = new CommitDetailsController(changeId, repoInstance, fakeHost);
        const setDescDisposable = fakeHost.commands.registerCommand('jj-view.setDescription', async () => false);
        const splitSpy = vi.fn();
        const splitBeforeDisposable = fakeHost.commands.registerCommand('jj-view.splitFilesBefore', splitSpy);

        try {
            await splitController.load();
            splitController.updateDraft('failing draft');

            await splitController.handleMessage({
                type: 'splitFiles',
                payload: { changeId, paths: ['a.txt'], placement: 'before' },
            });

            expect(splitSpy).not.toHaveBeenCalled();
            expect(splitController.hasUnsavedDraft).toBe(true);
        } finally {
            setDescDisposable.dispose();
            splitBeforeDisposable.dispose();
            splitController.dispose();
        }
    });

    test('flushPendingSave awaits actively running queued _nextSavePromise without duplicate save', async () => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('initial');
        const changeId = testRepo.getChangeId('@');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        const splitController = new CommitDetailsController(changeId, repoInstance, fakeHost);
        let releaseSave1!: () => void;
        const save1Gate = new Promise<void>((resolve) => {
            releaseSave1 = resolve;
        });
        let releaseSave2!: () => void;
        const save2Gate = new Promise<void>((resolve) => {
            releaseSave2 = resolve;
        });
        let notifySave2Started!: () => void;
        const save2Started = new Promise<void>((resolve) => {
            notifySave2Started = resolve;
        });

        const events: string[] = [];
        let saveCount = 0;

        const setDescDisposable = fakeHost.commands.registerCommand(
            'jj-view.setDescription',
            async (desc: string, rev: string) => {
                saveCount++;
                const idx = saveCount;
                events.push(`save-start:${idx}:${desc}`);
                if (idx === 1) {
                    await save1Gate;
                } else if (idx === 2) {
                    notifySave2Started();
                    await save2Gate;
                }
                await repoInstance.jj.describe(desc, rev);
                events.push(`save-end:${idx}:${desc}`);
                return desc;
            },
        );
        const splitBeforeDisposable = fakeHost.commands.registerCommand(
            'jj-view.splitFilesBefore',
            async (payload: { paths: string[]; revision?: string }) => {
                events.push(`splitBefore:${payload.revision}:${payload.paths.join(',')}`);
            },
        );

        try {
            await splitController.load();

            splitController.updateDraft('first draft');
            const firstSavePromise = splitController.save();

            // Explicitly queue _nextSavePromise while save 1 is in flight
            splitController.updateDraft('second draft');
            const secondSavePromise = splitController.save();

            releaseSave1();
            await save2Started;

            // Now save 2 (the formerly queued _nextSavePromise) is actively executing inside _executeSave().
            // Even if draft matches persisted or changes are settled, flushPendingSave must wait for save 2
            // without launching a concurrent save 3 or letting splitFiles race ahead.
            const splitPromise = splitController.handleMessage({
                type: 'splitFiles',
                payload: { changeId, paths: ['a.txt'], placement: 'before' },
            });

            await Promise.resolve();
            await Promise.resolve();
            expect(events).toEqual(['save-start:1:first draft', 'save-end:1:first draft', 'save-start:2:second draft']);

            releaseSave2();
            await Promise.all([firstSavePromise, secondSavePromise, splitPromise]);

            expect(saveCount).toBe(2);
            expect(events).toEqual([
                'save-start:1:first draft',
                'save-end:1:first draft',
                'save-start:2:second draft',
                'save-end:2:second draft',
                `splitBefore:${changeId}:a.txt`,
            ]);
            expect(testRepo.getDescription(changeId)).toBe('second draft');
        } finally {
            setDescDisposable.dispose();
            splitBeforeDisposable.dispose();
            splitController.dispose();
        }
    });

    test('multi-repo flushPendingSave passes controller rootUri to jj-view.setDescription', async () => {
        const repoB = new TestRepo();
        extraRepo = repoB;
        repoB.init();
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('repo A initial');
        const changeIdA = testRepo.getChangeId('@');

        repoB.writeFile('b.txt', 'b\n');
        repoB.describe('repo B initial');

        fakeHost.workspace.addFolder(Uri.file(repoB.path));
        const repoAInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        const repoBInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(repoB.path));
        if (!repoAInstance || !repoBInstance) {
            throw new Error('multi-repo instances not found');
        }

        // Focus Repo B so unfocused fallback would hit the wrong repository
        repositoryManager.setFocusedRepository(repoBInstance);

        const splitControllerA = new CommitDetailsController(changeIdA, repoAInstance, fakeHost);
        const capturedSetDescArgs: unknown[][] = [];
        const capturedSplitPayloads: unknown[] = [];

        const setDescDisposable = fakeHost.commands.registerCommand(
            'jj-view.setDescription',
            async (...args: unknown[]) => {
                capturedSetDescArgs.push(args);
                const targetRepo = resolveRepository(repositoryManager, { args, host: fakeHost });
                const desc = typeof args[0] === 'string' ? args[0] : '';
                const rev = typeof args[1] === 'string' ? args[1] : '@';
                if (targetRepo) {
                    await targetRepo.jj.describe(desc, rev);
                }
                return desc;
            },
        );
        const splitBeforeDisposable = fakeHost.commands.registerCommand(
            'jj-view.splitFilesBefore',
            async (payload: unknown) => {
                capturedSplitPayloads.push(payload);
            },
        );

        try {
            await splitControllerA.load();
            splitControllerA.updateDraft('repo A flushed draft');

            await splitControllerA.handleMessage({
                type: 'splitFiles',
                payload: { changeId: changeIdA, paths: ['a.txt'], placement: 'before' },
            });

            expect(capturedSetDescArgs).toHaveLength(1);
            const resolvedForSave = resolveRepository(repositoryManager, {
                args: capturedSetDescArgs[0],
                host: fakeHost,
            });
            expect(resolvedForSave?.rootUri.fsPath).toBeSameFsPath(repoAInstance.rootUri.fsPath);
            expect(testRepo.getDescription(changeIdA)).toBe('repo A flushed draft');
            expect(repoB.getDescription('@')).toBe('repo B initial');

            expect(capturedSplitPayloads).toHaveLength(1);
            const resolvedForSplit = resolveRepository(repositoryManager, {
                args: [capturedSplitPayloads[0]],
                host: fakeHost,
            });
            expect(resolvedForSplit?.rootUri.fsPath).toBeSameFsPath(repoAInstance.rootUri.fsPath);
        } finally {
            setDescDisposable.dispose();
            splitBeforeDisposable.dispose();
            splitControllerA.dispose();
        }
    });

    test('save invoked in firstSavePromise.then microtask joins queued _nextSavePromise without concurrent run', async () => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('initial');
        const changeId = testRepo.getChangeId('@');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        const splitController = new CommitDetailsController(changeId, repoInstance, fakeHost);
        let releaseSave1!: () => void;
        const save1Gate = new Promise<void>((resolve) => {
            releaseSave1 = resolve;
        });
        let releaseSave2!: () => void;
        const save2Gate = new Promise<void>((resolve) => {
            releaseSave2 = resolve;
        });

        let activeSaves = 0;
        let maxConcurrentSaves = 0;
        let saveCount = 0;
        const setDescDisposable = fakeHost.commands.registerCommand(
            'jj-view.setDescription',
            async (desc: string, rev: string) => {
                saveCount++;
                activeSaves++;
                maxConcurrentSaves = Math.max(maxConcurrentSaves, activeSaves);
                try {
                    if (saveCount === 1) {
                        await save1Gate;
                    } else if (saveCount === 2) {
                        await save2Gate;
                    }
                    await repoInstance.jj.describe(desc, rev);
                    return desc;
                } finally {
                    activeSaves--;
                }
            },
        );

        try {
            await splitController.load();

            splitController.updateDraft('draft 1');
            const save1Promise = splitController.save();
            // Attach a .then() callback that runs right after save1 resolves (while _nextSavePromise is still pending)
            const microtaskSavePromise = save1Promise.then(() => splitController.save('draft 3'));

            splitController.updateDraft('draft 2');
            const save2Promise = splitController.save();

            releaseSave1();
            await save1Promise;
            // Yield microtasks so microtaskSavePromise runs before save2 finishes
            await Promise.resolve();
            await Promise.resolve();
            expect(maxConcurrentSaves).toBe(1);

            releaseSave2();
            await Promise.all([save2Promise, microtaskSavePromise]);

            expect(maxConcurrentSaves).toBe(1);
            expect(saveCount).toBe(2);
            expect(testRepo.getDescription(changeId)).toBe('draft 3');
        } finally {
            setDescDisposable.dispose();
            splitController.dispose();
        }
    });

    test('emits file list promptly before async comparison finishes and resets stale comparison state on reload', async () => {
        testRepo.writeFile('file.txt', 'local v2');
        testRepo.describe('feat: local desc\n\nChange-Id: I1111222233334444555566667777888899990000');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        let hasForgeChange = true;
        const populateSpy = vi.spyOn(repoInstance.codeForge, 'populateCodeForgeInfo').mockImplementation((commits) => {
            for (const c of commits) {
                if (hasForgeChange) {
                    c.codeForgeChange = {
                        id: 'I1111222233334444555566667777888899990000',
                        number: 101,
                        displayLabel: 'CL/101',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        submittable: false,
                        url: 'https://example.com/101',
                        unresolvedComments: 0,
                        currentRevision: 'remote-rev',
                        remoteDescription: 'feat: remote desc\n\nChange-Id: I1111222233334444555566667777888899990000',
                        files: { 'file.txt': { newSha: 'remote-blob', status: 'M' } },
                    };
                    c.codeForgeNeedsUpload = true;
                } else {
                    c.codeForgeChange = undefined;
                    c.codeForgeNeedsUpload = undefined;
                }
            }
        });

        try {
            client.receivedMessages.length = 0;
            await controller.load();
            expect(client.receivedMessages.some((m) => m.type === 'update' && !m.payload.isLoadingFiles)).toBe(true);
            await controller.activeComparison;

            expect(controller.getState()?.descriptionModifiedFromRemote).toBe(true);
            expect(controller.getState()?.unuploadedFilePaths).toEqual(['file.txt']);

            hasForgeChange = false;
            await controller.load();
            await controller.activeComparison;

            expect(controller.getState()?.descriptionModifiedFromRemote).toBeUndefined();
            expect(controller.getState()?.unuploadedFilePaths).toBeUndefined();
        } finally {
            populateSpy.mockRestore();
        }
    });

    test('skips automatic unuploaded comparison for MERGED changes and discards stale loads on reload/dispose', async () => {
        testRepo.writeFile('file.txt', 'merged content');
        testRepo.describe('feat: already merged\n\nChange-Id: I2222222233334444555566667777888899990000');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        let status: 'NEW' | 'MERGED' = 'MERGED';
        const populateSpy = vi.spyOn(repoInstance.codeForge, 'populateCodeForgeInfo').mockImplementation((commits) => {
            for (const c of commits) {
                c.codeForgeChange = {
                    id: 'I2222222233334444555566667777888899990000',
                    number: 202,
                    displayLabel: 'CL/202',
                    providerName: 'Gerrit',
                    status,
                    submittable: false,
                    url: 'https://example.com/202',
                    unresolvedComments: 0,
                    currentRevision: 'remote-rev-merged',
                    remoteDescription: 'feat: older message',
                    files: { 'file.txt': { newSha: 'different-sha', status: 'M' } },
                };
                c.codeForgeNeedsUpload = status === 'NEW';
            }
        });

        try {
            await controller.load();
            await controller.activeComparison;
            expect(controller.activeComparison).toBeUndefined();
            expect(controller.getState()?.unuploadedFilePaths).toBeUndefined();
            expect(controller.getState()?.descriptionModifiedFromRemote).toBeUndefined();

            // Supersede an in-flight comparison via a second load(); stale load must not overwrite
            status = 'NEW';
            const firstLoad = controller.load();
            const secondLoad = controller.load();
            await Promise.all([firstLoad, secondLoad]);
            await controller.activeComparison;
            expect(controller.getState()?.unuploadedFilePaths).toEqual(['file.txt']);

            // Dispose cancels pending emissions cleanly
            controller.dispose();
            await expect(controller.load()).resolves.toBeUndefined();
        } finally {
            populateSpy.mockRestore();
        }
    });

    test('dispatches openFileOnRemote and copyRemoteFileUrl from file context menu messages', async () => {
        testRepo.writeFile('src/item.ts', 'const v = 1;\n');
        testRepo.describe('commit for remote links');
        const changeId = testRepo.getChangeId('@');
        const commitId = testRepo.getCommitId('@');

        const repoInstance = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repoInstance) {
            throw new Error('repo not found');
        }

        const detailsController = new CommitDetailsController(changeId, repoInstance, fakeHost);
        const executeSpy = vi.spyOn(fakeHost.commands, 'executeCommand');

        try {
            await detailsController.load();

            const openHandled = await detailsController.handleMessage({
                type: 'openFileOnRemote',
                payload: { changeId, path: 'src/item.ts', status: 'added' },
            });
            const copyHandled = await detailsController.handleMessage({
                type: 'copyRemoteFileUrl',
                payload: { changeId, path: 'src/item.ts', status: 'deleted' },
            });

            expect(openHandled).toBe(true);
            expect(copyHandled).toBe(true);
            expect(executeSpy).toHaveBeenCalledWith('jj-view.openFileOnRemote', {
                filePath: 'src/item.ts',
                isRepoRelative: true,
                revision: commitId,
                fileStatus: 'added',
                skipActiveSelection: true,
                rootUri: repoInstance.rootUri,
            });
            expect(executeSpy).toHaveBeenCalledWith('jj-view.copyRemoteFileUrl', {
                filePath: 'src/item.ts',
                isRepoRelative: true,
                revision: commitId,
                fileStatus: 'deleted',
                skipActiveSelection: true,
                rootUri: repoInstance.rootUri,
            });
        } finally {
            detailsController.dispose();
        }
    });
});
