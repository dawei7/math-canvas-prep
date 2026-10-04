import { bookExercisesInOrder, buildSectionTree, describeSection, findFrame, isWithin, type Frame, type Project, type Region } from '@mcprep/core';
import { flag, pageNumber, stringOption, usage } from '../args.js';
import { plural, rectText, tableLimited } from '../format.js';
import type { CommandContext, CommandSpec, OptionSpec } from '../types.js';
import { GLOBAL_OPTIONS, REPORT_OPTIONS, SNAP, applyAndReport, reportFlags } from './common.js';
import { addOperation } from './frames.js';

/**
 * Authoritative exercises: exercises audited once from a book, each named by the number the book prints (its label)
 * inside the section it belongs to. Everything these commands do is also available as `frames` commands and as batch
 * operations; they exist so that the vocabulary of the audit (label, section, solution) has a command of its own.
 */

const REFERENCE = 'The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).';

export interface ExerciseSummary {
  id: string;
  label: string;
  section: string;
  /** `SECTION:LABEL`: how to name the exercise in any command. */
  reference: string;
  page: number;
  rect: Frame['rect'];
  context: number;
  continues: number;
  solution: number;
}

/** A region as the commands take it: `page:left,top,right,bottom` (the form of `context add --page P --rect l,t,r,b` and of `exercises add --context P:l,t,r,b`). */
const regionText = (region: Region): string => `${region.page}:${rectText(region.rect)}`;

/** The regions of an exercise that are not its own: its instructions, continuations and solutions, as objects (--regions). */
export interface ExerciseRegions {
  context: Region[];
  continues: Region[];
  solution: Region[];
}

export function exerciseRegions(frame: Frame): ExerciseRegions {
  return { context: frame.context ?? [], continues: frame.continues ?? [], solution: frame.solution ?? [] };
}

export function exerciseSummary(frame: Frame): ExerciseSummary {
  const label = frame.label ?? frame.id;
  const section = frame.section ?? '';
  return { id: frame.id, label, section, reference: `${section}:${label}`, page: frame.page, rect: frame.rect, context: frame.context?.length ?? 0, continues: frame.continues?.length ?? 0, solution: frame.solution?.length ?? 0 };
}

/** The frame ids behind references, to show them in the report (a label or section may be about to change). */
async function idsOf(context: CommandContext, ...references: string[]): Promise<string[]> {
  const project: Project = (await context.session()).project;
  return references.flatMap((reference) => {
    const found = findFrame(project, reference);
    return found ? [found.id] : [];
  });
}

export const exercisesList: CommandSpec = {
  name: 'exercises list',
  summary: 'List the authoritative book exercises: label, section, page, and whether a solution is attached.',
  description:
    'Authoritative exercises are named by the number the book prints (the label) inside the section of the book they belong to. They are listed by section (in the order of the outline) and, within a section, in reading order. Use --without-solution to see which ones still have no answer attached, and --section to look at one section.',
  options: [
    { name: 'section', type: 'string', value: '<id>', description: 'Only the exercises filed under this section (an outline entry id).' },
    { name: 'subtree', type: 'boolean', description: 'With --section: also the exercises of the sections below it.' },
    { name: 'page', type: 'string', value: '<n>', description: 'Only exercises that start on this zero-based page.' },
    { name: 'with-solution', type: 'boolean', description: 'Only exercises that have a solution region.' },
    { name: 'without-solution', type: 'boolean', description: 'Only exercises that have no solution region.' },
    { name: 'regions', type: 'boolean', description: 'Also print, for each exercise, its instruction (context), continuation and solution regions as page:left,top,right,bottom (JSON: the objects under `regions`), to copy the instruction of a neighbour: `context add REF --page P --rect l,t,r,b` or `exercises add ... --context P:l,t,r,b`.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises list', 'mcprep exercises list --section 1.2 --json', 'mcprep exercises list --without-solution', 'mcprep exercises list --section 1.2 --regions'],
  output: '{ exercises: [{ id, label, section, reference, page, rect, context, continues, solution, regions? }], count, totals: { exercises, withSolution } }; context, continues and solution are counts; with --regions each exercise also has regions: { context: [{ page, rect }], continues: [...], solution: [...] }; totals are for the whole project, count for the list',
  async run(context) {
    const session = await context.session();
    const project = session.project;
    let frames = bookExercisesInOrder(project.frames, project.outline?.entries);
    const section = stringOption(context.options, 'section');
    if (section !== undefined) {
      if (flag(context.options, 'subtree')) {
        const tree = buildSectionTree(project.outline?.entries ?? [], project.pdf.pageCount);
        const root = tree.byId.get(section);
        if (root === undefined) throw usage(`There is no outline entry with the id "${section}".`, 'List the sections with `mcprep outline`.');
        const ids = new Set(tree.nodes.filter((node) => isWithin(tree, node, tree.nodes[root] as (typeof tree.nodes)[number]) && node.id !== undefined).map((node) => node.id as string));
        frames = frames.filter((frame) => ids.has(frame.section as string));
      } else frames = frames.filter((frame) => frame.section === section);
    }
    const page = stringOption(context.options, 'page');
    if (page !== undefined) frames = frames.filter((frame) => frame.page === pageNumber(page));
    if (flag(context.options, 'with-solution')) frames = frames.filter((frame) => (frame.solution?.length ?? 0) > 0);
    if (flag(context.options, 'without-solution')) frames = frames.filter((frame) => (frame.solution?.length ?? 0) === 0);
    const withRegions = flag(context.options, 'regions');
    const exercises = frames.map((frame) => (withRegions ? { ...exerciseSummary(frame), regions: exerciseRegions(frame) } : exerciseSummary(frame)));
    const all = bookExercisesInOrder(project.frames, project.outline?.entries);
    const totals = { exercises: all.length, withSolution: all.filter((frame) => (frame.solution?.length ?? 0) > 0).length };
    const titles = new Map((project.outline?.entries ?? []).map((entry) => [entry.id, describeSection(entry)] as const));
    const rows = exercises.map((entry) => [entry.reference, entry.id, String(entry.page), rectText(entry.rect), [entry.context ? `context ${entry.context}` : '', entry.continues ? `continues ${entry.continues}` : '', entry.solution ? `solution ${entry.solution}` : 'no solution'].filter(Boolean).join(', '), titles.get(entry.section) ?? ''].map(String));
    const head = `${plural(exercises.length, 'book exercise')}${exercises.length !== totals.exercises ? ` of ${totals.exercises}` : ''}; ${totals.withSolution} of ${totals.exercises} in the project have a solution.`;
    if (withRegions && exercises.length > 0) {
      const lines = frames.slice(0, 200).flatMap((frame) => {
        const regions = exerciseRegions(frame);
        const kinds = (['context', 'continues', 'solution'] as const).filter((kind) => regions[kind].length > 0);
        return [
          `${frame.section as string}:${frame.label as string}  (frame ${frame.id}, page ${frame.page}, rect ${rectText(frame.rect)})`,
          ...(kinds.length === 0 ? ['  no context, continuation or solution'] : kinds.map((kind) => `  ${kind}: ${regions[kind].map(regionText).join('  ')}`)),
        ];
      });
      if (frames.length > 200) lines.push(`... and ${frames.length - 200} more (use --json to see all)`);
      return { result: { exercises, count: exercises.length, totals }, text: `${head}\nRegions are page:left,top,right,bottom: copy one with \`mcprep context add REF --page P --rect l,t,r,b\` or \`mcprep exercises add ... --context P:l,t,r,b\`.\n${lines.join('\n')}` };
    }
    return { result: { exercises, count: exercises.length, totals }, text: exercises.length === 0 ? `${head}\nAdd one with \`mcprep exercises add --section <id> --label <5a> --page <n> --rect l,t,r,b\`.` : `${head}\n${tableLimited(rows, ['exercise', 'id', 'page', 'rect (left,top,right,bottom)', 'notes', 'section'], 300)}` };
  },
};

const ADD_OPTIONS: OptionSpec[] = [
  { name: 'section', type: 'string', value: '<id>', description: 'The id of the outline entry (the section) the exercise belongs to; `mcprep outline` lists them.', required: true },
  { name: 'label', type: 'string', value: '<5a>', description: 'The number exactly as the book prints it, without the closing "." or ")": 5, 12, 5a, A.3, II-4 (1 to 24 characters).', required: true },
  { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page of the main region.', required: true },
  { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'Left, top, right, bottom as fractions of the page (0..1, origin top-left).', required: true },
  SNAP,
  { name: 'id', type: 'string', value: '<id>', description: 'Your own frame id ([A-Za-z0-9_-], up to 40 characters). Default: generated (f1, f2, ...).' },
  { name: 'context', type: 'string', value: '<page:l,t,r,b>', multiple: true, description: 'The instruction or statement the learner sees and the AI receives with every check (printed once above 5a and 5b, say); repeatable, up to 8.' },
  { name: 'continues', type: 'string', value: '<page:l,t,r,b>', multiple: true, description: 'A further region of the same exercise, e.g. on the next page; repeatable, up to 8.' },
  { name: 'solution', type: 'string', value: '<page:l,t,r,b>', multiple: true, description: 'Where the answer is printed in this PDF (the answer key at the back, say): hidden from the learner, used only to grade; repeatable, up to 8.' },
  { name: 'no-enlarge', type: 'boolean', description: 'Refuse a rect below the minimum size instead of enlarging it.' },
  { name: 'replace', type: 'boolean', description: 'If the exercise (same section and label) already exists, overwrite it in place instead of failing, keeping its id: page, rect and continuation are replaced (none given: none left); context and solution are replaced when you give them and kept otherwise (clear them with `context remove` and `solution clear`).' },
  ...REPORT_OPTIONS,
];

export const exercisesAdd: CommandSpec = {
  name: 'exercises add',
  summary: 'Add an authoritative exercise: one printed exercise, with its printed label, in its section.',
  description:
    'The same as `frames add --kind exercise --authority book`. An authoritative exercise is a single exercise: it has no parts. The parts of a printed exercise (5a, 5b) are two exercises with two labels, and the statement printed once above them is attached to each as --context. The exercise is identified by its section and label: adding one that exists is an error (so applying the same commands twice does no harm) unless you say --replace, which overwrites it in place and keeps its id. An exercise contains its number and statement and everything up to but not including the next exercise\'s number.',
  writes: true,
  options: ADD_OPTIONS,
  examples: [
    'mcprep exercises add --section 1.2 --label 5a --page 17 --rect 0.09,0.41,0.91,0.48 --snap --context 17:0.09,0.36,0.91,0.41',
    'mcprep exercises add --section 1.2 --label 12 --page 18 --rect 0.09,0.1,0.91,0.2 --solution 211:0.1,0.52,0.5,0.54',
  ],
  output: 'The change report: { applied, dryRun, created, replaced, removed, frames: [{ id, label, reference, section, ... }], counts, book, validation }',
  async run(context) {
    const op = addOperation(context, { kind: 'exercise', authority: 'book' });
    return applyAndReport(context, [op], `added the book exercise ${op.section as string}:${op.label as string}`, reportFlags(context.options));
  },
};

export const exercisesMark: CommandSpec = {
  name: 'exercises mark',
  summary: 'Make an exercise you framed an authoritative book exercise: give it the printed label and its section.',
  description:
    'The exercise keeps its place and its context and solution, loses its positional number (E3) and from now on is named by label and section. It cannot be part of a unit: merge the parts first (`frames merge --unit`).',
  writes: true,
  args: [{ name: 'frame', description: REFERENCE, required: true }],
  options: [
    { name: 'label', type: 'string', value: '<5a>', description: 'The number exactly as the book prints it (5, 5a, A.3).', required: true },
    { name: 'section', type: 'string', value: '<id>', description: 'The id of the outline entry the exercise belongs to.', required: true },
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep exercises mark f7 --label 5a --section 1.2'],
  output: 'The change report.',
  async run(context) {
    const ref = context.args[0] as string;
    const show = await idsOf(context, ref);
    return applyAndReport(context, [{ op: 'authority.mark', id: ref, label: stringOption(context.options, 'label') as string, section: stringOption(context.options, 'section') as string }], `marked ${ref} as a book exercise`, { ...reportFlags(context.options), show });
  },
};

export const exercisesUnmark: CommandSpec = {
  name: 'exercises unmark',
  summary: 'Turn an authoritative exercise back into an ordinary one (positional number, can be cut into parts).',
  writes: true,
  args: [{ name: 'frame', description: REFERENCE, required: true }],
  options: [...REPORT_OPTIONS],
  examples: ['mcprep exercises unmark 1.2:5a'],
  output: 'The change report.',
  async run(context) {
    const ref = context.args[0] as string;
    const show = await idsOf(context, ref);
    return applyAndReport(context, [{ op: 'authority.unmark', id: ref }], `unmarked ${ref}`, { ...reportFlags(context.options), show });
  },
};

export const exercisesLabel: CommandSpec = {
  name: 'exercises label',
  summary: 'Change the label (the printed number) of an authoritative exercise.',
  writes: true,
  args: [
    { name: 'frame', description: REFERENCE, required: true },
    { name: 'label', description: 'The number exactly as the book prints it, without the closing "." or ")".', required: true },
  ],
  options: [...REPORT_OPTIONS],
  examples: ['mcprep exercises label f12 5b'],
  output: 'The change report.',
  async run(context) {
    const ref = context.args[0] as string;
    const show = await idsOf(context, ref);
    return applyAndReport(context, [{ op: 'label.set', id: ref, label: context.args[1] as string }], `relabelled ${ref}`, { ...reportFlags(context.options), show });
  },
};

export const exercisesSection: CommandSpec = {
  name: 'exercises section',
  summary: 'Move an authoritative exercise to another section.',
  writes: true,
  args: [
    { name: 'frame', description: REFERENCE, required: true },
    { name: 'section', description: 'The id of the outline entry (`mcprep outline` lists them).', required: true },
  ],
  options: [...REPORT_OPTIONS],
  examples: ['mcprep exercises section f12 1.3'],
  output: 'The change report.',
  async run(context) {
    const ref = context.args[0] as string;
    const show = await idsOf(context, ref);
    return applyAndReport(context, [{ op: 'section.set', id: ref, section: context.args[1] as string }], `moved ${ref} to section ${context.args[1] as string}`, { ...reportFlags(context.options), show });
  },
};
