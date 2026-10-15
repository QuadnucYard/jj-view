<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { LogViewHostToWebviewMessage } from '../../../host/ipc/log-view-schemas';

type FocusState = Extract<LogViewHostToWebviewMessage, { type: 'repositoryFocus' }>['payload'];
let {
    state,
    onShowRepository,
    onSetIncluded,
    onSetFollowEditor,
}: {
    state: FocusState;
    onShowRepository: (path: string) => void;
    onSetIncluded: (path: string, included: boolean) => void;
    onSetFollowEditor: (enabled: boolean) => void;
} = $props();
const included = $derived(state.repositories.filter((repo) => repo.included));
const excluded = $derived(state.repositories.filter((repo) => !repo.included));
</script>

<div class="repository-toolbar" role="group" aria-label="Graph repository controls">
    <select aria-label="Graph repository" title={state.focusedPath ?? 'Choose a repository'}
        value={state.focusedPath ?? ''} onchange={(event) => onShowRepository(event.currentTarget.value)}>
        {#if !state.focusedPath}<option value="" disabled>Choose a repository</option>{/if}
        {#each included as repo (repo.path)}
            <option value={repo.path} title={repo.path}>{repo.name}</option>
        {/each}
        {#if excluded.length > 0}
            <optgroup label="Show repository in graph">
                {#each excluded as repo (repo.path)}
                    <option value={repo.path} title={repo.path}>Show {repo.name}</option>
                {/each}
            </optgroup>
        {/if}
    </select>
    <details class="repository-scope">
        <summary title="Choose repositories for the graph">Repositories ({included.length})</summary>
        <div class="scope-menu">
            <p>Choose repositories for the graph.</p>
            {#each state.repositories as repo (repo.path)}
                <label title={repo.path}>
                    <input type="checkbox" checked={repo.included}
                        onchange={(event) => onSetIncluded(repo.path, event.currentTarget.checked)} />
                    <span>{repo.name}<small>{repo.path}</small></span>
                </label>
            {/each}
            {#if state.repositories.length === 0}<p>No repositories available.</p>{/if}
        </div>
    </details>
    <button class:enabled={state.followEditor} type="button" aria-label="Follow Editor" aria-pressed={state.followEditor}
        title="Switch graph repositories when the active editor belongs to a chosen repository"
        onclick={() => onSetFollowEditor(!state.followEditor)}><span class="codicon codicon-link" aria-hidden="true"></span><span class="follow-label">Follow Editor</span></button>
</div>

<style>
    .repository-toolbar {
        container-type: inline-size;
        display: flex; align-items: center; gap: 6px; min-height: 35px; padding: 0 8px;
        border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
        background: var(--vscode-editorGroupHeader-tabsBackground); color: var(--vscode-foreground);
        font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    }
    select {
        flex: 1; min-width: 70px; max-width: 260px; padding: 3px; border-radius: 6px; font: inherit;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    }
    button, summary { cursor: pointer; white-space: nowrap; font: inherit; padding: 4px 6px; border-radius: 6px; }
    button {
        display: flex; align-items: center; gap: 4px;
        border: 1px solid var(--vscode-widget-border);
        background: var(--vscode-editor-background); color: var(--vscode-foreground);
    }
    button.enabled {
        background: var(--vscode-inputOption-activeBackground, var(--vscode-list-activeSelectionBackground));
        border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
        color: var(--vscode-inputOption-activeForeground, var(--vscode-list-activeSelectionForeground));
    }
    button:hover, summary:hover, label:hover { background: var(--vscode-list-hoverBackground); }
    button:focus-visible, select:focus-visible, summary:focus-visible, input:focus-visible {
        outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
    }
    .repository-scope { position: relative; }
    .scope-menu {
        position: absolute; top: 100%; right: 0; z-index: 100; min-width: 240px;
        max-width: min(420px, 80vw); max-height: 60vh; overflow: auto; padding: 6px;
        background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px;
    }
    p { margin: 6px; color: var(--vscode-descriptionForeground); }
    label { display: flex; align-items: flex-start; gap: 6px; padding: 6px; cursor: pointer; }
    label span { overflow: hidden; overflow-wrap: anywhere; }
    small { display: block; color: var(--vscode-descriptionForeground); }
    @container (max-width: 360px) {
        .follow-label { display: none; }
    }
</style>
