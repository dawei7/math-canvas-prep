import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkVisual } from '../src/gate/visual.js';
import { PdfDocument } from '../src/pdf/document.js';
import { newProject, type Project } from '../src/project/model.js';
import { ProjectSession } from '../src/session.js';
import { buildSpanBook } from '../src/testing/span.js';

const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('the visual record of a book that prints no exercise', () => {
  it('is exhaustive with an empty list of entries (the survey record and the census prove that there is nothing to look at), and not with a missing entry', async () => {
    const book = buildSpanBook();
    const dir = await mkdtemp(join(tmpdir(), 'mcprep-visual-empty-'));
    folders.push(dir);
    await writeFile(join(dir, 'book.pdf'), book.pdf);
    const doc = await PdfDocument.fromBytes(book.pdf);
    const base = newProject({ pdf: { path: 'book.pdf', sha256: doc.sha256, bytes: doc.bytes, pageCount: book.pageCount }, title: 'Span' });
    await doc.close();
    const none: Project = { ...base, outline: { source: 'manual', entries: book.outline }, frames: [], seq: 1 };
    await writeFile(join(dir, 'book.mcprep.json'), `${JSON.stringify(none)}\n`);
    await writeFile(join(dir, 'visual.json'), '[]');
    const empty = await checkVisual(await ProjectSession.open(join(dir, 'book.mcprep.json')), join(dir, 'visual.json'), []);
    expect(empty.summary).toMatchObject({ entries: 0, exercises: 0, missing: 0, exhaustive: true });
    expect(empty.findings).toEqual([]);
    // With an exercise and no entry for it, the record is not exhaustive.
    const some: Project = { ...base, outline: { source: 'manual', entries: book.outline }, frames: book.frames, seq: 10 };
    await writeFile(join(dir, 'book.mcprep.json'), `${JSON.stringify(some)}\n`);
    const missing = await checkVisual(await ProjectSession.open(join(dir, 'book.mcprep.json')), join(dir, 'visual.json'), []);
    expect(missing.summary.exhaustive).toBe(false);
    expect(missing.summary.missing).toBeGreaterThan(0);
  });
});
