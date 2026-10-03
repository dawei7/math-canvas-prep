import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INK_BANDS } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import { renderPage, renderRegion } from '../src/pdf/render.js';
import { McPrepError } from '../src/rules/issues.js';
import { buildPdf, A4 } from '../src/testing/pdf-writer.js';
import { buildSampleSheet } from '../src/testing/sample.js';
import { tempDir } from './helpers.js';

const isPng = (bytes: Uint8Array): boolean => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
const pngSize = (bytes: Uint8Array): { width: number; height: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe('the synthetic sample', () => {
  const sample = buildSampleSheet();
  let doc: PdfDocument;
  beforeAll(async () => {
    doc = await PdfDocument.fromBytes(sample.pdf);
  });
  afterAll(async () => {
    await doc.close();
  });

  it('has three A4 pages and a stable hash', async () => {
    expect(doc.pageCount).toBe(3);
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await doc.pageSize(0)).toEqual({ width: 595, height: 842, rotation: 0 });
    expect(buildSampleSheet().pdf).toEqual(sample.pdf);
  });

  it('reads lines in reading order with page-fraction boxes', async () => {
    const text = await doc.pageText(0);
    expect(text.hasText).toBe(true);
    expect(text.columns).toBe(1);
    const tops = text.lines.map((line) => line.rect.top);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    const exercise = text.lines.find((line) => line.text.startsWith('Exercise 1.'));
    expect(exercise?.rect.left).toBeCloseTo(72 / 595, 3);
    // Baseline at 200 pt from the top; the box spans the font's ascent above it and descent below it.
    expect(exercise?.rect.top).toBeGreaterThan((200 - 11) / 842);
    expect(exercise?.rect.top).toBeLessThan((200 - 7) / 842);
    expect(exercise?.rect.bottom).toBeGreaterThan(200 / 842);
    expect(exercise?.rect.bottom).toBeLessThan((200 + 4) / 842);
    expect(exercise?.fontSize).toBe(11);
    const title = text.lines.find((line) => line.text === 'Calculus Sheet 1');
    expect(title?.fontSize).toBe(20);
  });

  it('marks the running header and footer', async () => {
    const text = await doc.pageText(1);
    const marked = text.lines.filter((line) => line.headerFooter === true).map((line) => line.text);
    expect(marked).toEqual(['Sample University - Calculus I', 'Page 2 of 3']);
  });

  it('tells bold lines when fonts are requested', async () => {
    const plain = await doc.pageText(0);
    expect(plain.lines.some((line) => line.bold !== undefined)).toBe(false);
    const withFonts = await doc.pageText(0, { fonts: true });
    expect(withFonts.lines.find((line) => line.text === 'Calculus Sheet 1')?.bold).toBe(true);
    expect(withFonts.lines.find((line) => line.text.startsWith('Exercise 1.'))?.bold).toBe(false);
  });

  it('reads the outline with depth and zero-based pages', async () => {
    expect(await doc.outline()).toEqual(sample.outline);
  });

  it('rejects a page that does not exist, naming the range', async () => {
    await expect(doc.pageText(3)).rejects.toMatchObject({ code: 'E_PAGE' });
    await expect(doc.pageText(-1)).rejects.toBeInstanceOf(McPrepError);
    await expect(doc.pageText(1.5)).rejects.toBeInstanceOf(McPrepError);
  });

  it('has an ink profile that finds the figure and leaves blank space blank', async () => {
    const ink = await doc.inkProfile(2);
    expect(ink).toHaveLength(INK_BANDS);
    const at = (y: number): number => ink[Math.floor(y * INK_BANDS)] as number;
    expect(at(0.43)).toBeGreaterThan(0.004); // top edge of the figure box (360 pt = 0.4276)
    expect(at(0.5)).toBeGreaterThan(0.004); // the label inside the box
    expect(at(0.8)).toBe(0);
    expect(at(0.7)).toBe(0);
  });

  it('renders a page and a region as PNG with a grid, with the grid labels in page coordinates', async () => {
    const page = await renderPage(doc, 0, { grid: 0.1, maxSide: 800 });
    expect(isPng(page.png)).toBe(true);
    expect(pngSize(page.png)).toEqual({ width: page.width, height: page.height });
    expect(Math.max(page.width, page.height)).toBeLessThanOrEqual(801);
    expect(page.height / page.width).toBeCloseTo(842 / 595, 1);
    expect(page.view).toMatchObject({ left: 0, top: 0, right: 1, bottom: 1 });

    const crop = await renderRegion(doc, 0, { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 }, { grid: 0.05, padding: 0.02 });
    expect(isPng(crop.png)).toBe(true);
    expect(crop.view.left).toBeCloseTo(0.08, 2);
    expect(crop.view.top).toBeCloseTo(0.18, 2);
    expect(crop.view.right).toBeCloseTo(0.92, 2);
    expect(crop.width / crop.height).toBeCloseTo(((0.84 * 595) / (0.14 * 842)), 0);
    const bare = await renderRegion(doc, 0, { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 }, { padding: 0.02 });
    expect(bare.png).not.toEqual(crop.png);
  });

  it('draws frames with labels when asked', async () => {
    const plain = await renderPage(doc, 0, { maxSide: 600 });
    const framed = await renderPage(doc, 0, {
      maxSide: 600,
      boxes: [{ label: 'E1', kind: 'exercise', rect: { left: 0.1, top: 0.22, right: 0.9, bottom: 0.3 }, dashed: false, frameId: 'a' }],
    });
    expect(framed.png).not.toEqual(plain.png);
  });
});

describe('page geometry', () => {
  const upright = (rotate: 0 | 90 | 180 | 270): Uint8Array =>
    buildPdf({ pages: [{ rotate, texts: [{ text: 'Upright text on a turned page', x: 72, y: 200, size: 11 }] }] });

  it.each([0, 90, 180, 270] as const)('applies /Rotate %i: fractions refer to the page as displayed', async (rotate) => {
    const doc = await PdfDocument.fromBytes(upright(rotate));
    try {
      const size = await doc.pageSize(0);
      expect(size.rotation).toBe(rotate);
      expect(size.width).toBe(595);
      expect(size.height).toBe(842);
      const { lines } = await doc.pageText(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.text).toBe('Upright text on a turned page');
      expect(lines[0]?.rect.left).toBeCloseTo(72 / 595, 2);
      expect(lines[0]?.rect.top).toBeGreaterThan((200 - 11) / 842);
      expect(lines[0]?.rect.top).toBeLessThan((200 - 7) / 842);
    } finally {
      await doc.close();
    }
  });

  it('uses the displayed size for a landscape page', async () => {
    const doc = await PdfDocument.fromBytes(buildPdf({ pages: [{ width: 842, height: 595, rotate: 90, texts: [{ text: 'Landscape', x: 100, y: 100 }] }] }));
    try {
      expect(await doc.pageSize(0)).toEqual({ width: 842, height: 595, rotation: 90 });
      const { lines } = await doc.pageText(0);
      expect(lines[0]?.rect.left).toBeCloseTo(100 / 842, 2);
    } finally {
      await doc.close();
    }
  });

  it('finds no text on a scan-like page and still renders it', async () => {
    const bytes = buildPdf({ pages: [{ scan: { bars: [{ left: 0.12, top: 0.2, right: 0.8, bottom: 0.23 }] } }, { texts: [{ text: 'Typeset', x: 72, y: 100 }] }] });
    const doc = await PdfDocument.fromBytes(bytes);
    try {
      const scan = await doc.pageText(0);
      expect(scan.hasText).toBe(false);
      expect(scan.lines).toEqual([]);
      expect((await doc.pageText(1)).hasText).toBe(true);
      const png = await renderPage(doc, 0, { maxSide: 300 });
      expect(isPng(png.png)).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('reads two columns, the left one first', async () => {
    const texts = [];
    for (let row = 0; row < 14; row += 1) {
      texts.push({ text: `Left column line ${row} with some words`, x: 60, y: 120 + row * 16, size: 10 });
      texts.push({ text: `Right column line ${row} with some words`, x: 320, y: 120 + row * 16, size: 10 });
    }
    const doc = await PdfDocument.fromBytes(buildPdf({ pages: [{ texts }] }));
    try {
      const page = await doc.pageText(0);
      expect(page.columns).toBe(2);
      expect(page.lines.slice(0, 14).every((line) => line.column === 0 && line.text.startsWith('Left'))).toBe(true);
      expect(page.lines.slice(14).every((line) => line.column === 1 && line.text.startsWith('Right'))).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('has no outline when the PDF has none, and nests outline entries by depth', async () => {
    const plain = await PdfDocument.fromBytes(buildPdf({ pages: [{}, {}] }));
    expect(await plain.outline()).toBeNull();
    await plain.close();
    const outline = [
      { title: 'Chapter 1', page: 0, depth: 0 },
      { title: '1.1 Sets', page: 0, depth: 1 },
      { title: '1.1.1 Union', page: 1, depth: 2 },
      { title: '1.2 Maps', page: 1, depth: 1 },
      { title: 'Chapter 2 Übungen', page: 1, depth: 0 },
    ];
    const nested = await PdfDocument.fromBytes(buildPdf({ pages: [{}, {}], outline }));
    expect(await nested.outline()).toEqual(outline);
    await nested.close();
  });

  it('draws text with umlauts so that they are read back', async () => {
    const doc = await PdfDocument.fromBytes(buildPdf({ pages: [{ texts: [{ text: 'Übung 3 (Maße und Größen)', x: 72, y: 100 }] }] }));
    expect((await doc.pageText(0)).lines[0]?.text).toBe('Übung 3 (Maße und Größen)');
    await doc.close();
  });
});

describe('errors', () => {
  it('says so when the file is missing or not a PDF', async () => {
    const dir = await tempDir();
    await expect(PdfDocument.open(join(dir, 'missing.pdf'))).rejects.toMatchObject({ code: 'E_PDF_MISSING' });
    const bad = join(dir, 'bad.pdf');
    await writeFile(bad, 'this is not a pdf');
    await expect(PdfDocument.open(bad)).rejects.toMatchObject({ code: 'E_PDF_INVALID' });
  });

  it('knows the page size constants', () => {
    expect(A4).toEqual({ width: 595, height: 842 });
  });
});
