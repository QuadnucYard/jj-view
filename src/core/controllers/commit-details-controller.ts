/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoalescingQueue } from '../../utils/coalescing-queue';
import { toError } from '../../utils/error-utils';
import type { LoggerChannel } from '../../utils/output-channel';
import { type Disposable, type Event, EventEmitter } from '../host/events';
import type { HostEnvironment } from '../host/host-environment';
import {
    type CommitDetailsHostToWebviewMessage,
    type CommitDetailsPayload,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../host/ipc/commit-details-schemas';
import { showJjError } from '../host/ui-helpers';
import {
    createWebviewRpcReceiver,
    type WebviewPostMessageLike,
    type WebviewRpcReceiver,
} from '../host/webview-rpc-dispatcher';
import type { JjRepository } from '../jj-repository';
import { StaleWorkspaceError } from '../jj-service';
import type { JjLogEntry, JjStatusEntry } from '../jj-types';

export interface CommitDetailsControllerOptions {
    logger?: LoggerChannel;
    onEditRecorded?: (edit: { undo: () => void; redo: () => void; label: string }) => void;
    openDiff?: (payload: {
        file: JjStatusEntry;
        changeId: string;
        isImmutable?: boolean;
        isWorkingCopy?: boolean;
    }) => Promise<void> | void;
}

export class CommitDetailsController implements Disposable {
    private _disposed = false;
    private readonly _disposables: Disposable[] = [];
    private readonly _loadQueue: CoalescingQueue;
    private readonly _refreshQueue: CoalescingQueue;
    private readonly _lifetime = new AbortController();
    private readonly _logger?: LoggerChannel;
    private readonly _receiver: WebviewRpcReceiver<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>;

    private _logEntry?: JjLogEntry;
    private _changes?: readonly JjStatusEntry[];
    private readonly _pendingLineCounts = new Map<string, Promise<void>>();
    private _loadId = 0;
    private _draftDescription?: string;
    private _persistedDescription?: string;

    private _lastPushedText = '';
    private _lastPushedSelection = { start: 0, end: 0 };
    private _debounceTimer?: NodeJS.Timeout;
    private _pendingUpdate?: { newText: string; newSelection: { start: number; end: number } };
    private _currentSavePromise?: Promise<boolean>;
    private _nextSavePromise?: Promise<boolean>;

    private readonly _onDidUpdate = new EventEmitter<JjLogEntry>();
    public readonly onDidUpdate: Event<JjLogEntry> = this._onDidUpdate.event;

    private readonly _onDidClose = new EventEmitter<string>();
    public readonly onDidClose: Event<string> = this._onDidClose.event;

    constructor(
        public readonly changeId: string,
        public readonly repo: JjRepository | undefined,
        private readonly _host: HostEnvironment,
        private readonly _options?: CommitDetailsControllerOptions,
    ) {
        this._logger = _options?.logger;
        this._receiver = this._createRpcReceiver();
        this._loadQueue = new CoalescingQueue(async () => {
            await this._doLoad();
        });
        this._refreshQueue = new CoalescingQueue(async () => {
            await this._refreshDetails();
        });
    }

    public get isDisposed(): boolean {
        return this._disposed;
    }

    public get logEntry(): JjLogEntry | undefined {
        return this._logEntry;
    }

    public get changes(): readonly JjStatusEntry[] | undefined {
        return this._changes;
    }

    public get draftDescription(): string {
        return this._draftDescription ?? this._logEntry?.description ?? '';
    }

    public get persistedDescription(): string | undefined {
        return this._persistedDescription;
    }

    public async getInitialPayload(): Promise<CommitDetailsPayload | undefined> {
        if (!this.repo || this._disposed) {
            return undefined;
        }
        if (this._logEntry || this._loadQueue.currentRun) {
            return this.getState();
        }
        try {
            const originalLoadId = this._loadId;
            const log = await this.repo.jj.getLogEntry(this.changeId);
            if (this._disposed) {
                return undefined;
            }
            if (this._logEntry || this._loadId !== originalLoadId) {
                return this.getState();
            }
            if (!log) {
                return undefined;
            }
            this._setLogEntry(log);
            return this.getState();
        } catch (err) {
            this._logger?.debug?.(
                `[CommitDetailsController] Failed to get initial payload for ${this.changeId}: ${String(err)}`,
            );
            return undefined;
        }
    }

    public revert(): void {
        this.flushDebounce();
        this._draftDescription = this._persistedDescription;
        this._lastPushedText = this._persistedDescription ?? '';
        this._lastPushedSelection = { start: 0, end: 0 };
        const state = this.getState();
        if (state) {
            this._receiver.sender.update(state);
            this._receiver.sender.updateDescription({
                description: this._draftDescription ?? '',
                selectionStart: 0,
                selectionEnd: 0,
            });
        }
    }

    public getState(): CommitDetailsPayload | undefined {
        if (!this._logEntry) {
            return undefined;
        }
        return {
            changeId: this.changeId,
            changeIdShortest: this._logEntry.change_id_shortest,
            isDivergent: this._logEntry.is_divergent,
            changeIdOffset: this._logEntry.change_id_offset,
            commitId: this._logEntry.commit_id,
            description: (this._persistedDescription ?? this._logEntry.description ?? '').trim(),
            files: this._changes ? [...this._changes] : [],
            isImmutable: this._logEntry.is_immutable,
            author: this._logEntry.author,
            committer: this._logEntry.committer,
            bookmarks: this._logEntry.bookmarks || [],
            tags: this._logEntry.tags || [],
            isEmpty: this._logEntry.is_empty,
            isConflict: this._logEntry.conflict,
            minChangeIdLength: this._host.config.get<number>('minChangeIdLength', 1),
            theme: this._host.config.get<string>('logTheme', 'default'),
            titleWidthRuler: this._host.config.get<number | undefined>('commit.titleWidthRuler'),
            bodyWidthRuler: this._host.config.get<number | undefined>('commit.bodyWidthRuler'),
            formatDescriptionOnSave: this._host.config.get<boolean>('commit.formatDescriptionOnSave', false),
            isLoadingFiles: this._changes === undefined,
        };
    }

    public addMessenger(messenger: WebviewPostMessageLike): Disposable {
        const sub = this._receiver.addMessenger(messenger);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                sub.dispose();
                if (!this._receiver.hasMessengers) {
                    this._onDidClose.fire(this.changeId);
                }
            },
        };
    }

    public async handleMessage(rawMessage: unknown): Promise<boolean> {
        if (this._disposed) {
            return false;
        }
        return this._receiver.dispatch(rawMessage);
    }

    public async load(): Promise<JjLogEntry | undefined> {
        if (!this.repo || this._disposed) {
            return undefined;
        }

        await this._loadQueue.run();
        await this._waitForLineCounts();
        return this._logEntry;
    }

    public async open(): Promise<JjLogEntry | undefined> {
        if (this._host.config.get<boolean>('commit.refreshOnOpen', true)) {
            await this.refresh();
            return this._logEntry;
        }
        return this.load();
    }

    public async refresh(): Promise<void> {
        await this._refreshQueue.run();
    }

    private async _refreshDetails(): Promise<void> {
        const repo = this.repo;
        if (!repo || this._disposed) {
            return;
        }

        let snapshotted = false;
        const { signal } = this._lifetime;
        try {
            const logs = await repo.jj.getLog({ revision: this.changeId, omitChanges: true, skipLogEntryCache: true });
            if (this._disposed) {
                return;
            }
            // JJ can omit workspace labels when there is only one workspace.
            if (logs.some((log) => log.is_current_working_copy && !log.working_copies?.length)) {
                snapshotted = await repo.jj.snapshotWorkspace(undefined, signal);
            }
            for (const workspace of new Set(logs.flatMap((log) => log.working_copies ?? []))) {
                if (this._disposed) {
                    break;
                }
                const completed = await repo.jj.snapshotWorkspace(workspace, signal);
                snapshotted ||= completed;
            }
        } catch (err) {
            this._reportRefreshError(err);
        }

        try {
            await this._loadQueue.run();
        } finally {
            // Publish the snapshot to other views after sending the file rows.
            // A completed snapshot still needs publishing if the editor closed.
            if (snapshotted) {
                try {
                    await repo.refresh({ reason: 'commit details refresh' });
                } catch (err) {
                    this._reportRefreshError(err);
                }
            }
        }
        await this._waitForLineCounts();
    }

    private _reportRefreshError(err: unknown): void {
        if (!this.repo || this._disposed) {
            return;
        }
        // Load cached details while the notification waits for a response.
        const error =
            err instanceof StaleWorkspaceError
                ? new StaleWorkspaceError(err.message, async () => {
                      await err.updateWorkspace();
                      await this.load();
                  })
                : err;
        void showJjError(this._host.ui, error, 'Failed to refresh change details', this.repo.jj, this._logger).catch(
            (notificationError) => {
                this._logger?.error('Failed to report commit details refresh error', toError(notificationError));
            },
        );
    }

    private async _waitForLineCounts(): Promise<void> {
        if (this._logEntry) {
            await this._pendingLineCounts.get(this._logEntry.commit_id);
        }
    }

    private async _doLoad(): Promise<void> {
        const repo = this.repo;
        if (!repo || this._disposed) {
            return;
        }

        const start = performance.now();
        this._loadId++;

        let log: JjLogEntry | undefined;
        try {
            log = await repo.jj.getCommitDetails(this.changeId);
        } catch (err) {
            if (this._disposed) {
                return;
            }
            this._logEntry = undefined;
            this._changes = undefined;
            this._logger?.info?.(
                `[CommitDetailsController] Commit ${this.changeId} not found or failed to load: ${toError(err).message}`,
            );
            this._onDidClose.fire(this.changeId);
            return;
        }

        if (this._disposed) {
            return;
        }

        if (!log) {
            this._logEntry = undefined;
            this._changes = undefined;
            this._logger?.info?.(`[CommitDetailsController] Commit ${this.changeId} not found/deleted`);
            this._onDidClose.fire(this.changeId);
            return;
        }

        this._setLogEntry(log);
        this._onDidUpdate.fire(log);

        const initialState = this.getState();
        if (initialState) {
            this._receiver.sender.update(initialState);
        }

        const changes = this._changes ?? [];
        const duration = performance.now() - start;
        this._logger?.info?.(`[timing] [CommitDetails] files took ${duration.toFixed(0)}ms (${changes.length} files)`);
        const commitId = log.commit_id;
        if (
            this._disposed ||
            this._pendingLineCounts.has(commitId) ||
            changes.every((file) => file.additions !== undefined && file.deletions !== undefined)
        ) {
            return;
        }
        const counts = this._loadLineCounts(repo, commitId, changes).finally(() => {
            this._pendingLineCounts.delete(commitId);
        });
        this._pendingLineCounts.set(commitId, counts);
    }

    private async _loadLineCounts(
        repo: JjRepository,
        commitId: string,
        changes: readonly JjStatusEntry[],
    ): Promise<void> {
        const statsStart = performance.now();
        try {
            const stats = await repo.jj.getChangeStats(commitId);
            if (this._disposed || this._logEntry?.commit_id !== commitId) {
                return;
            }

            this._changes = changes.map((file) => {
                const stat = stats.get(file.path);
                return { ...file, additions: stat?.additions ?? 0, deletions: stat?.deletions ?? 0 };
            });

            const finalState = this.getState();
            if (finalState) {
                this._receiver.sender.update(finalState);
            }

            const duration = performance.now() - statsStart;
            this._logger?.info?.(
                `[timing] [CommitDetails] line counts took ${duration.toFixed(0)}ms (${changes.length} files)`,
            );
        } catch (err) {
            this._logger?.error(
                `[CommitDetailsController] Failed to load line counts for ${this.changeId}`,
                toError(err),
            );
        }
    }

    private _setLogEntry(log: JjLogEntry): void {
        if (this._logEntry?.commit_id !== log.commit_id || this._changes === undefined) {
            this._changes = log.changes;
        }
        this._logEntry = log;
        const wasDirty = this._draftDescription !== undefined && this._draftDescription !== this._persistedDescription;
        this._persistedDescription = log.description.trim();
        if (!wasDirty) {
            this._draftDescription = this._persistedDescription;
            this._lastPushedText = this._persistedDescription;
        }
    }

    public updateDraft(newText: string, selection: { start: number; end: number } = { start: 0, end: 0 }): void {
        if (this._disposed) {
            return;
        }
        this._draftDescription = newText;

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._pendingUpdate = { newText, newSelection: selection };
        this._debounceTimer = setTimeout(() => {
            this.flushDebounce();
        }, 200);
    }

    public flushDebounce(): void {
        if (!this._pendingUpdate) {
            return;
        }

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }

        const { newText, newSelection } = this._pendingUpdate;
        this._pendingUpdate = undefined;

        if (newText === this._lastPushedText) {
            return;
        }

        const oldText = this._lastPushedText;
        const oldSelection = this._lastPushedSelection;

        this._options?.onEditRecorded?.({
            label: 'Edit Description',
            undo: () => {
                this.applyUndoRedo(oldText, oldSelection);
            },
            redo: () => {
                this.applyUndoRedo(newText, newSelection);
            },
        });

        this._lastPushedText = newText;
        this._lastPushedSelection = newSelection;

        if (newText === this._persistedDescription) {
            this._host.commands.executeCommand('workbench.action.files.save');
        }
    }

    public applyUndoRedo(text: string, selection: { start: number; end: number }): void {
        if (this._disposed) {
            return;
        }
        this.flushDebounce();
        this._lastPushedText = text;
        this._lastPushedSelection = selection;
        this._draftDescription = text;

        this._receiver.sender.updateDescription({
            description: text,
            selectionStart: selection.start,
            selectionEnd: selection.end,
        });
    }

    public async save(finalDescription?: string): Promise<boolean> {
        if (this._disposed || !this._logEntry) {
            return false;
        }

        if (finalDescription !== undefined) {
            this._draftDescription = finalDescription;
        }

        if (this._currentSavePromise) {
            if (!this._nextSavePromise) {
                this._nextSavePromise = this._currentSavePromise
                    .catch(() => false)
                    .then(async () => {
                        this._nextSavePromise = undefined;
                        return this._executeSave();
                    });
            }
            return this._nextSavePromise;
        }

        this._currentSavePromise = this._executeSave().finally(() => {
            this._currentSavePromise = undefined;
        });
        return this._currentSavePromise;
    }

    private async _executeSave(): Promise<boolean> {
        if (this._disposed || !this._logEntry) {
            return false;
        }
        this.flushDebounce();

        const descriptionToSave = this._draftDescription ?? this._logEntry?.description ?? '';
        const isSoftSave = descriptionToSave === this._persistedDescription;
        try {
            let savedDescription = descriptionToSave;
            if (!isSoftSave) {
                const res = await this._host.commands.executeCommand(
                    'jj-view.setDescription',
                    descriptionToSave,
                    this.changeId,
                );
                if (typeof res === 'string') {
                    savedDescription = res;
                } else if (res === false) {
                    this._receiver.sender.saveFailed();
                    return false;
                } else if (this.repo) {
                    await this.repo.jj.describe(descriptionToSave, this.changeId);
                    await this._host.commands.executeCommand('jj-view.refresh');
                }
            }

            if (this._logEntry) {
                this._logEntry = {
                    ...this._logEntry,
                    description: savedDescription,
                };
            }

            const hadConcurrentEdits = this._draftDescription !== descriptionToSave;

            if (!hadConcurrentEdits) {
                this._draftDescription = savedDescription;
                this._lastPushedText = savedDescription;
            }
            this._persistedDescription = savedDescription;

            this._receiver.sender.saveComplete({
                description: savedDescription,
                savedDraft: descriptionToSave,
            });

            if (hadConcurrentEdits) {
                this.flushDebounce();
                const currentDraft = this._draftDescription ?? '';
                const currentSelection = this._lastPushedSelection;
                queueMicrotask(() => {
                    if (this._disposed || this._draftDescription === this._persistedDescription) {
                        return;
                    }
                    this._options?.onEditRecorded?.({
                        label: 'Edit Description',
                        undo: () => {
                            this.applyUndoRedo(savedDescription, { start: 0, end: 0 });
                        },
                        redo: () => {
                            this.applyUndoRedo(currentDraft, currentSelection);
                        },
                    });
                });
            }

            return true;
        } catch (err) {
            this._logger?.error(`[CommitDetailsController] Failed to save commit ${this.changeId}`, toError(err));
            this._receiver.sender.saveFailed();
            await showJjError(this._host.ui, err, 'Failed to save commit description', this.repo?.jj, this._logger);
            return false;
        }
    }

    private _createRpcReceiver(): WebviewRpcReceiver<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage> {
        return createWebviewRpcReceiver<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>(
            CommitDetailsToHostMessageSchema,
            {
                refresh: () => this.refresh(),
                descriptionChanged: async (payload) => {
                    const newText = payload.description;
                    const newSelection = {
                        start: payload.selectionStart ?? 0,
                        end: payload.selectionEnd ?? 0,
                    };
                    this.updateDraft(newText, newSelection);
                },
                saveDescription: async (payload) => {
                    const newText = payload.description;
                    this._draftDescription = newText;
                    this.flushDebounce();
                    await this._host.commands.executeCommand('workbench.action.files.save');
                },
                openDiff: async (payload) => {
                    const { file, changeId, isImmutable } = payload;
                    if (this._options?.openDiff) {
                        await this._options.openDiff({
                            file,
                            changeId,
                            isImmutable,
                            isWorkingCopy: this._logEntry?.is_current_working_copy,
                        });
                    }
                },
                openMultiDiff: async (payload) => {
                    await this._host.commands.executeCommand('jj-view.showMultiFileDiff', payload.changeId);
                },
            },
            {
                logger: this._logger,
                getState: () => this.getState(),
            },
        );
    }

    public dispose(): void {
        this._disposed = true;
        this._lifetime.abort();
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._onDidUpdate.dispose();
        this._onDidClose.dispose();
        this._receiver.dispose();
    }
}
