/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../host/command-context';

export interface CopyBadgePayload {
    copyName?: string;
    workspacePath?: string;
}

export function createCopyBadgePayload(args: unknown[]): CopyBadgePayload {
    for (const arg of args) {
        if (arg && typeof arg === 'object') {
            const copyName = 'copyName' in arg && typeof arg.copyName === 'string' ? arg.copyName : undefined;
            const workspacePath =
                'workspacePath' in arg && typeof arg.workspacePath === 'string' ? arg.workspacePath : undefined;
            if (copyName !== undefined || workspacePath !== undefined) {
                return { copyName, workspacePath };
            }
        }
    }
    return {};
}

export async function copyNameCommand(ctx: CommandContext, payload: CopyBadgePayload): Promise<void> {
    if (payload.copyName) {
        await ctx.host.nav.copyToClipboard(payload.copyName);
    }
}

export async function copyWorkspacePathCommand(ctx: CommandContext, payload: CopyBadgePayload): Promise<void> {
    if (payload.workspacePath) {
        await ctx.host.nav.copyToClipboard(payload.workspacePath);
    }
}
