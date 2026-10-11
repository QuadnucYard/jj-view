/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

interface GitRepository {
    readonly rootUri: vscode.Uri;
}
interface GitApi {
    readonly repositories: readonly GitRepository[];
    readonly onDidOpenRepository: vscode.Event<GitRepository>;
    readonly onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: vscode.Event<boolean>;
    getAPI(version: 1): GitApi;
}
const PREVIOUS_VALUE_KEY = 'jj-view.previousGitBlameWorkspaceValue';

/** Detects actual Git providers, including Git repositories nested within JJ workspaces. */
export class GitBlameCoexistence implements vscode.Disposable {
    private extension: GitExtension | undefined;
    private api: GitApi | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly gitSubscriptions: vscode.Disposable[] = [];
    private disposed = false;
    private attachment = 0;
    private attaching = true;

    constructor(private readonly onChange: () => void) {
        this.subscriptions.push(vscode.extensions.onDidChange(() => void this.attach()));
        void this.attach();
    }

    private async attach(): Promise<void> {
        const attachment = ++this.attachment;
        this.attaching = true;
        try {
            const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
            const exports = extension ? await extension.activate() : undefined;
            if (this.disposed || attachment !== this.attachment) {
                return;
            }
            this.gitSubscriptions.splice(0).forEach((subscription) => {
                subscription.dispose();
            });
            this.extension = exports;
            this.api = undefined;
            if (exports) {
                // Git fires enablement before finishing its API initialization. Reattach
                // asynchronously so getAPI runs after all initialization setters finish.
                this.gitSubscriptions.push(exports.onDidChangeEnablement(() => void this.attach()));
                this.api = exports.enabled ? exports.getAPI(1) : undefined;
                if (this.api) {
                    this.gitSubscriptions.push(
                        this.api.onDidOpenRepository(this.onChange),
                        this.api.onDidCloseRepository(this.onChange),
                    );
                }
                this.onChange();
            } else {
                this.onChange();
            }
        } catch {
            // Git can be unavailable in remote or restricted extension hosts.
            if (!this.disposed && attachment === this.attachment) {
                this.extension = undefined;
                this.api = undefined;
                this.onChange();
            }
        } finally {
            if (!this.disposed && attachment === this.attachment) {
                this.attaching = false;
                this.onChange();
            }
        }
    }

    hasInlineBlame(uri: vscode.Uri): boolean {
        if (
            uri.scheme !== 'file' ||
            vscode.workspace.getConfiguration('git').get<boolean>('enabled') === false ||
            vscode.workspace.getConfiguration('git').get<boolean>('blame.editorDecoration.enabled') !== true
        ) {
            return false;
        }
        // Avoid briefly drawing two decorations while the Git extension is activating.
        if (this.attaching) {
            return true;
        }
        if (!this.extension?.enabled) {
            return false;
        }
        return (
            this.api?.repositories.some((repo) => {
                const relative = path.relative(repo.rootUri.fsPath, uri.fsPath);
                return (
                    relative === '' ||
                    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
                );
            }) ?? false
        );
    }

    dispose(): void {
        this.disposed = true;
        this.subscriptions.splice(0).forEach((subscription) => {
            subscription.dispose();
        });
        this.gitSubscriptions.splice(0).forEach((subscription) => {
            subscription.dispose();
        });
    }
}

export async function preferJjBlame(storage: vscode.Memento): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.window.showInformationMessage('Open a workspace before configuring JJ blame.');
        return;
    }
    const config = vscode.workspace.getConfiguration('git');
    if (config.get<boolean>('blame.editorDecoration.enabled') !== true) {
        return;
    }
    const action = { title: 'Prefer JJ Blame' };
    const selected = await vscode.window.showInformationMessage(
        'Disable Git inline blame throughout this workspace so JJ line blame can appear? Git source control and status-bar blame stay enabled.',
        { modal: true },
        action,
    );
    if (selected?.title !== action.title) {
        return;
    }
    const previous = config.inspect<boolean>('blame.editorDecoration.enabled')?.workspaceValue;
    if (!storage.get(PREVIOUS_VALUE_KEY)) {
        await storage.update(PREVIOUS_VALUE_KEY, { previous: previous ?? null });
    }
    await config.update('blame.editorDecoration.enabled', false, vscode.ConfigurationTarget.Workspace);
}

export async function restoreGitBlame(storage: vscode.Memento): Promise<void> {
    const saved = storage.get<unknown>(PREVIOUS_VALUE_KEY);
    if (
        !saved ||
        typeof saved !== 'object' ||
        !('previous' in saved) ||
        (saved.previous !== null && typeof saved.previous !== 'boolean')
    ) {
        return;
    }
    const config = vscode.workspace.getConfiguration('git');
    if (config.inspect<boolean>('blame.editorDecoration.enabled')?.workspaceValue === false) {
        await config.update(
            'blame.editorDecoration.enabled',
            saved.previous ?? undefined,
            vscode.ConfigurationTarget.Workspace,
        );
    }
    await storage.update(PREVIOUS_VALUE_KEY, undefined);
}
