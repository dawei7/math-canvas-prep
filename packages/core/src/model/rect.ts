import { AUTHORING, LIMITS } from '../rules/constants.js';
import { McPrepError } from '../rules/issues.js';
import type { PageSize, Rect } from './types.js';

export function makeRect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

export const rectWidth = (r: Rect): number => r.right - r.left;
export const rectHeight = (r: Rect): number => r.bottom - r.top;
export const rectArea = (r: Rect): number => Math.max(0, rectWidth(r)) * Math.max(0, rectHeight(r));

export function roundNumber(value: number, digits: number = AUTHORING.digits): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundRect(r: Rect, digits: number = AUTHORING.digits): Rect {
  return {
    left: roundNumber(r.left, digits),
    top: roundNumber(r.top, digits),
    right: roundNumber(r.right, digits),
    bottom: roundNumber(r.bottom, digits),
  };
}

export const isFiniteRect = (r: Rect): boolean =>
  Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom);

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Puts the rectangle inside the page (0..1), keeping its edges in order. */
export function clampRect(r: Rect): Rect {
  return {
    left: clamp(r.left, 0, 1),
    top: clamp(r.top, 0, 1),
    right: clamp(r.right, 0, 1),
    bottom: clamp(r.bottom, 0, 1),
  };
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** The overlapping area as a share of the smaller of the two rectangles (0 when they do not overlap). */
export function overlapOfSmaller(a: Rect, b: Rect): number {
  const common = intersection(a, b);
  if (!common) return 0;
  const smaller = Math.min(rectArea(a), rectArea(b));
  return smaller <= 0 ? 0 : rectArea(common) / smaller;
}

export function containsRect(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.left >= outer.left - tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

export function unionRect(rects: readonly Rect[]): Rect | null {
  const first = rects[0];
  if (!first) return null;
  let { left, top, right, bottom } = first;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return { left, top, right, bottom };
}

export function rectsEqual(a: Rect, b: Rect, tolerance = 1e-6): boolean {
  return (
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.right - b.right) <= tolerance &&
    Math.abs(a.bottom - b.bottom) <= tolerance
  );
}

export function shiftRect(r: Rect, dx: number, dy: number): Rect {
  return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy };
}

/**
 * Makes the rectangle at least the minimum size of the format (a little larger than the limit, so that it does not sit
 * on the boundary), growing around its centre and keeping it inside the page.
 */
export function enlargeToMinimum(r: Rect): Rect {
  const width = Math.max(rectWidth(r), AUTHORING.enlargeWidth);
  const height = Math.max(rectHeight(r), AUTHORING.enlargeHeight);
  const centreX = (r.left + r.right) / 2;
  const centreY = (r.top + r.bottom) / 2;
  const left = clamp(centreX - width / 2, 0, 1 - width);
  const top = clamp(centreY - height / 2, 0, 1 - height);
  return { left, top, right: left + width, bottom: top + height };
}

export function isBelowMinimum(r: Rect): boolean {
  return (
    rectWidth(r) < LIMITS.minWidth - AUTHORING.epsilon || rectHeight(r) < LIMITS.minHeight - AUTHORING.epsilon
  );
}

/** `0.08,0.12,0.92,0.31`: the compact form used in messages and accepted on the command line. */
export function formatRect(r: Rect, digits = 4): string {
  return [r.left, r.top, r.right, r.bottom].map((value) => roundNumber(value, digits).toString()).join(',');
}

export const RECT_FORMS =
  'a {left,top,right,bottom} object, an array [left,top,right,bottom] or the text "left,top,right,bottom" (fractions of the page, 0..1, origin top-left)';

/** Reads a rectangle from the forms an agent is likely to write; throws E_RECT with the accepted forms otherwise. */
export function parseRect(input: unknown): Rect {
  let values: unknown[] | undefined;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseRect(JSON.parse(trimmed) as unknown);
      } catch (error) {
        if (error instanceof McPrepError) throw error;
        throw rectError(input, 'it is not valid JSON');
      }
    }
    values = trimmed.split(/[\s,;]+/).filter((part) => part.length > 0);
  } else if (Array.isArray(input)) {
    values = input as unknown[];
  } else if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    values = [record['left'], record['top'], record['right'], record['bottom']];
  }
  if (!values || values.length !== 4) throw rectError(input, 'four numbers are needed');
  const numbers = values.map((value) => (typeof value === 'string' ? Number(value) : value));
  if (!numbers.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
    throw rectError(input, 'every value must be a finite number');
  }
  const [left, top, right, bottom] = numbers as [number, number, number, number];
  return { left, top, right, bottom };
}

function rectError(input: unknown, reason: string): McPrepError {
  return new McPrepError('E_RECT', `Cannot read a rectangle from ${JSON.stringify(input)}: ${reason}.`, {
    hint: `Use ${RECT_FORMS}.`,
  });
}

/** Page fractions to points of the displayed page. */
export function rectToPoints(r: Rect, size: PageSize): Rect {
  return {
    left: r.left * size.width,
    top: r.top * size.height,
    right: r.right * size.width,
    bottom: r.bottom * size.height,
  };
}
