/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('refreshes the target workspace from its graph pill', async ({ page, server, testRepo }) => {
    const target = testRepo.workspaceAdd('secondary');
    target.describe('target workspace');
    const other = testRepo.workspaceAdd('other');
    const otherId = testRepo.getLog('other@', 'commit_id');
    await page.goto(server.serverUrl);
    await waitForScmReady(page);
    const row = page
        .locator('.commit-row')
        .filter({ has: page.locator('.workspace-wrapper', { hasText: 'secondary@' }) });
    await expect(row.locator('.commit-desc')).toHaveText('(empty) target workspace');
    fs.writeFileSync(path.join(target.path, 'target.txt'), 'unsnapshotted target edit');
    fs.writeFileSync(path.join(other.path, 'other.txt'), 'unsnapshotted other edit');

    await recordGifFlow(
        page,
        async (capture) => {
            await capture();
            await row.locator('.workspace-wrapper .pill-label').click({ button: 'right' });
            const action = page.getByTestId('menu-item-jj-view.workspaceRefresh');
            await expect(action).toHaveText('Refresh Workspace');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'workspace-refresh-menu.png') });
            await capture();
            await action.click();
            await expect(row.locator('.commit-desc')).toHaveText('target workspace');
            expect(testRepo.listFiles('secondary@')).toContain('target.txt');
            expect(testRepo.getLog('other@', 'commit_id')).toBe(otherId);
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'workspace-refresh.gif') },
    );
});
