/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { LogViewController } from '../core/controllers/log-view-controller';
import type { JjRepository } from '../core/jj-repository';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('Graph repository focus', () => {
    let roots: TestRepo[];
    let host: FakeHostEnvironment;
    let manager: JjRepositoryManager;
    let first: JjRepository;
    let second: JjRepository;

    beforeEach(async () => {
        roots = [new TestRepo(), new TestRepo(), new TestRepo()];
        host = new FakeHostEnvironment();
        for (const root of roots) {
            root.init();
            host.workspace.addFolder(Uri.file(root.path));
        }
        manager = new JjRepositoryManager(new CodeForgeRegistry(), createMockLogOutputChannel(), host);
        const one = await manager.maybeRegisterRepositoryContainingUri(Uri.file(roots[0].path));
        const two = await manager.maybeRegisterRepositoryContainingUri(Uri.file(roots[1].path));
        if (!one || !two) {
            throw new Error('Expected repositories');
        }
        first = one;
        second = two;
        manager.setFocusedRepository(first);
    });

    afterEach(async () => {
        await manager.dispose();
        for (const root of roots) {
            await root.dispose();
        }
    });

    test('keeps graph focus by default and follows only included repositories when enabled', async () => {
        const secondFile = Uri.file(`${second.rootUri.fsPath}/file.txt`);
        host.documents.setActiveDocument(secondFile);
        await Promise.resolve();
        expect(manager.followEditor).toBe(false);
        expect(manager.focusedRepository).toBe(first);
        await manager.setFollowEditor(true);
        // Enabling follow does not immediately move the graph.
        expect(manager.focusedRepository).toBe(first);
        host.documents.setActiveDocument(secondFile);
        await vi.waitFor(() => expect(manager.focusedRepository).toBe(second));
        await manager.setRepositoryIncluded(first, false);
        host.documents.setActiveDocument(Uri.file(`${first.rootUri.fsPath}/file.txt`));
        await Promise.resolve();
        expect(manager.focusedRepository).toBe(second);
        expect(manager.getRepositoryForUri(Uri.file(`${first.rootUri.fsPath}/file.txt`))).toBe(first);
        expect(manager.tryAutoSwitch(Uri.parse('untitled:example'))).toBe(false);
    });

    test('uses recent included focus, permits an empty scope, and reveals only on explicit navigation', async () => {
        const third = await manager.maybeRegisterRepositoryContainingUri(Uri.file(roots[2].path));
        if (!third) {
            throw new Error('Expected third repository');
        }
        manager.setFocusedRepository(second);
        manager.setFocusedRepository(third);
        await manager.setRepositoryIncluded(third, false);
        expect(manager.focusedRepository).toBe(second);
        await manager.setRepositoryIncluded(second, false);
        expect(manager.focusedRepository).toBe(first);
        await manager.setRepositoryIncluded(first, false);
        expect(manager.focusedRepository).toBeUndefined();
        await manager.scanForRepositories();
        expect(manager.focusedRepository).toBeUndefined();
        await manager.showRepository(second);
        expect(manager.isRepositoryIncluded(second)).toBe(true);
        expect(manager.focusedRepository).toBe(second);
        await manager.setRepositoryIncluded(first, true);
        expect(manager.focusedRepository).toBe(second);
        expect(manager.isRepositoryIncluded(third)).toBe(false);
    });

    test('restores workspace focus and scope without following an already open editor', async () => {
        manager.setFocusedRepository(second);
        await manager.setRepositoryIncluded(first, false);
        await manager.setFollowEditor(true);
        await manager.dispose();
        host.documents.setActiveDocument(Uri.file(`${first.rootUri.fsPath}/file.txt`));
        host.documents.openDocumentUris = [Uri.file(`${first.rootUri.fsPath}/file.txt`)];
        manager = new JjRepositoryManager(new CodeForgeRegistry(), createMockLogOutputChannel(), host);
        await manager.restoreCachedRepositories();
        await manager.scanForRepositories();
        expect(manager.followEditor).toBe(true);
        expect(manager.focusedRepository?.rootUri.fsPath).toBeSameFsPath(second.rootUri.fsPath);
        const restoredFirst = manager.getRepositoryForUri(first.rootUri);
        expect(restoredFirst && manager.isRepositoryIncluded(restoredFirst)).toBe(false);
    });

    test('discovers an editor repository without stealing focus or extending an explicit scope', async () => {
        await manager.setRepositoryIncluded(second, false);
        await manager.setFollowEditor(true);
        host.documents.setActiveDocument(Uri.file(`${roots[2].path}/new-file.txt`));
        await vi.waitFor(() => expect(manager.repositories).toHaveLength(3));
        const discovered = manager.getRepositoryForUri(Uri.file(roots[2].path));
        expect(manager.focusedRepository).toBe(first);
        expect(discovered && manager.isRepositoryIncluded(discovered)).toBe(false);
    });

    test('rejects stale editor events before a deferred follow decision runs', async () => {
        await manager.setFollowEditor(true);
        host.documents.setActiveDocument(Uri.file(`${second.rootUri.fsPath}/file.txt`));
        host.documents.setActiveDocument(Uri.file(`${first.rootUri.fsPath}/file.txt`));
        await Promise.resolve();
        expect(manager.focusedRepository).toBe(first);
        await manager.closeRepository(first.rootUri);
        expect(manager.focusedRepository).toBe(second);
    });

    test('restores graph selections for each repo without retaining another repos commits during loading', async () => {
        const controller = new LogViewController(first, host, { repositoryManager: manager });
        try {
            await controller.refresh();
            const selected = roots[0].getChangeId('@');
            controller.setSelectedCommits([selected]);
            await manager.showRepository(second);
            expect(controller.repository).toBe(second);
            expect(controller.commits).toEqual([]);
            expect(controller.selectedCommitIds).toEqual([]);
            await controller.refresh();
            const secondSelection = roots[1].getChangeId('@');
            controller.setSelectedCommits([secondSelection]);
            await manager.showRepository(first);
            await controller.refresh();
            expect(controller.selectedCommitIds).toEqual([selected]);
            await manager.showRepository(second);
            await controller.refresh();
            expect(controller.selectedCommitIds).toEqual([secondSelection]);
        } finally {
            controller.dispose();
        }
    });
});
