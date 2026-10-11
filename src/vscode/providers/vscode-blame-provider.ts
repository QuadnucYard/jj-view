/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import {
    type JjAnnotation,
    type JjFileBlame,
    MAX_BLAME_BYTES,
    MAX_BLAME_LINES,
    mapBlameLines,
} from '../../core/jj-blame';
import type { JjRepository } from '../../core/jj-repository';
import type { JjRepositoryManager } from '../../core/jj-repository-manager';
import { decodeJjViewQuery, getFsPathFromUri, getRevisionFromUri } from '../../core/uri-utils';
import { AsyncCache } from '../../utils/async-cache';
import { GitBlameCoexistence, preferJjBlame, restoreGitBlame } from '../git-blame-coexistence';

interface BlameSnapshot {
    blame: JjFileBlame;
    workingCopyCommitId?: string;
}

function relativeDate(timestamp: string): string {
    const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
    if (!Number.isFinite(seconds)) {
        return 'unknown date';
    }
    for (const [size, unit] of [
        [31536000, 'year'],
        [2592000, 'month'],
        [86400, 'day'],
        [3600, 'hour'],
        [60, 'minute'],
    ] as const) {
        if (seconds >= size) {
            const count = Math.floor(seconds / size);
            return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
        }
    }
    return 'just now';
}

export class VsCodeBlameProvider implements vscode.Disposable {
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        after: { color: new vscode.ThemeColor('editorInlayHint.foreground'), margin: '0 0 0 3em' },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly repositorySubscriptions = new Map<JjRepository, vscode.Disposable>();
    private readonly snapshots = new AsyncCache<string, BlameSnapshot | undefined>({ maxEntries: 20 });
    private readonly git: GitBlameCoexistence;
    private generation = 0;
    private request = 0;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private mapping:
        | { document: vscode.TextDocument; version: number; snapshot: BlameSnapshot; lines: Map<number, number> }
        | undefined;

    constructor(
        private readonly manager: JjRepositoryManager,
        context: vscode.ExtensionContext,
    ) {
        this.git = new GitBlameCoexistence(() => this.schedule());
        this.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.window.onDidChangeTextEditorSelection((event) => {
                if (event.textEditor === vscode.window.activeTextEditor) {
                    this.schedule();
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document === vscode.window.activeTextEditor?.document) {
                    this.schedule(200);
                }
            }),
            vscode.workspace.onDidCloseTextDocument(() => this.invalidate()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('jj-view.blame') || event.affectsConfiguration('git')) {
                    this.schedule();
                }
            }),
            manager.onDidOpenRepository((repo) => {
                this.track(repo);
                this.invalidate();
            }),
            manager.onDidCloseRepository((repo) => {
                this.repositorySubscriptions.get(repo)?.dispose();
                this.repositorySubscriptions.delete(repo);
                this.invalidate();
            }),
            vscode.commands.registerCommand('jj-view.toggleLineBlame', async () => {
                const config = vscode.workspace.getConfiguration(
                    'jj-view',
                    vscode.window.activeTextEditor?.document.uri,
                );
                const target =
                    config.inspect<boolean>('blame.enabled')?.workspaceFolderValue !== undefined
                        ? vscode.ConfigurationTarget.WorkspaceFolder
                        : vscode.workspace.workspaceFolders?.length
                          ? vscode.ConfigurationTarget.Workspace
                          : vscode.ConfigurationTarget.Global;
                await config.update('blame.enabled', !config.get<boolean>('blame.enabled', true), target);
            }),
            vscode.commands.registerCommand('jj-view.preferJjBlame', () => preferJjBlame(context.workspaceState)),
            vscode.commands.registerCommand('jj-view.restoreGitBlame', () => restoreGitBlame(context.workspaceState)),
            vscode.commands.registerCommand('jj-view.openBlameCommit', async (root: unknown, commit: unknown) => {
                if (typeof root !== 'string' || typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) {
                    return;
                }
                const repo = manager.repositories.find((repo) => repo.rootUri.fsPath === root);
                if (!repo) {
                    return;
                }
                const entry = await repo.jj.getLogEntry(commit);
                if (entry) {
                    await repo.host.nav.openCommitDetails(
                        repo.rootUri,
                        entry.change_id,
                        entry.change_id_shortest,
                        entry.is_divergent,
                        entry.change_id_offset,
                    );
                }
            }),
        );
        manager.repositories.forEach((repo) => {
            this.track(repo);
        });
        this.schedule();
    }

    private track(repo: JjRepository): void {
        if (!this.repositorySubscriptions.has(repo)) {
            this.repositorySubscriptions.set(
                repo,
                repo.onDidStatusChange(() => this.invalidate()),
            );
        }
    }

    private invalidate(): void {
        this.generation++;
        void this.snapshots.clear();
        this.mapping = undefined;
        this.schedule();
    }

    private clearDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.decoration, []);
        }
    }

    private schedule(delay = 0): void {
        if (this.disposed) {
            return;
        }
        this.request++;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.clearDecorations();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().catch((error: unknown) => {
                this.manager.outputChannel.debug(`[Blame] ${String(error)}`);
            });
        }, delay);
    }

    private async loadSnapshot(repo: JjRepository, uri: vscode.Uri): Promise<BlameSnapshot | undefined> {
        let revision = uri.scheme === 'file' ? '@' : (getRevisionFromUri(uri) ?? '@');
        if (uri.scheme === 'jj-view') {
            const query = decodeJjViewQuery(uri);
            if (query.mode === 'diff') {
                revision = query.base;
                if (query.side === 'left') {
                    const entry = await repo.jj.getLogEntry(query.base);
                    // The merge-parent tree is synthetic and has no single blame revision.
                    if (entry?.parents.length !== 1) {
                        return undefined;
                    }
                    revision = entry.parents[0].commit_id;
                }
            } else {
                revision = query.revision;
            }
        }
        const [blame, workingCopy] = await Promise.all([
            repo.jj.getFileBlame(getFsPathFromUri(uri), revision),
            repo.jj.getLogEntry('@'),
        ]);
        return blame ? { blame, workingCopyCommitId: workingCopy?.commit_id } : undefined;
    }

    /** Allows extension-host tests to await a complete annotation update. */
    async refresh(): Promise<void> {
        const request = this.request;
        const editor = vscode.window.activeTextEditor;
        if (!editor || this.disposed) {
            return;
        }
        const document = editor.document;
        const uri = document.uri;
        const version = document.version;
        const line = editor.selection.active.line;
        if (
            !['file', 'jj-edit', 'jj-view'].includes(uri.scheme) ||
            !vscode.workspace.getConfiguration('jj-view', uri).get<boolean>('blame.enabled', true) ||
            this.git.hasInlineBlame(uri) ||
            document.lineCount > MAX_BLAME_LINES
        ) {
            editor.setDecorations(this.decoration, []);
            return;
        }
        const text = document.getText();
        if (!text || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_BLAME_BYTES) {
            return;
        }
        const repo = this.manager.getRepositoryForUri(uri);
        if (!repo) {
            return;
        }
        const snapshot = await this.snapshots.getOrFetch(
            JSON.stringify([this.generation, repo.rootUri.toString(), uri.toString()]),
            () =>
                this.loadSnapshot(repo, uri).catch((error: unknown) => {
                    this.manager.outputChannel.debug(`[Blame] ${String(error)}`);
                    return undefined;
                }),
        );
        if (
            !snapshot ||
            this.disposed ||
            this.request !== request ||
            document.version !== version ||
            vscode.window.activeTextEditor !== editor ||
            editor.selection.active.line !== line ||
            this.git.hasInlineBlame(uri)
        ) {
            return;
        }
        if (
            this.mapping?.document !== document ||
            this.mapping.version !== version ||
            this.mapping.snapshot !== snapshot
        ) {
            this.mapping = { document, version, snapshot, lines: mapBlameLines(snapshot.blame.content, text) };
        }
        const sourceLine = this.mapping.lines.get(line);
        const annotation = sourceLine === undefined ? undefined : snapshot.blame.annotations[sourceLine];
        // The empty editor line after a final newline has no source annotation.
        if (line === document.lineCount - 1 && document.lineAt(line).text === '' && text.endsWith('\n')) {
            return;
        }
        const workingCopy = annotation?.commitId === snapshot.workingCopyCommitId;
        const contentText = annotation
            ? workingCopy
                ? `Working copy · ${annotation.changeId.slice(0, 8)}`
                : `${annotation.author || annotation.email || 'Unknown author'}, ${relativeDate(annotation.timestamp)} · ${annotation.description.split('\n')[0] || '(no description)'}`
            : document.isDirty
              ? 'Unsaved changes'
              : 'Working copy changes';
        const position = document.lineAt(line).range.end;
        editor.setDecorations(this.decoration, [
            {
                range: new vscode.Range(position, position),
                renderOptions: { after: { contentText: contentText.replace(/[\r\n\t]/g, ' ').slice(0, 160) } },
                hoverMessage: annotation ? this.hover(repo, annotation, workingCopy) : undefined,
            },
        ]);
    }

    private hover(repo: JjRepository, annotation: JjAnnotation, workingCopy: boolean): vscode.MarkdownString {
        const hover = new vscode.MarkdownString();
        hover.appendText(
            `${workingCopy ? 'Working copy\n' : ''}${annotation.author} <${annotation.email}>\n${annotation.timestamp}\n\n${annotation.description}\n\nChange: ${annotation.changeId}\nCommit: ${annotation.commitId}`,
        );
        const args = encodeURIComponent(JSON.stringify([repo.rootUri.fsPath, annotation.commitId]));
        hover.appendMarkdown(`\n\n[Open JJ commit details](command:jj-view.openBlameCommit?${args})`);
        hover.isTrusted = { enabledCommands: ['jj-view.openBlameCommit'] };
        return hover;
    }

    dispose(): void {
        this.disposed = true;
        this.request++;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.clearDecorations();
        this.decoration.dispose();
        this.git.dispose();
        this.subscriptions.splice(0).forEach((subscription) => {
            subscription.dispose();
        });
        this.repositorySubscriptions.forEach((subscription) => {
            subscription.dispose();
        });
        this.repositorySubscriptions.clear();
        void this.snapshots.clear();
        this.mapping = undefined;
    }
}
