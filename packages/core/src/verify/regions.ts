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
interface Piece {
  text: string;
  rect: Rect;
  headerFooter: boolean;
  /** The text line of the page this piece belongs to (the pieces of a joined line share it). */
  line: number;
}

/** A line belongs to a region when its centre is between the region's left and right edges and half of it is inside. */
const MIN_INSIDE = 0.5;
/** Two pieces are in one row when they share this much of the smaller one's height. */
const SAME_ROW = 0.5;
/** Pieces whose left edge is within this distance of the leftmost one are at the left margin of the region's text. */
export const MARGIN = 0.012;
/** A line whose centre is outside a region but that covers this much of its width runs into it (two exercises joined into one line). */
const STRADDLE = 0.4;

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
  /** Everything in the region: the first row at the margin, then the rest from top to bottom. */
  text: string;
  /** How many text lines of the page (as `mcprep lines` lists them) have a piece in the region. */
  lines: number;
}

export class PageLines {
  /** False when the page has no text layer (a scan), or when no text was given for the page. */
  readonly hasText: boolean;
  private readonly lines: Piece[] = [];
  /** The whole lines (not their pieces) that may run into a region from the side. */
  private readonly wide: Piece[] = [];
  private tallest = 0;
  private tallestWide = 0;

  constructor(page: PageText | undefined) {
    this.hasText = page?.hasText === true;
    (page?.lines ?? []).forEach((line, at) => {
      const whole = foldText(line.text);
      if (whole.length === 0) return;
      this.wide.push({ text: whole, rect: line.rect, headerFooter: line.headerFooter === true, line: at });
      this.tallestWide = Math.max(this.tallestWide, line.rect.bottom - line.rect.top);
      // A line joined from pieces standing side by side (the rows of two columns, a fraction) is read piece by piece: a
      // region that holds only one of the columns must not be shown the other.
      const pieces = line.parts !== undefined && line.parts.length >= 2 ? line.parts : [line];
      for (const piece of pieces) {
        const text = foldText(piece.text);
        if (text.length === 0) continue;
        this.lines.push({ text, rect: piece.rect, headerFooter: line.headerFooter === true, line: at });
        this.tallest = Math.max(this.tallest, piece.rect.bottom - piece.rect.top);
      }
    });
    this.lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    this.wide.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }

  /** The text inside a region. */
  read(region: Rect): RegionText {
    const inside = this.within(this.lines, region, (piece) => {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      return centre >= region.left && centre <= region.right;
    });
    const width = region.right - region.left;
    const straddling = this.within(this.wide, region, (piece) => {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      const overlap = Math.min(piece.rect.right, region.right) - Math.max(piece.rect.left, region.left);
      return (centre < region.left || centre > region.right) && width > 0 && overlap / width >= STRADDLE;
    }).map((piece) => piece.text);
    if (inside.length === 0) return { pieces: [], straddling, margin: undefined, marginPiece: undefined, text: straddling.join(' '), lines: 0 };
    const leftmost = Math.min(...inside.map((piece) => piece.rect.left));
    const first = inside.find((piece) => piece.rect.left <= leftmost + MARGIN) as Piece;
    const band = first.rect;
    const row = inside
      .filter((piece) => {
        if (piece === first) return true;
        if (piece.rect.left <= first.rect.left) return false;
        const overlap = Math.min(band.bottom, piece.rect.bottom) - Math.max(band.top, piece.rect.top);
        const smaller = Math.min(band.bottom - band.top, piece.rect.bottom - piece.rect.top);
        return smaller > 0 && overlap / smaller >= SAME_ROW;
      })
      .sort((a, b) => a.rect.left - b.rect.left);
    const margin = row.map((piece) => piece.text).join(' ');
    const rest = inside.filter((piece) => !row.includes(piece)).map((piece) => piece.text);
    return {
      pieces: inside.map((piece) => piece.text),
      straddling,
      margin,
      marginPiece: { text: first.text, rect: first.rect },
      text: [margin, ...rest].join(' '),
      lines: new Set(inside.map((piece) => piece.line)).size,
    };
  }

  /** The pieces of `source` that are in the region by the given horizontal rule and have half of their height inside it. */
  private within(source: readonly Piece[], region: Rect, horizontal: (piece: Piece) => boolean): Piece[] {
    const hits: Piece[] = [];
    // The first piece that can reach into the region has its top no higher than the region's top minus the tallest piece.
    let low = 0;
    let high = source.length;
    const limit = region.top - (source === this.lines ? this.tallest : this.tallestWide);
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
      this.cache.set(page, found);
    }
    return found;
  }
}
