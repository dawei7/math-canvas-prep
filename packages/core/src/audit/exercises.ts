import type { PageText, Rect, Region } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import {
  blockRegions,
  blockText,
  buildBlocks,
  describeSpan,
  explodeMergedRows,
  findCandidates,
  groupByColumn,
  frameItems,
  layoutPages,
  MAX_CONTINUATIONS,
  median,
  parseNamedRange,
  parseRangeInstruction,
  selectSequence,
  spanNote,
  TOUCHING,
  type Block,
  type Candidate,
  type ItemPattern,
  type PLine,
  type RejectedStart,
} from './layout.js';
import { proposeLabelledExercises } from './labelled.js';
import { withRunningHeads } from './runningheads.js';
import { DEFAULT_BOOK_PATTERNS, isFurnitureLine, startsWithWord, type BookPatterns } from './scan.js';
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

export type { ItemPattern, RejectedStart };

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
  /** The words of the book (the item words and the link words matter here: exercises printed inside the text). */
  patterns?: Partial<BookPatterns>;
}

export interface ExerciseProposal {
  /** A name made from the section and the label, for lists and details files; the frame gets its own id when the proposal is applied (it is named `SECTION:LABEL` there). */
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

export const exerciseId = (section: string, label: string): string => `x${section.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 20)}-${label.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 17)}`;

// ---------------------------------------------------------------------------------------------------------------------
// The lines of a practice set

/** A line that starts with a number or names the items it is for is not a running head, wherever it stands. */
const startsLikeAnItem = (text: string): boolean => /^\s*\(?\d{1,3}[.)]/.test(text) || parseRangeInstruction(text) !== undefined;

function collectLines(pages: readonly PageText[], entry: BookEntry, body: number): PLine[] {
  const practice = entry.practice;
  if (!practice) return [];
  const lines: PLine[] = [];
  for (let p = practice.page; p <= Math.min(practice.end.page, pages.length - 1); p += 1) {
    const page = pages[p];
    if (!page || !page.hasText) continue;
    page.lines.forEach((line, index) => {
      if (isFurnitureLine(line, startsLikeAnItem, page.lines)) return;
      // Headings (the next chapter's opener, the heading of the next section) are never part of a practice set.
      if (body > 0 && line.fontSize >= body * 1.25 && line.chars <= 100) return;
      if (p === practice.page && index <= practice.index) return;
      if (p === practice.end.page && !(line.rect.top < practice.end.top - 0.002)) return;
      lines.push({ page: p, index, line, role: 'other' });
    });
  }
  return explodeMergedRows(lines);
}

/** How many lines below a line that names its items still belong to the instruction (a sentence and a list of steps). */
const MAX_INSTRUCTION_LINES = 12;

/** A line of at least this many characters that is indented under an instruction is a displayed formula of it, not a piece of the item below. */
const DISPLAY_CHARS = 16;

/**
 * Lines of one paragraph touch; between two paragraphs there is a gap of at least this share of the line pitch (a blank line is a
 * whole pitch, the skip between paragraphs of a typeset book about three quarters of one).
 */
const PARAGRAPH_GAP = 0.5;

/** The first line of a paragraph that is an instruction holds at least this many letters. */
const MIN_PARAGRAPH_LETTERS = 6;

const letterCount = (text: string): number => (text.match(/\p{L}/gu) ?? []).length;

/**
 * Whether an item follows the line within a few lines of its page, or at the top of the next page when nothing but text stands
 * below the line on its own page (the instruction ends its page).
 */
function itemFollows(lines: readonly PLine[], i: number): boolean {
  const entry = lines[i] as PLine;
  if (lines.slice(i + 1, i + 24).some((other) => other.role === 'start' && other.page === entry.page)) return true;
  for (let j = i + 1; j < lines.length; j += 1) {
    const other = lines[j] as PLine;
    if (other.page === entry.page) {
      if (other.role === 'start') return true;
      continue;
    }
    return other.page === entry.page + 1 && lines.slice(j, j + 12).some((next) => next.page === other.page && next.role === 'start');
  }
  return false;
}

/** Whether the next item after the line is one of the numbers: a sentence that names other exercises ("see Exercises 3-5") is no instruction for the item below it. */
function namesNextItem(lines: readonly PLine[], i: number, range: [number, number]): boolean {
  for (let j = i + 1; j < lines.length; j += 1) {
    const other = lines[j] as PLine;
    if (other.role === 'start' && other.candidate) return other.candidate.n >= range[0] && other.candidate.n <= range[1];
  }
  return false;
}

/**
 * Whether the line is the first of a paragraph that stands at the margin: it follows a blank line (or a page break) and does not
 * hang under the text of the item above it (the second paragraph of an item is indented like the text of its number).
 */
function headsParagraph(lines: readonly PLine[], i: number, pitch: number): boolean {
  const entry = lines[i] as PLine;
  const before = lines[i - 1];
  if (before !== undefined && before.page === entry.page && entry.line.rect.top - before.line.rect.bottom < PARAGRAPH_GAP * pitch) return false;
  for (let j = i - 1; j >= 0 && (lines[j] as PLine).page === entry.page; j -= 1) {
    const above = lines[j] as PLine;
    if (above.role === 'start') return entry.line.rect.left <= above.line.rect.left + 0.015;
  }
  return true;
}

/** The first line of the paragraph that the line is in: the lines of a paragraph touch and stand at one margin; the line itself when it is the first. */
function paragraphHead(lines: readonly PLine[], i: number, pitch: number): number {
  let head = i;
  while (head > 0) {
    const entry = lines[head] as PLine;
    const before = lines[head - 1] as PLine;
    if (before.page !== entry.page || before.role !== 'other' || entry.line.rect.top - before.line.rect.bottom >= PARAGRAPH_GAP * pitch || Math.abs(before.line.rect.left - entry.line.rect.left) > 0.02) break;
    head -= 1;
  }
  return head;
}

/**
 * A line that names the items it is for ("For Exercises 1-4, find ...", "In Exercises 5 - 10, ...", "For 10-13, use ...") is an
 * instruction in any weight and at any margin: it is the strongest sign of where a group of items begins. The lines
 * right below it that go on with its sentence belong to it. A line like that must be followed by an item: a sentence inside a
 * word problem that happens to start with "For 2-3 days" is not an instruction.
 */
function markRangeInstructions(lines: readonly PLine[], pitch: number): void {
  for (let i = 0; i < lines.length; i += 1) {
    const entry = lines[i] as PLine;
    if (entry.role !== 'other') continue;
    // At the start of the line ("For Exercises 1-4"), or anywhere in a line that stands alone at the head of a paragraph and names
    // the item that comes next.
    // (also in the later line of a paragraph that stands at the margin: "The chart below shows ... / Use it to answer Exercises 6 - 9.")
    const head = paragraphHead(lines, i, pitch);
    const named = headsParagraph(lines, head, pitch) ? parseNamedRange(entry.line.text) : undefined;
    const range = parseRangeInstruction(entry.line.text) ?? (named !== undefined && namesNextItem(lines, i, named) ? named : undefined);
    if (!range) continue;
    if (!itemFollows(lines, i)) continue;
    // The lines right below it that go on with its sentence (or its list of steps); the labels of a figure beside it are passed over.
    let last = entry;
    let right = entry.line.rect.right;
    let taken = 0;
    for (let j = i + 1; j < lines.length && taken < MAX_INSTRUCTION_LINES; j += 1) {
      const next = lines[j] as PLine;
      if (next.page !== entry.page || next.role !== 'other' || parseRangeInstruction(next.line.text)) break;
      if (next.line.rect.left >= right - 0.02 && next.line.chars <= 16) continue;
      // A formula that is displayed inside the sentence stands further right than the text does (a long line, unlike the pieces of
      // the first item's fraction, which are short).
      const gap = next.line.rect.top - last.line.rect.bottom;
      const indented = next.line.rect.left > entry.line.rect.left + 0.06;
      if (gap > 1.2 * pitch || next.line.rect.left < entry.line.rect.left - 0.02 || (indented && next.line.chars < DISPLAY_CHARS)) break;
      next.role = 'instruction';
      last = next;
      right = Math.max(right, next.line.rect.right);
      taken += 1;
    }
    entry.role = 'instruction';
    entry.range = range;
    // The lines of the paragraph above it that lead up to the sentence are part of the instruction.
    if (named !== undefined) for (let j = head; j < i; j += 1) (lines[j] as PLine).role = 'instruction';
  }
}

function markInstructions(lines: readonly PLine[], mode: NonNullable<ExerciseOptions['instructions']>, fontInfo: boolean, margin: number, pitch: number): void {
  if (mode === 'none') return;
  markRangeInstructions(lines, pitch);
  const useBold = mode === 'bold' || (mode === 'auto' && fontInfo);
  for (let i = 0; i < lines.length; i += 1) {
    const entry = lines[i] as PLine;
    if (entry.role !== 'other' || entry.line.chars < 3) continue;
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
    // Paragraphs that are set in the weight of the text (see markParagraphs) are instructions too.
    markParagraphs(lines, pitch);
  }
}

/**
 * A book that sets its instructions in the weight of the text has no bold line to find them by. They are the paragraphs that
 * stand between the items after a blank line, not indented like the second line of an item (which hangs under the text of its
 * number), and followed by an item: "Use the diagram to find each length." A set may print some instructions in bold and others not.
 */
function markParagraphs(lines: readonly PLine[], pitch: number): void {
  for (let i = 1; i < lines.length; i += 1) {
    const entry = lines[i] as PLine;
    const before = lines[i - 1] as PLine;
    if (entry.role !== 'other' || entry.line.chars < 8 || before.page !== entry.page) continue;
    // A paragraph holds words: the pieces of a fraction or a matrix that stand a little apart from the item are not one.
    if (letterCount(entry.line.text) < MIN_PARAGRAPH_LETTERS) continue;
    // After a blank line.
    if (entry.line.rect.top - before.line.rect.bottom < PARAGRAPH_GAP * pitch) continue;
    // Not hanging under the text of the item above it.
    let above: PLine | undefined;
    for (let j = i - 1; j >= 0 && (lines[j] as PLine).page === entry.page; j -= 1) {
      if ((lines[j] as PLine).role === 'start') {
        above = lines[j] as PLine;
        break;
      }
    }
    if (above && entry.line.rect.left > above.line.rect.left + 0.015) continue;
    // The lines that go on right below it, and an item after them.
    const block: PLine[] = [entry];
    let k = i + 1;
    while (k < lines.length) {
      const next = lines[k] as PLine;
      const last = block[block.length - 1] as PLine;
      if (next.page !== entry.page || next.role !== 'other' || next.line.rect.top - last.line.rect.bottom >= PARAGRAPH_GAP * pitch || Math.abs(next.line.rect.left - entry.line.rect.left) > 0.03) break;
      block.push(next);
      k += 1;
    }
    const after = lines[k];
    if (after === undefined || after.page !== entry.page || after.role !== 'start') continue;
    for (const member of block) member.role = 'instruction';
    i = k - 1;
  }
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
  const layout = layoutPages(lines, pages, pitch, { headingSize: body * 1.25 });
  const { items } = layout;
  if (layout.orphans.length > 0) {
    result.notes.push(`${layout.orphans.length} line${layout.orphans.length === 1 ? '' : 's'} belong to no item: ${layout.orphans.slice(0, 4).join('; ')}${layout.orphans.length > 4 ? '; ...' : ''}`);
  }

  // --- rectangles ----------------------------------------------------------------------------------------------------
  const found_ = new Map<Block, InstructionFound>();
  for (const block of blocks) found_.set(block, { text: blockText(block), regions: blockRegions(block, pages), governs: [] });
  const byColumn = groupByColumn(items);
  const built: { n: number; suffix: string; continues: Region[]; proposal: ExerciseProposal }[] = [];
  const framed = frameItems(items, { pages, items, byColumn, layout, headingSize: body * 1.25, ends: [{ page: practice.end.page, top: practice.end.top }] }, { touching: TOUCHING });
  for (const { item, frame } of framed) {
    const { rect, continues, figure } = frame;
    const candidate = item.candidate;
    // An instruction that names its items ("For Exercises 1-4") governs those and no others.
    const range = item.block?.range;
    const outside = range !== undefined && (candidate.n < range[0] || candidate.n > range[1]);
    const governing = outside ? undefined : item.block;
    const instruction = governing ? found_.get(governing) : undefined;
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
    if (continues.length > 0) {
      const taken = [...item.extra.values()].reduce((sum, entries) => sum + entries.length, 0) + item.spans.reduce((sum, span) => sum + span.lines.length, 0);
      evidence.push(`continues on page ${[...new Set(continues.map((region) => region.page))].join(', ')} (${taken} lines${item.spans.some((span) => span.figure) ? ', with a page that holds only a figure' : ''})`);
    }
    if (frame.cut) evidence.push(`the frame was cut apart from the frame${frame.cut.length === 1 ? '' : 's'} of ${frame.cut.join(', ')} (they lay on each other)`);
    if (governing) evidence.push(`instruction: "${blockText(governing).slice(0, 70)}"${governing.pages.size > 1 ? ` (printed on ${governing.pages.size} pages)` : ''}${range ? ` (names ${range[0]} to ${range[1]})` : ''}`);
    else if (outside && range) evidence.push(`no instruction: the one above names ${range[0]} to ${range[1]}, this item is beyond it`);
    else evidence.push('no instruction found above it');
    let confidence = 0.9;
    if (candidate.weak) confidence -= 0.25;
    if (neighbours.length < expectedNeighbours.length) confidence -= 0.1;
    if (rect.bottom - rect.top < 0.014) confidence -= 0.15;
    if (continues.length > 0) confidence -= 0.05;
    // A figure is framed by a guess (where its drawing ends is read from ink, not from text): to be looked at.
    if (figure) confidence -= 0.1;
    if (frame.cut) confidence -= 0.05;
    if (!governing && !outside) confidence -= 0.05;
    built.push({
      n: candidate.n,
      suffix: candidate.suffix,
      continues,
      proposal: {
        id: exerciseId(entry.id, candidate.label),
        section: entry.id,
        label: candidate.label,
        page: item.page,
        rect,
        ...(continues.length > 0 ? { continues: continues.slice(0, MAX_CONTINUATIONS) } : {}),
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
  // Every exercise that goes on after its page or its column is listed once, so that the report shows it.
  const spanned = spanNote(
    built.filter((entryBuilt) => entryBuilt.continues.length > 0).map((entryBuilt) => describeSpan(entryBuilt.proposal.label, entryBuilt.proposal.page, entryBuilt.continues, MAX_CONTINUATIONS)),
    'exercise',
  );
  if (spanned) result.notes.push(spanned);

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
 * The pages with the running heads that change with the section flagged (see `withRunningHeads`). The heading that ends a set
 * ("Warm-up Answers", "Answers ...") and the caption of a table that goes on ("TABLE 9.2: (continued)") are not heads,
 * although they may repeat at the top of pages.
 */
export function flagRunningHeads(pages: readonly PageText[], patterns: Pick<BookPatterns, 'stopWords' | 'answerWords'>): readonly PageText[] {
  const endsASet = startsWithWord([...patterns.stopWords, ...patterns.answerWords]);
  return withRunningHeads(pages, (text) => endsASet(text) || /\(continued\)/i.test(text));
}

/**
 * Proposes the exercises of the practice sets of the given sections (entries with a `practice` place; see
 * `deriveSections` and `locateSections`). `pages` should carry font information (bold) and, for figures, the ink profile.
 */
export function proposeExercises(pagesRead: readonly PageText[], sections: readonly BookEntry[], options: ExerciseOptions = {}): BookExercises {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const pages = flagRunningHeads(pagesRead, patterns);
  const notes: string[] = [];
  const targets = sections.filter((entry) => entry.kind === 'section');
  if (targets.length === 0) notes.push('There are no sections to look at: derive the sections first.');
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  // Without font information (no line says whether it is bold) instructions are recognised by their position only.
  const fontInfo = pages.some((page) => page.lines.some((line) => line.bold !== undefined));
  if (!fontInfo && (options.instructions ?? 'auto') !== 'none') notes.push('The pages carry no font information (bold), so instructions are recognised by their position only; read the pages with fonts for a better result.');
  // Exercises printed inside the text ("1.2.3 Aufgabe: ...") are looked for in the sections that have no practice set of their own.
  const inline = proposeLabelledExercises(pages, targets, patterns);
  if (inline.active) notes.push(...inline.notes);
  const results = targets.map((entry) => {
    const own = entry.practice === undefined ? inline.sections.get(entry.id) : undefined;
    if (own) return own;
    const set = proposeSection(pages, entry, options, body, fontInfo);
    if (inline.active && entry.practice === undefined) set.notes = ['no exercise is printed in this section'];
    return set;
  });
  return { sections: results, notes };
}
