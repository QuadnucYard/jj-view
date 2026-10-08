/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';
import { copyRelativePathCommand, createCopyRelativePathPayload } from '../../core/commands/copy-relative-path';
import type { JjRepository } from '../../core/jj-repository';
import { createJjResourceState } from '../../core/scm-resource-state';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { createMock } from '../test-utils';

describe('copyRelativePathCommand', () => {
    const root = Uri.file('/repo');

    test.each([
        'added',
        'modified',
        'deleted',
    ] as const)('copies the repository-relative path of a %s item', async (status) => {
        const ctx = new FakeCommandContext(createMock<JjRepository>({ rootUri: root }));
        const state = createJjResourceState({ path: 'src/nested/file name.ts', status }, '@', root.fsPath);

        await copyRelativePathCommand(ctx, createCopyRelativePathPayload([state]));

        expect(ctx.host.nav.clipboardText).toBe('src/nested/file name.ts');
        expect(ctx.host.nav.filesOpened).toHaveLength(0);
    });

    test('copies a historical item path without its revision metadata', async () => {
        const ctx = new FakeCommandContext(createMock<JjRepository>({ rootUri: root }));
        const state = createJjResourceState({ path: 'docs/guide.md', status: 'deleted' }, 'abc123', root.fsPath);

        await copyRelativePathCommand(ctx, createCopyRelativePathPayload([state]));

        expect(ctx.host.nav.clipboardText).toBe('docs/guide.md');
    });

    test('derives the path from the owning repository when relativePath is absent', async () => {
        const ctx = new FakeCommandContext(createMock<JjRepository>({ rootUri: root }));
        await copyRelativePathCommand(
            ctx,
            createCopyRelativePathPayload([{ resourceUri: Uri.joinPath(root, 'src/file.ts') }]),
        );

        expect(ctx.host.nav.clipboardText).toBe('src/file.ts');
    });

    test('leaves the clipboard unchanged when there is no item', async () => {
        const ctx = new FakeCommandContext(createMock<JjRepository>({ rootUri: root }));
        ctx.host.nav.clipboardText = 'existing';

        await copyRelativePathCommand(ctx, createCopyRelativePathPayload([]));

        expect(ctx.host.nav.clipboardText).toBe('existing');
    });
});
