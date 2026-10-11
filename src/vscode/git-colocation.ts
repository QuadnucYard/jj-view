/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from '../core/jj-service';
import { getJjViewConfig, getWorkspaceConfig, updateJjViewConfig } from './config-utils';

let hasRun = false;

/** Resets the run state for tests. */
export function resetGitColocationCheckForTesting(): void {
    hasRun = false;
}

/** Checks if the repository is git-colocated and prompts the user to disable the Git extension if necessary. */
export async function checkGitColocation(jj: JjService): Promise<void> {
    const gitRoot = await jj.getGitRoot();
    if (!gitRoot) {
        return; // Not git-backed
    }

    if (hasRun) {
        return;
    }
    hasRun = true;

    const repoRoot = await jj.getRepoRoot();

    // Normalize paths to compare. A colocated repo has its .git dir at the repo root.
    const isColocated = path.normalize(gitRoot) === path.normalize(path.join(repoRoot, '.git'));
    if (!isColocated) {
        return;
    }

    const isGitEnabled = getWorkspaceConfig<boolean>('git', 'enabled') !== false;
    const isGitExtensionPresent = !!vscode.extensions.getExtension('vscode.git');

    if (!isGitEnabled || !isGitExtensionPresent) {
        return;
    }

    const isSuppressed = getJjViewConfig<boolean>('suppressGitColocationWarning') === true;

    if (isSuppressed) {
        return;
    }

    const disableAction = 'Prefer JJ Blame';
    const ignoreAction = "Don't Show Again";
    const result = await vscode.window.showInformationMessage(
        'Colocated Jujutsu and Git repository detected. Git source control can stay enabled. JJ line blame yields while Git inline blame is enabled; prefer JJ blame to disable only Git inline blame in this workspace.',
        disableAction,
        ignoreAction,
    );

    if (result === disableAction) {
        await vscode.commands.executeCommand('jj-view.preferJjBlame');
    } else if (result === ignoreAction) {
        await updateJjViewConfig('suppressGitColocationWarning', true, vscode.ConfigurationTarget.Global);
    }
}
