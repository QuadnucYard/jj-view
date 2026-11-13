/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { showJjError } from '../core/host/ui-helpers';
import type { JjRepository } from '../core/jj-repository';
import type { JjRepositoryManager } from '../core/jj-repository-manager';
import { ScmModel } from '../core/scm-model';
import { Uri } from '../core/uri-utils';
import { toError } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';
import type { VsCodeScmProvider } from './providers/vscode-scm-provider';

type MountWorkspace = (repo: JjRepository, model: ScmModel, workspaceName: string) => VsCodeScmProvider;

/** Owns SCM selection independently of the graph's repository focus. */
export class ScmWorkspacePicker {
    private selectedName: string | undefined;
    private disposed = false;
    private pending: Promise<void> = Promise.resolve();
    private readonly drafts = new Map<string, { changeId: string; description: string; value: string }>();
    private readonly storageKey: string;

    constructor(
        public readonly owner: JjRepository,
        private readonly manager: JjRepositoryManager,
        private current: VsCodeScmProvider,
        private readonly mount: MountWorkspace,
        private readonly log: LoggerChannel,
    ) {
        this.storageKey = `jj-view.scmWorkspace:${owner.rootUri.toString()}`;
    }

    async restore(): Promise<void> {
        try {
            const saved = await this.manager.workspaceState.get<string>(this.storageKey);
            const workspaces = await this.owner.jj.getWorkspaces();
            const fallback = workspaces.find(
                (workspace) => Uri.file(workspace.path).toString() === this.owner.rootUri.toString(),
            );
            const target = workspaces.find((workspace) => workspace.name === saved) ?? fallback;
            if (target) {
                await this.select(target.name);
            }
        } catch (error: unknown) {
            this.log.error('[SCM] Failed to restore workspace selection', toError(error));
            await this.manager.host.ui.showWarning(
                'Could not restore the SCM workspace. Showing the opened workspace. Use Switch Workspace in SCM to retry.',
            );
        }
    }

    async pick(): Promise<void> {
        try {
            await this.owner.jj.clearCache();
            const workspaces = await this.owner.jj.getWorkspaces();
            const selected = await this.manager.host.ui.showQuickPick(
                workspaces.map((workspace) => ({
                    label: workspace.name,
                    description: workspace.name === this.selectedName ? 'Selected' : undefined,
                    detail: workspace.path,
                })),
                { title: 'Switch Workspace in SCM', placeHolder: 'Select the workspace to view', matchOnDetail: true },
            );
            if (selected) {
                await this.select(selected.label);
            }
        } catch (error: unknown) {
            await showJjError(this.manager.host.ui, error, 'Failed to switch SCM workspace', this.owner.jj, this.log);
        }
    }

    select(name: string): Promise<void> {
        const next = this.pending.then(() => this.switchWorkspace(name));
        this.pending = next.catch(() => {});
        return next;
    }

    private async switchWorkspace(name: string): Promise<void> {
        if (this.disposed || name === this.selectedName) {
            return;
        }
        const repo = await this.manager.getWorkspaceRepository(this.owner, name);
        const model = new ScmModel(repo, this.log);
        let mounted = false;
        try {
            // Snapshot from the target directory before replacing the visible provider.
            await model.refresh({ forceSnapshot: true, reason: 'SCM workspace selection' });
            if (!model.snapshot?.currentEntry) {
                throw new Error(`Could not load workspace "${name}". Refresh the workspace and try again.`);
            }
            await this.current.ready;
            if (this.disposed) {
                return;
            }
            const previous = this.current;
            const previousEntry = previous.scmModel.currentEntry;
            if (previousEntry) {
                this.drafts.set(previous.repo.rootUri.toString(), {
                    changeId: previousEntry.change_id,
                    description: previous.scmModel.snapshot?.description ?? '',
                    value: previous.inputBoxValue,
                });
            }
            this.current = this.mount(repo, model, name);
            mounted = true;
            this.selectedName = name;
            await this.current.ready;
            const draft = this.drafts.get(repo.rootUri.toString());
            if (draft && draft.changeId === model.currentEntry?.change_id && draft.value !== draft.description) {
                this.current.sourceControl.inputBox.value = draft.value;
            }
            await this.manager.workspaceState.update(this.storageKey, name);
        } finally {
            if (!mounted) {
                model.dispose();
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.drafts.clear();
    }
}
