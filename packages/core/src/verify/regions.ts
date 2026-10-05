import type { PageText, Rect } from '../model/types.js';
import { foldText } from './labels.js';

/**
 * The text a region holds, read from the lines of its page. A page is indexed once (its lines sorted from top to bottom), so
 * looking at thousands of regions costs a search for each, never a pass over the page or the document.
 *
 * What a person sees first in a crop is the text at its left margin, not the text that is highest: a fraction's numerator,
 * an exponent, the bars of an absolute value and the labels of a figure stand above the number of an exercise and to the
 * right of it. So the "first text" of a region is the first row at the leftmost edge of its text.
 */

/** A piece of text on a page: a text line, or one of the pieces a joined line was made of. */
export interface Piece {
  text: string;
  rect: Rect;
  headerFooter: boolean;
  /** The text line of the page this piece belongs to (the pieces of a joined line share it). */
  line: number;
  /** The font size and the weight of the line the piece belongs to (the text layer gives them for whole lines). */
  fontSize: number;
  bold: boolean;
  /** The column of the page the line was read in. */
  column: number;
}

/** A line belongs to a region when its centre is between the region's left and right edges and half of it is inside. */
const MIN_INSIDE = 0.5;
/** Two pieces are in one row when they share this much of the smaller one's height. */
const SAME_ROW = 0.5;
/** Pieces whose left edge is within this distance of the leftmost one are at the left margin of the region's text. */
export const MARGIN = 0.012;
/** A line whose centre is outside a region but that covers this much of its width runs into it (two exercises joined into one line). */
const STRADDLE = 0.4;
/** A line that comes in from the left counts when it starts in the top share of the region's height. */
const ENTERING_SHARE = 0.7;
/** Lines closer than this many line heights are one block of text (a paragraph); a running head stands further from the text under it. */
const BLOCK_GAP = 1.7;
/** A piece that starts this far left of a region's edge comes in from the left (a line joined across columns); a cut number is narrower. */
const FROM_OUTSIDE = 0.03;

export interface RegionText {
  /** Pieces of text inside the region, from top to bottom (running headers and footers left out). */
  pieces: string[];
  /**
   * Lines that run into the region from a neighbour without having their centre in it: a text layer that joined two exercises
   * of a row into one line cannot be cut at the column, and the line is only known as a whole.
   */
  straddling: string[];
  /** The first row at the left margin of the region's text (the piece at the margin that is highest, with what stands beside it); undefined for a region without text. */
  margin: string | undefined;
  /** The piece that starts that row: its text and its box. */
  marginPiece: { text: string; rect: Rect } | undefined;
  /**
   * The topmost row of the region (the piece that is highest, with what stands beside it on the right), and the piece that starts it: where an
   * equation number stands in the left margin lower down, or the first line is indented, the margin row is not the first row of the text.
   */
  topRow?: string;
  topPiece?: { text: string; rect: Rect };
  /** Everything in the region: the first row at the margin, then the rest from top to bottom. */
  text: string;
  /**
   * Lines that come in from the left and end inside the region, on its first row: a text layer that joined the items of a row
   * into one line ("4 . If two resistors 5 . A ladder is 6 .") ends with the number of the item whose region this is.
   */
  entering: { text: string; rect: Rect }[];
  /** The first piece of the region's own text when the margin piece is a line that comes in from the left (joined across the columns). */
  ownStart?: string;
  /** How many text lines of the page (as `mcprep lines` lists them) have a piece in the region. */
  lines: number;
}

/** The top and the bottom of a page, where running heads, page numbers and an imprint stand. */
const HEAD_BAND = 0.16;
/** Two lines of consecutive pages are the same place when their edges are this close. */
const SAME_PLACE = 0.012;

const hasWords = (text: string): boolean => /\p{L}{3}/u.test(text);
/** An exercise named by a keyword and a number ("Exercise 4.3.4: Let", "Problem 7.", "Aufgabe 1.2."). */
const KEYWORD_ITEM = /^(?:exercise|problem|question|task|aufgabe|übung|uebung)\s+\d[\d.]*[a-z]?\s*[.:)]/iu;
/** A line that starts like an item ("3. x = 2", "(3)", "5a)", "Exercise 4.3.4:") is an answer or an exercise, never a head. */
const startsLikeNumber = (text: string): boolean => /^\(?\d{1,4}[a-z]?\s*[.)](?!\d)/.test(text) || KEYWORD_ITEM.test(text);
const blur = (text: string): string => foldText(text).replace(/\d+/g, '#');
/** Two boxes are in one row when they share this much of the height of the smaller. */
function sameRow(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const smaller = Math.min(a.bottom - a.top, b.bottom - b.top);
  return smaller > 0 && overlap / smaller >= SAME_ROW;
}

export class PageLines {
  /** False when the page has no text layer (a scan), or when no text was given for the page. */
  readonly hasText: boolean;
  private readonly lines: Piece[] = [];
  private tallest = 0;
  private body: number | undefined;

  constructor(page: PageText | undefined) {
    this.hasText = page?.hasText === true;
    (page?.lines ?? []).forEach((line, at) => {
      // A line joined from pieces standing side by side (the rows of two columns, a fraction) is read piece by piece: a
      // region that holds only one of the columns must not be shown the other.
      const pieces = line.parts !== undefined && line.parts.length >= 2 ? line.parts : [line];
      for (const piece of pieces) {
        const text = foldText(piece.text);
        if (text.length === 0) continue;
        this.lines.push({ text, rect: piece.rect, headerFooter: line.headerFooter === true, line: at, fontSize: line.fontSize, bold: line.bold === true, column: line.column });
        this.tallest = Math.max(this.tallest, piece.rect.bottom - piece.rect.top);
      }
    });
    this.lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    this.markHeads();
  }

  /**
   * Running heads that the reader did not flag (a head that changes with the chapter stands on a few pages only): a line at the top
   * of the page on the row of a flagged one (the page number: "14   Prerequisites"), and every line of a page whose text stands in
   * the bottom band alone (the imprint at the end of a booklet) are running furniture.
   */
  private markHeads(): void {
    const anchors = this.lines.filter((piece) => piece.headerFooter && piece.rect.bottom <= HEAD_BAND);
    for (const piece of this.lines) {
      if (piece.headerFooter || piece.rect.bottom > HEAD_BAND || !hasWords(piece.text) || startsLikeNumber(piece.text)) continue;
      if (anchors.some((anchor) => sameRow(anchor.rect, piece.rect))) piece.headerFooter = true;
    }
    const text = this.lines.filter((piece) => !piece.headerFooter);
    if (text.length > 0 && text.every((piece) => piece.rect.top >= 1 - HEAD_BAND && !startsLikeNumber(piece.text))) for (const piece of text) piece.headerFooter = true;
  }

  /**
   * A line at the top or the bottom of the page that stands at the same place with the same text (digits blurred) on three
   * consecutive pages (this one and two of its neighbours, before or after) is a running head. `neighbour(offset)` gives the text of
   * the page that many pages away, or undefined when it was not read.
   */
  markRepeats(neighbour: (offset: number) => PageText | undefined): void {
    const near = new Map<number, PageText['lines']>();
    for (const offset of [-2, -1, 1, 2]) {
      const page = neighbour(offset);
      if (page?.hasText === true) near.set(offset, page.lines);
    }
    if (near.size < 2) return;
    const repeats = (piece: Piece, offset: number): boolean => {
      const lines = near.get(offset);
      if (!lines) return false;
      const text = blur(piece.text);
      return lines.some((line) => Math.abs(line.rect.left - piece.rect.left) <= SAME_PLACE && Math.abs(line.rect.top - piece.rect.top) <= SAME_PLACE && blur(line.text) === text);
    };
    // Whether the neighbour page has a running head or a page number (a line the reader flagged) on the row of this piece; undefined when it was not read.
    const headRow = (piece: Piece, offset: number): boolean | undefined => {
      const lines = near.get(offset);
      if (!lines) return undefined;
      return lines.some((line) => line.headerFooter === true && Math.abs(line.rect.top - piece.rect.top) <= SAME_PLACE && Math.abs(line.rect.bottom - piece.rect.bottom) <= SAME_PLACE);
    };
    for (const piece of this.lines) {
      if (piece.headerFooter || !hasWords(piece.text) || startsLikeNumber(piece.text)) continue;
      if (piece.rect.bottom > HEAD_BAND && piece.rect.top < 1 - HEAD_BAND) continue;
      const before = [repeats(piece, -1), repeats(piece, -2)];
      const after = [repeats(piece, 1), repeats(piece, 2)];
      if ((before[0] && before[1]) || (before[0] && after[0]) || (after[0] && after[1])) {
        piece.headerFooter = true;
        continue;
      }
      // A head that is a different one on every page or on a few (the title of a chapter or a section), alone on the row where both pages next to
      // this one have a running head or a page number that the reader flagged: the reader flags a head by its repeats and a number by its place,
      // and a title with its number joined to it ("... TRIALS51") or a title that stands on two or three pages only is neither.
      // It stands apart from the text: a line of a paragraph, with a line of the same column under it or over it at the usual leading, is body text
      // that happens to start at the height of the heads of the neighbouring pages (the first line of an exam page that has no head of its own).
      const rows = [headRow(piece, -1), headRow(piece, 1)].filter((row) => row !== undefined);
      if (rows.length === 2 && rows.every((row) => row === true) && !this.inBlock(piece)) piece.headerFooter = true;
    }
  }

  /** True when another line of the page stands right over or right under the piece (within the leading of a paragraph) and shares its column. */
  private inBlock(piece: Piece): boolean {
    const height = Math.max(1e-6, piece.rect.bottom - piece.rect.top);
    const width = piece.rect.right - piece.rect.left;
    return this.lines.some((other) => {
      if (other === piece || other.headerFooter) return false;
      const gap = other.rect.top >= piece.rect.bottom - 0.002 ? other.rect.top - piece.rect.bottom : piece.rect.top >= other.rect.bottom - 0.002 ? piece.rect.top - other.rect.bottom : Infinity;
      if (gap > BLOCK_GAP * height) return false;
      const across = Math.min(piece.rect.right, other.rect.right) - Math.max(piece.rect.left, other.rect.left);
      return across >= 0.3 * Math.min(width, other.rect.right - other.rect.left);
    });
  }

  /** Every piece of text of the page, from top to bottom (and from left to right in one row), running headers and footers included. */
  get pieces(): readonly Piece[] {
    return this.lines;
  }

  /** The usual font size of the page: the median over its pieces that are not running headers or footers (0 for a page without text). */
  get bodySize(): number {
    if (this.body === undefined) {
      const sizes = this.lines.filter((piece) => !piece.headerFooter && piece.fontSize > 0).map((piece) => piece.fontSize).sort((a, b) => a - b);
      this.body = sizes.length === 0 ? 0 : (sizes[Math.floor(sizes.length / 2)] as number);
    }
    return this.body;
  }

  /** The text inside a region. */
  read(region: Rect): RegionText {
    const inside = this.within(this.lines, region, (piece) => {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      return centre >= region.left && centre <= region.right;
    });
    const width = region.right - region.left;
    const straddling = this.within(this.lines, region, (piece) => {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      const overlap = Math.min(piece.rect.right, region.right) - Math.max(piece.rect.left, region.left);
      return (centre < region.left || centre > region.right) && width > 0 && overlap / width >= STRADDLE;
    }).map((piece) => piece.text);
    const topmost = inside.length > 0 ? (inside[0] as Piece).rect : undefined;
    const entering = this.within(this.lines, region, (piece) => {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      // A line from the left: its centre is left of the region, or it starts well left of it (joined across the columns).
      return (centre < region.left || piece.rect.left < region.left - FROM_OUTSIDE) && piece.rect.right > region.left;
    })
      // The label of an item that stands beside a display (a system of equations, a matrix) is set at the height of its middle row: any line
      // that comes in from the left in the upper part of the region may end with it.
      .filter((piece) => piece.rect.top <= region.top + ENTERING_SHARE * (region.bottom - region.top))
      .map((piece) => ({ text: piece.text, rect: piece.rect }));
    if (inside.length === 0) return { pieces: [], straddling, margin: undefined, marginPiece: undefined, text: straddling.join(' '), lines: 0, entering };
    const leftmost = Math.min(...inside.map((piece) => piece.rect.left));
    const first = inside.find((piece) => piece.rect.left <= leftmost + MARGIN) as Piece;
    // A piece that starts well left of the region is a line joined across the columns that comes in from the left; the region's own
    // text starts at its edge: the first piece of that text, when the margin piece is such a line.
    const own = first.rect.left < region.left - FROM_OUTSIDE ? inside.find((piece) => piece.rect.left >= region.left - FROM_OUTSIDE) : undefined;
    const band = first.rect;
    const row = inside
      .filter((piece) => {
        if (piece === first) return true;
        // A piece to the left of the anchor in the same band is part of the row (a number beside a numerator that was found first).
        const overlap = Math.min(band.bottom, piece.rect.bottom) - Math.max(band.top, piece.rect.top);
        const smaller = Math.min(band.bottom - band.top, piece.rect.bottom - piece.rect.top);
        return smaller > 0 && overlap / smaller >= SAME_ROW;
      })
      .sort((a, b) => a.rect.left - b.rect.left);
    const margin = row.map((piece) => piece.text).join(' ');
    const rest = inside.filter((piece) => !row.includes(piece)).map((piece) => piece.text);
    const topPiece = inside[0] as Piece;
    const topRow = inside
      .filter((piece) => piece === topPiece || (piece.rect.left > topPiece.rect.left && sameRow(topPiece.rect, piece.rect)))
      .sort((a, b) => a.rect.left - b.rect.left)
      .map((piece) => piece.text)
      .join(' ');
    return {
      pieces: inside.map((piece) => piece.text),
      straddling,
      margin,
      marginPiece: { text: (row[0] as Piece).text, rect: (row[0] as Piece).rect },
      topRow,
      topPiece: { text: topPiece.text, rect: topPiece.rect },
      text: [margin, ...rest].join(' '),
      lines: new Set(inside.map((piece) => piece.line)).size,
      entering,
      ...(own !== undefined ? { ownStart: own.text } : {}),
    };
  }

  /** The pieces of `source` that are in the region by the given horizontal rule and have half of their height inside it. */
  private within(source: readonly Piece[], region: Rect, horizontal: (piece: Piece) => boolean): Piece[] {
    const hits: Piece[] = [];
    // The first piece that can reach into the region has its top no higher than the region's top minus the tallest piece.
    let low = 0;
    let high = source.length;
    const limit = region.top - this.tallest;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((source[middle] as Piece).rect.top < limit) low = middle + 1;
      else high = middle;
    }
    for (let i = low; i < source.length; i += 1) {
      const piece = source[i] as Piece;
      if (piece.rect.top >= region.bottom) break;
      if (piece.headerFooter || !horizontal(piece)) continue;
      const height = piece.rect.bottom - piece.rect.top;
      if (height <= 0) continue;
      const overlap = Math.min(piece.rect.bottom, region.bottom) - Math.max(piece.rect.top, region.top);
      if (overlap / height >= MIN_INSIDE) hits.push(piece);
    }
    return hits;
  }
}

/** The index of every page that is asked for, built on first use from the lookup. */
export class PageIndex {
  private readonly cache = new Map<number, PageLines>();

  constructor(private readonly lookup: (page: number) => PageText | undefined) {}

  page(page: number): PageLines {
    let found = this.cache.get(page);
    if (!found) {
      found = new PageLines(this.lookup(page));
      found.markRepeats((offset) => this.lookup(page + offset));
      this.cache.set(page, found);
    }
    return found;
  }
}
