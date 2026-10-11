/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { buildGraph, TestRepo } from '../test-repo';
import { test } from './e2e-helpers';

for (const scheme of ['file', 'jj-edit']) {
    test(`Diff saves and formatting use the live ${scheme} document`, async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'base', files: { 'save-source.txt': 'base source\n' } },
            { label: 'ancestor', parents: ['base'], files: { 'save-source.txt': 'ancestor source\n' } },
            { label: 'wc', parents: ['ancestor'], files: { 'unrelated.txt': 'working source\n' } },
        ]);
        await vscode.openWorkspace(repo, { 'editor.formatOnSave': true }, {}, false, true);
        const result = await vscode.evaluate(
            async (vscode, api, rootPath, revision, scheme) => {
                if (typeof rootPath !== 'string' || typeof revision !== 'string' || typeof scheme !== 'string') {
                    throw new Error('Expected repository, revision, and scheme');
                }
                await api.repositoryManager.scanForRepositories();
                const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
                const repository = api.repositoryManager.repositories.find(
                    (candidate) => normalize(candidate.rootUri.fsPath) === normalize(rootPath),
                );
                if (!repository) {
                    throw new Error('Repository was not opened');
                }
                api.repositoryManager.setFocusedRepository(repository);
                await repository.refresh({ forceSnapshot: true, reason: 'save-source-setup' });
                const file = vscode.Uri.joinPath(vscode.Uri.file(repository.rootUri.fsPath), 'save-source.txt');
                const root = repository.rootUri.fsPath;
                const base = scheme === 'file' ? '@' : revision;
                const original = file.with({
                    scheme: 'jj-view',
                    fragment: new URLSearchParams({ root, base, side: 'left' }).toString(),
                });
                const target =
                    scheme === 'file'
                        ? file
                        : file.with({
                              scheme: 'jj-edit',
                              fragment: new URLSearchParams({ root, revision }).toString(),
                          });
                await vscode.commands.executeCommand('vscode.diff', original, target, 'Save source regression');
                const document = await vscode.workspace.openTextDocument(target);
                await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
                const formatterSources: string[] = [];
                const formatter = vscode.languages.registerDocumentFormattingEditProvider(
                    { scheme, language: 'plaintext' },
                    {
                        provideDocumentFormattingEdits(doc) {
                            const source = doc.getText();
                            formatterSources.push(source);
                            return [
                                vscode.TextEdit.replace(
                                    new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)),
                                    source.replace(/[ \t]+$/gm, ''),
                                ),
                            ];
                        },
                    },
                );
                const replace = async (source: string) => {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        target,
                        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
                        source,
                    );
                    if (!(await vscode.workspace.applyEdit(edit))) {
                        throw new Error('Editor edit was rejected');
                    }
                };
                const save = async (source: string, format: boolean) => {
                    const fs = repository.jj.system.fs;
                    const readTextFile = fs.readTextFile.bind(fs);
                    const writeTextFile = fs.writeTextFile.bind(fs);
                    let release = () => {};
                    let entered = () => {};
                    const blocked = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    const started = new Promise<void>((resolve) => {
                        entered = resolve;
                    });
                    let backgroundRead: Promise<Uint8Array> | undefined;
                    try {
                        if (scheme === 'jj-edit') {
                            // Hold an old filesystem read until the save reaches the writer.
                            // This is the interval where the queued editor content must win.
                            fs.readTextFile = async (path) => {
                                const content = await readTextFile(path);
                                if (path.replace(/\\/g, '/').endsWith('/right/save-source.txt')) {
                                    // Refresh reads can arrive first; hold every matching read.
                                    entered();
                                    await blocked;
                                }
                                return content;
                            };
                            fs.writeTextFile = async (path, content) => {
                                if (path.includes('jj-batch-edit-')) {
                                    release();
                                }
                                await writeTextFile(path, content);
                            };
                            backgroundRead = Promise.resolve(vscode.workspace.fs.readFile(target));
                            await started;
                        }
                        await replace(source);
                        if (format) {
                            if (!(await document.save())) {
                                throw new Error('Formatted save failed');
                            }
                        } else {
                            await vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
                        }
                        if (backgroundRead) {
                            const actual = new TextDecoder().decode(await backgroundRead);
                            const expected = format ? source.replace(/[ \t]+$/gm, '') : source;
                            if (actual !== expected) {
                                throw new Error(`Overlapping read returned stale source: ${JSON.stringify(actual)}`);
                            }
                        }
                    } finally {
                        release();
                        fs.readTextFile = readTextFile;
                        fs.writeTextFile = writeTextFile;
                        await backgroundRead;
                    }
                };
                try {
                    await save('direct typed source   \n', false);
                    const direct = {
                        editor: document.getText(),
                        persisted: new TextDecoder().decode(await vscode.workspace.fs.readFile(target)),
                    };
                    await repository.refresh({ forceSnapshot: true, reason: 'save-source-refresh' });
                    await save('formatted typed source   \n', true);
                    await repository.refresh({ forceSnapshot: true, reason: 'save-source-final-refresh' });
                    return {
                        direct,
                        formatterSources,
                        formatted: {
                            editor: document.getText(),
                            persisted: new TextDecoder().decode(await vscode.workspace.fs.readFile(target)),
                        },
                    };
                } finally {
                    formatter.dispose();
                }
            },
            repo.path,
            nodes.ancestor.changeId,
            scheme,
        );
        expect(result.direct).toEqual({ editor: 'direct typed source   \n', persisted: 'direct typed source   \n' });
        expect(result.formatterSources).toEqual(['formatted typed source   \n']);
        expect(result.formatted).toEqual({ editor: 'formatted typed source\n', persisted: 'formatted typed source\n' });
        expect(repo.getFileContent(scheme === 'file' ? '@' : nodes.ancestor.changeId, 'save-source.txt')).toBe(
            'formatted typed source\n',
        );
        if (scheme === 'jj-edit') {
            expect(repo.readFile('unrelated.txt')).toBe('working source\n');
            expect(repo.getDiffSummary('@')).not.toContain('save-source.txt');
        }
    });
}
