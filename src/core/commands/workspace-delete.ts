/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { getErrorMessage } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export interface WorkspaceDeletePayload {
    workspaceName?: string;
}

export async function workspaceDeleteCommand(ctx: CommandContext, payload?: WorkspaceDeletePayload): Promise<void> {
    const { jj } = ctx.repo;
    const workspaceName = await resolveWorkspaceName(ctx, payload?.workspaceName);
    if (!workspaceName) {
        return;
    }

    const YES = 'Yes, Delete Workspace';
    const warningMessage = `Are you sure you want to forget AND delete the directory for workspace "${workspaceName}"? This action cannot be undone.`;
    const result = ctx.host.ui.showModalWarning
        ? await ctx.host.ui.showModalWarning(warningMessage, YES)
        : await ctx.host.ui.showWarning(warningMessage, YES);

    if (result !== YES) {
        return;
    }

    try {
        // Use the registered path: resolving a workspace root can fail when its
        // directory has already been removed.
        const workspace = (await jj.getWorkspaces()).find((w) => w.name === workspaceName);
        if (!workspace) {
            throw new Error(`Workspace "${workspaceName}" is not registered`);
        }
        const dirPath = workspace.path;
        let directoryMissing = false;
        try {
            await ctx.host.system?.fs.stat(dirPath);
        } catch (e: unknown) {
            if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
                directoryMissing = true;
            } else {
                throw e;
            }
        }

        if (directoryMissing) {
            const forget = 'Yes, Forget Workspace';
            const message = `The directory for workspace "${workspaceName}" is missing: ${dirPath}. Do you want to forget the workspace directly?`;
            const choice = ctx.host.ui.showModalWarning
                ? await ctx.host.ui.showModalWarning(message, forget)
                : await ctx.host.ui.showWarning(message, forget);
            if (choice !== forget) {
                return;
            }
        }

        const progressTitle = directoryMissing
            ? `Forgetting workspace "${workspaceName}"...`
            : `Deleting workspace "${workspaceName}"...`;
        await ctx.host.ui.withProgress(progressTitle, async () => {
            await jj.workspaceForget(workspaceName);
            if (!directoryMissing) {
                await rmRecursive(ctx, dirPath);
            }
        });

        await ctx.repo.refresh();
    } catch (e: unknown) {
        const message = getErrorMessage(e);
        await showJjError(
            ctx.host.ui,
            new Error(`Failed to delete workspace: ${message}`),
            'Workspace Delete Error',
            ctx.repo.jj,
            ctx.log,
        );
    }
}

/**
 * Robustly deletes a directory using HostSystem fs and process fallback.
 */
async function rmRecursive(ctx: CommandContext, dirPath: string): Promise<void> {
    const hostFs = ctx.host.system?.fs;
    let fsError: unknown;
    if (hostFs) {
        try {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const rmPromise = hostFs.rm(dirPath, { recursive: true, force: true });
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Directory removal timed out after 5000ms')), 5000);
            });
            await Promise.race([rmPromise, timeoutPromise]).finally(() => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            });
            return;
        } catch (err) {
            fsError = err;
        }
    }
    const hostProcess = ctx.host.system?.process;
    if (hostProcess) {
        const isWin = ctx.host.system?.platform === 'win32';
        if (isWin) {
            await hostProcess.execFile('cmd.exe', ['/c', 'rd', '/s', '/q', dirPath]);
        } else {
            await hostProcess.execFile('rm', ['-rf', dirPath]);
        }
        return;
    }
    if (fsError) {
        throw fsError;
    }
    throw new Error('Host system does not support filesystem or process execution');
}
