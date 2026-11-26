/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatCommitTimestamp, getRelativeTimeString } from './time-utils';

const HOUR_MS = 60 * 60 * 1000;
const FADE_HOURS = 30 * 24;

export interface PillAge {
    tint: string;
    detail: string;
}

export function getPillAge(timestamp: string, now: number): PillAge | undefined {
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
        return undefined;
    }

    const elapsedHours = Math.max(0, now - time) / HOUR_MS;
    // A logarithmic scale gives recent updates more visual separation.
    const fade = Math.min(1, Math.log1p(elapsedHours) / Math.log1p(FADE_HOURS));
    return {
        tint: `${(4 + 28 * (1 - fade)).toFixed(1)}%`,
        detail:
            time >= now + 5000
                ? `Target commit timestamp: ${formatCommitTimestamp(timestamp)}`
                : `Target commit updated ${getRelativeTimeString(time, now)}`,
    };
}
