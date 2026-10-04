import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import { buildPdf } from '../src/testing/pdf-writer.js';
import { measureInk } from '../src/verify/ink-measure.js';
import { VERIFY_LIMITS, type VerifyFinding } from '../src/verify/types.js';
import { verifyProject } from '../src/verify/verify.js';
import { Workbook, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * Where the ink goes across an edge: the pixels along it at which the row (or column) just inside the region and the one just outside it are
 * both dark. The page is an A4 sheet drawn at 2 pixels per point (1190 x 1684 pixels) with a filled black bar and the stroked border of a
 * box (a line of 0.5 point: two dark pixels), so every number below follows from the geometry.
 */

const WIDTH = 1190;
const HEIGHT = 1684;

/** A region as the pixel columns `left..right` and the pixel rows `top..bottom` (both ends included) it covers. */
const pixels = (left: number, top: number, right: number, bottom: number): Rect => ({ left: left / WIDTH, top: top / HEIGHT, right: (right + 1) / WIDTH, bottom: (bottom + 1) / HEIGHT });

async function measured(regions: Record<string, Rect>): Promise<Record<string, NonNullable<ReturnType<Awaited<ReturnType<typeof measureInk>>['lookup']>>>> {
  const bytes = buildPdf({
    pages: [
      {
        // A bar of 200 x 20 points: columns 200 to 599 and rows 600 to 639 are black.
        // The border of a box of 200 x 100 points: the dark columns are 199-200 and 599-600, the dark rows 199-200 and 399-400.
        boxes: [
          { x: 100, y: 300, w: 200, h: 20, fill: 0 },
          { x: 100, y: 100, w: 200, h: 100 },
        ],
      },
    ],
  });
  const doc = await PdfDocument.fromBytes(bytes);
  try {
    const ink = await measureInk(doc, Object.values(regions).map((rect) => ({ page: 0, rect })));
    return Object.fromEntries(Object.entries(regions).map(([name, rect]) => [name, ink.lookup({ page: 0, rect }) as NonNullable<ReturnType<typeof ink.lookup>>]));
  } finally {
    await doc.close();
  }
}

describe('measureInk: the ink that goes across an edge', () => {
  it('is nothing for edges in white paper and for an edge at the border of the page', async () => {
    const found = await measured({ white: pixels(100, 700, 180, 780), around: pixels(190, 190, 610, 410), top: pixels(300, 0, 499, 100) });
    for (const name of ['white', 'around', 'top']) expect(found[name]?.cross, name).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(found['white']?.length).toEqual({ horizontal: 81, vertical: 81 });
  });

  it('counts the pixels where an edge lies inside ink, for the edge and the sides of the region', async () => {
    // The top edge is in the bar for 200 pixels of its length; the two vertical edges leave the bar after 20 rows; the bottom edge is in white.
    const found = await measured({ cut: pixels(300, 620, 499, 700) });
    expect(found['cut']?.cross).toEqual({ top: 200, bottom: 0, left: 20, right: 20 });
    expect(found['cut']?.top).toBe(1);
  });

  it('is nothing for a region that takes the ink whole: the row outside its edge is white', async () => {
    // The bar from its first row to its last: the top and bottom edges touch it and cut nothing (the dark share around them is 1); the left and right edges are in the bar.
    const found = await measured({ whole: pixels(300, 600, 499, 639) });
    expect(found['whole']?.cross).toEqual({ top: 0, bottom: 0, left: 40, right: 40 });
    expect(found['whole']?.top).toBe(1);
  });

  it('is nothing for a region that has the border of a box whole or none of it, and the whole edge for one that cuts the border', async () => {
    const found = await measured({
      whole: pixels(199, 199, 600, 400),
      inside: pixels(201, 201, 598, 398),
      outside: pixels(190, 190, 610, 410),
      cut: pixels(200, 200, 599, 399),
    });
    for (const name of ['whole', 'inside', 'outside']) expect(found[name]?.cross, name).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    // One pixel inside the outer pixel of the line: the line is cut along every edge.
    expect(found['cut']?.cross).toEqual({ top: 400, bottom: 400, left: 200, right: 200 });
    expect(found['cut']?.length).toEqual({ horizontal: 400, vertical: 200 });
  });

  it('is measured for every edge and reaches the number that makes an edge cut ink', async () => {
    expect(VERIFY_LIMITS.inkCrossPixels).toBeGreaterThanOrEqual(2);
    const found = await measured({ cut: pixels(300, 620, 499, 700) });
    expect(found['cut']?.cross?.top).toBeGreaterThanOrEqual(VERIFY_LIMITS.inkCrossPixels);
  });
});

describe('measureInk and the check: what can be changed about an edge, on rendered pages', () => {
  it('names the position where the edge passes the rule, and the edge passes it there', async () => {
    // The bar of the page (rows 600 to 639): an edge three rows inside it cuts it along its whole length; five rows up the three rows around it are white.
    const rect = pixels(300, 603, 499, 700);
    const found = await measured({ cut: rect });
    const detail = found['cut']?.detail?.top;
    expect(found['cut']?.pointsPerPixel).toBe(0.5);
    expect(detail?.run).toBe(200);
    expect(detail?.fixes.map((fix) => fix.move)).toEqual([-5, -6]);
    const moved = await measured({ moved: { ...rect, top: (detail?.fixes[0] as { position: number }).position } });
    expect(moved['moved']?.detail?.top).toBeUndefined();
    expect(moved['moved']?.cross?.top).toBe(0);
  });
});

describe('edge-interlocked: two lines whose descenders and ascenders overlap in height, rendered', () => {
  /** Line A has descenders (g, 12 point Courier, baseline 100 points), line B ascenders (l, baseline 109.5 points) between them: they overlap in height and do not touch. */
  async function lines(boundary: number): Promise<VerifyFinding[]> {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Interlock' }]);
    for (let k = 0; k < 12; k += 1) {
      book.text(0, 72 + 16 * k, 100, 'g', 12, 'Courier');
      book.text(0, 80 + 16 * k, 109.5, 'l', 12, 'Courier');
    }
    const at = (top: number, bottom: number): Rect => ({ left: 60 / 595, top: top / 842, right: 280 / 595, bottom: bottom / 842 });
    book.frames.push({ id: 'f1', kind: 'exercise', page: 0, rect: at(90, boundary), authority: 'book', label: '1', section: 'a' });
    book.frames.push({ id: 'f2', kind: 'exercise', page: 0, rect: at(boundary, 118), authority: 'book', label: '2', section: 'a' });
    const bytes = book.pdf();
    const doc = await PdfDocument.fromBytes(bytes);
    try {
      const ink = await measureInk(doc, book.frames.map((frame) => ({ page: 0, rect: frame.rect })));
      return verifyProject(book.project(), await pagesOf(bytes), { ink: ink.lookup }).findings.filter((finding) => finding.code === 'edge-on-ink' || finding.code === 'edge-interlocked');
    } finally {
      await doc.close();
    }
  }

  it('is information when only tips go across the edge between them, for each of the two regions; nothing is a warning', async () => {
    const found = await lines(101);
    expect(found.map((finding) => finding.code)).toEqual(['edge-interlocked', 'edge-interlocked']);
    expect(found.map((finding) => `${finding.ref} ${finding.severity}`)).toEqual(['a:1 info', 'a:2 info']);
    expect(found[0]?.message).toContain('The bottom edge of the region of a:1');
    expect(found[1]?.message).toContain('The top edge of the region of a:2');
    expect(found[0]?.message).toContain('only tips poke across it, at most 2 pixels deep');
    expect(found[0]?.evidence).toMatch(/ink goes across it at \d+ px, at most 2 px deep; no clear position within 6 px/);
  });

  it('is a warning when the edge cuts deeper than tips', async () => {
    const found = await lines(104);
    expect(found.every((finding) => finding.code === 'edge-on-ink' && finding.severity === 'warning')).toBe(true);
    expect(found.map((finding) => finding.ref).sort()).toEqual(['a:1', 'a:2']);
    expect(found[0]?.message).toContain('the ink reaches more than 3 pixels to each side of it');
  });
});
