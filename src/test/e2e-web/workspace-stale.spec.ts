/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('updates a stale secondary workspace from its graph pill', async ({ page, server, testRepo }) => {
    const secondary = testRepo.workspaceAdd('secondary');
    const other = testRepo.workspaceAdd('other');
    const checkoutFile = path.join(secondary.path, 'shared.txt');
    const otherId = testRepo.getLog('other@', 'commit_id');
    fs.writeFileSync(path.join(other.path, 'pending.txt'), 'pending edit');
    testRepo.writeFile('shared.txt', 'updated checkout');

    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const pill = page.locator('.workspace-wrapper', { hasText: 'secondary@' });
    const action = page.getByTestId('menu-item-jj-view.workspaceUpdateStale');
    await expect(pill).toBeVisible();
    await pill.getByText('secondary@').click({ button: 'right' });
    await expect(page.getByTestId('menu-item-jj-view.workspaceRefresh')).toBeVisible();
    await expect(action).toHaveCount(0);
    await page.keyboard.press('Escape');

    testRepo.rebase({ revision: 'secondary@', destination: '@' });
    expect(fs.existsSync(checkoutFile)).toBe(false);
    await page.getByTestId('scm-title-action-jj-view.refresh').click();

    await recordGifFlow(
        page,
        async (capture) => {
            await expect(pill.getByRole('img', { name: 'Stale workspace' })).toBeVisible();
            await expect(page.locator('.workspace-wrapper.stale')).toHaveCount(1);
            await capture();
            await pill.getByText('secondary@').click({ button: 'right' });
            await expect(action).toHaveText('Update Stale Workspace');
            await capture();
            await action.click();
            await expect(pill).toBeVisible();
            await expect(pill.getByRole('img', { name: 'Stale workspace' })).toHaveCount(0);
            expect(fs.readFileSync(checkoutFile, 'utf8')).toBe('updated checkout');
            expect(testRepo.getLog('other@', 'commit_id')).toBe(otherId);
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'workspace-stale-menu.gif') },
    );
});

test('updates the current workspace from its stale notification', async ({ page, server, testRepo }) => {
    testRepo.config('snapshot.auto-update-stale', 'false');
    const secondary = testRepo.workspaceAdd('secondary');
    secondary.writeFile('shared.txt', 'updated checkout');
    secondary.rebase({ revision: 'default@', destination: '@' });
    const checkoutFile = path.join(testRepo.path, 'shared.txt');
    expect(fs.existsSync(checkoutFile)).toBe(false);

    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const pill = page.locator('.workspace-wrapper', { hasText: 'default@' });
    await expect(pill.getByRole('img', { name: 'Stale workspace' })).toBeVisible();

    await recordGifFlow(
        page,
        async (capture) => {
            await page.getByTestId('scm-title-action-jj-view.refresh').click();
            const notification = page.getByTestId('notification-toast').filter({ hasText: 'working copy is stale' });
            await expect(notification).toBeVisible();
            await capture();
            await notification.getByRole('button', { name: 'Update Stale Workspace' }).click();
            await expect(notification).toHaveCount(0);
            await expect(pill).toBeVisible();
            await expect(pill.getByRole('img', { name: 'Stale workspace' })).toHaveCount(0);
            expect(fs.readFileSync(checkoutFile, 'utf8')).toBe('updated checkout');
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'workspace-stale-notification.gif') },
    );
});
