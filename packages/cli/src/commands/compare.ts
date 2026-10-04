import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McPrepError, buildBookSummary, compareBook, parseReference, writeFileAtomic, type CompareReport, type ProjectSession } from '@mcprep/core';
import { numberOption, stringOption, usage } from '../args.js';
import { plural, tableLimited, TEXT_LIMIT } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

/**
 * `book compare REFERENCE.json`: the audited book against a reference list of its sections (the owner's own count of the exercises of
 * each section), section by section. The exit code is 4 when anything differs, so that whoever audits must look at it.
 */

/** The reference file, read and checked: the sections of either of its two forms. */
export async function readReference(context: CommandContext, file: string, chapterOffset: number): Promise<ReturnType<typeof parseReference>> {
  const path = resolve(context.io.cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the reference "${file}": ${(error as Error).message}`, { hint: 'The reference is a JSON file; see `mcprep book compare --help` for its two forms.' });
  }
  return parseReference(raw, chapterOffset);
}

export function compareReport(session: ProjectSession, reference: ReturnType<typeof parseReference>): CompareReport {
  const project = session.project;
  const summary = buildBookSummary({
    title: project.meta.title,
    info: project.meta,
    pageCount: project.pdf.pageCount,
    frames: project.frames,
    outline: project.outline?.entries,
  });
  return compareBook(summary, project.frames, reference);
}

export function compareText(report: CompareReport, file: string): string {
  const { totals } = report;
  const lines = [
    `Compared with the reference ${file}: ${plural(report.reference.sections, 'section')} in the reference, ${plural(report.audited.sections, 'section')} with exercises in the audit; ${totals.exercises} exercises audited, ${totals.referenceExercises} in the reference (${totals.difference > 0 ? '+' : ''}${totals.difference}).`,
  ];
  if (report.differences.length === 0) lines.push('No difference: every section has the count, the title and the place the reference has.');
  else {
    lines.push(`${plural(report.differences.length, 'difference')} to look at:`);
    lines.push(tableLimited(report.differences.slice(0, TEXT_LIMIT).map((entry) => [entry.kind, entry.label, entry.message]), ['kind', 'section', 'what'], 400));
    if (report.differences.length > TEXT_LIMIT) lines.push(`... and ${report.differences.length - TEXT_LIMIT} more (--details FILE writes them all)`);
  }
  if (report.chapters.length > 1) {
    lines.push(tableLimited(report.chapters.map((chapter) => [chapter.label, chapter.title ?? '', String(chapter.sections), String(chapter.referenceExercises), String(chapter.exercises), `${chapter.equal}/${chapter.sections}`]), ['chapter', 'title', 'sections', 'reference', 'audit', 'same count'], 200));
  }
  return lines.join('\n');
}

export const bookCompare: CommandSpec = {
  name: 'book compare',
  summary: 'Compare the audited sections and their exercise counts with a reference list of the book; exit code 4 when anything differs.',
  description:
    'Reads a reference (JSON: the owner\'s own count of the exercises of each section, in one of two forms: { "chapters": [{ "number", "title", "sections": [{ "number", "title", "exercise_count" }] }] }, where section 2 of chapter 3 is "3.2" (--chapter-offset N adds N to the chapter numbers), or { "sections": [{ "label", "title", "exercise_count" }] }) and compares it with the project, section by section, matching sections by the label the book prints: per section the reference count against the audited count, the first and last label, the pages of the first and the last exercise, the difference and whether the titles differ after normalising; the sections on one side only; the totals and a table per chapter. Everything that differs is listed under `differences`; the exit code is 4 when there is any (a count, a section on one side only, a title), so that the one who audits must look at the pages and decide: what the book prints (a practice set with more exercises than the contents list) is acknowledged with `mcprep audit ack`, anything else is a defect to repair. No network, nothing is changed. `--details FILE` writes the whole report (format math-canvas-compare).',
  args: [{ name: 'reference', description: 'The reference JSON file.', required: true }],
  options: [
    { name: 'chapter-offset', type: 'number', value: '<n>', description: 'Added to the chapter numbers of a reference with chapters (when the reference counts the first chapter as 1 and the book prints 0, use -1).' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write the whole report as JSON (format math-canvas-compare).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep book compare reference.json', 'mcprep book compare reference.json --chapter-offset -1 --details compare.json', 'mcprep book compare reference.json --json'],
  output: '{ format: "math-canvas-compare", version: 1, reference: { sections, exercises }, audited: { sections, exercises }, totals: { referenceExercises, exercises, difference }, sections: [{ label, id, title, referenceTitle, count, referenceCount, difference, firstLabel, lastLabel, firstPage, lastPage, titleDiffers, status: "equal"|"count"|"missing"|"extra" }], chapters: [{ label, title, sections, referenceExercises, exercises, equal }], differences: [{ kind: "count"|"missing"|"extra"|"title", label, message }] }; the exit code is 4 when there is a difference',
  async run(context) {
    const file = context.args[0];
    if (file === undefined) throw usage('Name the reference file: `mcprep book compare REFERENCE.json`.');
    const offset = numberOption(context.options, 'chapter-offset') ?? 0;
    if (!Number.isInteger(offset)) throw usage(`--chapter-offset must be a whole number, not ${offset}.`);
    const reference = await readReference(context, file, offset);
    const report = compareReport(await context.session(), reference);
    const details = stringOption(context.options, 'details');
    if (details !== undefined) await writeFileAtomic(resolve(context.io.cwd, details), `${JSON.stringify(report, null, 1)}\n`);
    const text = [compareText(report, file), ...(details !== undefined ? [`Wrote the whole report to ${details}.`] : [])].join('\n');
    return { result: report, text, ...(report.differences.length > 0 ? { exitCode: 4 } : {}) };
  },
};
