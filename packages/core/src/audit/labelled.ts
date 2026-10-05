import { bodyFontSize } from '../propose/exercises.js';
import type { InkMap, PageText, Rect, Region, TextLine } from '../model/types.js';
import { MAX_CONTINUATIONS, contentLimit, describeSpan, lowestInk, spanNote } from './layout.js';
import type { ExerciseProposal, InstructionFound, SectionExercises } from './exercises.js';
import { DEFAULT_BOOK_PATTERNS, TOP_MARGIN, hasLeader, isPageNumber, isRunningLine, type BookPatterns } from './scan.js';
import type { BookEntry } from './sections.js';
import type { SectionSolutions, SolutionProposal } from './solutions.js';

/**
 * Exercises that are printed inside the text of a lesson, each one a block of its own, and answers that are entries of an answer
 * chapter, each one starting with a line of its own. There is no set of numbered items to read, only anchors:
 *
 *  - an exercise starts with a line like "1.2.3 Aufgabe: ..." (a number of two or three levels, one of the item words, a colon or
 *    a full stop) and ends at a link word that stands alone at the right margin ("Lösung", "Solution"), or above the next
 *    numbered line or heading; it may run over page breaks;
 *  - an answer starts with a line like "Lösung 1.2.3" (an answer word, then the number of the exercise) and ends at a link back
 *    that stands alone at the right margin ("zurück", "back"), or above the next answer or heading.
 *
 * The lines of a page are read by position (top first, then left): where the text layer finds two columns for a wide formula, its
 * list order is not the reading order. The number of an exercise belongs to the section whose label is its first two numbers;
 * when there is none, to the nearest section whose label is a start of it, else to the section the page lies in.
 */

/** One line of text that starts an exercise or an answer. */
export interface LabelledHit {
  page: number;
  /** The place of the line among the lines of its page in reading order. */
  index: number;
  line: TextLine;
  /** The number as printed: "1.2.3". */
  label: string;
  /** The word that came with it ("Aufgabe", "Lösung"). */
  word: string;
  /** How the line starts: with the number first ("1.2.3 Aufgabe: ...") or with the word first ("Aufgabe 1.2 (Title). ..."). */
  form: LabelledForm;
}

export type LabelledForm = 'number-first' | 'keyword-first';

/** How many such anchors a book needs before they are read as a layout of its own. */
export const MIN_LABELLED = 3;

/** A page whose text or ink reaches below this share of its height is filled: what is printed on the next page may go on from it. */
const PAGE_FILLED = 0.8;

/**
 * Whether the chapters numbered `numbers` are the sections of a book whose exercises print their number under the chapter's
 * ("Aufgabe 1.3 (Title)." belongs to chapter 1, and no section is numbered): there are at least `MIN_LABELLED` such exercises and
 * most of them name a chapter that is there.
 */
export function chaptersHoldingItems(numbers: readonly string[], pages: readonly PageText[], patterns: BookPatterns = DEFAULT_BOOK_PATTERNS): boolean {
  const hits = findLabelledItems(pages, patterns);
  if (hits.length < MIN_LABELLED) return false;
  const known = new Set(numbers);
  return hits.filter((hit) => known.has(hit.label.split('.')[0] as string)).length >= 0.6 * hits.length;
}

/** The shape of the anchor, to show in a note: "1.2.3 Aufgabe:" or "Aufgabe 1.2 (...)." */
export const anchorExample = (hit: { label: string; word: string; form: LabelledForm }): string => (hit.form === 'keyword-first' ? `${hit.word} ${hit.label} (...).` : `${hit.label} ${hit.word}:`);

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternatives = (words: readonly string[]): string => words.map((word) => word.trim().split(/\s+/).map(escapeWord).join('\\s+')).join('|');

/** The words of a list and their singular forms: "exercises", "aufgaben", "lösungen" give also "exercise", "aufgabe", "lösung". */
export function withSingulars(words: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of words) {
    const word = raw.trim().toLowerCase();
    if (word.length === 0) continue;
    found.add(word);
    if (/\s/.test(word)) continue;
    if (word.length > 4 && word.endsWith('ies')) found.add(`${word.slice(0, -3)}y`);
    if (word.length > 4 && word.endsWith('s')) found.add(word.slice(0, -1));
    if (word.length > 5 && word.endsWith('en')) {
      found.add(word.slice(0, -1));
      found.add(word.slice(0, -2));
    }
  }
  return [...found];
}

interface Compiled {
  item: RegExp;
  /** The word first: "Aufgabe 1.3 (Title). ...", "Exercise 2.4: ..." (the number is followed by a bracket, a colon, a full stop or a dash). */
  itemKeyword: RegExp;
  answer: RegExp;
  numbered: RegExp;
  context: RegExp;
  links: Set<string>;
  backs: Set<string>;
}

const compiled = new WeakMap<BookPatterns, Compiled>();

function compile(patterns: BookPatterns): Compiled {
  const known = compiled.get(patterns);
  if (known) return known;
  const itemWords = withSingulars(patterns.itemWords);
  const answerWords = withSingulars(patterns.answerWords).filter((word) => !/\s/.test(word));
  const result: Compiled = {
    item: new RegExp(`^(\\d{1,3}(?:\\.\\d{1,3}){1,3})\\s+(${alternatives(itemWords)})\\s*[:.]`, 'iu'),
    itemKeyword: new RegExp(`^(${alternatives(itemWords)})\\s+(\\d{1,3}(?:\\.\\d{1,3}){1,3})(?!\\.?\\d)(?=\\s*(?:[.:(–—]|-\\s|$))`, 'iu'),
    answer: new RegExp(`^(${alternatives(answerWords)})\\s+(\\d{1,3}(?:\\.\\d{1,3}){1,3})\\s*$`, 'iu'),
    // Another numbered item or a numbered heading ("1.1.1 Hinweis: ...", "1.2 Folgen"): a number of two or three levels and a capital.
    numbered: /^\d{1,3}(?:\.\d{1,3}){1,2}\.?\s+\p{Lu}/u,
    // "For the following exercises ...": a paragraph that holds for the exercises below it.
    context: /^(?:für|for|in|zu|bei)\s+(?:die\s+|den\s+|the\s+)?(?:folgenden|nächsten|following|next)\s+\p{L}+/iu,
    links: new Set(answerWords),
    backs: new Set(patterns.backWords.map((word) => word.trim().toLowerCase())),
  };
  compiled.set(patterns, result);
  return result;
}

const textOf = (line: TextLine): string => line.text.replace(/\s+/g, ' ').trim();

/** The lines of a page in reading order. */
const ordered = new WeakMap<PageText, TextLine[]>();
function linesOf(page: PageText): TextLine[] {
  let lines = ordered.get(page);
  if (!lines) {
    lines = [...page.lines].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    ordered.set(page, lines);
  }
  return lines;
}

/** Running heads, page numbers and anything in the top band of a page: never part of an exercise or an answer. */
const furniture = (line: TextLine): boolean => isRunningLine(line) || line.rect.top < 0.105 || (line.rect.top > 0.84 && /^\d{1,4}$/.test(textOf(line)));

/**
 * The same for an exercise that starts with its word: an exercise booklet starts its text right under the running head, so no band
 * at the top is set aside; what is furniture is what the reader or the row rule flagged as running (see `withRunningHeads`), the
 * margin above the text and a bare number at the foot of the page.
 */
const wordFirstFurniture = (line: TextLine, page?: PageText): boolean =>
  isRunningLine(line) || line.rect.bottom <= TOP_MARGIN || (line.rect.top > 0.84 && /^\d{1,4}$/.test(textOf(line))) || (page !== undefined && isPageNumber(line, page.lines));

const compareLabels = (a: string, b: string): number => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let k = 0; k < Math.max(left.length, right.length); k += 1) {
    const difference = (left[k] ?? -1) - (right[k] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
};

function scan(pages: readonly PageText[], pattern: RegExp, labelOf: (match: RegExpExecArray) => string, wordOf: (match: RegExpExecArray) => string, form: LabelledForm, leaders = false): LabelledHit[] {
  const hits: LabelledHit[] = [];
  pages.forEach((page, p) => {
    if (!page.hasText) return;
    linesOf(page).forEach((line, index) => {
      const text = textOf(line);
      const match = pattern.exec(text);
      if (!match) return;
      // A line of the printed contents ("Aufgabe 1.1 (Zahlen) ........ 5") lists an exercise, it is none.
      if (leaders && hasLeader(text)) return;
      // The word first, a line that is not in the margin of the page: the band of the running heads at the top is no place for a
      // number-first anchor, but an exercise that stands right under the head (the first line of its page) may start there.
      if (form === 'keyword-first' ? isRunningLine(line) || line.rect.bottom <= TOP_MARGIN : furniture(line)) return;
      hits.push({ page: p, index, line, label: labelOf(match), word: wordOf(match), form });
    });
  });
  return hits;
}

/**
 * The lines that start an exercise printed inside the text, in the order of the book: "1.2.3 Aufgabe: ..." (the number first) and
 * "Aufgabe 1.2 (Title). ..." (the word first, as an exercise booklet prints them), never a line of the printed contents.
 */
export function findLabelledItems(pages: readonly PageText[], patterns: BookPatterns = DEFAULT_BOOK_PATTERNS): LabelledHit[] {
  const rules = compile(patterns);
  const hits = [
    ...scan(pages, rules.item, (match) => match[1] as string, (match) => match[2] as string, 'number-first', true),
    ...scan(pages, rules.itemKeyword, (match) => match[2] as string, (match) => match[1] as string, 'keyword-first', true),
  ];
  return hits.sort((a, b) => a.page - b.page || a.index - b.index);
}

/** The lines that start an answer of an answer chapter ("Lösung 1.2.3"), in the order of the book. */
export function findLabelledAnswers(pages: readonly PageText[], patterns: BookPatterns = DEFAULT_BOOK_PATTERNS): LabelledHit[] {
  return scan(pages, compile(patterns).answer, (match) => match[2] as string, (match) => match[1] as string, 'keyword-first');
}

/**
 * The patterns by which a text check reads the number of these exercises and answers ("1.2.3 Aufgabe", "Lösung 1.2.3"): group 1
 * is the number. Used by `exercises verify` next to the plain numbers, so that the region of an answer that starts with the word
 * before its number counts as starting with it.
 */
export function labelledItemPatterns(patterns: BookPatterns = DEFAULT_BOOK_PATTERNS): RegExp[] {
  const items = alternatives(withSingulars(patterns.itemWords));
  const answers = alternatives(withSingulars(patterns.answerWords).filter((word) => !/\s/.test(word)));
  return [
    new RegExp(`^(\\d{1,3}(?:\\.\\d{1,3}){1,3})\\s+(?:${items})\\b`, 'iu'),
    new RegExp(`^(?:${items})\\s+(\\d{1,3}(?:\\.\\d{1,3}){1,3})(?!\\.?\\d)(?=\\s*(?:[.:(–—]|-\\s|$))`, 'iu'),
    new RegExp(`^(?:${answers})\\s+(\\d{1,3}(?:\\.\\d{1,3}){1,3})\\b`, 'iu'),
  ];
}

/** The pages whose ink is needed to frame the exercises and answers: the page of each anchor and the two after it. */
export function labelledPages(hits: readonly LabelledHit[], pageCount: number): number[] {
  const pages = new Set<number>();
  for (const hit of hits) for (let page = hit.page; page <= Math.min(pageCount - 1, hit.page + 2); page += 1) pages.add(page);
  return [...pages].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------------
// Walking from a line to its end

type Verdict = 'include-end' | 'end-before' | undefined;

interface Part {
  page: number;
  lines: TextLine[];
  /** The top of the line that ended the walk on this page (the region stops above it). */
  nextTop?: number;
  /** The walk ended at the end of this page, which holds nothing more of the exercise (the region reaches to the last ink). */
  toPageEnd?: boolean;
  /** The exercise starts with its word: a figure or a table drawn without text belongs to the region as far as the next line or the end of the page. */
  wordFirst?: boolean;
  /** The text block of the book (its left and right edges): a figure or a field drawn without text is as wide as that, at most. */
  block?: { left: number; right: number };
}

interface WalkOptions {
  /** Whether the exercise goes on at the top of the next page: asked after a page without an end (default: it does). */
  holdsOn?: (page: PageText) => boolean;
  wordFirst?: boolean;
  block?: { left: number; right: number };
}

interface Walked {
  parts: Part[];
  ended: boolean;
}

/**
 * The lines from a start line to the line that ends the walk, over page breaks (at most nine pages). The lines that stand
 * across the top and bottom of what was taken (the sign of a root, a limit under a sum: the text layer lists them before or after
 * the line they belong to) are taken whole.
 */
function walk(pages: readonly PageText[], startPage: number, startIndex: number, stopOf: (line: TextLine) => Verdict, options: WalkOptions = {}): Walked {
  const isFurniture = (line: TextLine, page: PageText): boolean => (options.wordFirst === true ? wordFirstFurniture(line, page) : furniture(line));
  const parts: Part[] = [];
  for (let p = startPage; p < pages.length && parts.length < MAX_CONTINUATIONS + 1; p += 1) {
    const page = pages[p] as PageText;
    const lines = linesOf(page);
    const taken: TextLine[] = [];
    let ended = false;
    let nextTop: number | undefined;
    for (let i = p === startPage ? startIndex : 0; i < lines.length; i += 1) {
      const line = lines[i] as TextLine;
      if (isFurniture(line, page) && !(p === startPage && i === startIndex)) continue;
      if (!(p === startPage && i === startIndex)) {
        const verdict = stopOf(line);
        if (verdict === 'include-end') {
          taken.push(line);
          ended = true;
          const after = lines.slice(i + 1).find((other) => !isFurniture(other, page) && other.rect.top >= line.rect.bottom - 0.002);
          if (after) nextTop = after.rect.top;
          break;
        }
        if (verdict === 'end-before') {
          ended = true;
          nextTop = line.rect.top;
          break;
        }
      }
      taken.push(line);
    }
    if (taken.length > 0) {
      const first = Math.min(...taken.map((line) => line.rect.top));
      const last = Math.max(...taken.map((line) => line.rect.bottom));
      for (const line of lines) {
        if (taken.includes(line) || isFurniture(line, page)) continue;
        const centre = (line.rect.top + line.rect.bottom) / 2;
        if (centre >= first && centre <= last && !(nextTop !== undefined && line.rect.top >= nextTop - 0.001)) taken.push(line);
      }
      parts.push({ page: p, lines: taken, ...(nextTop !== undefined ? { nextTop } : {}), ...(options.wordFirst === true ? { wordFirst: true } : {}), ...(options.block ? { block: options.block } : {}) });
    }
    if (ended) return { parts, ended: true };
    // A page whose content stops short of its end holds the whole exercise: the next page starts another thing.
    if (options.holdsOn && !options.holdsOn(page)) {
      const last = parts[parts.length - 1];
      if (last && last.page === p) last.toPageEnd = true;
      return { parts, ended: true };
    }
  }
  return { parts, ended: false };
}

const round = (value: number): number => Math.round(value * 10000) / 10000;
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

function dark(map: InkMap, y: number, left: number, right: number): number {
  const row = Math.min(map.height - 1, Math.max(0, Math.floor(y * map.height)));
  const stride = Math.ceil(map.width / 8);
  const first = Math.max(0, Math.floor(left * map.width));
  const last = Math.min(map.width - 1, Math.ceil(right * map.width));
  let count = 0;
  for (let x = first; x <= last; x += 1) if (((map.bits[row * stride + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0) count += 1;
  return count;
}

/** From y, the nearest row in the direction (-1 up, 1 down) that holds no ink, at most `reach` of the page away. */
function whiteRow(map: InkMap, y: number, left: number, right: number, direction: -1 | 1, reach: number): number | undefined {
  const step = 1 / map.height;
  for (let moved = 0; moved <= reach; moved += step) {
    const at = y + direction * moved;
    if (at <= 0 || at >= 1) return undefined;
    if (dark(map, at, left, right) === 0) return at;
  }
  return undefined;
}

/** How much of an edge may be dark before the edge cuts something (the share `exercises verify --ink` takes). */
const EDGE_INK = 0.02;

/** The share of the rows between `from` and `to` in which the pixel of column `x` (and, with `beside`, one on each side of it) is dark. */
function darkAlong(map: InkMap, x: number, from: number, to: number, beside = true): number {
  const column = Math.min(map.width - 1, Math.max(0, Math.round(x * map.width)));
  const stride = Math.ceil(map.width / 8);
  const first = Math.max(0, Math.floor(from * map.height));
  const last = Math.min(map.height - 1, Math.ceil(to * map.height));
  if (last < first) return 0;
  let count = 0;
  const reach = beside ? 1 : 0;
  for (let y = first; y <= last; y += 1) {
    for (let side = -reach; side <= reach; side += 1) {
      const at = column + side;
      if (at < 0 || at >= map.width) continue;
      if (((map.bits[y * stride + (at >> 3)] ?? 0) & (0x80 >> (at & 7))) !== 0) {
        count += 1;
        break;
      }
    }
  }
  return count / (last - first + 1);
}

/** A column is a stem of a border when this share of the rows of a line is dark in it. */
const STEM = 0.9;

/**
 * The box that is drawn around the line between `from` and `to` (the first line of an exercise): a dark stem within reach of each
 * side of the region (the left and the right border of the box) and the rows where both end (its top and bottom border). The region
 * holds the whole box, border included. Undefined when no stem stands near both sides: a lone rule is no box.
 */
function boxAround(map: InkMap, left: number, right: number, from: number, to: number): Rect | undefined {
  const step = 1 / map.width;
  const stems = (centre: number): number[] => {
    const found: number[] = [];
    for (let x = Math.max(step, centre - 0.03); x <= Math.min(1 - step, centre + 0.03); x += step) if (darkAlong(map, x, from, to, false) >= STEM) found.push(x);
    return found;
  };
  const near = (list: number[], edge: number): number[] => list.filter((x) => Math.abs(x - edge) <= 0.03);
  const l = near(stems(left), left);
  const r = near(stems(right), right);
  if (l.length === 0 || r.length === 0) return undefined;
  // Along a border, up and down, as far as it is dark (at most a tenth of the page).
  const follow = (x: number, direction: -1 | 1): number => {
    let y = direction < 0 ? from : to;
    const stride = Math.ceil(map.width / 8);
    const column = Math.round(x * map.width);
    const row = (at: number): number => Math.min(map.height - 1, Math.max(0, Math.floor(at * map.height)));
    const isDark = (at: number): boolean => {
      for (let side = -1; side <= 1; side += 1) {
        const c = column + side;
        if (c >= 0 && c < map.width && ((map.bits[row(at) * stride + (c >> 3)] ?? 0) & (0x80 >> (c & 7))) !== 0) return true;
      }
      return false;
    };
    for (let moved = 0; moved < 0.1 && y > 0 && y < 1 && isDark(y + direction / map.height); moved += 1 / map.height) y += direction / map.height;
    return y;
  };
  // A border drawn in a hairline or anti-aliased has columns that are too light to count as dark here: a few pixels of white beyond it.
  const margin = 4 * step;
  return {
    left: Math.min(...l) - margin,
    right: Math.max(...r) + margin,
    top: Math.min(follow(l[0] as number, -1), follow(r[0] as number, -1)) - 4 / map.height,
    bottom: Math.max(follow(l[0] as number, 1), follow(r[0] as number, 1)) + 4 / map.height,
  };
}

/**
 * From x, the nearest column in the direction (-1 left, 1 right) that is not dark along the rows between `from` and `to`, at most
 * `reach` of the page away, and two pixels further out so that the columns beside the edge are white too.
 */
function whiteColumn(map: InkMap, x: number, direction: -1 | 1, from: number, to: number, reach: number): number | undefined {
  const step = 1 / map.width;
  for (let moved = step; moved <= reach; moved += step) {
    const at = x + direction * moved;
    if (at <= 0 || at >= 1) return undefined;
    if (darkAlong(map, at, from, to) <= EDGE_INK) return at + direction * 2 * step;
  }
  return undefined;
}

/**
 * The region of the lines taken on one page: as wide as the lines, a little above the first and below the last, the bottom edge
 * stopping above the line that ended the walk. An edge that falls on ink (a tall bracket reaches beyond its line, the border of a
 * box drawn around the exercise runs along a side) moves into the nearest white row or column when the page has an ink map.
 */
function regionOf(pages: readonly PageText[], part: Part): Rect {
  const { lines, page: pageIndex, nextTop } = part;
  const page = pages[pageIndex] as PageText;
  let left = Math.min(...lines.map((line) => line.rect.left)) - 0.01;
  let right = Math.max(...lines.map((line) => line.rect.right)) + 0.01;
  // A figure or a field drawn without text may reach further sideways than the lines do: the region is as wide as the text block.
  if (part.wordFirst === true && part.block && page.columns <= 1) {
    left = Math.min(left, part.block.left - 0.01);
    right = Math.max(right, part.block.right + 0.01);
  }
  let top = Math.min(...lines.map((line) => line.rect.top)) - 0.002;
  const lastBottom = Math.max(...lines.map((line) => line.rect.bottom));
  let bottom = lastBottom + 0.004;
  if (nextTop !== undefined) bottom = Math.max(lastBottom + 0.0005, Math.min(bottom, nextTop - 0.004));
  // A line that stands across the top edge is taken whole, so that the edge never cuts a line.
  const isFurniture = (line: TextLine): boolean => (part.wordFirst === true ? wordFirstFurniture(line, page) : furniture(line));
  const others = page.lines.filter((line) => !isFurniture(line) && !lines.includes(line) && line.rect.right > left && line.rect.left < right);
  const limit = top - 0.03;
  for (let again = true, guard = 0; again && guard < 3; guard += 1) {
    again = false;
    for (const line of others) {
      if (line.rect.top < top && line.rect.bottom > top + 0.001 && line.rect.bottom - line.rect.top < 0.03 && line.rect.top - 0.002 >= limit) {
        top = line.rect.top - 0.002;
        again = true;
      }
    }
  }
  // A figure or a table drawn under the last line belongs to the exercise, as far as the next line or the end of the page.
  if (part.wordFirst === true && page.ink) {
    const limit = nextTop !== undefined ? nextTop - 0.003 : contentLimit(page);
    const low = limit > lastBottom ? lowestInk(page.ink, lastBottom, limit) : undefined;
    if (low !== undefined) bottom = Math.max(bottom, Math.min(limit, low + 0.004));
  }
  const map = page.inkMap;
  if (map) {
    // A box drawn around the first line (the statement) belongs to the region, border included.
    const first = lines.reduce((a, b) => (b.rect.top < a.rect.top ? b : a));
    const box = boxAround(map, left, right, first.rect.top, first.rect.bottom);
    if (box) {
      left = Math.min(left, box.left);
      right = Math.max(right, box.right);
      top = Math.min(top, box.top);
    }
    // The side that runs along ink moves out into the white: the border of a box, a rule or the stem of a bracket is not cut.
    const out = (x: number, direction: -1 | 1): number => (darkAlong(map, x, top, bottom) > EDGE_INK ? whiteColumn(map, x, direction, top, bottom, 0.03) ?? x : x);
    left = out(left, -1);
    right = out(right, 1);
    const floor = Math.max(0, top - 0.04);
    if (dark(map, top, left, right) > 0) {
      const white = whiteRow(map, top, left, right, -1, 0.04);
      if (white !== undefined) top = Math.max(floor, white - 1 / map.height);
    }
    const reach = nextTop !== undefined ? Math.max(0, nextTop - 0.003 - bottom) : 0.03;
    if (dark(map, bottom, left, right) > 0) {
      const white = whiteRow(map, bottom, left, right, 1, reach);
      if (white !== undefined) bottom = white + 1 / map.height;
    }
    if (box) bottom = Math.max(bottom, box.bottom);
  }
  return { left: round(clamp(left)), top: round(clamp(top)), right: round(clamp(right)), bottom: round(clamp(bottom)) };
}

const regionsOf = (pages: readonly PageText[], parts: readonly Part[]): Region[] => parts.map((part) => ({ page: part.page, rect: regionOf(pages, part) }));

// ---------------------------------------------------------------------------------------------------------------------
// The section an exercise belongs to

/**
 * The section whose label is the first two numbers of `label` ("1.2.3" belongs to "1.2"); when there is none, the nearest
 * section whose label is a start of it; else the last section that starts on or before the page.
 */
export function sectionOfLabel(label: string, page: number, targets: readonly BookEntry[]): BookEntry | undefined {
  const parts = label.split('.');
  for (let length = Math.min(2, parts.length - 1); length >= 1; length -= 1) {
    const prefix = parts.slice(0, length).join('.');
    const found = targets.find((entry) => entry.label === prefix || entry.id === prefix);
    if (found) return found;
  }
  let best: BookEntry | undefined;
  for (const entry of targets) if (entry.page <= page && (best === undefined || entry.page >= best.page)) best = entry;
  return best;
}

/** The left and right edges of the text on the given pages: the 3rd percentile of the left edges and the 97th of the right edges of their lines. */
function textBlock(pages: readonly PageText[], on: readonly number[]): { left: number; right: number } | undefined {
  const lefts: number[] = [];
  const rights: number[] = [];
  for (const p of new Set(on)) {
    const page = pages[p];
    if (!page || page.columns > 1) continue;
    for (const line of page.lines) {
      if (wordFirstFurniture(line, page)) continue;
      lefts.push(line.rect.left);
      rights.push(line.rect.right);
    }
  }
  if (lefts.length < 5) return undefined;
  lefts.sort((a, b) => a - b);
  rights.sort((a, b) => a - b);
  return { left: lefts[Math.floor(0.03 * (lefts.length - 1))] as number, right: rights[Math.ceil(0.97 * (rights.length - 1))] as number };
}

// ---------------------------------------------------------------------------------------------------------------------
// Exercises

export interface LabelledExercises {
  /** The result for each section that has exercises printed inside its text. */
  sections: Map<string, SectionExercises>;
  /** Book-wide notes: how many were found, the links that belong to no exercise. */
  notes: string[];
  /** Whether the book prints its exercises this way at all (at least `MIN_LABELLED` anchors). */
  active: boolean;
}

export function proposeLabelledExercises(pages: readonly PageText[], targets: readonly BookEntry[], patterns: BookPatterns = DEFAULT_BOOK_PATTERNS): LabelledExercises {
  const result: LabelledExercises = { sections: new Map(), notes: [], active: false };
  const hits = findLabelledItems(pages, patterns);
  if (hits.length < MIN_LABELLED) return result;
  result.active = true;
  const rules = compile(patterns);
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const headingSize = body * 1.12;
  const isLink = (line: TextLine): boolean => line.rect.left > 0.6 && line.chars <= 14 && rules.links.has(textOf(line).toLowerCase());
  const isHeading = (line: TextLine): boolean => line.fontSize >= headingSize || rules.numbered.test(textOf(line));
  const startsExercise = (line: TextLine): boolean => rules.item.test(textOf(line)) || rules.itemKeyword.test(textOf(line));
  const stopOf = (line: TextLine): Verdict => (isLink(line) ? 'include-end' : isHeading(line) || startsExercise(line) ? 'end-before' : undefined);
  // An exercise that starts with its word ("Aufgabe 1.3 (Title). ...") has no link word to end at: it goes on at the top of the next
  // page only when its page is filled to the bottom with text or ink; else the rest of the page is the room to answer in.
  const block = textBlock(pages, hits.filter((hit) => hit.form === 'keyword-first').map((hit) => hit.page));
  const reachesBottom = (page: PageText): boolean => {
    const limit = contentLimit(page);
    const text = page.lines.filter((line) => !wordFirstFurniture(line, page) && line.rect.top < limit).map((line) => line.rect.bottom);
    const ink = page.ink ? lowestInk(page.ink, 0.1, limit) : undefined;
    return Math.max(0, ...text, ink ?? 0) >= PAGE_FILLED;
  };

  // The paragraphs that hold for the exercises below them ("For the following exercises ...") and the exercises, in the order of the book.
  const hitOf = new Map(hits.map((hit) => [hit.line, hit] as const));
  let context: { text: string; regions: Region[] } | undefined;
  const contextOf = new Map<LabelledHit, { text: string; regions: Region[] }>();
  pages.forEach((page, p) => {
    if (!page.hasText) return;
    linesOf(page).forEach((line, index) => {
      const hit = hitOf.get(line);
      if (furniture(line) && hit === undefined) return;
      const text = textOf(line);
      if (hit) {
        if (context) contextOf.set(hit, context);
        return;
      }
      if (rules.context.test(text)) {
        const walked = walk(pages, p, index, (other) => (isHeading(other) || startsExercise(other) ? 'end-before' : undefined));
        context = { text, regions: regionsOf(pages, walked.parts) };
        return;
      }
      if (context && isHeading(line)) context = undefined;
    });
  });

  const consumed = new Set<TextLine>();
  const bySection = new Map<string, { entry: BookEntry; proposals: { hit: LabelledHit; proposal: ExerciseProposal; spans: Region[]; ended: boolean }[]; duplicates: string[] }>();
  const seen = new Set<string>();
  for (const hit of hits) {
    const entry = sectionOfLabel(hit.label, hit.page, targets);
    if (!entry) continue;
    const section = bySection.get(entry.id) ?? { entry, proposals: [], duplicates: [] };
    bySection.set(entry.id, section);
    if (seen.has(hit.label)) {
      section.duplicates.push(hit.label);
      continue;
    }
    seen.add(hit.label);
    const wordFirst = hit.form === 'keyword-first';
    const walked = walk(pages, hit.page, hit.index, stopOf, wordFirst ? { holdsOn: reachesBottom, wordFirst: true, ...(block ? { block } : {}) } : {});
    const linkLine = walked.parts.flatMap((part) => part.lines).find(isLink);
    if (linkLine) consumed.add(linkLine);
    // A continuation that holds nothing but the link is not part of the statement.
    while (walked.parts.length > 1 && (walked.parts[walked.parts.length - 1] as Part).lines.every(isLink)) walked.parts.pop();
    const regions = regionsOf(pages, walked.parts);
    const [first, ...more] = regions as [Region, ...Region[]];
    const shared = contextOf.get(hit);
    const evidence: string[] = [`starts with "${textOf(hit.line).slice(0, 30)}" (an exercise printed ${wordFirst ? 'under its word and number' : 'inside the text'})`];
    // What ended it: a link word, or (for an exercise that starts with its word) the next label, a heading or the last ink of the page.
    const endedAtPage = wordFirst && walked.parts.some((part) => part.toPageEnd === true);
    const endedByLink = linkLine !== undefined || (wordFirst && walked.ended);
    if (linkLine) evidence.push(`ends at the link "${textOf(linkLine)}" at the right margin`);
    else if (endedAtPage) evidence.push('ends at the last ink of its page: the page is not filled to the bottom, the rest of it is room to answer in');
    else if (walked.ended) evidence.push(wordFirst ? 'ends above the next labelled exercise or heading' : 'no link word at the right margin: it ends above the next numbered line or heading');
    else evidence.push('no end was found within nine pages');
    if (more.length > 0) evidence.push(`continues on page ${more.map((region) => region.page).join(', ')}`);
    if (shared) evidence.push(`instruction: "${shared.text.slice(0, 70)}"`);
    let confidence = 0.9;
    if (!endedByLink) confidence -= 0.1;
    if (!walked.ended) confidence -= 0.2;
    if (more.length > 0) confidence -= 0.05;
    section.proposals.push({
      hit,
      spans: more,
      ended: endedByLink,
      proposal: {
        id: `x${entry.id.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 20)}-${hit.label.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 17)}`,
        section: entry.id,
        label: hit.label,
        page: first.page,
        rect: first.rect,
        ...(more.length > 0 ? { continues: more.slice(0, MAX_CONTINUATIONS) } : {}),
        context: shared ? shared.regions.map((region) => ({ page: region.page, rect: { ...region.rect } })) : [],
        confidence: Math.max(0.1, Math.round(confidence * 100) / 100),
        evidence,
        title: textOf(hit.line).slice(0, 80),
        layout: 'text',
      },
    });
  }
  for (const [id, section] of bySection) {
    const proposals = section.proposals.sort((a, b) => compareLabels(a.hit.label, b.hit.label));
    const instructions = new Map<string, InstructionFound>();
    for (const { hit, proposal } of proposals) {
      const shared = contextOf.get(hit);
      if (!shared) continue;
      const known = instructions.get(shared.text) ?? { text: shared.text, regions: shared.regions, governs: [] };
      known.governs.push(proposal.label);
      instructions.set(shared.text, known);
    }
    const notes: string[] = [];
    const spanned = spanNote(
      proposals.filter((entry) => entry.spans.length > 0).map((entry) => describeSpan(entry.proposal.label, entry.proposal.page, entry.spans, MAX_CONTINUATIONS)),
      'exercise',
    );
    if (spanned) notes.push(spanned);
    const open = proposals.filter((entry) => !entry.ended).map((entry) => entry.proposal.label);
    if (open.length > 0) notes.push(`${open.length === 1 ? 'the exercise' : 'the exercises'} ${open.slice(0, 12).join(', ')}${open.length > 12 ? ', ...' : ''} ${open.length === 1 ? 'has' : 'have'} no link word at the right margin: ${open.length === 1 ? 'it ends' : 'they end'} above the next numbered line`);
    if (section.duplicates.length > 0) notes.push(`${section.duplicates.length === 1 ? 'the number' : 'the numbers'} ${section.duplicates.join(', ')} ${section.duplicates.length === 1 ? 'is' : 'are'} printed more than once`);
    const labels = proposals.map((entry) => entry.hit.label);
    const pagesUsed = proposals.flatMap((entry) => [entry.proposal.page, ...(entry.proposal.continues ?? []).map((region) => region.page)]);
    result.sections.set(id, {
      section: id,
      ...(section.entry.label !== undefined ? { label: section.entry.label } : {}),
      title: section.entry.title,
      pages: [Math.min(...pagesUsed), Math.max(...pagesUsed)],
      proposals: proposals.map((entry) => entry.proposal),
      ...(labels.length > 0 ? { first: labels[0] as string, last: labels[labels.length - 1] as string } : {}),
      gaps: [],
      duplicates: section.duplicates,
      instructions: [...instructions.values()],
      rejected: [],
      excluded: [],
      notes,
    });
  }
  const total = [...result.sections.values()].reduce((sum, entry) => sum + entry.proposals.length, 0);
  const wordFirst = hits.filter((hit) => hit.form === 'keyword-first').length;
  result.notes.push(
    `${total} exercises in ${result.sections.size} sections are printed inside the text: lines that start like "${anchorExample(hits[0] as LabelledHit)}" (items found by their label, each ending at a link word at the right margin, above the next labelled line or heading${wordFirst > 0 ? ', or at the last ink of its page' : ''})`,
  );
  // Link words that no exercise ended with.
  const stray: string[] = [];
  pages.forEach((page, p) => {
    if (!page.hasText) return;
    for (const line of linesOf(page)) if (!furniture(line) && isLink(line) && !consumed.has(line)) stray.push(String(p));
  });
  if (stray.length > 0) result.notes.push(`${stray.length} link word${stray.length === 1 ? '' : 's'} at the right margin belong to no exercise (page${stray.length === 1 ? '' : 's'} ${[...new Set(stray)].slice(0, 12).join(', ')}${new Set(stray).size > 12 ? ', ...' : ''})`);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Answers

export interface LabelledAnswers {
  sections: SectionSolutions[];
  notes: string[];
  active: boolean;
}

/**
 * The answers that start with a line like "Lösung 1.2.3". `exercises` (section and label of the exercises that exist) decides
 * the section of an answer; an answer of a number no exercise has is filed by its number. Each answer goes on to the link back
 * ("zurück") or to the next answer or heading, over page breaks.
 */
export function proposeLabelledAnswers(
  pages: readonly PageText[],
  targets: readonly BookEntry[],
  exercises: readonly { section: string; label: string }[] | undefined,
  patterns: BookPatterns = DEFAULT_BOOK_PATTERNS,
): LabelledAnswers {
  const result: LabelledAnswers = { sections: [], notes: [], active: false };
  const hits = findLabelledAnswers(pages, patterns);
  if (hits.length < MIN_LABELLED) return result;
  const known = new Map((exercises ?? []).map((exercise) => [exercise.label, exercise.section]));
  if (exercises && exercises.length > 0) {
    const matching = hits.filter((hit) => known.has(hit.label)).length;
    if (matching < 0.5 * hits.length) return result;
  }
  result.active = true;
  const rules = compile(patterns);
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const headingSize = body * 1.12;
  const isBack = (line: TextLine): boolean => line.rect.left > 0.6 && line.chars <= 14 && rules.backs.has(textOf(line).toLowerCase());
  const isHeading = (line: TextLine): boolean => line.fontSize >= headingSize || rules.numbered.test(textOf(line));
  const stopOf = (line: TextLine): Verdict => (isBack(line) ? 'include-end' : rules.answer.test(textOf(line)) || isHeading(line) ? 'end-before' : undefined);

  const bySection = new Map<string, { entry: BookEntry; answers: SolutionProposal[]; spans: { n: number; text: string }[]; duplicates: string[]; open: string[] }>();
  const seen = new Set<string>();
  for (const hit of hits) {
    const sectionId = known.get(hit.label);
    const entry = (sectionId !== undefined ? targets.find((candidate) => candidate.id === sectionId) : undefined) ?? sectionOfLabel(hit.label, hit.page, targets);
    if (!entry) continue;
    const section = bySection.get(entry.id) ?? { entry, answers: [], spans: [], duplicates: [], open: [] };
    bySection.set(entry.id, section);
    if (seen.has(hit.label)) {
      section.duplicates.push(hit.label);
      continue;
    }
    seen.add(hit.label);
    const walked = walk(pages, hit.page, hit.index, stopOf);
    const endedByBack = walked.parts.some((part) => part.lines.some(isBack));
    const backLine = walked.parts.flatMap((part) => part.lines).find(isBack);
    // A last page that holds nothing but the link back is not part of the answer.
    while (walked.parts.length > 1 && (walked.parts[walked.parts.length - 1] as Part).lines.every(isBack)) walked.parts.pop();
    const regions = regionsOf(pages, walked.parts);
    if (!endedByBack) section.open.push(hit.label);
    const more = regions.slice(1);
    if (more.length > 0) section.spans.push({ n: section.answers.length, text: describeSpan(hit.label, hit.page, more, MAX_CONTINUATIONS) });
    const evidence = [`starts with "${textOf(hit.line)}" (an answer headed by its number)`];
    evidence.push(endedByBack ? `ends at the link "${textOf(backLine as TextLine)}" at the right margin` : walked.ended ? 'no link back at the right margin: it ends above the next answer or heading' : 'no end was found within nine pages');
    if (more.length > 0) evidence.push(`goes on in ${more.length} further region${more.length === 1 ? '' : 's'} (page ${more.map((region) => region.page).join(', ')})`);
    section.answers.push({
      section: entry.id,
      label: hit.label,
      exercise: `x${entry.id.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 20)}-${hit.label.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 17)}`,
      regions: regions.slice(0, MAX_CONTINUATIONS),
      confidence: endedByBack ? 0.9 : walked.ended ? 0.8 : 0.6,
      evidence,
      text: textOf(hit.line).slice(0, 80),
    });
  }
  const wanted = new Map<string, Set<string>>();
  for (const exercise of exercises ?? []) wanted.set(exercise.section, (wanted.get(exercise.section) ?? new Set()).add(exercise.label));
  for (const entry of targets) {
    const found = bySection.get(entry.id);
    const answers = (found?.answers ?? []).sort((a, b) => compareLabels(a.label, b.label));
    const expected = wanted.get(entry.id);
    const have = new Set(answers.map((answer) => answer.label));
    const notes: string[] = [];
    const spanned = spanNote((found?.spans ?? []).map((span) => span.text), 'answer');
    if (spanned) notes.push(spanned);
    const withoutAnswer = expected ? [...expected].filter((label) => !have.has(label)).sort(compareLabels) : [];
    const withoutExercise = expected ? [...have].filter((label) => !expected.has(label)).sort(compareLabels) : [];
    if (withoutAnswer.length > 0) notes.push(`no answer for the exercise${withoutAnswer.length === 1 ? '' : 's'} ${withoutAnswer.slice(0, 12).join(', ')}${withoutAnswer.length > 12 ? ', ...' : ''}`);
    if (withoutExercise.length > 0) notes.push(`answer${withoutExercise.length === 1 ? '' : 's'} ${withoutExercise.slice(0, 12).join(', ')} ${withoutExercise.length === 1 ? 'has' : 'have'} no exercise`);
    if (found && found.open.length > 0) notes.push(`${found.open.length === 1 ? 'the answer' : 'the answers'} ${found.open.slice(0, 12).join(', ')}${found.open.length > 12 ? ', ...' : ''} ${found.open.length === 1 ? 'has' : 'have'} no link back at the right margin`);
    if (found && found.duplicates.length > 0) notes.push(`${found.duplicates.length === 1 ? 'the number' : 'the numbers'} ${found.duplicates.join(', ')} ${found.duplicates.length === 1 ? 'is' : 'are'} printed more than once`);
    if (answers.length === 0 && (expected?.size ?? 0) === 0) continue;
    result.sections.push({
      section: entry.id,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      title: entry.title,
      answers,
      ...(answers.length > 0 ? { first: answers[0]?.label as string, last: answers[answers.length - 1]?.label as string } : {}),
      gaps: [],
      duplicates: found?.duplicates ?? [],
      headers: [],
      withoutAnswer,
      withoutExercise,
      rejected: [],
      notes,
    });
  }
  result.notes.push(`${hits.length} answers are entries of an answer chapter: lines that start like "${(hits[0] as LabelledHit).word} ${(hits[0] as LabelledHit).label}" (found by the word before the number, each ending at a link back at the right margin or above the next answer or heading)`);
  return result;
}
