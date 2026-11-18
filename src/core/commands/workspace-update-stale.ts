/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { resolveWorkspaceName, type WorkspaceNamePayload } from './workspace-utils';

export async function workspaceUpdateStaleCommand(ctx: CommandContext, payload: WorkspaceNamePayload): Promise<void> {
    try {
        const workspaceName = await resolveWorkspaceName(ctx, payload.workspaceName);
        if (workspaceName) {
            await ctx.host.ui.withProgress(`Updating stale workspace "${workspaceName}"...`, () =>
                ctx.repo.jj.workspaceUpdateStale(workspaceName),
            );
        }
    } catch (error: unknown) {
        await showJjError(ctx.host.ui, error, 'Failed to update stale workspace', ctx.repo.jj, ctx.log);
    }
}
