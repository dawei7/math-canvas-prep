import { lineStart } from '../geometry/snap.js';
import { INK_BANDS, type PageText, type Rect, type Region, type TextLine } from '../model/types.js';
import { AUTHORING } from '../rules/constants.js';
import { bodyFontSize } from '../propose/exercises.js';
import { isRunningLine } from './scan.js';
import type { BookEntry } from './sections.js';

/**
 * The numbered exercises of the practice sets of a book, found from the printed text of the pages.
 *
 * What is looked for in a practice set: lines that start with a printed number ("5)", "5.", "(5)", "5a)"), kept only
 * when the numbers form a sequence and the lines are aligned like the others; the instruction lines (set in bold, at
 * the margin) that are printed once for a group of items and govern the items below them (also on the next page);
 * and, for each item, everything that belongs to it: continuation lines of a word problem, the second line of a
 * fraction, the labels of a figure, the lines on the next page when the item runs over a page break. The page is
 * cut into bands by the instructions, and a band into columns by the left edges of its items, so that a page that
 * holds two columns in one group and three in the next is read correctly. The result is a proposal with the
 * evidence for every item; it is meant to be looked at.
 */

export interface ItemPattern {
  /** For the evidence: how the numbers look. */
  name: string;
  /** Group 1 is the printed label (without the closing mark); group 2 the text after it. */
  regex: RegExp;
}

/** The item starts that are looked for by default. Replace them with `itemPatterns` for a book that numbers differently. */
export const DEFAULT_ITEM_PATTERNS: ItemPattern[] = [
  { name: '5)', regex: /^(\d{1,3}[a-z]?)\)\s*(.*)$/ },
  { name: '5.', regex: /^(\d{1,3}[a-z]?)\.(?!\d)\s*(.*)$/ },
  { name: '(5)', regex: /^\((\d{1,3}[a-z]?)\)\s*(.*)$/ },
];

export interface ExerciseOptions {
  itemPatterns?: ItemPattern[];
  /**
   * How to recognise instruction lines: `bold` (set in bold, at the margin), `margin` (at the margin, above an item),
   * `auto` (bold when the practice sets have bold lines, else margin), `none`. Default `auto`.
   */
  instructions?: 'bold' | 'margin' | 'auto' | 'none';
  /** Do not propose more than this many items in a set (the surplus is listed as excluded); default no limit. */
  maxItems?: number;
  /** A limit for single sections, by section id; wins over `maxItems`. */
  caps?: Record<string, number>;
}

export interface ExerciseProposal {
  /** A deterministic frame id made from the section and the label, so applying twice does not duplicate. */
  id: string;
  section: string;
  /** The number as the book prints it ("5", "5a"), without the closing mark. */
  label: string;
  page: number;
  rect: Rect;
  continues?: Region[];
  /** The instruction regions that govern the item (several when the instruction crosses a page break). */
  context: Region[];
  confidence: number;
  evidence: string[];
  /** The text of the first line. */
  title: string;
  layout: 'text' | 'figure';
}

export interface InstructionFound {
  text: string;
  regions: Region[];
  /** The labels of the items it governs. */
  governs: string[];
}

export interface RejectedStart {
  page: number;
  text: string;
  reason: string;
}

export interface SectionExercises {
  section: string;
  label?: string;
  title: string;
  /** First and last page examined. */
  pages: [number, number];
  proposals: ExerciseProposal[];
  /** First and last label as printed, in numeric order. */
  first?: string;
  last?: string;
  /** Labels between the first and the last that were not found. */
  gaps: string[];
  duplicates: string[];
  instructions: InstructionFound[];
  rejected: RejectedStart[];
  /** Items found but left out because of a cap. */
  excluded: string[];
  notes: string[];
}

export interface BookExercises {
  sections: SectionExercises[];
  notes: string[];
}

interface Candidate {
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
}

interface PLine {
  page: number;
  index: number;
  line: TextLine;
  role: 'start' | 'instruction' | 'other';
  candidate?: Candidate;
  block?: Block;
}

interface Block {
  lines: PLine[];
  /** Lines of the block per page. */
  pages: Map<number, PLine[]>;
  /** Whether no item follows the block on the last page it touches. */
  openAtEnd: boolean;
}

interface ItemAcc {
  candidate: Candidate;
  start: PLine;
  own: PLine[];
  extra: Map<number, PLine[]>;
  band: number;
  column: number;
  page: number;
  figure: boolean;
  block: Block | undefined;
}

const PAD = 0.012;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number): number => Math.round(value * 10000) / 10000;
const FIGURE_SHORT = 14;
const INK_THRESHOLD = 0.004;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Values grouped into clusters whose members lie within `tolerance` of the cluster's first value. */
function cluster(values: readonly number[], tolerance: number): { center: number; count: number }[] {
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

/** The y where the body text of a page ends: just above its footer, or near the bottom. */
function contentLimit(page: PageText | undefined): number {
  const footers = (page?.lines ?? []).filter((line) => line.headerFooter === true && line.rect.top > 0.85).map((line) => line.rect.top);
  return footers.length > 0 ? Math.min(...footers) - AUTHORING.startPadding : 0.96;
}

/** The y of the lowest inked band between two positions, or undefined when the space is blank. */
function lowestInk(ink: readonly number[], from: number, to: number): number | undefined {
  const first = Math.max(0, Math.ceil(from * INK_BANDS));
  for (let band = Math.min(INK_BANDS - 1, Math.floor(to * INK_BANDS)); band >= first; band -= 1) {
    if ((ink[band] ?? 0) >= INK_THRESHOLD) return (band + 1) / INK_BANDS;
  }
  return undefined;
}

export const exerciseId = (section: string, label: string): string => `x${section.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 20)}-${label.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 17)}`;

// ---------------------------------------------------------------------------------------------------------------------
// The lines of a practice set and the numbers that start items

function collectLines(pages: readonly PageText[], entry: BookEntry, body: number): PLine[] {
  const practice = entry.practice;
  if (!practice) return [];
  const lines: PLine[] = [];
  for (let p = practice.page; p <= Math.min(practice.end.page, pages.length - 1); p += 1) {
    const page = pages[p];
    if (!page || !page.hasText) continue;
    page.lines.forEach((line, index) => {
      if (isRunningLine(line)) return;
      // Headings (the next chapter's opener, the heading of the next section) are never part of a practice set.
      if (body > 0 && line.fontSize >= body * 1.25 && line.chars <= 100) return;
      if (p === practice.page && index <= practice.index) return;
      if (p === practice.end.page && !(line.rect.top < practice.end.top - 0.002)) return;
      lines.push({ page: p, index, line, role: 'other' });
    });
  }
  return explodeMergedRows(lines);
}

/**
 * The text extraction sometimes joins the two items of one row of a two-column list into one line ("5) first 6)
 * second"), when the gap between the columns is not wide enough to be seen as a gutter. Such a line is cut again where
 * the next number begins; the cut sits on the left edge of the column that other items start at, else where the text
 * says. Only a line that starts with a number and holds the next numbers (1 to 3 more) is cut.
 */
function explodeMergedRows(lines: readonly PLine[]): PLine[] {
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
    const embedded = /(?<=\s)(\d{1,3})[).](?=\s)/g;
    let found: RegExpExecArray | null;
    while ((found = embedded.exec(text)) !== null) {
      const n = Number(found[1]);
      if (n <= expected || n - expected > 3 || found.index <= 3) continue;
      // The cut has to fall on a column where other items start; a number inside a sentence does not.
      const estimate = left + ((right - left) * found.index) / Math.max(1, text.length);
      const column = columns
        .filter((candidate) => candidate.center > pieceLeft + 0.1 && candidate.center < right && Math.abs(candidate.center - estimate) <= 0.12)
        .sort((a, b) => Math.abs(a.center - estimate) - Math.abs(b.center - estimate))[0];
      if (!column) continue;
      cuts.push({ at: found.index, boundary: column.center });
      expected = n;
      pieceLeft = column.center;
    }
    if (cuts.length === 0) {
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

function piece(entry: PLine, text: string, left: number, right: number, k: number): PLine {
  const line: TextLine = { ...entry.line, text, chars: text.replace(/\s/g, '').length, rect: { ...entry.line.rect, left, right: Math.max(right, left + 0.02) } };
  return { page: entry.page, index: entry.index + k * 0.001, line, role: 'other' };
}

function findCandidates(lines: readonly PLine[], patterns: readonly ItemPattern[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entry of lines) {
    const text = entry.line.text.trim();
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const label = match[1] as string;
      const n = Number.parseInt(label, 10);
      if (!Number.isFinite(n) || n < 1) break;
      const rest = (match[2] ?? '').trim();
      found.push({ label, n, suffix: label.replace(/^\d+/, ''), lead: text.slice(0, text.length - rest.length).trim(), rest, page: entry.page, index: entry.index, line: entry.line, weak: false });
      break;
    }
  }
  return found;
}

interface Selection {
  chosen: Candidate[];
  rejected: RejectedStart[];
  gaps: string[];
  duplicates: string[];
  weak: Candidate[];
}


function selectSequence(candidates: readonly Candidate[], lines: readonly PLine[]): Selection {
  const rejected: RejectedStart[] = [];
  const reject = (candidate: Candidate, reason: string): void => {
    rejected.push({ page: candidate.page, text: candidate.line.text.slice(0, 60), reason });
  };
  const clusters = cluster(candidates.map((candidate) => candidate.line.rect.left), 0.02);
  const total = candidates.length;
  const significant = clusters.filter((entry) => total <= 3 || entry.count >= Math.max(3, Math.ceil(0.08 * total)));
  const aligned = (left: number): boolean => clusters.some((entry) => Math.abs(entry.center - left) <= 0.025);
  // A number slightly to the right of the main columns is an indented line of a paragraph, not an item.
  const good = candidates.filter((candidate) => {
    const left = candidate.line.rect.left;
    const parent = significant.find((entry) => left - entry.center > 0.012 && left - entry.center <= 0.09);
    if (!parent) return true;
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
    if (chain && last && candidate.n - last.n <= 3) chain.push(candidate);
    else chains.push([candidate]);
  }
  const main = [...chains].sort((a, b) => b.length - a.length)[0] ?? [];
  for (const chain of chains) {
    if (chain === main) continue;
    for (const candidate of chain) {
      chosen.delete(candidate.label);
      reject(candidate, `its number ${candidate.label} does not belong to the run ${(main[0] as Candidate | undefined)?.label ?? '?'}..${(main[main.length - 1] as Candidate | undefined)?.label ?? '?'}`);
    }
  }
  // Gaps in the run, and a second look for the missing numbers.
  const numeric = main.filter((candidate) => candidate.suffix === '');
  const gaps: string[] = [];
  const weak: Candidate[] = [];
  if (numeric.length >= 2) {
    const have = new Set(numeric.map((candidate) => candidate.n));
    const low = (numeric[0] as Candidate).n;
    const high = (numeric[numeric.length - 1] as Candidate).n;
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

// ---------------------------------------------------------------------------------------------------------------------
// Instructions

function markInstructions(lines: readonly PLine[], mode: NonNullable<ExerciseOptions['instructions']>, fontInfo: boolean, margin: number, pitch: number): void {
  if (mode === 'none') return;
  const useBold = mode === 'bold' || (mode === 'auto' && fontInfo);
  for (let i = 0; i < lines.length; i += 1) {
    const entry = lines[i] as PLine;
    if (entry.role === 'start' || entry.line.chars < 3) continue;
    if (useBold) {
      if (entry.line.bold === true && entry.line.rect.left <= margin + 0.08) entry.role = 'instruction';
      continue;
    }
    // Without bold: a line at the margin that is not a continuation of the item above and is followed by an item.
    if (Math.abs(entry.line.rect.left - margin) > 0.02 || entry.line.chars < 8) continue;
    const previous = lines[i - 1];
    const next = lines[i + 1];
    const afterItem = previous !== undefined && previous.page === entry.page && previous.role === 'start' && entry.line.rect.top - previous.line.rect.bottom < 1.2 * pitch;
    const beforeItem = next !== undefined && next.page === entry.page && (next.role === 'start' || next.role === 'instruction');
    if (!afterItem && beforeItem) entry.role = 'instruction';
  }
  if (useBold) {
    // A long instruction is cut by the column detection into a piece in each column: the bold piece that shares its
    // row with an instruction line belongs to the instruction too.
    for (const entry of lines) {
      if (entry.role !== 'other' || entry.line.bold !== true || entry.line.chars < 3) continue;
      const sameRow = lines.some(
        (other) =>
          other.role === 'instruction' &&
          other.page === entry.page &&
          Math.min(other.line.rect.bottom, entry.line.rect.bottom) - Math.max(other.line.rect.top, entry.line.rect.top) > 0.5 * Math.min(other.line.rect.bottom - other.line.rect.top, entry.line.rect.bottom - entry.line.rect.top),
      );
      if (sameRow) entry.role = 'instruction';
    }
  }
}

/** Groups instruction lines into blocks; a block that ends a page and goes on at the top of the next page is one block. */
function buildBlocks(lines: readonly PLine[], pitch: number): Block[] {
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
      const last = group[group.length - 1] as PLine;
      block.openAtEnd = !starts.some((entry) => entry.line.rect.top > last.line.rect.top);
      open = block.openAtEnd ? block : undefined;
      group = [];
    };
    for (const entry of instruction) {
      const last = group[group.length - 1];
      if (last && entry.line.rect.top - last.line.rect.bottom > 1.5 * pitch) flush();
      group.push(entry);
    }
    flush();
    if (instruction.length === 0 && starts.length > 0) open = undefined;
  }
  return blocks;
}

const blockText = (block: Block): string => block.lines.map((entry) => entry.line.text.trim()).join(' ').replace(/\s+/g, ' ');

function blockRegions(block: Block, pages: readonly PageText[]): Region[] {
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

interface Layout {
  items: ItemAcc[];
  boundaries: Map<number, { top: number; block: Block }[]>;
  orphans: string[];
}

function layoutPages(lines: readonly PLine[], pages: readonly PageText[], pitch: number): Layout {
  const items: ItemAcc[] = [];
  const orphans: string[] = [];
  const boundariesByPage = new Map<number, { top: number; block: Block }[]>();
  const pageList = [...new Set(lines.map((entry) => entry.page))].sort((a, b) => a - b);
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
        band,
        column: columnIndex(band, entry.line.rect.left),
        page,
        figure: candidate.rest.length === 0,
        block: band > 0 ? (boundaries[band - 1] as { block: Block }).block : carried,
      };
    });
    const inColumn = (band: number, column: number): ItemAcc[] => mine.filter((item) => item.band === band && item.column === column).sort((a, b) => a.start.line.rect.top - b.start.line.rect.top);
    for (const entry of [...others].sort((a, b) => a.line.rect.top - b.line.rect.top)) {
      const band = bandOf(entry.line.rect.top);
      const column = columnIndex(band, entry.line.rect.left);
      const column_ = inColumn(band, column);
      const height = entry.line.rect.bottom - entry.line.rect.top;
      // A line that shares its row with the first line of an item (the sign of a root, the rows of a fraction) belongs to it.
      let owner = column_.find(
        (item) => Math.min(item.start.line.rect.bottom, entry.line.rect.bottom) - Math.max(item.start.line.rect.top, entry.line.rect.top) > 0.3 * Math.min(height, item.start.line.rect.bottom - item.start.line.rect.top),
      );
      if (!owner) {
        const above = [...column_].reverse().find((item) => item.start.line.rect.top <= entry.line.rect.top + 0.004);
        const below = column_.find((item) => item.start.line.rect.top > entry.line.rect.top + 0.004);
        const aboveGap = above ? entry.line.rect.top - Math.max(...above.own.map((own) => own.line.rect.bottom)) : Infinity;
        const belowGap = below ? below.start.line.rect.top - entry.line.rect.bottom : Infinity;
        // The top of a stacked fraction lies just above the line of its item, closer to it than to the item before.
        const overlapsBelow =
          below !== undefined &&
          Math.min(below.start.line.rect.right, entry.line.rect.right) - Math.max(below.start.line.rect.left, entry.line.rect.left) > 0.5 * (entry.line.rect.right - entry.line.rect.left);
        if (below && overlapsBelow && !below.figure && belowGap >= -0.004 && belowGap <= 0.012 && belowGap + 0.004 < aboveGap) owner = below;
        else if (above && aboveGap <= Math.max(0.15, 8 * pitch)) owner = above;
        else if (above?.figure) owner = above;
      }
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
      const carry = previous
        .filter((item) => Math.abs(item.start.line.rect.left - entry.line.rect.left) <= 0.07)
        .sort((a, b) => Math.abs(a.start.line.rect.left - entry.line.rect.left) - Math.abs(b.start.line.rect.left - entry.line.rect.left))[0];
      if (carry && band === 0 && carry.own[carry.own.length - 1] !== undefined) {
        const lastBottom = Math.max(...carry.own.map((own) => own.line.rect.bottom));
        if (lastBottom >= contentLimit(pages[carry.page]) - 0.2) {
          carry.extra.set(page, [...(carry.extra.get(page) ?? []), entry]);
          continue;
        }
      }
      orphans.push(`page ${page}: "${entry.line.text.slice(0, 40)}"`);
    }
    items.push(...mine);
    // The items that may go on over the page break: the lowest of each column.
    const lowest = new Map<number, ItemAcc>();
    for (const item of mine) {
      const key = Math.round(item.start.line.rect.left * 50);
      const known = lowest.get(key);
      if (!known || item.start.line.rect.top > known.start.line.rect.top) lowest.set(key, item);
    }
    previous = [...lowest.values()];
    if (boundaries.length > 0) carried = (boundaries[boundaries.length - 1] as { block: Block }).block;
  }
  return { items, boundaries: boundariesByPage, orphans };
}

// ---------------------------------------------------------------------------------------------------------------------
// One section

function proposeSection(pages: readonly PageText[], entry: BookEntry, options: ExerciseOptions, body: number, fontInfo: boolean): SectionExercises {
  const result: SectionExercises = {
    section: entry.id,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    title: entry.title,
    pages: [entry.practice?.page ?? entry.page, entry.practice?.page ?? entry.page],
    proposals: [],
    gaps: [],
    duplicates: [],
    instructions: [],
    rejected: [],
    excluded: [],
    notes: [],
  };
  const practice = entry.practice;
  if (!practice) {
    result.notes.push('no practice set was found for this section');
    return result;
  }
  const lines = collectLines(pages, entry, body);
  if (lines.length === 0) {
    result.notes.push('the practice set has no text lines (a scan?)');
    return result;
  }
  result.pages = [practice.page, lines[lines.length - 1]?.page ?? practice.page];
  const found = findCandidates(lines, options.itemPatterns ?? DEFAULT_ITEM_PATTERNS);
  if (found.length === 0) {
    result.notes.push('no line of the practice set starts with a number');
    return result;
  }
  const selection = selectSequence(found, lines);
  result.gaps = selection.gaps;
  result.duplicates = selection.duplicates;
  result.rejected = selection.rejected;
  const chosenAt = new Map<string, Candidate>();
  for (const candidate of selection.chosen) chosenAt.set(`${candidate.page}:${candidate.index}`, candidate);
  for (const entryLine of lines) {
    const candidate = chosenAt.get(`${entryLine.page}:${entryLine.index}`);
    if (candidate) {
      entryLine.role = 'start';
      entryLine.candidate = candidate;
    }
  }
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1] as PLine;
    const b = lines[i] as PLine;
    if (a.page === b.page && Math.abs(a.line.rect.left - b.line.rect.left) < 0.05 && b.line.rect.top > a.line.rect.top) pitches.push(b.line.rect.top - a.line.rect.top);
  }
  const pitch = median(pitches.filter((value) => value < 0.06)) || 0.018;
  const margin = Math.min(...selection.chosen.map((candidate) => candidate.line.rect.left));
  markInstructions(lines, options.instructions ?? 'auto', fontInfo, margin, pitch);
  const blocks = buildBlocks(lines, pitch);
  const layout = layoutPages(lines, pages, pitch);
  const { items } = layout;
  if (layout.orphans.length > 0) {
    result.notes.push(`${layout.orphans.length} line${layout.orphans.length === 1 ? '' : 's'} belong to no item: ${layout.orphans.slice(0, 4).join('; ')}${layout.orphans.length > 4 ? '; ...' : ''}`);
  }

  // --- rectangles ----------------------------------------------------------------------------------------------------
  const found_ = new Map<Block, InstructionFound>();
  for (const block of blocks) found_.set(block, { text: blockText(block), regions: blockRegions(block, pages), governs: [] });
  const byColumn = new Map<string, ItemAcc[]>();
  for (const item of items) {
    const key = `${item.page}:${item.band}:${item.column}`;
    byColumn.set(key, [...(byColumn.get(key) ?? []), item]);
  }
  const built: { n: number; suffix: string; proposal: ExerciseProposal }[] = [];
  for (const item of items) {
    const page = pages[item.page] as PageText;
    const all = page.lines;
    const candidate = item.candidate;
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
    const figure = item.figure || (item.own.length >= 3 && short >= 0.5 * item.own.length);
    if (figure) {
      const body = all.filter((entryLine) => !isRunningLine(entryLine));
      const bodyRight = body.length > 0 ? Math.max(...body.map((entryLine) => entryLine.rect.right)) + PAD : 0.95;
      const rightNeighbours = items.filter((other) => other.page === item.page && other.band === item.band && other.column > item.column).map((other) => other.start.line.rect.left - PAD);
      right = Math.max(right, Math.min(rightNeighbours.length > 0 ? Math.min(...rightNeighbours) : bodyRight, bodyRight));
    }
    left = clamp01(left);
    right = clamp01(right);
    const firstLine = [...item.own].sort((a, b) => a.line.rect.top - b.line.rect.top)[0] as PLine;
    const top = clamp01(lineStart(firstLine.line, AUTHORING.startPadding, all));
    const lastText = Math.max(...item.own.map((entryLine) => entryLine.line.rect.bottom));
    let bottom = clamp01(lastText + AUTHORING.endPadding);
    // The limit below: the next item or instruction in the same column, or the end of the page's content.
    const below = [
      ...items
        .filter((other) => other.page === item.page && other.band === item.band && other.column === item.column && other.start.line.rect.top > item.start.line.rect.top)
        .map((other) => lineStart(([...other.own].sort((x, y) => x.line.rect.top - y.line.rect.top)[0] as PLine).line, AUTHORING.startPadding, all)),
      ...(layout.boundaries.get(item.page) ?? []).filter((boundary) => boundary.top > lastText).map((boundary) => boundary.top - AUTHORING.startPadding),
    ];
    const limit = Math.min(contentLimit(page), ...below);
    if (page.ink) {
      // Ink under the last line (a figure) counts, but not ink that belongs to a neighbouring column.
      const foreign = all
        .filter((entryLine) => !isRunningLine(entryLine) && entryLine.rect.top > lastText + 0.002 && (entryLine.rect.left >= right - 0.02 || entryLine.rect.right <= left + 0.02))
        .map((entryLine) => entryLine.rect.top - 0.003);
      const ceiling = Math.min(limit, ...foreign);
      if (ceiling > lastText) {
        const lowest = lowestInk(page.ink, lastText, ceiling);
        if (lowest !== undefined) bottom = Math.max(bottom, Math.min(ceiling, lowest + AUTHORING.endPadding));
      }
    }
    if (below.length > 0) bottom = Math.min(bottom, limit);
    bottom = Math.max(bottom, top + AUTHORING.minPieceHeight * 1.5);
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
    const instruction = item.block ? found_.get(item.block) : undefined;
    if (instruction) instruction.governs.push(candidate.label);

    // --- evidence and confidence -------------------------------------------------------------------------------------
    const evidence: string[] = [];
    evidence.push(candidate.weak ? `starts with "${candidate.label}" followed by text (the closing mark is not in the text layer)` : `starts with "${candidate.lead}"`);
    const numbers = items.map((other) => other.candidate.n);
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    const expectedNeighbours = [candidate.n - 1, candidate.n + 1].filter((n) => n >= low && n <= high);
    const neighbours = expectedNeighbours.filter((n) => numbers.includes(n));
    evidence.push(
      neighbours.length === expectedNeighbours.length
        ? candidate.n === low
          ? `the first number of the run, followed by ${candidate.n + 1}`
          : candidate.n === high
            ? `the last number of the run, after ${candidate.n - 1}`
            : `follows ${candidate.n - 1} and precedes ${candidate.n + 1}`
        : `neighbours found: ${neighbours.join(', ') || 'none'} of ${expectedNeighbours.join(', ')}`,
    );
    const columns = Math.max(...items.filter((other) => other.page === item.page && other.band === item.band).map((other) => other.column)) + 1;
    if (columns > 1) evidence.push(`column ${item.column + 1} of ${columns} in its group`);
    if (item.own.length > 1) evidence.push(`${item.own.length} printed lines on its page${figure ? ' (a figure with labels)' : ''}`);
    if (figure) evidence.push(candidate.rest.length === 0 ? 'the number stands alone: the frame reaches over the figure' : 'mostly short lines: treated as a figure');
    if (continues.length > 0) evidence.push(`continues on page ${continues.map((region) => region.page).join(', ')} (${[...item.extra.values()].reduce((sum, entries) => sum + entries.length, 0)} lines)`);
    if (item.block) evidence.push(`instruction: "${blockText(item.block).slice(0, 70)}"${item.block.pages.size > 1 ? ` (printed on ${item.block.pages.size} pages)` : ''}`);
    else evidence.push('no instruction found above it');
    let confidence = 0.9;
    if (candidate.weak) confidence -= 0.25;
    if (neighbours.length < expectedNeighbours.length) confidence -= 0.1;
    if (rect.bottom - rect.top < 0.014) confidence -= 0.15;
    if (continues.length > 0) confidence -= 0.05;
    if (!item.block) confidence -= 0.05;
    built.push({
      n: candidate.n,
      suffix: candidate.suffix,
      proposal: {
        id: exerciseId(entry.id, candidate.label),
        section: entry.id,
        label: candidate.label,
        page: item.page,
        rect,
        ...(continues.length > 0 ? { continues: continues.slice(0, 8) } : {}),
        context: instruction ? instruction.regions.map((region) => ({ page: region.page, rect: { ...region.rect } })) : [],
        confidence: Math.max(0.1, Math.round(confidence * 100) / 100),
        evidence,
        title: item.start.line.text.trim().slice(0, 80),
        layout: figure ? 'figure' : 'text',
      },
    });
  }
  built.sort((a, b) => a.n - b.n || a.suffix.localeCompare(b.suffix));
  const proposals = built.map((entryBuilt) => entryBuilt.proposal);

  // --- cap and report --------------------------------------------------------------------------------------------------
  const cap = options.caps?.[entry.id] ?? options.maxItems;
  if (cap !== undefined && proposals.length > cap) {
    const dropped = proposals.splice(cap);
    result.excluded = dropped.map((proposal) => proposal.label);
    result.notes.push(`${dropped.length} item${dropped.length === 1 ? '' : 's'} beyond the cap of ${cap} were left out: ${dropped[0]?.label}..${dropped[dropped.length - 1]?.label}`);
  }
  result.proposals = proposals;
  result.instructions = [...found_.values()];
  const labels = selection.chosen.map((candidate) => candidate.label);
  if (labels.length > 0) {
    result.first = labels[0] as string;
    result.last = labels[labels.length - 1] as string;
  }
  if (selection.gaps.length > 0) result.notes.push(`no line starts with ${selection.gaps.length === 1 ? 'the number' : 'the numbers'} ${selection.gaps.join(', ')} although the numbers run from ${labels[0]} to ${labels[labels.length - 1]}`);
  if (selection.duplicates.length > 0) result.notes.push(`${selection.duplicates.length === 1 ? 'the number' : 'the numbers'} ${selection.duplicates.join(', ')} ${selection.duplicates.length === 1 ? 'is' : 'are'} printed more than once`);
  if (selection.weak.length > 0) result.notes.push(`${selection.weak.map((candidate) => candidate.label).join(', ')}: the number is printed without its closing mark`);
  const first = selection.chosen[0];
  if (first && first.n !== 1 && first.suffix === '') result.notes.push(`the numbering starts at ${first.label}, not at 1`);
  return result;
}

/**
 * Proposes the exercises of the practice sets of the given sections (entries with a `practice` place; see
 * `deriveSections` and `locateSections`). `pages` should carry font information (bold) and, for figures, the ink profile.
 */
export function proposeExercises(pages: readonly PageText[], sections: readonly BookEntry[], options: ExerciseOptions = {}): BookExercises {
  const notes: string[] = [];
  const targets = sections.filter((entry) => entry.kind === 'section');
  if (targets.length === 0) notes.push('There are no sections to look at: derive the sections first.');
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  // Without font information (no line says whether it is bold) instructions are recognised by their position only.
  const fontInfo = pages.some((page) => page.lines.some((line) => line.bold !== undefined));
  if (!fontInfo && (options.instructions ?? 'auto') !== 'none') notes.push('The pages carry no font information (bold), so instructions are recognised by their position only; read the pages with fonts for a better result.');
  return { sections: targets.map((entry) => proposeSection(pages, entry, options, body, fontInfo)), notes };
}
