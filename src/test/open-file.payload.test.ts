/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { JjResourceState } from '../core/scm-resource-state';
import { Uri } from '../core/uri-utils';
import { createOpenChangesPayload } from '../vscode/payloads/open-changes.payload';
import { createOpenFilePayload } from '../vscode/payloads/open-file.payload';
import { createMock } from './test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({ extensions: { getExtension: vi.fn() } });
});

describe('open file payload placement', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        {
            label: 'competing Git repository',
            scheme: 'jj-scm',
            active: true,
            enabled: true,
            ownsFile: true,
            autoReveal: true,
            beside: true,
        },
        {
            label: 'unrelated Git repository',
            scheme: 'jj-scm',
            active: true,
            enabled: true,
            ownsFile: false,
            autoReveal: true,
            beside: false,
        },
        {
            label: 'inactive Git extension',
            scheme: 'jj-scm',
            active: false,
            enabled: true,
            ownsFile: true,
            autoReveal: true,
            beside: false,
        },
        {
            label: 'disabled Git extension',
            scheme: 'jj-scm',
            active: true,
            enabled: false,
            ownsFile: true,
            autoReveal: true,
            beside: false,
        },
        {
            label: 'disabled auto-reveal',
            scheme: 'jj-scm',
            active: true,
            enabled: true,
            ownsFile: true,
            autoReveal: false,
            beside: false,
        },
        {
            label: 'editor action',
            scheme: 'jj-view',
            active: true,
            enabled: true,
            ownsFile: true,
            autoReveal: true,
            beside: false,
        },
    ])('handles $label', (scenario) => {
        const getRepository = vi.fn((_uri: vscode.Uri) => (scenario.ownsFile ? {} : null));
        const git = { enabled: scenario.enabled, getAPI: vi.fn((_version: 1) => ({ getRepository })) };
        vi.mocked(vscode.extensions.getExtension).mockReturnValue(
            createMock<vscode.Extension<typeof git>>({
                isActive: scenario.active,
                exports: git,
            }),
        );
        vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(
            createMock<vscode.WorkspaceConfiguration>({
                get: vi.fn().mockReturnValue(scenario.autoReveal),
            }),
        );
        const resourceUri = Uri.file('/repo/nested/file.txt').with({
            scheme: scenario.scheme,
            fragment: 'jj-revision=ancestor&root=%2Frepo',
        });
        const payload = createOpenFilePayload([{ resourceUri }]);
        expect(payload.openBeside === true).toBe(scenario.beside);
        expect(payload.resourceUri).toEqual(resourceUri);
        const diffPayload = createOpenChangesPayload([
            createMock<JjResourceState>({
                resourceUri,
                rightUri: Uri.file('/repo/nested/file.txt'),
            }),
        ]);
        expect(diffPayload.openBeside === true).toBe(scenario.beside);
        if (scenario.active && scenario.enabled && scenario.autoReveal && scenario.scheme === 'jj-scm') {
            expect(getRepository).toHaveBeenCalledWith(vscode.Uri.file('/repo/nested/file.txt'));
        } else {
            expect(git.getAPI).not.toHaveBeenCalled();
        }
    });

    it('keeps normal placement when Git is absent', () => {
        vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
        const resourceUri = Uri.file('/repo/file.txt').with({ scheme: 'jj-scm' });
        expect(createOpenFilePayload([{ resourceUri }]).openBeside).toBeUndefined();
    });
});
