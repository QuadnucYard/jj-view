<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjBookmark } from '../../../jj-types';
import type { PillAge } from '../utils/pill-age';
import BasePill from './BasePill.svelte';

interface Props {
    bookmark: JjBookmark;
    style?: string;
    syncedRemotes?: readonly string[];
    age?: PillAge;
}

let { bookmark, style = '', syncedRemotes = [], age }: Props = $props();

const isRemote = $derived(!!bookmark.remote);
const isShared = $derived(!isRemote && syncedRemotes.length > 0);
const displayName = $derived(isRemote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name);
const icon = $derived(isRemote ? 'cloud' : isShared ? 'link' : 'bookmark');
const title = $derived.by(() => {
    if (isRemote) {
        return `Remote bookmark: ${displayName}`;
    }
    const localTitle = `Local bookmark: ${displayName}`;
    if (!isShared) {
        return localTitle;
    }
    const remoteNames = syncedRemotes.map((remote) => `${bookmark.name}@${remote}`).join(', ');
    return `${localTitle}\nRemote bookmarks: ${remoteNames}`;
});

let vscodeContext = $derived(
    JSON.stringify({
        webviewSection: 'jj.bookmark',
        bookmarkName: bookmark.name,
        isRemoteBookmark: isRemote,
        preventDefaultContextMenuItems: true,
    }),
);
</script>

<span
    data-vscode-context={vscodeContext}
    class="bookmark-wrapper"
    class:remote={isRemote}
    class:shared={isShared}
>
    <BasePill
        copyName={displayName}
        {title}
        {age}
        style="background-color: color-mix(in srgb, var(--pill-accent) 15%, transparent); color: var(--vscode-foreground); border-color: color-mix(in srgb, var(--pill-accent) 65%, transparent); {style}"
    >
        <span aria-hidden="true" class="codicon codicon-{icon}"></span>
        <span class="pill-label">{displayName}</span>
    </BasePill>
</span>

<style>
    .bookmark-wrapper {
        --pill-accent: var(--vscode-charts-blue, var(--vscode-foreground));
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .bookmark-wrapper.remote {
        --pill-accent: var(--vscode-charts-purple, var(--vscode-foreground));
    }

    .bookmark-wrapper.shared {
        --pill-accent: var(--vscode-charts-green, var(--vscode-foreground));
    }
</style>

