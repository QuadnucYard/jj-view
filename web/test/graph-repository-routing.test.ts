/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CodeForgeRegistry } from '../../src/core/code-forge-registry';
import { LogViewController } from '../../src/core/controllers/log-view-controller';
import type { JjRepository } from '../../src/core/jj-repository';
import { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import { ScmModel } from '../../src/core/scm-model';
import { Uri } from '../../src/core/uri-utils';
import { FakeHostEnvironment } from '../../src/test/fake-host-environment';
import { TestRepo } from '../../src/test/test-repo';
import { createMockLogOutputChannel } from '../../src/test/test-utils';
import { registerWebCommands } from '../src/commands/register-web-commands';

describe('Graph repository command routing', () => {
    let roots: TestRepo[];
    let host: FakeHostEnvironment;
    let manager: JjRepositoryManager;
    let first: JjRepository;
    let second: JjRepository;
    beforeEach(async () => {
        roots = [new TestRepo(), new TestRepo()];
        host = new FakeHostEnvironment();
        for (const root of roots) {
            root.init();
            host.workspace.addFolder(Uri.file(root.path));
        }
        manager = new JjRepositoryManager(new CodeForgeRegistry(), createMockLogOutputChannel(), host);
        await manager.scanForRepositories();
        [first, second] = manager.repositories;
    });
    afterEach(async () => {
        await manager.dispose();
        for (const root of roots) {
            await root.dispose();
        }
    });
    test('routes graph mutations to the displayed repo and SCM mutations to their own repo', async () => {
        const logger = createMockLogOutputChannel();
        const scm = new ScmModel(second, logger);
        const controller = new LogViewController(first, host, { repositoryManager: manager });
        registerWebCommands({
            repositoryManager: manager,
            hostEnvironment: host,
            logger,
            scmModel: scm,
            logViewController: controller,
        });
        try {
            await manager.setRepositoryIncluded(second, false);
            host.documents.setActiveDocument(Uri.file(`${second.rootUri.fsPath}/file.txt`));
            const initialFirst = roots[0].getChangeId('@');
            const initialSecond = roots[1].getChangeId('@');
            await controller.handleMessage({ type: 'new' });
            expect(roots[0].getChangeId('@')).not.toBe(initialFirst);
            expect(roots[1].getChangeId('@')).toBe(initialSecond);
            await host.commands.executeCommand('jj-view.new');
            expect(roots[1].getChangeId('@')).not.toBe(initialSecond);
            expect(manager.focusedRepository).toBe(first);
            expect(manager.isRepositoryIncluded(second)).toBe(false);
            // Native context-menu commands carry the same scope through DOM context.
            const secondBeforeMenu = roots[1].getChangeId('@');
            const firstBeforeMenu = roots[0].getChangeId('@');
            await host.commands.executeCommand('jj-view.new', { graphRepositoryPath: first.rootUri.fsPath });
            expect(roots[0].getChangeId('@')).not.toBe(firstBeforeMenu);
            expect(roots[1].getChangeId('@')).toBe(secondBeforeMenu);
            await host.commands.executeCommand('jj-view.graph.undo');
            expect(roots[0].getChangeId('@')).toBe(firstBeforeMenu);
            expect(roots[1].getChangeId('@')).toBe(secondBeforeMenu);
            controller.setSelectedCommits([roots[0].getChangeId('@-')]);
            scm.handleSelectionChange([secondBeforeMenu]);
            await host.commands.executeCommand('jj-view.graph.abandon');
            // Abandoning the selected ancestor preserves the working-copy change ID.
            expect(roots[0].getChangeId('@')).toBe(firstBeforeMenu);
            expect(roots[1].getChangeId('@')).toBe(secondBeforeMenu);
            expect(host.ui.errorMessages).toEqual([]);
            await manager.setRepositoryIncluded(second, true);
            await manager.closeRepository(first.rootUri);
            await host.commands.executeCommand('jj-view.new', { graphRepositoryRoot: first.rootUri });
            expect(roots[1].getChangeId('@')).toBe(secondBeforeMenu);
            expect(host.ui.errorMessages.at(-1)).toContain('No active repository');
        } finally {
            controller.dispose();
            scm.dispose();
        }
    });
});
