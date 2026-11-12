/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { resolveWorkspaceName } from './workspace-utils';

export interface WorkspaceRefreshPayload {
    workspaceName?: string;
}

export async function workspaceRefreshCommand(ctx: CommandContext, payload?: WorkspaceRefreshPayload): Promise<void> {
    let workspaceName: string | undefined;
    try {
        workspaceName = await resolveWorkspaceName(ctx, payload?.workspaceName);
        if (!workspaceName) {
            return;
        }
        const targetName = workspaceName;
        await ctx.host.ui.withProgress(`Refreshing workspace "${workspaceName}"...`, async () => {
            await ctx.repo.jj.workspaceRefresh(targetName);
            await ctx.repo.refresh({ reason: 'workspace refresh command' });
        });
    } catch (error: unknown) {
        const prefix = workspaceName ? `Failed to refresh workspace "${workspaceName}"` : 'Failed to resolve workspace';
        await showJjError(ctx.host.ui, error, prefix, ctx.repo.jj, ctx.log);
    }
}
