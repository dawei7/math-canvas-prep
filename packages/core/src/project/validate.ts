import { countFrames, numberFrames, type FrameNumber } from '../model/numbering.js';
import type { FrameKind, PageText } from '../model/types.js';
import { checkTitle, cleanFolder } from '../rules/document.js';
import { checkFrames } from '../rules/frames.js';
import { issue, summarize, type Issue, type ValidationResult } from '../rules/issues.js';
import { lintAgainstText, lintFrames } from '../rules/lint.js';
import { checkOutline } from '../rules/outline.js';
import type { Project } from './model.js';

export interface ProjectValidation extends ValidationResult {
  counts: Record<FrameKind, number>;
  numbers: FrameNumber[];
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

  if (project.outline) {
    issues.push(...checkOutline(project.outline.entries, project.pdf.pageCount).issues);
  }

  issues.push(...lintFrames(checked.frames));
  if (text) issues.push(...lintAgainstText(checked.frames, text));

  const numbers = numberFrames(project.frames);
  return { ...summarize(issues), counts: countFrames(project.frames), numbers: [...numbers.values()] };
}
