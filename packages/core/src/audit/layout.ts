import { INK_CLEAN, inkAbove, nearestWhiteRow, rowInk } from '../geometry/ink.js';
import { lineStart } from '../geometry/snap.js';
import { INK_BANDS, type LinePart, type PageText, type Rect, type Region, type TextLine } from '../model/types.js';
import { endsLikeAnItem } from '../pdf/lines.js';
import { AUTHORING } from '../rules/constants.js';
import { isRunningLine } from './scan.js';

/**
 * What the exercises of a practice set and the answers of an answer key have in common: lines that start with a
 * printed number, the sequence those numbers must form, the bands and columns of a page, the lines that belong to
 * an item (continuations, the rows of a fraction, the labels of a figure, the lines on the next page) and the frame
 * that results. See `exercises.ts` and `solutions.ts`.
 */

export interface RejectedStart {
  page: number;
  text: string;
  reason: string;
}

export interface ItemPattern {
  /** For the evidence: how the numbers look. */
  name: string;
  /** Group 1 is the printed label (without the closing mark); group 2 the text after it. */
  regex: RegExp;
}

export interface Candidate {
  label: string;
  n: number;
  suffix: string;
  /** The printed number with its marks ("5)", "(5)"). */
  lead: string;
  rest: string;
  page: number;
  index: number;
  line: TextLine;
  weak: boolean;
  /** For a printed range ("1-7. Yes, all of them"): the last number it covers; `n` is the first. */
  through?: number;
}

export interface PLine {
  page: number;
  index: number;
  line: TextLine;
  role: 'start' | 'instruction' | 'other';
  candidate?: Candidate;
  block?: Block;
  /** For an instruction line that names the items it is for ("For Exercises 1-4"): the first and the last number. */
  range?: [number, number];
}

export interface Block {
  lines: PLine[];
  /** Lines of the block per page. */
  pages: Map<number, PLine[]>;
  /** Whether no item follows the block on the last page it touches. */
  openAtEnd: boolean;
  /** The numbers of the items the instruction names ("For Exercises 1-4"), when it names them. */
  range?: [number, number];
}

/**
 * Where an item goes on after the page or the column where it starts: the lines of one column of one page, or a page that
 * holds only a figure (no text lines) between two stretches of the text of the item.
 */
export interface Span {
  page: number;
  /** The text column of the lines (the column the extraction put them in), to keep the columns of one page apart. */
  column: number;
  lines: PLine[];
  /** A page without text lines: the span covers the inked part of its content area. */
  figure?: boolean;
}

/** The most continuation regions an item (and so an answer) is given: nine pages. */
export const MAX_CONTINUATIONS = 8;

/** How a note names an item whose text goes on after its page or column: "3 (pages 0-2, 2 continuation regions)". */
export function describeSpan(label: string, page: number, continues: readonly Region[], kept: number): string {
  const pagesSpanned = [page, ...continues.map((region) => region.page)];
  const first = Math.min(...pagesSpanned);
  const last = Math.max(...pagesSpanned);
  const where = first === last ? `page ${first}, in the next column` : `pages ${first}-${last}`;
  const shown = Math.min(continues.length, kept);
  const beyond = continues.length > kept ? `; the text goes on beyond the limit of ${kept} continuation regions, the rest is not framed` : '';
  return `${label} (${where}, ${shown} continuation region${shown === 1 ? '' : 's'}${beyond})`;
}

/** The note that lists the items of a section that go on after their page or column (one note, so that the report shows every span). */
export function spanNote(spans: readonly string[], things: 'exercise' | 'answer'): string | undefined {
  if (spans.length === 0) return undefined;
  const head = spans.length === 1 ? `one ${things} goes on after the end of its page or column` : `${spans.length} ${things}s go on after the end of their page or column`;
  return `${head}: ${spans.slice(0, 12).join('; ')}${spans.length > 12 ? '; ...' : ''}`;
}

/** An item whose text ends above this height of its page is complete: the lines at the top of the next page are not its text. */
const MIN_OPEN = 0.6;

/** The first line of a stretch of text that goes on from the end of a column has at least this many characters (not a row of a fraction). */
const MIN_PARAGRAPH_LINE = 12;

/** A line of at most this many characters can be a fragment of another line (the row of a fraction, the sign of a root). */
const FRAGMENT_CHARS = 24;

/** A line of this many characters is running text, not a label of a figure. */
const RUNNING_TEXT = 30;

/** A line of this many characters that no item owns is text of its own (a paragraph), not a label of the figure above it. */
const STRAY_TEXT = 12;

export interface ItemAcc {
  candidate: Candidate;
  start: PLine;
  own: PLine[];
  extra: Map<number, PLine[]>;
  /** The later pages and columns that the item runs over (see `chainSpans`), in reading order. */
  spans: Span[];
  band: number;
  column: number;
  page: number;
  figure: boolean;
  /** Set when the pieces of the item (short lines) are the rows of one expression, not the labels of a figure: no figure frame. */
  plain?: boolean;
  block: Block | undefined;
}

export const PAD = 0.012;
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
export const round = (value: number): number => Math.round(value * 10000) / 10000;
export const FIGURE_SHORT = 14;
const INK_THRESHOLD = 0.004;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Values grouped into clusters whose members lie within `tolerance` of the cluster's first value. */
export function cluster(values: readonly number[], tolerance: number): { center: number; count: number }[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: { sum: number; count: number; first: number }[] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last.first <= tolerance) {
      last.sum += value;
      last.count += 1;
    } else clusters.push({ sum: value, count: 1, first: value });
  }
  return clusters.map((entry) => ({ center: entry.sum / entry.count, count: entry.count }));
}

/** The line of the page that a piece cut out of it (a cell, a fragment, one item of a joined row) comes from. */
const sourceOf = new WeakMap<TextLine, TextLine>();

/** The y where the body text of a page ends: just above its footer, or near the bottom. */
export function contentLimit(page: PageText | undefined): number {
  const footers = (page?.lines ?? []).filter((line) => line.headerFooter === true && line.rect.top > 0.85).map((line) => line.rect.top);
  return footers.length > 0 ? Math.min(...footers) - AUTHORING.startPadding : 0.96;
}

/** The y of the lowest inked band between two positions, or undefined when the space is blank. */
export function lowestInk(ink: readonly number[], from: number, to: number): number | undefined {
  const first = Math.max(0, Math.ceil(from * INK_BANDS));
  for (let band = Math.min(INK_BANDS - 1, Math.floor(to * INK_BANDS)); band >= first; band -= 1) {
    if ((ink[band] ?? 0) >= INK_THRESHOLD) return (band + 1) / INK_BANDS;
  }
  return undefined;
}

/**
 * The sign of a root, an exponent or another glyph or two that the extraction joined to the line of an item it only stands
 * near: it lies beside the text that starts with the number and not on its row (the sign of a root that belongs to the row
 * below stands higher than the text next to it). The rows of a fraction stack and the denominators of two fractions share a
 * row, so they stay. The fragment becomes a line of its own, and the rules that give a fragment to an item decide whose
 * it is. The part that starts with a number is never the one that is set free.
 */
export function detachFragments(lines: readonly PLine[]): PLine[] {
  const result: PLine[] = [];
  for (const entry of lines) {
    const parts = entry.line.parts;
    const [first, second] = parts ?? [];
    if (!parts || parts.length !== 2 || !first || !second) {
      result.push(entry);
      continue;
    }
    const starts = (text: string): boolean => /^\s*\d{1,3}[).]/.test(text);
    if (starts(first.text) === starts(second.text)) {
      result.push(entry);
      continue;
    }
    const [main, fragment] = starts(first.text) ? [first, second] : [second, first];
    const gap = Math.max(fragment.rect.left - main.rect.right, main.rect.left - fragment.rect.right);
    const centre = (fragment.rect.top + fragment.rect.bottom) / 2;
    const onTheRow = centre >= main.rect.top && centre <= main.rect.bottom;
    if (fragment.chars > 2 || fragment.rect.right - fragment.rect.left > 0.03 || gap < 0.012 || onTheRow) {
      result.push(entry);
      continue;
    }
    const base: TextLine = { ...entry.line };
    delete base.parts;
    delete base.cells;
    const mainLine: TextLine = { ...base, text: main.text, chars: main.chars, rect: { ...main.rect } };
    const fragmentLine: TextLine = { ...base, text: fragment.text, chars: fragment.chars, rect: { ...fragment.rect } };
    sourceOf.set(mainLine, entry.line);
    sourceOf.set(fragmentLine, entry.line);
    result.push({ ...entry, line: mainLine });
    result.push({ page: entry.page, index: entry.index + 0.0005, role: 'other', line: fragmentLine });
  }
  return result;
}

export { endsLikeAnItem };

/**
 * The text extraction sometimes joins the two items of one row of a two-column list into one line ("5) first 6)
 * second"), when the gap between the columns is not wide enough to be seen as a gutter. Such a line is cut again where
 * the next number begins; the cut sits on the left edge of the column that other items start at, else where the text
 * says. Only a line that starts with a number and holds larger numbers at the position of a column is cut, and only
 * where the text before the number can be the end of an item (see {@link endsLikeAnItem}).
 */
export function explodeMergedRows(input: readonly PLine[]): PLine[] {
  return splitByCells(explodeByColumns(detachFragments(input)));
}

const LABEL_START = /^\s*(\d{1,3})[.)](?:\s|$)/;

const DASH = '(?:-|–|—|−|to|through|thru)';
const RANGE_WORDS = '(?:exercises?|problems?|questions?|items?|numbers?|aufgaben?|übungen?|uebungen?)';
const RANGE_INSTRUCTION = new RegExp(
  `^(?:(?:for|in|do|answer|solve|complete)\\s+)?(?:the\\s+)?${RANGE_WORDS}\\s+(\\d{1,3})\\s*${DASH}\\s*(\\d{1,3})\\b|^(?:for|in)\\s+(\\d{1,3})\\s*${DASH}\\s*(\\d{1,3})\\b|^(?:for|in)\\s+${RANGE_WORDS}\\s+(\\d{1,3})\\s*[,:]|^(?:for|in)\\s+(?:the\\s+)?\\p{L}{3,}\\s+(\\d{1,3})\\s*${DASH}\\s*(\\d{1,3})\\b`,
  'iu',
);

/**
 * The numbers an instruction line names: "For Exercises 1-4, find ..." and "In Exercises 5 - 10, ..." name 1 to 4 and 5 to 10;
 * "For questions 1-5", "For 10-13" and "For Exercise 9," likewise, and so does "In tasks 10 - 27" (any word of at least three
 * letters after "For" or "In" will do before a range of numbers). A line that merely starts with a number is not one.
 */
export function parseRangeInstruction(text: string): [number, number] | undefined {
  const found = RANGE_INSTRUCTION.exec(text.trim());
  if (!found) return undefined;
  const [from, to] =
    found[1] !== undefined ? [found[1], found[2]] : found[3] !== undefined ? [found[3], found[4]] : found[5] !== undefined ? [found[5], found[5]] : [found[6], found[7]];
  const low = Number(from);
  const high = Number(to);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 1 || high < low || high - low > 99) return undefined;
  return [low, high];
}

const NAMED_RANGE = new RegExp(`\\b${RANGE_WORDS}\\s+(\\d{1,3})(?:\\s*${DASH}\\s*(\\d{1,3})\\b|\\s+(?:and|&|und)\\s+(\\d{1,3})\\b)`, 'iu');

/**
 * The numbers that a sentence names anywhere in it, after a word for the items ("For each system listed in Exercises 41 - 52:",
 * "See the sketch for questions 13-16.", "In tasks 24 and 25, name ..."): a range, or two numbers that follow each
 * other. Only a line that stands alone at the head of a paragraph is read this way (see `markRangeInstructions`): inside the text of
 * an item such a phrase is a reference.
 */
export function parseNamedRange(text: string): [number, number] | undefined {
  const found = NAMED_RANGE.exec(text.trim());
  if (!found) return undefined;
  const low = Number(found[1]);
  const high = Number(found[2] ?? found[3]);
  const pair = found[3] !== undefined;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 1 || (pair ? high !== low + 1 : high < low || high - low > 99)) return undefined;
  return [low, high];
}

/**
 * A line that holds several items one after the other ("19. sin 12 20. sin 34 21. cos 56"), each starting with a number that
 * follows the one before, is cut into its items where the text runs of the numbers begin (the extraction records them as the
 * `cells` of the line). This needs no column that other items share: it works for a row of five short items as for a row of
 * two.
 */
export function splitByCells(input: readonly PLine[]): PLine[] {
  const result: PLine[] = [];
  for (const entry of input) {
    const cells = cellsOf(entry);
    if (!cells) {
      result.push(entry);
      continue;
    }
    cells.forEach((cell, k) => {
      const line: TextLine = { ...entry.line, text: cell.text, chars: cell.chars, rect: { ...cell.rect } };
      delete line.parts;
      delete line.cells;
      sourceOf.set(line, entry.line);
      result.push({ page: entry.page, index: entry.index + k * 0.001, line, role: 'other' });
    });
  }
  return result;
}

/**
 * The items a line is made of according to its cells: the pieces that start with a number (rising by one to three), and
 * possibly the rest of the item before in front of them. At least two cells.
 */
function cellsOf(entry: PLine): readonly LinePart[] | undefined {
  const cells = entry.line.cells;
  if (!cells || cells.length < 2) return undefined;
  const numbers = cells.map((cell) => LABEL_START.exec(cell.text)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  const labelled = cells.filter((cell) => LABEL_START.test(cell.text)).length;
  if (labelled === 0) return undefined;
  const rising = numbers.every((n, at) => at === 0 || (n > (numbers[at - 1] as number) && n - (numbers[at - 1] as number) <= 3));
  return rising ? cells : undefined;
}

function explodeByColumns(lines: readonly PLine[]): PLine[] {
  const numbered = lines.filter((entry) => /^\s*\d{1,3}[).]/.test(entry.line.text));
  if (numbered.length < 4) return [...lines];
  // The columns that items start at: left edges that several lines share.
  const columns = cluster(
    numbered.map((entry) => entry.line.rect.left),
    0.02,
  ).filter((column) => column.count >= 3);
  if (columns.length < 2) return [...lines];
  const result: PLine[] = [];
  for (const entry of lines) {
    const text = entry.line.text;
    const first = /^\s*(\d{1,3})[).]/.exec(text);
    if (!first || entry.line.rect.right - entry.line.rect.left < 0.3) {
      result.push(entry);
      continue;
    }
    const { left, right } = entry.line.rect;
    const cuts: { at: number; boundary: number }[] = [];
    let expected = Number(first[1]);
    let pieceLeft = left;
    let pieceFrom = 0;
    const embedded = /(?<=\s)(\d{1,3})[).](?=\s)/g;
    let found: RegExpExecArray | null;
    while ((found = embedded.exec(text)) !== null) {
      const n = Number(found[1]);
      // Along the rows the next number is 1 to 3 further; down flowing columns it is a whole column further.
      if (n <= expected || n - expected > 80 || found.index <= 3) continue;
      // Not a number that closes a bracket or follows an operator: that is part of the expression.
      if (!endsLikeAnItem(text.slice(pieceFrom, found.index))) continue;
      // The cut has to fall on a column where other items start; a number inside a sentence does not.
      const estimate = left + ((right - left) * found.index) / Math.max(1, text.length);
      const column = columns
        .filter((candidate) => candidate.center > pieceLeft + 0.1 && candidate.center < right && Math.abs(candidate.center - estimate) <= 0.12)
        .sort((a, b) => Math.abs(a.center - estimate) - Math.abs(b.center - estimate))[0];
      if (!column) continue;
      cuts.push({ at: found.index, boundary: column.center });
      expected = n;
      pieceLeft = column.center;
      pieceFrom = found.index;
    }
    // A line that says where its items stand (its cells) is cut there, not at an estimate, when the estimate misses one.
    if (cuts.length === 0 || cuts.length < (cellsOf(entry)?.length ?? 1) - 1) {
      result.push(entry);
      continue;
    }
    let from = 0;
    let start = left;
    cuts.forEach((cut, k) => {
      result.push(piece(entry, text.slice(from, cut.at).trim(), start, cut.boundary - 0.01, k));
      from = cut.at;
      start = cut.boundary;
    });
    result.push(piece(entry, text.slice(from).trim(), start, right, cuts.length));
  }
  return result;
}

/**
 * One item cut out of a joined line. When the extraction says what the joined pieces looked like (`parts`), the item
 * takes the height of the pieces that stand where it does, not of the whole row: items of neighbouring columns that
 * sit a little higher or lower than each other would otherwise make each other taller.
 */
function piece(entry: PLine, text: string, left: number, right: number, k: number): PLine {
  const rect = { ...entry.line.rect, left, right: Math.max(right, left + 0.02) };
  const own = (entry.line.parts ?? []).filter((part) => (part.rect.left + part.rect.right) / 2 >= left && (part.rect.left + part.rect.right) / 2 <= right);
  if (own.length > 0 && own.length < (entry.line.parts ?? []).length) {
    rect.top = Math.min(...own.map((part) => part.rect.top));
    rect.bottom = Math.max(...own.map((part) => part.rect.bottom));
  }
  const line: TextLine = { ...entry.line, text, chars: text.replace(/\s/g, '').length, rect };
  delete line.parts;
  delete line.cells;
  sourceOf.set(line, entry.line);
  return { page: entry.page, index: entry.index + k * 0.001, line, role: 'other' };
}

export function findCandidates(lines: readonly PLine[], patterns: readonly ItemPattern[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entry of lines) {
    const text = entry.line.text.trim();
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const label = match[1] as string;
      const n = Number.parseInt(label, 10);
      // A number does not start with a zero ("07." is a decimal or a code, not the seventh exercise).
      if (!Number.isFinite(n) || n < 1 || /^0\d/.test(label)) break;
      const rest = (match[2] ?? '').trim();
      found.push({ label, n, suffix: label.replace(/^\d+/, ''), lead: text.slice(0, text.length - rest.length).trim(), rest, page: entry.page, index: entry.index, line: entry.line, weak: false });
      break;
    }
  }
  return found;
}

export interface Selection {
  chosen: Candidate[];
  rejected: RejectedStart[];
  gaps: string[];
  duplicates: string[];
  weak: Candidate[];
}


export interface SequenceOptions {
  /** Numbers above this are no items of the set (the exercises it is read against end there): they are put aside. */
  maxNumber?: number;
  /**
   * The largest step between two numbers of one run (default 3). A key that prints the answers of selected exercises
   * only has larger steps.
   */
  maxJump?: number;
}

export function selectSequence(allCandidates: readonly Candidate[], lines: readonly PLine[], options: SequenceOptions = {}): Selection {
  const rejected: RejectedStart[] = [];
  const reject = (candidate: Candidate, reason: string): void => {
    rejected.push({ page: candidate.page, text: candidate.line.text.slice(0, 60), reason });
  };
  // Numbers beyond the last one expected stay when they go on from it (the key answers more than the exercises found), and are
  // put aside when they stand apart from it (a number inside an answer).
  let reach = options.maxNumber ?? Infinity;
  const beyond = new Set<Candidate>();
  if (options.maxNumber !== undefined) {
    for (const candidate of [...allCandidates].filter((entry) => entry.n > (options.maxNumber as number)).sort((a, b) => a.n - b.n)) {
      if (candidate.n - reach <= (options.maxJump ?? 3)) reach = Math.max(reach, candidate.through ?? candidate.n);
      else beyond.add(candidate);
    }
  }
  const candidates = allCandidates.filter((candidate) => {
    if (!beyond.has(candidate)) return true;
    reject(candidate, `its number ${candidate.label} stands apart, beyond the last number expected here (${options.maxNumber as number})`);
    return false;
  });
  const clusters = cluster(candidates.map((candidate) => candidate.line.rect.left), 0.02);
  const total = candidates.length;
  const significant = clusters.filter((entry) => total <= 3 || entry.count >= Math.max(3, Math.ceil(0.08 * total)));
  const aligned = (left: number): boolean => clusters.some((entry) => Math.abs(entry.center - left) <= 0.025);
  // A number slightly to the right of the main columns is an indented line of a paragraph, not an item.
  const sameRow = (a: Candidate, b: Candidate): boolean => {
    const overlap = Math.min(a.line.rect.bottom, b.line.rect.bottom) - Math.max(a.line.rect.top, b.line.rect.top);
    return a.page === b.page && overlap >= 0.5 * Math.min(a.line.rect.bottom - a.line.rect.top, b.line.rect.bottom - b.line.rect.top);
  };
  const good = candidates.filter((candidate) => {
    const left = candidate.line.rect.left;
    const parent = significant.find((entry) => left - entry.center > 0.012 && left - entry.center <= 0.09);
    if (!parent) return true;
    // A number that stands in a row with another one is an item in a column of its own, not a line of a paragraph; so is a
    // number that stands alone on its line (the number of a figure), which no paragraph holds.
    if (candidate.rest.length === 0) return true;
    if (candidates.some((other) => other !== candidate && Math.abs(other.line.rect.left - left) > 0.09 && sameRow(other, candidate))) return true;
    reject(candidate, `indented (left ${round(left)}, the numbers start at ${round(parent.center)}): probably inside a paragraph`);
    return false;
  });
  // One candidate per label; a duplicate keeps the one on the page of its neighbours.
  const byLabel = new Map<string, Candidate[]>();
  for (const candidate of good) byLabel.set(candidate.label, [...(byLabel.get(candidate.label) ?? []), candidate]);
  const chosen = new Map<string, Candidate>();
  const duplicates: string[] = [];
  for (const [label, list] of byLabel) if (list.length === 1) chosen.set(label, list[0] as Candidate);
  for (const [label, list] of byLabel) {
    if (list.length < 2) continue;
    duplicates.push(label);
    const n = (list[0] as Candidate).n;
    const pagesNear = [...chosen.values()].filter((other) => Math.abs(other.n - n) <= 2).map((other) => other.page);
    const distance = (candidate: Candidate): number => (pagesNear.length > 0 ? Math.min(...pagesNear.map((p) => Math.abs(p - candidate.page))) : 0);
    const best = [...list].sort((a, b) => distance(a) - distance(b) || a.page - b.page || a.line.rect.top - b.line.rect.top)[0] as Candidate;
    chosen.set(label, best);
    for (const other of list) if (other !== best) reject(other, `the number ${label} is printed more than once; the one next to its neighbours was used`);
  }
  // The main run of numbers: break at jumps of more than 3 and keep the longest chain.
  const ordered = [...chosen.values()].sort((a, b) => a.n - b.n || a.suffix.localeCompare(b.suffix));
  const chains: Candidate[][] = [];
  for (const candidate of ordered) {
    const chain = chains[chains.length - 1];
    const last = chain?.[chain.length - 1];
    if (chain && last && candidate.n - (last.through ?? last.n) <= (options.maxJump ?? 3)) chain.push(candidate);
    else chains.push([candidate]);
  }
  const main = [...chains].sort((a, b) => b.length - a.length)[0] ?? [];
  // Chains of two or more numbers are kept (a few items lost to a garbled line leave short runs); a single number far
  // from the others is put aside.
  for (const chain of chains) {
    if (chain === main || chain.length >= 2) continue;
    for (const candidate of chain) {
      chosen.delete(candidate.label);
      reject(candidate, `its number ${candidate.label} does not belong to the run ${(main[0] as Candidate | undefined)?.label ?? '?'}..${(main[main.length - 1] as Candidate | undefined)?.label ?? '?'}`);
    }
  }
  // Gaps in the run, and a second look for the missing numbers.
  const numeric = [...chosen.values()].filter((candidate) => candidate.suffix === '').sort((a, b) => a.n - b.n);
  const gaps: string[] = [];
  const weak: Candidate[] = [];
  if (numeric.length >= 2) {
    const have = new Set(numeric.flatMap((candidate) => Array.from({ length: (candidate.through ?? candidate.n) - candidate.n + 1 }, (_unused, k) => candidate.n + k)));
    const low = (numeric[0] as Candidate).n;
    const high = Math.max(...numeric.map((candidate) => candidate.through ?? candidate.n));
    const pageOf = (n: number): number | undefined => numeric.find((candidate) => candidate.n === n)?.page;
    const taken = new Set([...chosen.values()].map((candidate) => `${candidate.page}:${candidate.index}`));
    for (let n = low; n <= high; n += 1) {
      if (have.has(n)) continue;
      const before = pageOf(n - 1);
      const after = pageOf(n + 1);
      // A number printed without its closing mark ("33 (2)(3)") or lost in the text layer.
      const loose = new RegExp(`^(${n})(?=\\s+\\S)\\s*(.*)$`);
      const found = lines.find((entry) => {
        if (taken.has(`${entry.page}:${entry.index}`) || !aligned(entry.line.rect.left)) return false;
        if (before !== undefined && entry.page < before) return false;
        if (after !== undefined && entry.page > after) return false;
        return loose.test(entry.line.text.trim());
      });
      if (found) {
        const text = found.line.text.trim();
        const match = loose.exec(text) as RegExpExecArray;
        const rest = (match[2] ?? '').trim();
        const candidate: Candidate = { label: String(n), n, suffix: '', lead: String(n), rest, page: found.page, index: found.index, line: found.line, weak: true };
        chosen.set(candidate.label, candidate);
        weak.push(candidate);
      } else gaps.push(String(n));
    }
  }
  return { chosen: [...chosen.values()].sort((a, b) => a.n - b.n || a.suffix.localeCompare(b.suffix)), rejected, gaps, duplicates, weak };
}

/** Groups instruction lines into blocks; a block that ends a page and goes on at the top of the next page is one block. */
export function buildBlocks(lines: readonly PLine[], pitch: number): Block[] {
  const blocks: Block[] = [];
  const pageList = [...new Set(lines.map((entry) => entry.page))].sort((a, b) => a - b);
  let open: Block | undefined;
  for (const page of pageList) {
    const onPage = lines.filter((entry) => entry.page === page);
    const instruction = onPage.filter((entry) => entry.role === 'instruction').sort((a, b) => a.line.rect.top - b.line.rect.top || a.line.rect.left - b.line.rect.left);
    const firstOther = onPage.filter((entry) => entry.role !== 'instruction').reduce((top, entry) => Math.min(top, entry.line.rect.top), Infinity);
    const starts = onPage.filter((entry) => entry.role === 'start');
    let group: PLine[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      const atTop = group[0] === instruction[0] && group.every((entry) => entry.line.rect.top < firstOther);
      let block: Block;
      if (atTop && open) {
        block = open;
        block.lines.push(...group);
      } else {
        block = { lines: [...group], pages: new Map(), openAtEnd: false };
        blocks.push(block);
      }
      for (const entry of group) {
        entry.block = block;
        block.pages.set(page, [...(block.pages.get(page) ?? []), entry]);
      }
      const named = group.find((entry) => entry.range !== undefined);
      if (named?.range) block.range = named.range;
      const last = group[group.length - 1] as PLine;
      block.openAtEnd = !starts.some((entry) => entry.line.rect.top > last.line.rect.top);
      open = block.openAtEnd ? block : undefined;
      group = [];
    };
    for (const entry of instruction) {
      const last = group[group.length - 1];
      if (last && entry.line.rect.top - last.line.rect.bottom > 1.5 * pitch) {
        // The caption of the figure that stands under the paragraph ("The plot for Ex. 19 - 27") names the exercises of the paragraph, with no item
        // between the two: the paragraph, the figure and the caption are one instruction.
        const named = group.find((member) => member.range !== undefined)?.range;
        const mentioned = /\b(\d{1,3})\s*[-–—−]\s*(\d{1,3})\b/.exec(entry.line.text);
        const caption = named !== undefined && mentioned !== null && Number(mentioned[1]) >= named[0] && Number(mentioned[2]) <= named[1] && Number(mentioned[1]) <= Number(mentioned[2]);
        const between = starts.some((item) => item.line.rect.top > last.line.rect.bottom && item.line.rect.top < entry.line.rect.top);
        if (!caption || between) flush();
      }
      group.push(entry);
    }
    flush();
    // A page without an instruction line ends the block that was open: it goes on only at the top of the very next page that has lines.
    if (instruction.length === 0) open = undefined;
  }
  return blocks;
}

export const blockText = (block: Block): string => block.lines.map((entry) => entry.line.text.trim()).join(' ').replace(/\s+/g, ' ');

export function blockRegions(block: Block, pages: readonly PageText[]): Region[] {
  const regions: Region[] = [];
  for (const [page, entries] of [...block.pages].sort((a, b) => a[0] - b[0])) {
    const top = Math.min(...entries.map((entry) => entry.line.rect.top));
    const first = entries.find((entry) => entry.line.rect.top === top) as PLine;
    regions.push({
      page,
      rect: {
        left: round(clamp01(Math.min(...entries.map((entry) => entry.line.rect.left)) - PAD)),
        top: round(clamp01(lineStart(first.line, AUTHORING.startPadding, pages[page]?.lines))),
        right: round(clamp01(Math.max(...entries.map((entry) => entry.line.rect.right)) + PAD)),
        bottom: round(clamp01(Math.max(...entries.map((entry) => entry.line.rect.bottom)) + AUTHORING.endPadding)),
      },
    });
  }
  return regions;
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout: which lines belong to which item

/**
 * Rows of a stacked fraction (a numerator above the line of the number, the rows of a complex fraction) are claimed by the
 * nearest-line rules in the order the lines are read, from the top: a row that lies between two items can then go to the
 * one above although it stacks on the one below. Between two neighbouring items of a column the border is the largest
 * gap between their lines, so the lines are shared out again along it. Only fragments are moved (a line of text that
 * belongs to an item is never given to another), and only when the border is clear.
 */
export function restack(items: readonly ItemAcc[]): void {
  const columns = new Map<string, ItemAcc[]>();
  for (const item of items) {
    const key = `${item.band}:${item.column}`;
    columns.set(key, [...(columns.get(key) ?? []), item]);
  }
  for (const list of columns.values()) {
    list.sort((a, b) => a.start.line.rect.top - b.start.line.rect.top);
    for (let k = 0; k + 1 < list.length; k += 1) {
      const above = list[k] as ItemAcc;
      const below = list[k + 1] as ItemAcc;
      if (above.figure || below.figure) continue;
      const lines = [...new Set([...above.own, ...below.own])].sort((a, b) => a.line.rect.top - b.line.rect.top || a.line.rect.left - b.line.rect.left);
      const first = lines.indexOf(above.start);
      const last = lines.indexOf(below.start);
      if (first < 0 || last < 0 || first >= last) continue;
      let bottom = -Infinity;
      let best = -1;
      let widest = 0.004;
      lines.forEach((entry, index) => {
        if (index > 0 && index - 1 >= first && index - 1 < last) {
          const gap = entry.line.rect.top - bottom;
          if (gap > widest) {
            widest = gap;
            best = index - 1;
          }
        }
        bottom = Math.max(bottom, entry.line.rect.bottom);
      });
      if (best < 0) continue;
      const upper = lines.slice(0, best + 1);
      const lower = lines.slice(best + 1);
      const moved = [...upper.filter((entry) => !above.own.includes(entry)), ...lower.filter((entry) => !below.own.includes(entry))];
      if (moved.length === 0 || moved.some((entry) => entry.line.chars > 14)) continue;
      above.own = [above.start, ...upper.filter((entry) => entry !== above.start)];
      below.own = [below.start, ...lower.filter((entry) => entry !== below.start)];
    }
  }
}

/** How near a fragment must stand to the row of an item (the line of its number and what stands on it) to belong to it. */
const ROW_REACH = { across: 0.006, down: 0.012, nearer: 0.004 };

/** Lines that stand this close under a paragraph (a share of the page) go on from it. */
const PARAGRAPH_GAP = 0.05;

/** A label this far under the last line of the figure above it (a share of the page) may belong to an item of another column that starts under the figure. */
const FAR_LABEL = 0.25;

const gapBetween = (a: Rect, b: Rect): { across: number; down: number } => ({
  across: Math.max(0, b.left - a.right, a.left - b.right),
  down: Math.max(0, b.top - a.bottom, a.top - b.bottom),
});

/**
 * A fragment (a numerator, the sign of a root, an exponent, a few characters) that does not touch the row of the item it was
 * given, but touches the row of another item of the page, belongs to that other item. The rules that give a line to an item go
 * by columns, and in a grid whose columns do not line up the column of a fragment can be the next one over. The row of an item is
 * its first line and what stands on the same line. A fragment of a figure (its labels) stays where it is.
 */
export function reassignFragments(items: readonly ItemAcc[], startSize: number, donors?: ReadonlySet<ItemAcc>): Set<ItemAcc> {
  const changed = new Set<ItemAcc>();
  const rows = new Map<ItemAcc, Rect>();
  const onRow = new Map<ItemAcc, Set<PLine>>();
  for (const item of items) {
    const start = item.start.line.rect;
    let box: Rect = { ...start };
    const members = new Set<PLine>([item.start]);
    for (const entry of item.own) {
      const rect = entry.line.rect;
      if (entry === item.start || Math.min(start.bottom, rect.bottom) - Math.max(start.top, rect.top) <= 0.5 * Math.min(start.bottom - start.top, rect.bottom - rect.top)) continue;
      members.add(entry);
      box = { left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top), right: Math.max(box.right, rect.right), bottom: Math.max(box.bottom, rect.bottom) };
    }
    rows.set(item, box);
    onRow.set(item, members);
  }
  const touches = (rect: Rect, row: Rect): boolean => {
    const gap = gapBetween(rect, row);
    return gap.across <= ROW_REACH.across && gap.down <= ROW_REACH.down;
  };
  for (const item of items) {
    if (item.figure || (donors && !donors.has(item))) continue;
    const row = rows.get(item) as Rect;
    for (const entry of [...item.own]) {
      if ((onRow.get(item) as Set<PLine>).has(entry)) continue;
      if (!(entry.line.chars <= FRAGMENT_CHARS || entry.line.fontSize < startSize * 0.9)) continue;
      const own = gapBetween(entry.line.rect, row);
      let best: { item: ItemAcc; down: number; across: number } | undefined;
      for (const other of items) {
        if (other === item || other.band !== item.band || other.figure) continue;
        const gap = gapBetween(entry.line.rect, rows.get(other) as Rect);
        if (gap.across > ROW_REACH.across || gap.down > ROW_REACH.down) continue;
        if (!best || gap.down < best.down || (gap.down === best.down && gap.across < best.across)) best = { item: other, ...gap };
      }
      // It moves when it does not touch its own row, or when the row of the other item is clearly nearer.
      if (!best || (touches(entry.line.rect, row) && best.down + ROW_REACH.nearer >= own.down)) continue;
      item.own = item.own.filter((member) => member !== entry);
      best.item.own.push(entry);
      changed.add(item);
      changed.add(best.item);
    }
  }
  return changed;
}

export interface Layout {
  items: ItemAcc[];
  /** The right edge of the text of the whole set (a figure may reach as far as the text of other pages does). */
  bodyRight: number;
  /** Where the text block of the full pages begins (the top of the first line of most pages). */
  bodyTop: number;
  /** The font size of the first lines of the items (the median). */
  startSize: number;
  boundaries: Map<number, { top: number; block: Block }[]>;
  orphans: string[];
}

export function layoutPages(lines: readonly PLine[], pages: readonly PageText[], pitch: number, options: { headingSize?: number } = {}): Layout {
  const items: ItemAcc[] = [];
  const orphanLines: PLine[] = [];
  const boundariesByPage = new Map<number, { top: number; block: Block }[]>();
  const pageList = [...new Set(lines.map((entry) => entry.page))].sort((a, b) => a - b);
  const startSize = median(lines.filter((entry) => entry.role === 'start').map((entry) => entry.line.fontSize)) || 12;
  let previous: ItemAcc[] = [];
  let carried: Block | undefined;
  for (const page of pageList) {
    const onPage = lines.filter((entry) => entry.page === page);
    const tops = new Map<Block, number>();
    for (const entry of onPage) if (entry.block) tops.set(entry.block, Math.min(tops.get(entry.block) ?? Infinity, entry.line.rect.top));
    const boundaries = [...tops].map(([block, top]) => ({ block, top })).sort((a, b) => a.top - b.top);
    boundariesByPage.set(page, boundaries);
    const bandOf = (y: number): number => boundaries.filter((boundary) => boundary.top <= y + 1e-6).length;
    const starts = onPage.filter((entry) => entry.role === 'start');
    const others = onPage.filter((entry) => entry.role === 'other');
    const columnsOf = new Map<number, { center: number; count: number }[]>();
    for (let band = 0; band <= boundaries.length; band += 1) {
      columnsOf.set(
        band,
        cluster(
          starts.filter((entry) => bandOf(entry.line.rect.top) === band).map((entry) => entry.line.rect.left),
          0.02,
        ),
      );
    }
    const columnIndex = (band: number, left: number): number => {
      let index = 0;
      (columnsOf.get(band) ?? []).forEach((column, i) => {
        if (left >= column.center - 0.03) index = i;
      });
      return index;
    };
    const mine: ItemAcc[] = starts.map((entry) => {
      const band = bandOf(entry.line.rect.top);
      const candidate = entry.candidate as Candidate;
      return {
        candidate,
        start: entry,
        own: [entry],
        extra: new Map<number, PLine[]>(),
        spans: [],
        band,
        column: columnIndex(band, entry.line.rect.left),
        page,
        figure: candidate.rest.length === 0,
        block: band > 0 ? (boundaries[band - 1] as { block: Block }).block : carried,
      };
    });
    const inColumn = (band: number, column: number): ItemAcc[] => mine.filter((item) => item.band === band && item.column === column).sort((a, b) => a.start.line.rect.top - b.start.line.rect.top);
    // The paragraph of its own under a row of items (the text that introduces a graph and the exercises under it) and the lines that go on under it.
    let paragraph: { top: number; bottom: number } | undefined;
    for (const entry of [...others].sort((a, b) => a.line.rect.top - b.line.rect.top)) {
      const band = bandOf(entry.line.rect.top);
      const height = entry.line.rect.bottom - entry.line.rect.top;
      // A text that the extraction cut at a gutter goes on right after the first line of its item, in the next column.
      const sameRow = mine
        .filter(
          (item) =>
            item.band === band &&
            Math.min(item.start.line.rect.bottom, entry.line.rect.bottom) - Math.max(item.start.line.rect.top, entry.line.rect.top) > 0.5 * Math.min(height, item.start.line.rect.bottom - item.start.line.rect.top) &&
            entry.line.rect.left - item.start.line.rect.right >= -0.01 &&
            entry.line.rect.left - item.start.line.rect.right <= 0.045,
        )
        .sort((a, b) => Math.abs(entry.line.rect.left - a.start.line.rect.right) - Math.abs(entry.line.rect.left - b.start.line.rect.right))[0];
      // ... unless it stands at the left edge of a column next to an item of that column (then it is that item's).
      const inSlot = mine.some(
        (other) =>
          other !== sameRow &&
          other.band === band &&
          Math.abs(other.start.line.rect.left - entry.line.rect.left) <= 0.03 &&
          other.start.line.rect.top - entry.line.rect.bottom <= 0.03 &&
          entry.line.rect.top - other.start.line.rect.bottom <= 0.03,
      );
      // (Only in a row whose item stands in a column of the page, one that at least half as many items stand in as in the fullest: where the items of a row
      // stand wherever the text before them ends, nothing is a slot.)
      const columnsHere = columnsOf.get(band) ?? [];
      const inGrid = sameRow !== undefined && (columnsHere[sameRow.column]?.count ?? 0) >= 0.5 * Math.max(...columnsHere.map((column) => column.count));
      if (sameRow && !(inGrid && inSlot)) {
        sameRow.own.push(entry);
        continue;
      }
      // The lines that go on from the previous page continue below each other: a line right under such a line goes on too.
      const continued = previous.find((item) => {
        const extra = item.extra.get(page);
        if (!extra || extra.length === 0 || band !== 0) return false;
        const gap = entry.line.rect.top - Math.max(...extra.map((own) => own.line.rect.bottom));
        return gap >= -0.004 && gap <= 0.014 && Math.abs(item.start.line.rect.left - entry.line.rect.left) <= 0.07;
      });
      if (continued) {
        continued.extra.set(page, [...(continued.extra.get(page) ?? []), entry]);
        continue;
      }
      const ownerIn = (column_: ItemAcc[], strict: boolean): ItemAcc | undefined => {
        // A line that shares its row with the first line of an item (the sign of a root, the rows of a fraction) belongs to it.
        // When two rows qualify (the sign of a root reaches up between two tight rows), the one whose text it stands in wins,
        // then the one it overlaps more.
        const overlapWith = (item: ItemAcc): number => Math.min(item.start.line.rect.bottom, entry.line.rect.bottom) - Math.max(item.start.line.rect.top, entry.line.rect.top);
        // A small fragment (the sign of a root, an exponent) needs less of a share to belong to a row: it is small.
        const small = entry.line.chars <= 8 || entry.line.fontSize < startSize * 0.9;
        const sharing = column_.filter((item) => overlapWith(item) > (small ? 0.15 : 0.3) * Math.min(height, item.start.line.rect.bottom - item.start.line.rect.top));
        if (sharing.length > 0) {
          const centreX = (entry.line.rect.left + entry.line.rect.right) / 2;
          const standsIn = (item: ItemAcc): boolean => centreX >= item.start.line.rect.left - 0.005 && centreX <= item.start.line.rect.right + 0.005;
          return [...sharing].sort((a2, b2) => Number(standsIn(b2)) - Number(standsIn(a2)) || overlapWith(b2) - overlapWith(a2))[0];
        }
        const above = [...column_].reverse().find((item) => item.start.line.rect.top <= entry.line.rect.top + 0.004);
        const below = column_.find((item) => item.start.line.rect.top > entry.line.rect.top + 0.004);
        const aboveGap = above ? entry.line.rect.top - Math.max(...above.own.map((own) => own.line.rect.bottom)) : Infinity;
        const belowGap = below ? below.start.line.rect.top - entry.line.rect.bottom : Infinity;
        // A small fragment (the sign of a root, a numerator, a denominator) close above or below the first line of an
        // item, to the right of the number, belongs to that item, unless it sits closer under the last line of the item above.
        if (entry.line.chars <= 8 || entry.line.fontSize < startSize * 0.9) {
          const gapTo = (item: ItemAcc): number => Math.max(0, item.start.line.rect.top - entry.line.rect.bottom, entry.line.rect.top - item.start.line.rect.bottom);
          const near = column_
            .filter(
              (item) =>
                gapTo(item) <= 0.02 &&
                entry.line.rect.left >= item.start.line.rect.left - 0.01 &&
                entry.line.rect.left <= item.start.line.rect.right + 0.1,
            )
            .sort((a2, b2) => gapTo(a2) - gapTo(b2))[0];
          // The coordinates under a graph stand close to its ink, further from the text above than from the number below: under a
          // figure the gap that counts is the white between the fragment and the ink above it.
          const map = pages[page]?.inkMap;
          const inkGap = above?.figure === true && map ? inkAbove(map, entry.line.rect.top, above.start.line.rect.top, entry.line.rect.left - 0.012, entry.line.rect.right + 0.012) : Infinity;
          if (near && gapTo(near) < Math.min(aboveGap, inkGap) - 0.002) return near;
        }
        // The top of a stacked fraction lies just above the line of its item, closer to it than to the item before.
        const overlapsBelow =
          below !== undefined &&
          Math.min(below.start.line.rect.right, entry.line.rect.right) - Math.max(below.start.line.rect.left, entry.line.rect.left) > 0.5 * (entry.line.rect.right - entry.line.rect.left);
        // (A part of an exercise, "(d) Show that ...", is never the top of the fraction of the next one.)
        const isPart = /^\s*(?:\([a-z]\)|[a-z][.)])\s/i.test(entry.line.text);
        if (below && overlapsBelow && !isPart && !below.figure && belowGap >= -0.004 && belowGap <= 0.012 && belowGap + 0.004 < aboveGap) return below;
        if (strict) return undefined;
        if (above) {
          // A line of running text that runs over the starts of two columns or more under a row of four items or more is a paragraph of its own
          // (it introduces a graph and the exercises under it): it is not the second line of the item above, nor are the lines that go on
          // right under it (the rest of it, the labels of its graph) the labels of a figure of that row.
          const columnStarts = (columnsOf.get(band) ?? []).filter((candidate) => candidate.center > entry.line.rect.left + 0.03 && candidate.center < entry.line.rect.right - 0.02).length;
          const rowMates = mine.filter((item) => item.band === band && Math.abs(item.start.line.rect.top - above.start.line.rect.top) <= 0.5 * (above.start.line.rect.bottom - above.start.line.rect.top)).length;
          const opens = entry.line.chars >= RUNNING_TEXT && columnStarts >= 2 && rowMates >= 4;
          const goesOn = paragraph !== undefined && above.start.line.rect.top < paragraph.top && entry.line.rect.top - paragraph.bottom <= PARAGRAPH_GAP;
          if (opens || goesOn) {
            paragraph = { top: paragraph?.top ?? entry.line.rect.top, bottom: Math.max(paragraph?.bottom ?? 0, entry.line.rect.bottom) };
            return undefined;
          }
        }
        if (above && aboveGap <= Math.max(0.15, 8 * pitch)) return above;
        if (above?.figure) {
          // A figure reaches as far down as its labels go, but a label far below it (a quarter of the page and more under its last line) that
          // stands under an item of another column which starts below the figure and spans the label (the lines of that item run over it)
          // is that item's, not the figure's.
          if (aboveGap <= FAR_LABEL) return above;
          const centreX = (entry.line.rect.left + entry.line.rect.right) / 2;
          const spans = (item: ItemAcc): boolean => item.own.some((own) => own.line.rect.left <= centreX && own.line.rect.right >= centreX);
          const nearer = mine
            .filter((item) => item.band === band && item.start.line.rect.top > above.start.line.rect.top && item.start.line.rect.top <= entry.line.rect.top + 0.004 && spans(item))
            .sort((a2, b2) => b2.start.line.rect.top - a2.start.line.rect.top)[0];
          return nearer ?? above;
        }
        return undefined;
      };
      // First the column the line stands in; when no item of it claims the line, the nearest column to its left that has
      // an item above it (the labels of a figure may reach into columns to the right, where other items start further down).
      // A line of running text is no label of a figure: it stays where it stands (the top of a column that goes on from the
      // one before is its place, see `chainSpans`).
      let column = columnIndex(band, entry.line.rect.left);
      let owner = ownerIn(inColumn(band, column), true);
      if (!owner) {
        const above_ = (item: ItemAcc): boolean => item.start.line.rect.top <= entry.line.rect.top + 0.004;
        if (entry.line.chars < RUNNING_TEXT) {
          (columnsOf.get(band) ?? []).forEach((candidate, i) => {
            if (candidate.center <= entry.line.rect.left + 0.03 && mine.some((item) => item.band === band && item.column === i && above_(item))) column = i;
          });
        }
        owner = ownerIn(inColumn(band, column), false);
      }
      const column_ = inColumn(band, column);
      if (owner) {
        owner.own.push(entry);
        continue;
      }
      // Above the first item of its column: the figure of a number that stands alone, else the item that goes on.
      const first = column_[0];
      if (first?.figure && entry.line.rect.top < first.start.line.rect.top) {
        first.own.push(entry);
        continue;
      }
      // Only a line above the first item of its column can go on from the page before: under an item it is part of that one or of none.
      const startedAbove = column_.some((item) => item.start.line.rect.top < entry.line.rect.top - 0.002);
      const carry = startedAbove
        ? undefined
        : previous
        .filter((item) => Math.abs(item.start.line.rect.left - entry.line.rect.left) <= 0.07)
        .sort((a, b) => Math.abs(a.start.line.rect.left - entry.line.rect.left) - Math.abs(b.start.line.rect.left - entry.line.rect.left))[0];
      if (carry && band === 0 && carry.own[carry.own.length - 1] !== undefined) {
        const lastBottom = Math.max(...carry.own.map((own) => own.line.rect.bottom));
        if (lastBottom >= contentLimit(pages[carry.page]) - 0.4) {
          carry.extra.set(page, [...(carry.extra.get(page) ?? []), entry]);
          continue;
        }
      }
      orphanLines.push(entry);
    }
    restack(mine);
    items.push(...mine);
    // The items that may go on over the page break: the lowest of each column.
    const lowest = new Map<number, ItemAcc>();
    for (const item of mine) {
      const key = Math.round(item.start.line.rect.left * 50);
      const known = lowest.get(key);
      if (!known || item.start.line.rect.top > known.start.line.rect.top) lowest.set(key, item);
    }
    // Labels that are right-aligned start at slightly different places: of the items whose numbers stand within a few letters of
    // each other, one column, only the lowest goes on.
    previous = [...lowest.values()].filter(
      (item) => ![...lowest.values()].some((other) => other !== item && Math.abs(other.start.line.rect.left - item.start.line.rect.left) <= 0.03 && other.start.line.rect.top > item.start.line.rect.top),
    );
    if (boundaries.length > 0) carried = (boundaries[boundaries.length - 1] as { block: Block }).block;
  }
  const bodyTop = textBlockTop(lines, pageList);
  const attached = chainSpans(items, orphanLines, lines, pages, pitch, bodyTop, options.headingSize);
  const orphans = orphanLines.filter((entry) => !attached.has(entry)).map((entry) => `page ${entry.page}: "${entry.line.text.slice(0, 40)}"`);
  const rights = lines.map((entry) => entry.line.rect.right);
  return { items, bodyRight: rights.length > 0 ? Math.min(1, Math.max(...rights) + PAD) : 0.95, bodyTop, startSize, boundaries: boundariesByPage, orphans };
}

/** Where the text block of the full pages begins: the top of the first line, taken from the tenth of the pages that start highest. */
function textBlockTop(lines: readonly PLine[], pageList: readonly number[]): number {
  const tops = pageList.map((page) => Math.min(...lines.filter((entry) => entry.page === page).map((entry) => entry.line.rect.top)));
  return tops.length === 0 ? 0 : -fromTop(tops.map((value) => -value), 0.1);
}

const columnOf = (entry: PLine): number => entry.line.column;

/** The value at the given share of the sorted values, counted from the top (0.1: the tenth largest of a hundred). */
function fromTop(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
}

/** Where the inked part of the page's content area begins and ends between two positions, or undefined for a blank area. */
function inkExtent(page: PageText | undefined, from: number, to: number): { top: number; bottom: number } | undefined {
  const ink = page?.ink;
  if (!ink) return undefined;
  const bottom = lowestInk(ink, from, to);
  if (bottom === undefined) return undefined;
  let top = from;
  for (let band = Math.max(0, Math.floor(from * INK_BANDS)); band < INK_BANDS; band += 1) {
    if ((ink[band] ?? 0) >= INK_THRESHOLD) {
      top = band / INK_BANDS;
      break;
    }
  }
  return { top, bottom };
}

/**
 * An item that runs on without a label goes on after the end of its page or its column: at the top of the next column, of the
 * next page, of the next page after a page that holds only a figure, and over any number of pages that have no item of their
 * own. The lines that no item claimed and that stand at the top of a column, above the first item, instruction or heading
 * there, go to the item that reaches the end of the column before it: its text ends in the bottom of the text block (the
 * lowest text of the full pages) and theirs starts in the top of it. Only lines no other rule gave to an item are taken: a
 * numbered line of another item is never swallowed, and a stretch of text that begins lower on its page stays free.
 * Returns the lines that were taken.
 */
function chainSpans(
  items: readonly ItemAcc[],
  orphanLines: readonly PLine[],
  lines: readonly PLine[],
  pages: readonly PageText[],
  pitch: number,
  bodyTop: number,
  headingSize: number | undefined,
): Set<PLine> {
  const attached = new Set<PLine>();
  const pageList = [...new Set(lines.map((entry) => entry.page))].sort((a, b) => a - b);
  const lowest = pageList.map((page) => Math.max(...lines.filter((entry) => entry.page === page).map((entry) => entry.line.rect.bottom)));
  // An item goes on only when its text reaches the end of the text block: near the bottom of the fuller pages, and in any case
  // in the lower part of the page (a page that is half empty ends the item).
  const fuller = fromTop(lowest, 0.1) - 3 * pitch;
  const zoneOf = (page: number): number => Math.max(MIN_OPEN, Math.min(fuller, contentLimit(pages[page]) - 0.1));
  const topZone = bodyTop + 3 * pitch;
  const owner = new Map<PLine, ItemAcc>();
  for (const item of items) {
    for (const entry of item.own) owner.set(entry, item);
    for (const list of item.extra.values()) for (const entry of list) owner.set(entry, item);
  }
  /** Where the text of an item stands before the given place in the reading order (page, then column): its last piece there. */
  const endBefore = (item: ItemAcc, page: number, column: number): { page: number; column: number; bottom: number } | undefined => {
    const pieces: { page: number; column: number; bottom: number }[] = [];
    const add = (entries: readonly PLine[]): void => {
      for (const entryColumn of new Set(entries.map(columnOf))) {
        const here = entries.filter((entry) => columnOf(entry) === entryColumn);
        pieces.push({ page: here[0]?.page ?? item.page, column: entryColumn, bottom: Math.max(...here.map((entry) => entry.line.rect.bottom)) });
      }
    };
    add(item.own);
    for (const list of item.extra.values()) add(list);
    for (const span of item.spans) if (span.lines.length > 0) add(span.lines);
    return pieces
      .filter((piece) => piece.page < page || (piece.page === page && piece.column < column))
      .sort((a, b) => a.page - b.page || a.column - b.column || a.bottom - b.bottom)
      .pop();
  };
  interface Tail {
    item: ItemAcc;
    page: number;
    column: number;
    bottom: number;
  }
  let tail: Tail | undefined;
  for (const [pageIndex, page] of pageList.entries()) {
    const onPage = lines.filter((entry) => entry.page === page);
    const columns = [...new Set(onPage.map(columnOf))].sort((a, b) => a - b);
    for (const [position, column] of columns.entries()) {
      const inColumn = onPage.filter((entry) => columnOf(entry) === column);
      const breaks = inColumn.filter((entry) => entry.role === 'start' || entry.role === 'instruction');
      const firstBreak = breaks.length > 0 ? Math.min(...breaks.map((entry) => entry.line.rect.top)) : Infinity;
      const headings = (pages[page]?.lines ?? []).filter(
        (line) => headingSize !== undefined && !isRunningLine(line) && line.fontSize >= headingSize && line.chars <= 100 && line.column === column,
      );
      const topOf = (entries: readonly PLine[]): PLine[] => entries.filter((entry) => columnOf(entry) === column && entry.line.rect.top < firstBreak - 0.002);
      // The lines at the top of the column that an earlier rule gave to the item on the same column of the page before: they
      // belong to the item that is open at the end of the text before them when that is another item and the first one ended
      // (its text went on in a later column, or stopped in the upper part of its page).
      let carried = items.find((item) => topOf(item.extra.get(page) ?? []).length > 0);
      const reading = tail !== undefined && (position === 0 ? tail.page < page : tail.page === page && tail.column < column);
      const released: PLine[] = [];
      if (carried && tail && reading && tail.item !== carried && tail.bottom >= zoneOf(tail.page)) {
        const end = endBefore(carried, page, column);
        if (end && end.bottom < zoneOf(end.page)) {
          const moved = topOf(carried.extra.get(page) ?? []);
          const rest = (carried.extra.get(page) ?? []).filter((entry) => !moved.includes(entry));
          if (rest.length > 0) carried.extra.set(page, rest);
          else carried.extra.delete(page);
          for (const entry of moved) owner.delete(entry);
          released.push(...moved);
          carried = undefined;
        }
      }
      const free = [
        ...released,
        ...orphanLines.filter((entry) => entry.page === page && columnOf(entry) === column && !attached.has(entry) && !owner.has(entry) && entry.line.rect.top < firstBreak - 0.002),
      ].sort((a, b) => a.line.rect.top - b.line.rect.top);
      const group: PLine[] = [];
      const carriedLines = carried ? topOf(carried.extra.get(page) ?? []) : [];
      let reach = carriedLines.length > 0 ? Math.max(...carriedLines.map((entry) => entry.line.rect.bottom)) : -Infinity;
      for (const entry of free) {
        const gap = entry.line.rect.top - reach;
        if (group.length > 0 && gap > 0.12) break;
        if (headings.some((heading) => heading.rect.bottom > reach - 0.002 && heading.rect.top < entry.line.rect.top)) break;
        if (carried && group.length === 0 && gap > 3 * pitch) break;
        group.push(entry);
        reach = Math.max(reach, entry.line.rect.bottom);
      }
      const first = group[0];
      // The item that receives the lines: the one the old rules chose, or the one open at the end of the text before them. Free
      // lines are the text of a paragraph there, not the rows of a fraction: the first has some length, and on a new page it
      // stands at the top of the text block.
      const paragraphLike = first !== undefined && first.line.chars >= MIN_PARAGRAPH_LINE && (position > 0 || first.line.rect.top <= topZone);
      const receiver = carried ?? (tail && reading && tail.bottom >= zoneOf(tail.page) && paragraphLike ? tail.item : undefined);
      if (receiver && (first || carriedLines.length > 0)) {
        // Pages between that hold only a figure (no text line, some ink in the text block) belong to the span: its text goes on after them.
        if (position === 0) {
          const before = pageList[pageIndex - 1];
          for (let q = (before ?? page) + 1; q < page; q += 1) {
            if (inkExtent(pages[q], bodyTop - 0.005, contentLimit(pages[q])) !== undefined) receiver.spans.push({ page: q, column: 0, lines: [], figure: true });
          }
        }
        if (group.length > 0) receiver.spans.push({ page, column, lines: group });
        for (const entry of group) {
          attached.add(entry);
          owner.set(entry, receiver);
        }
      }
      // The flow goes on from the item that owns the lowest line of the column, when there is one.
      const lowestLine = inColumn.reduce((a, b) => (b.line.rect.bottom > a.line.rect.bottom ? b : a));
      const holder = owner.get(lowestLine);
      tail = holder ? { item: holder, page, column, bottom: lowestLine.line.rect.bottom } : undefined;
    }
  }
  return attached;
}


// ---------------------------------------------------------------------------------------------------------------------
// The frame of an item

export function groupByColumn(items: readonly ItemAcc[]): Map<string, ItemAcc[]> {
  const byColumn = new Map<string, ItemAcc[]>();
  for (const item of items) {
    const key = `${item.page}:${item.band}:${item.column}`;
    byColumn.set(key, [...(byColumn.get(key) ?? []), item]);
  }
  return byColumn;
}

export interface FrameContext {
  pages: readonly PageText[];
  items: readonly ItemAcc[];
  byColumn: ReadonlyMap<string, readonly ItemAcc[]>;
  layout: Layout;
  /** Lines set at least this large are headings: nothing is framed beyond the top of one. */
  headingSize?: number;
  /** Places where the lines that belong to the items end (the end of the practice set, of a zone of answers): no frame reaches below one. */
  ends?: readonly { page: number; top: number }[];
}

/** The lines that an item owns (own, carried over and in a span), per list of items. */
const ownedLines = new WeakMap<readonly ItemAcc[], Set<TextLine>>();

function ownedBy(items: readonly ItemAcc[]): Set<TextLine> {
  const known = ownedLines.get(items);
  if (known) return known;
  const owned = new Set<TextLine>();
  const add = (entry: PLine): void => {
    owned.add(entry.line);
    const source = sourceOf.get(entry.line);
    if (source) owned.add(source);
  };
  for (const item of items) {
    for (const entry of item.own) add(entry);
    for (const list of item.extra.values()) for (const entry of list) add(entry);
    for (const span of item.spans) for (const entry of span.lines) add(entry);
  }
  ownedLines.set(items, owned);
  return owned;
}

export interface ItemFrame {
  rect: Rect;
  continues: Region[];
  /** The item is a figure with labels (its number stands alone, or most of its lines are short). */
  figure: boolean;
  /** The labels of the items whose frames this one was cut apart from (see `separateFrames`). */
  cut?: string[];
}

export interface FramedItem {
  item: ItemAcc;
  frame: ItemFrame;
}

/** The share of the smaller frame and the height at which two frames count as lying on each other (the thresholds of `exercises verify`). */
const OVERLAP_SHARE = 0.05;
const OVERLAP_HEIGHT = 0.004;

/** The text of two items may touch by this much (the arrow above a letter, the descender of the line above) and still be cut apart between them. */
export const TOUCHING = 0.006;

const rectArea = (rect: Rect): number => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);

function ownBox(item: ItemAcc): Rect {
  const rects = item.own.map((entry) => entry.line.rect);
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

/** Whether the lines of an item form one block: each starts within a line's height of the ones above it, and the block is not tall. */
function isCompact(item: ItemAcc): boolean {
  const rects = item.own.map((entry) => entry.line.rect).sort((a, b) => a.top - b.top);
  let reach = -Infinity;
  for (const rect of rects) {
    if (reach > -Infinity && rect.top - reach > 0.015) return false;
    reach = Math.max(reach, rect.bottom);
  }
  return (rects[rects.length - 1] as Rect).bottom - (rects[0] as Rect).top <= 0.12;
}

/** The items whose frames lie on the frame of another item of the page (see `separateFrames`). */
export function overlappingItems(framed: readonly FramedItem[], minShare = OVERLAP_SHARE, minHeight = OVERLAP_HEIGHT): Set<ItemAcc> {
  const found = new Set<ItemAcc>();
  const byPage = new Map<number, FramedItem[]>();
  for (const entry of framed) byPage.set(entry.item.page, [...(byPage.get(entry.item.page) ?? []), entry]);
  for (const list of byPage.values()) {
    list.sort((a, b) => a.frame.rect.top - b.frame.rect.top);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i] as FramedItem;
        const b = list[j] as FramedItem;
        if (b.frame.rect.top >= a.frame.rect.bottom) break;
        const height = Math.min(a.frame.rect.bottom, b.frame.rect.bottom) - Math.max(a.frame.rect.top, b.frame.rect.top);
        const width = Math.min(a.frame.rect.right, b.frame.rect.right) - Math.max(a.frame.rect.left, b.frame.rect.left);
        if (width <= 0 || height < minHeight) continue;
        if ((width * height) / Math.min(rectArea(a.frame.rect), rectArea(b.frame.rect)) <= minShare) continue;
        found.add(a.item);
        found.add(b.item);
      }
    }
  }
  return found;
}

/**
 * The frames of all items of a set: each item framed on its own, then, where frames lie on each other, the fragments that were
 * given to the wrong item are given back (see `reassignFragments`), the items that changed are framed again and the frames
 * that still lie on each other are cut apart. A set whose frames do not lie on each other is framed exactly by `itemFrame`.
 * Frames lie on each other when the common part is more than `conflictShare` of the smaller one (default a twentieth) and at
 * least `conflictHeight` high (default 0.004); answers use larger values, as a sliver of the answer above is no mistake.
 */
export function frameItems(items: readonly ItemAcc[], context: FrameContext, options: { touching?: number; conflictShare?: number; conflictHeight?: number } = {}): FramedItem[] {
  let framed: FramedItem[] = items.map((item) => ({ item, frame: itemFrame(item, context) }));
  const conflicted = overlappingItems(framed, options.conflictShare, options.conflictHeight);
  if (conflicted.size > 0) {
    // A number that stands alone is a figure only when nothing else stands on its row: the text of an item that the extraction
    // set apart from its number (`27.` and the expression beside it) makes an ordinary item.
    const reclassified = new Set<ItemAcc>();
    for (const item of conflicted) {
      const start = item.start.line.rect;
      const text = item.own.some(
        (entry) => entry !== item.start && entry.line.rect.left >= start.right - 0.005 && Math.min(start.bottom, entry.line.rect.bottom) - Math.max(start.top, entry.line.rect.top) > 0.5 * (start.bottom - start.top),
      );
      if (item.figure && text) {
        item.figure = false;
        reclassified.add(item);
      }
    }
    const changed = reassignFragments(items, context.layout.startSize, conflicted);
    for (const item of reclassified) changed.add(item);
    // Short lines that stand close together are the rows of one expression (a fraction, a root), not the labels of a figure.
    for (const item of [...conflicted, ...changed]) {
      if (!item.figure && item.plain !== true && isCompact(item)) {
        item.plain = true;
        changed.add(item);
      }
    }
    if (changed.size > 0) framed = framed.map((entry) => (changed.has(entry.item) ? { item: entry.item, frame: itemFrame(entry.item, context) } : entry));
  }
  separateFrames(framed, options.touching);
  return framed;
}

/**
 * Two frames on one page that lie on each other (more than a twentieth of the smaller one, at least 0.004 high) are cut apart
 * where the text of their items allows it: items one above the other at the middle of the gap between the last line of the
 * upper and the first line of the lower, items side by side at the middle between the right edge of the left text and the left
 * edge of the right text. The cut goes along the axis on which the frames overlap least. Frames that do not lie on each other
 * are never touched; two items whose text overlaps (a line that was given to the wrong item) cannot be cut apart and stay as
 * they are.
 */
export function separateFrames(framed: readonly FramedItem[], touching = 0.001): void {
  const byPage = new Map<number, FramedItem[]>();
  for (const entry of framed) byPage.set(entry.item.page, [...(byPage.get(entry.item.page) ?? []), entry]);
  for (const list of byPage.values()) {
    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;
      list.sort((a, b) => a.frame.rect.top - b.frame.rect.top || a.frame.rect.left - b.frame.rect.left);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i] as FramedItem;
          const b = list[j] as FramedItem;
          if (b.frame.rect.top >= a.frame.rect.bottom) break;
          const common: Rect = {
            left: Math.max(a.frame.rect.left, b.frame.rect.left),
            top: Math.max(a.frame.rect.top, b.frame.rect.top),
            right: Math.min(a.frame.rect.right, b.frame.rect.right),
            bottom: Math.min(a.frame.rect.bottom, b.frame.rect.bottom),
          };
          if (common.right <= common.left || common.bottom <= common.top) continue;
          const share = rectArea(common) / Math.min(rectArea(a.frame.rect), rectArea(b.frame.rect));
          if (share <= OVERLAP_SHARE || common.bottom - common.top < OVERLAP_HEIGHT) continue;
          const boxA = ownBox(a.item);
          const boxB = ownBox(b.item);
          const axes: ('vertical' | 'horizontal')[] = common.bottom - common.top <= common.right - common.left ? ['vertical', 'horizontal'] : ['horizontal', 'vertical'];
          for (const axis of axes) {
            if (axis === 'vertical') {
              const [upper, lower, boxUpper, boxLower] = boxA.bottom <= boxB.top + touching ? [a, b, boxA, boxB] : boxB.bottom <= boxA.top + touching ? [b, a, boxB, boxA] : [];
              if (!upper || !lower || !boxUpper || !boxLower) continue;
              const cutAt = round((boxUpper.bottom + boxLower.top) / 2);
              upper.frame.rect.bottom = Math.min(upper.frame.rect.bottom, cutAt);
              lower.frame.rect.top = Math.max(lower.frame.rect.top, cutAt);
            } else {
              const [left, right, boxLeft, boxRight] = boxA.right <= boxB.left + touching ? [a, b, boxA, boxB] : boxB.right <= boxA.left + touching ? [b, a, boxB, boxA] : [];
              if (!left || !right || !boxLeft || !boxRight) continue;
              const cutAt = round((boxLeft.right + boxRight.left) / 2);
              left.frame.rect.right = Math.min(left.frame.rect.right, cutAt);
              right.frame.rect.left = Math.max(right.frame.rect.left, cutAt);
            }
            a.frame.cut = [...new Set([...(a.frame.cut ?? []), b.item.candidate.label])];
            b.frame.cut = [...new Set([...(b.frame.cut ?? []), a.item.candidate.label])];
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
  }
}

/** The frame of an item on its page, and the regions on the following pages where it goes on. */
export function itemFrame(item: ItemAcc, context: FrameContext): ItemFrame {
  const { pages, items, byColumn, layout, headingSize, ends } = context;
  const page = pages[item.page] as PageText;
  const all = page.lines;
  const extent = (page: number, band: number, column: number): { left: number; right: number } | undefined => {
    const group = byColumn.get(`${page}:${band}:${column}`);
    if (!group) return undefined;
    const groupLines = group.flatMap((other) => [...other.own]);
    return {
      left: Math.min(...groupLines.map((entryLine) => entryLine.line.rect.left)),
      right: Math.max(...groupLines.map((entryLine) => entryLine.line.rect.right)),
    };
  };
  const mine = extent(item.page, item.band, item.column) as { left: number; right: number };
  const ownLeft = Math.min(...item.own.map((entryLine) => entryLine.line.rect.left));
  const ownRight = Math.max(...item.own.map((entryLine) => entryLine.line.rect.right));
  let left = mine.left - PAD;
  let right = mine.right + PAD;
  // Next to another column of the same group the frames meet in the middle of the gap between the texts and never
  // reach into the text of the neighbour (a wide item of the group does not widen the frame of a narrow one).
  const previousColumn = extent(item.page, item.band, item.column - 1);
  const nextColumn = extent(item.page, item.band, item.column + 1);
  if (nextColumn) {
    const gap = nextColumn.left - mine.right;
    if (gap > 0) right = Math.min(right, mine.right + gap / 2 - 0.0005);
    else right = Math.min(right, Math.max(ownRight + 0.003, nextColumn.left - 0.003));
  }
  if (previousColumn) {
    const gap = mine.left - previousColumn.right;
    if (gap > 0) left = Math.max(left, mine.left - gap / 2 + 0.0005);
    else left = Math.max(left, Math.min(ownLeft - 0.003, previousColumn.right + 0.003));
  }
  const short = item.own.filter((entryLine) => entryLine.line.chars <= FIGURE_SHORT).length;
  const figure = item.figure || (item.plain !== true && item.own.length >= 3 && short >= 0.5 * item.own.length);
  if (figure) {
    const body = all.filter((entryLine) => !isRunningLine(entryLine));
    const bodyRight = Math.max(layout.bodyRight, body.length > 0 ? Math.max(...body.map((entryLine) => entryLine.rect.right)) + PAD : 0);
    const rightNeighbours = items
      .filter((other) => other.page === item.page && other.band === item.band && other.start.line.rect.left > item.start.line.rect.left + 0.1 && Math.abs(other.start.line.rect.top - item.start.line.rect.top) <= 0.12)
      .map((other) => other.start.line.rect.left - PAD);
    right = Math.max(right, Math.min(rightNeighbours.length > 0 ? Math.min(...rightNeighbours) : bodyRight, bodyRight));
  }
  left = clamp01(left);
  right = clamp01(right);
  const firstLine = [...item.own].sort((a, b) => a.line.rect.top - b.line.rect.top)[0] as PLine;
  const ownTop = firstLine.line.rect.top;
  let top = clamp01(lineStart(firstLine.line, AUTHORING.startPadding, all));
  // The frame never starts inside a line of something else beside it (an instruction, the fraction row of the item above):
  // it starts under that line, so that its descenders stay out, but never below the first line of the item itself.
  const ownLines = new Set<TextLine>(item.own.map((entryLine) => entryLine.line));
  for (const other of all) {
    if (ownLines.has(other) || isRunningLine(other)) continue;
    const centre = (other.rect.left + other.rect.right) / 2;
    if (centre < left || centre > right) continue;
    const height = other.rect.bottom - other.rect.top;
    if (height <= 0 || height > 0.05 || other.rect.top >= ownTop || other.rect.bottom <= top) continue;
    top = Math.max(top, Math.min(other.rect.bottom, ownTop - 0.0005));
  }
  const lastText = Math.max(...item.own.map((entryLine) => entryLine.line.rect.bottom));
  let bottom = clamp01(lastText + AUTHORING.endPadding);
  const hasNextInColumn = items.some((other) => other.page === item.page && other.band === item.band && other.column === item.column && other.start.line.rect.top > item.start.line.rect.top);
  // The limit below: the next item or instruction in the same column, or the end of the page's content.
  const below = [
    ...items
      .filter((other) => other.page === item.page && other.band === item.band && other.column === item.column && other.start.line.rect.top > item.start.line.rect.top)
      .map((other) => lineStart(([...other.own].sort((x, y) => x.line.rect.top - y.line.rect.top)[0] as PLine).line, AUTHORING.startPadding, all)),
    ...(layout.boundaries.get(item.page) ?? []).filter((boundary) => boundary.top > lastText).map((boundary) => boundary.top - AUTHORING.startPadding),
    // The end of the set (the heading of what follows it, the answers of the section) ends every frame.
    ...(ends ?? []).filter((end) => end.page === item.page && end.top > lastText - 0.002).map((end) => end.top - 0.004),
    // A heading below (the next chapter of an answer key) ends the frame, also of a figure that reaches down over ink.
    ...(headingSize !== undefined && headingSize > 0
      ? all
          .filter((entryLine) => !isRunningLine(entryLine) && entryLine.fontSize >= headingSize && entryLine.rect.top > lastText - 0.002 && Math.min(entryLine.rect.right, right) > Math.max(entryLine.rect.left, left))
          .map((entryLine) => entryLine.rect.top - 0.004)
      : []),
  ];
  const limit = Math.min(contentLimit(page), ...below);
  if (page.ink) {
    // Ink under the last line (a figure) counts, but not ink that belongs to a neighbouring column. A figure may reach
    // down beside the labels of its neighbours, so it stops at the first item below it; any other item stops at the
    // first line beside it.
    const foreign = figure
      ? items
          .filter(
            (other) =>
              other !== item &&
              other.page === item.page &&
              other.start.line.rect.top > lastText + 0.002 &&
              Math.min(right, Math.max(...other.own.map((entryLine) => entryLine.line.rect.right))) > Math.max(left, Math.min(...other.own.map((entryLine) => entryLine.line.rect.left))),
          )
          .flatMap((other) => other.own.map((entryLine) => entryLine.line.rect.top - 0.003))
      : [
          ...all
            .filter((entryLine) => !isRunningLine(entryLine) && entryLine.rect.top > lastText + 0.002 && (entryLine.rect.left >= right - 0.02 || entryLine.rect.right <= left + 0.02))
            .map((entryLine) => entryLine.rect.top - 0.003),
          // A line of another item below, over the width of the frame, is text and not part of a figure: the frame stops above it
          // (an item in a row of its own has no item of its column under it to stop at).
          ...items
            .filter((other) => other !== item && other.page === item.page && !hasNextInColumn)
            .flatMap((other) => other.own)
            .filter((entryLine) => entryLine.line.rect.top > lastText + 0.002 && entryLine.line.rect.right > left + 0.005 && entryLine.line.rect.left < right - 0.005)
            .map((entryLine) => entryLine.line.rect.top - 0.003),
        ];
    // Ink under the last line is a figure, not the text of something else: a line of text below that no item owns (a paragraph, the
    // heading of the answers) stops the reach, but the labels of a figure (short lines) do not.
    const owned = ownedBy(items);
    const text_ = all
      .filter((entryLine) => !isRunningLine(entryLine) && !owned.has(entryLine) && entryLine.chars >= STRAY_TEXT && entryLine.rect.top > lastText + 0.002 && entryLine.rect.right > left + 0.005 && entryLine.rect.left < right - 0.005)
      .map((entryLine) => entryLine.rect.top - 0.003);
    const ceiling = Math.min(limit, ...foreign, ...text_);
    if (ceiling > lastText) {
      const lowest = lowestInk(page.ink, lastText, ceiling);
      if (lowest !== undefined) bottom = Math.max(bottom, Math.min(ceiling, lowest + AUTHORING.endPadding));
    }
  }
  if (below.length > 0) bottom = Math.min(bottom, limit);
  // The lines of the item itself are always inside, even where the next item's fraction rows reach up into them.
  bottom = Math.max(bottom, Math.min(1, lastText + 0.001), top + AUTHORING.minPieceHeight * 1.5);
  // An edge that runs through the ink of a neighbouring line moves into the white between the lines, as far as the own
  // lines allow: the top edge stays above the own first line, the bottom edge below the own last one.
  if (page.inkMap && !figure) {
    if (rowInk(page.inkMap, top, left, right) > INK_CLEAN) top = nearestWhiteRow(page.inkMap, top, top - 0.003, Math.max(top, ownTop), left, right) ?? top;
    if (rowInk(page.inkMap, bottom, left, right) > INK_CLEAN) bottom = nearestWhiteRow(page.inkMap, bottom, Math.min(bottom, lastText), bottom + 0.003, left, right) ?? bottom;
  }
  const rect: Rect = { left: round(left), top: round(top), right: round(right), bottom: round(Math.min(1, bottom)) };

  const continues: Region[] = [];
  for (const [continuePage, extraLines] of [...item.extra].sort((a, b) => a[0] - b[0])) {
    const extraTop = Math.min(...extraLines.map((entryLine) => entryLine.line.rect.top));
    const firstExtra = extraLines.find((entryLine) => entryLine.line.rect.top === extraTop) as PLine;
    continues.push({
      page: continuePage,
      rect: {
        left: round(clamp01(Math.min(left, Math.min(...extraLines.map((entryLine) => entryLine.line.rect.left)) - PAD))),
        top: round(clamp01(lineStart(firstExtra.line, AUTHORING.startPadding, pages[continuePage]?.lines))),
        right: round(clamp01(Math.max(right, Math.max(...extraLines.map((entryLine) => entryLine.line.rect.right)) + PAD))),
        bottom: round(clamp01(Math.max(...extraLines.map((entryLine) => entryLine.line.rect.bottom)) + AUTHORING.endPadding)),
      },
    });
  }
  const regions = [...continues.map((region) => ({ region, column: columnOf(item.start) })), ...spanRegions(item, context, left, right)];
  // In reading order: by page, and on one page by column (left to right).
  regions.sort((a, b) => a.region.page - b.region.page || a.column - b.column);
  // Two regions of one page that lie on each other are one: lines that the carry from the page before and the chain of columns both took.
  const joined: { region: Region; column: number }[] = [];
  for (const entry of regions) {
    const last = joined[joined.length - 1];
    if (last && last.region.page === entry.region.page && lieOnEachOther(last.region.rect, entry.region.rect)) {
      const a = last.region.rect;
      const b = entry.region.rect;
      last.region = { page: last.region.page, rect: { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) } };
    } else joined.push({ ...entry });
  }
  return { rect, continues: joined.map((entry) => entry.region), figure };
}

/** Whether two rectangles share an area (more than a sliver in both directions). */
const lieOnEachOther = (a: Rect, b: Rect): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.001 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.001;

/**
 * The regions of the later pages and columns that an item runs over (see `chainSpans`). A stretch in the column of the item is
 * as wide as the item's frame; one in another column fits its own lines. A page that holds only a figure is covered where it is
 * inked. The last stretch ends above the next item, instruction or heading of its column, and a figure or table drawn under
 * its last line (ink and no text) belongs to it as far as that.
 */
function spanRegions(item: ItemAcc, context: FrameContext, left: number, right: number): { region: Region; column: number }[] {
  const { pages, items, layout, headingSize } = context;
  const result: { region: Region; column: number }[] = [];
  for (const span of item.spans) {
    const pageText = pages[span.page];
    if (span.figure) {
      const extent = inkExtent(pageText, layout.bodyTop - 0.005, contentLimit(pageText));
      if (!extent) continue;
      result.push({
        region: { page: span.page, rect: { left: round(clamp01(left)), top: round(clamp01(extent.top - 0.004)), right: round(clamp01(right)), bottom: round(clamp01(extent.bottom + 0.004)) } },
        column: columnOf(item.start),
      });
      continue;
    }
    if (span.lines.length === 0) continue;
    const sameColumn = span.column === columnOf(item.start);
    const spanLeft = Math.min(...span.lines.map((entry) => entry.line.rect.left)) - PAD;
    const spanRight = Math.max(...span.lines.map((entry) => entry.line.rect.right)) + PAD;
    const first = span.lines.reduce((a, b) => (b.line.rect.top < a.line.rect.top ? b : a));
    const lastBottom = Math.max(...span.lines.map((entry) => entry.line.rect.bottom));
    let bottom = lastBottom + AUTHORING.endPadding;
    if (pageText?.ink && pageText.columns <= 1) {
      const breaks = [
        contentLimit(pageText),
        ...items
          .filter((other) => other.page === span.page && columnOf(other.start) === span.column && other.start.line.rect.top > lastBottom)
          .map((other) => Math.min(...other.own.map((entry) => entry.line.rect.top)) - 0.003),
        ...(layout.boundaries.get(span.page) ?? []).filter((boundary) => boundary.top > lastBottom).map((boundary) => boundary.top - AUTHORING.startPadding),
        ...(headingSize !== undefined && headingSize > 0
          ? pageText.lines.filter((line) => !isRunningLine(line) && line.fontSize >= headingSize && line.rect.top > lastBottom).map((line) => line.rect.top - 0.004)
          : []),
      ];
      const limit = Math.min(...breaks);
      const lowest = limit > lastBottom ? lowestInk(pageText.ink, lastBottom, limit) : undefined;
      if (lowest !== undefined) bottom = Math.max(bottom, Math.min(limit, lowest + AUTHORING.endPadding));
    }
    result.push({
      region: {
        page: span.page,
        rect: {
          left: round(clamp01(sameColumn ? Math.min(left, spanLeft) : spanLeft)),
          top: round(clamp01(lineStart(first.line, AUTHORING.startPadding, pageText?.lines))),
          right: round(clamp01(sameColumn ? Math.max(right, spanRight) : spanRight)),
          bottom: round(clamp01(bottom)),
        },
      },
      column: span.column,
    });
  }
  return result;
}
