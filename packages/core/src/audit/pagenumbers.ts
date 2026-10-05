import type { PageText, TextLine } from '../model/types.js';

/**
 * The page numbers a book prints in its footers or in its running heads, and how they map to PDF pages. A table of
 * contents and the lists on chapter openers give printed page numbers; the PDF page of an entry is found through them.
 * Most books keep a constant offset between the printed number and the position in the file (a cover and a title page
 * come first), some restart the numbering for the back matter, so a printed number is looked up as printed first and
 * through the offset second.
 */

export interface PageNumbering {
  /** The printed number of a zero-based page, when the page prints one. */
  printed(page: number): number | undefined;
  /** The zero-based page that prints this number, or the page the offset points to. */
  pageOf(printed: number): number | undefined;
  /** Printed number minus zero-based page index, when most numbered pages agree on one. */
  offset: number | undefined;
  /** Share of the pages that print a number. */
  numbered: number;
  /** Number of pages that follow the offset. */
  agreeing: number;
}

/** The band at the bottom of a page where a running page number is looked for. */
const BAND = 0.1;
/** The band at the top: a running head sits lower than a footer does (its line may end at 0.11 of the page). */
const TOP_BAND = 0.13;

/** Where a number was found: in a line of its own, or at one end of the text of a running head or foot. */
export type NumberSource = 'footer' | 'header' | 'head-text';

/** The page number that stands at one end of a running head ("14   Prerequisites", "Shapes • Section 1.1 5"). */
function numberInText(text: string): number | undefined {
  const trimmed = text.trim();
  const first = /^(\d{1,4})\s+\S/.exec(trimmed);
  const last = /\S\s+(\d{1,4})$/.exec(trimmed);
  // A text that starts with a number and ends with another one says nothing sure.
  if (first && last) return undefined;
  const found = first ?? last;
  return found ? Number(found[1]) : undefined;
}

/**
 * The page number of a page and where it stands. Lines that hold only a number, in the bottom or top band, come first (the
 * bottom band before the top, then the one nearest the horizontal middle); a page without one may carry its number at one
 * end of the text of a running head or foot.
 */
export function printedNumberFrom(page: PageText): { value: number; source: NumberSource } | undefined {
  const candidates: { line: TextLine; value: number }[] = [];
  for (const line of page.lines) {
    if (!/^\d{1,4}$/.test(line.text.trim())) continue;
    const bottom = line.rect.top >= 1 - BAND;
    const top = line.rect.bottom <= TOP_BAND;
    if (!bottom && !top) continue;
    // A page number is small: wide or tall numbers are part of a figure or a table.
    if (line.rect.right - line.rect.left > 0.12) continue;
    candidates.push({ line, value: Number(line.text.trim()) });
  }
  if (candidates.length > 0) {
    // The bottom band first (most books print the number there), then the one nearest the middle of the page.
    candidates.sort((a, b) => {
      const aBottom = a.line.rect.top >= 1 - BAND ? 0 : 1;
      const bBottom = b.line.rect.top >= 1 - BAND ? 0 : 1;
      if (aBottom !== bBottom) return aBottom - bBottom;
      const middle = (line: TextLine): number => Math.abs((line.rect.left + line.rect.right) / 2 - 0.5);
      return middle(a.line) - middle(b.line);
    });
    const best = candidates[0] as { line: TextLine; value: number };
    return { value: best.value, source: best.line.rect.top >= 1 - BAND ? 'footer' : 'header' };
  }
  // The number is part of the text of a running head: the first line of the page, small, with words around the number.
  const heads = page.lines.filter((line) => line.rect.bottom <= TOP_BAND && line.chars >= 6 && line.rect.right - line.rect.left <= 0.9);
  const sizes = page.lines.map((line) => line.fontSize).sort((a, b) => a - b);
  const typical = sizes[Math.floor(sizes.length / 2)] ?? 0;
  for (const line of heads) {
    // A heading is set larger than the text; a running head is not.
    if (typical > 0 && line.fontSize > typical * 1.3) continue;
    const value = numberInText(line.text);
    if (value !== undefined) return { value, source: 'head-text' };
  }
  return undefined;
}

/** The printed number of a page (see {@link printedNumberFrom}). */
export function printedNumberOf(page: PageText): number | undefined {
  return printedNumberFrom(page)?.value;
}

export function readPageNumbers(pages: readonly PageText[]): PageNumbering {
  const printedBy = new Map<number, number>();
  for (const page of pages) {
    const value = printedNumberOf(page);
    if (value !== undefined) printedBy.set(page.page, value);
  }
  const histogram = new Map<number, number>();
  for (const [page, value] of printedBy) histogram.set(value - page, (histogram.get(value - page) ?? 0) + 1);
  let offset: number | undefined;
  let agreeing = 0;
  for (const [candidate, count] of histogram) {
    if (count > agreeing || (count === agreeing && offset !== undefined && Math.abs(candidate) < Math.abs(offset))) {
      offset = candidate;
      agreeing = count;
    }
  }
  const total = Math.max(1, pages.length);
  if (agreeing < 3 || agreeing < 0.4 * printedBy.size) {
    offset = undefined;
    agreeing = 0;
  }
  const firstWith = new Map<number, number>();
  for (const [page, value] of [...printedBy].sort((a, b) => a[0] - b[0])) if (!firstWith.has(value)) firstWith.set(value, page);
  return {
    printed: (page) => printedBy.get(page),
    pageOf: (printed) => {
      if (offset !== undefined) {
        const guess = printed - offset;
        if (guess >= 0 && guess < pages.length && (printedBy.get(guess) === printed || !printedBy.has(guess))) return guess;
      }
      const found = firstWith.get(printed);
      if (found !== undefined) return found;
      if (offset !== undefined) {
        const guess = printed - offset;
        if (guess >= 0 && guess < pages.length) return guess;
      }
      return undefined;
    },
    offset,
    numbered: printedBy.size / total,
    agreeing,
  };
}
