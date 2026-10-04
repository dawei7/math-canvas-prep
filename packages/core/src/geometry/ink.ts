import type { InkMap } from '../model/types.js';

/**
 * Where the ink of a page lies, for edges that have to run between two lines of text. The text layer gives the box of a
 * line, which is taller than what is printed in it; the ink map says where a row of pixels is white.
 */

/** A row of pixels counts as white when at most this share of its width is dark. */
export const INK_CLEAN = 0.006;

const dark = (map: InkMap, x: number, y: number): boolean => (((map.bits[y * Math.ceil(map.width / 8) + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1) === 1;

/** The share of the columns between `left` and `right` (page fractions) that have a dark pixel in the three rows around `y`. */
export function rowInk(map: InkMap, y: number, left: number, right: number): number {
  const row = Math.round(y * map.height);
  const first = Math.max(0, Math.ceil(left * map.width) + 1);
  const last = Math.min(map.width - 1, Math.floor(right * map.width) - 2);
  if (last < first) return 0;
  let count = 0;
  for (let x = first; x <= last; x += 1) {
    for (let r = Math.max(0, row - 1); r <= Math.min(map.height - 1, row + 1); r += 1) {
      if (dark(map, x, r)) {
        count += 1;
        break;
      }
    }
  }
  return count / (last - first + 1);
}

/**
 * The white row closest to `y` between `from` and `to` (page fractions), or undefined when there is none: every row
 * there has ink between `left` and `right`.
 */
export function nearestWhiteRow(map: InkMap, y: number, from: number, to: number, left: number, right: number, tolerance: number = INK_CLEAN): number | undefined {
  const low = Math.max(1, Math.round(Math.min(from, to) * map.height));
  const high = Math.min(map.height - 2, Math.round(Math.max(from, to) * map.height));
  const centre = Math.round(y * map.height);
  let best: number | undefined;
  for (let row = low; row <= high; row += 1) {
    if (best !== undefined && Math.abs(row - centre) >= Math.abs(best - centre)) continue;
    if (rowInk(map, row / map.height, left, right) <= tolerance) best = row;
  }
  return best === undefined ? undefined : best / map.height;
}
