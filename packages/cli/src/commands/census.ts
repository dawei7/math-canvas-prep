import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_RUN_KEYWORDS, LEFT_OUT_REASONS, RUN_LIMITS, censusSession, type CensusReport, type LeftOutReason, type NumberedRun } from '@mcprep/core';
import { flag, listOption, numberOption, stringOption, usage } from '../args.js';
import { plural, table } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

/**
 * `exercises census`: the survey that does not depend on any heading word or layout. It lists every run of numbered items in the whole
 * book (five or more items numbered one after the other: an exercise set, an answer key, a list of references, the steps of a method) and
 * says whether the project covers it. The detector is `findNumberedRuns` in the core; this is the command: its options, the table a person
 * reads and the file with everything.
 */

/** The rows of the table a person reads shown at most; the JSON always has every run. */
const TEXT_ROWS = 200;

const pageSpan = (run: NumberedRun): string => (run.firstPage === run.lastPage ? String(run.firstPage) : `${run.firstPage}-${run.lastPage}`);

function schemeText(run: NumberedRun): string {
  const base = run.keyword !== undefined ? `${run.keyword} k` : run.scheme;
  return run.step === 2 ? `${base} ${run.parity ?? ''} only`.replace('  ', ' ') : base;
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** A run as the command prints it in JSON: without its items (they are in the `--details` file). */
export function runSummary(run: NumberedRun): Omit<NumberedRun, 'items'> & { itemsOutside: number } {
  const { items, ...rest } = run;
  return { ...rest, itemsOutside: items.filter((item) => !item.covered).length };
}

/** What each reason is called in the sentence about the candidates that were left out (the longer sentence of `LEFT_OUT_REASONS` is in the docs and the report schema). */
const LEFT_OUT_WORDS: Readonly<Record<LeftOutReason, string>> = {
  years: 'lists of years',
  contents: 'tables of contents, indexes and lists with leader dots',
  'running-head': 'running heads',
  'short-items': 'columns of items of one or two characters',
  headings: 'headings printed again as a list',
};

/** The candidates that were left out, counted by reason, as a sentence ("tables of contents ...: 3; lists of years: 1"). */
function leftOutText(report: CensusReport): string {
  const counts = new Map<LeftOutReason, number>();
  for (const left of report.leftOut) counts.set(left.reason, (counts.get(left.reason) ?? 0) + 1);
  return (Object.keys(LEFT_OUT_REASONS) as LeftOutReason[])
    .filter((reason) => counts.has(reason))
    .map((reason) => `${LEFT_OUT_WORDS[reason]}: ${counts.get(reason)}`)
    .join('; ');
}

export function censusText(report: CensusReport, listed: readonly NumberedRun[]): string {
  const { summary } = report;
  const head =
    summary.runs === 0
      ? `No run of ${report.minRun} or more numbered items was found in the ${plural(report.pages, 'page')} of the text layer. That is a result only if the book prints no numbered list of that length: a scan has no text layer (\`mcprep info\` says which pages have one).`
      : `${plural(summary.runs, 'run')} of ${report.minRun} or more numbered items (${summary.items} items) on ${plural(summary.pagesWithRuns, 'page')} of ${report.pages}: ${summary.covered} covered by the project, ${summary.uncovered} not (${plural(summary.itemsOutside, 'item')} outside every region).`;
  const left = report.leftOut.length > 0 ? `Left out as no list of exercises or answers (the report lists each one with its reason): ${leftOutText(report)}.` : '';
  if (listed.length === 0) return [head, summary.runs === 0 ? '' : 'Nothing to list: every run is covered.', left].filter(Boolean).join('\n');
  const rows = listed.slice(0, TEXT_ROWS).map((run) => [run.id, pageSpan(run), `${run.first} to ${run.last}`, String(run.count), schemeText(run), percent(run.coverage), run.heading ?? '']);
  const parts = [head, table(rows, ['id', 'pages', 'numbers', 'items', 'scheme', 'covered', 'the line above the first item'])];
  if (listed.length > TEXT_ROWS) parts.push(`... and ${listed.length - TEXT_ROWS} more (--json lists every run)`);
  if (left !== '') parts.push(left);
  parts.push(
    `Every run is a candidate: an exercise set, an answer key, or another list (references, steps of a method, footnotes). Look at its first page (\`mcprep render PAGE\`, \`mcprep lines PAGE\`); frame what is an exercise or an answer (\`mcprep exercises add\`, \`mcprep solution add\`); a list the book prints that is neither is acknowledged by the gate (\`mcprep audit ack --code numbered-run-uncovered --ref ID\`). The gate reports every uncovered run of ${RUN_LIMITS.minRun} items or more, and of ${RUN_LIMITS.auditedMinRun} or more once the project covers ${RUN_LIMITS.auditedRuns} runs.`,
  );
  return parts.join('\n');
}

export const exercisesCensus: CommandSpec = {
  name: 'exercises census',
  summary: 'List every run of numbered items in the whole book, whatever the layout, and whether the project covers it: the survey that needs no heading word.',
  description:
    'Reads the text layer of EVERY page (no pixels, no network; a book of 1,400 pages takes about ten seconds) and lists the runs of numbered items it holds, whatever the book calls them and however its pages are laid out. An item is a line (or one cell of a row of two or three items side by side) that starts with a label and then has text: `8.`, `8)`, `(8)`, a dotted label of one chapter (`4.12`, `1.2.3`: the last number rises, the others stay), or a keyword and a number (`Exercise 4.2`, `Problem 7`, `Question 12`, `Task 5`, `Aufgabe 1.26`, `Uebung 3`; `--keyword WORD` adds words). A run is `--min-run` (default 5) or more items of one kind whose numbers rise by one (by two in a key that prints only the odd or only the even items), in reading order, from column to column and from page to page (up to two pages without an item in between); one label in ten may be missing, because the text layer drops lines and books skip numbers. Lines that do not start with a label go on with the item above. A candidate is left out, and listed with its reason (`leftOut`), when it is a table of contents or an index (the lines have leader dots, end in a page number or a list of page numbers, or have a bare number at the right margin), a run whose numbers are all years, a running head (its lines stand in the top or bottom band of three or more pages, about one to a page), fewer than ten items of one or two characters, or the headings of the book printed again as a list (the outline of a chapter before its sections); a numbered line set larger than the text is a heading and no item. Each run reports its id (`p32:8`: the zero-based page of its first item and its first label, written so that no shell takes it for syntax: `8_paren` for `8)`, `8_parens` for `(8)`, `Exercise_4.2` for a keyword label; a second run with the same id gets `#2`; the id the gate gives to the finding `numbered-run-uncovered`), the pages that hold its items, its first and last label, the number of items found and of labels missing between them, its scheme (`k.`, `k)`, `(k)`, `k.m`, `keyword`; with step 2 whether it is odd or even), the heading (the nearest line above its first item that is set larger or bolder than the text, else the nearest short line; only reported: no heading word decides anything), the first words of its first item, the page and box of its first and last item and its `coverage`: the share of its item lines that lie inside a region of the project (an exercise, a continuation, an instruction or an answer; at least half of a line must be inside). A run is `covered` at 0.8 or more. Every run is a candidate, an exercise set, an answer key or another list (references, the steps of a method, worked examples, footnotes): the exercises of a set are framed (`exercises add`), an answer key by its solution regions (`solution add`), and a list that is neither is acknowledged at the gate with the page and a quote (`audit ack --code numbered-run-uncovered --ref ID`). With an empty project (no exercise at all) every run is uncovered, which is the point: a layout that `exercises propose` does not read still shows here. The gate (`audit gate`, `exercises verify`) reports every uncovered run of 5 items or more as `numbered-run-uncovered`, and only the uncovered runs of 8 items or more once the project covers 3 runs. `--uncovered` lists only the runs that the project does not cover. `--details FILE` writes the whole report with every item (format math-canvas-census, see `mcprep schema census`). Nothing is changed.',
  options: [
    { name: 'min-run', type: 'number', value: '<n>', description: `The fewest items a run has (default ${RUN_LIMITS.minRun}; at least 2).` },
    { name: 'uncovered', type: 'boolean', description: 'List only the runs that the project does not cover (the ones the gate reports as numbered-run-uncovered).' },
    { name: 'keyword', type: 'string', multiple: true, value: '<word>', description: 'A word that makes a keyword label ("Exercise 4.2"), besides the English and German ones the census reads by default (exercise, problem, question, task, aufgabe, uebung, frage); repeatable.' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write the whole report as JSON (every run with all its items, and the candidates that were left out), in the format math-canvas-census.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises census', 'mcprep exercises census --uncovered', 'mcprep exercises census --min-run 8 --details census.json', 'mcprep exercises census --keyword Aufgabe --json'],
  output:
    '{ format: "math-canvas-census", version: 1, pages, minRun, summary: { runs, items, pagesWithRuns, covered, uncovered, itemsOutside, leftOut }, listed: number of runs in `runs`, runs: [{ id, pages: [...], firstPage, lastPage, first, last, count, missing, scheme, step, parity?, keyword?, heading?, start, firstItem: { page, rect }, lastItem: { page, rect }, coverage, covered, itemsOutside }] (all runs, or with --uncovered the ones that are not covered; without their items: --details has them), leftOut: [{ id, firstPage, lastPage, first, last, count, reason: "years"|"contents"|"running-head"|"short-items"|"headings", coverage }] }',
  async run(context: CommandContext) {
    const session = await context.session();
    const minRun = numberOption(context.options, 'min-run');
    if (minRun !== undefined && (!Number.isInteger(minRun) || minRun < 2)) throw usage(`--min-run must be a whole number from 2, not ${minRun}.`, `The default is ${RUN_LIMITS.minRun}.`);
    const words = listOption(context.options, 'keyword').map((word) => String(word).trim()).filter((word) => word !== '');
    const report = await censusSession(session, { ...(minRun !== undefined ? { minRun } : {}), ...(words.length > 0 ? { keywords: [...DEFAULT_RUN_KEYWORDS, ...words] } : {}) });
    const details = stringOption(context.options, 'details');
    if (details !== undefined) await writeFile(resolve(context.io.cwd, details), `${JSON.stringify(report, null, 1)}\n`);
    const listed = flag(context.options, 'uncovered') ? report.runs.filter((run) => !run.covered) : report.runs;
    const { runs: _all, ...head } = report;
    const result = { ...head, listed: listed.length, runs: listed.map(runSummary) };
    const text = [censusText(report, listed), ...(details !== undefined ? [`Wrote the whole report to ${details}.`] : [])].join('\n');
    return { result, text, notes: [] };
  },
};
