/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MAX_BLAME_BYTES, mapBlameLines } from '../core/jj-blame';
import { JjService } from '../core/jj-service';
import { TestRepo } from './test-repo';

describe('JJ file blame', () => {
    let repo: TestRepo;
    let jj: JjService;
    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
    });
    afterEach(async () => {
        await repo.dispose();
    });

    test('attributes inherited and working-copy lines to their source commits', async () => {
        repo.writeFile('file.txt', 'inherited\nold\n');
        repo.describe('Original "quoted" description\n\nBody');
        const parent = await jj.getLogEntry('@');
        repo.new();
        repo.writeFile('file.txt', 'inherited\nnew\n');
        repo.describe('Working copy');
        const current = await jj.getLogEntry('@');
        const blame = await jj.getFileBlame('file.txt');
        expect(blame?.content).toBe('inherited\nnew\n');
        expect(blame?.annotations.map((line) => line.commitId)).toEqual([parent?.commit_id, current?.commit_id]);
        expect(blame?.annotations[0].description).toContain('Original "quoted"');
        expect(blame?.annotations[0].author).toBe('Test User');
        expect(blame?.annotations[0].email).toBe('test@example.com');
    });

    test('reads literal punctuation and unicode paths and preserves CRLF and final line', async () => {
        const filename = '子目录/name [1] (copy).txt';
        repo.writeFile(filename, 'first\r\nlast');
        repo.describe('Literal path');
        const blame = await jj.getFileBlame(path.join(repo.path, filename));
        expect(blame?.content).toBe('first\r\nlast');
        expect(blame?.annotations.map((line) => line.content)).toEqual(['first\r\n', 'last']);
    });

    test('does not snapshot disk edits and pins historical revision content', async () => {
        repo.writeFile('file.txt', 'original\n');
        repo.describe('Original');
        const original = await jj.getLogEntry('@');
        fs.writeFileSync(path.join(repo.path, 'file.txt'), 'disk edit\n');
        const blame = await jj.getFileBlame('file.txt');
        expect(blame?.content).toBe('original\n');
        expect((await jj.getLogEntry('@'))?.commit_id).toBe(original?.commit_id);
        repo.describe('Snapshot disk edit');
        expect((await jj.getFileBlame('file.txt', original?.commit_id))?.content).toBe('original\n');
        expect((await jj.getFileBlame('file.txt'))?.content).toBe('disk edit\n');
    });

    test('omits missing, ignored and binary files and handles empty files', async () => {
        repo.writeFile('.gitignore', 'ignored.txt\n');
        repo.writeFile('ignored.txt', 'ignored\n');
        repo.writeFile('binary.txt', 'binary\0content');
        repo.writeFile('empty.txt', '');
        repo.describe('Files');
        expect(await jj.getFileBlame('missing.txt')).toBeUndefined();
        expect(await jj.getFileBlame('ignored.txt')).toBeUndefined();
        expect(await jj.getFileBlame('binary.txt')).toBeUndefined();
        expect((await jj.getFileBlame('empty.txt'))?.annotations).toEqual([]);
    });

    test('omits oversized files', async () => {
        repo.writeFile('large.txt', 'x'.repeat(MAX_BLAME_BYTES + 1));
        repo.describe('Large file');
        expect(await jj.getFileBlame('large.txt')).toBeUndefined();
    });

    test('omits conflicted file content', async () => {
        repo.writeFile('file.txt', 'base\n');
        repo.describe('Base');
        const base = await jj.getLogEntry('@');
        repo.new();
        repo.writeFile('file.txt', 'left\n');
        repo.describe('Left');
        const left = await jj.getLogEntry('@');
        repo.new([base?.commit_id ?? 'root()']);
        repo.writeFile('file.txt', 'right\n');
        repo.describe('Right');
        const right = await jj.getLogEntry('@');
        repo.new([left?.commit_id ?? '', right?.commit_id ?? '']);
        expect(await jj.getFileBlame('file.txt')).toBeUndefined();
    });
});

describe('blame buffer mapping', () => {
    test('maps unchanged lines across insertions, modifications and deletions', () => {
        expect([...mapBlameLines('a\nb\nc\nd\n', 'new\na\nchanged\nc\n')]).toEqual([
            [1, 0],
            [3, 2],
        ]);
    });
    test('normalizes CRLF without changing attribution', () => {
        expect([...mapBlameLines('a\r\nb\r\n', 'a\nb\n')]).toEqual([
            [0, 0],
            [1, 1],
        ]);
    });
    test('does not attribute the synthetic final editor line', () => {
        expect(mapBlameLines('a\n', 'a\n').has(1)).toBe(false);
        expect(mapBlameLines('', '').size).toBe(0);
    });
    test('bounds diff work for completely rewritten documents', () => {
        const source = Array.from({ length: 2100 }, (_, i) => `old${i}`).join('\n');
        const target = Array.from({ length: 2100 }, (_, i) => `new${i}`).join('\n');
        expect(mapBlameLines(source, target).size).toBe(0);
    });
});
