import type { Rect } from '../model/types.js';
import { VERIFY_LIMITS, type EdgeDetail, type EdgeFix, type EdgeInk, type EdgeSide } from './types.js';

/**
 * What can be done about an edge that fails the pixel rule (`edge-on-ink`): the positions of the same edge at which the rule is passed (a
 * repair of one `frames update`), how much of the ink that goes across it is only tips, and, for an edge that cuts more, the nearest clear
 * position outwards as a hint. Pure: it reads a picture of dark pixels (`renderDark`) and a rectangle, nothing else.
 */

/** A page as a bitmap of dark pixels (1) and light ones (0): what `renderDark` makes. */
export interface EdgePicture {
  width: number;
  height: number;
  dark: Uint8Array;
}

const SIDES: readonly EdgeSide[] = ['top', 'bottom', 'left', 'right'];

/** The first and the last pixel column and row that lie inside a region, as `measureInk` takes them. */
export interface EdgeBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function boxOf(picture: EdgePicture, rect: Rect): EdgeBox {
  return {
    x0: Math.max(0, Math.round(rect.left * picture.width)),
    x1: Math.min(picture.width - 1, Math.round(rect.right * picture.width) - 1),
    y0: Math.max(0, Math.round(rect.top * picture.height)),
    y1: Math.min(picture.height - 1, Math.round(rect.bottom * picture.height) - 1),
  };
}

/** One edge of a box moved by a shift: the pixel line just inside it, the one just outside it and the span along it. */
interface Line {
  horizontal: boolean;
  inside: number;
  outside: number;
  /** The number of lines of that direction on the picture. */
  limit: number;
  from: number;
  to: number;
}

const towardsOutside = (side: EdgeSide): -1 | 1 => (side === 'top' || side === 'left' ? -1 : 1);

function lineOf(picture: EdgePicture, box: EdgeBox, side: EdgeSide, shift: number): Line {
  const horizontal = side === 'top' || side === 'bottom';
  const base = side === 'top' ? box.y0 : side === 'bottom' ? box.y1 : side === 'left' ? box.x0 : box.x1;
  const inside = base + shift;
  return { horizontal, inside, outside: inside + towardsOutside(side), limit: horizontal ? picture.height : picture.width, from: horizontal ? box.x0 : box.y0, to: horizontal ? box.x1 : box.y1 };
}

const pixel = (picture: EdgePicture, line: Line, at: number, along: number): number => picture.dark[line.horizontal ? at * picture.width + along : along * picture.width + at] as number;

/** The share of dark pixels along one pixel line of the span. */
function darkShare(picture: EdgePicture, line: Line, at: number): number {
  if (at < 0 || at >= line.limit || line.to < line.from) return 0;
  let count = 0;
  for (let k = line.from; k <= line.to; k += 1) count += pixel(picture, line, at, k);
  return count / (line.to - line.from + 1);
}

/** The largest share of dark pixels in the three lines around the edge: the old rule of `edge-on-ink`. */
const shareAround = (picture: EdgePicture, line: Line): number => Math.max(darkShare(picture, line, line.inside - 1), darkShare(picture, line, line.inside), darkShare(picture, line, line.inside + 1));

/** How many pixels along the edge are dark just inside it and just outside it at the same place. */
function crossingCount(picture: EdgePicture, line: Line): number {
  if (line.inside < 0 || line.inside >= line.limit || line.outside < 0 || line.outside >= line.limit) return 0;
  let count = 0;
  for (let k = line.from; k <= line.to; k += 1) count += pixel(picture, line, line.inside, k) & pixel(picture, line, line.outside, k);
  return count;
}

/** The places along the edge where the ink goes across it, and the longest run of them in a row. */
function crossingPixels(picture: EdgePicture, line: Line): { pixels: number[]; run: number } {
  const pixels: number[] = [];
  let run = 0;
  let longest = 0;
  if (line.inside >= 0 && line.inside < line.limit && line.outside >= 0 && line.outside < line.limit) {
    for (let k = line.from; k <= line.to; k += 1) {
      if (pixel(picture, line, line.inside, k) & pixel(picture, line, line.outside, k)) {
        pixels.push(k);
        run += 1;
        if (run > longest) longest = run;
      } else run = 0;
    }
  }
  return { pixels, run: longest };
}

/** The edge is clear at this position: the rule is passed there. */
const clear = (crossing: number, share: number): boolean => crossing < VERIFY_LIMITS.inkCrossPixels && share <= VERIFY_LIMITS.inkEdgeShare;

/** The page fraction of the edge after it moved to pixel line `index`, with as few decimals as measure to the same line again. */
function positionOf(picture: EdgePicture, side: EdgeSide, index: number): number {
  const horizontal = side === 'top' || side === 'bottom';
  const size = horizontal ? picture.height : picture.width;
  const first = side === 'top' || side === 'left';
  const exact = (first ? index : index + 1) / size;
  for (let decimals = 4; decimals <= 8; decimals += 1) {
    const rounded = Number(exact.toFixed(decimals));
    if ((first ? Math.round(rounded * size) : Math.round(rounded * size) - 1) === index) return rounded;
  }
  return exact;
}

interface Candidate {
  fix: EdgeFix;
  share: number;
}

/** The base line of an edge (its first or last pixel line inside the box), the one of the opposite edge, and how many lines the picture has that way. */
function frameOf(picture: EdgePicture, box: EdgeBox, side: EdgeSide): { base: number; other: number; extent: number } {
  return {
    base: side === 'top' ? box.y0 : side === 'bottom' ? box.y1 : side === 'left' ? box.x0 : box.x1,
    other: side === 'top' ? box.y1 : side === 'bottom' ? box.y0 : side === 'left' ? box.x1 : box.x0,
    extent: side === 'top' || side === 'bottom' ? picture.height : picture.width,
  };
}

/**
 * Every position of an edge within `window` pixels at which the rule is passed, the best first: the least crossing, then the shortest move,
 * then down or to the right (two regions that lie on each other, the answers of a column, share the line between them, and both choose the same
 * one when a tie goes the same way for both: "outwards" would be opposite for the two), then the least dark around it. Outwards the region only
 * grows (nothing of it is lost); inwards it shrinks, which is only offered when what it gives up is nothing but the tips that go across the
 * edge now.
 */
function nearFixes(picture: EdgePicture, box: EdgeBox, side: EdgeSide, window: number, crossing: readonly number[]): EdgeFix[] {
  const out = towardsOutside(side);
  const { base, other, extent } = frameOf(picture, box, side);
  // The tips that go across the edge now, with two pixels on either side: giving up ink there is what a move inwards may cost.
  const tips = new Set<number>();
  for (const k of crossing) for (let d = -2; d <= 2; d += 1) tips.add(k + d);
  const found: Candidate[] = [];
  const current = lineOf(picture, box, side, 0);
  for (let distance = 1; distance <= window; distance += 1) {
    for (const outward of [true, false]) {
      const shift = (outward ? out : -out) * distance;
      const moved = base + shift;
      if (moved < 1 || moved > extent - 2 || Math.abs(moved - other) < 8) continue;
      if (!outward) {
        // The lines that the region gives up: from the line just inside the edge to the one before the new line.
        const lost: [number, number] = side === 'top' || side === 'left' ? [base, base + distance - 1] : [base - distance + 1, base];
        let onlyTips = true;
        for (let at = lost[0]; at <= lost[1] && onlyTips; at += 1) {
          for (let k = current.from; k <= current.to; k += 1) {
            if (pixel(picture, current, at, k) && !tips.has(k)) {
              onlyTips = false;
              break;
            }
          }
        }
        if (!onlyTips) continue;
      }
      const line = lineOf(picture, box, side, shift);
      const crossed = crossingCount(picture, line);
      const share = shareAround(picture, line);
      if (clear(crossed, share)) found.push({ fix: { position: positionOf(picture, side, moved), move: shift, crossing: crossed }, share });
    }
  }
  found.sort((a, b) => a.fix.crossing - b.fix.crossing || Math.abs(a.fix.move) - Math.abs(b.fix.move) || (a.fix.move > 0 ? 0 : 1) - (b.fix.move > 0 ? 0 : 1) || a.share - b.share);
  return found.map((entry) => entry.fix);
}

/** The nearest position OUTWARDS within `window` pixels at which the rule is passed: the region grows, nothing of it is lost. */
function farFix(picture: EdgePicture, box: EdgeBox, side: EdgeSide, window: number): EdgeFix | undefined {
  const out = towardsOutside(side);
  const { base, extent } = frameOf(picture, box, side);
  for (let distance = 1; distance <= window; distance += 1) {
    const shift = out * distance;
    const moved = base + shift;
    if (moved < 1 || moved > extent - 2) continue;
    const line = lineOf(picture, box, side, shift);
    const crossed = crossingCount(picture, line);
    if (clear(crossed, shareAround(picture, line))) return { position: positionOf(picture, side, moved), move: shift, crossing: crossed };
  }
  return undefined;
}

/**
 * How far the pieces of ink that go across the edge poke across it: for each (a connected component of dark pixels, 8-connected, within 40
 * pixels across and 60 along the edge) the smaller of its depths inside and outside the edge, and the largest over the pieces. It stops counting
 * once a piece is deeper than `inkTipPixels` on both sides and says `inkTipPixels + 1`.
 */
function pokeOf(picture: EdgePicture, line: Line, pixels: readonly number[], outside: -1 | 1): number {
  const cap = VERIFY_LIMITS.inkTipPixels;
  const inward = -outside;
  const index = (at: number, along: number): number => (line.horizontal ? at * picture.width + along : along * picture.width + at);
  const seen = new Set<number>();
  let poke = 0;
  for (const start of pixels) {
    if (seen.has(index(line.inside, start))) continue;
    let deepestInside = 0;
    let deepestOutside = 0;
    const stack: number[] = [line.inside, start];
    seen.add(index(line.inside, start));
    while (stack.length > 0) {
      const along = stack.pop() as number;
      const at = stack.pop() as number;
      const relative = (at - line.inside) * inward;
      if (relative >= 0) deepestInside = Math.max(deepestInside, relative + 1);
      else deepestOutside = Math.max(deepestOutside, -relative);
      if (deepestInside > cap && deepestOutside > cap) return cap + 1;
      for (let dAt = -1; dAt <= 1; dAt += 1) {
        for (let dAlong = -1; dAlong <= 1; dAlong += 1) {
          if (dAt === 0 && dAlong === 0) continue;
          const nextAt = at + dAt;
          const nextAlong = along + dAlong;
          if (Math.abs((nextAt - line.inside) * inward) > 40 || Math.abs(nextAlong - start) > 60) continue;
          if (nextAt < 0 || nextAt >= line.limit || nextAlong < 0 || nextAlong >= (line.horizontal ? picture.width : picture.height)) continue;
          const key = index(nextAt, nextAlong);
          if (seen.has(key) || !picture.dark[key]) continue;
          seen.add(key);
          stack.push(nextAt, nextAlong);
        }
      }
    }
    poke = Math.max(poke, Math.min(deepestInside, deepestOutside));
  }
  return poke;
}

function analyse(picture: EdgePicture, box: EdgeBox, side: EdgeSide): EdgeDetail {
  const line = lineOf(picture, box, side, 0);
  const { pixels, run } = crossingPixels(picture, line);
  const detail: EdgeDetail = { run, poke: pokeOf(picture, line, pixels, towardsOutside(side)), fixes: nearFixes(picture, box, side, VERIFY_LIMITS.inkFixWindow, pixels) };
  // An edge that cuts more than tips: where is the nearest clear position outwards, farther than the window?
  if (detail.poke > VERIFY_LIMITS.inkTipPixels || run >= VERIFY_LIMITS.inkThickRun) {
    const far = farFix(picture, box, side, VERIFY_LIMITS.inkFarWindow);
    if (far !== undefined) detail.far = far;
  }
  return detail;
}

/**
 * The measure of the ink along the edges of a region (`ink`), with what can be done about each edge that fails the rule: the positions at which
 * it is passed (`fixes`, the best first), the depth by which the ink that goes across it pokes across (`poke`), the longest run of crossing
 * pixels and, for an edge that cuts more than tips, the nearest clear position outwards (`far`). `pointsPerPixel` says how long a pixel is.
 */
export function explainEdges(picture: EdgePicture, rect: Rect, ink: EdgeInk, pointsPerPixel?: number): EdgeInk {
  const box = boxOf(picture, rect);
  const detail: Partial<Record<EdgeSide, EdgeDetail>> = {};
  for (const side of SIDES) {
    const crossed = ink.cross?.[side] ?? 0;
    if (crossed >= VERIFY_LIMITS.inkCrossPixels || ink[side] > VERIFY_LIMITS.inkEdgeShare) detail[side] = analyse(picture, box, side);
  }
  return { ...ink, ...(pointsPerPixel !== undefined ? { pointsPerPixel } : {}), ...(Object.keys(detail).length > 0 ? { detail } : {}) };
}
