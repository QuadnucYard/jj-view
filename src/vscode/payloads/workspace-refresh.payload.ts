/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkspaceRefreshPayload } from '../../core/commands/workspace-refresh';

export function createWorkspaceRefreshPayload(args: unknown[]): WorkspaceRefreshPayload {
    const arg = args[0];
    if (typeof arg === 'string') {
        return { workspaceName: arg };
    }
    if (arg && typeof arg === 'object') {
        if ('workspaceName' in arg && typeof arg.workspaceName === 'string') {
            return { workspaceName: arg.workspaceName };
        }
        if ('name' in arg && typeof arg.name === 'string') {
            return { workspaceName: arg.name };
        }
    }
    return {};
}
