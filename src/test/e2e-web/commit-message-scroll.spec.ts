/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

const testWithScrollbars = test.extend({
    launchOptions: async ({ launchOptions }, use) => {
        await use({ ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] });
    },
});

testWithScrollbars(
    'keeps the commit message aligned as selection scrolls to the bottom',
    async ({ page, server, testRepo }) => {
        const title = 'Selection in a long commit message';
        const message = [
            title,
            '',
            'A wide body line '.repeat(18).trimEnd(),
            ...Array.from({ length: 30 }, (_, index) => `Body line ${index + 1}`),
        ].join('\n');
        testRepo.writeFile('message.txt', 'message example\n');
        testRepo.describe(message);
        testRepo.new();

        const pageErrors: string[] = [];
        page.on('pageerror', (error) => {
            if (!error.message.includes('agentapi binary not found')) {
                pageErrors.push(error.message);
            }
        });
        await page.setViewportSize({ width: 1050, height: 480 });
        await page.goto(server.serverUrl);
        await waitForScmReady(page);
        await page.addStyleTag({
            content: `
            .commit-textarea { scrollbar-width: auto; scrollbar-color: auto; }
            .commit-textarea::-webkit-scrollbar { width: 12px; height: 12px; }
        `,
        });
        await page.getByTestId('log-content').getByText(title, { exact: true }).click();
        const editor = page.getByTestId('commit-details-view').locator('.editor-wrapper');
        const textarea = editor.locator('textarea');
        await expect(textarea).toHaveValue(message);

        const expectAligned = async () => {
            await expect
                .poll(() =>
                    textarea.evaluate((element) => {
                        const clip = element.parentElement?.querySelector('.editor-backdrop')?.getBoundingClientRect();
                        const mirror = element.parentElement
                            ?.querySelector('.backdrop-content')
                            ?.getBoundingClientRect();
                        if (!clip || !mirror) {
                            throw new Error('Commit message backdrop is missing');
                        }
                        const input = element.getBoundingClientRect();
                        return {
                            x: Math.round(mirror.left - input.left + element.scrollLeft),
                            y: Math.round(mirror.top - input.top + element.scrollTop),
                            width: Math.round(clip.width) - element.clientWidth,
                            height: Math.round(clip.height) - element.clientHeight,
                        };
                    }),
                )
                .toEqual({ x: 0, y: 0, width: 0, height: 0 });
        };

        await recordGifFlow(
            page,
            async (capture) => {
                // Classic scrollbars must take up space for this regression to be exercised.
                await expect
                    .poll(() =>
                        textarea.evaluate((element) => ({
                            vertical: element.getBoundingClientRect().width - element.clientWidth >= 10,
                            horizontal: element.getBoundingClientRect().height - element.clientHeight >= 10,
                        })),
                    )
                    .toEqual({ vertical: true, horizontal: true });
                await capture();

                const box = await textarea.boundingBox();
                if (!box) {
                    throw new Error('Commit message textarea is not visible');
                }
                await page.mouse.move(box.x + 20, box.y + 20);
                await page.mouse.down();
                try {
                    await page.mouse.move(box.x + 120, box.y + box.height + 15, { steps: 12 });
                    await expect
                        .poll(() =>
                            textarea.evaluate(
                                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
                            ),
                        )
                        .toBeLessThanOrEqual(1);
                } finally {
                    await page.mouse.up();
                }
                await expect
                    .poll(() =>
                        textarea.evaluate((element) => {
                            if (!(element instanceof HTMLTextAreaElement)) {
                                throw new Error('Commit message input is not a textarea');
                            }
                            return element.value.slice(element.selectionStart, element.selectionEnd);
                        }),
                    )
                    .toContain('Body line 29');
                await expectAligned();
                await editor.screenshot({ path: path.join(ARTIFACT_DIR, 'commit-message-selection-dark.png') });
                await capture();

                await page.evaluate(async () => {
                    await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
                });
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
                await expectAligned();
                await editor.screenshot({ path: path.join(ARTIFACT_DIR, 'commit-message-selection-light.png') });
                await capture();

                await textarea.evaluate((element) => {
                    element.scrollLeft = element.scrollWidth;
                });
                await expect.poll(() => textarea.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
                await expectAligned();

                await textarea.fill('Short message');
                await expect(editor.locator('.backdrop-text')).toHaveText('Short message');
                await expectAligned();
            },
            { outputPath: path.join(ARTIFACT_DIR, 'commit-message-selection.gif') },
        );
        expect(pageErrors).toEqual([]);
    },
);
