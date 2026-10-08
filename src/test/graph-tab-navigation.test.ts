/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from '../core/uri-utils';
import { VsCodeHostNavigation } from '../vscode/vscode-host-environment';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({ ViewColumn: { Active: -1 } });
});

test('opens kept graph details with VS Code preview disabled', async () => {
    const nav = new VsCodeHostNavigation();
    await nav.openCommitDetails(Uri.file('/repo'), 'change123', 'c', false, 0, { preview: false });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        expect.objectContaining({ scheme: 'jj-commit' }),
        'jj-view.commitDetailsEditor',
        expect.objectContaining({ preview: false, preserveFocus: true }),
    );
});
