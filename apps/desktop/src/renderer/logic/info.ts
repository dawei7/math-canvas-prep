import { LIMITS, cleanFolder, isWebAddress, type Operation, type ProjectMeta } from '@mcprep/core/pure';

/**
 * What the bundle says about the work itself (the document information of docs/BUNDLE_FORMAT.md, section 2), as a form:
 * the text fields as the dialog shows them, what is wrong with each in plain words, and the one operation that makes the
 * project say what the form says. Pure; tested without a window.
 */

export interface InfoForm {
  title: string;
  folder: string;
  author: string;
  series: string;
  description: string;
  licenseName: string;
  licenseUrl: string;
  sourceUrl: string;
  notice: string;
}

export type InfoField = keyof InfoForm;

export const formFromMeta = (meta: ProjectMeta): InfoForm => ({
  title: meta.title,
  folder: meta.folder ?? '',
  author: meta.author ?? '',
  series: meta.series ?? '',
  description: meta.description ?? '',
  licenseName: meta.license?.name ?? '',
  licenseUrl: meta.license?.url ?? '',
  sourceUrl: meta.sourceUrl ?? '',
  notice: meta.notice ?? '',
});

const length = (text: string): number => Array.from(text.trim()).length;

/** What is wrong with each field, in plain words (only the fields that have a problem). */
export function checkInfoForm(form: InfoForm): Partial<Record<InfoField, string>> {
  const problems: Partial<Record<InfoField, string>> = {};
  const limit = (field: InfoField, max: number, name: string): void => {
    if (length(form[field]) > max) problems[field] = `${name} is ${length(form[field])} characters long; at most ${max} are allowed.`;
  };
  if (form.title.trim() === '') problems.title = 'The title is what the library shows: it cannot be empty.';
  else limit('title', LIMITS.titleMax, 'The title');
  const folder = form.folder.trim();
  if (folder !== '') {
    const names = folder.split(/[\\/]+/).filter((name) => name.trim() !== '');
    if (names.length > LIMITS.folderLevels) problems.folder = `A folder has at most ${LIMITS.folderLevels} levels (names separated by "/"); this one has ${names.length}.`;
    else if (cleanFolder(folder).folder === undefined) problems.folder = 'Write the folder as names separated by "/", for example Books/Algebra.';
  }
  limit('author', LIMITS.authorMax, 'The author');
  limit('series', LIMITS.seriesMax, 'The series');
  limit('description', LIMITS.descriptionMax, 'The description');
  limit('notice', LIMITS.noticeMax, 'The notice');
  limit('licenseName', LIMITS.licenseNameMax, 'The licence name');
  const url = (field: 'licenseUrl' | 'sourceUrl', name: string): void => {
    const text = form[field].trim();
    if (text === '') return;
    if (!isWebAddress(text)) problems[field] = `${name} must be a full web address starting with http:// or https:// (at most ${LIMITS.urlMax} characters).`;
  };
  url('licenseUrl', 'The licence address');
  url('sourceUrl', 'The source address');
  if (form.licenseName.trim() === '' && form.licenseUrl.trim() !== '' && problems.licenseUrl === undefined) problems.licenseName = 'A licence address needs the name of the licence too (for example CC BY 3.0).';
  return problems;
}

/**
 * The operation that makes the project say what the form says: only the fields that changed (an emptied field is removed),
 * or undefined when nothing did.
 */
export function patchFromForm(meta: ProjectMeta, form: InfoForm): Extract<Operation, { op: 'meta.set' }> | undefined {
  const before = formFromMeta(meta);
  const patch: Extract<Operation, { op: 'meta.set' }> = { op: 'meta.set' };
  let changed = false;
  const text = (field: 'author' | 'series' | 'description' | 'notice' | 'sourceUrl', formField: InfoField): void => {
    if (form[formField].trim() === before[formField].trim()) return;
    patch[field] = form[formField].trim() === '' ? null : form[formField].trim();
    changed = true;
  };
  if (form.title.trim() !== before.title.trim()) {
    patch.title = form.title.trim();
    changed = true;
  }
  if (form.folder.trim() !== before.folder.trim()) {
    patch.folder = form.folder.trim() === '' ? null : form.folder.trim();
    changed = true;
  }
  text('author', 'author');
  text('series', 'series');
  text('description', 'description');
  text('notice', 'notice');
  text('sourceUrl', 'sourceUrl');
  if (form.licenseName.trim() !== before.licenseName.trim() || form.licenseUrl.trim() !== before.licenseUrl.trim()) {
    patch.license = form.licenseName.trim() === '' ? null : { name: form.licenseName.trim(), url: form.licenseUrl.trim() === '' ? null : form.licenseUrl.trim() };
    changed = true;
  }
  return changed ? patch : undefined;
}
