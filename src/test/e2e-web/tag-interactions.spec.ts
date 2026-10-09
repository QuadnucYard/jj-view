/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ScopedTestRepo } from '../test-repo';
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

test('distinguishes remote graph tags and keeps remote tag actions read-only', async ({ page, server, testRepo }) => {
    using remoteRepo = new ScopedTestRepo();
    remoteRepo.init();
    remoteRepo.writeFile('remote.txt', 'remote release');
    remoteRepo.describe('remote tag target');
    remoteRepo.tag('release', '@');
    testRepo.writeFile('local.txt', 'local release');
    testRepo.describe('local tag target');
    const localId = testRepo.getChangeId('@');
    testRepo.addRemote('origin', remoteRepo.path);
    testRepo.fetchTags('origin');
    testRepo.trackTag('release', 'origin');
    testRepo.tagMove('release', localId);
    testRepo.config('revsets.log', 'all()');
    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const remoteTag = page.locator('.commit-row .tag-wrapper').filter({ hasText: 'release@origin' });
    const localTag = page.locator('.draggable-tag').filter({ hasText: 'release' });
    await expect(remoteTag).toBeVisible();
    await expect(localTag).toBeVisible();
    await expect(remoteTag.locator('..')).not.toHaveClass(/draggable-tag/);
    await recordGifFlow(
        page,
        async (capture) => {
            await capture();
            const bounds = await remoteTag.boundingBox();
            if (!bounds) {
                throw new Error('Missing remote tag bounds');
            }
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.down();
            await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2, { steps: 5 });
            await expect(page.locator('.drag-preview-overlay')).toHaveCount(0);
            await page.mouse.up();
            await remoteTag.click({ button: 'right' });
            await expect(page.getByTestId('menu-item-jj-view.deleteTag')).toHaveCount(0);
            await page.keyboard.press('Escape');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'remote-tags.png') });
            await capture();
            await localTag.click({ button: 'right' });
            await page.getByTestId('menu-item-jj-view.deleteTag').click();
            await expect(page.locator('.draggable-tag')).toHaveCount(0);
            await expect(remoteTag).toBeVisible();
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'remote-tags.gif') },
    );
});
