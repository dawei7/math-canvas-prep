import { buildSectionTree, countSections, type OutlineEntry, type Project } from '@mcprep/core';
import { flag, numberOption, pageNumber, stringOption, usage } from '../args.js';
import { plural, tableLimited } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { REPORT_OPTIONS, applyAndReport, reportFlags } from './common.js';

/**
 * The outline is the table of contents of the book, and its entries are the sections that authoritative exercises belong
 * to. An entry that exercises name has an `id` (unique), may have the printed `label` ("1.1", "Chapter 3") and the `top` of
 * its heading on its page (so that two sections on one page can be told apart).
 */

export interface OutlineView {
  index: number;
  title: string;
  page: number;
  depth: number;
  id?: string;
  label?: string;
  top?: number;
  /** Authoritative exercises filed under this entry, and under it with everything below it. */
  exercises?: number;
  exercisesTotal?: number;
  withSolution?: number;
}

const truncate = (text: string, length: number): string => (text.length <= length ? text : `${text.slice(0, length - 1)}...`);

/** The entries with their position and, when `project` is given, how many exercises each holds. */
export function outlineViews(entries: readonly OutlineEntry[], project?: Project): OutlineView[] {
  const counts = project ? countSections(buildSectionTree(entries, project.pdf.pageCount), project.frames) : undefined;
  return entries.map((entry, index): OutlineView => {
    const view: OutlineView = { index, title: entry.title, page: entry.page, depth: entry.depth };
    if (entry.id !== undefined) view.id = entry.id;
    if (entry.label !== undefined) view.label = entry.label;
    if (entry.top !== undefined) view.top = entry.top;
    const count = counts?.perNode[index];
    if (count) {
      view.exercises = count.exercises;
      view.exercisesTotal = count.exercisesTotal;
      view.withSolution = count.withSolution;
    }
    return view;
  });
}

export function outlineTable(views: readonly OutlineView[]): string {
  const withCounts = views.some((view) => view.exercises !== undefined);
  const headers = ['#', 'id', 'label', 'page', 'top', ...(withCounts ? ['exercises (total)'] : []), 'title'];
  const rows = views.map((view) => [
    String(view.index),
    view.id ?? '-',
    view.label ?? '',
    String(view.page),
    view.top !== undefined ? String(Math.round(view.top * 10000) / 10000) : '',
    ...(withCounts ? [view.exercisesTotal === 0 ? '' : `${view.exercises ?? 0} (${view.exercisesTotal ?? 0})`] : []),
    `${'  '.repeat(view.depth)}${truncate(view.title, 80)}`,
  ]);
  return tableLimited(rows, headers, 400);
}

export const outlineIds: CommandSpec = {
  name: 'outline ids',
  summary: 'Give every outline entry that has no id one (from its printed label, else the number in its title), so that exercises can name it.',
  description:
    'Exercises name their section by the id of an outline entry. `outline pdf --adopt`, `outline derive` and `outline set` without ids make entries that exercises cannot name yet; this gives each of them an id: the printed label ("1.2"), else the number at the start of the title ("2.3 Fractions"), else a short form of the title, else s<position>; made unique with a numeric suffix. Entries that already have an id keep it.',
  writes: true,
  options: [...REPORT_OPTIONS],
  examples: ['mcprep outline ids'],
  output: 'The usual change report (the outline is in the project; `mcprep outline` shows the ids).',
  async run(context) {
    return applyAndReport(context, [{ op: 'outline.ids' }], 'gave the outline entries ids', reportFlags(context.options));
  },
};

const ENTRY_OPTIONS = [
  { name: 'label', type: 'string' as const, value: '<text>', description: 'The number printed with the heading ("1.1", "Chapter 3"), at most 24 characters.' },
  { name: 'top', type: 'string' as const, value: '<0..1>', description: 'Where the heading starts on its page, from the top (0 to 1), so that two sections on one page can be told apart.' },
];

function topOf(text: string | undefined): number | null | undefined {
  if (text === undefined) return undefined;
  if (text === 'none' || text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) throw usage(`--top must be a number from 0 to 1 (or "none"), not "${text}".`);
  return value;
}

export const outlineAdd: CommandSpec = {
  name: 'outline add',
  summary: 'Add an entry (a section) to the outline.',
  description:
    'The entry goes at the end of the outline, or at position --at (from 0). It gets an id unless you give one or say --no-id; the id is what exercises name with --section. Entries are in reading order and a child follows its parent and is one level deeper (a jump is clamped).',
  writes: true,
  options: [
    { name: 'title', type: 'string', value: '<text>', description: 'The title (1 to 200 characters).', required: true },
    { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page where the heading is.', required: true },
    { name: 'depth', type: 'number', value: '<0..8>', description: 'Level: 0 for a chapter, 1 for a section in it, ... (default 0).' },
    { name: 'id', type: 'string', value: '<id>', description: 'Its id ([A-Za-z0-9][A-Za-z0-9._-], up to 60 characters). Default: made from the label or the title.' },
    { name: 'no-id', type: 'boolean', description: 'Do not give it an id (exercises cannot be filed under it).' },
    ...ENTRY_OPTIONS,
    { name: 'at', type: 'number', value: '<position>', description: 'Insert at this position of the outline (from 0) instead of at the end.' },
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep outline add --title "1.2 Subtracting integers" --page 17 --depth 1 --label 1.2 --top 0.1', 'mcprep outline add --title "Appendix" --page 210 --id appendix'],
  output: 'The usual change report.',
  async run(context) {
    const options = context.options;
    const top = topOf(stringOption(options, 'top'));
    const id = stringOption(options, 'id');
    const at = numberOption(options, 'at');
    const depth = numberOption(options, 'depth');
    const label = stringOption(options, 'label');
    return applyAndReport(
      context,
      [
        {
          op: 'outline.add',
          title: stringOption(options, 'title') as string,
          page: pageNumber(stringOption(options, 'page') as string),
          ...(depth !== undefined ? { depth } : {}),
          ...(id !== undefined ? { id } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(typeof top === 'number' ? { top } : {}),
          ...(at !== undefined ? { at } : {}),
          ...(id === undefined && !flag(options, 'no-id') ? { autoId: true } : {}),
        },
      ],
      'added an outline entry',
      reportFlags(options),
    );
  },
};

function addressOf(context: CommandContext): { id?: string; index?: number } {
  const id = context.args[0];
  const index = numberOption(context.options, 'index');
  if (id === undefined && index === undefined) throw usage('Name the outline entry by its id (`mcprep outline` lists them) or by --index (its position, from 0).');
  return { ...(id !== undefined ? { id } : {}), ...(index !== undefined ? { index } : {}) };
}

export const outlineUpdate: CommandSpec = {
  name: 'outline update',
  summary: 'Change an outline entry: its title, page, depth, label, top or id.',
  description:
    'Name the entry by its id, or by --index when it has none. A new id (--new-id) is taken over by the exercises filed under the old one. --label "" and --top none remove the label and the top. Changing the depth moves only this entry, not the ones below it.',
  writes: true,
  args: [{ name: 'id', description: 'The id of the entry (`mcprep outline` lists them).' }],
  options: [
    { name: 'index', type: 'number', value: '<n>', description: 'The position of the entry in the outline (from 0), for an entry that has no id.' },
    { name: 'title', type: 'string', value: '<text>', description: 'New title.' },
    { name: 'page', type: 'string', value: '<n>', description: 'New zero-based page.' },
    { name: 'depth', type: 'number', value: '<0..8>', description: 'New level.' },
    { name: 'new-id', type: 'string', value: '<id>', description: 'New id (the exercises filed under the old id follow).' },
    ...ENTRY_OPTIONS,
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep outline update 1.2 --top 0.12 --label 1.2', 'mcprep outline update 1.2 --new-id subtracting', 'mcprep outline update --index 7 --new-id appendix'],
  output: 'The usual change report.',
  async run(context) {
    const options = context.options;
    const top = topOf(stringOption(options, 'top'));
    const page = stringOption(options, 'page');
    const label = stringOption(options, 'label');
    const title = stringOption(options, 'title');
    const depth = numberOption(options, 'depth');
    const newId = stringOption(options, 'new-id');
    if (title === undefined && page === undefined && depth === undefined && label === undefined && top === undefined && newId === undefined) {
      throw usage('`outline update` needs something to change: --title, --page, --depth, --label, --top or --new-id.');
    }
    return applyAndReport(
      context,
      [
        {
          op: 'outline.update',
          ...addressOf(context),
          ...(title !== undefined ? { title } : {}),
          ...(page !== undefined ? { page: pageNumber(page) } : {}),
          ...(depth !== undefined ? { depth } : {}),
          ...(label !== undefined ? { label: label === '' ? null : label } : {}),
          ...(top !== undefined ? { top } : {}),
          ...(newId !== undefined ? { newId } : {}),
        },
      ],
      'changed an outline entry',
      reportFlags(options),
    );
  },
};

export const outlineDelete: CommandSpec = {
  name: 'outline delete',
  summary: 'Delete an outline entry.',
  description:
    'The entries below it move up one level, or are deleted with it with --subtree. A section that exercises are filed under cannot be deleted: move the exercises first (`exercises section`), or delete them.',
  writes: true,
  args: [{ name: 'id', description: 'The id of the entry (`mcprep outline` lists them).' }],
  options: [
    { name: 'index', type: 'number', value: '<n>', description: 'The position of the entry in the outline (from 0), for an entry that has no id.' },
    { name: 'subtree', type: 'boolean', description: 'Also delete everything below it.' },
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep outline delete 1.2', 'mcprep outline delete c3 --subtree', 'mcprep outline delete --index 7'],
  output: 'The usual change report.',
  async run(context) {
    return applyAndReport(context, [{ op: 'outline.delete', ...addressOf(context), ...(flag(context.options, 'subtree') ? { subtree: true } : {}) }], 'deleted an outline entry', reportFlags(context.options));
  },
};

/** What `outline` prints about the project's own outline. */
export function describeProjectOutline(project: Project): { result: { source: 'project'; projectSource: string; entries: OutlineView[]; totals: { entries: number; withId: number; exercises: number } }; text: string } {
  const entries = project.outline?.entries ?? [];
  const views = outlineViews(entries, project);
  const withId = entries.filter((entry) => entry.id !== undefined).length;
  const exercises = project.frames.filter((frame) => frame.authority === 'book').length;
  const totals = { entries: entries.length, withId, exercises };
  const note =
    exercises > 0 || withId > 0
      ? ` ${withId} with an id (the sections exercises are filed under), ${plural(exercises, 'book exercise')}.`
      : ' None has an id yet: exercises are filed under entries that have one (`mcprep outline ids`).';
  return {
    result: { source: 'project', projectSource: project.outline?.source ?? 'manual', entries: views, totals },
    text: `The project's own outline (${project.outline?.source ?? 'manual'}, ${plural(entries.length, 'entry', 'entries')}); it goes into the bundle.${note}\n${outlineTable(views)}`,
  };
}

