import { toScreen, type PageBox } from './geometry.js';
import type { Rect } from '@mcprep/core/pure';

/**
 * Where the small label of a frame goes on the page. A book can carry 44 frames on one two-column page, only a few pixels
 * apart: a fixed 18 pixel label would pile up. The label is as tall as its frame allows (at most 18, at least 11 pixels),
 * and goes into the free space beside the frame: to the left when there is room before the next frame on its line (or the
 * edge of the page), else to the right, else inside its top-left corner.
 */

export interface ChipItem {
  id: string;
  label: string;
  rect: Rect;
}

export interface Chip {
  /** Top-left corner and size in CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  side: 'left' | 'right' | 'inside';
}

export const CHIP_HEIGHT = 18;
export const CHIP_MIN_HEIGHT = 11;
const GAP = 6;

/** The size of a label for a frame that is `heightPx` tall. */
export function chipSize(label: string, heightPx: number): { w: number; h: number; fontSize: number } {
  const h = Math.min(CHIP_HEIGHT, Math.max(CHIP_MIN_HEIGHT, Math.floor(heightPx) - 1));
  const fontSize = Math.max(8, Math.min(11, h * 0.62));
  const padding = h < CHIP_HEIGHT ? 8 : 12;
  return { w: Math.max(h + 6, label.length * fontSize * 0.6 + padding), h, fontSize };
}

/** Places the labels of the frames of one page. Quadratic in the frames of that page (a few dozen), never in the document. */
export function placeChips(items: readonly ChipItem[], box: PageBox): Map<string, Chip> {
  const placed = new Map<string, Chip>();
  const eps = 1e-6;
  for (const item of items) {
    const s = toScreen(item.rect, box);
    const size = chipSize(item.label, s.h);
    let leftLimit = 0;
    let rightLimit = box.width;
    for (const other of items) {
      if (other === item) continue;
      // Only frames on the same line of the page limit the room beside this one.
      if (other.rect.bottom <= item.rect.top + eps || other.rect.top >= item.rect.bottom - eps) continue;
      if (other.rect.right <= item.rect.left + eps) leftLimit = Math.max(leftLimit, other.rect.right * box.width);
      else if (other.rect.left >= item.rect.right - eps) rightLimit = Math.min(rightLimit, other.rect.left * box.width);
    }
    const need = size.w + GAP + 2;
    const leftRoom = s.x - leftLimit;
    const rightRoom = rightLimit - (s.x + s.w);
    if (leftRoom >= need) placed.set(item.id, { ...size, x: s.x - size.w - GAP, y: s.y, side: 'left' });
    else if (rightRoom >= need) placed.set(item.id, { ...size, x: s.x + s.w + GAP, y: s.y, side: 'right' });
    else placed.set(item.id, { ...size, x: s.x + 2, y: s.y + 1, side: 'inside' });
  }
  return placed;
}
