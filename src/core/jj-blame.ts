/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { diffArrays } from 'diff';
import { z } from 'zod';
import { buildLogTemplate } from './jj-template-builder';

export const MAX_BLAME_BYTES = 1024 * 1024;
export const MAX_BLAME_LINES = 20_000;

export const JjAnnotationSchema = z.object({
    line: z.number().int().positive(),
    content: z.string(),
    commitId: z.string(),
    changeId: z.string(),
    author: z.string(),
    email: z.string(),
    timestamp: z.string(),
    description: z.string(),
});
export type JjAnnotation = z.infer<typeof JjAnnotationSchema>;

export interface JjFileBlame {
    commitId: string;
    annotations: readonly JjAnnotation[];
    content: string;
}

export const ANNOTATION_TEMPLATE = buildLogTemplate({
    line: { type: 'raw', expr: 'line_number' },
    content: { type: 'json', expr: 'stringify(content)' },
    commitId: { type: 'json', expr: 'commit.commit_id()' },
    changeId: { type: 'json', expr: 'commit.change_id()' },
    author: { type: 'json', expr: 'commit.author().name()' },
    email: { type: 'json', expr: 'commit.author().email()' },
    timestamp: { type: 'timestamp', expr: 'commit.author().timestamp()' },
    description: { type: 'json', expr: 'commit.description()' },
});

function lines(text: string): string[] {
    const result = text.split(/\r?\n/);
    if (result.at(-1) === '') {
        result.pop();
    }
    return result;
}

/** Maps only unchanged lines; changed lines must never inherit somebody else's attribution. */
export function mapBlameLines(snapshot: string, document: string): Map<number, number> {
    const mapping = new Map<number, number>();
    let source = 0;
    let target = 0;
    const changes = diffArrays(lines(snapshot), lines(document), { maxEditLength: 2000 });
    if (!changes) {
        return mapping;
    }
    for (const change of changes) {
        if (!change.added && !change.removed) {
            for (let offset = 0; offset < change.count; offset++) {
                mapping.set(target + offset, source + offset);
            }
        }
        if (!change.added) {
            source += change.count;
        }
        if (!change.removed) {
            target += change.count;
        }
    }
    return mapping;
}
