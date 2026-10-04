import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/model/types.js';
import { boxOf, explainEdges, type EdgePicture } from '../src/verify/edge-detail.js';
import { VERIFY_LIMITS, type EdgeDetail, type EdgeInk, type EdgeSide } from '../src/verify/types.js';

/**
 * What can be done about an edge that the pixel rule reports, on pictures that are drawn here pixel by pixel: a bar (a rule, a stroke), the border of
 * a box, and two lines of text whose descenders and ascenders interlock. The numbers follow from the geometry. An edge is clear where the three rows
 * (or columns) around it are white, so a bar that fills the rows `a` to `b` leaves the edge clear from the row `a - 2` upwards and from `b + 2` down.
 */

const W = 400;
const H = 300;

const blank = (): EdgePicture => ({ width: W, height: H, dark: new Uint8Array(W * H) });

/** Paints the pixel columns `x0..x1` and rows `y0..y1` (both ends included). */
function paint(picture: EdgePicture, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) picture.dark[y * picture.width + x] = 1;
}

/** The rectangle (page fractions) that covers the pixel columns `x0..x1` and rows `y0..y1`. */
const rectOf = (x0: number, y0: number, x1: number, y1: number): Rect => ({ left: x0 / W, top: y0 / H, right: (x1 + 1) / W, bottom: (y1 + 1) / H });

/** The measure of the edges as `measureInk` takes it (the share of dark pixels in three lines around an edge, the pixels where the ink goes across it). */
function measure(picture: EdgePicture, rect: Rect): EdgeInk {
  const { x0, x1, y0, y1 } = boxOf(picture, rect);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= picture.width || y >= picture.height ? 0 : (picture.dark[y * picture.width + x] as number));
  const row = (y: number): number => {
    let count = 0;
    for (let x = x0; x <= x1; x += 1) count += at(x, y);
    return count / (x1 - x0 + 1);
  };
  const column = (x: number): number => {
    let count = 0;
    for (let y = y0; y <= y1; y += 1) count += at(x, y);
    return count / (y1 - y0 + 1);
  };
  const rowsCross = (inside: number, outside: number): number => {
    if (outside < 0 || outside >= picture.height) return 0;
    let count = 0;
    for (let x = x0; x <= x1; x += 1) count += at(x, inside) & at(x, outside);
    return count;
  };
  const columnsCross = (inside: number, outside: number): number => {
    if (outside < 0 || outside >= picture.width) return 0;
    let count = 0;
    for (let y = y0; y <= y1; y += 1) count += at(inside, y) & at(outside, y);
    return count;
  };
  return {
    top: Math.max(row(y0 - 1), row(y0), row(y0 + 1)),
    bottom: Math.max(row(y1 - 1), row(y1), row(y1 + 1)),
    left: Math.max(column(x0 - 1), column(x0), column(x0 + 1)),
    right: Math.max(column(x1 - 1), column(x1), column(x1 + 1)),
    cross: { top: rowsCross(y0, y0 - 1), bottom: rowsCross(y1, y1 + 1), left: columnsCross(x0, x0 - 1), right: columnsCross(x1, x1 + 1) },
    length: { horizontal: x1 - x0 + 1, vertical: y1 - y0 + 1 },
  };
}

function detailOf(picture: EdgePicture, rect: Rect, side: EdgeSide): EdgeDetail {
  const ink = explainEdges(picture, rect, measure(picture, rect), 0.5);
  expect(ink.pointsPerPixel).toBe(0.5);
  return ink.detail?.[side] as EdgeDetail;
}

/** The first inside row of the top edge, or the last of the bottom edge, that a position (a page fraction) gives. */
const rowOf = (picture: EdgePicture, rect: Rect, side: 'top' | 'bottom', position: number): number => {
  const box = boxOf(picture, { ...rect, [side]: position });
  return side === 'top' ? box.y0 : box.y1;
};

const moves = (detail: EdgeDetail): number[] => detail.fixes.map((fix) => fix.move);

describe('explainEdges: a rule or a stroke that the edge cuts', () => {
  const picture = blank();
  // A bar of 20 rows (100 to 119) and 300 columns: a rule, a thick stroke, the side of a box.
  paint(picture, 50, 100, 349, 119);

  it('gives nothing for an edge that passes the rule', () => {
    const rect = rectOf(40, 40, 360, 90);
    expect(explainEdges(picture, rect, measure(picture, rect)).detail).toBeUndefined();
  });

  it('names the positions outwards, in white, within three points, the nearest first', () => {
    // The top edge three rows inside the bar cuts it along its whole length. From row 98 up the three rows around it are white: five and six rows up.
    const rect = rectOf(40, 103, 360, 250);
    const ink = measure(picture, rect);
    expect(ink.cross?.top).toBe(300);
    const detail = detailOf(picture, rect, 'top');
    expect(detail.run).toBe(300);
    expect(moves(detail)).toEqual([-5, -6]);
    expect(detail.fixes.every((fix) => fix.crossing === 0)).toBe(true);
    expect(rowOf(picture, rect, 'top', (detail.fixes[0] as { position: number }).position)).toBe(98);
    // The bar is deep ink, so the nearest clear position outwards is named as well (here it is the first of the positions).
    expect(detail.far?.move).toBe(-5);
    // Measured again with the new edge, the rule is passed.
    const moved = { ...rect, top: (detail.fixes[0] as { position: number }).position };
    expect(explainEdges(picture, moved, measure(picture, moved)).detail).toBeUndefined();
  });

  it('names a position inwards when what the region gives up is only the part of the bar that the edge cuts', () => {
    // The edge four rows from the bar's end (rows 116 to 119 inside): from row 121 down it is clear, five and six rows down, and the bar is out of the region.
    const detail = detailOf(picture, rectOf(40, 116, 360, 250), 'top');
    expect(moves(detail)).toEqual([5, 6]);
  });

  it('names no position, only a hint outwards, when the clear place is further than the window', () => {
    // Ten rows inside the bar: twelve rows up or eleven down, more than the window of six.
    const rect = rectOf(40, 110, 360, 250);
    const detail = detailOf(picture, rect, 'top');
    expect(detail.fixes).toEqual([]);
    expect(detail.poke).toBe(VERIFY_LIMITS.inkTipPixels + 1);
    expect(detail.far?.move).toBe(-12);
    expect(rowOf(picture, rect, 'top', (detail.far as { position: number }).position)).toBe(98);
    // Further than the far window: no hint.
    const deep = blank();
    paint(deep, 50, 100, 349, 199);
    const none = detailOf(deep, rectOf(40, 160, 360, 280), 'top');
    expect(none.fixes).toEqual([]);
    expect(none.far).toBeUndefined();
  });

  it('treats the bottom and the sides the same way, down and to the right being outwards for them', () => {
    // The bottom edge three rows from the bar's end (rows 100 to 116 inside the region): from row 121 down it is clear.
    const bottom = detailOf(picture, rectOf(40, 20, 360, 116), 'bottom');
    expect(bottom.run).toBe(300);
    expect(moves(bottom)).toEqual([5, 6]);
    // A vertical bar (columns 100 to 119) and the right edge three columns inside it; the left edge four columns from its end.
    const vertical = blank();
    paint(vertical, 100, 50, 119, 249);
    const right = detailOf(vertical, rectOf(40, 30, 103, 280), 'right');
    expect(right.run).toBe(200);
    expect(moves(right)).toEqual([-5, -6]);
    const left = detailOf(vertical, rectOf(116, 30, 300, 280), 'left');
    expect(moves(left)).toEqual([5, 6]);
  });

  it('an edge that lies on ink and cuts nothing has a clear position all the same', () => {
    // The top edge at the first row of the bar: nothing is cut (the row outside is white), but the edge lies on ink.
    const rect = rectOf(40, 100, 360, 250);
    const ink = measure(picture, rect);
    expect(ink.cross?.top).toBe(0);
    expect(ink.top).toBeGreaterThan(0.9);
    const detail = detailOf(picture, rect, 'top');
    expect(detail.run).toBe(0);
    expect(detail.poke).toBe(0);
    expect(detail.fixes[0]).toMatchObject({ move: -2, crossing: 0 });
  });

  it('gives up nothing but tips when it moves an edge inwards', () => {
    // Under the bar there is a mark (rows 124 to 126) that is no tip: an edge at row 116 may not move down past it for the clear position at row 121,
    // because the mark is in the rows the region would give up only when the move is long enough to reach it (rows 121 to 123 are white).
    const marked = blank();
    paint(marked, 50, 100, 349, 119);
    paint(marked, 200, 122, 210, 127);
    const detail = detailOf(marked, rectOf(40, 116, 360, 250), 'top');
    // Row 121 is no longer clear (the mark is in the three rows around it), and rows 122 and 123 are the mark: nothing within the window.
    expect(detail.fixes).toEqual([]);
  });
});

describe('explainEdges: the border of a box, a figure', () => {
  // A box of 150 x 100 pixels with a border of two pixels: columns 100 to 249, rows 100 to 199.
  const picture = blank();
  paint(picture, 100, 100, 249, 101);
  paint(picture, 100, 198, 249, 199);
  paint(picture, 100, 100, 101, 199);
  paint(picture, 248, 100, 249, 199);

  it('a region that holds the box whole, border included, with white around it, or none of it, has nothing to repair', () => {
    for (const rect of [rectOf(96, 96, 253, 203), rectOf(80, 80, 270, 220), rectOf(104, 104, 245, 195)]) {
      const ink = explainEdges(picture, rect, measure(picture, rect));
      expect(ink.detail, JSON.stringify(rect)).toBeUndefined();
    }
  });

  it('a region that lies exactly on the box lies on ink, and a position in white is named', () => {
    const detail = detailOf(picture, rectOf(100, 100, 249, 199), 'top');
    expect(detail.run).toBe(0);
    expect(detail.fixes[0]).toMatchObject({ move: -2, crossing: 0 });
  });

  it('an edge through the middle of the box cuts its two sides: deep ink, no position within the window, a hint outwards past the box', () => {
    const rect = rectOf(80, 130, 270, 260);
    const ink = measure(picture, rect);
    expect(ink.cross?.top).toBe(4);
    const detail = detailOf(picture, rect, 'top');
    expect(detail.run).toBe(2);
    expect(detail.poke).toBeGreaterThan(VERIFY_LIMITS.inkTipPixels);
    expect(detail.fixes).toEqual([]);
    // Above the top of the box (rows 100 and 101) the three rows around the edge are clear from row 98 up: 32 rows up from row 130.
    expect(detail.far?.move).toBe(-32);
  });

  it('an edge through the box further than the far window from white has no position at all', () => {
    const detail = detailOf(picture, rectOf(80, 160, 270, 260), 'top');
    expect(detail.fixes).toEqual([]);
    expect(detail.far).toBeUndefined();
  });
});

describe('explainEdges: lines that interlock', () => {
  // Line A: a body of 21 rows (40 to 60) with nine descenders of two columns, rows 61 to 66. Line B: a body (70 to 90) with nine ascenders, rows 63 to
  // 69, in the columns between them. Descenders and ascenders overlap in height and do not touch.
  const picture = blank();
  paint(picture, 50, 40, 349, 60);
  paint(picture, 50, 70, 349, 90);
  for (let k = 0; k < 9; k += 1) {
    paint(picture, 60 + 30 * k, 61, 61 + 30 * k, 66);
    paint(picture, 75 + 30 * k, 63, 76 + 30 * k, 69);
  }

  it('no position within the window is clear, and only tips go across: nothing a rectangle can separate', () => {
    const rect = rectOf(40, 65, 360, 150);
    const ink = measure(picture, rect);
    expect(ink.cross?.top).toBe(36);
    const detail = detailOf(picture, rect, 'top');
    expect(detail.fixes).toEqual([]);
    expect(detail.run).toBe(2);
    // The descenders poke two rows into the region (rows 65 and 66), the ascenders two rows out of it (rows 63 and 64).
    expect(detail.poke).toBe(2);
    expect(detail.poke).toBeLessThanOrEqual(VERIFY_LIMITS.inkTipPixels);
    expect(detail.far).toBeUndefined();
  });

  it('the same edge a few rows higher cuts the descenders deeper than tips', () => {
    const detail = detailOf(picture, rectOf(40, 62, 360, 150), 'top');
    // The descenders poke five rows into the region now.
    expect(detail.poke).toBeGreaterThan(VERIFY_LIMITS.inkTipPixels);
  });
});
