/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('moves graph tags by dragging and deletes them through the context menu', async ({ page, server, testRepo }) => {
    testRepo.writeFile('release.txt', 'release content');
    testRepo.describe('tag source');
    const sourceId = testRepo.getChangeId('@');
    testRepo.tag('release', '@');
    testRepo.new();
    testRepo.describe('tag destination');
    const targetId = testRepo.getChangeId('@');
    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const source = page.locator(`.commit-row[data-change-id="${sourceId}"]`);
    const target = page.locator(`.commit-row[data-change-id="${targetId}"]`);
    await expect(source.locator('.draggable-tag')).toBeVisible();
    await recordGifFlow(
        page,
        async (capture) => {
            await capture();
            const tag = await source.locator('.draggable-tag').boundingBox();
            const destination = await target.boundingBox();
            if (!tag || !destination) {
                throw new Error('Missing tag or destination bounds');
            }
            await page.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2);
            await page.mouse.down();
            await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, {
                steps: 10,
            });
            await expect(page.locator('.drag-preview-overlay .tag-wrapper')).toHaveText('release');
            await capture();
            await page.mouse.up();
            await expect(target.locator('.draggable-tag')).toHaveText('release');
            await expect(source.locator('.draggable-tag')).toHaveCount(0);
            await target.locator('.draggable-tag').click({ button: 'right' });
            const deleteAction = page.getByTestId('menu-item-jj-view.deleteTag');
            await expect(deleteAction).toBeVisible();
            await expect(page.getByTestId('menu-item-jj-view.deleteBookmark')).toHaveCount(0);
            await capture();
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'tag-context-menu.png') });
            await deleteAction.click();
            await expect(page.locator('.draggable-tag')).toHaveCount(0);
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'tag-interactions.gif') },
    );
});
