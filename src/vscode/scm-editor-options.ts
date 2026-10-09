/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { Uri } from '../core/uri-utils';

// The built-in Git extension's public, versioned API.
interface GitExtension {
    readonly enabled: boolean;
    getAPI(version: 1): { getRepository(uri: vscode.Uri): object | null };
}

export function gitCanRevealFile(fileUri: Uri): boolean {
    if (fileUri.scheme !== 'file' || !vscode.workspace.getConfiguration('scm').get('autoReveal', true)) {
        return false;
    }
    const git = vscode.extensions.getExtension<GitExtension>('vscode.git');
    return (
        !!git?.isActive &&
        git.exports.enabled &&
        git.exports.getAPI(1).getRepository(vscode.Uri.parse(fileUri.toString())) !== null
    );
}

export function getBesideEditorOptions(targetUri: Uri): vscode.TextDocumentShowOptions {
    const activeColumn = vscode.window.tabGroups.activeTabGroup?.viewColumn;
    const existingEditor = vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.toString() === targetUri.toString() && editor.viewColumn !== activeColumn,
    );
    return { viewColumn: existingEditor?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: true };
}
