import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Frame, Region } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import { newProject, type Project } from '../src/project/model.js';
import { ProjectSession } from '../src/session.js';
import { SHEET_DEFAULTS, pagesCaption, planSheets, renderSheets, sheetHash, sheetHeight } from '../src/sheets/sheets.js';
import { buildSpanBook } from '../src/testing/span.js';

const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The span book as a project on disk, its third exercise changed by `change`, and a session on it. */
async function session(change: (frames: Frame[]) => Frame[] = (frames) => frames): Promise<{ session: ProjectSession; dir: string }> {
  const book = buildSpanBook();
  const dir = await mkdtemp(join(tmpdir(), 'mcprep-sheets-'));
  folders.push(dir);
  await writeFile(join(dir, 'book.pdf'), book.pdf);
  const doc = await PdfDocument.fromBytes(book.pdf);
  const base = newProject({ pdf: { path: 'book.pdf', sha256: doc.sha256, bytes: doc.bytes, pageCount: book.pageCount }, title: 'Span' });
  await doc.close();
  const project: Project = { ...base, outline: { source: 'manual', entries: book.outline }, frames: change(book.frames), seq: 10 };
  await writeFile(join(dir, 'book.mcprep.json'), `${JSON.stringify(project)}\n`);
  return { session: await ProjectSession.open(join(dir, 'book.mcprep.json')), dir };
}

const pngHeight = (bytes: Uint8Array): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);

describe('the captions of the cells', () => {
  it('give the pages of every region of an exercise: p. 1, 2-3', () => {
    expect(pagesCaption([1, 2, 3])).toBe('p. 1-3');
    expect(pagesCaption([3, 1, 2, 1])).toBe('p. 1-3');
    expect(pagesCaption([1, 3])).toBe('p. 1, 3');
    expect(pagesCaption([1, 2, 3, 5, 7, 8])).toBe('p. 1-3, 5, 7-8');
    expect(pagesCaption([4])).toBe('p. 4');
  });
});

describe('the sheets of a book', () => {
  it('put the cells in the order of the book, a sheet closed at perSheet cells, and say what each shows with a hash', async () => {
    const { session: open } = await session();
    try {
      const plan = await planSheets(open, { scope: 'all', perSheet: 2 });
      expect(plan.manifest.sheets.map((sheet) => sheet.refs)).toEqual([['0.1:1', '0.1:2'], ['0.1:3', '0.1:4'], ['0.1:5']]);
      expect(plan.manifest).toMatchObject({ scope: 'all', perSheet: 2, solutions: false, cellWidth: 740, heightCap: 2600, maxHeight: 6000, exercises: 5 });
      expect(plan.manifest.sheets[1]?.pages).toEqual([0, 1, 2]);
      const frames = open.project.frames;
      expect(plan.manifest.sheets[0]?.hash).toBe(sheetHash([frames[0] as Frame, frames[1] as Frame], false));
      // The same project gives the same plan.
      expect((await planSheets(open, { scope: 'all', perSheet: 2 })).manifest).toEqual(plan.manifest);
    } finally {
      await open.close();
    }
  });

  it('start a new sheet before a cell would make the sheet taller than the cap, whatever perSheet says', async () => {
    const { session: open } = await session();
    try {
      // Exercise 3 spans three pages: with the others in a sheet of 50 cells it still has the cap to keep.
      const plan = await planSheets(open, { scope: 'all', perSheet: 50 });
      for (const sheet of plan.manifest.sheets) expect(sheet.height, `sheet ${sheet.number}`).toBeLessThanOrEqual(SHEET_DEFAULTS.heightCap);
      expect(plan.manifest.sheets.flatMap((sheet) => sheet.refs)).toEqual(['0.1:1', '0.1:2', '0.1:3', '0.1:4', '0.1:5']);
      expect(sheetHeight([100, 50, 80])).toBe(8 + 100 + 8 + 80 + 8);
    } finally {
      await open.close();
    }
  });

  it('give a cell taller than the cap a sheet of its own, and draw one taller than the most a sheet may be smaller, saying so', async () => {
    const full: Region = { page: 1, rect: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.95 } };
    const { session: open } = await session((frames) => frames.map((frame) => (frame.label === '3' ? { ...frame, continues: Array.from({ length: 8 }, () => ({ ...full })) } : frame)));
    try {
      const plan = await planSheets(open, { scope: 'all', perSheet: 50 });
      const tall = plan.manifest.sheets.find((sheet) => sheet.refs.includes('0.1:3'));
      expect(tall).toMatchObject({ refs: ['0.1:3'], tall: true, height: 6000 });
      expect(tall?.scaled).toBeGreaterThan(0.5);
      expect(tall?.scaled).toBeLessThan(1);
      // The others are not on that sheet, and keep to the cap.
      for (const sheet of plan.manifest.sheets) if (sheet !== tall) expect(sheet.height).toBeLessThanOrEqual(SHEET_DEFAULTS.heightCap);
      const dir = await mkdtemp(join(tmpdir(), 'mcprep-sheets-out-'));
      folders.push(dir);
      await renderSheets(open, plan, { outDir: dir, only: (number) => number === tall?.number });
      const height = pngHeight(new Uint8Array(await readFile(join(dir, tall?.file as string))));
      expect(Math.abs(height - 6000)).toBeLessThan(80);
      // The manifest lists every sheet, though only one was drawn.
      expect(JSON.parse(await readFile(join(dir, 'sheets.json'), 'utf8')).sheets).toHaveLength(plan.manifest.sheets.length);
    } finally {
      await open.close();
    }
  });

  it('are drawn as tall as they were planned, within a few pixels, with and without the answers', async () => {
    const { session: open } = await session();
    try {
      const plan = await planSheets(open, { scope: 'all', perSheet: 12, solutions: true });
      const dir = await mkdtemp(join(tmpdir(), 'mcprep-sheets-out-'));
      folders.push(dir);
      await renderSheets(open, plan, { outDir: dir });
      for (const sheet of plan.manifest.sheets) {
        const height = pngHeight(new Uint8Array(await readFile(join(dir, sheet.file))));
        expect(Math.abs(height - sheet.height), `sheet ${sheet.number}`).toBeLessThan(0.02 * sheet.height + 30);
      }
    } finally {
      await open.close();
    }
  });
});
