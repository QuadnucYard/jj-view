/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { describeDialogCommand } from '../../core/commands/describe-dialog';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

let repo: TestRepo;
let ctx: FakeCommandContext;
beforeEach(() => {
    repo = new TestRepo(); repo.init();
    ctx = new FakeCommandContext(createMock<JjRepository>({
        jj: new JjService(repo.path, NO_OP_LOGGER), rootUri: Uri.file(repo.path),
        refresh: vi.fn().mockResolvedValue(undefined),
    }));
});
afterEach(() => repo.dispose());
test('edits the requested revision and allows clearing its description', async () => {
    repo.new([], 'original'); const target = repo.getChangeId('@'); repo.new([], 'working copy');
    ctx.host.ui.setNextInputBoxResponse('');
    await describeDialogCommand(ctx, { revision: target });
    expect(await ctx.repo.jj.getDescription(target)).toBe('');
    expect(await ctx.repo.jj.getDescription('@')).toBe('working copy');
    expect(ctx.host.ui.errorMessages).toEqual([]);
});
test('cancellation leaves the description intact', async () => {
    repo.new([], 'original');
    await describeDialogCommand(ctx);
    expect(await ctx.repo.jj.getDescription('@')).toBe('original');
});
