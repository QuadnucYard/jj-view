/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface DescribeDialogPayload {
    revision?: string;
}

export async function describeDialogCommand(ctx: CommandContext, payload?: DescribeDialogPayload): Promise<void> {
    const revision = payload?.revision ?? '@';
    try {
        const currentDescription = await ctx.repo.jj.getDescription(revision);
        const description = await ctx.host.ui.showInputBox({
            prompt: `Edit description for ${revision === '@' ? 'working copy' : revision}`,
            placeHolder: 'Description of the changes...',
            value: currentDescription,
        });
        if (description === undefined) {
            return;
        }
        await ctx.host.ui.withProgress('Setting description...', () => ctx.repo.jj.describe(description, revision));
        await ctx.repo.refresh({ reason: 'after describe' });
        await ctx.host.commands.executeCommand('jj-view.refreshGraph');
    } catch (error: unknown) {
        await showJjError(ctx.host.ui, error, 'Error setting description', ctx.repo.jj, ctx.log);
    }
}
