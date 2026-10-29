/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, test } from 'vitest';
import { copyNameCommand, copyWorkspacePathCommand, createCopyBadgePayload } from '../../core/commands/copy-badge';
import type { JjRepository } from '../../core/jj-repository';
import { FakeCommandContext } from '../fake-host-environment';
import { createMock } from '../test-utils';

describe('badge clipboard commands', () => {
    test('copies the requested badge value without commit metadata or name decoration', async () => {
        const ctx = new FakeCommandContext(createMock<JjRepository>({}));
        const payload = createCopyBadgePayload([
            {
                commitId: 'unrelated-commit',
                copyName: 'workspace name',
                workspacePath: 'C:\\repos\\workspace name',
            },
        ]);
        await copyNameCommand(ctx, payload);
        expect(ctx.host.nav.clipboardText).toBe('workspace name');
        await copyWorkspacePathCommand(ctx, payload);
        expect(ctx.host.nav.clipboardText).toBe('C:\\repos\\workspace name');
    });

    test('preserves the clipboard for missing or malformed badge values', async () => {
        const ctx = new FakeCommandContext(createMock<JjRepository>({}));
        ctx.host.nav.clipboardText = 'existing';
        for (const args of [[], [null], [{ copyName: 123, workspacePath: false }], [{ copyName: '' }]]) {
            const payload = createCopyBadgePayload(args);
            await copyNameCommand(ctx, payload);
            await copyWorkspacePathCommand(ctx, payload);
            expect(ctx.host.nav.clipboardText).toBe('existing');
        }
    });
});
