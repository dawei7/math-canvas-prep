import { LIMITS } from './constants.js';

/** Names of folder levels, as the app files a document in its library. */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export interface FolderResult {
  folder: string | undefined;
  /** What was changed, for a report. */
  repairs: string[];
}

/**
 * Section 2: `document.folder` is names separated by `/`, at most seven levels. A reader cleans every name (no control
 * characters or `/`, trimmed, at most 60 characters) and drops levels beyond the seventh. Empty names disappear.
 */
export function cleanFolder(raw: string | undefined): FolderResult {
  if (raw === undefined) return { folder: undefined, repairs: [] };
  const repairs: string[] = [];
  const names: string[] = [];
  for (const part of raw.split('/')) {
    let name = part.replace(CONTROL, '').trim();
    if (name !== part) repairs.push(`The folder name "${part}" was cleaned to "${name}".`);
    const characters = Array.from(name);
    if (characters.length > LIMITS.folderNameMax) {
      name = characters.slice(0, LIMITS.folderNameMax).join('').trim();
      repairs.push(`The folder name "${part.slice(0, 20)}..." was cut to ${LIMITS.folderNameMax} characters.`);
    }
    if (name.length > 0) names.push(name);
  }
  if (names.length > LIMITS.folderLevels) {
    repairs.push(`The folder has ${names.length} levels; levels beyond the ${LIMITS.folderLevels}th were dropped.`);
    names.length = LIMITS.folderLevels;
  }
  return { folder: names.length > 0 ? names.join('/') : undefined, repairs };
}

/** For authoring input: a backslash is also taken as a separator (people write Windows paths). */
export function folderFromInput(raw: string): string {
  return raw.replace(/\\/g, '/');
}

/** The title as the library shows it: trimmed, 1 to 200 characters; undefined when it cannot be used. */
export function checkTitle(raw: string): { title?: string; problem?: string } {
  const title = raw.trim();
  if (title.length < 1) return { problem: 'The title is empty.' };
  if (title.length > LIMITS.titleMax) return { problem: `The title has ${title.length} characters; at most ${LIMITS.titleMax} are allowed.` };
  return { title };
}

/** A title suggestion from a file name: no folder, no extension, underscores and dashes as spaces. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem.replace(CONTROL, ' ').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned.length > 0 ? cleaned : 'Imported document').slice(0, LIMITS.titleMax);
}
