/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import * as vscode from 'vscode';
import type { JjMergeService } from '../../core/jj-merge-service';
import { getFsPathFromUri, type Uri } from '../../core/uri-utils';
import { getErrorMessage } from '../../utils/error-utils';

/**
 * Publishes merge inputs together and protects unsaved results when their conflict changes.
 */
export class VsCodeMergeContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly contents = new Map<string, string>();
    private readonly warned = new Map<string, string>();
    private readonly pending = new Map<string, { signature: string; publish: () => void; approved: boolean }>();
    private generation = 0;
    private disposed = false;

    constructor(
        public readonly service: JjMergeService,
        private readonly belongsToRepository?: (uri: Uri) => boolean,
    ) {
        this._disposables.push(
            vscode.workspace.onDidCloseTextDocument((document) => {
                this.contents.delete(document.uri.toString());
                this.warned.delete(getFsPathFromUri(document.uri));
                this.pending.delete(getFsPathFromUri(document.uri));
            }),
            this.service.onDidChange((uri) => {
                this._onDidChange.fire(vscode.Uri.parse(uri.toString()));
            }),
        );
    }

    async provideTextDocumentContent(uri: Uri): Promise<string> {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (this.disposed) {
                throw new Error('Merge provider is disposed');
            }
            const generation = this.generation;
            const key = uri.toString();
            const existing = this.contents.get(key);
            if (existing !== undefined) {
                return existing;
            }
            const content = await this.service.provideContent(uri);
            if (generation === this.generation && !this.disposed) {
                this.contents.set(key, content);
                return content;
            }
        }
        throw new Error('Repository changed repeatedly while opening merge inputs');
    }

    /** Refresh open inputs together without replacing unsaved merge results. */
    async refresh(conflictedPaths: readonly string[], root: string): Promise<void> {
        if (this.disposed) {
            return;
        }
        const generation = ++this.generation;
        this.service.clearCache();
        const conflicts = new Set(conflictedPaths.map((file) => path.resolve(root, file)));
        const groups = new Map<string, vscode.TextDocument[]>();
        for (const document of vscode.workspace.textDocuments) {
            if (document.uri.scheme !== 'jj-merge-output') {
                continue;
            }
            const file = getFsPathFromUri(document.uri);
            const relative = path.relative(root, file);
            const belongs =
                this.belongsToRepository?.(document.uri) ??
                (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'));
            if (!belongs) {
                continue;
            }
            const key = document.uri.toString();
            if (!this.contents.has(key)) {
                // The editor can outlive a repository/provider. Preserve what it displays
                // until fresh inputs are ready and dirty-result protection has been checked.
                this.contents.set(key, document.getText());
            }
            const documents = groups.get(file) ?? [];
            documents.push(document);
            groups.set(file, documents);
        }
        const errors: Error[] = [];
        for (const [file, documents] of groups) {
            if (!conflicts.has(path.normalize(file))) {
                // Saving a resolution normally removes the conflict. Its original inputs
                // remain useful in the open merge editor; completion is not invalidation.
                this.pending.delete(file);
                this.warned.delete(file);
                continue;
            }
            let updates: { uri: vscode.Uri; content: string }[];
            try {
                updates = await Promise.all(
                    documents.map(async (document) => ({
                        uri: document.uri,
                        content: await this.service.provideContent(document.uri),
                    })),
                );
            } catch (error: unknown) {
                if (generation !== this.generation) {
                    return;
                }
                errors.push(
                    new Error(`Failed to refresh merge inputs for ${file}: ${getErrorMessage(error)}`, {
                        cause: error,
                    }),
                );
                continue;
            }
            if (generation !== this.generation) {
                return;
            }
            if (
                updates.every(
                    ({ uri, content }) =>
                        this.contents.get(uri.toString())?.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n'),
                )
            ) {
                this.warned.delete(file);
                this.pending.delete(file);
                continue;
            }
            const publish = () => {
                if (generation !== this.generation) {
                    return;
                }
                // Publish the complete capture before VS Code starts rereading any input.
                for (const { uri, content } of updates) {
                    this.contents.set(uri.toString(), content);
                }
                for (const { uri } of updates) {
                    this._onDidChange.fire(uri);
                }
                this.warned.delete(file);
                this.pending.delete(file);
            };
            const result = vscode.workspace.textDocuments.find(
                (document) =>
                    document.uri.scheme === 'file' && path.normalize(document.uri.fsPath) === path.normalize(file),
            );
            if (!result?.isDirty) {
                publish();
                continue;
            }
            const signature = JSON.stringify(updates.map(({ content }) => content));
            const previous = this.pending.get(file);
            const pending = { signature, publish, approved: previous?.signature === signature && previous.approved };
            this.pending.set(file, pending);
            // An action clicked during capture must survive until the current capture is ready.
            if (pending.approved) {
                publish();
                continue;
            }
            if (this.warned.get(file) === signature) {
                continue;
            }
            this.warned.set(file, signature);
            void vscode.window
                .showWarningMessage(
                    `Conflict inputs for ${path.basename(file)} changed. Your unsaved resolution has been preserved.`,
                    'Refresh Merge Inputs',
                )
                .then((action) => {
                    if (action === 'Refresh Merge Inputs') {
                        const pending = this.pending.get(file);
                        if (pending?.signature === signature) {
                            pending.approved = true;
                            pending.publish();
                        }
                    }
                });
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, errors.map((error) => error.message).join('\n'));
        }
    }

    update(uri: Uri): void {
        this.contents.delete(uri.toString());
        this.service.update(uri);
    }

    clearCache(fsPath?: string): void {
        this.generation++;
        this.pending.clear();
        this.warned.clear();
        for (const key of this.contents.keys()) {
            if (!fsPath || path.normalize(getFsPathFromUri(vscode.Uri.parse(key))) === path.normalize(fsPath)) {
                this.contents.delete(key);
            }
        }
        this.service.clearCache(fsPath);
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.contents.clear();
        this.warned.clear();
        this.pending.clear();
        this._onDidChange.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
