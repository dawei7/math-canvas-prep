import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SAMPLE_DEFAULTS, findFrame, renderRegion, sampleSession, type Frame, type Rect, type SampleEntry, type SampleReport } from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural, tableLimited } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

/**
 * `exercises sample`: the review sample that is the same for everyone (see `sampleProject` in the core and docs/AUDIT_A_BOOK.md
 * for the rules), optionally with the PNG crops of everything in it.
 */

interface Crop {
  ref: string;
  kind: 'exercise' | 'solution';
  region: string;
  path: string;
}

function count(context: CommandContext, name: 'exercises' | 'solutions'): number {
  const value = numberOption(context.options, name);
  if (value === undefined) return SAMPLE_DEFAULTS[name];
  if (!Number.isInteger(value) || value < 0) throw usage(`--${name} must be a whole number from 0, not ${value}.`, '0 leaves that part of the sample out; it is the most the sample has.');
  return value;
}

/** A reference as part of a file name: letters, digits, `.`, `_` and `-` stay, everything else (the colon, `(`, `/`, spaces) becomes `_`. */
const fileSafe = (ref: string): string => ref.replace(/[^A-Za-z0-9._-]/g, '_');

/** The regions to crop for an entry: its own, and for the layouts that name one, the continuation or the instruction on another page. */
function regionsOf(entry: SampleEntry, frame: Frame): { name: string; page: number; rect: Rect }[] {
  if (entry.kind === 'solution') return (frame.solution ?? []).map((region, at) => ({ name: at === 0 ? 'solution' : `solution-${at + 1}`, page: region.page, rect: region.rect }));
  const regions = [{ name: 'exercise', page: frame.page, rect: frame.rect }];
  if (entry.reasons.includes('has-continuation')) (frame.continues ?? []).slice(0, 1).forEach((region) => regions.push({ name: 'continues0', page: region.page, rect: region.rect }));
  if (entry.reasons.includes('context-on-another-page')) {
    const at = (frame.context ?? []).findIndex((region) => region.page !== frame.page);
    const region = (frame.context ?? [])[at];
    if (region) regions.push({ name: `context${at}`, page: region.page, rect: region.rect });
  }
  return regions;
}

async function writeCrops(context: CommandContext, report: SampleReport, folder: string): Promise<Crop[]> {
  const session = await context.session();
  const doc = await session.document();
  const dir = resolve(context.io.cwd, folder);
  await mkdir(dir, { recursive: true });
  const crops: Crop[] = [];
  const used = new Set<string>();
  for (const entry of [...report.exercises, ...report.solutions]) {
    const frame = findFrame(session.project, entry.ref);
    if (!frame) continue;
    for (const region of regionsOf(entry, frame)) {
      let name = `${fileSafe(entry.ref)}-${region.name}`;
      for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${fileSafe(entry.ref)}-${region.name}~${n}`;
      used.add(name.toLowerCase());
      const image = await renderRegion(doc, region.page, region.rect, {});
      const path = join(dir, `${name}.png`);
      await writeFile(path, image.png);
      crops.push({ ref: entry.ref, kind: entry.kind, region: region.name, path });
    }
  }
  return crops;
}

function rows(entries: readonly SampleEntry[]): string[][] {
  return entries.map((entry) => [entry.ref, entry.reasons.join(', '), String(entry.page), entry.region]);
}

export function sampleText(report: SampleReport, crops?: readonly Crop[], out?: string): string {
  const { summary } = report;
  const lines = [
    `Sample to look at: ${plural(summary.sampledExercises, 'exercise')} and ${plural(summary.sampledSolutions, 'answer')} (the book has ${plural(summary.exercises, 'exercise')} in ${plural(summary.sections, 'section')}, ${summary.withSolution} with an answer).`,
  ];
  if (report.exercises.length > 0) lines.push('', 'Exercises (look at each with `mcprep crop <ref>`):', tableLimited(rows(report.exercises), ['ref', 'why', 'page', 'region'], 500));
  if (report.solutions.length > 0) lines.push('', 'Answers (look at each with `mcprep crop <ref> --region solution:0`):', tableLimited(rows(report.solutions), ['ref', 'why', 'page', 'region'], 500));
  if (report.notes.length > 0) lines.push('', 'Notes:', ...report.notes.map((note) => `  - ${note}`));
  if (crops !== undefined) lines.push('', `Wrote ${plural(crops.length, 'crop')}, named by reference and kind (for example ${crops[0] !== undefined ? crops[0].path : 'none'}).`);
  if (out !== undefined) lines.push(`Wrote the sample to ${out}.`);
  return lines.join('\n');
}

export const exercisesSample: CommandSpec = {
  name: 'exercises sample',
  summary: 'A fixed sample of exercises and answers to look at, chosen by rules (no randomness): the same for every agent.',
  description:
    'The sample has at most --exercises exercises (default 40) and --solutions answers (default 20): hard caps. The rules are applied in order, each adds its exercises that are not in the sample yet until the cap is reached, and a rule that does not fit what is left is thinned by an even stride (never cut off at the end; the notes say which). Exercises: (1) one exercise of each layout kind the book has, the first one in the order of the book: it continues on another region, its instruction is on another page, it stands in a row with one other exercise, in a row with two others, the longest region, the smallest region, a region much taller than the median of its section (beside a figure); (2) the first and the last exercise of every chapter (an outline entry of depth 0 that holds exercises, or the entries at the top of an outline without any); (3) the first and the last exercise of every section, or, when what is left of the cap is less than twice the number of sections, of an even stride of sections that keeps the first and the last; (4) an even stride over the rest of the exercises in the order of the book. Answers (of the exercises that have one): (1) those of the exercises of rule 1, then the answer with the most lines of text, an answer that is only a picture, the first answer of every chapter\'s key, then those of the other sampled exercises in the order they were picked, then an even stride over the rest. `--per-section` is the thorough review: rule 3 ignores the caps and takes the first and the last exercise of every section, and the answers of every sampled exercise are taken, so the sample may be larger than the caps. The order of the book is the order of the sections in the outline and, within one, reading order; the order of the frames in the file does not matter, and nothing is random. Every entry says why it is there (`reason`, and all `reasons`), its page and its region (`main` or `solution:0`, as `crop --region` takes it). `--crops DIR` also writes the PNG of every region, named by reference and kind (`1.2_5-exercise.png`, `1.2_5-solution.png`), as `crop` does; look at them, or call `crop` for each entry. `--out FILE` writes the sample as JSON (format math-canvas-sample, see `mcprep schema sample`). Nothing is changed.',
  options: [
    { name: 'exercises', type: 'number', value: '<n>', description: `The most exercises the sample has (default ${SAMPLE_DEFAULTS.exercises}); 0 leaves the exercises out. Only --per-section may go beyond it.` },
    { name: 'solutions', type: 'number', value: '<n>', description: `The most answers the sample has (default ${SAMPLE_DEFAULTS.solutions}); 0 leaves the answers out. Only --per-section may go beyond it.` },
    { name: 'per-section', type: 'boolean', description: 'The thorough review: take the first and the last exercise of EVERY section (and the answers of every sampled exercise), whatever the caps are; the sample may then be larger than --exercises and --solutions.' },
    { name: 'out', type: 'string', value: '<file>', description: 'Write the sample as JSON (format math-canvas-sample).' },
    { name: 'crops', type: 'string', value: '<dir>', description: 'Also write the PNG crop of every region of the sample into this folder, named by reference and kind (`1.2_5-exercise.png`, `1.2_5-solution.png`).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises sample', 'mcprep exercises sample --crops sample/ --out sample.json', 'mcprep exercises sample --exercises 60 --solutions 30 --json', 'mcprep exercises sample --per-section'],
  output:
    '{ format: "math-canvas-sample", version: 1, options: { exercises, solutions, perSection }, summary: { sections, exercises, withSolution, sampledExercises, sampledSolutions }, exercises: [{ ref, reason, reasons, page, kind, region }], solutions: [{ ref, reason, reasons, page, kind, region }], notes: string[] (layouts the book does not have, rules that were thinned), crops?: [{ ref, kind, region, path }] (with --crops) }',
  async run(context) {
    const session = await context.session();
    const report = await sampleSession(session, { exercises: count(context, 'exercises'), solutions: count(context, 'solutions'), ...(flag(context.options, 'per-section') ? { perSection: true } : {}) });
    const folder = stringOption(context.options, 'crops');
    const crops = folder !== undefined ? await writeCrops(context, report, folder) : undefined;
    const result = crops !== undefined ? { ...report, crops } : report;
    const out = stringOption(context.options, 'out');
    if (out !== undefined) await writeFile(resolve(context.io.cwd, out), `${JSON.stringify(result, null, 1)}\n`);
    return { result, text: sampleText(report, crops, out), notes: [] };
  },
};
