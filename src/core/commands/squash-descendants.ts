/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { AbandonPayload } from './abandon';

export async function squashDescendantsCommand(ctx: CommandContext, payload?: AbandonPayload): Promise<void> {
    if ((payload?.revisions?.length ?? 0) > 1) {
        await ctx.host.ui.showErrorMessage('Select a single revision to squash descendants into.');
        return;
    }
    const revision =
        payload?.revisions?.[0] ??
        (await ctx.host.ui.showInputBox({
            prompt: 'Enter revision to squash descendants into',
            placeHolder: 'Revision ID (e.g. @, change_id)',
        }));
    if (!revision) {
        return;
    }
    try {
        const roots = await ctx.repo.jj.getLog({ revision: `(${revision})`, omitChanges: true });
        const affected = await ctx.repo.jj.getLog({ revision: `(${revision})::`, omitChanges: true });
        if (roots.length !== 1 || affected.some((entry) => entry.is_immutable)) {
            await ctx.host.ui.showErrorMessage('Choose one mutable revision whose descendants are all mutable.');
            return;
        }
        const descendants = affected.filter((entry) => entry.commit_id !== roots[0].commit_id);
        if (descendants.length === 0) {
            await ctx.host.ui.showInformation(`No mutable descendants found for ${revision}.`);
            return;
        }
        const lines = descendants
            .slice(0, 10)
            .map((entry) => `  ${entry.change_id_shortest}  ${entry.description.split('\n')[0] || '(no description)'}`);
        if (descendants.length > 10) {
            lines.push(`  ...and ${descendants.length - 10} more`);
        }
        const label = `${revision} and ${descendants.length} descendant(s)`;
        const showWarning =
            ctx.host.ui.showModalWarning?.bind(ctx.host.ui) ?? ctx.host.ui.showWarning.bind(ctx.host.ui);
        if ((await showWarning(`Squash ${label}?\n\n${lines.join('\n')}`, 'Squash')) !== 'Squash') {
            return;
        }
        await ctx.host.ui.withProgress('Squashing descendants...', () =>
            ctx.repo.jj.squashRevision({
                revision: `${roots[0].commit_id}:: ~ ${roots[0].commit_id}`,
                intoRevision: roots[0].commit_id,
                useDestinationMessage: true,
            }),
        );
        await ctx.repo.refresh({ reason: 'squash descendants' });
        await ctx.host.commands.executeCommand('jj-view.refreshGraph');
        await ctx.host.ui.showInformation(`Squashed ${label}.`);
    } catch (error: unknown) {
        await showJjError(ctx.host.ui, error, 'Failed to squash descendants', ctx.repo.jj, ctx.log);
    }
}
