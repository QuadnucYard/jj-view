<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjTag } from '../../../jj-types';
import { TagPill } from '../../common/components';
import type { DragManager } from '../drag-manager.svelte';

interface Props {
    tag: JjTag;
    dragManager: DragManager;
    syncedRemotes?: readonly string[];
}

let { tag, dragManager, syncedRemotes = [] }: Props = $props();

const isDragging = $derived(dragManager.activeDragItem?.type === 'tag' && dragManager.activeDragItem.name === tag.name);
</script>

{#if tag.remote}
    <span use:dragManager.draggable={() => null}>
        <TagPill {tag} {syncedRemotes} />
    </span>
{:else}
<span
    class="draggable-tag"
    class:is-dragging={isDragging}
    use:dragManager.draggable={() => ({ type: 'tag', name: tag.name })}
>
    <TagPill {tag} {syncedRemotes} />
</span>
{/if}

<style>
    .draggable-tag {
        cursor: grab;
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .draggable-tag.is-dragging {
        cursor: grabbing;
        opacity: 0.3;
        filter: grayscale(100%);
    }
</style>

