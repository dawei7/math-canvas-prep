import { rectHeight } from '../model/rect.js';
import type { Rect, TextLine } from '../model/types.js';
import { AUTHORING } from '../rules/constants.js';

/**
 * Snapping to text lines, the behaviour of the Android app: an edge that cuts through a line of text moves off it
 * (a line that is mostly inside the frame is taken whole, one that is mostly outside is left out), and a divider
 * between parts moves onto the start of the nearest line when one is close, so that no half line is ever framed.
 */

/** Whether the line is beside the rect (its centre is between left and right). */
export function lineIsBeside(line: TextLine, rect: Rect): boolean {
  const centre = (line.rect.left + line.rect.right) / 2;
  return centre >= rect.left && centre <= rect.right;
}

/** The lines that belong to the rect: beside it and at least half of their height inside it. */
export function linesInRect(lines: readonly TextLine[], rect: Rect, minInside = 0.5): TextLine[] {
  return lines.filter((line) => {
    if (!lineIsBeside(line, rect)) return false;
    const height = rectHeight(line.rect);
    if (height <= 0) return false;
    const overlap = Math.min(line.rect.bottom, rect.bottom) - Math.max(line.rect.top, rect.top);
    return overlap / height >= minInside;
  });
}

/** Whether the two lines overlap sideways (so that one can cut into the other when they are in the same column). */
function overlapsSideways(a: TextLine, b: TextLine): boolean {
  return Math.min(a.rect.right, b.rect.right) > Math.max(a.rect.left, b.rect.left);
}

/**
 * Where a part that begins with this line should start: a little above it, so the line is wholly inside. With the
 * `neighbours` (the other lines of the page) the start never cuts into the line above: when that line is closer than
 * the padding, the start sits exactly at its bottom.
 */
export function lineStart(line: TextLine, padding: number = AUTHORING.startPadding, neighbours?: readonly TextLine[]): number {
  let y = Math.max(0, line.rect.top - padding);
  if (neighbours) {
    for (const other of neighbours) {
      if (other === line || other.rect.top >= line.rect.top) continue;
      if (other.rect.bottom > y && other.rect.bottom <= line.rect.top + 1e-9 && overlapsSideways(other, line)) y = other.rect.bottom;
    }
  }
  return y;
}

/** Moves y onto the start of the nearest line when one is within the snap distance. */
export function snapDivider(y: number, lines: readonly TextLine[], distance: number = AUTHORING.snapDistance): number {
  let best: number | undefined;
  for (const line of lines) {
    const start = lineStart(line, AUTHORING.startPadding, lines);
    if (best === undefined || Math.abs(start - y) < Math.abs(best - y)) best = start;
  }
  return best !== undefined && Math.abs(best - y) <= distance ? best : y;
}

export interface SnapChange {
  edge: 'top' | 'bottom';
  from: number;
  to: number;
  /** `whole`: the line was taken in; `out`: the line was left out. */
  how: 'whole' | 'out';
  line: string;
}

export interface SnapResult {
  rect: Rect;
  changes: SnapChange[];
}

const CUT_EPSILON = 0.0004;

/**
 * Moves the top and bottom edges of `rect` off any line they cut through. Left and right are not changed. If snapping
 * would leave less than a minimum-height rectangle the original is returned unchanged.
 */
export function snapRectToLines(rect: Rect, lines: readonly TextLine[]): SnapResult {
  const beside = lines.filter((line) => lineIsBeside(line, rect) && rectHeight(line.rect) > 0);
  const changes: SnapChange[] = [];
  let top = rect.top;
  let bottom = rect.bottom;

  for (let round = 0; round < 6; round += 1) {
    let moved = false;
    for (const line of beside) {
      const height = rectHeight(line.rect);
      if (top > line.rect.top + CUT_EPSILON && top < line.rect.bottom - CUT_EPSILON) {
        const inside = (line.rect.bottom - top) / height;
        const to = inside >= 0.5 ? Math.max(0, line.rect.top - AUTHORING.startPadding) : line.rect.bottom;
        changes.push({ edge: 'top', from: top, to, how: inside >= 0.5 ? 'whole' : 'out', line: line.text });
        top = to;
        moved = true;
      }
      if (bottom > line.rect.top + CUT_EPSILON && bottom < line.rect.bottom - CUT_EPSILON) {
        const inside = (bottom - line.rect.top) / height;
        const to = inside >= 0.5 ? Math.min(1, line.rect.bottom + AUTHORING.endPadding) : Math.max(0, line.rect.top - AUTHORING.endPadding);
        changes.push({ edge: 'bottom', from: bottom, to, how: inside >= 0.5 ? 'whole' : 'out', line: line.text });
        bottom = to;
        moved = true;
      }
    }
    if (!moved) break;
  }
  if (bottom - top < AUTHORING.minPieceHeight) return { rect, changes: [] };
  return { rect: { left: rect.left, top, right: rect.right, bottom }, changes };
}
