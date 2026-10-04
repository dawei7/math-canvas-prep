import { resolve } from 'node:path';
import { SHEET_DEFAULTS, planSheets, renderSheets, type SheetScope, type SheetsManifest } from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural } from '../format.js';
import type { CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';
import { sectionIds } from './verify.js';

/**
 * `exercises sheets`: contact sheets for an exhaustive look at the audit: every exercise of the book (or of a section, or of the
 * fixed sample) cropped with its instruction, continuations and answer, in the order of the book, a fixed number to a sheet.
 */

export const exercisesSheets: CommandSpec = {
  name: 'exercises sheets',
  summary: 'Make contact sheets of every exercise (or of a section, or of the fixed sample) with its instruction, continuations and answer, to look at them all.',
  description:
    'For the exhaustive visual pass that the gate asks for: the exercises in the order of the book (all of them, the ones of --section, or the fixed sample of `exercises sample`), `--per-sheet` (default 12) cells at most to a sheet, two cells wide, each cell of a fixed width (740 pixels), a sheet closed as soon as the next cell would make it taller than 2,600 pixels (so that the sheets stay readable, with the answers too; a cell taller than that has a sheet of its own, drawn smaller only above 6,000 pixels, and sheets.json says so) and captioned SECTION:LABEL and the zero-based pages of its regions ("p. 12, 13-14"). A cell shows, one region under the other: the instruction (blue frame), the exercise (red), its continuations (orange) and, with --solutions, its answer (green). Files: sheet-0001.png, sheet-0002.png, ... and sheets.json in --out, which lists the references and the pages of every sheet and a hash of what it shows; a repair that changes an exercise changes the hash of its sheet, which `audit gate --sheets-seen` finds. Nothing is uploaded; the result is the same for the same project. `--sheet N` draws only sheet N, `--from-sheet N` the sheets from N on (sheets.json is always the whole list): use them to look again after a repair. Look at every sheet, then list the numbers in a file for the gate (1-40, say).',
  options: [
    { name: 'out', short: 'o', type: 'string', value: '<folder>', required: true, description: 'Where the sheets and sheets.json go.' },
    { name: 'section', type: 'string', value: '<id>', multiple: true, description: 'Only the exercises of this section (an outline entry id); repeat the option or separate the ids with commas.' },
    { name: 'all', type: 'boolean', description: 'Every exercise of the book (the default when neither --section nor --sample is given).' },
    { name: 'sample', type: 'boolean', description: 'Only the exercises of the fixed sample (`mcprep exercises sample`).' },
    { name: 'per-sheet', type: 'number', value: '<n>', description: `Cells on a sheet, at most (default ${SHEET_DEFAULTS.perSheet}); a sheet taller than ${SHEET_DEFAULTS.heightCap} pixels is closed earlier.` },
    { name: 'solutions', type: 'boolean', description: 'Also draw the answer of each exercise (green).' },
    { name: 'sheet', type: 'number', value: '<n>', description: 'Draw only this sheet (1 is the first).' },
    { name: 'from-sheet', type: 'number', value: '<n>', description: 'Draw only the sheets from this one on.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises sheets --out sheets/', 'mcprep exercises sheets --out sheets/ --solutions --per-sheet 8', 'mcprep exercises sheets --out sheets/ --section 1.2', 'mcprep exercises sheets --out sheets/ --solutions --from-sheet 14'],
  output: '{ out, rendered: [sheet numbers drawn], manifest: { format: "math-canvas-sheets", version: 1, scope: "all"|"sample"|"section", sections?, perSheet, solutions, cellWidth, exercises, sheets: [{ number, file, refs, pages, hash }] } }',
  async run(context) {
    const session = await context.session();
    const out = stringOption(context.options, 'out');
    if (out === undefined) throw usage('Say where the sheets go: --out FOLDER.');
    const sections = sectionIds(context);
    if (flag(context.options, 'sample') && (flag(context.options, 'all') || sections.length > 0)) throw usage('--sample cannot be combined with --all or --section.');
    if (flag(context.options, 'all') && sections.length > 0) throw usage('--all cannot be combined with --section.');
    const scope: SheetScope = flag(context.options, 'sample') ? 'sample' : sections.length > 0 ? 'section' : 'all';
    const perSheet = numberOption(context.options, 'per-sheet');
    const solutions = flag(context.options, 'solutions');
    const only = numberOption(context.options, 'sheet');
    const from = numberOption(context.options, 'from-sheet');
    if (only !== undefined && from !== undefined) throw usage('Use --sheet or --from-sheet, not both.');
    for (const [name, value] of [['sheet', only], ['from-sheet', from]] as const) if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw usage(`--${name} must be a whole number from 1, not ${value}.`);
    const plan = await planSheets(session, { scope, ...(sections.length > 0 ? { sections } : {}), ...(perSheet !== undefined ? { perSheet } : {}), solutions });
    const total = plan.manifest.sheets.length;
    if ((only ?? from) !== undefined && (only ?? from) as number > total) throw usage(`There are ${total} sheets; there is no sheet ${(only ?? from) as number}.`);
    const folder = resolve(context.io.cwd, out);
    const rendered = await renderSheets(session, plan, { outDir: folder, ...(only !== undefined ? { only: (n: number) => n === only } : from !== undefined ? { only: (n: number) => n >= from } : {}) });
    const manifest: SheetsManifest = plan.manifest;
    const text = [
      `${plural(manifest.exercises, 'exercise')} on ${plural(total, 'sheet')} of at most ${manifest.perSheet} cells and ${manifest.heightCap} pixels (${scope === 'all' ? 'the whole book' : scope === 'sample' ? 'the fixed sample' : `section ${sections.join(', ')}`}${solutions ? ', with the answers' : ''}); drew ${rendered.length === total ? 'all of them' : plural(rendered.length, 'sheet')} into ${folder}.`,
      'Look at every sheet (blue: instruction, red: the exercise, orange: continuation, green: answer), repair what is wrong, then list the sheets you looked at for `mcprep audit gate --sheets-seen FILE`.',
    ].join('\n');
    return { result: { out: folder, rendered, manifest }, text };
  },
};
