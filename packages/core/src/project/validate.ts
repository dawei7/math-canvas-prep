import { countBook, countFrames, numberFrames, type FrameNumber } from '../model/numbering.js';
import type { FrameKind, PageText } from '../model/types.js';
import { checkBook, lintBook } from '../rules/book.js';
import { checkTitle, cleanFolder } from '../rules/document.js';
import { checkFrames } from '../rules/frames.js';
import { checkDocumentInfo } from '../rules/info.js';
import { issue, summarize, type Issue, type ValidationResult } from '../rules/issues.js';
import { lintAgainstText, lintFrames } from '../rules/lint.js';
import { checkOutline } from '../rules/outline.js';
import type { Project } from './model.js';

export interface ProjectValidation extends ValidationResult {
  /** Positional counts: exercises you framed for yourself (a unit counts once), questions, bookmarks. */
  counts: Record<FrameKind, number>;
  /** The positional numbers; authoritative exercises have none (they are named by their label). */
  numbers: FrameNumber[];
  /** The authoritative exercises: how many, and how many have a solution. */
  book: { exercises: number; withSolution: number };
}

/**
 * Everything the importer would say about the project's frames and outline (errors and repairs), plus warnings.
 * `text` holds the analysed text of pages (optional) for the checks that look at the printed lines.
 */
export function validateProject(project: Project, text?: ReadonlyMap<number, PageText>): ProjectValidation {
  const issues: Issue[] = [];
  const checked = checkFrames(project.frames, { pageCount: project.pdf.pageCount, strictShapes: true });
  issues.push(...checked.issues);

  const title = checkTitle(project.meta.title);
  if (title.problem) issues.push(issue('error', 'title', title.problem, { fix: 'Set a title of 1 to 200 characters (`mcprep meta --title ...`).' }));
  for (const repair of cleanFolder(project.meta.folder).repairs) issues.push(issue('repair', 'folder-cleaned', repair));
  issues.push(...checkDocumentInfo(project.meta, { strict: true, where: 'meta' }).issues);

  if (project.outline) {
    issues.push(...checkOutline(project.outline.entries, project.pdf.pageCount).issues);
  }
  issues.push(...checkBook(checked.frames, project.outline?.entries));

  issues.push(...lintFrames(checked.frames));
  issues.push(...lintBook(checked.frames, project.outline?.entries, project.pdf.pageCount));
  if (text) issues.push(...lintAgainstText(checked.frames, text));

  const numbers = numberFrames(project.frames);
  return { ...summarize(issues), counts: countFrames(project.frames), numbers: [...numbers.values()], book: countBook(project.frames) };
}
