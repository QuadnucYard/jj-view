/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenFilePayload } from '../../core/commands/open';
import { toFileUri, Uri } from '../../core/uri-utils';
import { gitCanRevealFile } from '../scm-editor-options';
import { extractActiveResourceUri } from './payload-helpers';

export function createOpenFilePayload(args: unknown[]): OpenFilePayload {
    const { resourceUri } = extractActiveResourceUri(args);
    return {
        resourceUri,
        sourceUri: Uri.isUri(args[0]) ? args[0] : undefined,
        ...(resourceUri?.scheme === 'jj-scm' && gitCanRevealFile(toFileUri(resourceUri)) ? { openBeside: true } : {}),
    };
}
