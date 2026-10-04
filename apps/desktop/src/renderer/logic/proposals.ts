import {
  LIMITS,
  bookKey,
  bookKeyOf,
  bookReference,
  compareSolution,
  compareWithProposal,
  enlargeToMinimum,
  exerciseToOperation,
  isBelowMinimum,
  rectsEqual,
  sameRegions,
  solutionToOperation,
  type ExerciseProposal,
  type Frame,
  type Operation,
  type Rect,
  type Region,
  type SolutionProposal,
} from '@mcprep/core/pure';
import type { BookResult } from '../../shared/api.js';
import { inWindowPages } from './derive.js';

/**
 * The exercises and the answers the search found in a book, as the Propose panel shows them: one row for each, compared
 * with what the project has (new, different, the same), the findings that are not rows (numbers missing, answers without an
 * exercise), and what applying some of them does. The same core functions the command line applies them with, so that a
 * batch applied here is the batch `mcprep exercises propose --apply` writes. Pure, tested without a window, quick for
 * thousands of rows (built once for a result and a version of the frames).
 */

export type BookKind = 'exercises' | 'solutions';
/** Not in the project yet, there already but with another frame or answer, or exactly as proposed. */
export type BookState = 'new' | 'different' | 'same';
export type BookFilter = 'todo' | 'new' | 'different' | 'same' | 'rejected' | 'all';
export type ConfidenceFilter = 'any' | 'sure' | 'unsure';

/** From this confidence on, the search counts a proposal as sure. */
export const SURE_FROM = 0.8;

/** One thing the ghost of a row draws on a page: the frame, the instruction, the part on the next page, the place of the answer. */
export interface GhostPiece {
  page: number;
  rect: Rect;
  role: 'main' | 'context' | 'continues' | 'solution';
}

export interface BookRow {
  /** `SECTION:LABEL`: names the row for ticks, rejections and the ghost on the page. */
  key: string;
  section: string;
  label: string;
  /** Where the page view goes for it: the page of the exercise, the first page of the answer. */
  page: number;
  pieces: GhostPiece[];
  /** The first line of the exercise, or the answer as printed. */
  title: string;
  confidence: number;
  evidence: string[];
  state: BookState;
  /** The project's exercise with this section and number: always there for an answer, only when it is in the book already for an exercise. */
  frame: Frame | undefined;
  /** What differs from the project's own (for a different row), in words. */
  changes: string[];
  /** Why the row cannot be applied. */
  refusal: string | undefined;
  proposal: ExerciseProposal | SolutionProposal;
}

export interface BookCounts {
  total: number;
  new: number;
  different: number;
  same: number;
  unsure: number;
  refused: number;
}

export interface FindingGroup {
  title: string;
  /** Plain lines; `section` lets the window go to the section. */
  lines: { text: string; section?: string }[];
}

export interface BookRows {
  rows: BookRow[];
  byKey: Map<string, BookRow>;
  counts: BookCounts;
  findings: FindingGroup[];
}

const TOLERANCE = 2e-4;
const stored = (rect: Rect): Rect => (isBelowMinimum(rect) ? enlargeToMinimum(rect) : rect);
const storedRegions = (regions: readonly Region[]): Region[] => regions.map((entry) => ({ page: entry.page, rect: stored(entry.rect) }));

const word = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const listed = (items: readonly string[], most = 8): string => (items.length > most ? `${items.slice(0, most).join(', ')}, ... (${items.length})` : items.join(', '));

/** What differs between the project's exercise and the proposal, in words (the state itself comes from the core's comparison). */
function exerciseChanges(frame: Frame, proposal: ExerciseProposal): string[] {
  const changes: string[] = [];
  if (frame.page !== proposal.page) changes.push(`it is on page ${frame.page + 1} in the book, the search found it on page ${proposal.page + 1}`);
  else if (!rectsEqual(frame.rect, stored(proposal.rect), TOLERANCE)) changes.push('its frame is somewhere else or has another size');
  if (!sameRegions(frame.continues ?? [], storedRegions(proposal.continues ?? []))) changes.push('the part on the next page differs');
  if (!sameRegions(frame.context ?? [], storedRegions(proposal.context))) changes.push('its instruction differs');
  return changes.length > 0 ? changes : ['it differs from what the search found'];
}

const regionPieces = (regions: readonly Region[], role: GhostPiece['role']): GhostPiece[] => regions.map((region) => ({ page: region.page, rect: region.rect, role }));

function exerciseRows(result: Extract<BookResult, { kind: 'exercises' }>, existing: ReadonlyMap<string, Frame>): BookRow[] {
  const rows: BookRow[] = [];
  const seen = new Set<string>();
  for (const section of result.exercises.sections) {
    for (const proposal of section.proposals) {
      const key = bookReference(proposal.section, proposal.label);
      if (seen.has(key)) continue;
      seen.add(key);
      const frame = existing.get(bookKey(proposal.section, proposal.label));
      const state: BookState = frame === undefined ? 'new' : compareWithProposal(frame, proposal) === 'unchanged' ? 'same' : 'different';
      rows.push({
        key,
        section: proposal.section,
        label: proposal.label,
        page: proposal.page,
        pieces: [{ page: proposal.page, rect: proposal.rect, role: 'main' }, ...regionPieces(proposal.context, 'context'), ...regionPieces(proposal.continues ?? [], 'continues')],
        title: proposal.title,
        confidence: proposal.confidence,
        evidence: proposal.evidence,
        state,
        frame,
        changes: state === 'different' && frame !== undefined ? exerciseChanges(frame, proposal) : [],
        refusal: LIMITS.labelPattern.test(proposal.label)
          ? undefined
          : `the number "${proposal.label}" is not a label the bundle allows (1 to ${LIMITS.labelMax} letters, digits, spaces and . _ - ( ) /, starting with a letter or digit)`,
        proposal,
      });
    }
  }
  return rows;
}

function solutionRows(result: Extract<BookResult, { kind: 'solutions' }>, existing: ReadonlyMap<string, Frame>): BookRow[] {
  const rows: BookRow[] = [];
  const seen = new Set<string>();
  for (const section of result.solutions.sections) {
    for (const answer of section.answers) {
      const key = bookReference(answer.section, answer.label);
      const frame = existing.get(bookKey(answer.section, answer.label));
      if (frame === undefined || seen.has(key) || answer.regions.length === 0) continue;
      seen.add(key);
      const compared = compareSolution(frame, answer.regions);
      const first = answer.regions[0] as Region;
      rows.push({
        key,
        section: answer.section,
        label: answer.label,
        page: first.page,
        pieces: regionPieces(answer.regions, 'solution'),
        title: answer.text,
        confidence: answer.confidence,
        evidence: answer.evidence,
        state: compared === 'unchanged' ? 'same' : compared === 'needs-solution' ? 'new' : 'different',
        frame,
        changes: compared === 'changed' ? ['its solution is somewhere else in the answer key'] : [],
        refusal: answer.regions.length > LIMITS.maxSolutionRegions ? `its answer would need ${answer.regions.length} regions, at most ${LIMITS.maxSolutionRegions} are allowed` : undefined,
        proposal: answer,
      });
    }
  }
  return rows;
}

/** The book exercises of the project by (section, label). */
function existingBook(frames: readonly Frame[]): Map<string, Frame> {
  const existing = new Map<string, Frame>();
  for (const frame of frames) {
    const key = bookKeyOf(frame);
    if (key !== undefined) existing.set(key, frame);
  }
  return existing;
}

/** The section and number of every book exercise of the project (what the answers are matched to). */
export function exerciseRefs(frames: readonly Frame[]): { section: string; label: string }[] {
  const refs: { section: string; label: string }[] = [];
  for (const frame of frames) if (bookKeyOf(frame) !== undefined) refs.push({ section: frame.section as string, label: frame.label as string });
  return refs;
}

// ---------------------------------------------------------------------------------------------------------- findings

function findingsOf(result: BookResult, rows: readonly BookRow[], existing: ReadonlyMap<string, Frame>): FindingGroup[] {
  const groups: FindingGroup[] = [];
  const add = (title: string, lines: FindingGroup['lines']): void => {
    if (lines.length > 0) groups.push({ title, lines });
  };
  const refused = rows.filter((row) => row.refusal !== undefined);
  if (result.kind === 'exercises') {
    const sections = result.exercises.sections;
    add(
      'Numbers missing from a section',
      sections.filter((section) => section.gaps.length > 0).map((section) => ({ section: section.section, text: `${section.section}: ${listed(section.gaps)} ${section.gaps.length === 1 ? 'is' : 'are'} missing between ${section.first as string} and ${section.last as string}` })),
    );
    add(
      'Printed more than once',
      sections.filter((section) => section.duplicates.length > 0).map((section) => ({ section: section.section, text: `${section.section}: ${listed(section.duplicates)}` })),
    );
    add(
      'Looked like exercises, left out',
      sections.flatMap((section) => section.rejected.slice(0, 3).map((start) => ({ section: section.section, text: `${section.section}, page ${start.page + 1}: "${start.text.slice(0, 40)}" ${inWindowPages(start.reason)}` }))).slice(0, 30),
    );
    const proposed = new Set(rows.map((row) => bookKey(row.section, row.label)));
    const searched = new Set(sections.map((section) => section.section));
    const notProposed: string[] = [];
    for (const [key, frame] of existing) if (!proposed.has(key) && frame.section !== undefined && searched.has(frame.section)) notProposed.push(bookReference(frame.section, frame.label as string));
    add('In the book, but not found now (left as they are)', notProposed.length > 0 ? [{ text: listed(notProposed, 24) }] : []);
    add('Notes of the search', [...new Set([...sections.flatMap((section) => section.notes.map((note) => `${section.section}: ${note}`)), ...result.notes])].map((text) => ({ text: inWindowPages(text) })).slice(0, 60));
  } else {
    const answered = new Set(rows.map((row) => bookKey(row.section, row.label)));
    const covered = new Set(result.solutions.sections.filter((section) => section.answers.length > 0).map((section) => section.section));
    const withoutExercise: Map<string, string[]> = new Map();
    for (const section of result.solutions.sections) {
      for (const answer of section.answers) {
        if (existing.has(bookKey(answer.section, answer.label))) continue;
        const labels = withoutExercise.get(answer.section) ?? [];
        labels.push(answer.label);
        withoutExercise.set(answer.section, labels);
      }
    }
    add(
      'Answers without an exercise in the book',
      [...withoutExercise].map(([section, labels]) => ({ section, text: `${section}: ${listed(labels)}` })),
    );
    const withoutAnswer = new Map<string, string[]>();
    for (const frame of existing.values()) {
      if (frame.section === undefined || !covered.has(frame.section) || answered.has(bookKey(frame.section, frame.label as string))) continue;
      const labels = withoutAnswer.get(frame.section) ?? [];
      labels.push(frame.label as string);
      withoutAnswer.set(frame.section, labels);
    }
    add(
      'Exercises without an answer',
      [...withoutAnswer].map(([section, labels]) => ({ section, text: `${section}: ${listed(labels)}` })),
    );
    add(
      'Numbers missing from the answers of a section',
      result.solutions.sections.filter((section) => section.gaps.length > 0).map((section) => ({ section: section.section, text: `${section.section}: ${listed(section.gaps)} ${section.gaps.length === 1 ? 'is' : 'are'} missing between ${section.first as string} and ${section.last as string}` })),
    );
    add(
      'Printed more than once',
      result.solutions.sections.filter((section) => section.duplicates.length > 0).map((section) => ({ section: section.section, text: `${section.section}: ${listed(section.duplicates)}` })),
    );
    add('Notes of the search', [...new Set([...result.solutions.sections.flatMap((section) => section.notes.map((note) => `${section.section}: ${note}`)), ...result.notes])].map((text) => ({ text: inWindowPages(text) })).slice(0, 60));
  }
  add('Left out', refused.map((row) => ({ section: row.section, text: `${row.key}: ${row.refusal as string}` })).slice(0, 30));
  return groups;
}

// ------------------------------------------------------------------------------------------------------------- rows

const cache = new WeakMap<object, WeakMap<readonly Frame[], BookRows>>();

/** The rows of a result against a version of the project's frames (built once per pair). */
export function bookRows(result: BookResult, frames: readonly Frame[]): BookRows {
  let byFrames = cache.get(result);
  if (!byFrames) {
    byFrames = new WeakMap();
    cache.set(result, byFrames);
  }
  const cached = byFrames.get(frames);
  if (cached) return cached;
  const existing = existingBook(frames);
  const rows = result.kind === 'exercises' ? exerciseRows(result, existing) : solutionRows(result, existing);
  const counts: BookCounts = { total: rows.length, new: 0, different: 0, same: 0, unsure: 0, refused: 0 };
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.confidence < SURE_FROM) counts.unsure += 1;
    if (row.refusal !== undefined) counts.refused += 1;
  }
  const built: BookRows = { rows, byKey: new Map(rows.map((row) => [row.key, row])), counts, findings: findingsOf(result, rows, existing) };
  byFrames.set(frames, built);
  return built;
}

export interface ViewOptions {
  filter: BookFilter;
  confidence: ConfidenceFilter;
  rejected: Readonly<Record<string, true>>;
  /** Text to find in the number, the section and the first line. */
  query?: string;
}

/** The rows the list shows: by state, by confidence, without those the person rejected (unless that is what is asked for), by a text. */
export function viewRows(rows: readonly BookRow[], options: ViewOptions): BookRow[] {
  const query = (options.query ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    const rejected = options.rejected[row.key] === true;
    if (options.filter === 'rejected' ? !rejected : rejected) return false;
    if (options.filter === 'todo' && row.state === 'same') return false;
    if (options.filter === 'new' && row.state !== 'new') return false;
    if (options.filter === 'different' && row.state !== 'different') return false;
    if (options.filter === 'same' && row.state !== 'same') return false;
    if (options.confidence === 'sure' && row.confidence < SURE_FROM) return false;
    if (options.confidence === 'unsure' && row.confidence >= SURE_FROM) return false;
    if (query !== '' && !`${row.key} ${row.title}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** What is ticked when a result arrives: every row the project does not have and that can be applied. A different row needs the person's tick. */
export function defaultTicks(rows: readonly BookRow[]): Record<string, true> {
  const ticks: Record<string, true> = {};
  for (const row of rows) if (row.state === 'new' && row.refusal === undefined) ticks[row.key] = true;
  return ticks;
}

/** The ghosts of the rows on each page, built once for a list of rows (a page shows only its own). */
const pieceCache = new WeakMap<readonly BookRow[], Map<number, { row: BookRow; piece: GhostPiece }[]>>();

export function ghostsOn(rows: readonly BookRow[], page: number): readonly { row: BookRow; piece: GhostPiece }[] {
  let pages = pieceCache.get(rows);
  if (!pages) {
    pages = new Map();
    for (const row of rows) {
      for (const piece of row.pieces) {
        const list = pages.get(piece.page);
        if (list) list.push({ row, piece });
        else pages.set(piece.page, [{ row, piece }]);
      }
    }
    pieceCache.set(rows, pages);
  }
  return pages.get(page) ?? [];
}

// ------------------------------------------------------------------------------------------------------------- apply

export interface BookPlan {
  /** The batch: in the order of the rows, the way the command line writes it. */
  operations: Operation[];
  /** New exercises, or answers given to exercises that had none. */
  added: number;
  /** Exercises or answers that were there and are overwritten. */
  replaced: number;
  /** Rows asked for that are the same as the project's already. */
  skipped: number;
  /** Rows asked for that cannot be applied, with the reason. */
  refused: BookRow[];
}

/** The operations for the rows with these keys: a new row is added, a different one replaces the project's (the person ticked it), the same is skipped. */
export function planBook(kind: BookKind, rows: readonly BookRow[], keys: ReadonlySet<string>): BookPlan {
  const plan: BookPlan = { operations: [], added: 0, replaced: 0, skipped: 0, refused: [] };
  for (const row of rows) {
    if (!keys.has(row.key)) continue;
    if (row.refusal !== undefined) {
      plan.refused.push(row);
      continue;
    }
    if (row.state === 'same') {
      plan.skipped += 1;
      continue;
    }
    if (kind === 'exercises') {
      plan.operations.push(exerciseToOperation(row.proposal as ExerciseProposal, row.state === 'different' ? { replace: true } : {}) as Operation);
    } else {
      plan.operations.push(solutionToOperation(row.key, (row.proposal as SolutionProposal).regions));
    }
    if (row.state === 'different') plan.replaced += 1;
    else plan.added += 1;
  }
  return plan;
}

/** One line that says what was done, for the panel and the notice. */
export function describePlan(kind: BookKind, plan: BookPlan): string {
  const parts: string[] = [];
  if (kind === 'exercises') {
    if (plan.added > 0) parts.push(`added ${word(plan.added, 'book exercise')}`);
    if (plan.replaced > 0) parts.push(`replaced ${word(plan.replaced, 'book exercise')}`);
  } else {
    if (plan.added > 0) parts.push(`gave ${word(plan.added, 'exercise')} their solution`);
    if (plan.replaced > 0) parts.push(`replaced ${word(plan.replaced, 'solution')}`);
  }
  let text = parts.length > 0 ? `${parts.join(', ')}` : 'nothing to do';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (plan.refused.length > 0) text += `; ${plan.refused.length} left out (${listed(plan.refused.map((row) => row.key), 4)})`;
  return `${text}. Undo takes it back.`;
}
