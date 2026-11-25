/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { hydrate, mount } from 'svelte';
import { initBridge } from '../transport/bridge.svelte';
import CommitDetailsApp from './CommitDetailsApp.svelte';

const rootElement = document.getElementById('root');
if (rootElement) {
    initBridge();
    const props = { timestampLocale: rootElement.dataset.timestampLocale || undefined };
    if (rootElement.hasChildNodes()) {
        hydrate(CommitDetailsApp, { target: rootElement, props });
    } else {
        mount(CommitDetailsApp, { target: rootElement, props });
    }
    // Signals that event listeners are attached; interactions before this point are not handled.
    rootElement.dataset.hydrated = 'true';
}
