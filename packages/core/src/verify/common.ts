import { bookReference, isAuthoritative, normalizeLabel } from '../model/authority.js';
import { compareReadingOrder } from '../model/numbering.js';
import type { Frame, OutlineEntry } from '../model/types.js';
import { buildSectionTree, type SectionTree } from '../book/sections.js';
import { foldLabel } from './labels.js';
import type { FindingSeverity, VerifyCode, VerifyFinding } from './types.js';

/** Where a finding sorts: the section (in the order of the outline), then the place on the pages. */
export interface Where {
  section: number;
  page: number;
  top: number;
  left: number;
}

/** A finding together with the position it sorts at. */
export interface Draft {
  finding: VerifyFinding;
  where: Where;
  /** Findings of one code with a greater weight come first (the worst edge on ink); without one, they follow the order of the book. */
  weight?: number;
}

/** An exercise frame as the checks see it. */
export interface Exercise {
  frame: Frame;
  /** `SECTION:LABEL` for an authoritative exercise, else the frame id. */
  ref: string;
  /** An authoritative exercise that has a label and a section. */
  book: boolean;
  section: string | undefined;
  /** The label as the checks compare it (closing punctuation dropped, folded). */
  label: string | undefined;
  where: Where;
  /** The position in the order of the book (the index in `Prepared.exercises`). */
  order: number;
}

export interface Prepared {
  /** In the order of the book: the sections in outline order, each in reading order; ordinary exercises last. */
  exercises: Exercise[];
  tree: SectionTree;
  /** The rank of a section id: its place in the outline; ids the outline does not have follow, in alphabetical order. */
  sectionRank(id: string | undefined): number;
}

/** Ranks from here on belong to sections the outline does not have, then to ordinary exercises (which have no section). */
const UNKNOWN_RANK = 1_000_000;
const ORDINARY_RANK = 2_000_000;

export function draft(code: VerifyCode, severity: FindingSeverity, ref: string, page: number | null, message: string, evidence: string, where: Where): Draft {
  return { finding: { code, severity, ref, page, message, evidence }, where };
}

/** The exercises to check, sorted into the order of the book, with their references and positions. */
export function prepare(frames: readonly Frame[], outline: readonly OutlineEntry[] | undefined, pageCount: number, only: ReadonlySet<string> | undefined): Prepared {
  const tree = buildSectionTree(outline ?? [], pageCount);
  const unknown = new Set<string>();
  const chosen: Frame[] = [];
  for (const frame of frames) {
    if (frame.kind !== 'exercise') continue;
    const book = isAuthoritative(frame) && frame.section !== undefined && frame.label !== undefined;
    if (only !== undefined && !(book && only.has(frame.section as string))) continue;
    chosen.push(frame);
    if (book && !tree.byId.has(frame.section as string)) unknown.add(frame.section as string);
  }
  const unknownRank = new Map([...unknown].sort().map((id, index) => [id, UNKNOWN_RANK + index] as const));
  const sectionRank = (id: string | undefined): number => (id === undefined ? ORDINARY_RANK : (tree.byId.get(id) ?? unknownRank.get(id) ?? UNKNOWN_RANK));
  const exercises = chosen.map((frame): Exercise => {
    const book = isAuthoritative(frame) && frame.section !== undefined && frame.label !== undefined;
    const section = book ? frame.section : undefined;
    return {
      frame,
      book,
      section,
      label: book ? foldLabel(frame.label as string) : undefined,
      ref: book ? bookReference(section as string, normalizeLabel(frame.label as string).label) : frame.id,
      where: { section: sectionRank(section), page: frame.page, top: frame.rect.top, left: frame.rect.left },
      order: 0,
    };
  });
  exercises.sort((a, b) => a.where.section - b.where.section || compareReadingOrder(a.frame, b.frame));
  exercises.forEach((exercise, index) => {
    exercise.order = index;
  });
  return { exercises, tree, sectionRank };
}

/** A measure rounded for a message: `0.123`. */
export const measure = (value: number, digits = 4): string => String(Math.round(value * 10 ** digits) / 10 ** digits);
