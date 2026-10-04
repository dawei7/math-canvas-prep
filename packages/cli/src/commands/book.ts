import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { McPrepError, buildBookSummary, writeFileAtomic, type BookSummary, type Operation } from '@mcprep/core';
import { flag, stringOption, usage } from '../args.js';
import { plural, tableLimited } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS, REPORT_OPTIONS, applyAndReport, reportFlags } from './common.js';

/**
 * The book as a whole: what it is (title, author, licence), how it is divided into sections and how many authoritative
 * exercises each section holds. `book show --json` and `book export` give the same plain JSON summary.
 */

const truncate = (text: string, length: number): string => (text.length <= length ? text : `${text.slice(0, length - 1)}...`);

function summaryOf(context: CommandContext, withItems: boolean): Promise<BookSummary> {
  return context.session().then((session) => {
    const project = session.project;
    return buildBookSummary({
      title: project.meta.title,
      folder: project.meta.folder,
      info: project.meta,
      pageCount: project.pdf.pageCount,
      sha256: project.pdf.sha256,
      bytes: project.pdf.bytes,
      frames: project.frames,
      outline: project.outline?.entries,
      exercises: withItems,
    });
  });
}

function sectionRows(summary: BookSummary, onlyUsed: boolean): string[][] {
  const keep = new Set<number>();
  if (onlyUsed) {
    for (const section of summary.sections) {
      if (section.exercisesTotal === 0) continue;
      let at: number | null = section.index;
      while (at !== null && !keep.has(at)) {
        keep.add(at);
        at = (summary.sections[at] as BookSummary['sections'][number]).parent;
      }
    }
  }
  return summary.sections
    .filter((section) => !onlyUsed || keep.has(section.index))
    .map((section) => [
      String(section.index),
      section.id ?? '-',
      `${'  '.repeat(section.depth)}${truncate(section.label !== undefined && !section.title.startsWith(section.label) ? `${section.label} ${section.title}` : section.title, 48)}`,
      String(section.page),
      `${section.exercises}`,
      `${section.exercisesTotal}`,
      section.exercisesTotal === 0 ? '' : `${section.withSolutionTotal}/${section.exercisesTotal}`,
      section.firstLabel !== undefined ? (section.firstLabel === section.lastLabel ? section.firstLabel : `${section.firstLabel} .. ${section.lastLabel}`) : '',
    ]);
}

export function describeBook(summary: BookSummary, onlyUsed = false): string[] {
  const { document, totals } = summary;
  const lines = [`${document.title}  (${plural(document.pageCount, 'page')}${document.folder !== undefined ? `, library folder ${document.folder}` : ''})`];
  if (document.author !== undefined) lines.push(`  author: ${document.author}`);
  if (document.series !== undefined) lines.push(`  series: ${document.series}`);
  if (document.license !== undefined) lines.push(`  licence: ${document.license.name}${document.license.url !== undefined ? ` (${document.license.url})` : ''}`);
  if (document.sourceUrl !== undefined) lines.push(`  source: ${document.sourceUrl}`);
  if (document.description !== undefined) lines.push(`  about: ${truncate(document.description.replace(/\s+/g, ' '), 140)}`);
  if (document.notice !== undefined) lines.push(`  notice: ${truncate(document.notice.replace(/\s+/g, ' '), 140)}`);
  lines.push(
    `Sections: ${totals.sections} outline entries, ${totals.sectionsWithId} with an id. Book exercises: ${totals.exercises}, ${totals.withSolution} with a solution, ${totals.withoutSolution} without${totals.unfiled > 0 ? `; ${totals.unfiled} are filed under a section that is not in the outline` : ''}.`,
  );
  if (totals.ordinary.exercises + totals.ordinary.questions + totals.ordinary.bookmarks > 0) {
    lines.push(`Also framed for yourself: ${plural(totals.ordinary.exercises, 'exercise')}, ${plural(totals.ordinary.questions, 'question')}, ${plural(totals.ordinary.bookmarks, 'bookmark')}.`);
  }
  if (summary.sections.length > 0) {
    lines.push(tableLimited(sectionRows(summary, onlyUsed), ['#', 'id', 'section', 'page', 'own', 'total', 'with solution', 'labels'], 400));
    lines.push('own: exercises filed under the entry; total: with everything below it; with solution: of the total.');
  } else {
    lines.push('The project has no outline, so the book has no sections yet: `mcprep outline pdf --adopt`, `mcprep outline derive` or `mcprep outline set`, then `mcprep outline ids`.');
  }
  return lines;
}

export const bookShow: CommandSpec = {
  name: 'book show',
  summary: 'Show the book: its information, its sections with the number of authoritative exercises in each, and the totals.',
  description:
    'The sections are the entries of the outline. For each: its id (what exercises name), the printed label, the page, how many book exercises are filed under it (own), under it and everything below it (total), how many of them have a solution, and the first and last label. With --json the result is the machine summary documented in docs/PROJECT_FILE.md (and `mcprep schema book-summary`); `mcprep book export` writes the same JSON to a file.',
  options: [
    { name: 'used', type: 'boolean', description: 'Only the sections that hold exercises, and the entries above them.' },
    { name: 'exercises', type: 'boolean', description: 'In the JSON, also list each section\'s own exercises (id, label, page, number of solution regions).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep book show', 'mcprep book show --used', 'mcprep book show --json'],
  output: 'The summary: { format: "math-canvas-book-summary", version: 1, generator, document: { title, folder?, pageCount, sha256?, bytes?, author?, series?, description?, license?, sourceUrl?, notice? }, sections: [{ index, id?, label?, title, page, top?, depth, parent, exercises, exercisesTotal, withSolution, withSolutionTotal, firstLabel?, lastLabel?, items? }], totals: { sections, sectionsWithId, exercises, withSolution, withoutSolution, unfiled, ordinary: { exercises, questions, bookmarks } } }',
  async run(context) {
    const summary = await summaryOf(context, flag(context.options, 'exercises'));
    return { result: summary, text: describeBook(summary, flag(context.options, 'used')).join('\n') };
  },
};

export const bookExport: CommandSpec = {
  name: 'book export',
  summary: 'Write the book summary (sections with exercise counts, totals, document information) as a plain JSON file.',
  description:
    'The same JSON as `book show --json`, written atomically to a file: a documented, camelCase list of the sections with their exercise and solution counts, pages zero-based. It is made from the project, so it can be written before the bundle is exported; the bundle itself carries the same facts in its manifest, frames and outline.',
  writes: false,
  options: [
    { name: 'out', short: 'o', type: 'string', value: '<file.json>', description: 'Where to write it (default: <pdf name>.book.json next to the project).' },
    { name: 'exercises', type: 'boolean', description: 'Also list each section\'s own exercises (id, label, page, number of solution regions).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep book export --out build/pre-algebra.book.json', 'mcprep book export --exercises'],
  output: '{ path, bytes, summary: the summary of `book show` }',
  async run(context) {
    const session = await context.session();
    const summary = await summaryOf(context, flag(context.options, 'exercises'));
    const out = stringOption(context.options, 'out');
    const path = out !== undefined ? resolve(context.io.cwd, out) : join(dirname(session.projectPath), `${basename(session.pdfPath, extname(session.pdfPath))}.book.json`);
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    await writeFileAtomic(path, text);
    return { result: { path, bytes: Buffer.byteLength(text), summary }, text: `Wrote ${path} (${Buffer.byteLength(text)} bytes): ${plural(summary.totals.sections, 'section')}, ${plural(summary.totals.exercises, 'book exercise')} (${summary.totals.withSolution} with a solution).` };
  },
};

/** A text option: `@file` reads the text from a file, `@@...` is a text that starts with @. */
async function textOption(context: CommandContext, name: string): Promise<string | undefined> {
  const value = stringOption(context.options, name);
  if (value === undefined) return undefined;
  if (value.startsWith('@@')) return value.slice(1);
  if (!value.startsWith('@')) return value;
  const path = resolve(context.io.cwd, value.slice(1));
  try {
    const text = await readFile(path, 'utf8');
    return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read "${value.slice(1)}" for --${name}: ${(error as Error).message}`);
  }
}

export const bookMeta: CommandSpec = {
  name: 'book meta',
  summary: 'Show or change what the bundle says about the book: title, library folder, author, series, description, licence, source address and notice.',
  description:
    'The licence travels with the file: a licence that asks for attribution needs its notice shown wherever the book is shown, so give --notice the text the licence asks for (who wrote it, under which licence, what was changed). An empty text ("") removes a field. A text that starts with @ is read from that file (--notice @notice.txt); write @@ for a text that really starts with @. Without options the current values are shown.',
  writes: true,
  options: [
    { name: 'title', type: 'string', value: '<text>', description: 'The title the library shows (1 to 200 characters).' },
    { name: 'folder', type: 'string', value: '<A/B>', description: 'Library folder, names separated by "/", at most seven levels.' },
    { name: 'author', type: 'string', value: '<text>', description: 'Who wrote the work (up to 200 characters).' },
    { name: 'series', type: 'string', value: '<text>', description: 'The series it belongs to (up to 200 characters).' },
    { name: 'description', type: 'string', value: '<text>', description: 'What the book is about, in a few sentences (up to 4000 characters).' },
    { name: 'license-name', type: 'string', value: '<text>', description: 'The licence, for example "CC BY 3.0" (up to 100 characters).' },
    { name: 'license-url', type: 'string', value: '<url>', description: 'Where the licence is (http or https).' },
    { name: 'no-license', type: 'boolean', description: 'Remove the licence.' },
    { name: 'source-url', type: 'string', value: '<url>', description: 'Where the work comes from (http or https, up to 500 characters).' },
    { name: 'notice', type: 'string', value: '<text>', description: 'The text the licence asks to be shown with the work (up to 4000 characters).' },
    ...REPORT_OPTIONS,
  ],
  examples: [
    'mcprep book meta --title "Pre-Algebra" --author "A. Author" --license-name "CC BY 3.0" --license-url https://creativecommons.org/licenses/by/3.0/ --source-url https://example.org/the-book',
    'mcprep book meta --notice @notice.txt',
    'mcprep book meta',
  ],
  output: '{ title, folder?, author?, series?, description?, license?: { name, url? }, sourceUrl?, notice? }, and with a change the usual change report',
  async run(context) {
    const session = await context.session();
    const options = context.options;
    const names = ['title', 'folder', 'author', 'series', 'description', 'license-name', 'license-url', 'source-url', 'notice'];
    const given = names.filter((name) => options[name] !== undefined);
    const clearLicense = flag(options, 'no-license');
    if (given.length === 0 && !clearLicense) {
      const meta = session.project.meta;
      const lines = [`title: ${meta.title}`, `folder: ${meta.folder ?? '(none)'}`, `author: ${meta.author ?? '(none)'}`, `series: ${meta.series ?? '(none)'}`, `licence: ${meta.license ? `${meta.license.name}${meta.license.url ? ` (${meta.license.url})` : ''}` : '(none)'}`, `source: ${meta.sourceUrl ?? '(none)'}`, `description: ${meta.description !== undefined ? truncate(meta.description.replace(/\s+/g, ' '), 100) : '(none)'}`, `notice: ${meta.notice !== undefined ? truncate(meta.notice.replace(/\s+/g, ' '), 100) : '(none)'}`];
      return { result: { ...meta }, text: lines.join('\n') };
    }
    const op: Extract<Operation, { op: 'meta.set' }> = { op: 'meta.set' };
    const title = stringOption(options, 'title');
    if (title !== undefined) op.title = title;
    const folder = stringOption(options, 'folder');
    if (folder !== undefined) op.folder = folder;
    for (const key of ['author', 'series', 'description', 'notice'] as const) {
      const value = await textOption(context, key);
      if (value !== undefined) op[key] = value;
    }
    const sourceUrl = stringOption(options, 'source-url');
    if (sourceUrl !== undefined) op.sourceUrl = sourceUrl;
    const licenseName = stringOption(options, 'license-name');
    const licenseUrl = stringOption(options, 'license-url');
    if (clearLicense) {
      if (licenseName !== undefined || licenseUrl !== undefined) throw usage('--no-license cannot be combined with --license-name or --license-url.');
      op.license = null;
    } else if (licenseName !== undefined || licenseUrl !== undefined) {
      const name = licenseName ?? session.project.meta.license?.name;
      if (name === undefined || name.trim() === '') {
        throw usage(licenseName === undefined ? '--license-url needs a licence name: give --license-name too.' : 'The licence name must not be empty (use --no-license to remove the licence).');
      }
      // A new name replaces the whole licence (its old address is dropped unless --license-url says it again).
      op.license = { name, url: licenseUrl === undefined || licenseUrl === '' ? null : licenseUrl };
    }
    return applyAndReport(context, [op], 'changed what the book says about itself', reportFlags(options));
  },
};
