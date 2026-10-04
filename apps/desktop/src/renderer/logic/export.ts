import type { BundleFeature, OutlineEntry, Project } from '@mcprep/core/pure';
import type { BookModel, FrameIndex } from './model.js';
import { buildSectionRows } from './sections.js';

/**
 * What the export dialog tells before anything is written: which optional parts of the format the bundle will use, what it
 * will contain (what a person framed for themselves, the book exercises per section, how many have a solution). The
 * features are decided the way the bundle writer decides them.
 */

export type ExportOutline = 'project' | 'pdf' | 'none';

export interface ExportSectionRow {
  index: number;
  title: string;
  label: string | undefined;
  depth: number;
  /** Book exercises filed under the section itself, and under it and everything below it. */
  own: number;
  total: number;
  /** Of the section's own exercises, how many have a hidden solution; and of all below it. */
  ownSolved: number;
  totalSolved: number;
}

export interface ExportFacts {
  features: BundleFeature[];
  ordinary: { exercises: number; questions: number; bookmarks: number };
  book: { exercises: number; withSolution: number; withoutSolution: number; sections: number; sectionsWithExercises: number; unfiled: number };
  /** The sections that hold book exercises (or have them below), in the order of the book. */
  sections: ExportSectionRow[];
}

export function exportFacts(project: Project, outline: ExportOutline, pdfOutline: readonly OutlineEntry[] | null, index: FrameIndex, model: BookModel): ExportFacts {
  const carried = outline === 'project' ? project.outline?.entries : outline === 'pdf' ? (pdfOutline ?? undefined) : undefined;
  const features: BundleFeature[] = [];
  if (carried?.some((entry) => entry.id !== undefined)) features.push('sections');
  if (index.book.length > 0) features.push('authority');
  if (project.frames.some((frame) => frame.solution !== undefined && frame.solution.length > 0)) features.push('solution');
  const sections: ExportSectionRow[] = buildSectionRows(model, { collapsed: {}, filter: 'all' })
    .filter((row) => row.total > 0)
    .map((row) => ({ index: row.index, title: row.entry.title, label: row.entry.label, depth: row.depth, own: row.own, total: row.total, ownSolved: row.ownSolved, totalSolved: row.totalSolved }));
  return {
    features,
    ordinary: { exercises: index.counts.exercise, questions: index.counts.question, bookmarks: index.counts.bookmark },
    book: {
      exercises: index.book.length,
      withSolution: index.bookWithSolution,
      withoutSolution: index.book.length - index.bookWithSolution,
      sections: model.entries.length,
      sectionsWithExercises: sections.filter((row) => row.own > 0).length,
      unfiled: model.unplaced.length,
    },
    sections,
  };
}

/** What a feature of the format means, for a person: also what an older reader does with it. */
export const FEATURE_TEXT: Record<BundleFeature, { name: string; text: string }> = {
  sections: { name: 'Sections', text: 'The contents carry ids, so that exercises can name the section they belong to.' },
  authority: { name: 'Book exercises', text: 'Exercises that keep the number the book prints. An app that does not know them shows them as ordinary exercises.' },
  solution: { name: 'Hidden solutions', text: 'Answers (regions of this PDF) to grade with. Never shown to the learner; an app that does not know them ignores them.' },
};

export const percent = (part: number, whole: number): string => (whole === 0 ? '0%' : `${Math.round((100 * part) / whole)}%`);
