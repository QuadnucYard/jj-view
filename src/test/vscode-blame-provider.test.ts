/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock, setActiveTextEditor } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { NO_OP_LOGGER } from '../core/jj-service';
import { createRevisionUri, encodeJjViewQuery, Uri } from '../core/uri-utils';
import { VsCodeBlameProvider } from '../vscode/providers/vscode-blame-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

describe('JJ editor blame', () => {
    let repo: TestRepo;
    let manager: JjRepositoryManager;
    let provider: VsCodeBlameProvider;
    let parentCommit: string;
    let document: vscode.TextDocument;
    let editor: vscode.TextEditor;
    let text: string;
    let line: number;
    let version: number;
    let dirty: boolean;
    let uri: vscode.Uri;
    let enabled: boolean;
    let setDecorations: ReturnType<
        typeof vi.fn<(type: vscode.TextEditorDecorationType, options: readonly vscode.DecorationOptions[]) => void>
    >;
    let configurationChanges: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;
    let selections: vscode.EventEmitter<vscode.TextEditorSelectionChangeEvent>;

    beforeEach(async () => {
        vi.clearAllMocks();
        repo = new TestRepo();
        repo.init();
        repo.writeFile('file.txt', 'inherited\nold\n');
        repo.describe('Original author change');
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));
        manager = new JjRepositoryManager(new CodeForgeRegistry(), NO_OP_LOGGER, host);
        const repository = await manager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!repository) {
            throw new Error('Repository not detected');
        }
        parentCommit = (await repository.jj.getLogEntry('@'))?.commit_id ?? '';
        repo.new();
        repo.writeFile('file.txt', 'inherited\nnew\n');
        text = 'inherited\nnew\n';
        line = 0;
        version = 1;
        dirty = false;
        enabled = true;
        uri = vscode.Uri.file(path.join(repo.path, 'file.txt'));
        document = createMock<vscode.TextDocument>({
            get uri() {
                return uri;
            },
            get version() {
                return version;
            },
            get isDirty() {
                return dirty;
            },
            get lineCount() {
                return text.split('\n').length;
            },
            getText: () => text,
            lineAt: vi.fn().mockImplementation((index: number) => {
                const value = text.split('\n')[index];
                return { text: value, range: new vscode.Range(index, 0, index, value.length) };
            }),
        });
        setDecorations = vi.fn();
        editor = createMock<vscode.TextEditor>({
            document,
            get selection() {
                return new vscode.Selection(line, 0, line, 0);
            },
            setDecorations,
        });
        setActiveTextEditor(editor);
        Object.defineProperty(vscode.window, 'visibleTextEditors', { configurable: true, value: [editor] });
        vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() =>
            createMock<vscode.WorkspaceConfiguration>({
                get: <T>(key: string, fallback?: T): T | undefined =>
                    key === 'blame.enabled' ? (enabled as T) : fallback,
            }),
        );
        configurationChanges = new vscode.EventEmitter();
        selections = new vscode.EventEmitter();
        vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(configurationChanges.event);
        vi.spyOn(vscode.window, 'onDidChangeTextEditorSelection').mockImplementation(selections.event);
        provider = new VsCodeBlameProvider(
            manager,
            createMock<vscode.ExtensionContext>({ workspaceState: createMock() }),
        );
    });

    afterEach(async () => {
        provider.dispose();
        setActiveTextEditor(undefined);
        configurationChanges.dispose();
        selections.dispose();
        vi.restoreAllMocks();
        await manager.dispose();
        await repo.dispose();
    });

    function decoration(): vscode.DecorationOptions | undefined {
        return setDecorations.mock.calls.at(-1)?.[1][0];
    }
    async function expectText(value: string): Promise<void> {
        await vi.waitFor(() => expect(decoration()?.renderOptions?.after?.contentText).toContain(value), {
            timeout: 10000,
        });
    }
    function moveCursor(next: number): void {
        line = next;
        selections.fire({ textEditor: editor, selections: [editor.selection], kind: undefined });
    }

    test('renders the cursor line and escaped metadata with a restricted commit-details link', async () => {
        await expectText('Original author change');
        expect(decoration()?.range.start.line).toBe(0);
        expect(decoration()?.range.start.character).toBe('inherited'.length);
        const hover = decoration()?.hoverMessage;
        expect(hover).toMatchObject({ isTrusted: { enabledCommands: ['jj-view.openBlameCommit'] } });
        moveCursor(1);
        await expectText('Working copy');
        expect(decoration()?.range.start.line).toBe(1);
        moveCursor(2);
        await vi.waitFor(() => expect(decoration()).toBeUndefined());
    });

    test('maps unchanged lines around unsaved insertions without attributing edited lines', async () => {
        text = 'inserted\ninherited\nnew\n';
        dirty = true;
        version++;
        await expectText('Unsaved changes');
        moveCursor(1);
        await expectText('Original author change');
    });

    test('uses historical revision content and the correct diff side', async () => {
        text = 'inherited\nold\n';
        uri = createRevisionUri(repo.path, 'file.txt', parentCommit);
        line = 1;
        await expectText('Original author change');
        uri = Uri.from({
            scheme: 'jj-view',
            path: '/file.txt',
            fragment: encodeJjViewQuery({
                mode: 'diff',
                root: repo.path,
                base: '@',
                side: 'left',
            }),
        });
        version++;
        moveCursor(1);
        await expectText('Original author change');
    });

    test('clears decorations immediately when disabled and restores them when re-enabled', async () => {
        await expectText('Original author change');
        enabled = false;
        configurationChanges.fire({ affectsConfiguration: () => true });
        expect(decoration()).toBeUndefined();
        enabled = true;
        configurationChanges.fire({ affectsConfiguration: () => true });
        await expectText('Original author change');
    });

    test('discards an in-flight result after the active editor changes', async () => {
        const system = manager.repositories[0].jj.system;
        const originalExec = system.process.execFile.bind(system.process);
        let release = () => {};
        let started = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const annotationStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        vi.spyOn(system.process, 'execFile').mockImplementation(async (file, args, options) => {
            if (args.includes('annotate')) {
                started();
                await gate;
            }
            return originalExec(file, args, options);
        });
        const pending = provider.refresh();
        await annotationStarted;
        setActiveTextEditor(undefined);
        release();
        await pending;
        expect(decoration()).toBeUndefined();
    });

    test('refreshes attribution after the working copy is committed to a parent', async () => {
        moveCursor(1);
        await expectText('Working copy');
        repo.describe('Saved new line');
        repo.new();
        await manager.repositories[0].refresh({ reason: 'blame test' });
        await expectText('Saved new line');
    });
});
