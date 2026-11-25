<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { getPersonDisplayStrings, type PersonInfoProps } from '../utils/person-utils';
import { formatCommitTimestamp } from '../utils/time-utils';

let { person, label, locale }: PersonInfoProps = $props();

const relativeTimeFormatter = $derived(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
const displayStrings = $derived(person ? getPersonDisplayStrings(person, relativeTimeFormatter) : null);
const timestamp = $derived(person ? formatCommitTimestamp(person.timestamp, locale) : '');
const relativeTime = $derived(displayStrings?.relTime === person?.timestamp ? undefined : displayStrings?.relTime);

let timestampRow = $state<HTMLSpanElement>();
let timeValue = $state<HTMLSpanElement>();
let age = $state<HTMLSpanElement>();
let showAge = $state(false);

$effect(() => {
    const row = timestampRow;
    const value = timeValue;
    const relative = age;
    if (!row || !value || !relative) {
        showAge = false;
        return;
    }

    const measure = () => {
        const rowWidth = row.getBoundingClientRect().width;
        const valueWidth = value.getBoundingClientRect().width;
        const relativeWidth = relative.getBoundingClientRect().width;
        showAge = valueWidth + relativeWidth <= rowWidth;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(value);
    observer.observe(relative);
    measure();
    return () => observer.disconnect();
});
</script>

{#if person && displayStrings}
    <div class="person-info">
        <span class="label">{label}:</span>
        <strong class="name">{displayStrings.nameToDisplay}</strong>
        <span
            class="email"
            class:no-email={!displayStrings.hasEmail}
            title="<{displayStrings.emailToDisplay}>"
        >
            &lt;{displayStrings.emailToDisplay}&gt;
        </span>
        {#if timestamp}
            <span class="timestamp" lang={relativeTimeFormatter.resolvedOptions().locale}>
                <span aria-hidden="true" class="dot-separator">•</span>
                <span class="time-row" bind:this={timestampRow}>
                    <span class="time-value" bind:this={timeValue}>
                        <time dateTime={person.timestamp} class="time" dir="auto" title={showAge ? undefined : relativeTime}>
                            {timestamp}
                        </time>
                        {#if relativeTime}
                            <span class="relative-time" class:visible={showAge} bind:this={age}>
                                <bdi>({relativeTime})</bdi>
                            </span>
                        {/if}
                    </span>
                </span>
            </span>
        {/if}
    </div>
{/if}

<style>
    .person-info {
        display: flex;
        align-items: center;
        font-size: 12px;
        line-height: 1.5;
        gap: 2px;
        flex-wrap: wrap;
    }

    .label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        margin-right: 4px;
        flex-shrink: 0;
    }

    .name {
        color: var(--vscode-foreground);
        font-weight: 600;
        margin-right: 4px;
        flex-shrink: 0;
    }

    .email {
        color: var(--vscode-descriptionForeground);
        opacity: 0.75;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
        min-width: 0;
    }

    .email.no-email {
        color: var(--vscode-errorForeground);
    }

    .dot-separator {
        color: var(--vscode-descriptionForeground);
        opacity: 0.4;
        margin: 0 4px;
        flex-shrink: 0;
    }

    .timestamp {
        display: flex;
        flex-grow: 1;
        min-width: 0;
    }

    .time-row {
        display: flex;
        flex: 1;
        min-width: 0;
        overflow: clip;
    }

    .time-value {
        position: relative;
        min-width: 0;
    }

    .time {
        color: var(--vscode-descriptionForeground);
        overflow-wrap: anywhere;
    }

    .relative-time {
        position: absolute;
        inset-block-start: 0;
        inset-inline-start: 100%;
        inline-size: max-content;
        visibility: hidden;
        color: var(--vscode-descriptionForeground);
        padding-inline-start: 5px;
        white-space: nowrap;
    }

    .relative-time.visible {
        visibility: visible;
    }
</style>
