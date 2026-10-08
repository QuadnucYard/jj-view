/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import type { CommandContext } from '../host/command-context';
import { getFsPathFromUri, type Uri } from '../uri-utils';
import { extractUriFromArgs } from './command-utils';

export interface CopyRelativePathPayload {
    relativePath?: string;
    resourceUri?: Uri;
}

export function createCopyRelativePathPayload(args: unknown[]): CopyRelativePathPayload {
    const resource = args[0];
    const relativePath =
        resource &&
        typeof resource === 'object' &&
        'relativePath' in resource &&
        typeof resource.relativePath === 'string'
            ? resource.relativePath
            : undefined;
    return { relativePath, resourceUri: extractUriFromArgs(args) };
}

export async function copyRelativePathCommand(ctx: CommandContext, payload: CopyRelativePathPayload): Promise<void> {
    const relativePath =
        payload.relativePath ??
        (payload.resourceUri
            ? path.relative(ctx.repo.rootUri.fsPath, getFsPathFromUri(payload.resourceUri))
            : undefined);
    if (relativePath === undefined) {
        return;
    }
    await ctx.host.nav.copyToClipboard(relativePath);
}
