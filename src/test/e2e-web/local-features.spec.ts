/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('describes a graph revision and persists hover-action visibility', async ({ page, server, testRepo }) => {
    testRepo.writeFile('feature.txt', 'feature content\n');
    testRepo.describe('feature to describe');
    const changeId = testRepo.getChangeId('@');
    testRepo.new();
    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const row = page.locator(`.commit-row[data-change-id="${changeId}"]`);
    await expect(row).toBeVisible();
    await recordGifFlow(
        page,
        async (capture) => {
            let frame = 0;
            const captureFrame = async () => {
                await capture();
                await page.screenshot({ path: path.join(ARTIFACT_DIR, `local-features-frame-${frame++}.png`) });
            };
            await row.hover();
            const describeButton = row.getByRole('button', { name: 'Describe', exact: true });
            await expect(describeButton).toBeVisible();
            await expect(row.getByRole('button', { name: 'Edit Commit', exact: true })).toHaveCount(1);
            await captureFrame();
            await describeButton.click();
            const input = page.getByTestId('quick-input-text-input');
            await expect(input).toHaveValue('feature to describe');
            await input.fill('updated feature description');
            await captureFrame();
            await input.press('Enter');
            await expect.poll(() => testRepo.getDescription(changeId)).toBe('updated feature description');
            await expect(row).toContainText('updated feature description');
            await row.hover();
            await describeButton.click({ button: 'right' });
            await page.getByTestId('menu-item-jj-view.hideCommitAction.describe').click();
            await expect(describeButton).toHaveCount(0);
            await captureFrame();
            await page.reload();
            await expect(row).toBeVisible();
            await row.hover();
            await expect(describeButton).toHaveCount(0);
            await row.click({ button: 'right' });
            await expect(page.getByTestId('menu-item-jj-view.abandonDescendants')).toBeVisible();
            await expect(page.getByTestId('menu-item-jj-view.squashDescendants')).toBeVisible();
            await page.keyboard.press('Escape');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'local-features.png') });
        },
        { outputPath: path.join(ARTIFACT_DIR, 'local-features.gif') },
    );
});

test('double-clicking graph items keeps details tabs open', async ({ page, server, testRepo }) => {
    testRepo.writeFile('first.txt', 'first content\n');
    testRepo.describe('first graph item');
    const firstId = testRepo.getChangeId('@');
    testRepo.new();
    testRepo.writeFile('second.txt', 'second content\n');
    testRepo.describe('second graph item');
    const secondId = testRepo.getChangeId('@');
    testRepo.new();
    testRepo.writeFile('third.txt', 'third content\n');
    testRepo.describe('third graph item');
    const thirdId = testRepo.getChangeId('@');
    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const firstRow = page.locator(`.commit-row[data-change-id="${firstId}"]`);
    const secondRow = page.locator(`.commit-row[data-change-id="${secondId}"]`);
    const thirdRow = page.locator(`.commit-row[data-change-id="${thirdId}"]`);
    const tabs = page.locator('[data-testid="tab-bar-container"] .tab');
    const firstTab = tabs.filter({ hasText: `Commit ${firstId.slice(0, 8)}` });
    const secondTab = tabs.filter({ hasText: `Commit ${secondId.slice(0, 8)}` });
    const thirdTab = tabs.filter({ hasText: `Commit ${thirdId.slice(0, 8)}` });
    await recordGifFlow(
        page,
        async (capture) => {
            await firstRow.getByText('first graph item', { exact: true }).click();
            await expect(firstTab).toHaveClass(/preview/);
            await capture();
            await firstRow.getByText('first graph item', { exact: true }).dblclick();
            await expect(firstTab).not.toHaveClass(/preview/);
            await expect(firstRow).toHaveAttribute('aria-selected', 'true');
            await expect(firstTab).toHaveCount(1);
            await capture();
            await secondRow.getByText('second graph item', { exact: true }).click();
            await expect(secondTab).toHaveClass(/preview/);
            await expect(firstTab).toBeVisible();
            await thirdRow.getByText('third graph item', { exact: true }).click();
            await expect(thirdTab).toHaveClass(/preview/);
            await expect(secondTab).toHaveCount(0);
            await expect(firstTab).toBeVisible();
            await thirdRow.getByText('third graph item', { exact: true }).dblclick();
            await expect(thirdTab).not.toHaveClass(/preview/);
            await expect(tabs).toHaveCount(2);
            await capture();
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'graph-keep-open.png') });
        },
        { outputPath: path.join(ARTIFACT_DIR, 'graph-keep-open.gif') },
    );
});
