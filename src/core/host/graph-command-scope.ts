/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JjRepositoryManager } from '../jj-repository-manager';
import { Uri } from '../uri-utils';
import type { HostCommands, HostDisposable } from './host-environment';

const GRAPH_TOOLBAR_COMMANDS = ['undo', 'redo', 'abandon', 'newMergeChange', 'newBefore', 'workspaceAdd'] as const;

/** Native view-title actions do not carry a repository URI. */
export function registerGraphToolbarCommands(commands: HostCommands, manager: JjRepositoryManager): HostDisposable[] {
    return GRAPH_TOOLBAR_COMMANDS.map((action) =>
        commands.registerCommand(`jj-view.graph.${action}`, async () => {
            const repo = manager.focusedRepository;
            if (repo) {
                await commands.executeCommand(`jj-view.${action}`, { graphRepositoryRoot: repo.rootUri });
            }
        }),
    );
}

/** Keep graph command routing independent of the active editor's repository. */
export function extractGraphCommandScope(args: unknown[]): { args: unknown[]; rootUri?: Uri } {
    const last = args.at(-1);
    if (last && typeof last === 'object' && 'graphRepositoryRoot' in last && Uri.isUri(last.graphRepositoryRoot)) {
        return { args: args.slice(0, -1), rootUri: last.graphRepositoryRoot };
    }
    const first = args[0];
    if (
        first &&
        typeof first === 'object' &&
        'graphRepositoryPath' in first &&
        typeof first.graphRepositoryPath === 'string'
    ) {
        return { args, rootUri: Uri.file(first.graphRepositoryPath) };
    }
    return { args };
}

/** A stale graph action must never fall back to another repository. */
export function getGraphCommandRepository(manager: JjRepositoryManager, rootUri: Uri) {
    return manager.repositories.find((repo) => repo.rootUri.toString() === rootUri.toString());
}
