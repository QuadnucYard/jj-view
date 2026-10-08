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
    await recordGifFlow(page, async (capture) => {
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
    }, { outputPath: path.join(ARTIFACT_DIR, 'local-features.gif') });
});
