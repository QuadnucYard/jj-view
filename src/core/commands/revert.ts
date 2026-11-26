/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export async function revertCommand(ctx: CommandContext, revision: string | undefined): Promise<void> {
    if (!revision) {
        return;
    }

    try {
        await ctx.host.ui.withProgress('Reverting...', () => ctx.repo.jj.revert(revision, { onto: revision }));
        await ctx.repo.refresh({ reason: 'after revert' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error reverting commit', ctx.repo.jj, ctx.log);
    }
}
