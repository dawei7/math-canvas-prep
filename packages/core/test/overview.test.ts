import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PdfDocument } from '../src/pdf/document.js';
import { overlayFont } from '../src/pdf/render.js';
import {
  OVERVIEW_DEFAULTS,
  OVERVIEW_FILE,
  OVERVIEW_FORMAT,
  formatOverviewManifest,
  overviewFileName,
  planOverview,
  renderOverview,
  type OverviewManifest,
  type OverviewOptions,
} from '../src/sheets/overview.js';
import { STRUCTURE_PAGE, STRUCTURE_TAB, buildStructureBook, structureMarker } from '../src/testing/structure-book.js';
import { buildPdf, type PdfPageSpec } from '../src/testing/pdf-writer.js';

const folders: string[] = [];
const documents: PdfDocument[] = [];

afterAll(async () => {
  for (const doc of documents) await doc.close();
  for (const folder of folders) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'mcprep-overview-'));
  folders.push(made);
  return made;
}

async function open(bytes: Uint8Array): Promise<PdfDocument> {
  const doc = await PdfDocument.fromBytes(bytes);
  documents.push(doc);
  return doc;
}

interface Decoded {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A PNG file as pixels. */
async function decode(path: string): Promise<Decoded> {
  const image = await loadImage(await readFile(path));
  const canvas = createCanvas(image.width, image.height);
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: g.getImageData(0, 0, image.width, image.height).data };
}

/** The grey value (the red channel; every page here is grey) of a pixel. */
const grey = (image: Decoded, x: number, y: number): number => image.data[(y * image.width + x) * 4] as number;

/** Where the cell of the page in position `at` of its sheet is, and where its picture is. */
function cellOf(manifest: OverviewManifest, at: number): { x: number; y: number; picture: { left: number; top: number; width: number; height: number } } {
  const x = manifest.gap + (at % manifest.columns) * (manifest.cellWidth + manifest.gap);
  const y = manifest.gap + Math.floor(at / manifest.columns) * (manifest.cellHeight + manifest.gap);
  return { x, y, picture: { left: x + 1, top: y + manifest.captionHeight + 1, width: manifest.cellWidth - 2, height: manifest.cellHeight - manifest.captionHeight - 2 } };
}

/** The grey of the tab of the page `at` in its cell: found where the tab is, in page fractions, in the picture. */
function tabGrey(image: Decoded, manifest: OverviewManifest, at: number, page = STRUCTURE_PAGE): number {
  const { picture } = cellOf(manifest, at);
  const x = picture.left + Math.round(((STRUCTURE_TAB.x + STRUCTURE_TAB.width / 2) / page.width) * picture.width);
  const y = picture.top + Math.round(((STRUCTURE_TAB.y + STRUCTURE_TAB.height / 2) / page.height) * picture.height);
  return grey(image, x, y);
}

/** A piece of the caption strip of a cell, as the grey values of its pixels. */
function captionOf(image: Decoded, manifest: OverviewManifest, at: number): number[] {
  const { x, y } = cellOf(manifest, at);
  const values: number[] = [];
  for (let row = y + 2; row < y + manifest.captionHeight - 2; row += 1) for (let column = x + 2; column < x + 60; column += 1) values.push(grey(image, column, row));
  return values;
}

/** The same strip as `captionOf` reads, for a caption drawn on its own: what the cell must show for the page the text names. */
async function drawnCaption(text: string, manifest: OverviewManifest): Promise<number[]> {
  const family = await overlayFont();
  const canvas = createCanvas(manifest.cellWidth, manifest.captionHeight);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, manifest.cellWidth, manifest.captionHeight);
  g.font = `bold 15px "${family}"`;
  g.textBaseline = 'middle';
  g.fillStyle = '#1a1a1a';
  g.fillText(text, 2, manifest.captionHeight / 2);
  const data = g.getImageData(0, 0, manifest.cellWidth, manifest.captionHeight).data;
  const values: number[] = [];
  for (let row = 2; row < manifest.captionHeight - 2; row += 1) for (let column = 2; column < 60; column += 1) values.push(data[(row * manifest.cellWidth + column) * 4] as number);
  return values;
}
/** A book of full-page grey pages of the given sizes: the grey of page n is `structureMarker(n)`. */
function greyBook(sizes: { width: number; height: number }[]): Uint8Array {
  const pages: PdfPageSpec[] = sizes.map((size, index) => ({ ...size, boxes: [{ x: 0, y: 0, w: size.width, h: size.height, fill: structureMarker(index) / 255 }] }));
  return buildPdf({ pages });
}

const LETTER = { width: 612, height: 792 };
const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 3;

describe('the plan of the overview sheets', () => {
  it('puts the pages of the range on sheets in the order of the book, eight to a sheet in four columns, and says how big everything is', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const { manifest, notes } = await planOverview(doc);
    expect(notes).toEqual([]);
    expect(manifest).toMatchObject({ format: OVERVIEW_FORMAT, version: 1, pageCount: 20, from: 0, to: 19, perSheet: 8, columns: 4, pageSize: LETTER, gap: 8, captionHeight: 22 });
    expect(manifest.sheets.map((sheet) => sheet.pages)).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11, 12, 13, 14, 15],
      [16, 17, 18, 19],
    ]);
    expect(manifest.sheets.map((sheet) => sheet.file)).toEqual(['overview-0001.png', 'overview-0002.png', 'overview-0003.png']);
    expect(manifest.sheets.map((sheet) => sheet.number)).toEqual([1, 2, 3]);
    // A cell is 380 pixels wide, a page 378 inside its border, and its height follows the page; a sheet is four cells and the white round and between them.
    expect(manifest.cellWidth).toBe(OVERVIEW_DEFAULTS.cellWidth);
    expect(manifest.cellHeight).toBe(22 + 490 + 2);
    expect(manifest.scale).toBeCloseTo(378 / 612, 6);
    expect(manifest.sheets[0]).toMatchObject({ width: 8 + 4 * (380 + 8), height: 8 + 2 * (514 + 8) });
    // The last sheet has one row only.
    expect(manifest.sheets[2]).toMatchObject({ width: 1560, height: 8 + 514 + 8 });
  });

  it('draws a range of pages, a number of pages and of columns, and no sheet wider than its pages', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const range = await planOverview(doc, { from: 5, to: 12, perSheet: 3, columns: 2 });
    expect(range.manifest).toMatchObject({ from: 5, to: 12, perSheet: 3, columns: 2 });
    expect(range.manifest.sheets.map((sheet) => sheet.pages)).toEqual([[5, 6, 7], [8, 9, 10], [11, 12]]);
    expect(range.manifest.sheets[0]).toMatchObject({ width: 8 + 2 * 388, height: 8 + 2 * 522 });
    expect(range.manifest.sheets[2]).toMatchObject({ width: 8 + 2 * 388, height: 8 + 1 * 522 });
    // Fewer pages than columns: the sheet is as wide as the pages are many.
    const few = await planOverview(doc, { from: 3, to: 4 });
    expect(few.manifest.columns).toBe(2);
    expect(few.manifest.sheets).toHaveLength(1);
    expect(few.manifest.sheets[0]?.width).toBe(8 + 2 * 388);
    const wide = await planOverview(doc, { perSheet: 2 });
    expect(wide.manifest.columns).toBe(2);
    expect(wide.manifest.sheets).toHaveLength(10);
  });

  it('takes the scale from the option and makes the cell for it', async () => {
    const doc = await open(buildStructureBook(4).pdf);
    const { manifest } = await planOverview(doc, { scale: 0.5 });
    expect(manifest.scale).toBe(0.5);
    expect(manifest.cellWidth).toBe(306 + 2);
    expect(manifest.cellHeight).toBe(22 + 396 + 2);
  });

  it('makes the cells for the size that most pages have, not for the cover', async () => {
    const sizes = [{ width: 792, height: 612 }, ...Array.from({ length: 9 }, () => LETTER)];
    const doc = await open(greyBook(sizes));
    const { manifest } = await planOverview(doc);
    expect(manifest.pageSize).toEqual(LETTER);
    expect(manifest.cellHeight).toBe(22 + 490 + 2);
  });

  it('says what is wrong with a range that has no pages or an option out of range, with the exit code of a usage error', async () => {
    const doc = await open(buildStructureBook(10).pdf);
    const refused = async (options: OverviewOptions): Promise<{ code: string; message: string }> => {
      const error = (await planOverview(doc, options).then(
        () => undefined,
        (reason: unknown) => reason,
      )) as { code: string; message: string } | undefined;
      expect(error, JSON.stringify(options)).toBeDefined();
      return error as { code: string; message: string };
    };
    expect(await refused({ from: 6, to: 3 })).toMatchObject({ code: 'E_USAGE', message: expect.stringContaining('The range of pages is empty: --from 6 is after --to 3') as string });
    const past = await refused({ from: 10 });
    expect(past.code).toBe('E_USAGE');
    expect(past.message).toContain('--from 10 is past the last page: this PDF has 10 pages (zero-based 0..9)');
    expect((await refused({ from: -1 })).message).toContain('--from must be a whole number from 0, not -1');
    expect((await refused({ from: 1.5 })).message).toContain('not 1.5');
    expect((await refused({ to: -2 })).message).toContain('--to must be a whole number from 0');
    expect((await refused({ perSheet: 0 })).message).toContain('--per-sheet must be a whole number from 1 to 12, not 0');
    expect((await refused({ perSheet: 13 })).message).toContain('from 1 to 12, not 13');
    expect((await refused({ columns: 0 })).message).toContain('--columns must be a whole number from 1 to 12');
    expect((await refused({ scale: 0.1 })).message).toContain('--scale must be a number of pixels per point from 0.2 to 2, not 0.1');
    expect((await refused({ scale: Number.NaN })).message).toContain('--scale');
  });

  it('refuses a sheet that would be far too large', async () => {
    const doc = await open(greyBook(Array.from({ length: 4 }, () => ({ width: 1800, height: 2400 }))));
    const error = (await planOverview(doc, { scale: 2, perSheet: 4, columns: 2 }).then(
      () => undefined,
      (reason: unknown) => reason,
    )) as { code: string; message: string; hint?: string } | undefined;
    expect(error?.code).toBe('E_USAGE');
    expect(error?.message).toContain('A sheet would be 7228 x 9672 pixels, which is too large');
    expect(error?.hint).toContain('--per-sheet');
  });

  it('cuts a last page past the end back to the last page and says so', async () => {
    const doc = await open(buildStructureBook(10).pdf);
    const { manifest, notes } = await planOverview(doc, { from: 4, to: 99 });
    expect(manifest.to).toBe(9);
    expect(manifest.sheets.flatMap((sheet) => sheet.pages)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(notes).toEqual(['--to 99 is past the last page; the range ends at page 9 (this PDF has 10 pages).']);
  });

  it('says so when a sheet is larger than a model takes in whole', async () => {
    const doc = await open(buildStructureBook(12).pdf);
    expect((await planOverview(doc)).notes).toEqual([]);
    const { notes } = await planOverview(doc, { perSheet: 12 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('1560 x 1574');
    expect(notes[0]).toContain('reduced before a model sees it');
    const big = await planOverview(doc, { perSheet: 12, columns: 3 });
    expect(big.notes[0]).toContain('1172 x 2096');
  });

  it('is the same plan every time, written as the same text, with a line for each sheet', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const first = formatOverviewManifest((await planOverview(doc)).manifest);
    const second = formatOverviewManifest((await planOverview(doc)).manifest);
    expect(second).toBe(first);
    const lines = first.split('\n');
    expect(lines.filter((line) => line.startsWith('  {"number"'))).toHaveLength(3);
    expect(lines[lines.length - 2]).toBe('}');
    expect(first.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(first) as OverviewManifest;
    expect(parsed.sheets[1]).toEqual({ number: 2, file: overviewFileName(2), pages: [8, 9, 10, 11, 12, 13, 14, 15], width: 1560, height: 1052 });
    expect(Object.keys(parsed).slice(0, 4)).toEqual(['format', 'version', 'pageCount', 'from']);
  });
});

describe('drawing the overview sheets', () => {
  it('puts every page in its own cell, in reading order, at the same place in every sheet', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const out = await folder();
    const plan = await planOverview(doc);
    const result = await renderOverview(doc, plan, { outDir: out });
    expect(result).toEqual({ drawn: [1, 2, 3], failed: [], unlisted: [] });
    expect((await readdir(out)).sort()).toEqual(['overview-0001.png', 'overview-0002.png', 'overview-0003.png', OVERVIEW_FILE]);
    for (const sheet of plan.manifest.sheets) {
      const image = await decode(join(out, sheet.file));
      expect([image.width, image.height]).toEqual([sheet.width, sheet.height]);
      for (const [at, page] of sheet.pages.entries()) {
        expect(near(tabGrey(image, plan.manifest, at), structureMarker(page)), `page ${page} in cell ${at} of sheet ${sheet.number}: ${tabGrey(image, plan.manifest, at)} is not ${structureMarker(page)}`).toBe(true);
      }
    }
  });

  it('writes the caption of a page above it, "p. N", the same wherever the page lies, and a thin border round the picture', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const full = await folder();
    const planFull = await planOverview(doc);
    await renderOverview(doc, planFull, { outDir: full });
    const single = await folder();
    const planSingle = await planOverview(doc, { from: 5, to: 5 });
    await renderOverview(doc, planSingle, { outDir: single });
    const fullImage = await decode(join(full, 'overview-0001.png'));
    const singleImage = await decode(join(single, 'overview-0001.png'));
    // Page 5 is the sixth cell of the first sheet (second row, second column) and the only one of the other: its caption is the same pixels.
    expect(captionOf(fullImage, planFull.manifest, 5)).toEqual(captionOf(singleImage, planSingle.manifest, 0));
    expect(captionOf(fullImage, planFull.manifest, 5)).not.toEqual(captionOf(fullImage, planFull.manifest, 6));
    // The text of every caption is "p. " and the zero-based number of its page: the pixels are those of the same text drawn by itself.
    for (let at = 0; at < 8; at += 1) expect(captionOf(fullImage, planFull.manifest, at), `the caption of cell ${at}`).toEqual(await drawnCaption(`p. ${at}`, planFull.manifest));
    expect(captionOf(fullImage, planFull.manifest, 5)).not.toEqual(await drawnCaption('p. 6', planFull.manifest));
    // The caption has ink in it, and the white round it stays white.
    const strip = captionOf(fullImage, planFull.manifest, 5);
    expect(Math.min(...strip)).toBeLessThan(80);
    const cell = cellOf(planFull.manifest, 5);
    expect(grey(fullImage, cell.x - 3, cell.y + 5)).toBe(255);
    // The border: a mid-grey line one pixel outside the picture, white beyond it.
    const middle = cell.picture.top + 200;
    expect(grey(fullImage, cell.picture.left - 1, middle)).toBe(128);
    expect(grey(fullImage, cell.picture.left + cell.picture.width, middle)).toBe(128);
    expect(grey(fullImage, cell.picture.left - 2, middle)).toBe(255);
    expect(grey(fullImage, cell.picture.left + 40, cell.picture.top - 1)).toBe(128);
    expect(grey(fullImage, cell.picture.left + 40, cell.picture.top + cell.picture.height)).toBe(128);
    expect(grey(fullImage, cell.picture.left + 40, cell.picture.top + cell.picture.height + 1)).toBe(255);
  });

  it('draws only the sheets it is asked for and still lists all of them in overview.json', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const out = await folder();
    const plan = await planOverview(doc);
    const result = await renderOverview(doc, plan, { outDir: out, only: (number) => number === 2 });
    expect(result.drawn).toEqual([2]);
    expect((await readdir(out)).sort()).toEqual(['overview-0002.png', OVERVIEW_FILE]);
    const listed = JSON.parse(await readFile(join(out, OVERVIEW_FILE), 'utf8')) as OverviewManifest;
    expect(listed.sheets.map((sheet) => sheet.file)).toEqual(['overview-0001.png', 'overview-0002.png', 'overview-0003.png']);
    const later = await renderOverview(doc, plan, { outDir: out, only: (number) => number >= 3 });
    expect(later.drawn).toEqual([3]);
    expect((await readdir(out)).sort()).toEqual(['overview-0002.png', 'overview-0003.png', OVERVIEW_FILE]);
    const progress: [number, number][] = [];
    await renderOverview(doc, plan, { outDir: out, only: (number) => number !== 2, onSheet: (done, total) => progress.push([done, total]) });
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it('leaves the cells that a last sheet does not need white, and the sheet shorter', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const out = await folder();
    const plan = await planOverview(doc, { perSheet: 6, columns: 3 });
    expect(plan.manifest.sheets.map((sheet) => sheet.pages.length)).toEqual([6, 6, 6, 2]);
    await renderOverview(doc, plan, { outDir: out });
    const last = await decode(join(out, plan.manifest.sheets[3]?.file as string));
    expect(last.height).toBe(8 + 1 * (plan.manifest.cellHeight + 8));
    expect(last.height).toBeLessThan(plan.manifest.sheets[0]?.height as number);
    expect(near(tabGrey(last, plan.manifest, 0), structureMarker(18))).toBe(true);
    expect(near(tabGrey(last, plan.manifest, 1), structureMarker(19))).toBe(true);
    // The place of a third page is white from the caption to the bottom of the cell.
    const empty = cellOf(plan.manifest, 2);
    for (const y of [empty.y + 3, empty.picture.top + 100, empty.picture.top + empty.picture.height]) expect(grey(last, empty.x + 100, y), `row ${y}`).toBe(255);
  });

  it('fits a page of another size into the cell instead of stretching it, under its caption and inside its own border', async () => {
    const doc = await open(greyBook([{ width: 792, height: 612 }, ...Array.from({ length: 5 }, () => LETTER)]));
    const out = await folder();
    const plan = await planOverview(doc);
    await renderOverview(doc, plan, { outDir: out });
    const image = await decode(join(out, 'overview-0001.png'));
    const cell = cellOf(plan.manifest, 0);
    const { left, top, width, height } = cell.picture;
    // The landscape page is as wide as the cell and 293 pixels tall (378 / 792 of its 612 points), hung under the caption.
    expect(near(grey(image, left + width / 2, top + 100), structureMarker(0))).toBe(true);
    expect(grey(image, left + width / 2, top + 290)).toBeLessThan(200);
    expect(grey(image, left + width / 2, top + 293)).toBe(128);
    expect(grey(image, left + width / 2, top + 294)).toBe(255);
    expect(grey(image, left + width / 2, top + height - 2)).toBe(255);
    // A page of the usual size next to it fills its cell.
    const next = cellOf(plan.manifest, 1);
    expect(near(grey(image, next.picture.left + 10, next.picture.top + next.picture.height - 3), structureMarker(1))).toBe(true);
  });

  it('writes the same files for the same book and options', async () => {
    const doc = await open(buildStructureBook(11).pdf);
    const one = await folder();
    const two = await folder();
    await renderOverview(doc, await planOverview(doc, { perSheet: 6 }), { outDir: one });
    await renderOverview(doc, await planOverview(doc, { perSheet: 6 }), { outDir: two });
    const names = (await readdir(one)).sort();
    expect(names).toEqual((await readdir(two)).sort());
    expect(names).toEqual(['overview-0001.png', 'overview-0002.png', OVERVIEW_FILE]);
    for (const name of names) expect(Buffer.compare(await readFile(join(one, name)), await readFile(join(two, name))), name).toBe(0);
    // The text does not depend on which sheets were drawn.
    const three = await folder();
    await renderOverview(doc, await planOverview(doc, { perSheet: 6 }), { outDir: three, only: (number) => number === 2 });
    expect(await readFile(join(three, OVERVIEW_FILE), 'utf8')).toBe(await readFile(join(one, OVERVIEW_FILE), 'utf8'));
  });

  it('goes on after a page that cannot be drawn, says which, and puts a cell that says so in its place', async () => {
    const doc = await open(buildStructureBook(6).pdf);
    const original = doc.rawPage.bind(doc);
    vi.spyOn(doc, 'rawPage').mockImplementation((index: number) => {
      if (index === 2) return Promise.reject(new Error('the page is damaged\nsecond line of the reason'));
      return original(index);
    });
    const out = await folder();
    const plan = await planOverview(doc);
    expect(plan.manifest.pageCount).toBe(6);
    const result = await renderOverview(doc, plan, { outDir: out });
    expect(result.failed).toEqual([{ page: 2, message: 'the page is damaged' }]);
    expect(result.drawn).toEqual([1]);
    const image = await decode(join(out, 'overview-0001.png'));
    expect(near(tabGrey(image, plan.manifest, 1), structureMarker(1))).toBe(true);
    expect(near(tabGrey(image, plan.manifest, 3), structureMarker(3))).toBe(true);
    const cell = cellOf(plan.manifest, 2);
    // A light grey cell with its border, and some red lettering in it.
    expect(grey(image, cell.picture.left + 5, cell.picture.top + 5)).toBe(238);
    let ink = 0;
    for (let y = cell.picture.top; y < cell.picture.top + cell.picture.height; y += 1) for (let x = cell.picture.left; x < cell.picture.left + cell.picture.width; x += 1) if (grey(image, x, y) < 200) ink += 1;
    expect(ink).toBeGreaterThan(50);
  });

  it('keeps the words of a cell that cannot be drawn inside the cell, however small the cells are', async () => {
    const doc = await open(buildStructureBook(4).pdf);
    const original = doc.rawPage.bind(doc);
    vi.spyOn(doc, 'rawPage').mockImplementation((index: number) => (index === 1 ? Promise.reject(new Error('damaged')) : original(index)));
    const out = await folder();
    const plan = await planOverview(doc, { scale: 0.2 });
    expect(plan.manifest.cellWidth).toBe(Math.ceil(612 * 0.2) + 2);
    await renderOverview(doc, plan, { outDir: out });
    const image = await decode(join(out, 'overview-0001.png'));
    const cell = cellOf(plan.manifest, 1);
    // The white between this cell and its neighbours is still white from the top of the picture to its bottom.
    for (const x of [cell.x - 1, cell.x - plan.manifest.gap, cell.x + plan.manifest.cellWidth, cell.x + plan.manifest.cellWidth + plan.manifest.gap - 1]) {
      for (let y = cell.picture.top; y < cell.picture.top + cell.picture.height; y += 1) expect(grey(image, x, y), `x ${x}, y ${y}`).toBe(255);
    }
  });

  it('writes overview.json before the first sheet is drawn, so that a run that is cut off leaves the list of the sheets', async () => {
    const doc = await open(buildStructureBook(20).pdf);
    const out = await folder();
    const seen: string[][] = [];
    await renderOverview(doc, await planOverview(doc), { outDir: out, onSheet: () => seen.push(readdirSync(out).sort()) });
    expect(seen[0]).toEqual(['overview-0001.png', OVERVIEW_FILE]);
    expect(seen[2]).toEqual(['overview-0001.png', 'overview-0002.png', 'overview-0003.png', OVERVIEW_FILE]);
  });

  it('names the sheets of an earlier run that overview.json does not list', async () => {
    const doc = await open(buildStructureBook(4).pdf);
    const out = await folder();
    await writeFile(join(out, 'overview-0007.png'), 'left over');
    await writeFile(join(out, 'notes.txt'), 'not a sheet');
    const result = await renderOverview(doc, await planOverview(doc), { outDir: out });
    expect(result.unlisted).toEqual(['overview-0007.png']);
    expect(await readFile(join(out, 'overview-0007.png'), 'utf8')).toBe('left over');
  });

  it('cannot draw into a folder that is a file, and says so with the code of a file that cannot be written', async () => {
    const doc = await open(buildStructureBook(2).pdf);
    const out = await folder();
    await writeFile(join(out, 'taken'), 'a file');
    const error = (await renderOverview(doc, await planOverview(doc), { outDir: join(out, 'taken') }).then(
      () => undefined,
      (reason: unknown) => reason,
    )) as { code: string; message: string } | undefined;
    expect(error?.code).toBe('E_WRITE');
    expect(error?.message).toContain('Cannot create the folder');
  });
});
