/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ScopedTestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('pushes graph badges to chosen remotes and adds another destination', async ({ page, server, testRepo }) => {
    using origin = new ScopedTestRepo();
    using upstream = new ScopedTestRepo();
    origin.init();
    upstream.init();
    testRepo.writeFile('release.txt', 'release content');
    testRepo.describe('release target');
    testRepo.bookmark('feature', '@');
    testRepo.tag('release', '@');
    testRepo.new();
    testRepo.addRemote('origin', origin.path);
    testRepo.addRemote('upstream', upstream.path);
    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const bookmark = page.locator('.commit-row .bookmark-wrapper').filter({ hasText: /^\s*feature\s*$/ });
    const tag = page.locator('.commit-row .tag-wrapper').filter({ hasText: /^\s*release\s*$/ });
    await expect(bookmark).toBeVisible();
    await expect(tag).toBeVisible();
    await recordGifFlow(
        page,
        async (capture) => {
            await bookmark.click({ button: 'right' });
            await expect(page.getByTestId('menu-item-jj-view.pushRef')).toHaveText('Push');
            await expect(page.getByTestId('menu-item-jj-view.pushRefToRemote')).toHaveText('Push to Remote...');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'badge-push-menu.png') });
            await capture();
            await page.getByTestId('menu-item-jj-view.pushRef').click();
            await expect(page.getByTestId('quick-input-widget')).toBeVisible();
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'badge-push-remotes.png') });
            await capture();
            await page.locator('.quick-pick-item').filter({ hasText: 'origin' }).click();
            await expect.poll(() => origin.listGitRefs('refs/heads/')).toEqual(['refs/heads/feature']);
            await expect(bookmark.locator('[title]')).toHaveAttribute('title', /feature@origin/);
            await capture();

            await bookmark.click({ button: 'right' });
            await page.getByTestId('menu-item-jj-view.pushRefToRemote').click();
            await expect(page.locator('.quick-pick-item').filter({ hasText: 'Has this bookmark' })).toHaveCount(1);
            await capture();
            await page.locator('.quick-pick-item').filter({ hasText: 'upstream' }).click();
            await expect.poll(() => upstream.listGitRefs('refs/heads/')).toEqual(['refs/heads/feature']);

            await tag.click({ button: 'right' });
            await page.getByTestId('menu-item-jj-view.pushRefToRemote').click();
            await page.locator('.quick-pick-item').filter({ hasText: 'upstream' }).click();
            await expect.poll(() => upstream.listGitRefs('refs/tags/')).toEqual(['refs/tags/release']);
            await expect(origin.listGitRefs('refs/tags/')).toEqual([]);
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'badge-push.gif') },
    );
});
