<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import BasePill from './BasePill.svelte';

interface Props {
    workspace: string;
    path?: string;
    stale?: boolean;
    style?: string;
}

let { workspace, path, stale = false, style = '' }: Props = $props();

const accentColor = $derived(
    stale ? 'var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow))' : 'var(--vscode-charts-yellow)',
);
const backgroundColor = $derived(`color-mix(in srgb, ${accentColor}, transparent ${stale ? 78 : 90}%)`);
const border = $derived(
    stale ? `1px dashed ${accentColor}` : `1px solid color-mix(in srgb, ${accentColor}, transparent 50%)`,
);
const title = $derived(`${workspace}@${stale ? ' (stale)' : ''}${path ? `\n${path}` : ''}`);

let vscodeContext = $derived(
    JSON.stringify({
        webviewSection: 'workspace',
        workspaceName: workspace,
        workspacePath: path,
        workspaceStale: stale,
        preventDefaultContextMenuItems: true,
    }),
);
</script>

<span
    data-vscode-context={vscodeContext}
    class="workspace-wrapper"
    class:stale
>
    <BasePill
        copyName={workspace}
        {title}
        style="background-color: {backgroundColor}; color: {accentColor}; border: {border}; {style}"
    >
        {#if stale}
            <span class="codicon codicon-warning" role="img" aria-label="Stale workspace"></span>
        {/if}
        <span class="pill-label">
            <span class="isolate-dir">{workspace}@</span>
        </span>
    </BasePill>
</span>

<style>
    .workspace-wrapper {
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .pill-label {
        direction: rtl;
        text-align: left;
    }

    .isolate-dir {
        direction: ltr;
        unicode-bidi: isolate;
    }
</style>

