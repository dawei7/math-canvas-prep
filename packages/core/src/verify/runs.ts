import type { LinePart, PageText, Rect, TextLine } from '../model/types.js';
import type { Project } from '../project/model.js';
import { draft, type Draft } from './common.js';
import { excerpt, foldText } from './labels.js';
import { PageIndex } from './regions.js';
import { coveredShare } from './run.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * The census of numbered runs: every place in the text layer where at least five items are numbered one after the other, whatever the
 * book calls them and however its pages are laid out. The finder of exercises (`exercises propose`) reads only the layouts it was taught,
 * and every check of the harness hangs on the same practice-set recognition: a layout it does not know gives no finding at all, and an
 * empty result looks like a clean book. The census does not know any heading word or layout. It looks for the one thing every list of
 * exercises, answers, references or steps has in common, numbers that follow each other, and asks whether the project covers them.
 *
 * What counts as an item, a run and a cover is written down in docs/AUDIT_A_BOOK.md ("The census of numbered runs"):
 * - an item is a line (or one cell of a row of several) that starts with a label and then has text: `8.`, `8)`, `(8)`, a dotted label of
 *   a fixed chapter (`4.12`), or a keyword and a number (`Exercise 4.2`, `Aufgabe 1.26`);
 * - a run is `minRun` or more items of one kind whose numbers rise by one (by two in a key that prints only the odd or only the even
 *   items), in reading order, from column to column and page to page; one label in ten may be missing;
 * - a run is covered when most of its item lines lie inside a region of the project.
 */

export type RunScheme = 'k.' | 'k)' | '(k)' | 'k.m' | 'keyword';

/** The thresholds of the census (page fractions unless said otherwise). They are documented in docs/AUDIT_A_BOOK.md. */
export const RUN_LIMITS = {
  /** A run has at least this many items. */
  minRun: 5,
  /** A project that covers at least this many runs is audited: the gate judges it on the runs of at least `auditedMinRun` items (a list of five to seven numbered items is mostly the parts of a worked example or the steps of a method). */
  auditedRuns: 3,
  auditedMinRun: 8,
  /** A run is covered when at least this share of its item lines lie inside regions (the share of a line that counts as inside is `VERIFY_LIMITS.coveredShare`). */
  covered: 0.8,
  /** One label in this many may be missing from a run. */
  missingPer: 10,
  /** A line whose type is this many times the usual size of the book and that is short is a heading, not an item (numbers and dotted numbers only). */
  headingSize: 1.2,
  /** Items of one run stand within this many pages of each other. */
  maxPagesApart: 2,
  /** Items in one column of a page have left edges this close. */
  streamTolerance: 0.04,
  /** A run is a table of contents or an index when at least this share of its items end in a page number. */
  pageNumberShare: 0.4,
  /** A run whose items stand in the top or bottom band of their pages, at most about one to a page, is furniture (a running head that changes with the page). */
  furnitureShare: 0.8,
  furnitureBand: 0.09,
  furnitureItemsPerPage: 1.5,
  /** Items of one or two characters ... */
  shortItemLength: 2,
  /** ... make no run below this many of them (matrix entries, the cells of a table); more of them are an answer key. */
  shortItemsKeyAt: 10,
  /** A run is the headings of the book printed again (the outline of a chapter before its sections) when this share of its items repeat the label and the words of a heading that is set larger. */
  headingsShare: 0.5,
  /** The longest heading line reported, in characters. */
  headingLength: 80,
  /** A line is in the column of an item for the heading search when it starts no further than this to the right of the item (a page fraction). */
  headingColumn: 0.3,
  /** A line is "short" (it may be a heading) up to this many characters. */
  shortLine: 48,
  /** Years: a run whose numbers are all in this range is a list of years. */
  yearFrom: 1000,
  yearTo: 2100,
} as const;

/** The words that make a keyword label: `Exercise 4.2`, `Problem 7`, `Aufgabe 1.26`. English and German; the list is an option. */
export const DEFAULT_RUN_KEYWORDS: readonly string[] = ['exercise', 'problem', 'question', 'task', 'aufgabe', 'uebung', 'übung', 'frage'];

/** The text of every page, by zero-based page number: a list (the index is the page) or a lookup (with `pageCount`). */
export type RunPages = readonly (PageText | undefined)[] | ((page: number) => PageText | undefined);

export interface RunOptions {
  /** The fewest items a run has (default 5). */
  minRun?: number;
  /** The words of keyword labels (default {@link DEFAULT_RUN_KEYWORDS}); an empty list reads none. */
  keywords?: readonly string[];
  /** The regions of the project that cover text, by page (an exercise, its continuations, its instructions, its answers); without it nothing is covered. */
  regions?: (page: number) => readonly { rect: Rect }[];
  /** How many pages there are, when `pages` is a lookup. */
  pageCount?: number;
}

/** Why a candidate of five or more numbered items is no run: it is a list of something else. */
export type LeftOutReason = 'years' | 'contents' | 'running-head' | 'short-items' | 'headings';

/** What each reason says, in a sentence. */
export const LEFT_OUT_REASONS: Readonly<Record<LeftOutReason, string>> = {
  years: 'a list of years',
  contents: 'a table of contents, an index or a list with leader dots (the lines end in page numbers or have leaders)',
  'running-head': 'a running head or footer (a line in the top or bottom band of the page, about one to a page)',
  'short-items': 'fewer than ten items of one or two characters (a column of values, the cells of a table)',
  headings: 'the headings of the book printed again as a list (the outline of a chapter)',
};

/** A candidate that was left out: the numbers it counted and the reason; named as the run would have been. */
export interface LeftOutRun {
  id: string;
  firstPage: number;
  lastPage: number;
  first: string;
  last: string;
  count: number;
  reason: LeftOutReason;
  /** The share of its items that lie inside a region of the project (a candidate that the project covers anyway is no loss). */
  coverage: number;
}

export interface RunItem {
  page: number;
  /** The box of the line that starts the item (one cell of a row of several). */
  rect: Rect;
  /** The label as printed: `8.`, `(8)`, `1.12`, `Exercise 4.2`. */
  label: string;
  /** The number the item counts as (the last number of a dotted label). */
  n: number;
  /** The first 60 characters of the line. */
  text: string;
  /** Whether the line lies inside a region of the project. */
  covered: boolean;
}

export interface NumberedRun {
  /** `p32:8`: the zero-based page of the first item and its first label (`8`, `8_paren` for `8)`, `8_parens` for `(8)`, `1.12`, `Exercise_4.2`); a second run with the same id gets `#2`. */
  id: string;
  /** The pages that hold items, in order. */
  pages: number[];
  firstPage: number;
  lastPage: number;
  /** The first and the last label as printed (`8.`, `21.`). */
  first: string;
  last: string;
  /** How many items were found. */
  count: number;
  /** How many numbers between the first and the last no item has (the text layer drops lines, books skip numbers). */
  missing: number;
  scheme: RunScheme;
  /** 1 for consecutive numbers, 2 for a key that prints every second one. */
  step: 1 | 2;
  /** With step 2: whether the numbers are odd or even. */
  parity?: 'odd' | 'even';
  /** The word of a keyword label (`Exercise`). */
  keyword?: string;
  /** The nearest line above the first item that is no item and is short or set larger or bolder; undefined when there is none. */
  heading?: string;
  /** The first 60 characters of the first item. */
  start: string;
  firstItem: { page: number; rect: Rect };
  lastItem: { page: number; rect: Rect };
  /** The share of the items that lie inside a region of the project (0 without regions). */
  coverage: number;
  /** `coverage` is at least {@link RUN_LIMITS.covered}. */
  covered: boolean;
  items: RunItem[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels

type Style = 'dot' | 'paren' | 'parens' | 'dotted' | 'keyword';

const SCHEME: Record<Style, RunScheme> = { dot: 'k.', paren: 'k)', parens: '(k)', dotted: 'k.m', keyword: 'keyword' };

interface Label {
  style: Style;
  /** What items of one run share: the style, and for a dotted or keyword label the keyword and the fixed part of the number. */
  family: string;
  n: number;
  /** The number's parts before the last one (`4` for `4.12`). */
  prefix: string;
  printed: string;
  keyword?: string;
}

/** `8. text`: a number and a full stop that no digit follows (that is a decimal point), then text. */
const DOT = /^(\d{1,4})\.(?!\d)\s*(\S.*)$/u;
const PAREN = /^(\d{1,4})\)\s*(\S.*)$/u;
const PARENS = /^\((\d{1,4})\)\s*(\S.*)$/u;
/** `4.12 text` and `1.2.3 text`: a dotted number of two to four parts, a space and text. */
const DOTTED = /^(\d{1,3}(?:\.\d{1,4}){1,3})\.?\s+(\S.*)$/u;
/** A label that stands alone on its line: the text of the item is the piece beside it. */
const LABEL_ONLY = /^(\d{1,4})[.)]$/u;

function keywordPattern(words: readonly string[]): RegExp | undefined {
  const list = words.map((word) => word.trim()).filter((word) => word !== '');
  if (list.length === 0) return undefined;
  const source = list.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(${source})\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,3})(?!\\d|\\.\\d)\\s*[.:)]*\\s*(.*)$`, 'iu');
}

function parseLabel(text: string, keyword: RegExp | undefined): Label | undefined {
  let found: RegExpExecArray | null;
  if (keyword !== undefined && (found = keyword.exec(text)) !== null) {
    const parts = (found[2] as string).split('.');
    const prefix = parts.slice(0, -1).join('.');
    return { style: 'keyword', family: `keyword:${(found[1] as string).toLowerCase()}:${prefix}`, n: Number(parts[parts.length - 1]), prefix, printed: `${found[1] as string} ${found[2] as string}`, keyword: found[1] as string };
  }
  if ((found = PARENS.exec(text)) !== null) return { style: 'parens', family: 'parens', n: Number(found[1]), prefix: '', printed: `(${found[1] as string})` };
  if ((found = DOTTED.exec(text)) !== null) {
    const parts = (found[1] as string).split('.');
    const prefix = parts.slice(0, -1).join('.');
    return { style: 'dotted', family: `dotted:${prefix}`, n: Number(parts[parts.length - 1]), prefix, printed: found[1] as string };
  }
  if ((found = DOT.exec(text)) !== null) return { style: 'dot', family: 'dot', n: Number(found[1]), prefix: '', printed: `${found[1] as string}.` };
  if ((found = PAREN.exec(text)) !== null) return { style: 'paren', family: 'paren', n: Number(found[1]), prefix: '', printed: `${found[1] as string})` };
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The lines of a page: units

/** A piece of a page that can start an item: a text line, one piece of a line that was joined from pieces side by side, or one cell of a row of items. */
interface Unit {
  text: string;
  rect: Rect;
  fontSize: number;
  /** Whether the line is set in bold; false when the pages were not read with their fonts. */
  bold: boolean;
  /** The text line of the page it comes from. */
  line: number;
  /** Its place in the reading order of its page. */
  order: number;
}

const CELL_START = /^\s*(\d{1,3})[.)](?:\s|$)/u;

/** The cells of a line that holds several printed item numbers one after the other (each number one to three further), or undefined. */
function cellsOf(cells: readonly LinePart[] | undefined): readonly LinePart[] | undefined {
  if (cells === undefined || cells.length < 2) return undefined;
  const numbers = cells.map((cell) => CELL_START.exec(cell.text)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  if (numbers.length === 0) return undefined;
  const rising = numbers.every((n, at) => at === 0 || (n > (numbers[at - 1] as number) && n - (numbers[at - 1] as number) <= 3));
  return rising ? cells : undefined;
}

function unitsOf(page: PageText, furniture: ReadonlySet<number>): Unit[] {
  const units: Unit[] = [];
  const push = (text: string, rect: Rect, line: TextLine, at: number): void => {
    const folded = foldText(text);
    if (folded === '') return;
    units.push({ text: folded, rect, fontSize: line.fontSize, bold: line.bold === true, line: at, order: units.length });
  };
  page.lines.forEach((line, at) => {
    if (furniture.has(at)) return;
    const cells = cellsOf(line.cells);
    if (cells !== undefined) {
      for (const cell of cells) push(cell.text, cell.rect, line, at);
      return;
    }
    if (line.parts !== undefined && line.parts.length >= 2) {
      for (const part of line.parts) {
        const inner = cellsOf(part.cells);
        if (inner !== undefined) for (const cell of inner) push(cell.text, cell.rect, line, at);
        else push(part.text, part.rect, line, at);
      }
      return;
    }
    push(line.text, line.rect, line, at);
  });
  return units;
}

/** The lines of a page that are running furniture (heads, page numbers, imprints), as the checks of whole pages read them. */
function furnitureOf(index: PageIndex, page: number): Set<number> {
  const lines = new Set<number>();
  for (const piece of index.page(page).pieces) if (piece.headerFooter) lines.add(piece.line);
  return lines;
}

function weightedMedian(weights: ReadonlyMap<number, number>): number {
  const sizes = [...weights.entries()].sort((a, b) => a[0] - b[0]);
  const total = sizes.reduce((sum, [, weight]) => sum + weight, 0);
  let seen = 0;
  for (const [size, weight] of sizes) {
    seen += weight;
    if (seen >= total / 2) return size;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Items

interface Cand {
  page: number;
  /** Where the item is in the book, in reading order: one number. */
  pos: number;
  label: Label;
  unit: Unit;
  rect: Rect;
  text: string;
  /**
   * The line reads like a line of a table of contents, a list of references or an index: it has leader dots, or ends in a page number after them or
   * in a list of page numbers, or has a bare number at the right of its row.
   */
  pageRef: boolean;
  /** The label and the first letters of the line, to tell the lines of a list of headings from the headings themselves. */
  key: string;
}

const LEADER_END = /(?:\.{3,}|(?:\.\s){3,}|…+|·{3,})\s*(?:\d{1,4}|[ivxlcdm]{1,6})\s*$/iu;
const LEADER_ANY = /(?:\.\s){3,}|\.{4,}|…{2,}|·{4,}/u;
/** An index entry: words, then a list of page numbers ("variance, 45, 67-69"); a list of numbers alone ("1. 0, 1, 3, 7") is an answer. */
const LIST_END = /\p{L}{3,}[^,]*,\s*\d{1,4}(?:\s*-\s*\d{1,4})?(?:\s*,\s*\d{1,4}(?:\s*-\s*\d{1,4})?)+\s*$/u;
const BARE_NUMBER = /^(?:\d{1,4}|[ivxlcdm]{1,6})$/iu;

/** What identifies the text of a heading when it is printed again as an item of a list: its label and its first letters and digits. */
function headingKey(label: Label, text: string): string {
  return `${label.printed.replace(/\.$/, '')}|${text.slice(label.printed.length).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 24)}`;
}

const sameRow = (a: Rect, b: Rect): boolean => {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const smaller = Math.min(a.bottom - a.top, b.bottom - b.top);
  return smaller > 0 && overlap / smaller >= 0.5;
};

/** The piece beside a unit on its row, to its right (the next units in reading order), or undefined. */
function neighbourRight(units: readonly Unit[], at: number): Unit | undefined {
  const unit = units[at] as Unit;
  for (let next = at + 1; next < Math.min(units.length, at + 4); next += 1) {
    const other = units[next] as Unit;
    if (other.rect.left >= unit.rect.right - 0.005 && sameRow(unit.rect, other.rect)) return other;
  }
  return undefined;
}

const pos = (page: number, order: number): number => page * 100000 + order;

/** Whether a numbered line is the heading of a section (a number and a title in a larger type, a dotted number in bold), which is no item. */
const isNumberedHeading = (label: Label, unit: Unit, body: number): boolean =>
  (label.style === 'dot' || label.style === 'dotted') && ((body > 0 && unit.fontSize >= RUN_LIMITS.headingSize * body && unit.text.length <= 100) || (label.style === 'dotted' && unit.bold && unit.text.length <= 70));

/** The items of a page; `headings` collects the keys of the numbered lines that were left out as headings (they are told apart from items by their size). */
function candidatesOf(page: number, units: readonly Unit[], body: number, keyword: RegExp | undefined, headings: Set<string>): Cand[] {
  const found: Cand[] = [];
  units.forEach((unit, at) => {
    let label = parseLabel(unit.text, keyword);
    let text = unit.text;
    let rect = unit.rect;
    let beside: Unit | undefined;
    if (label === undefined) {
      const only = LABEL_ONLY.exec(unit.text);
      beside = only === null ? undefined : neighbourRight(units, at);
      if (only === null || beside === undefined) return;
      label = parseLabel(`${unit.text} ${beside.text}`, keyword);
      if (label === undefined) return;
      text = `${unit.text} ${beside.text}`;
      rect = { left: unit.rect.left, top: Math.min(unit.rect.top, beside.rect.top), right: beside.rect.right, bottom: Math.max(unit.rect.bottom, beside.rect.bottom) };
    }
    // A heading is no item: "1.4 Exercises" set large, "3. Methods" as a chapter title.
    if (isNumberedHeading(label, unit, body)) {
      headings.add(headingKey(label, text));
      return;
    }
    // A bare number at the right margin of the row, far from the words, is the page number of a line of a table of contents.
    const right = beside === undefined ? neighbourRight(units, at) : undefined;
    const pageRef = LEADER_END.test(text) || LEADER_ANY.test(text) || LIST_END.test(text) || (right !== undefined && BARE_NUMBER.test(right.text) && right.rect.right >= 0.8 && right.rect.left >= unit.rect.right + 0.12);
    found.push({ page, pos: pos(page, unit.order), label, unit, rect, text, pageRef, key: headingKey(label, text) });
  });
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fragments, runs

interface Fragment {
  items: Cand[];
  /** 0 while it holds one item. */
  step: 0 | 1 | 2;
}

const lastOf = (items: readonly Cand[]): Cand => items[items.length - 1] as Cand;

/** Items of one family in reading order, cut into the stretches where each number follows the one before by the same step. */
function fragmentsOf(items: readonly Cand[]): Fragment[] {
  const fragments: Fragment[] = [];
  let open: Fragment[] = [];
  for (const item of items) {
    open = open.filter((fragment) => item.page - lastOf(fragment.items).page <= RUN_LIMITS.maxPagesApart);
    let best: Fragment | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestStep = 0;
    for (const fragment of open) {
      const last = lastOf(fragment.items);
      const d = item.label.n - last.label.n;
      const fits = fragment.step === 0 ? d === 1 || d === 2 : d === fragment.step;
      if (!fits) continue;
      // The nearest page first (a list that goes on from the page before is not one that ended two pages ago), on one page the column of the
      // item (left edges that agree: two lists side by side), then the nearest in reading order.
      const column = Math.abs(item.rect.left - last.rect.left) <= RUN_LIMITS.streamTolerance ? 0 : 1_000_000;
      const score = (item.page - last.page) * 10_000_000 + column + (item.pos - last.pos);
      if (score < bestScore) {
        best = fragment;
        bestScore = score;
        bestStep = d;
      }
    }
    if (best !== undefined) {
      best.items.push(item);
      if (best.step === 0) best.step = bestStep as 1 | 2;
    } else {
      const fragment: Fragment = { items: [item], step: 0 };
      fragments.push(fragment);
      open.push(fragment);
    }
  }
  return fragments;
}

/** Joins fragments whose numbers go on from each other and that lie near each other: the next column, the next page, one label that was dropped. */
function stitched(fragments: readonly Fragment[]): Cand[][] {
  // Every fragment can be joined, also one item that stands alone (the last item of a column that the reader gave before the column it goes on from).
  const usable = [...fragments].sort((a, b) => (a.items[0] as Cand).pos - (b.items[0] as Cand).pos);
  // The fragments that can come before one that starts on a page: the ones that are on it or end up to two pages before it.
  const near = new Map<number, Fragment[]>();
  for (const a of usable) {
    const head = (a.items[0] as Cand).page;
    for (let page = head; page <= lastOf(a.items).page + 2; page += 1) {
      const list = near.get(page);
      if (list) list.push(a);
      else near.set(page, [a]);
    }
  }
  const following = new Map<Fragment, Fragment>();
  const preceded = new Set<Fragment>();
  for (const b of usable) {
    const first = b.items[0] as Cand;
    let best: Fragment | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const a of near.get(first.page) ?? []) {
      if (a === b || following.has(a) || preceded.has(b)) continue;
      const head = a.items[0] as Cand;
      const last = lastOf(a.items);
      // B is near A (not on a page before A starts, not more than two pages after it ends). On one page B may stand before A in reading order: a page
      // of two columns whose gutter the reader did not find gives the column on the right, up at the top, before the column on the left, further down.
      if (first.page < head.page || first.page > last.page + 2) continue;
      if (a.step !== b.step && a.step !== 0 && b.step !== 0) continue;
      const step = a.step || b.step || 1;
      const d = first.label.n - last.label.n;
      if (d !== 0 && d !== step && d !== 2 * step) continue;
      if (d === 0 && first.pos <= head.pos) continue;
      const distance = Math.abs(first.pos - last.pos);
      if (distance < bestDistance) {
        best = a;
        bestDistance = distance;
      }
    }
    if (best !== undefined) {
      following.set(best, b);
      preceded.add(b);
    }
  }
  const chains: Cand[][] = [];
  for (const start of usable) {
    if (preceded.has(start)) continue;
    const items: Cand[] = [];
    for (let fragment: Fragment | undefined = start; fragment !== undefined; fragment = following.get(fragment)) items.push(...fragment.items);
    chains.push(items);
  }
  return chains;
}

interface Stretch {
  items: Cand[];
  missing: number;
  step: 1 | 2;
}

/** The most labels one run may lack: one in ten of its span, at least one. */
const allowance = (span: number): number => Math.max(1, Math.ceil(span / RUN_LIMITS.missingPer));

/**
 * A chain cut into runs: where a number does not go on from the one before (more than one label missing at once, more missing than one in
 * ten allows, a step that changes) a new run starts. A number that repeats is left out.
 */
function segments(chain: readonly Cand[]): Stretch[] {
  if (chain.length === 0) return [];
  const diffs = chain.slice(1).map((item, at) => item.label.n - (chain[at] as Cand).label.n).filter((d) => d > 0);
  const twos = diffs.filter((d) => d === 2 || d === 4).length;
  const step: 1 | 2 = diffs.length > 0 && twos >= 0.7 * diffs.length ? 2 : 1;
  const stretches: Stretch[] = [];
  let current: Stretch = { items: [chain[0] as Cand], missing: 0, step };
  for (const item of chain.slice(1)) {
    const last = lastOf(current.items);
    const d = item.label.n - last.label.n;
    if (d === 0) continue;
    const gaps = d > 0 && d % step === 0 ? d / step - 1 : Number.POSITIVE_INFINITY;
    if (gaps <= 1 && current.missing + gaps <= allowance(current.items.length + current.missing + gaps)) {
      current.items.push(item);
      current.missing += gaps;
    } else {
      stretches.push(current);
      current = { items: [item], missing: 0, step };
    }
  }
  stretches.push(current);
  return stretches;
}

// ---------------------------------------------------------------------------------------------------------------------
// The census

const clip = (text: string, length: number): string => excerpt(text, length).trimEnd();

/**
 * The line above the first item that says what the items are, only reported: the nearest line that is no item and is set larger or bolder than
 * the text, else the nearest that is short. On the page of the item the lines above it in its own column come first, the nearest first (the page
 * reader may give the lines of two columns row by row, so the reading order says nothing there); then the lines of the two pages before, from
 * the foot of the page up, as far back as sixty lines in all. No word decides anything.
 */
function headingAbove(first: Cand, unitsOf: (page: number) => readonly Unit[], body: number, keyword: RegExp | undefined): string | undefined {
  let short: string | undefined;
  let looked = 0;
  for (let page = first.page; page >= Math.max(0, first.page - 2); page -= 1) {
    const units = unitsOf(page);
    // In the column of the item: not below it, not ending before it starts (another column to the left), not starting far to its right (another column).
    const ordered =
      page === first.page
        ? units.filter((unit) => unit.rect.bottom <= first.rect.top + 0.005 && unit.rect.right > first.rect.left && unit.rect.left <= first.rect.left + RUN_LIMITS.headingColumn).sort((a, b) => b.rect.bottom - a.rect.bottom || b.order - a.order)
        : [...units].reverse();
    for (const unit of ordered) {
      if (looked >= 60) break;
      looked += 1;
      if (!/\p{L}{3}/u.test(unit.text)) continue;
      const label = parseLabel(unit.text, keyword);
      if (label !== undefined && !isNumberedHeading(label, unit, body)) continue;
      if (unit.bold || (body > 0 && unit.fontSize >= 1.1 * body)) return clip(unit.text, RUN_LIMITS.headingLength);
      if (short === undefined && unit.text.length <= RUN_LIMITS.shortLine) short = clip(unit.text, RUN_LIMITS.headingLength);
    }
  }
  return short;
}

/**
 * The id of a run goes on the command line (`audit ack --ref ID`), so it has no character that a shell takes for syntax: a closing or an opening
 * bracket becomes a word (`8)` is `8_paren`, `(8)` is `8_parens`) and the space of a keyword label an underscore (`Exercise_4.2`).
 */
function idOf(first: Cand): string {
  const { label } = first;
  const text =
    label.style === 'keyword'
      ? `${label.keyword as string}_${label.printed.replace(/^\S+\s+/, '')}`
      : label.style === 'paren'
        ? `${label.n}_paren`
        : label.style === 'parens'
          ? `${label.n}_parens`
          : label.printed.replace(/\.$/, '');
  return `p${first.page}:${text}`;
}

/** Finds every run of numbered items in the text of a book; see the module comment. The runs come in reading order. */
export function findNumberedRuns(pages: RunPages, options: RunOptions = {}): NumberedRun[] {
  return surveyNumberedRuns(pages, options).runs;
}

/**
 * The runs of a book and the candidates that were left out, each with its reason: nothing the census sets aside is silent. A candidate is five
 * or more numbered items one after the other that are no list of exercises, answers or the like: a table of contents, an index, a list of years,
 * a running head, items of one or two characters, a list of headings printed again.
 */
export function surveyNumberedRuns(pages: RunPages, options: RunOptions = {}): { runs: NumberedRun[]; leftOut: LeftOutRun[] } {
  const minRun = Math.max(2, Math.floor(options.minRun ?? RUN_LIMITS.minRun));
  const pageCount = typeof pages === 'function' ? (options.pageCount ?? 0) : pages.length;
  const lookup = typeof pages === 'function' ? pages : (page: number): PageText | undefined => pages[page];
  const index = new PageIndex(lookup);
  const keyword = keywordPattern(options.keywords ?? DEFAULT_RUN_KEYWORDS);

  // The lines of every page, and the usual size of type in the book.
  const unitsByPage: Unit[][] = [];
  const sizes = new Map<number, number>();
  let withText = 0;
  let withFonts = 0;
  for (let page = 0; page < pageCount; page += 1) {
    const text = lookup(page);
    const units = text === undefined || !text.hasText ? [] : unitsOf(text, furnitureOf(index, page));
    unitsByPage.push(units);
    if (text !== undefined && text.hasText) {
      withText += 1;
      if (text.lines.some((line) => line.bold !== undefined)) withFonts += 1;
    }
    for (const unit of units) {
      const size = Math.round(unit.fontSize * 2) / 2;
      sizes.set(size, (sizes.get(size) ?? 0) + unit.text.length);
    }
  }
  // Bold is read only when every page of the book was read with its fonts (the gate reads a page with them only where it needs them, and the
  // report must not depend on which pages those were).
  if (withFonts < withText) for (const units of unitsByPage) for (const unit of units) unit.bold = false;
  const body = weightedMedian(sizes);
  const unitsAt = (page: number): readonly Unit[] => unitsByPage[page] ?? [];

  // The items, by family.
  const families = new Map<string, Cand[]>();
  const headings = new Set<string>();
  unitsByPage.forEach((units, page) => {
    for (const cand of candidatesOf(page, units, body, keyword, headings)) {
      const list = families.get(cand.label.family);
      if (list) list.push(cand);
      else families.set(cand.label.family, [cand]);
    }
  });

  const found: { run: NumberedRun; first: Cand }[] = [];
  const out: { left: LeftOutRun; first: Cand }[] = [];
  for (const items of families.values()) {
    for (const chain of stitched(fragmentsOf(items))) {
      for (const stretch of segments(chain)) {
        if (stretch.items.length < minRun) continue;
        const judged = judgeRun(stretch, options, unitsAt, body, keyword, headings);
        if ('left' in judged) out.push({ left: judged.left, first: stretch.items[0] as Cand });
        else found.push({ run: judged, first: stretch.items[0] as Cand });
      }
    }
  }
  found.sort((a, b) => a.first.pos - b.first.pos);
  out.sort((a, b) => a.first.pos - b.first.pos);
  const named = (id: string, used: Map<string, number>): string => {
    const seen = (used.get(id) ?? 0) + 1;
    used.set(id, seen);
    return seen === 1 ? id : `${id}#${seen}`;
  };
  const usedRuns = new Map<string, number>();
  const usedOut = new Map<string, number>();
  return {
    runs: found.map(({ run }) => ({ ...run, id: named(run.id, usedRuns) })),
    leftOut: out.map(({ left }) => ({ ...left, id: named(left.id, usedOut) })),
  };
}

/** The share of the items of a candidate (0 to 1) for which a test holds. */
const share = (items: readonly Cand[], test: (item: Cand) => boolean): number => items.filter(test).length / items.length;

/** A run from its items, or the reason why what it is made of is no list of numbered items. */
function judgeRun(stretch: Stretch, options: RunOptions, unitsAt: (page: number) => readonly Unit[], body: number, keyword: RegExp | undefined, headings: ReadonlySet<string>): NumberedRun | { left: LeftOutRun } {
  const items = stretch.items;
  const first = items[0] as Cand;
  const last = lastOf(items);
  const regions = options.regions;
  const insideRegions = (item: Cand): boolean => regions !== undefined && coveredShare(item.rect, regions(item.page)) >= VERIFY_LIMITS.coveredShare;
  const left = (reason: LeftOutReason): { left: LeftOutRun } => ({ left: { id: idOf(first), firstPage: first.page, lastPage: last.page, first: first.label.printed, last: last.label.printed, count: items.length, reason, coverage: share(items, insideRegions) } });
  if (items.every((item) => item.label.n >= RUN_LIMITS.yearFrom && item.label.n <= RUN_LIMITS.yearTo)) return left('years');
  if (share(items, (item) => item.pageRef) >= RUN_LIMITS.pageNumberShare) return left('contents');
  // A running head that changes with the page: a line in the top or bottom band, about one to a page (footnotes of one page, or an answer list at the
  // foot of one page, are no running head).
  const band = RUN_LIMITS.furnitureBand;
  const pagesOfItems = new Set(items.map((item) => item.page)).size;
  if (share(items, (item) => item.rect.bottom <= band || item.rect.top >= 1 - band) >= RUN_LIMITS.furnitureShare && pagesOfItems >= 3 && items.length <= RUN_LIMITS.furnitureItemsPerPage * pagesOfItems) return left('running-head');
  // What follows the label of an item in its line: fewer than ten items of one or two characters are matrix entries, table cells, a column of values;
  // ten or more are more likely an answer key (the answers of a test of single letters or digits).
  const wording = (item: Cand): number => item.text.replace(item.label.printed, '').replace(/^[\s.:)]+/, '').length;
  // (A keyword label is explicit: "Aufgabe 1.3" alone on its line, the statement below it, is an item.)
  if (first.label.style !== 'keyword' && items.length < RUN_LIMITS.shortItemsKeyAt && items.every((item) => wording(item) <= RUN_LIMITS.shortItemLength)) return left('short-items');
  // The numbered lines are the headings of the book printed again (the outline of a chapter before its sections).
  if (first.label.style !== 'keyword' && share(items, (item) => headings.has(item.key)) >= RUN_LIMITS.headingsShare) return left('headings');

  const runItems: RunItem[] = items.map((item) => ({
    page: item.page,
    rect: item.rect,
    label: item.label.printed,
    n: item.label.n,
    text: clip(item.text, 60),
    covered: insideRegions(item),
  }));
  const coverage = runItems.filter((item) => item.covered).length / runItems.length;
  const heading = headingAbove(first, unitsAt, body, keyword);
  const odd = first.label.n % 2 === 1;
  return {
    id: idOf(first),
    pages: [...new Set(items.map((item) => item.page))].sort((a, b) => a - b),
    firstPage: first.page,
    lastPage: last.page,
    first: first.label.printed,
    last: last.label.printed,
    count: items.length,
    missing: stretch.missing,
    scheme: SCHEME[first.label.style],
    step: stretch.step,
    ...(stretch.step === 2 ? { parity: odd ? ('odd' as const) : ('even' as const) } : {}),
    ...(first.label.keyword !== undefined ? { keyword: first.label.keyword } : {}),
    ...(heading !== undefined ? { heading } : {}),
    start: clip(first.text, 60),
    firstItem: { page: first.page, rect: first.rect },
    lastItem: { page: last.page, rect: last.rect },
    coverage,
    covered: coverage >= RUN_LIMITS.covered,
    items: runItems,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The census as a report

export const CENSUS_FORMAT = 'math-canvas-census';
export const CENSUS_VERSION = 1;

export interface CensusSummary {
  runs: number;
  /** Items in all runs. */
  items: number;
  /** Pages that hold an item of some run. */
  pagesWithRuns: number;
  /** Runs that the project covers (at least 80 percent of their items lie inside a region). */
  covered: number;
  uncovered: number;
  /** Items outside every region, in all runs. */
  itemsOutside: number;
  /** Candidates of five or more numbered items that were set aside (a table of contents, an index, the steps of a proof ...): `leftOut` of the report lists them with the reason. */
  leftOut: number;
}

/** What `mcprep exercises census` reports: every run of numbered items in the book, and whether the project covers it. */
export interface CensusReport {
  format: typeof CENSUS_FORMAT;
  version: typeof CENSUS_VERSION;
  /** The pages of the book. */
  pages: number;
  minRun: number;
  summary: CensusSummary;
  /** In reading order. */
  runs: NumberedRun[];
  /** The candidates that were left out, each with its reason, in reading order: nothing that the census sets aside is silent. */
  leftOut: LeftOutRun[];
}

export function censusOf(project: Project, pages: RunPages, options: { minRun?: number; keywords?: readonly string[] } = {}): CensusReport {
  const minRun = Math.max(2, Math.floor(options.minRun ?? RUN_LIMITS.minRun));
  const { runs, leftOut } = surveyNumberedRuns(pages, { minRun, regions: regionsByPage(project), pageCount: project.pdf.pageCount, ...(options.keywords !== undefined ? { keywords: options.keywords } : {}) });
  return {
    format: CENSUS_FORMAT,
    version: CENSUS_VERSION,
    pages: project.pdf.pageCount,
    minRun,
    summary: {
      runs: runs.length,
      items: runs.reduce((sum, run) => sum + run.count, 0),
      pagesWithRuns: new Set(runs.flatMap((run) => run.pages)).size,
      covered: runs.filter((run) => run.covered).length,
      uncovered: runs.filter((run) => !run.covered).length,
      itemsOutside: runs.reduce((sum, run) => sum + run.items.filter((item) => !item.covered).length, 0),
      leftOut: leftOut.length,
    },
    runs,
    leftOut,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The finding

/** The regions of a project that cover text on each page: every frame's own region, its continuations, its instructions and its answers. */
export function regionsByPage(project: Project): (page: number) => readonly { rect: Rect }[] {
  const byPage = new Map<number, { rect: Rect }[]>();
  const add = (page: number, rect: Rect): void => {
    const list = byPage.get(page);
    if (list) list.push({ rect });
    else byPage.set(page, [{ rect }]);
  };
  for (const frame of project.frames) {
    add(frame.page, frame.rect);
    for (const region of frame.continues ?? []) add(region.page, region.rect);
    for (const region of frame.context ?? []) add(region.page, region.rect);
    for (const region of frame.solution ?? []) add(region.page, region.rect);
  }
  return (page) => byPage.get(page) ?? [];
}

const pagesText = (run: NumberedRun, from: number, to: number): string => (from === to ? `Page ${from}` : `Pages ${from}-${to}`);

/** Whether the label ranges read as one line: `8. to 21.`. */
const span = (run: NumberedRun): string => (run.first === run.last ? run.first : `${run.first} to ${run.last}`);

/** The findings of the census: a warning for each run that most of the project's regions leave out. */
export function checkNumberedRuns(project: Project, pages: RunPages): Draft[] {
  const { runs } = surveyNumberedRuns(pages, { regions: regionsByPage(project), pageCount: project.pdf.pageCount });
  // A project that covers few runs has little audited yet: every run counts. One that covers several is judged on the substantial ones.
  const threshold = runs.filter((run) => run.covered).length >= RUN_LIMITS.auditedRuns ? RUN_LIMITS.auditedMinRun : RUN_LIMITS.minRun;
  const drafts: Draft[] = [];
  for (const run of runs) {
    if (run.covered || run.count < threshold) continue;
    const outside = run.items.filter((item) => !item.covered);
    const firstOutside = outside[0] as RunItem;
    const lastOutside = outside[outside.length - 1] as RunItem;
    const where = pagesText(run, outside[0]?.page ?? run.firstPage, lastOutside.page);
    const what =
      outside.length === run.count
        ? `${run.count} numbered items (${span(run)})`
        : `${outside.length} of the ${run.count} numbered items of the run ${span(run)} (from ${firstOutside.label} on)`;
    const above = run.heading !== undefined ? `the line above them reads '${run.heading}'` : 'no heading line stands above them';
    drafts.push({
      ...draft(
        'numbered-run-uncovered',
        'warning',
        run.id,
        firstOutside.page,
        `${where}: ${what} lie outside every exercise, context and answer region; ${above}. If they are exercises, frame them; if the book prints another kind of list there (a bibliography, steps of a method), acknowledge it with the page and a quote.`,
        clip(run.start, VERIFY_LIMITS.evidenceLength).trimEnd(),
        { section: 1_600_000, page: firstOutside.page, top: firstOutside.rect.top, left: firstOutside.rect.left },
      ),
      weight: outside.length,
    });
  }
  return drafts;
}
