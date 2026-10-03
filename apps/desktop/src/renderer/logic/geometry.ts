import type { Frame, PageText, Rect } from '@mcprep/core/pure';
import { AUTHORING, LIMITS, linesInRect, rectHeight } from '@mcprep/core/pure';

/** Where a page is on the screen: its top-left corner in CSS pixels and its size. */
export interface PageBox {
  width: number;
  height: number;
}

export const toScreen = (rect: Rect, box: PageBox): { x: number; y: number; w: number; h: number } => ({
  x: rect.left * box.width,
  y: rect.top * box.height,
  w: (rect.right - rect.left) * box.width,
  h: (rect.bottom - rect.top) * box.height,
});

export const fromScreen = (x: number, y: number, box: PageBox): { x: number; y: number } => ({ x: x / box.width, y: y / box.height });

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Handle positions in pixels: they sit OUTSIDE the outline (the owner's rule: handles point outward). */
export function handlePositions(rect: Rect, box: PageBox, offset = 9): Record<HandleName, { x: number; y: number }> {
  const { x, y, w, h } = toScreen(rect, box);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    nw: { x: x - offset, y: y - offset },
    n: { x: cx, y: y - offset },
    ne: { x: x + w + offset, y: y - offset },
    e: { x: x + w + offset, y: cy },
    se: { x: x + w + offset, y: y + h + offset },
    s: { x: cx, y: y + h + offset },
    sw: { x: x - offset, y: y + h + offset },
    w: { x: x - offset, y: cy },
  };
}

/** The rectangle after dragging `handle` by (dx, dy) in page fractions; never smaller than the minimum or off the page. */
export function resizeRect(rect: Rect, handle: HandleName, dx: number, dy: number): Rect {
  let { left, top, right, bottom } = rect;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  left = clamp01(left);
  right = clamp01(right);
  top = clamp01(top);
  bottom = clamp01(bottom);
  const minWidth = LIMITS.minWidth * 1.05;
  const minHeight = LIMITS.minHeight * 1.05;
  if (right - left < minWidth) {
    if (handle.includes('w')) left = right - minWidth;
    else right = left + minWidth;
  }
  if (bottom - top < minHeight) {
    if (handle.includes('n')) top = bottom - minHeight;
    else bottom = top + minHeight;
  }
  return { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(1, right), bottom: Math.min(1, bottom) };
}

/** A rectangle from two corners in any order, put inside the page. */
export function rectFromCorners(ax: number, ay: number, bx: number, by: number): Rect {
  return { left: clamp01(Math.min(ax, bx)), top: clamp01(Math.min(ay, by)), right: clamp01(Math.max(ax, bx)), bottom: clamp01(Math.max(ay, by)) };
}

/** The smallest rectangle around the parts of a unit on one page. */
export function unitArea(frames: readonly Frame[], frame: Frame): Rect {
  const parts = frame.unit === undefined ? [frame] : frames.filter((item) => item.unit === frame.unit && item.page === frame.page);
  return {
    left: Math.min(...parts.map((part) => part.rect.left)),
    top: Math.min(...parts.map((part) => part.rect.top)),
    right: Math.max(...parts.map((part) => part.rect.right)),
    bottom: Math.max(...parts.map((part) => part.rect.bottom)),
  };
}

/** Parts of the frame's unit on its page, top to bottom (or just the frame). */
export function partsOnPage(frames: readonly Frame[], frame: Frame): Frame[] {
  const parts = frame.unit === undefined ? [frame] : frames.filter((item) => item.unit === frame.unit && item.page === frame.page);
  return [...parts].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

/**
 * The frame that a tap on a text line makes: that line, across the width of the text block it belongs to, with the
 * padding the rest of the tools use. Without a line under the tap: a one-line frame of the default width around it.
 */
export function frameAtTap(text: PageText | undefined, x: number, y: number): Rect {
  const lines = text?.lines.filter((line) => line.headerFooter !== true) ?? [];
  // The tap is on a line when it is at the height of the line and within the width of the text block the line belongs to.
  const hit = lines.find((line) => {
    if (y < line.rect.top - 0.004 || y > line.rect.bottom + 0.004) return false;
    const block = lines.filter((other) => other.column === line.column);
    return x >= Math.min(...block.map((other) => other.rect.left)) - 0.02 && x <= Math.max(...block.map((other) => other.rect.right)) + 0.02;
  });
  if (hit) {
    const column = lines.filter((line) => line.column === hit.column);
    const left = Math.max(0, Math.min(...column.map((line) => line.rect.left)) - 0.012);
    const right = Math.min(1, Math.max(...column.map((line) => line.rect.right)) + 0.012);
    return { left, top: Math.max(0, hit.rect.top - AUTHORING.startPadding), right, bottom: Math.min(1, hit.rect.bottom + AUTHORING.endPadding) };
  }
  const left = clamp01(x - AUTHORING.defaultWidth / 2);
  const right = Math.min(1, left + AUTHORING.defaultWidth);
  const top = clamp01(y - AUTHORING.defaultHeight / 2);
  return { left: Math.max(0, right - AUTHORING.defaultWidth), top: Math.min(top, 1 - AUTHORING.defaultHeight), right, bottom: Math.min(1, Math.min(top, 1 - AUTHORING.defaultHeight) + AUTHORING.defaultHeight) };
}

/** Dividers for cutting a freshly drawn area into parts: the markers found in its lines, else one cut in the middle. */
export function middleCut(rect: Rect, text: PageText | undefined): number[] {
  const inside = text ? linesInRect(text.lines, rect) : [];
  const middle = (rect.top + rect.bottom) / 2;
  if (inside.length === 0) return [middle];
  // Put the cut at the start of the line nearest to the middle, but only if that leaves two real parts.
  const nearest = [...inside].sort((a, b) => Math.abs(a.rect.top - middle) - Math.abs(b.rect.top - middle))[0];
  const cut = nearest ? Math.max(rect.top + AUTHORING.minPieceHeight, nearest.rect.top - AUTHORING.startPadding) : middle;
  return rect.bottom - cut >= AUTHORING.minPieceHeight && cut - rect.top >= AUTHORING.minPieceHeight ? [cut] : [middle];
}

export const heightOf = rectHeight;
