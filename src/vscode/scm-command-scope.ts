/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostEnvironment } from '../core/host/host-environment';
import { resolveRepository } from '../core/host/ui-helpers';
import type { JjRepositoryManager } from '../core/jj-repository-manager';
import type { VsCodeScmProvider } from './providers/vscode-scm-provider';

const SCM_INPUT_COMMANDS = new Set([
    'jj-view.commit',
    'jj-view.commitPrompt',
    'jj-view.setDescription',
    'jj-view.switchScmWorkspace',
    'jj-view.refresh',
    'jj-view.new',
]);

export function resolveScmCommand(
    commandId: string,
    args: unknown[],
    manager: JjRepositoryManager,
    providers: Map<string, VsCodeScmProvider>,
    host: HostEnvironment,
) {
    const first = args[0];
    for (const provider of providers.values()) {
        if (first === provider.sourceControl || provider.ownsGroup(first)) {
            return { repo: provider.repo, scm: provider };
        }
    }
    // A title/input action from a replaced provider must not target its successor.
    if (first && typeof first === 'object' && 'inputBox' in first && 'id' in first) {
        return undefined;
    }
    // Keyboard input actions belong to the displayed SCM, regardless of editor focus.
    if (args.length === 0 && SCM_INPUT_COMMANDS.has(commandId)) {
        const owner = manager.focusedRepository;
        const scm =
            (owner && providers.get(owner.rootUri.fsPath)) ??
            (providers.size === 1 ? providers.values().next().value : undefined);
        if (scm) {
            return { repo: scm.repo, scm };
        }
    }
    const repo = resolveRepository(manager, { args, host });
    if (!repo) {
        return undefined;
    }
    const scm = Array.from(providers.values()).find((provider) => provider.repo === repo);
    return { repo, scm };
}
