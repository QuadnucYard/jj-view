/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openMergeEditorCommand } from '../../core/commands/merge-editor';
import type { JjRepository } from '../../core/jj-repository';
import type { JjResourceState } from '../../core/scm-resource-state';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { createMock } from '../test-utils';

describe('openMergeEditorCommand', () => {
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        mockJjRepo = createMock<JjRepository>({
            rootUri: Uri.file('/test'),
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
        ctx.host.nav.openMergeEditor = vi.fn();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource states provided', async () => {
        await openMergeEditorCommand(ctx, { resourceStates: [] });

        expect(ctx.host.nav.openMergeEditor).not.toHaveBeenCalled();
    });

    test('calls openMergeEditor with resource uri', async () => {
        const resourceUri = Uri.file('/test/foo.txt');
        const resourceState = createMock<JjResourceState>({ resourceUri });
        await openMergeEditorCommand(ctx, { resourceStates: [resourceState] });

        expect(ctx.host.nav.openMergeEditor).toHaveBeenCalledWith(resourceUri);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ forceSnapshot: true, reason: 'before merge editor' });
        expect(mockJjRepo.refresh).toHaveBeenCalledBefore(vi.mocked(ctx.host.nav.openMergeEditor));
    });

    test('handles error', async () => {
        const resourceUri = Uri.file('/test/foo.txt');
        const resourceState = createMock<JjResourceState>({ resourceUri });
        const openMergeEditor = ctx.host.nav.openMergeEditor;
        if (!openMergeEditor) {
            throw new Error('openMergeEditor not defined');
        }
        vi.mocked(openMergeEditor).mockRejectedValue(new Error('boom'));

        await openMergeEditorCommand(ctx, { resourceStates: [resourceState] });

        expect(ctx.host.ui.errorMessages[0]).toContain('Error opening merge editor');
    });
});
