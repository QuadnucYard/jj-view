/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface PushRefPayload {
    kind?: 'bookmark' | 'tag';
    name?: string;
    isRemote?: boolean;
}

export function createPushRefPayload(args: unknown[]): PushRefPayload {
    for (const arg of args) {
        if (typeof arg !== 'object' || arg === null) {
            continue;
        }
        // A badge's context takes precedence over inherited commit context.
        if (
            'webviewSection' in arg &&
            arg.webviewSection === 'jj.tag' &&
            'tagName' in arg &&
            typeof arg.tagName === 'string'
        ) {
            return { kind: 'tag', name: arg.tagName, isRemote: 'isRemoteTag' in arg && arg.isRemoteTag === true };
        }
        if (
            'webviewSection' in arg &&
            arg.webviewSection === 'jj.bookmark' &&
            'bookmarkName' in arg &&
            typeof arg.bookmarkName === 'string'
        ) {
            return {
                kind: 'bookmark',
                name: arg.bookmarkName,
                isRemote: 'isRemoteBookmark' in arg && arg.isRemoteBookmark === true,
            };
        }
    }
    return {};
}

export async function pushRefCommand(ctx: CommandContext, payload?: PushRefPayload, pickRemote = false): Promise<void> {
    const { kind, name, isRemote } = payload ?? {};
    if (!kind || !name || isRemote) {
        return;
    }

    try {
        const [remotes, refs] = await Promise.all([
            ctx.repo.jj.getGitRemotes(),
            kind === 'bookmark' ? ctx.repo.jj.getBookmarks({ allRemotes: true }) : ctx.repo.jj.getTags(),
        ]);
        if (!refs.some((ref) => ref.name === name && !ref.remote)) {
            await ctx.host.ui.showInformation(`Local ${kind} "${name}" no longer exists.`);
            return;
        }
        if (remotes.length === 0) {
            await ctx.host.ui.showInformation('No Git remotes configured.');
            return;
        }
        const existing = new Set(refs.filter((ref) => ref.name === name && ref.remote).map((ref) => ref.remote));
        const destinations = remotes.filter((remote) => existing.has(remote.name));
        const defaultRemote =
            destinations.length === 1 ? destinations[0] : remotes.length === 1 ? remotes[0] : undefined;
        let remote = pickRemote ? undefined : defaultRemote;
        if (!remote) {
            const pick = await ctx.host.ui.showQuickPick(
                remotes.map((remote) => ({
                    label: remote.name,
                    description: existing.has(remote.name) ? `Has this ${kind}` : `New ${kind}`,
                    detail: remote.url,
                    value: remote.name,
                })),
                { placeHolder: `Select remote to push ${kind} "${name}" to` },
            );
            remote = remotes.find((remote) => remote.name === pick?.value);
        }
        if (!remote) {
            return;
        }
        const destination = remote.name;
        await ctx.host.ui.withProgress(`Pushing ${kind} "${name}" to ${destination}...`, async () => {
            // JJ requires explicit tracking when adding a destination to a ref
            // already tracked elsewhere. Never auto-track an existing remote ref:
            // that could merge its target into the local ref before the push.
            if (destinations.length > 0 && !existing.has(destination)) {
                await ctx.repo.jj.trackRef(kind, name, destination);
            }
            return ctx.repo.jj.upload(
                undefined,
                'git',
                'push',
                '--remote',
                destination,
                kind === 'bookmark' ? '--bookmark' : '--tag',
                `exact:${name}`,
            );
        });
        await ctx.repo.refresh({ reason: 'after ref push' });
        await ctx.host.commands.executeCommand('jj-view.refreshGraph');
        ctx.repo.codeForge.requestRefreshWithBackoffs();
        await ctx.host.ui.showInformation(`Pushed ${kind} "${name}" to ${remote.name}.`);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, `Failed to push ${kind}`, ctx.repo.jj, ctx.log);
    }
}

export async function pushRefToRemoteCommand(ctx: CommandContext, payload?: PushRefPayload): Promise<void> {
    return pushRefCommand(ctx, payload, true);
}
