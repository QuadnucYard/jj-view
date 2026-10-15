/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ScopedTestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Multirepo Workspace', () => {
    test('keeps graph focus within chosen repositories and restores workspace preferences', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('main.txt', 'main content\n');
        testRepo.describe('main repository work');
        testRepo.new();
        for (let i = 0; i < 18; i++) {
            testRepo.new(undefined, `main history ${i}`);
        }
        using other = new ScopedTestRepo(path.join(testRepo.path, 'other-project'));
        other.init();
        other.writeFile('other.txt', 'other content\n');
        other.describe('other repository work');
        other.new();
        await page.goto(server.serverUrl);
        await waitForScmReady(page);
        const graph = page.locator('[data-testid="log-content"]');
        const picker = graph.getByRole('combobox', { name: 'Graph repository' });
        const follow = graph.getByRole('button', { name: 'Follow Editor' });
        const scope = graph.locator('summary', { hasText: 'Repositories' });
        const otherCheckbox = graph.getByRole('checkbox', { name: /other-project/ });
        await expect(picker.locator('option')).toHaveCount(2);
        const mainPath = await picker.inputValue();
        const otherPath = await page.evaluate(
            () =>
                window.__JJ_VIEW_REPO_MANAGER__?.repositories.find((repo) =>
                    repo.rootUri.fsPath.replace(/\\/g, '/').endsWith('/other-project'),
                )?.rootUri.fsPath,
        );
        if (!otherPath) {
            throw new Error('Expected other repository');
        }
        await expect(follow).toHaveAttribute('aria-pressed', 'false');
        await expect(graph.locator('.commit-row').filter({ hasText: 'main repository work' })).toBeVisible();
        const firstRow = graph.locator('.commit-row').first();
        const selectedChange = await firstRow.getAttribute('data-change-id');
        await firstRow.click();
        await graph.locator('.scroll-container').evaluate((element) => {
            element.scrollTop = 100;
        });
        await expect
            .poll(() => graph.locator('.scroll-container').evaluate((element) => element.scrollTop))
            .toBeGreaterThan(80);
        await recordGifFlow(
            page,
            async (capture) => {
                await capture();
                await page.evaluate(async (root) => {
                    const repo = window.__JJ_VIEW_REPO_MANAGER__?.repositories.find(
                        (repo) => repo.rootUri.fsPath === root,
                    );
                    if (!repo || !window.__JJ_VIEW_ENV__) {
                        throw new Error('Expected environment');
                    }
                    await window.__JJ_VIEW_ENV__.nav.openFile(
                        repo.rootUri.with({ path: `${repo.rootUri.path}/other.txt` }),
                    );
                }, otherPath);
                await expect(page.getByRole('tab', { name: /^other\.txt/ })).toBeVisible();
                await expect(picker).toHaveValue(mainPath);
                await follow.click();
                await scope.click();
                await otherCheckbox.uncheck();
                await expect(scope).toHaveText('Repositories (1)');
                await capture();
                await scope.click();
                // A commit-details editor from an excluded repo must also leave the graph alone.
                await page.evaluate(async (root) => {
                    const repo = window.__JJ_VIEW_REPO_MANAGER__?.repositories.find(
                        (repo) => repo.rootUri.fsPath === root,
                    );
                    if (!repo || !window.__JJ_VIEW_ENV__) {
                        throw new Error('Expected environment');
                    }
                    await window.__JJ_VIEW_ENV__.nav.openCommitDetails(repo.rootUri, '@');
                }, otherPath);
                await expect(picker).toHaveValue(mainPath);
                await picker.selectOption(otherPath);
                await expect(graph.locator('.commit-row').filter({ hasText: 'other repository work' })).toBeVisible();
                await expect(scope).toHaveText('Repositories (2)');
                await capture();
                await page.evaluate(async (root) => {
                    const repo = window.__JJ_VIEW_REPO_MANAGER__?.repositories.find(
                        (repo) => repo.rootUri.fsPath === root,
                    );
                    if (!repo || !window.__JJ_VIEW_ENV__) {
                        throw new Error('Expected environment');
                    }
                    await window.__JJ_VIEW_ENV__.nav.openFile(
                        repo.rootUri.with({ path: `${repo.rootUri.path}/main.txt` }),
                    );
                }, mainPath);
                await expect(picker).toHaveValue(mainPath);
                await expect(graph.locator(`.commit-row[data-change-id="${selectedChange}"]`)).toHaveAttribute(
                    'aria-selected',
                    'true',
                );
                await expect
                    .poll(() => graph.locator('.scroll-container').evaluate((element) => element.scrollTop))
                    .toBeGreaterThan(80);
                await picker.selectOption(otherPath);
                await expect(graph.locator('.commit-row').filter({ hasText: 'other repository work' })).toBeVisible();
                await page.reload();
                await waitForScmReady(page);
                await expect(picker).toHaveValue(otherPath);
                await expect(follow).toHaveAttribute('aria-pressed', 'true');
                await scope.click();
                for (const checkbox of await graph.getByRole('checkbox').all()) {
                    await checkbox.uncheck();
                }
                await expect(graph.getByText('Choose repositories above to display the graph.')).toBeVisible();
                await capture();
                await scope.click();
                await picker.selectOption(mainPath);
                await expect(graph.locator('.commit-row').filter({ hasText: 'main repository work' })).toBeVisible();
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'repository-focus.png'), fullPage: true });
            },
            { outputPath: path.join(ARTIFACT_DIR, 'repository-focus.gif') },
        );
    });
    test('should recursively discover nested sub-repositories using host fastwalk findFiles', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create root repo commit
        testRepo.writeFile('root_file.txt', 'root content\n');
        testRepo.describe('root commit');
        testRepo.new();

        // Create subprojects nested at different directory levels
        const sub1Path = path.join(testRepo.path, 'subproject1');
        const sub2Path = path.join(testRepo.path, 'nested', 'subproject2');

        const sub1Repo = new ScopedTestRepo(sub1Path);
        sub1Repo.init();
        sub1Repo.writeFile('sub1_file.txt', 'sub1 content\n');
        sub1Repo.describe('sub1 commit');
        sub1Repo.new();

        const sub2Repo = new ScopedTestRepo(sub2Path);
        sub2Repo.init();
        sub2Repo.writeFile('sub2_file.txt', 'sub2 content\n');
        sub2Repo.describe('sub2 commit');
        sub2Repo.new();

        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            // Wait for repositoryManager to complete recursive scanning and discover all repositories
            await page.waitForFunction(
                () => {
                    const manager = window.__JJ_VIEW_REPO_MANAGER__;
                    return manager && manager.repositories.length >= 3;
                },
                { timeout: 10000 },
            );

            // Query discovered repository roots from repoManager
            const discoveredRoots = await page.evaluate((): string[] => {
                const manager = window.__JJ_VIEW_REPO_MANAGER__;
                return manager ? manager.repositories.map((r) => r.rootUri.fsPath) : [];
            });

            // URI serialization canonicalizes Windows drive letters to lowercase.
            const normalize = (p: string) =>
                p.replace(/[\\/]+/g, '/').replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
            const normDiscovered = discoveredRoots.map(normalize);
            const normRoot = normalize(testRepo.path);
            const normSub1 = normalize(sub1Path);
            const normSub2 = normalize(sub2Path);

            expect(normDiscovered).toContain(normRoot);
            expect(normDiscovered).toContain(normSub1);
            expect(normDiscovered).toContain(normSub2);

            // Capture screenshot for walkthrough
            await page.screenshot({
                path: path.join(ARTIFACT_DIR, 'multirepo-workspace-discovery.png'),
                fullPage: true,
            });
        } finally {
            sub1Repo.dispose();
            sub2Repo.dispose();
        }
    });
});
