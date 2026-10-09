/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface DeleteTagPayload {
    tagName?: string;
    isRemoteTag?: boolean;
}

export async function deleteTagCommand(ctx: CommandContext, payload?: DeleteTagPayload): Promise<void> {
    if (payload?.isRemoteTag) {
        return;
    }
    let tagName = payload?.tagName?.trim() || undefined;

    if (!tagName) {
        try {
            const tags = await ctx.host.ui.withProgress('Fetching tags...', () => ctx.repo.jj.getTags());
            const items = tags.filter((tag) => !tag.remote).map((tag) => ({ label: tag.name, value: tag.name }));

            if (items.length === 0) {
                await ctx.host.ui.showInformation('No tags to delete.');
                return;
            }

            const pick = await ctx.host.ui.showQuickPick(items, { placeHolder: 'Select a tag to delete' });
            tagName = typeof pick?.value === 'string' ? pick.value : undefined;
        } catch (e: unknown) {
            await showJjError(ctx.host.ui, e, 'Failed to fetch tags', ctx.repo.jj, ctx.log);
            return;
        }
    }

    if (!tagName) {
        return;
    }

    try {
        await ctx.host.ui.withProgress(`Deleting tag "${tagName}"...`, () => ctx.repo.jj.deleteTag(tagName));
        await ctx.repo.refresh({ reason: 'after tag delete' });
        await ctx.host.commands.executeCommand('jj-view.refreshGraph');
        await ctx.host.ui.showInformation(`Deleted tag "${tagName}".`);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to delete tag', ctx.repo.jj, ctx.log);
    }
}
