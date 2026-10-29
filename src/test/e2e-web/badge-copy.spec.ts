/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('copies graph badge names and workspace paths from context menus', async ({ page, server, testRepo, context }) => {
    testRepo.writeFile('file.txt', 'content');
    testRepo.describe('badge copy target');
    testRepo.bookmark('feature/nested-name', '@');
    testRepo.tag('release-1.0', '@');
    const workspace = testRepo.workspaceAdd('secondary', '@');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(server.serverUrl);
    await waitForScmReady(page);

    await recordGifFlow(
        page,
        async (capture) => {
            for (const [selector, name] of [
                ['.bookmark-wrapper', 'feature/nested-name'],
                ['.tag-wrapper', 'release-1.0'],
                ['.workspace-wrapper', 'secondary'],
            ]) {
                const badge = page.locator(`.commit-row ${selector}`).filter({ hasText: name });
                await expect(badge).toBeVisible();
                await badge.locator('.pill-label').click({ button: 'right' });
                const action = page.getByTestId('menu-item-jj-view.copyName');
                await expect(action).toHaveText('Copy Name');
                if (selector !== '.workspace-wrapper') {
                    await expect(page.getByTestId('menu-item-jj-view.copyWorkspacePath')).toHaveCount(0);
                }
                await capture();
                await action.click();
                await expect(page.getByTestId('context-menu')).not.toBeVisible();
                await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(name);
            }
            await page
                .locator('.commit-row .workspace-wrapper .pill-label')
                .filter({ hasText: 'secondary@' })
                .click({ button: 'right' });
            const copyPath = page.getByTestId('menu-item-jj-view.copyWorkspacePath');
            await expect(copyPath).toHaveText('Copy Path');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'badge-copy-workspace.png') });
            await capture();
            await copyPath.click();
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(workspace.path);
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'badge-copy.gif') },
    );
});
