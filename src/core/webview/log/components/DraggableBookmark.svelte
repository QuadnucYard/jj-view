<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjBookmark } from '../../../jj-types';
import { BookmarkPill } from '../../common/components';
import type { DragManager } from '../drag-manager.svelte';

interface Props {
    bookmark: JjBookmark;
    dragManager: DragManager;
    syncedRemotes?: readonly string[];
}

let { bookmark, dragManager, syncedRemotes = [] }: Props = $props();

const isDragging = $derived(
    dragManager.activeDragItem?.type === 'bookmark' &&
        dragManager.activeDragItem.name === bookmark.name &&
        dragManager.activeDragItem.remote === bookmark.remote,
);
</script>

{#if bookmark.remote}
    <span use:dragManager.draggable={() => null}>
        <BookmarkPill {bookmark} {syncedRemotes} />
    </span>
{:else}
    <span
        class="draggable-bookmark"
        class:is-dragging={isDragging}
        use:dragManager.draggable={() => ({
            type: 'bookmark',
            name: bookmark.name,
            remote: bookmark.remote,
        })}
    >
        <BookmarkPill {bookmark} {syncedRemotes} />
    </span>
{/if}

<style>
    .draggable-bookmark {
        cursor: grab;
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .draggable-bookmark.is-dragging {
        cursor: grabbing;
        opacity: 0.3;
        filter: grayscale(100%);
    }
</style>

