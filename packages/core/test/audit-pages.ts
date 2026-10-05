import { INK_BANDS, type PageText, type TextLine } from '../src/model/types.js';
import { DEFAULT_BOOK_PATTERNS } from '../src/audit/scan.js';
import type { BookEntry } from '../src/audit/sections.js';

/**
 * Practice pages built by hand, line by line, for tests of the audit: a line is a text, a place and a size. Nothing here
 * needs a PDF, and every page, text and number is made up.
 */

export interface Spec {
  text: string;
  left: number;
  top: number;
  right?: number;
  size?: number;
  bold?: boolean;
  /** The text column the extraction put the line in (default 0). */
  column?: number;
  /** The height of the line's box; the default is one line of text. */
  height?: number;
}

export const HEIGHT = 0.0155;

/** The heading that ends a practice set with the default patterns: their first stop word in title case (the tests take it from the defaults and do not repeat it). */
export const STOP_HEADING = (DEFAULT_BOOK_PATTERNS.stopWords[0] ?? '').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

export function line(spec: Spec, withFonts = true): TextLine {
  const size = spec.size ?? 12;
  const right = spec.right ?? Math.min(0.95, spec.left + spec.text.length * 0.0075 * (size / 12));
  return {
    text: spec.text,
    rect: { left: spec.left, top: spec.top, right, bottom: spec.top + (spec.height ?? HEIGHT * (size / 12)) },
    fontSize: size,
    column: spec.column ?? 0,
    chars: spec.text.replace(/\s/g, '').length,
    ...(withFonts ? { bold: spec.bold === true } : {}),
  };
}

/** The ink profile of a page: the given rows (page fractions) are dark across the given share of the width. */
export function inkProfile(rows: readonly { from: number; to: number; share?: number }[]): number[] {
  const bands = new Array<number>(INK_BANDS).fill(0);
  for (const row of rows) {
    for (let band = Math.floor(row.from * INK_BANDS); band < Math.min(INK_BANDS, Math.ceil(row.to * INK_BANDS)); band += 1) bands[band] = row.share ?? 0.4;
  }
  return bands;
}

export interface PageOptions {
  /** How many text columns the extraction found (default 1). */
  columns?: number;
  ink?: number[];
}

/** A page with a footer (the page number, flagged the way the reader flags running footers). */
export function page(index: number, specs: Spec[], options: PageOptions = {}): PageText {
  const lines = specs.map((spec) => line(spec));
  lines.push({ ...line({ text: String(index + 1), left: 0.5, top: 0.926, size: 10 }), headerFooter: true });
  return {
    page: index,
    size: { width: 595, height: 842, rotation: 0 },
    lines,
    columns: options.columns ?? 1,
    hasText: true,
    ...(options.ink ? { ink: options.ink } : {}),
  };
}

/** A section whose practice set starts at the heading of page `first` and ends at the end of the book. */
export function section(first: number, pageCount: number, id = '1.1'): BookEntry {
  return {
    title: 'Practice',
    page: first,
    depth: 1,
    id,
    label: id,
    kind: 'section',
    confidence: 1,
    evidence: [],
    differences: [],
    practice: { page: first, top: 0.1, index: 0, text: `${id} Practice - Title`, end: { page: pageCount, top: 0, why: 'the end of the book' } },
  };
}

export const heading = (id = '1.1'): Spec => ({ text: `${id} Practice - Title`, left: 0.33, top: 0.1, size: 16.9, bold: true });

/** `count` lines of running text, one under the other, with the pitch of a paragraph, from `top`; `short` lines fit a column of half the page. */
export function paragraph(prefix: string, count: number, top: number, left = 0.17, column = 0, short = false): Spec[] {
  return Array.from({ length: count }, (_, k) => ({ text: `${prefix} line ${k + 1}${short ? '' : ' of the statement and its setting'}`, left, top: top + k * 0.0175, column }));
}
