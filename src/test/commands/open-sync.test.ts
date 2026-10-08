/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { extractFileUri } from '../../core/commands/command-utils';
import type { JjResourceState } from '../../core/scm-resource-state';
import { toFileUri } from '../../core/uri-utils';
import { openFileWithSync, registerOpenSyncTracking } from '../../vscode/open-sync';
import { VsCodeHostNavigation } from '../../vscode/vscode-host-environment';
import { createMock } from '../test-utils';
import { fireDidChangeActiveTextEditor, setActiveTextEditor } from '../vscode-mock';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        workspace: {
            openTextDocument: vi.fn(),
        },
        TextEditorRevealType: {
            Default: 0,
            InCenter: 1,
            InCenterIfOutsideViewport: 2,
            AtTop: 3,
        },
    });
});

function setActiveEditor(
    uri: vscode.Uri,
    text: string,
    selection: vscode.Selection,
    visibleRanges: vscode.Range[] = [],
    selections: readonly vscode.Selection[] = [selection],
): vscode.TextEditor {
    const editor = createMock<vscode.TextEditor>({
        document: createMock<vscode.TextDocument>({
            uri,
            getText: vi.fn().mockReturnValue(text),
        }),
        selection,
        selections,
        visibleRanges,
        revealRange: vi.fn(),
    });
    vscode.window.activeTextEditor = editor;
    return editor;
}

function setOpenTarget(uri: vscode.Uri, text: string): vscode.TextEditor {
    const editor = createMock<vscode.TextEditor>({
        document: createMock<vscode.TextDocument>({
            uri,
            getText: vi.fn().mockReturnValue(text),
        }),
        selections: [],
        revealRange: vi.fn(),
    });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(editor.document);
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor);
    return editor;
}

describe('openFileCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
        setActiveTextEditor(undefined);
        vscode.window.visibleTextEditors = [];
    });

    test('does nothing if no args and no active text editor', async () => {
        await openFileCommand();
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open from SourceControlResourceState', async () => {
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: vscode.Uri.file('/foo').with({ query: 'jj-revision=rev123' }),
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('opens on-disk file even when the resource state has a revision-backed uri', async () => {
        const rightUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=rev123',
        });
        const resourceUri = vscode.Uri.file('/foo').with({ query: 'jj-revision=rev123' });
        const resourceState = createMock<JjResourceState>({
            resourceUri,
            rightUri,
            revision: 'rev123',
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('preserves selection through host navigation for a fragment-backed revision uri', async () => {
        const sourceUri = vscode.Uri.parse('jj-view:///foo').with({ fragment: 'root=%2Frepo&base=revB&side=left' });
        const targetUri = vscode.Uri.file('/repo/foo');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(sourceUri, 'one\ntwo\nfive', selection, [new vscode.Range(2, 0, 2, 0)]);
        const target = setOpenTarget(targetUri, 'one\ntwo\nthree\nfour\nfive');
        await new VsCodeHostNavigation().openFile(targetUri, { sourceUri, preview: false });
        expect(target.selections).toEqual([new vscode.Selection(new vscode.Position(4, 0), new vscode.Position(4, 0))]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(target.document, {
            preview: false,
            selection: new vscode.Range(4, 0, 4, 0),
        });
    });

    test('syncs all cursors and scroll position to the opened target editor', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=rev123',
        });
        const resourceUri = vscode.Uri.file('/foo').with({ query: 'jj-revision=rev123' });
        const primary = new vscode.Selection(new vscode.Position(7, 3), new vscode.Position(7, 3));
        const secondary = new vscode.Selection(new vscode.Position(4, 6), new vscode.Position(3, 2));
        const content = Array.from({ length: 10 }, (_, line) => `line-${line}`).join('\n');
        setActiveEditor(revisionUri, content, primary, [new vscode.Range(6, 0, 9, 0)], [primary, secondary]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), content);
        const resourceState = createMock<JjResourceState>({
            resourceUri,
            rightUri: revisionUri,
            revision: 'rev123',
        });

        await openFileCommand(resourceState);

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ scheme: 'file', path: '/foo', query: '' }),
        );
        expect(targetEditor.selections).toEqual([primary, secondary]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(7, 0, 7, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });

    test('opens at the viewport before restoring off-screen reversed selections', async () => {
        const sourceUri = vscode.Uri.parse('jj-edit:///foo?revision=revB');
        const content = Array.from({ length: 200 }, (_, line) => `line-${line}`).join('\n');
        const primary = new vscode.Selection(8, 3, 2, 1);
        const secondary = new vscode.Selection(190, 2, 190, 2);
        setActiveEditor(sourceUri, content, primary, [new vscode.Range(90, 0, 110, 0)], [primary, secondary]);
        const target = setOpenTarget(vscode.Uri.file('/foo'), content);
        vi.mocked(vscode.window.showTextDocument).mockImplementationOnce(async (document, options) => {
            expect(document).toBe(target.document);
            expect(options).toEqual({ selection: new vscode.Range(100, 0, 100, 0) });
            expect(target.selections).toEqual([]);
            expect(target.revealRange).not.toHaveBeenCalled();
            return target;
        });

        await openFileCommand(sourceUri);

        expect(target.selections).toEqual([primary, secondary]);
        expect(target.revealRange).not.toHaveBeenCalled();
    });

    test('maps cursor and viewport through inserted lines using unchanged anchors', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=revB',
        });
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(revisionUri, 'line1\nline2\nline5', selection, [new vscode.Range(2, 0, 2, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openFileCommand(resourceState);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
        ]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(5, 0, 5, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });

    test('remaps from the left side of a working-copy diff', async () => {
        const diffUri = vscode.Uri.parse('jj-view:///foo?base=%40&side=left');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(diffUri, 'line1\nline2\nline5', selection, [new vscode.Range(2, 0, 2, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');

        await openFileCommand(diffUri);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
        ]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(5, 0, 5, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });

    test('remaps stale content from the right side of a working-copy diff', async () => {
        const diffUri = vscode.Uri.parse('jj-view:///foo?base=%40&side=right');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(diffUri, 'line1\nline2\nline5', selection, [new vscode.Range(2, 0, 2, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');

        await openFileCommand(diffUri);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
        ]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(5, 0, 5, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });

    test('maps replacement lines proportionally between unchanged anchors', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=revB',
        });
        const selection = new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(3, 2));
        setActiveEditor(revisionUri, 'before\nold1\nold2\nold3\nafter', selection, [new vscode.Range(1, 0, 3, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before\nnew1\nnew2\nafter');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openFileCommand(resourceState);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(2, 2)),
        ]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(2, 0, 2, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });

    test('maps deleted lines to the deletion boundary', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const selection = new vscode.Selection(new vscode.Position(2, 2), new vscode.Position(2, 2));
        setActiveEditor(revisionUri, 'before\nremoved1\nremoved2\nafter', selection);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before\nafter');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0)),
        ]);
    });

    test('shrinks selections with one endpoint in a deletion without collapsing them', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const deletedActive = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(3, 5));
        const deletedAnchor = new vscode.Selection(new vscode.Position(3, 4), new vscode.Position(4, 2));
        setActiveEditor(
            revisionUri,
            'before\nkept\nremoved1\nremoved2\nafter',
            deletedActive,
            [],
            [deletedActive, deletedAnchor],
        );
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before\nkept\nafter');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 0)),
            new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 2)),
        ]);
    });

    test('clamps a trailing deletion to the final target line', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const selection = new vscode.Selection(new vscode.Position(2, 2), new vscode.Position(2, 2));
        setActiveEditor(revisionUri, 'before\nremoved1\nremoved2', selection);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(0, 6), new vscode.Position(0, 6)),
        ]);
    });

    test('maps against the live target editor content', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const selection = new vscode.Selection(new vscode.Position(5, 100), new vscode.Position(3, 100));
        setActiveEditor(revisionUri, 'line1\nline2\nline3\nline4\nline5\nline6', selection, [
            new vscode.Range(4, 0, 5, 0),
        ]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'short\nlast');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 4), new vscode.Position(1, 4)),
        ]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(1, 0, 1, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });

    test('skips remapping when the active editor already shows the target revision', async () => {
        const selection = new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(1, 2));
        setActiveEditor(vscode.Uri.file('/foo'), 'one\ntwo', selection);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'one\ntwo');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([selection]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, { selection });
    });

    test('opens normally without synchronization when the active editor is another file', async () => {
        const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
        setActiveEditor(vscode.Uri.file('/other'), 'line1\nline2', selection);

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({ scheme: 'file', path: '/foo', query: '' }),
        );
    });

    test('does not sync files whose paths differ only by case', async () => {
        const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
        setActiveEditor(vscode.Uri.file('/Foo.ts'), 'line1\nline2', selection);

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo.ts'), revision: '@' }));

        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({ scheme: 'file', path: '/foo.ts', query: '' }),
        );
    });

    test('syncs from a previously active tab when the menu supplies its uri', async () => {
        const revisionUri = vscode.Uri.parse('jj-view:///foo?revision=revB');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveTextEditor(undefined);
        const tracking = registerOpenSyncTracking();

        try {
            const revisionEditor = setActiveEditor(revisionUri, 'line1\nline2\nline5', selection, [
                new vscode.Range(2, 0, 2, 0),
            ]);
            fireDidChangeActiveTextEditor(revisionEditor);
            const otherSelection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
            setActiveEditor(vscode.Uri.file('/other'), 'other', otherSelection);
            const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');

            await openFileCommand(revisionUri);

            expect(targetEditor.selections).toEqual([
                new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
            ]);
            expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
                selection: new vscode.Range(5, 0, 5, 0),
            });
            expect(targetEditor.revealRange).not.toHaveBeenCalled();
        } finally {
            tracking.dispose();
        }
    });

    test('no active editor: opens without selection', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.parse('file:///foo?jj-revision=@'),
            rightUri: vscode.Uri.file('/foo').with({
                scheme: 'jj-edit',
                query: 'revision=rev123',
            }),
            revision: 'rev123',
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('executes vscode.open from a historical URI (jj-view scheme)', async () => {
        const uri = vscode.Uri.parse('jj-view:///foo/bar.txt?base=c123&side=left');

        await openFileCommand(uri);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo/bar.txt',
                query: '',
            }),
        );
    });

    test('syncs from activeTextEditor fallback when args are empty', async () => {
        const revisionUri = vscode.Uri.parse('jj-edit:///baz/qux.ts?revision=rev123');
        const selection = new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(1, 2));
        setActiveEditor(revisionUri, 'first\nsecond', selection, [new vscode.Range(0, 0, 1, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/baz/qux.ts'), 'first\nsecond');

        await openFileCommand();

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: 'file',
                path: '/baz/qux.ts',
                query: '',
            }),
        );
        expect(targetEditor.selections).toEqual([selection]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(targetEditor.document, {
            selection: new vscode.Range(0, 0, 0, 0),
        });
        expect(targetEditor.revealRange).not.toHaveBeenCalled();
    });
});

async function openFileCommand(...args: unknown[]): Promise<void> {
    const resourceUri = extractFileUri(args) ?? vscode.window.activeTextEditor?.document.uri;
    if (!resourceUri) {
        return;
    }
    await openFileWithSync(toFileUri(resourceUri), args[0] instanceof vscode.Uri ? args[0] : undefined);
}
