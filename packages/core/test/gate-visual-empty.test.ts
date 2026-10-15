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

  it('leaves the words of a cell that is a picture with no text at all as typed (nothing can be looked in), and still refuses an empty string', async () => {
    const book = buildSpanBook();
    const dir = await mkdtemp(join(tmpdir(), 'mcprep-visual-picture-'));
    folders.push(dir);
    await writeFile(join(dir, 'book.pdf'), book.pdf);
    const doc = await PdfDocument.fromBytes(book.pdf);
    const base = newProject({ pdf: { path: 'book.pdf', sha256: doc.sha256, bytes: doc.bytes, pageCount: book.pageCount }, title: 'Span' });
    await doc.close();
    // The first exercise framed on a blank corner of its page: no text in the region and no line coming into it.
    const first = book.frames[0];
    if (first === undefined) throw new Error('the span book has no exercise');
    const { context: _context, solution: _solution, ...bare } = first;
    const corner = { ...bare, rect: { left: 0.9, top: 0.97, right: 0.99, bottom: 0.995 } };
    const only: Project = { ...base, outline: { source: 'manual', entries: book.outline }, frames: [corner], seq: 10 };
    await writeFile(join(dir, 'book.mcprep.json'), `${JSON.stringify(only)}\n`);
    const ref = `${String(corner.section)}:${String(corner.label)}`;
    const entry = (startsWith: string): string => JSON.stringify([{ ref, startsWith, instruction: false, answerStartsWith: '', ok: true }]);
    await writeFile(join(dir, 'visual.json'), entry('4'));
    const typed = await checkVisual(await ProjectSession.open(join(dir, 'book.mcprep.json')), join(dir, 'visual.json'), []);
    expect(typed.findings.filter((finding) => finding.code === 'visual-mismatch')).toEqual([]);
    await writeFile(join(dir, 'visual.json'), entry(''));
    const blank = await checkVisual(await ProjectSession.open(join(dir, 'book.mcprep.json')), join(dir, 'visual.json'), []);
    expect(blank.findings.some((finding) => finding.code === 'visual-mismatch' && finding.message.includes('empty'))).toBe(true);
  });
});
