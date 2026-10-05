import type { Rect } from '../model/types.js';
import type { PdfDocument } from '../pdf/document.js';
import { renderDark } from '../pdf/render.js';
import { explainEdges } from './edge-detail.js';
import { edgeInkOf } from './edge-ink.js';
import type { EdgeInk, InkLookup } from './types.js';

/**
 * The ink along the edges of regions, measured on the rendered pages: each page that has a region is drawn once, at two
 * pixels per point, and a pixel is dark when it is clearly darker than paper (luminance below 150, as the acceptance script
 * of the first audits did). For an edge two things are taken along its whole length (`edgeInkOf`, the measure the audit also moves its
 * edges by):
 *
 * - the share of dark pixels in the three rows (or columns) around it, the largest of the three (`top`, `bottom`, `left`, `right`);
 * - where the ink goes on across it (`cross`): the number of pixels along the edge at which the row (or column) just INSIDE the region
 *   and the one just OUTSIDE it are both dark, at the same place. The first inside row of the top edge is `round(top * height)` and the
 *   outside one the row above it; the last inside row of the bottom edge is `round(bottom * height) - 1` and the outside one the row
 *   below it; the columns of the left and right edges likewise. An edge in white paper has 0, an edge that lies on the border of a box
 *   or on a rule has the whole length, an edge that cuts a glyph by a hair has the pixels of its strokes at that place. An edge at the
 *   border of the page has nothing outside and so 0.
 *
 * For every edge that fails the rule (`edge-on-ink`) `explainEdges` then looks at what can be changed about it (`detail`): the positions of
 * the edge within 6 pixels at which the rule is passed, how deep the ink that goes across it pokes across, and the nearest clear position
 * outwards within 40 pixels. It sees the picture of the page, which is gone when the measuring of the page is done.
 */

export interface InkRegion {
  page: number;
  rect: Rect;
}

const keyOf = (page: number, rect: Rect): string => `${page}|${[rect.left, rect.top, rect.right, rect.bottom].map((value) => value.toFixed(5)).join(',')}`;

export interface InkMeasure {
  lookup: InkLookup;
  /** How many pages were rendered. */
  pages: number;
}

export async function measureInk(pdf: PdfDocument, regions: readonly InkRegion[], options: { scale?: number; onPage?: (done: number, total: number) => void } = {}): Promise<InkMeasure> {
  const byPage = new Map<number, InkRegion[]>();
  for (const region of regions) {
    if (region.page < 0 || region.page >= pdf.pageCount) continue;
    const list = byPage.get(region.page);
    if (list) list.push(region);
    else byPage.set(region.page, [region]);
  }
  const results = new Map<string, EdgeInk>();
  let done = 0;
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const picture = await renderDark(pdf, page, options.scale === undefined ? {} : { scale: options.scale });
    const pointsPerPixel = (await pdf.pageSize(page)).width / picture.width;
    // What can be done about the edges that fail the rule: the nearest position that passes it, how much of the ink is only tips.
    for (const region of byPage.get(page) as InkRegion[]) results.set(keyOf(page, region.rect), explainEdges(picture, region.rect, edgeInkOf(picture, region.rect), pointsPerPixel));
    done += 1;
    options.onPage?.(done, byPage.size);
  }
  return { lookup: (region) => results.get(keyOf(region.page, region.rect)), pages: byPage.size };
}
