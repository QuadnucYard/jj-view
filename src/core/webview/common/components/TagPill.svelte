<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjTag } from '../../../jj-types';
import BasePill from './BasePill.svelte';

interface Props {
    tag: JjTag;
    style?: string;
}

let { tag, style = '' }: Props = $props();

const displayName = $derived(tag.remote ? `${tag.name}@${tag.remote}` : tag.name);
const accentColor = $derived(tag.remote ? 'var(--vscode-charts-purple)' : 'var(--vscode-charts-green)');
const backgroundColor = $derived(`color-mix(in srgb, ${accentColor}, transparent 90%)`);
const borderColor = $derived(`color-mix(in srgb, ${accentColor}, transparent 50%)`);
</script>

<span
    class="tag-wrapper"
    data-vscode-context={JSON.stringify({
        webviewSection: 'jj.tag',
        tagName: tag.name,
        isRemoteTag: !!tag.remote,
        preventDefaultContextMenuItems: true,
    })}
>
<BasePill
    title={displayName}
    style="background-color: {backgroundColor}; color: {accentColor}; border: 1px solid {borderColor}; {style}"
>
    <span aria-hidden="true" class="codicon codicon-tag"></span>
    <span class="pill-label">{displayName}</span>
</BasePill>
</span>

<style>
    .tag-wrapper {
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }
</style>
