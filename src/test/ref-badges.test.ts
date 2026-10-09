/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, test } from 'vitest';
import { getRefBadges } from '../core/webview/common/utils/ref-badges';

describe('getRefBadges', () => {
    test('collapses matching remotes into the local badge regardless of order', () => {
        const local = { name: 'release', remote: null };
        const tags = [
            { name: 'release', remote: 'origin' },
            local,
            { name: 'release', remote: 'backup' },
            { name: 'release', remote: 'origin' },
        ];
        expect(getRefBadges(tags)).toEqual([{ ref: local, syncedRemotes: ['origin', 'backup'] }]);
        expect(tags).toHaveLength(4);
    });

    test('keeps remote-only refs and different ref names distinct', () => {
        const tags = [{ name: 'local' }, { name: 'release', remote: 'origin' }, { name: 'release', remote: 'backup' }];
        expect(getRefBadges(tags)).toEqual(tags.map((tag) => ({ ref: tag, syncedRemotes: [] })));
        expect(getRefBadges()).toEqual([]);
    });

    test('keeps refs on different nodes separate and reveals remotes after local deletion', () => {
        const local = { name: 'release' };
        const remote = { name: 'release', remote: 'origin' };
        expect(getRefBadges([local])).toEqual([{ ref: local, syncedRemotes: [] }]);
        expect(getRefBadges([remote])).toEqual([{ ref: remote, syncedRemotes: [] }]);
        expect(getRefBadges([local, remote])).toEqual([{ ref: local, syncedRemotes: ['origin'] }]);
        expect(getRefBadges([remote])).toEqual([{ ref: remote, syncedRemotes: [] }]);
    });
});
