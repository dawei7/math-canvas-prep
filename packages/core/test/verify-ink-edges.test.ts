import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import { buildPdf } from '../src/testing/pdf-writer.js';
import { measureInk } from '../src/verify/ink-measure.js';
import { VERIFY_LIMITS } from '../src/verify/types.js';

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
