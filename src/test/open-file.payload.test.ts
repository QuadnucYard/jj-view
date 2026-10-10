/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { JjResourceState } from '../core/scm-resource-state';
import { Uri } from '../core/uri-utils';
import { createOpenChangesPayload } from '../vscode/payloads/open-changes.payload';
import { createOpenFilePayload } from '../vscode/payloads/open-file.payload';
import { createMock } from './test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

describe('open file payloads', () => {
    it('opens SCM files without overriding native placement', () => {
        const resourceUri = Uri.file('/repo/file.txt').with({ scheme: 'jj-scm' });
        expect(createOpenFilePayload([{ resourceUri }])).toEqual({ resourceUri, sourceUri: undefined });
    });

    it('retains the source editor URI for selection synchronization', () => {
        const sourceUri = Uri.file('/repo/file.txt').with({ scheme: 'jj-view', query: 'revision=parent' });
        expect(createOpenFilePayload([sourceUri])).toEqual({ resourceUri: sourceUri, sourceUri });
    });

    it('opens SCM diffs without overriding native placement', () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: Uri.file('/repo/file.txt').with({ scheme: 'jj-scm' }),
            rightUri: Uri.file('/repo/file.txt'),
        });
        expect(createOpenChangesPayload([resourceState])).toEqual({ resourceState });
    });
});
