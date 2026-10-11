/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface CreateTagPayload {
    revision?: string;
    tagName?: string;
}

export async function createTagCommand(ctx: CommandContext, payload?: CreateTagPayload): Promise<void> {
    const revision = payload?.revision;
    if (!revision) {
        return;
    }

    try {
        const tags = await ctx.host.ui.withProgress('Fetching tags...', () => ctx.repo.jj.getTags());
        const localNames = new Set(tags.filter((tag) => !tag.remote).map((tag) => tag.name));
        const validateInput = (value: string): string | undefined => {
            const name = value.trim();
            if (!name) {
                return 'Enter a tag name.';
            }
            if (localNames.has(name)) {
                return 'A local tag with this name already exists.';
            }
            return undefined;
        };
        const name = (
            payload?.tagName?.trim() ||
            (await ctx.host.ui.showInputBox({
                prompt: 'Create a tag at the selected revision',
                placeHolder: 'Tag name',
                validateInput,
            }))
        )?.trim();
        if (!name) {
            return;
        }
        const error = validateInput(name);
        if (error) {
            await ctx.host.ui.showErrorMessage(error);
            return;
        }

        await ctx.host.ui.withProgress(`Creating tag "${name}"...`, () => ctx.repo.jj.createTag(name, revision));
        await ctx.repo.refresh({ reason: 'after tag create' });
        await ctx.host.commands.executeCommand('jj-view.refreshGraph');
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to create tag', ctx.repo.jj, ctx.log);
    }
}
