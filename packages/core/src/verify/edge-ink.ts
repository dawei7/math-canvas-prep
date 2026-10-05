import type { Rect } from '../model/types.js';
import type { EdgeInk } from './types.js';

/** A page as a bitmap of dark pixels (1) and light ones (0): a pixel is dark when its luminance is below the threshold (150 by default, see `renderDark`). */
export interface DarkPicture {
  width: number;
  height: number;
  dark: Uint8Array;
}

/**
 * The ink along the four edges of one rectangle on one picture of a page, drawn at two pixels per point: for each edge the share of dark
 * pixels in the three rows (or columns) around it and the pixels at which the ink goes on across it. The measure of `exercises verify
 * --ink` and the one the audit moves an edge that cuts ink by.
 */
export function edgeInkOf(picture: DarkPicture, rect: Rect): EdgeInk {
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
  return {
    top: row(y0),
    bottom: row(y1),
    left: column(x0),
    right: column(x1),
    cross: { top: rowsCross(y0, y0 - 1), bottom: rowsCross(y1, y1 + 1), left: columnsCross(x0, x0 - 1), right: columnsCross(x1, x1 + 1) },
    length: { horizontal: Math.max(0, x1 - x0 + 1), vertical: Math.max(0, y1 - y0 + 1) },
  };
}
