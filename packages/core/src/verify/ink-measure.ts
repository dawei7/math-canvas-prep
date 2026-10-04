import type { Rect } from '../model/types.js';
import type { PdfDocument } from '../pdf/document.js';
import { renderDark } from '../pdf/render.js';
import type { EdgeInk, InkLookup } from './types.js';

/**
 * The ink along the edges of regions, measured on the rendered pages: each page that has a region is drawn once, at two
 * pixels per point, and a pixel is dark when it is clearly darker than paper (luminance below 150, as the acceptance script
 * of the first audits did). For an edge two things are taken along its whole length:
 *
 * - the share of dark pixels in the three rows (or columns) around it, the largest of the three (`top`, `bottom`, `left`, `right`);
 * - where the ink goes on across it (`cross`): the number of pixels along the edge at which the row (or column) just INSIDE the region
 *   and the one just OUTSIDE it are both dark, at the same place. The first inside row of the top edge is `round(top * height)` and the
 *   outside one the row above it; the last inside row of the bottom edge is `round(bottom * height) - 1` and the outside one the row
 *   below it; the columns of the left and right edges likewise. An edge in white paper has 0, an edge that lies on the border of a box
 *   or on a rule has the whole length, an edge that cuts a glyph by a hair has the pixels of its strokes at that place. An edge at the
 *   border of the page has nothing outside and so 0.
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
    const { width, height, dark } = picture;
    const rowShare = (y: number, x0: number, x1: number): number => {
      if (y < 0 || y >= height || x1 < x0) return 0;
      let count = 0;
      const base = y * width;
      for (let x = x0; x <= x1; x += 1) count += dark[base + x] as number;
      return count / (x1 - x0 + 1);
    };
    const columnShare = (x: number, y0: number, y1: number): number => {
      if (x < 0 || x >= width || y1 < y0) return 0;
      let count = 0;
      for (let y = y0; y <= y1; y += 1) count += dark[y * width + x] as number;
      return count / (y1 - y0 + 1);
    };
    for (const region of byPage.get(page) as InkRegion[]) {
      const rect = region.rect;
      const x0 = Math.max(0, Math.round(rect.left * width));
      const x1 = Math.min(width - 1, Math.round(rect.right * width) - 1);
      const y0 = Math.max(0, Math.round(rect.top * height));
      const y1 = Math.min(height - 1, Math.round(rect.bottom * height) - 1);
      const row = (y: number): number => Math.max(rowShare(y - 1, x0, x1), rowShare(y, x0, x1), rowShare(y + 1, x0, x1));
      const column = (x: number): number => Math.max(columnShare(x - 1, y0, y1), columnShare(x, y0, y1), columnShare(x + 1, y0, y1));
      // The ink that goes on across an edge: dark just inside and just outside, at the same place along the edge.
      const rowsCross = (inside: number, outside: number): number => {
        if (inside < 0 || inside >= height || outside < 0 || outside >= height) return 0;
        let count = 0;
        for (let x = x0; x <= x1; x += 1) count += (dark[inside * width + x] as number) & (dark[outside * width + x] as number);
        return count;
      };
      const columnsCross = (inside: number, outside: number): number => {
        if (inside < 0 || inside >= width || outside < 0 || outside >= width) return 0;
        let count = 0;
        for (let y = y0; y <= y1; y += 1) count += (dark[y * width + inside] as number) & (dark[y * width + outside] as number);
        return count;
      };
      results.set(keyOf(page, rect), {
        top: row(y0),
        bottom: row(y1),
        left: column(x0),
        right: column(x1),
        cross: { top: rowsCross(y0, y0 - 1), bottom: rowsCross(y1, y1 + 1), left: columnsCross(x0, x0 - 1), right: columnsCross(x1, x1 + 1) },
        length: { horizontal: Math.max(0, x1 - x0 + 1), vertical: Math.max(0, y1 - y0 + 1) },
      });
    }
    done += 1;
    options.onPage?.(done, byPage.size);
  }
  return { lookup: (region) => results.get(keyOf(region.page, region.rect)), pages: byPage.size };
}
