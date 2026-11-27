/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('keeps an omitted-history marker clear of the next graph node', async ({ page, server, testRepo }) => {
    testRepo.new(['root()'], 'Lower tree');
    const lowerCommit = testRepo.getCommitId('@');
    testRepo.new(['root()'], 'Upper tree');
    const jjConfigDir = path.join(server.userDataDir, 'jj');
    await fs.mkdir(jjConfigDir, { recursive: true });
    await fs.writeFile(
        path.join(jjConfigDir, 'config.toml'),
        `revsets.log = '@ | ${lowerCommit}'\nrevset-aliases."immutable_heads()" = '${lowerCommit}'\n`,
    );

    await page.goto(server.serverUrl);
    await waitForScmReady(page);

    const graph = page.locator('svg.graph-svg');
    const markers = graph.locator(':scope > g[transform]');
    const edges = graph.locator(':scope > path');
    const lowerNode = graph.locator(`[data-commit-id="${lowerCommit}"] polygon`);
    await expect(markers).toHaveCount(2);
    await expect(edges).toHaveCount(2);
    await expect(lowerNode).toBeVisible();

    await recordGifFlow(
        page,
        async (capture) => {
            for (const theme of ['pierre-dark-soft', 'pierre-light']) {
                await page.evaluate(async (theme) => {
                    await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', theme);
                }, theme);
                await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

                const markerBottom = await markers.first().evaluate((marker) => marker.getBoundingClientRect().bottom);
                const edgeBottom = await edges.first().evaluate((edge) => edge.getBoundingClientRect().bottom);
                const lowerNodeTop = await lowerNode.evaluate((node) => node.getBoundingClientRect().top);
                expect(markerBottom).toBeLessThan(lowerNodeTop);
                expect(edgeBottom).toBeLessThan(lowerNodeTop);
                await page.locator('.commit-graph').screenshot({
                    path: path.join(ARTIFACT_DIR, `graph-disconnected-${theme}.png`),
                });
                await capture();
            }
        },
        { outputPath: path.join(ARTIFACT_DIR, 'graph-disconnected.gif') },
    );
});

test.describe('Commit Details timestamps', () => {
    test.use({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });

    test('shows localized author and committer times and adapts relative ages to pane width', async ({
        page,
        server,
        testRepo,
    }) => {
        const authorTime = '2024-06-15T07:08:09Z';
        const commitTime = '2024-06-15T07:08:42Z';
        testRepo.config('debug.commit-timestamp', authorTime);
        testRepo.new(undefined, 'Draft timestamp example');
        testRepo.removeConfig('debug.commit-timestamp');
        testRepo.config('debug.commit-timestamp', commitTime);
        testRepo.writeFile('timestamps.txt', 'timestamp example\n');
        testRepo.describe('Add timestamp example');
        testRepo.removeConfig('debug.commit-timestamp');
        testRepo.new();

        const pageErrors: Error[] = [];
        page.on('pageerror', (error) => {
            if (!error.message.includes('agentapi binary not found')) {
                pageErrors.push(error);
            }
        });
        await page.clock.setFixedTime(new Date('2024-06-18T07:09:00Z'));
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const commit = page.getByTestId('log-content').getByText('Add timestamp example', { exact: true });
        const people = page.getByTestId('commit-details-view').locator('.people-rows');
        const authorRow = people.locator('.person-info').filter({ hasText: 'Author:' });
        const committerRow = people.locator('.person-info').filter({ hasText: 'Committer:' });
        const author = authorRow.locator('time');
        const committer = committerRow.locator('time');
        const authorAge = authorRow.getByText('(3天前)', { exact: true });
        const committerAge = committerRow.getByText('(3天前)', { exact: true });

        await recordGifFlow(
            page,
            async (capture) => {
                await expect(commit).toBeVisible();
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'commit-details-timestamps-log.png') });
                await capture();
                await commit.click();
                await expect(author).toHaveText('2024年6月15日 GMT+8 15:08:09');
                await expect(committer).toHaveText('2024年6月15日 GMT+8 15:08:42');
                expect(Date.parse((await author.getAttribute('datetime')) ?? '')).toBe(Date.parse(authorTime));
                expect(Date.parse((await committer.getAttribute('datetime')) ?? '')).toBe(Date.parse(commitTime));
                await expect(authorAge).toBeVisible();
                await expect(committerAge).toBeVisible();
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-dark-soft');
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'commit-details-timestamps-dark.png') });
                await capture();

                await page.evaluate(async () => {
                    await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
                });
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
                await page.setViewportSize({ width: 560, height: 680 });
                await expect(author).toBeInViewport({ ratio: 1 });
                await expect(committer).toBeInViewport({ ratio: 1 });
                await expect(authorAge).toBeHidden();
                await expect(committerAge).toBeHidden();
                await expect(author).toHaveAttribute('title', '3天前');
                await expect(committer).toHaveAttribute('title', '3天前');
                expect(await people.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'commit-details-timestamps-light.png') });

                await page.setViewportSize({ width: 1280, height: 720 });
                await expect(authorAge).toBeVisible();
                await expect(committerAge).toBeVisible();
            },
            { outputPath: path.join(ARTIFACT_DIR, 'commit-details-timestamps.gif') },
        );
        expect(pageErrors).toEqual([]);
    });
});

test.describe('Standalone Web Log and Commit Details', () => {
    test('should display log graph, select commit, open commit details, and click file diff', async ({
        page,
        server,
        testRepo,
    }) => {
        // Set up commits with descriptions and files
        testRepo.writeFile('file1.txt', 'commit 1 contents\n');
        testRepo.describe('feat: initial commit');
        testRepo.new();

        testRepo.writeFile('file2.txt', 'commit 2 original\n');
        testRepo.describe('feat: add second file');
        testRepo.new();

        testRepo.writeFile('file2.txt', 'commit 2 updated\n');
        testRepo.describe('fix: update second file');
        testRepo.writeFile('file3.txt', 'working copy uncommitted\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // 1. Verify Log Pane is visible below SCM pane
        const logPane = page.locator('[data-testid="log-pane"]');
        await expect(logPane).toBeVisible({ timeout: 10000 });

        // 2. Verify graph nodes and descriptions are rendered in JJ Log
        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent).toBeVisible();

        // Wait for commit rows to render
        const commitRows = logContent.locator('.commit-row');
        await expect(commitRows.first()).toBeVisible({ timeout: 10000 });
        await expect(commitRows).toHaveCount(4);

        // Verify descriptions in log graph
        await expect(logContent.getByText('feat: add second file')).toBeVisible();
        await expect(logContent.getByText('feat: initial commit')).toBeVisible();

        // 3. Click the description of the second commit ('feat: add second file')
        const targetRow = logContent.locator('.commit-row').filter({ hasText: 'feat: add second file' });
        await targetRow.locator('.commit-desc').click();

        // 4. Verify Commit Details pane is mounted in main editor view
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        await expect(detailsView).toBeVisible({ timeout: 5000 });

        // Verify commit details header & description
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: add second file');

        // Verify author metadata is rendered
        await expect(detailsView.locator('.people-rows')).toBeVisible();

        // Verify changed files list contains 'file2.txt'
        const fileRow = detailsView.locator('.file-row').filter({ hasText: 'file2.txt' });
        await expect(fileRow).toBeVisible();

        // Verify consistent typography and foreground colors between SCM, Log, and Commit Details
        const scmItem = page.locator('[data-testid="scm-resource-item"]').first();
        await expect(scmItem).toBeVisible();
        const scmFontSize = await scmItem.evaluate((el) => window.getComputedStyle(el).fontSize);
        const logDesc = targetRow.locator('.commit-desc');
        const logFontSize = await logDesc.evaluate((el) => window.getComputedStyle(el).fontSize);
        expect(scmFontSize).toBe('13px');
        expect(logFontSize).toBe('13px');

        const scmFileName = scmItem.locator('.file-name');
        const scmColor = await scmFileName.evaluate((el) => window.getComputedStyle(el).color);
        const logColor = await logDesc.evaluate((el) => window.getComputedStyle(el).color);
        const detailsFileName = fileRow.locator('.file-name');
        const detailsColor = await detailsFileName.evaluate((el) => window.getComputedStyle(el).color);
        expect(scmColor).toBe(detailsColor);
        expect(logColor).toBe(detailsColor);

        // Verify description foreground has muted contrast in Commit Details
        const authorLabel = detailsView.locator('.people-rows .label').first();
        const labelColor = await authorLabel.evaluate((el) => window.getComputedStyle(el).color);
        expect(labelColor).not.toBe(detailsColor);

        // 5. Click the changed file in Commit Details to open its diff
        const detailsTab = page.locator('[data-testid="tab-bar-container"] .tab.active');
        const detailsTabId = await detailsTab.getAttribute('data-testid');
        if (!detailsTabId) {
            throw new Error('Details tab is missing its test ID');
        }
        await expect(detailsTab).toHaveClass(/preview/);
        await fileRow.click();

        // Verify Pierre Diff Viewer opens
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });
        const activeTab = page.locator('[data-testid="tab-bar-container"] .tab.active');
        await expect(activeTab).toContainText('file2.txt');

        // Verify diff content contains the file content
        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();
        await expect(diffContainer.getByText('commit 2 original')).toBeVisible({ timeout: 5000 });

        // Opening a diff pins the originating details tab so it can be revisited.
        const keptDetailsTab = page.getByTestId(detailsTabId);
        await expect(keptDetailsTab).toBeVisible();
        await expect(keptDetailsTab).not.toHaveClass(/preview/);
        await keptDetailsTab.click();
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: add second file');
        await expect(fileRow).toBeVisible();
    });

    test('should replace the contents of the preview details tab when another commit is clicked', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('first.txt', 'first\n');
        testRepo.describe('feat: first commit');
        testRepo.new();
        testRepo.writeFile('second.txt', 'second\n');
        testRepo.describe('feat: second commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');

        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: first commit' })
            .locator('.commit-desc')
            .click();
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: first commit', { timeout: 10000 });
        await expect(detailsView.locator('.file-row').filter({ hasText: 'first.txt' })).toBeVisible();
        await expect(tabs).toHaveCount(1);
        const firstTabTitle = await tabs.first().innerText();

        // Clicking another commit reuses the preview tab. The tab title and
        // the rendered details must both move to the new commit.
        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: second commit' })
            .locator('.commit-desc')
            .click();
        await expect(tabs).toHaveCount(1);
        await expect(tabs.first()).not.toHaveText(firstTabTitle);
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: second commit', { timeout: 10000 });
        await expect(detailsView.locator('.file-row').filter({ hasText: 'second.txt' })).toBeVisible();
        await expect(detailsView.locator('.file-row').filter({ hasText: 'first.txt' })).toHaveCount(0);
    });

    test('should keep an edited description draft in its own tab when another commit is opened', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('first.txt', 'first\n');
        testRepo.describe('feat: first commit');
        testRepo.new();
        testRepo.writeFile('second.txt', 'second\n');
        testRepo.describe('feat: second commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        const textarea = page.locator('[data-testid="commit-details-view"] .commit-textarea');
        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');

        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: first commit' })
            .locator('.commit-desc')
            .click();
        await expect(textarea).toHaveValue('feat: first commit', { timeout: 10000 });
        await expect(tabs.first()).toHaveClass(/preview/);

        // Editing the description marks the tab dirty and pins it.
        await textarea.fill('feat: first commit (draft)');
        await expect(tabs.first()).toHaveClass(/dirty/);
        await expect(tabs.first()).not.toHaveClass(/preview/);

        // The next commit therefore opens in a second tab instead of
        // replacing the one holding the draft.
        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: second commit' })
            .locator('.commit-desc')
            .click();
        await expect(tabs).toHaveCount(2);
        await expect(textarea).toHaveValue('feat: second commit', { timeout: 10000 });

        // Switching back shows the draft, not a reloaded description.
        await tabs.first().click();
        await expect(textarea).toHaveValue('feat: first commit (draft)');
    });

    test('should render colorful graph lanes and allow vertical scrolling for long log history', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create 20 revisions to ensure the log history overflows the viewport
        for (let i = 1; i <= 20; i++) {
            testRepo.writeFile('log-scroll-test.txt', `revision ${i} line\n`);
            testRepo.describe(`feat: commit number ${i} for scrolling`);
            if (i < 20) {
                testRepo.new();
            }
        }

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logPane = page.locator('[data-testid="log-pane"]');
        await expect(logPane).toBeVisible({ timeout: 10000 });

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent).toBeVisible();

        const scrollContainer = logContent.locator('.scroll-container');
        await expect(scrollContainer).toBeVisible();

        // Verify commit rows are rendered
        const commitRows = logContent.locator('.commit-row');
        await expect(commitRows.first()).toBeVisible({ timeout: 10000 });
        const rowCount = await commitRows.count();
        expect(rowCount).toBeGreaterThanOrEqual(20);

        // Verify graph circles are colored with CSS lane variables
        const graphCircles = logContent.locator('.graph-svg [data-commit-id] circle');
        await expect(graphCircles.first()).toBeVisible();
        const circleCount = await graphCircles.count();
        expect(circleCount).toBeGreaterThan(0);

        // Verify circles use lane color variable (e.g. var(--jj-lane-0))
        const hasLaneColor = await graphCircles.evaluateAll((circles) =>
            circles.some((el) => {
                const fill = el.getAttribute('fill') || '';
                const stroke = el.getAttribute('stroke') || '';
                return fill.includes('--jj-lane-') || stroke.includes('--jj-lane-');
            }),
        );
        expect(hasLaneColor).toBe(true);

        // Verify scrollability: scrollHeight exceeds clientHeight
        const isScrollable = await scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight);
        expect(isScrollable).toBe(true);

        // Scroll down
        await scrollContainer.evaluate((el) => {
            el.scrollTop = 300;
        });

        // Verify scrollTop changed
        const scrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
        expect(scrollTop).toBeGreaterThan(0);
    });
});
