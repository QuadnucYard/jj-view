/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractRevisions } from './command-utils';
import type { CreateTagPayload } from './tag-create';
import type { DeleteTagPayload } from './tag-delete';

export function createDeleteTagPayload(args: unknown[]): DeleteTagPayload {
    for (const arg of args) {
        if (typeof arg === 'string') {
            return { tagName: arg };
        }
        if (typeof arg === 'object' && arg !== null && 'tagName' in arg && typeof arg.tagName === 'string') {
            return { tagName: arg.tagName, isRemoteTag: 'isRemoteTag' in arg && arg.isRemoteTag === true };
        }
    }
    return {};
}

export function createCreateTagPayload(args: unknown[]): CreateTagPayload {
    const revision = extractRevisions(args)[0];
    const arg = args.find((arg) => typeof arg === 'object' && arg !== null && 'tagName' in arg);
    const tagName =
        typeof arg === 'object' && arg !== null && 'tagName' in arg && typeof arg.tagName === 'string'
            ? arg.tagName
            : undefined;
    return { revision, tagName };
}
