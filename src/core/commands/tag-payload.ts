/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DeleteTagPayload } from './tag-delete';

export function createDeleteTagPayload(args: unknown[]): DeleteTagPayload {
    for (const arg of args) {
        if (typeof arg === 'string') {
            return { tagName: arg };
        }
        if (typeof arg === 'object' && arg !== null && 'tagName' in arg && typeof arg.tagName === 'string') {
            return { tagName: arg.tagName };
        }
    }
    return {};
}
