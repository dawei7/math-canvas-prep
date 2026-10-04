import { foldLabel, foldText } from './labels.js';
import type { PageLines, Piece } from './regions.js';

/**
 * What a line of a page is, for the checks that ask whether text was left out of every region: running furniture (a page number,
 * a running header), a heading, the start of an item (an exercise or an answer), an instruction, or ordinary text. The rules are
 * small and written down (docs/AUDIT_A_BOOK.md, "No text left behind") so that a person can apply them by hand.
 */

/** A line is a heading when it is at least this many times the usual font size of its page (or bold), and short. */
export const HEADING_SIZE_FACTOR = 1.15;
export const HEADING_MAX_LENGTH = 90;
/** A page number stands in the top or the bottom band of the page. */
const FURNITURE_BAND = 0.16;

/** `5.`, `5)`, `(5)`, `12a.`: a number and its closing mark. A `.` followed by a digit is a decimal point (`1.2`, `5.5 million`). */
const ITEM_NUMBER = /^\(?(\d{1,4}[a-z]?)\s*[.)](?!\d)/;
/** A dotted number of three parts or more (`1.1.2`, `12.2.51`) followed by a space: how some books number their exercises. */
const ITEM_DOTTED = /^(\d{1,3}(?:\.\d{1,4}){2,})(?=\s|$)/;
/** A part marker: `(a)` or `a)`. */
const ITEM_PART = /^\(?([a-z])\)/;
const PAGE_NUMBER = /^[-–]?\s*(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,6})\s*[-–]?$/i;

const VERBS = [
  'solve', 'find', 'evaluate', 'simplify', 'graph', 'write', 'determine', 'compute', 'calculate', 'factor', 'expand', 'convert', 'compare', 'identify', 'state', 'plot', 'sketch', 'use', 'show', 'prove',
  'explain', 'complete', 'fill', 'match', 'round', 'divide', 'multiply', 'add', 'subtract', 'rewrite', 'express', 'name', 'list', 'draw', 'label', 'describe', 'decide', 'tell', 'give', 'choose', 'circle',
  'check', 'verify', 'estimate', 'reduce', 'perform', 'apply', 'translate', 'classify', 'arrange', 'rationalize', 'differentiate', 'integrate', 'let', 'assume', 'consider', 'answer', 'read', 'look', 'mark',
  'measure', 'construct', 'reflect', 'rotate', 'create', 'make', 'build', 'test', 'locate', 'sort', 'count', 'record', 'predict',
];
const INSTRUCTION_START = new RegExp(`^(?:\\(?[a-z]\\)\\s+)?(?:${VERBS.join('|')})\\b`, 'i');
/** "In exercises 1-5, ...", "For each of the following, ...", "For 10-13, ...". */
const INSTRUCTION_PHRASE = /^(?:in|for)\s+(?:(?:each|all)\s+of\s+)?(?:the\s+)?(?:following|exercises?|problems?|questions?|items?|each|\d)/i;

export interface ItemStart {
  /** The label as the line prints it, without the closing mark; a part marker is `(a)`. */
  label: string;
  /** True for a part marker (`(a)`, `a)`) that has no number of its own. */
  part: boolean;
  /** A dotted number (`1.1.7`): its last number counts examples and definitions too, so such a line is not necessarily an exercise. */
  dotted?: boolean;
}

/** How the line starts an item: with a number and a closing mark, a part marker, or one of the patterns of the book (group 1 is the label). */
export function startsLikeItem(text: string, patterns?: readonly RegExp[]): ItemStart | undefined {
  const number = ITEM_NUMBER.exec(text);
  if (number) return { label: foldLabel(number[1] as string), part: false };
  const dotted = ITEM_DOTTED.exec(text);
  if (dotted) return { label: dotted[1] as string, part: false, dotted: true };
  const part = ITEM_PART.exec(text);
  if (part) return { label: `(${part[1] as string})`, part: true };
  for (const pattern of patterns ?? []) {
    const found = pattern.exec(text);
    if (found && found[1] !== undefined) return { label: foldLabel(found[1]), part: false };
  }
  return undefined;
}

/** A line that tells the learner what to do: it starts with an imperative verb or an "In exercises ..." form, or it is bold and ends like a sentence. */
export function isInstructionText(text: string, bold: boolean): boolean {
  if (text.length < 8 || startsLikeItem(text) !== undefined) return false;
  const sentence = /[.:?!,]$/.test(text);
  if (INSTRUCTION_PHRASE.test(text)) return true;
  if (INSTRUCTION_START.test(text) && (bold || sentence)) return true;
  return bold && /[.:?!]$/.test(text);
}

/** What the outline names: titles and labels, folded and lower-cased, so that a heading line can be told from text. */
export interface HeadingNames {
  /** Titles of at least 4 characters. */
  titles: string[];
  /** Labels as whole lines (`0.1`, `chapter 3`). */
  labels: Set<string>;
}

export function headingNames(entries: readonly { title: string; label?: string | undefined }[]): HeadingNames {
  const titles = new Set<string>();
  const labels = new Set<string>();
  for (const entry of entries) {
    const title = foldText(entry.title).toLowerCase();
    if (title.length >= 4) titles.add(title);
    if (entry.label !== undefined) {
      const label = foldText(entry.label).toLowerCase();
      if (label.length > 0) labels.add(label);
    }
  }
  return { titles: [...titles], labels };
}

/** True when no other piece of the page stands in the row of this one: a heading, a title, a marker is set alone on its row. */
function aloneOnRow(page: PageLines, piece: Piece): boolean {
  const height = piece.rect.bottom - piece.rect.top;
  if (height <= 0) return true;
  for (const other of page.pieces) {
    if (other === piece) continue;
    if (other.rect.top > piece.rect.bottom) break;
    if (other.rect.bottom < piece.rect.top || other.headerFooter) continue;
    const overlap = Math.min(piece.rect.bottom, other.rect.bottom) - Math.max(piece.rect.top, other.rect.top);
    const smaller = Math.min(height, other.rect.bottom - other.rect.top);
    if (smaller > 0 && overlap / smaller >= 0.5) return false;
  }
  return true;
}

export type PieceKind = 'furniture' | 'symbol' | 'heading' | 'item' | 'instruction' | 'text';

/** The kind of every piece of a page, found once. */
export class PageKinds {
  private readonly kinds = new Map<Piece, PieceKind>();

  constructor(
    private readonly page: PageLines,
    private readonly names: HeadingNames,
    private readonly patterns: readonly RegExp[] | undefined,
  ) {}

  kind(piece: Piece): PieceKind {
    let found = this.kinds.get(piece);
    if (found === undefined) {
      found = this.compute(piece);
      this.kinds.set(piece, found);
    }
    return found;
  }

  item(piece: Piece): ItemStart | undefined {
    return startsLikeItem(piece.text, this.patterns);
  }

  private compute(piece: Piece): PieceKind {
    if (piece.headerFooter) return 'furniture';
    const text = piece.text;
    const inBand = piece.rect.bottom <= FURNITURE_BAND || piece.rect.top >= 1 - FURNITURE_BAND;
    const centre = (piece.rect.left + piece.rect.right) / 2;
    if (inBand && PAGE_NUMBER.test(text) && (Math.abs(centre - 0.5) <= 0.12 || centre <= 0.2 || centre >= 0.8) && aloneOnRow(this.page, piece)) return 'furniture';
    // A line of marks only (a box that ends a proof, a bracket, a bullet) has no words: it is no text that was left out.
    if (!/[\p{L}\p{N}]/u.test(text)) return 'symbol';
    if (this.item(piece) !== undefined) return 'item';
    const lower = text.toLowerCase();
    if (this.names.labels.has(lower)) return 'heading';
    for (const title of this.names.titles) if (lower.includes(title) && text.length <= title.length + 40) return 'heading';
    const instruction = isInstructionText(text, piece.bold);
    const body = this.page.bodySize;
    const large = body > 0 && piece.fontSize >= HEADING_SIZE_FACTOR * body;
    if (!instruction && (piece.bold || large) && text.length <= HEADING_MAX_LENGTH && aloneOnRow(this.page, piece)) return 'heading';
    return instruction ? 'instruction' : 'text';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbers an instruction names: "Exercises 5 - 10", "For 10-13", "Problems 3 and 4"

export interface NamedNumbers {
  /** The integers the instruction names, as inclusive ranges. */
  ranges: { from: number; to: number }[];
}

const WORD = '(?:exercises?|problems?|questions?|items?|numbers?|nos?\\.?)';
const NUM = '(\\d{1,4})[a-z]?';
const DASH = '(?:-|to|through|thru)';
const RANGE = new RegExp(`\\b(?:${WORD}\\s+|for\\s+(?:${WORD}\\s+)?)${NUM}\\s*${DASH}\\s*${NUM}\\b`, 'gi');
const LIST = new RegExp(`\\b${WORD}\\s+${NUM}((?:\\s*(?:,|and|&)\\s*\\d{1,4}[a-z]?)+)`, 'gi');

/** The ranges of numbers a line of instruction names, or undefined when it names none. */
export function namedNumbers(text: string): NamedNumbers | undefined {
  const ranges: { from: number; to: number }[] = [];
  for (const match of text.matchAll(RANGE)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from <= to) ranges.push({ from, to });
  }
  for (const match of text.matchAll(LIST)) {
    const numbers = [Number(match[1]), ...[...(match[2] as string).matchAll(/\d{1,4}/g)].map((digits) => Number(digits[0]))];
    for (const n of numbers) ranges.push({ from: n, to: n });
  }
  return ranges.length > 0 ? { ranges } : undefined;
}

/** The integer a plain label is (`5` and `5a` are 5), or undefined: a dotted label (`1.3.10`) is not named by a range of numbers. */
export function labelNumber(label: string): number | undefined {
  const match = /^(\d{1,4})(?![.\d])/.exec(label);
  return match ? Number(match[1]) : undefined;
}

export function namesNumber(named: NamedNumbers, n: number): boolean {
  return named.ranges.some((range) => range.from <= n && n <= range.to);
}
