import type { PageText, TextLine } from '../model/types.js';

/**
 * The page numbers a book prints in its footers (or headers), and how they map to PDF pages. A table of contents and
 * the lists on chapter openers give printed page numbers; the PDF page of an entry is found through them. Most books
 * keep a constant offset between the printed number and the position in the file (a cover and a title page come
 * first), some restart the numbering for the back matter, so a printed number is looked up as printed first and
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

/** The band at the top and bottom of a page where a running page number is looked for. */
const BAND = 0.1;

/** Lines that hold only a page number, in the bottom or top band; the one nearest the horizontal middle wins. */
export function printedNumberOf(page: PageText): number | undefined {
  const candidates: { line: TextLine; value: number }[] = [];
  for (const line of page.lines) {
    if (!/^\d{1,4}$/.test(line.text.trim())) continue;
    const bottom = line.rect.top >= 1 - BAND;
    const top = line.rect.bottom <= BAND;
    if (!bottom && !top) continue;
    // A page number is small: wide or tall numbers are part of a figure or a table.
    if (line.rect.right - line.rect.left > 0.12) continue;
    candidates.push({ line, value: Number(line.text.trim()) });
  }
  if (candidates.length === 0) return undefined;
  // The bottom band first (most books print the number there), then the one nearest the middle of the page.
  candidates.sort((a, b) => {
    const aBottom = a.line.rect.top >= 1 - BAND ? 0 : 1;
    const bBottom = b.line.rect.top >= 1 - BAND ? 0 : 1;
    if (aBottom !== bBottom) return aBottom - bBottom;
    const middle = (line: TextLine): number => Math.abs((line.rect.left + line.rect.right) / 2 - 0.5);
    return middle(a.line) - middle(b.line);
  });
  return (candidates[0] as { value: number }).value;
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
