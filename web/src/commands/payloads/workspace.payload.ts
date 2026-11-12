/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { WorkspaceDeletePayload } from '../../../../src/core/commands/workspace-delete';
import type { WorkspaceForgetPayload } from '../../../../src/core/commands/workspace-forget';
import type {
    WorkspaceOpenInCurrentWindowPayload,
    WorkspaceOpenInNewWindowPayload,
} from '../../../../src/core/commands/workspace-open';
import type { WorkspaceRefreshPayload } from '../../../../src/core/commands/workspace-refresh';

export function createWorkspaceForgetPayload(args: unknown[]): WorkspaceForgetPayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

export function createWorkspaceDeletePayload(args: unknown[]): WorkspaceDeletePayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

export function createWorkspaceOpenInCurrentWindowPayload(args: unknown[]): WorkspaceOpenInCurrentWindowPayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

export function createWorkspaceOpenInNewWindowPayload(args: unknown[]): WorkspaceOpenInNewWindowPayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

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
