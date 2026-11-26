/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test('shows target commit freshness on graph pills in light and dark themes', async ({ page, server, testRepo }) => {
    const timestampKey = 'debug.commit-timestamp';
    for (const [bookmark, timestamp] of [
        ['archived', '2024-05-01T12:00:00Z'],
        ['review', '2024-06-23T12:00:00Z'],
        ['draft', '2024-06-27T12:00:00Z'],
    ]) {
        testRepo.config(timestampKey, timestamp);
        testRepo.new(undefined, bookmark);
        testRepo.writeFile('example.txt', `${bookmark}\n`);
        testRepo.snapshot();
        testRepo.bookmark(bookmark, '@');
        testRepo.removeConfig(timestampKey);
    }
    testRepo.config(timestampKey, '2024-06-30T11:40:00Z');
    testRepo.describe('recent update');
    testRepo.workspaceAdd('secondary');
    testRepo.removeConfig(timestampKey);
    testRepo.tag('release', 'archived');

    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => {
        if (!error.message.includes('agentapi binary not found')) {
            pageErrors.push(error);
        }
    });
    await page.clock.install({ time: new Date('2024-06-30T12:00:00Z') });
    await page.goto(server.serverUrl);
    await waitForScmReady(page);

    const log = page.getByTestId('log-content');
    const bookmarkPill = (name: string) =>
        log.locator('.bookmark-wrapper .bookmark-pill').filter({ has: page.getByText(name, { exact: true }) });
    const draft = bookmarkPill('draft');
    const review = bookmarkPill('review');
    const archived = bookmarkPill('archived');
    const tag = log.locator('.tag-wrapper .bookmark-pill');
    const workspace = log.locator('.workspace-wrapper .bookmark-pill').filter({ hasText: 'default@' });
    await expect(draft).toHaveAttribute('title', /Target commit updated 20 minutes ago$/);
    await expect(tag).toHaveAttribute('title', /Target commit updated 1 month ago$/);
    await expect(workspace).toHaveAttribute('title', /Target commit updated 20 minutes ago$/);
    await expect(review).toHaveAttribute('title', /Target commit updated 1 week ago$/);
    await expect(archived).toHaveAttribute('title', /Target commit updated 1 month ago$/);

    const gradient = /linear-gradient\(/;
    const readTint = (el: Element) => parseFloat(getComputedStyle(el).getPropertyValue('--pill-age-tint'));
    await recordGifFlow(
        page,
        async (capture) => {
            for (const theme of ['pierre-dark-soft', 'pierre-light']) {
                await page.evaluate(async (theme) => {
                    await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', theme);
                }, theme);
                await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                for (const pill of [draft, review, archived, tag, workspace]) {
                    await expect(pill).toHaveCSS('background-image', gradient);
                }
                const freshTint = await draft.evaluate(readTint);
                const reviewTint = await review.evaluate(readTint);
                const oldTint = await archived.evaluate(readTint);
                expect(freshTint).toBeGreaterThan(reviewTint);
                expect(reviewTint).toBeGreaterThan(oldTint);
                await log.screenshot({ path: path.join(ARTIFACT_DIR, `graph-pill-age-${theme}.png`) });
                await capture();
            }

            const initialTint = await draft.evaluate(readTint);
            await page.clock.fastForward('02:00:00');
            await expect(draft).toHaveAttribute('title', /Target commit updated 2 hours ago$/);
            expect(await draft.evaluate(readTint)).toBeLessThan(initialTint);
            await capture();
        },
        { outputPath: path.join(ARTIFACT_DIR, 'graph-pill-age.gif') },
    );
    expect(pageErrors).toEqual([]);
});
