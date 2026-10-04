import type { PageText, Rect, Region } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import {
  blockRegions,
  blockText,
  buildBlocks,
  explodeMergedRows,
  findCandidates,
  groupByColumn,
  itemFrame,
  layoutPages,
  median,
  selectSequence,
  type Block,
  type Candidate,
  type ItemPattern,
  type PLine,
  type RejectedStart,
} from './layout.js';
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
  const byColumn = groupByColumn(items);
  const built: { n: number; suffix: string; proposal: ExerciseProposal }[] = [];
  for (const item of items) {
    const { rect, continues, figure } = itemFrame(item, { pages, items, byColumn, layout });
    const candidate = item.candidate;
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
