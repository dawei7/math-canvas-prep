import { isAuthoritative } from '../model/authority.js';
import { compareReadingOrder, countFrames } from '../model/numbering.js';
import type { DocumentInfo, Frame, OutlineEntry } from '../model/types.js';
import { infoForFile } from '../rules/info.js';
import { FORMAT } from '../rules/constants.js';
import { VERSION } from '../version.js';
import { buildSectionTree, countSections, exercisesBySection } from './sections.js';

/**
 * The summary of an audited book: what it is, how it is divided into sections and how many authoritative exercises (and
 * solutions) each section holds. It is what `mcprep book show --json` prints and `mcprep book export` writes, and it is the
 * same for a project and for a bundle that was read back. Plain JSON, camelCase, pages zero-based (documented in
 * docs/PROJECT_FILE.md and schemas/book-summary.schema.json).
 */

export const BOOK_SUMMARY_FORMAT = 'math-canvas-book-summary';

export interface BookSummaryExercise {
  /** The frame id in the project or bundle. */
  id: string;
  /** The number as the book prints it. */
  label: string;
  page: number;
  /** How many solution regions the exercise has. */
  solutionRegions: number;
}

export interface BookSectionSummary {
  /** The position of the entry in the outline (reading order), from 0. */
  index: number;
  /** The id that exercises name; absent for an entry that has none. */
  id?: string;
  /** The number printed with the heading. */
  label?: string;
  title: string;
  /** Zero-based page where the heading is. */
  page: number;
  /** Where the heading starts on its page, from the top (0 to 1), when known. */
  top?: number;
  depth: number;
  /** `index` of the entry above this one, or null for a top-level entry. */
  parent: number | null;
  /** Authoritative exercises filed under this entry. */
  exercises: number;
  /** The same for this entry and everything below it. */
  exercisesTotal: number;
  /** Of `exercises`, how many have at least one solution region. */
  withSolution: number;
  withSolutionTotal: number;
  /** The labels of the first and the last of this entry's own exercises, in reading order. */
  firstLabel?: string;
  lastLabel?: string;
  /** Only with `exercises: true`: this entry's own exercises in reading order. */
  items?: BookSummaryExercise[];
}

export interface BookSummary {
  format: typeof BOOK_SUMMARY_FORMAT;
  version: 1;
  generator: { name: string; version: string };
  document: DocumentInfo & {
    title: string;
    folder?: string;
    pageCount: number;
    /** Of the PDF the summary was made for, when known. */
    sha256?: string;
    bytes?: number;
  };
  /** Every entry of the outline in reading order, the sections first among them. */
  sections: BookSectionSummary[];
  totals: {
    /** Number of outline entries. */
    sections: number;
    /** Number of outline entries that have an id (the ones exercises can name). */
    sectionsWithId: number;
    /** Authoritative exercises, and how many have a solution. */
    exercises: number;
    withSolution: number;
    withoutSolution: number;
    /** Authoritative exercises whose section is not in the outline (an error that validation reports). */
    unfiled: number;
    /** What a person framed for themselves in the same document (positional, parts of a unit counting once). */
    ordinary: { exercises: number; questions: number; bookmarks: number };
  };
}

export interface BookSummaryInput {
  title: string;
  folder?: string | undefined;
  info?: DocumentInfo | undefined;
  pageCount: number;
  sha256?: string | undefined;
  bytes?: number | undefined;
  frames: readonly Frame[];
  outline: readonly OutlineEntry[] | undefined;
  /** Also list each section's own exercises. */
  exercises?: boolean | undefined;
}

export function buildBookSummary(input: BookSummaryInput): BookSummary {
  const entries = input.outline ?? [];
  const tree = buildSectionTree(entries, input.pageCount);
  const counts = countSections(tree, input.frames);
  const groups = exercisesBySection(input.frames);
  const ordinary = countFrames(input.frames);
  const sections = tree.nodes.map((node): BookSectionSummary => {
    const count = counts.perNode[node.index] as (typeof counts.perNode)[number];
    const entry = node.entry;
    const own = node.id !== undefined && tree.byId.get(node.id) === node.index ? (groups.get(node.id) ?? []) : [];
    const out: BookSectionSummary = { index: node.index, title: entry.title, page: entry.page, depth: entry.depth, parent: node.parent >= 0 ? node.parent : null, exercises: count.exercises, exercisesTotal: count.exercisesTotal, withSolution: count.withSolution, withSolutionTotal: count.withSolutionTotal };
    if (entry.id !== undefined) out.id = entry.id;
    if (entry.label !== undefined) out.label = entry.label;
    if (entry.top !== undefined) out.top = entry.top;
    if (own.length > 0) {
      out.firstLabel = own[0]?.label as string;
      out.lastLabel = own[own.length - 1]?.label as string;
    }
    if (input.exercises === true) {
      out.items = own.map((frame) => ({ id: frame.id, label: frame.label as string, page: frame.page, solutionRegions: frame.solution?.length ?? 0 }));
    }
    return out;
  });
  const document: BookSummary['document'] = { title: input.title, pageCount: input.pageCount };
  if (input.folder !== undefined) document.folder = input.folder;
  Object.assign(document, infoForFile(input.info ?? {}));
  if (input.sha256 !== undefined) document.sha256 = input.sha256;
  if (input.bytes !== undefined) document.bytes = input.bytes;
  return {
    format: BOOK_SUMMARY_FORMAT,
    version: 1,
    generator: { name: FORMAT.generatorName, version: VERSION },
    document,
    sections,
    totals: {
      sections: tree.nodes.length,
      sectionsWithId: tree.byId.size,
      exercises: counts.totals.exercises,
      withSolution: counts.totals.withSolution,
      withoutSolution: counts.totals.exercises - counts.totals.withSolution,
      unfiled: counts.unplaced.length,
      ordinary: { exercises: ordinary.exercise, questions: ordinary.question, bookmarks: ordinary.bookmark },
    },
  };
}

/** The authoritative exercises in the order of the book: by section (outline order), then reading order. */
export function bookExercisesInOrder(frames: readonly Frame[], outline: readonly OutlineEntry[] | undefined): Frame[] {
  const order = new Map<string, number>();
  (outline ?? []).forEach((entry, index) => {
    if (entry.id !== undefined && !order.has(entry.id)) order.set(entry.id, index);
  });
  return frames
    .filter(isAuthoritative)
    .sort((a, b) => (order.get(a.section as string) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.section as string) ?? Number.MAX_SAFE_INTEGER) || compareReadingOrder(a, b));
}
