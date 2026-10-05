import type { LinePart, PageText, Rect, TextLine } from '../src/model/types.js';

/**
 * Pages of text lines made by hand for the census of numbered runs: no PDF, only the lines with their boxes, as the page reader gives them. `x` and `y`
 * are the left edge and the top of a line as fractions of the page; a line is 0.014 high and as wide as its characters (0.0065 each) unless `w` says.
 */

export interface L {
  text: string;
  x: number;
  y: number;
  w?: number;
  /** The font size; the usual one is 11. */
  size?: number;
  bold?: boolean;
  column?: number;
  headerFooter?: boolean;
  /** The pieces of a line that holds several items side by side (the reader's `cells`). */
  cells?: { text: string; x: number }[];
}

const HEIGHT = 0.014;
const CHAR = 0.0065;

export function line(entry: L): TextLine {
  const width = entry.w ?? entry.text.length * CHAR;
  const rect: Rect = { left: entry.x, top: entry.y, right: Math.min(1, entry.x + width), bottom: entry.y + HEIGHT };
  const cells: LinePart[] | undefined = entry.cells?.map((cell) => ({ text: cell.text, chars: cell.text.replace(/\s/g, '').length, rect: { left: cell.x, top: entry.y, right: Math.min(1, cell.x + cell.text.length * CHAR), bottom: entry.y + HEIGHT } }));
  return {
    text: entry.text,
    rect,
    fontSize: entry.size ?? 11,
    column: entry.column ?? 0,
    chars: entry.text.replace(/\s/g, '').length,
    ...(entry.bold !== undefined ? { bold: entry.bold } : {}),
    ...(entry.headerFooter === true ? { headerFooter: true } : {}),
    ...(cells !== undefined ? { cells } : {}),
  };
}

/** A page of the given lines, in the order given (reading order). */
export function page(lines: readonly L[], index = 0, columns = 1): PageText {
  return { page: index, size: { width: 595, height: 842, rotation: 0 }, lines: lines.map(line), columns, hasText: lines.length > 0 };
}

/** A page without any text (a scan, a picture). */
export const blank = (index: number): PageText => ({ page: index, size: { width: 595, height: 842, rotation: 0 }, lines: [], columns: 1, hasText: false });

/** `count` lines `LABEL TEXT` one under the other, `pitch` apart, from `first` on: the label is made by `label(n)`. */
export function listing(options: { from: number; to: number; x?: number; y?: number; pitch?: number; label?: (n: number) => string; text?: (n: number) => string; column?: number; step?: number }): L[] {
  const { from, to } = options;
  const lines: L[] = [];
  let row = 0;
  for (let n = from; n <= to; n += options.step ?? 1) {
    const label = options.label ?? ((k: number) => `${k}.`);
    const text = options.text ?? ((k: number) => `Find the value of x when ${k} is added to 3 and the sum is halved.`);
    lines.push({ text: `${label(n)} ${text(n)}`, x: options.x ?? 0.12, y: (options.y ?? 0.2) + row * (options.pitch ?? 0.05), ...(options.column !== undefined ? { column: options.column } : {}) });
    row += 1;
  }
  return lines;
}

/** A body of plain lines (running text) of the given number, from `y` on, at the left margin. */
export function prose(count: number, y = 0.1, x = 0.12): L[] {
  return Array.from({ length: count }, (_unused, k) => ({ text: `A line of ordinary text that goes on and on, number ${k}, without any label.`, x, y: y + k * 0.02 }));
}

/** The pages of a book as the census takes them: a list indexed by the page number. */
export const book = (...pages: PageText[]): PageText[] => pages.map((entry, at) => ({ ...entry, page: at }));
