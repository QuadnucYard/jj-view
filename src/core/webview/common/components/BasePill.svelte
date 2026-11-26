<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';
import type { PillAge } from '../utils/pill-age';

interface Props {
    children?: Snippet;
    title?: string;
    className?: string;
    style?: string;
    copyName?: string;
    age?: PillAge;
}

let { children, title, className = '', style = '', copyName, age }: Props = $props();
</script>

<span
    data-vscode-context={copyName ? JSON.stringify({ copyName, preventDefaultContextMenuItems: true }) : undefined}
    title={age ? [title, age.detail].filter(Boolean).join('\n') : title}
    class="bookmark-pill {className}"
    class:dated={age !== undefined}
    {style}
    style:--pill-age-tint={age?.tint}
>
    {@render children?.()}
</span>

<style>
    .bookmark-pill {
        border-radius: 11px;
        padding: 0 6px;
        font-size: inherit;
        line-height: normal;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        flex-shrink: 1;
        vertical-align: middle;
        box-sizing: border-box;
        border: 1px solid transparent;
        min-width: 22px;
        overflow: hidden;
        gap: 4px;
        user-select: none;
    }

    .bookmark-pill :global(.codicon) {
        font-size: 11px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .bookmark-pill.dated {
        --pill-foreground: var(--vscode-foreground);
        background-image: linear-gradient(
            110deg,
            color-mix(in srgb, var(--pill-accent) var(--pill-age-tint), transparent),
            transparent 85%
        );
    }

    .bookmark-pill :global(.pill-label) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: normal;
        display: inline-block;
        transform: translateY(-1px);
    }
</style>

