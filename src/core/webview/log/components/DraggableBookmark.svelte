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
    !bookmark.remote &&
        dragManager.activeDragItem?.type === 'bookmark' &&
        dragManager.activeDragItem.name === bookmark.name,
);
</script>

<span
    class="bookmark-drag-wrapper"
    class:draggable-bookmark={!bookmark.remote}
    class:is-dragging={isDragging}
    use:dragManager.draggable={() => bookmark.remote ? null : { type: 'bookmark', name: bookmark.name, syncedRemotes }}
>
    <BookmarkPill {bookmark} {syncedRemotes} />
</span>

<style>
    .bookmark-drag-wrapper {
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .draggable-bookmark {
        cursor: grab;
    }

    .draggable-bookmark.is-dragging {
        cursor: grabbing;
        opacity: 0.3;
        filter: grayscale(100%);
    }
</style>

