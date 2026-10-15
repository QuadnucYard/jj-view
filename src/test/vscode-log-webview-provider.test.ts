/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { NO_OP_LOGGER } from '../core/jj-service';
import { Uri } from '../core/uri-utils';
import { VsCodeLogWebviewProvider } from '../vscode/providers/vscode-log-webview-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

describe('Log webview recovery', () => {
    let repo: TestRepo;
    let manager: JjRepositoryManager;
    let provider: VsCodeLogWebviewProvider;
    let windowChanges: vscode.EventEmitter<vscode.WindowState>;
    let visibilityChanges: vscode.EventEmitter<void>;
    let viewDisposals: vscode.EventEmitter<void>;
    let visible: boolean;
    let postMessage: ReturnType<typeof vi.fn<(message: unknown) => Promise<boolean>>>;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        repo.describe('Before inactivity');
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));
        manager = new JjRepositoryManager(new CodeForgeRegistry(), NO_OP_LOGGER, host);
        const repository = await manager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository not detected');
        }

        windowChanges = new vscode.EventEmitter<vscode.WindowState>();
        visibilityChanges = new vscode.EventEmitter<void>();
        viewDisposals = new vscode.EventEmitter<void>();
        vi.spyOn(vscode.window, 'onDidChangeWindowState').mockImplementation(windowChanges.event);
        provider = new VsCodeLogWebviewProvider(
            Uri.file('/extension'),
            repository,
            () => {},
            createMock<vscode.ExtensionContext>({}),
            NO_OP_LOGGER,
            manager,
        );
        visible = true;
        postMessage = vi.fn(async () => true);
        provider.resolveWebviewView(
            createMock<vscode.WebviewView>({
                get visible() {
                    return visible;
                },
                onDidChangeVisibility: visibilityChanges.event,
                onDidDispose: viewDisposals.event,
                webview: createMock<vscode.Webview>({
                    postMessage,
                    asWebviewUri: (uri) => uri,
                    onDidReceiveMessage: () => ({ dispose: () => {} }),
                }),
            }),
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
        await provider.controller.refresh();
        postMessage.mockClear();
    });

    afterEach(async () => {
        provider.dispose();
        windowChanges.dispose();
        visibilityChanges.dispose();
        viewDisposals.dispose();
        vi.restoreAllMocks();
        await manager.dispose();
        await repo.dispose();
    });

    test.each([
        { focused: false, active: true },
        { focused: true, active: false },
    ])('restores cached graph and fetches changes after resuming from %j', async (idleState) => {
        const changeId = provider.controller.commits[0].change_id;
        provider.controller.setSelectedCommits([changeId]);
        provider.controller.setHighlightedCommit(changeId);
        const cachedState = provider.controller.getState();
        windowChanges.fire(idleState);
        postMessage.mockClear();
        repo.describe('Changed while inactive');

        windowChanges.fire({ focused: true, active: true });

        // Restore immediately, before the asynchronous repository read completes.
        expect(postMessage).toHaveBeenCalledWith({ type: 'update', payload: cachedState });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setHighlight', payload: { changeId } });
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'repositoryFocus' }));
        await vi.waitFor(() => {
            expect(provider.controller.commits[0].description).toContain('Changed while inactive');
        });
        expect(provider.controller.selectedCommitIds).toEqual([changeId]);
        expect(postMessage).toHaveBeenLastCalledWith({ type: 'update', payload: provider.controller.getState() });
    });

    test('only recovers on resume while the graph view is visible', async () => {
        const refresh = vi.spyOn(provider.controller, 'refresh');
        windowChanges.fire({ focused: true, active: false });
        expect(refresh).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();

        visible = false;
        windowChanges.fire({ focused: true, active: true });
        expect(refresh).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();

        visible = true;
        visibilityChanges.fire();
        expect(postMessage).toHaveBeenCalledWith({ type: 'update', payload: provider.controller.getState() });
        expect(refresh).toHaveBeenCalledTimes(1);
        await refresh.mock.results[0].value;
        windowChanges.fire({ focused: true, active: true });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('preserves repository loading state when the graph becomes visible', async () => {
        const repository = provider.controller.repository;
        provider.controller.repository = undefined;
        provider.controller.repository = repository;
        const loadingState = provider.controller.getState();
        expect(loadingState.loading).toBe(true);
        postMessage.mockClear();

        visibilityChanges.fire();

        expect(provider.controller.getState()).toEqual(loadingState);
        expect(postMessage).toHaveBeenCalledWith({ type: 'update', payload: loadingState });
        await provider.controller.refresh();
        expect(provider.controller.getState().loading).toBe(false);
        expect(provider.controller.commits.length).toBeGreaterThan(0);
    });

    test.each(['view', 'provider'])('stops recovery after the %s is disposed', (target) => {
        const refresh = vi.spyOn(provider.controller, 'refresh');
        if (target === 'view') {
            viewDisposals.fire();
        } else {
            provider.dispose();
        }
        windowChanges.fire({ focused: false, active: false });
        windowChanges.fire({ focused: true, active: true });
        expect(refresh).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
    });
});
