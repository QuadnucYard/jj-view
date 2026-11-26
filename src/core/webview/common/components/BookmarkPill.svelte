<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjBookmark } from '../../../jj-types';
import BasePill from './BasePill.svelte';

interface Props {
    bookmark: JjBookmark;
    style?: string;
    syncedRemotes?: readonly string[];
}

let { bookmark, style = '', syncedRemotes = [] }: Props = $props();

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
        style="background-color: color-mix(in srgb, var(--bookmark-accent) 15%, transparent); color: var(--vscode-foreground); border-color: color-mix(in srgb, var(--bookmark-accent) 65%, transparent); {style}"
    >
        <span aria-hidden="true" class="codicon codicon-{icon}"></span>
        <span class="pill-label">{displayName}</span>
    </BasePill>
</span>

<style>
    .bookmark-wrapper {
        --bookmark-accent: var(--vscode-charts-blue, var(--vscode-foreground));
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .bookmark-wrapper.remote {
        --bookmark-accent: var(--vscode-charts-purple, var(--vscode-foreground));
    }

    .bookmark-wrapper.shared {
        --bookmark-accent: var(--vscode-charts-green, var(--vscode-foreground));
    }
</style>

