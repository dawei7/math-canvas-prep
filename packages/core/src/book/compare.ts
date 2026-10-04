import { isAuthoritative } from '../model/authority.js';
import type { Frame } from '../model/types.js';
import { McPrepError } from '../rules/issues.js';
import type { BookSummary } from './summary.js';

/**
 * `mcprep book compare`: the audited book against a reference list of its sections (the owner's own list of the book: per section the
 * number of exercises it prints), section by section. Pure: the reference is plain JSON, nothing is read from the network.
 */

export const COMPARE_FORMAT = 'math-canvas-compare';
export const COMPARE_VERSION = 1;

/** One section of the reference. */
export interface ReferenceSection {
  label: string;
  title?: string;
  count: number;
  chapterLabel?: string;
  chapterTitle?: string;
}

const fail = (message: string): never => {
  throw new McPrepError('E_USAGE', message, {
    hint: 'A reference is JSON of one of two forms: { "chapters": [{ "number": 1, "title": "...", "sections": [{ "number": 1, "title": "...", "exercise_count": 40 }] }] } (the section 1 of chapter 1 is "1.1"; --chapter-offset adds to the chapter number), or { "sections": [{ "label": "1.1", "title": "...", "exercise_count": 40 }] } ("count" is accepted for "exercise_count").',
  });
};

const countOf = (entry: Record<string, unknown>, where: string): number => {
  const value = entry['exercise_count'] ?? entry['exerciseCount'] ?? entry['count'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return fail(`${where} has no exercise count: "exercise_count" must be a whole number from 0.`);
  return value;
};

const record = (value: unknown, where: string): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(`${where} is not an object.`));

/** The sections of a reference in either of the two forms. `chapterOffset` is added to the chapter numbers of the form with chapters. */
export function parseReference(raw: unknown, chapterOffset = 0): ReferenceSection[] {
  const root = record(raw, 'The reference');
  const sections: ReferenceSection[] = [];
  if (Array.isArray(root['chapters'])) {
    root['chapters'].forEach((value, index) => {
      const chapter = record(value, `Chapter ${index + 1} of the reference`);
      const number = chapter['number'];
      const chapterNumber = typeof number === 'number' ? number + chapterOffset : Number.isFinite(Number(number)) && String(number).trim() !== '' ? Number(number) + chapterOffset : undefined;
      if (chapterNumber === undefined) fail(`Chapter ${index + 1} of the reference has no "number".`);
      if (!Array.isArray(chapter['sections'])) fail(`Chapter ${String(chapterNumber)} of the reference has no "sections" list.`);
      for (const sectionValue of chapter['sections'] as unknown[]) {
        const section = record(sectionValue, `A section of chapter ${String(chapterNumber)} of the reference`);
        const label = `${String(chapterNumber)}.${String(section['number'])}`;
        sections.push({
          label,
          ...(typeof section['title'] === 'string' ? { title: section['title'] } : {}),
          count: countOf(section, `The section ${label} of the reference`),
          chapterLabel: String(chapterNumber),
          ...(typeof chapter['title'] === 'string' ? { chapterTitle: chapter['title'] } : {}),
        });
      }
    });
  } else if (Array.isArray(root['sections'])) {
    root['sections'].forEach((value, index) => {
      const section = record(value, `Section ${index + 1} of the reference`);
      if (typeof section['label'] !== 'string' || section['label'].trim() === '') fail(`Section ${index + 1} of the reference has no "label".`);
      const label = (section['label'] as string).trim();
      sections.push({ label, ...(typeof section['title'] === 'string' ? { title: section['title'] } : {}), count: countOf(section, `The section ${label} of the reference`) });
    });
  } else fail('The reference has neither "chapters" nor "sections".');
  const seen = new Set<string>();
  for (const section of sections) {
    if (seen.has(section.label)) fail(`The reference lists the section ${section.label} twice.`);
    seen.add(section.label);
  }
  return sections;
}

/** A title as it is compared: compatibility forms folded, "&" as "and", case and punctuation ignored. */
export function titleForCompare(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export type CompareStatus = 'equal' | 'count' | 'missing' | 'extra';

export interface CompareSection {
  label: string;
  /** The id exercises name; null for a section of the reference that the outline does not have. */
  id: string | null;
  title: string | null;
  referenceTitle: string | null;
  count: number | null;
  referenceCount: number | null;
  /** The audited count minus the reference count; null when the section is on one side only. */
  difference: number | null;
  firstLabel: string | null;
  lastLabel: string | null;
  /** The zero-based pages of the first and the last exercise of the section. */
  firstPage: number | null;
  lastPage: number | null;
  titleDiffers: boolean;
  status: CompareStatus;
}

export interface CompareDifference {
  kind: 'count' | 'missing' | 'extra' | 'title';
  label: string;
  message: string;
}

export interface CompareChapter {
  label: string;
  title: string | null;
  sections: number;
  referenceExercises: number;
  exercises: number;
  /** Sections of the chapter that have the same count on both sides. */
  equal: number;
}

export interface CompareReport {
  format: typeof COMPARE_FORMAT;
  version: typeof COMPARE_VERSION;
  reference: { sections: number; exercises: number };
  audited: { sections: number; exercises: number };
  totals: { referenceExercises: number; exercises: number; difference: number };
  sections: CompareSection[];
  chapters: CompareChapter[];
  /** Every count that differs, every section on one side only, every title that differs after normalising: what must be looked at. */
  differences: CompareDifference[];
}

/** Compares what the audit stored with the reference, section by section, matching sections by the label the book prints. */
export function compareBook(summary: BookSummary, frames: readonly Frame[], reference: readonly ReferenceSection[]): CompareReport {
  const pages = new Map<string, { first: number; last: number }>();
  for (const frame of frames) {
    if (!isAuthoritative(frame) || frame.section === undefined) continue;
    const held = pages.get(frame.section);
    if (held) {
      held.first = Math.min(held.first, frame.page);
      held.last = Math.max(held.last, frame.page);
    } else pages.set(frame.section, { first: frame.page, last: frame.page });
  }
  // The outline entries by label; of several with one label the one that holds exercises.
  const byLabel = new Map<string, BookSummary['sections'][number]>();
  for (const entry of summary.sections) {
    if (entry.label === undefined) continue;
    const held = byLabel.get(entry.label);
    if (held === undefined || (held.exercises === 0 && entry.exercises > 0)) byLabel.set(entry.label, entry);
  }
  const referenced = new Set(reference.map((entry) => entry.label));
  const rows: CompareSection[] = [];
  const differences: CompareDifference[] = [];
  const place = (entry: BookSummary['sections'][number] | undefined): Pick<CompareSection, 'firstPage' | 'lastPage' | 'firstLabel' | 'lastLabel'> => {
    const held = entry?.id !== undefined ? pages.get(entry.id) : undefined;
    return { firstPage: held?.first ?? null, lastPage: held?.last ?? null, firstLabel: entry?.firstLabel ?? null, lastLabel: entry?.lastLabel ?? null };
  };
  for (const wanted of reference) {
    const entry = byLabel.get(wanted.label);
    if (entry === undefined) {
      rows.push({ label: wanted.label, id: null, title: null, referenceTitle: wanted.title ?? null, count: null, referenceCount: wanted.count, difference: null, firstLabel: null, lastLabel: null, firstPage: null, lastPage: null, titleDiffers: false, status: 'missing' });
      differences.push({ kind: 'missing', label: wanted.label, message: `The reference has the section ${wanted.label}${wanted.title !== undefined ? ` "${wanted.title}"` : ''} (${wanted.count} exercises); the outline of the audit has no section with that label.` });
      continue;
    }
    const titleDiffers = wanted.title !== undefined && titleForCompare(wanted.title) !== titleForCompare(entry.title);
    const difference = entry.exercises - wanted.count;
    rows.push({
      label: wanted.label,
      id: entry.id ?? null,
      title: entry.title,
      referenceTitle: wanted.title ?? null,
      count: entry.exercises,
      referenceCount: wanted.count,
      difference,
      ...place(entry),
      titleDiffers,
      status: difference === 0 ? 'equal' : 'count',
    });
    if (difference !== 0) {
      differences.push({ kind: 'count', label: wanted.label, message: `Section ${wanted.label}: the audit has ${entry.exercises} exercises, the reference ${wanted.count} (${difference > 0 ? '+' : ''}${difference}).` });
    }
    if (titleDiffers) differences.push({ kind: 'title', label: wanted.label, message: `Section ${wanted.label}: the title of the audit is "${entry.title}", the reference's "${wanted.title as string}".` });
  }
  for (const entry of summary.sections) {
    if (entry.exercises === 0) continue;
    const label = entry.label ?? entry.id ?? `#${entry.index}`;
    if (entry.label !== undefined && referenced.has(entry.label)) continue;
    rows.push({ label, id: entry.id ?? null, title: entry.title, referenceTitle: null, count: entry.exercises, referenceCount: null, difference: null, ...place(entry), titleDiffers: false, status: 'extra' });
    differences.push({ kind: 'extra', label, message: `The audit has ${entry.exercises} exercises in "${entry.title}" (${label}); the reference has no such section.` });
  }

  const chapters = new Map<string, CompareChapter>();
  const chapterOf = (row: CompareSection, wanted: ReferenceSection | undefined): string => wanted?.chapterLabel ?? row.label.split('.')[0] ?? row.label;
  const wantedBy = new Map(reference.map((entry) => [entry.label, entry]));
  for (const row of rows) {
    const wanted = wantedBy.get(row.label);
    const label = chapterOf(row, wanted);
    const held = chapters.get(label) ?? { label, title: wanted?.chapterTitle ?? null, sections: 0, referenceExercises: 0, exercises: 0, equal: 0 };
    held.sections += 1;
    held.referenceExercises += row.referenceCount ?? 0;
    held.exercises += row.count ?? 0;
    if (row.status === 'equal') held.equal += 1;
    if (held.title === null && wanted?.chapterTitle !== undefined) held.title = wanted.chapterTitle;
    chapters.set(label, held);
  }
  const referenceExercises = reference.reduce((sum, entry) => sum + entry.count, 0);
  return {
    format: COMPARE_FORMAT,
    version: COMPARE_VERSION,
    reference: { sections: reference.length, exercises: referenceExercises },
    audited: { sections: summary.sections.filter((entry) => entry.exercises > 0).length, exercises: summary.totals.exercises },
    totals: { referenceExercises, exercises: summary.totals.exercises, difference: summary.totals.exercises - referenceExercises },
    sections: rows,
    chapters: [...chapters.values()],
    differences,
  };
}
