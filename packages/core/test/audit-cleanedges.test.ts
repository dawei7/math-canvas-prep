import { describe, expect, it } from 'vitest';
import { cleanPage, cleanProposals, type CleanItem } from '../src/audit/cleanedges.js';
import type { BookExercises } from '../src/audit/exercises.js';
import type { BookSolutions } from '../src/audit/solutions.js';
import type { PageText, Rect, TextLine } from '../src/model/types.js';
import { edgeInkOf, type DarkPicture } from '../src/verify/edge-ink.js';
import { VERIFY_LIMITS } from '../src/verify/types.js';

/**
 * The audit moves an edge of a proposed region that cuts printed ink to where it does not (`cleanPage`). The pages here are drawn by
 * hand as bitmaps of dark pixels, a page of 600 x 800 points at two pixels per point, so that every case is one picture: the ink that
 * the edge cuts, the boxes of the lines of the text layer, and what the edge may and may not do. Pixel boxes are written as
 * [x0, y0, x1, y1], both ends inside.
 */

const W = 1200;
const H = 1600;

type Box = [number, number, number, number];

const blank = (): DarkPicture => ({ width: W, height: H, dark: new Uint8Array(W * H) });

function ink(picture: DarkPicture, ...boxes: Box[]): DarkPicture {
  for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) picture.dark[y * W + x] = 1;
  return picture;
}

/** A pixel box as a rectangle in page fractions. */
const rectOf = ([x0, y0, x1, y1]: Box): Rect => ({ left: x0 / W, top: y0 / H, right: (x1 + 1) / W, bottom: (y1 + 1) / H });

const lineOf = (text: string, box: Box, parts?: Box[]): TextLine => ({
  text,
  rect: rectOf(box),
  fontSize: 12,
  column: 0,
  chars: text.length,
  ...(parts ? { parts: parts.map((part) => ({ text, chars: text.length, rect: rectOf(part) })) } : {}),
});

const pageOf = (...lines: TextLine[]): PageText => ({ page: 0, size: { width: 600, height: 800, rotation: 0 }, lines, columns: 1, hasText: true });

const item = (box: Box, group: CleanItem['group'] = 'exercise'): CleanItem => ({ rect: rectOf(box), group });

/** The pixel row or column an edge of the rectangle stands at, as the measure takes it (the first row inside from the top edge, the last one from the bottom edge). */
const at = {
  top: (item: CleanItem): number => Math.round(item.rect.top * H),
  bottom: (item: CleanItem): number => Math.round(item.rect.bottom * H) - 1,
  left: (item: CleanItem): number => Math.round(item.rect.left * W),
  right: (item: CleanItem): number => Math.round(item.rect.right * W) - 1,
};

type Side = keyof typeof at;

/** Whether the edge cuts ink by the rule of `exercises verify --ink` (`edge-on-ink`). */
function cuts(picture: DarkPicture, rect: Rect, side: Side): boolean {
  const measured = edgeInkOf(picture, rect);
  return (measured.cross?.[side] ?? 0) >= VERIFY_LIMITS.inkCrossPixels || measured[side] > VERIFY_LIMITS.inkEdgeShare;
}

describe('cleaning the edges of the regions of one page', () => {
  it('leaves a region alone whose edges cut nothing, exactly as it was', () => {
    const picture = ink(blank(), [230, 330, 700, 370]);
    const region = item([200, 300, 799, 420]);
    const before = { ...region.rect };
    expect(cleanPage(picture, pageOf(lineOf('1) text', [220, 320, 780, 380])), [region])).toBe(0);
    expect(region.rect).toEqual(before);
  });

  it('lets go of the descender of the line above that reaches into the region: the top edge moves in, under it, and the own text stays', () => {
    // The line above has a tail that goes four rows into the region; the own text is further down. A tail of four pixels in six hundred is
    // a graze (under two percent): the edge may stand right under it.
    const picture = ink(blank(), [300, 275, 700, 296], [400, 297, 403, 303], [230, 345, 700, 375]);
    const page = pageOf(lineOf('above', [220, 270, 780, 310]), lineOf('1) own', [220, 340, 780, 380]));
    const region = item([200, 300, 799, 500]);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(1);
    expect(at.top(region)).toBe(304);
    expect(cuts(picture, region.rect, 'top')).toBe(false);
    // Nothing else moved.
    expect([at.bottom(region), at.left(region), at.right(region)]).toEqual([500, 200, 799]);
  });

  it('takes in the rest of an own descender: the bottom edge moves out, past the tail', () => {
    const picture = ink(blank(), [230, 355, 700, 385], [300, 386, 304, 417]);
    const page = pageOf(lineOf('1) own', [220, 350, 780, 410]));
    const region = item([200, 300, 799, 410]);
    expect(cuts(picture, region.rect, 'bottom')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(1);
    expect(at.bottom(region)).toBe(417);
    expect(cuts(picture, region.rect, 'bottom')).toBe(false);
  });

  it('lets go of ink of a neighbour that reaches deep into the region, further than a few pixels, as far as it reaches', () => {
    // A block of a figure above takes ten rows of the region: it is mostly outside, so it is the neighbour's.
    const picture = ink(blank(), [300, 250, 700, 309], [230, 405, 700, 435]);
    const page = pageOf(lineOf('1) own', [220, 400, 780, 440]));
    const region = item([200, 300, 799, 600]);
    expect(cleanPage(picture, page, [region])).toBe(1);
    expect(at.top(region)).toBe(311);
    expect(cuts(picture, region.rect, 'top')).toBe(false);
  });

  it('does not take in the printed text of a neighbour to get out of ink: the edge stays where it was', () => {
    // A tip of the own text reaches up over the top edge; the first clean row above it lies over the rule at the foot of the line above, which
    // the region would take in (only the bottom of the box of that line is in the rows the edge would cross: it is not read as inside).
    const picture = ink(blank(), [300, 282, 700, 285], [220, 296, 780, 298], [400, 299, 402, 301], [230, 302, 700, 335]);
    const page = pageOf(lineOf('above', [220, 280, 780, 298]), lineOf('1) own', [220, 299, 780, 340]));
    const region = item([200, 300, 799, 400]);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.top(region)).toBe(300);
  });

  it('does not take in a piece of text that the text check would read as inside the region, though nothing is printed in the rows it crosses', () => {
    // An overline of the own text lies on the top edge; the first clean row above it is three rows up, and a small piece of text there (a mark
    // that is not printed: nothing is dark in its box) would be more than half inside the region.
    const picture = ink(blank(), [230, 299, 700, 335]);
    const page = pageOf(lineOf('mark', [500, 295, 520, 298]), lineOf('1) own', [220, 299, 780, 340]));
    const region = item([200, 300, 799, 400]);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.top(region)).toBe(300);
  });

  it('never moves out further than its reach (1.2 percent of the page), whatever lies beyond, and does not move in either when the ink is its own', () => {
    // A bracket of the own text goes 38 rows over the top edge: the first clean row above it is 40 rows away. The box of a piece of a neighbour that
    // reaches into the columns of the region makes room to move in (46 rows), which an edge that cuts its own ink does not use.
    const picture = ink(blank(), [400, 262, 410, 335], [230, 340, 700, 345]);
    const page = pageOf(lineOf('1) own', [220, 299, 780, 350]), lineOf('figure', [780, 250, 900, 340]));
    const region = item([200, 300, 799, 500]);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.top(region)).toBe(300);
  });

  it('keeps a left edge out of the own text, though a white column lies in the line between the number and the words', () => {
    // A rule of the left neighbour reaches 18 columns into the region; the line starts at 100 with its number (ink 102..118), the words from 140.
    const picture = ink(blank(), [40, 405, 118, 406], [102, 420, 118, 440], [140, 420, 560, 440]);
    const page = pageOf(lineOf('A) words', [100, 415, 560, 445]));
    const region = item([100, 400, 599, 520]);
    expect(cuts(picture, region.rect, 'left')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.left(region)).toBe(100);
  });

  it('keeps a right edge out of the own text as well', () => {
    // A rule of the right neighbour reaches ten columns into the region; the line goes on to 595, with a white stretch before its last mark.
    const picture = ink(blank(), [590, 405, 660, 406], [120, 420, 560, 440], [594, 420, 595, 440]);
    const page = pageOf(lineOf('words .', [100, 415, 595, 445]));
    const region = item([100, 400, 599, 520]);
    expect(cuts(picture, region.rect, 'right')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.right(region)).toBe(599);
  });

  it('lets an answer go that the region above only holds because its box reaches into it, when the answer below holds more of it', () => {
    // The numerator of the next answer (its box 388..408) stands half in the region above (to 400) and wholly in the one below (from 386).
    const picture = ink(blank(), [315, 315, 640, 345], [300, 398, 500, 415]);
    const page = pageOf(lineOf('own', [310, 310, 650, 350]), lineOf('numerator', [300, 388, 500, 408]));
    const above = item([250, 300, 750, 400]);
    const below = item([250, 386, 750, 500]);
    expect(cuts(picture, above.rect, 'bottom')).toBe(true);
    cleanPage(picture, page, [above, below]);
    expect(at.bottom(above)).toBe(396);
    expect(cuts(picture, above.rect, 'bottom')).toBe(false);
  });

  it('does not leave a piece of the own text less than 60 percent inside to get out of ink', () => {
    // A block above takes ten rows of the region; the line of the own text has its box from 300 to 320 and its ink in the lower rows: the first
    // clean rows (311 and more) would leave less than 60 percent of the box inside.
    const picture = ink(blank(), [300, 250, 700, 309], [230, 316, 700, 319]);
    const page = pageOf(lineOf('1) own', [220, 300, 780, 320]));
    const region = item([200, 300, 799, 500]);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.top(region)).toBe(300);
  });

  it('does not make a region smaller than the size check allows', () => {
    // 400 x 10 pixels is just above the smallest area of a region; the clean row under the tail of the line above would take it below.
    const picture = ink(blank(), [300, 295, 303, 301], [220, 305, 500, 306]);
    const page = pageOf(lineOf('1) own', [210, 304, 590, 309]));
    const region = item([200, 300, 599, 309]);
    expect(VERIFY_LIMITS.minArea * W * H).toBeLessThan(400 * 10);
    expect(VERIFY_LIMITS.minArea * W * H).toBeGreaterThan(400 * 7);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.top(region)).toBe(300);
  });

  it('puts a region back as it was when its moves make an edge cut that did not cut before, and cannot be cleaned', () => {
    // The top edge cuts a tall bracket of the own text and moves out to 393; the bar of a figure that ends at 398 and lies along the column
    // left of the region then cuts the left edge (more than two percent of the pixels around it): too far to move out, and with the own text
    // from 300 on there is no room to move in.
    const picture = ink(blank(), [330, 395, 340, 440], [350, 401, 650, 440], [100, 380, 299, 398]);
    const page = pageOf(lineOf('1) own', [300, 420, 680, 470]), lineOf('bracket', [330, 395, 340, 440]));
    const region = item([300, 400, 699, 520]);
    expect(cuts(picture, region.rect, 'top')).toBe(true);
    expect(cuts(picture, region.rect, 'left')).toBe(false);
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(at.top(region)).toBe(400);
  });

  it('moves only the edges that cut, and writes the others as they were', () => {
    const picture = ink(blank(), [300, 275, 700, 296], [400, 297, 403, 303], [230, 345, 700, 375]);
    const page = pageOf(lineOf('above', [220, 270, 780, 310]), lineOf('1) own', [220, 340, 780, 380]));
    const region = { rect: { left: 0.1666666, top: 0.1875, right: 0.6666666, bottom: 0.3125 }, group: 'exercise' as const };
    cleanPage(picture, page, [region]);
    expect(region.rect.left).toBe(0.1666666);
    expect(region.rect.right).toBe(0.6666666);
    expect(region.rect.bottom).toBe(0.3125);
    expect(region.rect.top).toBe(0.19);
  });

  it('is idempotent: the cleaned region cuts nothing and cleaning it again changes nothing', () => {
    const picture = ink(blank(), [300, 250, 700, 309], [230, 405, 700, 435]);
    const page = pageOf(lineOf('1) own', [220, 400, 780, 440]));
    const region = item([200, 300, 799, 600]);
    cleanPage(picture, page, [region]);
    const once = { ...region.rect };
    expect(cleanPage(picture, page, [region])).toBe(0);
    expect(region.rect).toEqual(once);
  });
});

describe('cleaning the regions of the proposals of a book', () => {
  const exercise = (page: number, rect: Rect, extra: Record<string, unknown> = {}) => ({ page, rect, context: [], ...extra });

  it('cleans every region (the exercise, its continuation, its instruction, its answer), draws each page once, and counts what moved', async () => {
    const descender = (): DarkPicture => ink(blank(), [300, 275, 700, 296], [400, 297, 403, 303], [230, 345, 700, 375]);
    const pages = [pageOf(lineOf('above', [220, 270, 780, 310]), lineOf('1) own', [220, 340, 780, 380])), pageOf(lineOf('above', [220, 270, 780, 310]), lineOf('1) own', [220, 340, 780, 380]))];
    const cut = (): Rect => rectOf([200, 300, 799, 500]);
    const first = exercise(0, cut(), { continues: [{ page: 1, rect: cut() }], context: [{ page: 1, rect: cut() }] });
    const answer = { regions: [{ page: 0, rect: cut() }] };
    const drawn: number[] = [];
    const result = await cleanProposals(
      (page) => {
        drawn.push(page);
        return Promise.resolve(descender());
      },
      pages,
      { sections: [{ proposals: [first] }] } as unknown as BookExercises,
      { sections: [{ answers: [answer] }] } as unknown as BookSolutions,
    );
    expect(drawn).toEqual([0, 1]);
    expect(result).toEqual({ edges: 4, regions: 4, pages: 2 });
    for (const rect of [first.rect, (first.continues as { rect: Rect }[])[0]?.rect, first.context[0]?.rect, answer.regions[0]?.rect] as Rect[]) expect(Math.round(rect.top * H)).toBe(304);
  });

  it('does nothing for a book without proposals', async () => {
    expect(await cleanProposals(() => Promise.reject(new Error('no page is drawn')), [], undefined, undefined)).toEqual({ edges: 0, regions: 0, pages: 0 });
  });
});
