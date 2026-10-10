/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenFilePayload } from '../../core/commands/open';
import { Uri } from '../../core/uri-utils';
import { extractActiveResourceUri } from './payload-helpers';

export function createOpenFilePayload(args: unknown[]): OpenFilePayload {
    const { resourceUri } = extractActiveResourceUri(args);
    return {
        resourceUri,
        sourceUri: Uri.isUri(args[0]) ? args[0] : undefined,
    };
}
