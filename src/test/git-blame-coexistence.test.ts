/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { GitBlameCoexistence, preferJjBlame, restoreGitBlame } from '../vscode/git-blame-coexistence';
import { createMock } from './test-utils';

describe('Git blame coexistence', () => {
    let coexistence: GitBlameCoexistence;
    let gitEnabled: boolean;
    let inlineEnabled: boolean;
    let apiReady: boolean;
    let workspaceValue: boolean | undefined;
    let storage: vscode.Memento;
    let repositories: { rootUri: vscode.Uri }[];
    let opened: vscode.EventEmitter<{ rootUri: vscode.Uri }>;
    let closed: vscode.EventEmitter<{ rootUri: vscode.Uri }>;
    let enablement: vscode.EventEmitter<boolean>;
    let changed: ReturnType<typeof vi.fn<() => void>>;
    let update: ReturnType<typeof vi.fn<vscode.WorkspaceConfiguration['update']>>;

    beforeEach(async () => {
        vi.clearAllMocks();
        gitEnabled = true;
        inlineEnabled = true;
        apiReady = true;
        workspaceValue = undefined;
        repositories = [{ rootUri: vscode.Uri.file('/workspace/jj') }];
        opened = new vscode.EventEmitter();
        closed = new vscode.EventEmitter();
        enablement = new vscode.EventEmitter();
        changed = vi.fn();
        const api = {
            get repositories() {
                return repositories;
            },
            onDidOpenRepository: opened.event,
            onDidCloseRepository: closed.event,
        };
        const exports = {
            get enabled() {
                return gitEnabled;
            },
            onDidChangeEnablement: enablement.event,
            getAPI: () => {
                if (!apiReady) {
                    throw new Error('Git model not found');
                }
                return api;
            },
        };
        const extension = createMock<vscode.Extension<typeof exports>>({ activate: async () => exports });
        vi.mocked(vscode.extensions.getExtension).mockReturnValue(extension);
        update = vi.fn().mockImplementation(async (_key: string, value: boolean | undefined) => {
            workspaceValue = value;
        });
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
            createMock<vscode.WorkspaceConfiguration>({
                get: <T>(key: string, fallback?: T): T | undefined => {
                    if (key === 'enabled') {
                        return gitEnabled as T;
                    }
                    if (key === 'blame.editorDecoration.enabled') {
                        return (workspaceValue ?? inlineEnabled) as T;
                    }
                    return fallback;
                },
                inspect: <T>(key: string) => ({ key, workspaceValue: workspaceValue as T | undefined }),
                update,
            }),
        );
        const saved = new Map<string, unknown>();
        storage = {
            keys: () => [...saved.keys()],
            get: <T>(key: string, fallback?: T): T | undefined => (saved.has(key) ? (saved.get(key) as T) : fallback),
            update: async (key: string, value: unknown) => {
                saved.set(key, value);
            },
        };
        coexistence = new GitBlameCoexistence(changed);
        await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    });
    afterEach(() => {
        coexistence.dispose();
        opened.dispose();
        closed.dispose();
        enablement.dispose();
        vi.restoreAllMocks();
    });

    test('suppresses only files covered by an active Git inline blame provider', () => {
        expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj/file.txt'))).toBe(true);
        expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj-other/file.txt'))).toBe(false);
        expect(coexistence.hasInlineBlame(vscode.Uri.from({ scheme: 'jj-view', path: '/workspace/jj/file.txt' }))).toBe(
            false,
        );
        inlineEnabled = false;
        expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj/file.txt'))).toBe(false);
    });

    test('reacts to repository closure and Git enablement changes', () => {
        const repository = repositories[0];
        repositories = [];
        closed.fire(repository);
        expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj/file.txt'))).toBe(false);
        repositories = [repository];
        opened.fire(repository);
        expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj/file.txt'))).toBe(true);
        gitEnabled = false;
        enablement.fire(false);
        expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj/file.txt'))).toBe(false);
    });

    test('waits until Git finishes initialization after an enablement event', async () => {
        gitEnabled = false;
        enablement.fire(false);
        await Promise.resolve();
        apiReady = false;
        gitEnabled = true;
        enablement.fire(true);
        apiReady = true;
        await vi.waitFor(() => {
            expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj/file.txt'))).toBe(true);
            expect(coexistence.hasInlineBlame(vscode.Uri.file('/workspace/jj-other/file.txt'))).toBe(false);
        });
        expect(changed).toHaveBeenCalled();
    });

    test('changes only workspace inline blame after explicit selection and restores inheritance', async () => {
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue({ title: 'Prefer JJ Blame' });
        await preferJjBlame(storage);
        expect(update).toHaveBeenCalledExactlyOnceWith(
            'blame.editorDecoration.enabled',
            false,
            vscode.ConfigurationTarget.Workspace,
        );
        expect(gitEnabled).toBe(true);
        await restoreGitBlame(storage);
        expect(update).toHaveBeenLastCalledWith(
            'blame.editorDecoration.enabled',
            undefined,
            vscode.ConfigurationTarget.Workspace,
        );
    });

    test('does not change settings when the workspace preference is cancelled', async () => {
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
        await preferJjBlame(storage);
        expect(update).not.toHaveBeenCalled();
    });

    test('preserves subsequent user edits when undoing the JJ preference', async () => {
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue({ title: 'Prefer JJ Blame' });
        await preferJjBlame(storage);
        workspaceValue = true;
        await restoreGitBlame(storage);
        expect(update).toHaveBeenCalledTimes(1);
        expect(workspaceValue).toBe(true);
    });
});
