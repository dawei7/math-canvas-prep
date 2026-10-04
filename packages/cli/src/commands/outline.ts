import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McPrepError, deriveOutline, type OutlineEntry } from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural, table } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS, applyAndReport } from './common.js';
import { describeProjectOutline, outlineTable, outlineViews } from './outline-edit.js';

const rows = (entries: readonly OutlineEntry[]): string[][] => entries.map((entry) => [String(entry.page), `${'  '.repeat(entry.depth)}${entry.title}`, String(entry.depth)]);
const HEADERS = ['page', 'title', 'depth'];

export const outline: CommandSpec = {
  name: 'outline',
  summary: "Show the contents the bundle will carry (the sections of the book): the project's own outline with ids and exercise counts, or the PDF's.",
  description:
    "The app shows the bundle's outline.json as the document's contents instead of reading titles from the PDF. When the project has no outline of its own the bundle carries none and the app reads the PDF's. The entries are the sections of the book: an entry that exercises are filed under has an id, may have the printed label and the top of its heading, and is listed with the number of book exercises under it. Sub-commands: `outline pdf` (the PDF's own), `outline derive` (headings found by heuristics), `outline set` (write your own), `outline add`, `outline update`, `outline delete`, `outline ids` (edit it), `outline clear`.",
  options: [...GLOBAL_OPTIONS],
  examples: ['mcprep outline', 'mcprep outline --json'],
  output: '{ source: "project"|"pdf"|"none", entries: [{ index, title, page, depth, id?, label?, top?, exercises?, exercisesTotal?, withSolution? }], projectSource?: "pdf"|"derived"|"manual", totals?: { entries, withId, exercises } }; exercises are the book exercises filed under the entry, exercisesTotal with everything below it',
  async run(context) {
    const session = await context.session();
    if (session.project.outline) return describeProjectOutline(session.project);
    const pdf = await (await session.document()).outline();
    if (pdf) {
      const views = outlineViews(pdf);
      return { result: { source: 'pdf', entries: views }, text: `The project has no outline of its own; the bundle will carry none and the app reads the PDF's (${plural(pdf.length, 'entry', 'entries')}). Adopt it with \`outline pdf --adopt\` to edit it and to give its entries ids:\n${outlineTable(views)}` };
    }
    return { result: { source: 'none', entries: [] }, text: 'Neither the project nor the PDF has an outline. Try `mcprep outline derive`.' };
  },
};

export const outlinePdf: CommandSpec = {
  name: 'outline pdf',
  summary: 'Read the PDF\'s own outline (its bookmarks).',
  options: [{ name: 'adopt', type: 'boolean', description: 'Store it as the project\'s outline (so that you can edit it and it goes into the bundle).' }, ...GLOBAL_OPTIONS],
  examples: ['mcprep outline pdf', 'mcprep outline pdf --adopt'],
  writes: true,
  output: '{ entries: [{ title, page, depth }] | [], adopted?: boolean }',
  async run(context) {
    const session = await context.session();
    const entries = await (await session.document()).outline();
    if (!entries) return { result: { entries: [] }, text: 'The PDF has no outline.' };
    if (flag(context.options, 'adopt')) {
      const done = await applyAndReport(context, [{ op: 'outline.set', entries, source: 'pdf' }], 'stored the PDF\'s outline in the project');
      return { ...done, result: { entries, adopted: true } };
    }
    return { result: { entries }, text: `${plural(entries.length, 'entry', 'entries')}:\n${table(rows(entries), HEADERS)}` };
  },
};

export const outlineDerive: CommandSpec = {
  name: 'outline derive',
  summary: 'Find headings by font size, bold, position and numbering, for a PDF without an outline.',
  description:
    'Heuristics, with their evidence: a line is a heading when it is set larger than the body text, in bold, numbered like "2.1", or starts with a chapter word; the depth comes from the numbering or from the rank of the font size. Check the result (and edit it) before it goes into a bundle.',
  writes: true,
  options: [
    { name: 'apply', type: 'boolean', description: 'Store the result as the project\'s outline.' },
    { name: 'min-confidence', type: 'number', value: '<0..1>', description: 'Keep headings at least this likely (default 0.55).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep outline derive', 'mcprep outline derive --apply'],
  output: '{ entries: [{ title, page, depth, confidence, evidence: string[] }], bodyFontSize, applied: boolean, notes: string[] }',
  async run(context) {
    const session = await context.session();
    const pdf = await session.document();
    const pages = await pdf.allPageText({ fonts: true });
    const minConfidence = numberOption(context.options, 'min-confidence');
    const proposal = deriveOutline(pages, minConfidence !== undefined ? { minConfidence } : {});
    const text = `${plural(proposal.entries.length, 'heading')} found (body text ${proposal.bodyFontSize} pt):\n${table(proposal.entries.map((entry) => [String(entry.page), `${'  '.repeat(entry.depth)}${entry.title}`, String(entry.depth), entry.confidence.toFixed(2), entry.evidence[0] ?? '']), ['page', 'title', 'depth', 'conf', 'why'])}${proposal.notes.length > 0 ? `\n${proposal.notes.join('\n')}` : ''}`;
    if (flag(context.options, 'apply') && proposal.entries.length > 0) {
      const done = await applyAndReport(context, [{ op: 'outline.set', source: 'derived', entries: proposal.entries.map(({ title, page, depth }) => ({ title, page, depth })) }], 'stored the derived outline in the project');
      return { ...done, result: { entries: proposal.entries, bodyFontSize: proposal.bodyFontSize, applied: true, notes: proposal.notes }, text: `${text}\n${done.text}` };
    }
    return { result: { entries: proposal.entries, bodyFontSize: proposal.bodyFontSize, applied: false, notes: proposal.notes }, text, notes: proposal.notes };
  },
};

async function readJsonArgument(context: CommandContext, source: string): Promise<unknown> {
  const text = source === '-' ? await context.readStdin() : await readFile(resolve(context.io.cwd, source), 'utf8').catch((error: unknown) => {
    throw new McPrepError('E_FILE', `Cannot read "${source}": ${(error as Error).message}`);
  });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usage(`${source === '-' ? 'Standard input' : source} is not valid JSON: ${(error as Error).message}`);
  }
}

export const outlineSet: CommandSpec = {
  name: 'outline set',
  summary: "Replace the project's outline with entries from a JSON file (or - for standard input).",
  description: 'The JSON is a list of { "title", "page", "depth", "id"?, "label"?, "top"? } (pages zero-based, depth 0 to 8, a child one deeper than its parent) or an object with an "entries" list. The id is what exercises name as their section, the label the number printed with the heading, the top where the heading starts on its page (0 to 1). --auto-ids gives the entries that have no id one. Exercises that name an id the new outline no longer has make the change an error, so nothing is orphaned.',
  writes: true,
  args: [{ name: 'file', description: 'A JSON file, or - for standard input.', required: true }],
  options: [
    { name: 'source', type: 'string', value: 'manual|derived|pdf', description: 'What to record as the origin (default manual).' },
    { name: 'auto-ids', type: 'boolean', description: 'Give every entry that has no id one (as `outline ids` does).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep outline set outline.json', 'mcprep outline set outline.json --auto-ids', "echo '[{\"title\":\"1 Sets\",\"page\":0,\"depth\":0}]' | mcprep outline set -"],
  output: 'The usual change report (frames, validation); the outline is in the project.',
  async run(context) {
    const raw = await readJsonArgument(context, context.args[0] as string);
    const entries = Array.isArray(raw) ? raw : (raw as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) throw usage('The outline must be a list of entries, or an object with an "entries" list.');
    const source = stringOption(context.options, 'source');
    if (source !== undefined && !['manual', 'derived', 'pdf'].includes(source)) throw usage('--source must be manual, derived or pdf.');
    return applyAndReport(
      context,
      [{ op: 'outline.set', entries: entries as OutlineEntry[], ...(source !== undefined ? { source: source as 'manual' | 'derived' | 'pdf' } : {}) }, ...(flag(context.options, 'auto-ids') ? [{ op: 'outline.ids' as const }] : [])],
      'replaced the project outline',
    );
  },
};

export const outlineClear: CommandSpec = {
  name: 'outline clear',
  summary: 'Remove the project\'s own outline (the bundle then carries none and the app reads the PDF\'s).',
  writes: true,
  options: [...GLOBAL_OPTIONS],
  examples: ['mcprep outline clear'],
  output: 'The usual change report.',
  async run(context) {
    return applyAndReport(context, [{ op: 'outline.clear' }], 'removed the project outline');
  },
};

