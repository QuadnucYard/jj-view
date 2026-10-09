/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
interface NamedRef {
    name: string;
    remote?: string | null;
}

export interface RefBadge<T extends NamedRef> {
    ref: T;
    syncedRemotes: string[];
}

export function getRefBadges<T extends NamedRef>(refs: readonly T[] = []): RefBadge<T>[] {
    const localNames = new Set(refs.filter((ref) => !ref.remote).map((ref) => ref.name));
    const remotesByName = new Map<string, Set<string>>();
    for (const ref of refs) {
        if (ref.remote) {
            const remotes = remotesByName.get(ref.name) ?? new Set<string>();
            remotes.add(ref.remote);
            remotesByName.set(ref.name, remotes);
        }
    }
    return refs
        .filter((ref) => !ref.remote || !localNames.has(ref.name))
        .map((ref) => ({
            ref,
            syncedRemotes: ref.remote ? [] : [...(remotesByName.get(ref.name) ?? [])],
        }));
}
