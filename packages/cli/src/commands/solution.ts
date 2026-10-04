import { bookReference, findFrame, isAuthoritative, McPrepError, numberFrames, type Frame, type Project } from '@mcprep/core';
import { byPosition, plural, rectText, tableLimited } from '../format.js';
import { flag, numberOption, pageNumber, stringOption } from '../args.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS, REPORT_OPTIONS, SNAP, applyAndReport, reportFlags } from './common.js';

/**
 * Solution context: regions of the SAME PDF (usually the answer key at the back) that are used to grade an exercise and
 * hidden from the learner. They are not shown with the exercise and never sent to a tutor chat. (The instruction that the
 * learner sees and the AI receives is `context`: `mcprep context add`.)
 */

const FRAME = 'The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).';

interface SolutionEntry {
  frame: string;
  label: string;
  reference?: string;
  authority: 'book' | 'user';
  regions: { index: number; page: number; rect: Frame['rect'] }[];
}

function entryOf(frame: Frame, labels: ReturnType<typeof numberFrames>): SolutionEntry {
  const book = isAuthoritative(frame);
  const entry: SolutionEntry = {
    frame: frame.id,
    label: book ? (frame.label ?? frame.id) : (labels.get(frame.id)?.label ?? frame.id),
    authority: book ? 'book' : 'user',
    regions: (frame.solution ?? []).map((region, index) => ({ index, page: region.page, rect: region.rect })),
  };
  if (book && frame.section !== undefined) entry.reference = bookReference(frame.section, frame.label ?? frame.id);
  return entry;
}

async function target(context: CommandContext): Promise<{ frame: Frame; project: Project }> {
  const project = (await context.session()).project;
  const ref = context.args[0] as string;
  const frame = findFrame(project, ref);
  if (!frame) {
    throw new McPrepError('E_NO_FRAME', `There is no frame "${ref}".`, { hint: 'Name an exercise by its frame id (`mcprep frames list`) or SECTION:LABEL (`mcprep exercises list`).' });
  }
  return { frame, project };
}

export const solutionAdd: CommandSpec = {
  name: 'solution add',
  summary: 'Attach a region where the answer is printed (usually the answer key at the back) to an exercise; hidden from the learner.',
  description:
    'Solution regions are of the same PDF as the exercise. They are used only to grade: the learner never sees them with the exercise and they are never sent to a tutor chat. Typically one small region per exercise in the answer key (the line "22) 0"), or one block that answers several exercises (give the same region to each). Up to 8 regions per exercise. Look at the crop afterwards: `mcprep crop <exercise> --region solution:0`.',
  writes: true,
  args: [{ name: 'frame', description: FRAME, required: true }],
  options: [
    { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page of the solution.', required: true },
    { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'The solution region (page fractions).', required: true },
    SNAP,
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep solution add 1.2:5a --page 211 --rect 0.1,0.52,0.5,0.54 --snap', 'mcprep solution add f12 --page 211 --rect 0.1,0.52,0.5,0.54'],
  output: 'The change report; the frame carries "solution": n.',
  async run(context) {
    const ref = context.args[0] as string;
    const { frame } = await target(context);
    return applyAndReport(context, [{ op: 'solution.add', id: ref, page: pageNumber(stringOption(context.options, 'page') as string), rect: stringOption(context.options, 'rect') as string, ...(flag(context.options, 'snap') ? { snap: true } : {}) }], `added a solution region to ${ref}`, { ...reportFlags(context.options), show: [frame.id] });
  },
};

export const solutionList: CommandSpec = {
  name: 'solution list',
  summary: 'List the solution regions of an exercise, or of every exercise that has some.',
  args: [{ name: 'frame', description: `${FRAME} Without it: every exercise that has solution regions.` }],
  options: [{ name: 'missing', type: 'boolean', description: 'Instead list the authoritative exercises that have no solution region yet.' }, ...GLOBAL_OPTIONS],
  examples: ['mcprep solution list', 'mcprep solution list 1.2:5a', 'mcprep solution list --missing'],
  output: '{ solutions: [{ frame, label, reference?, authority, regions: [{ index, page, rect }] }], count, missing?: [{ frame, label, reference }] }',
  async run(context) {
    const session = await context.session();
    const project = session.project;
    const labels = numberFrames(project.frames);
    if (flag(context.options, 'missing')) {
      const missing = project.frames
        .filter((frame) => isAuthoritative(frame) && (frame.solution?.length ?? 0) === 0)
        .sort(byPosition)
        .map((frame) => ({ frame: frame.id, label: frame.label as string, reference: bookReference(frame.section ?? '?', frame.label ?? '?') }));
      return {
        result: { solutions: [], count: 0, missing },
        text: missing.length === 0 ? 'Every authoritative exercise has a solution region.' : `${plural(missing.length, 'authoritative exercise')} without a solution region:\n${tableLimited(missing.map((entry) => [entry.reference, entry.frame]), ['exercise', 'id'], 300)}`,
      };
    }
    let frames: Frame[];
    if (context.args[0] !== undefined) frames = [(await target(context)).frame];
    else frames = project.frames.filter((frame) => (frame.solution?.length ?? 0) > 0).sort(byPosition);
    const solutions = frames.map((frame) => entryOf(frame, labels));
    const rows = solutions.flatMap((entry) => (entry.regions.length === 0 ? [[entry.reference ?? entry.label, entry.frame, '-', '-', '(no solution regions)']] : entry.regions.map((region) => [entry.reference ?? entry.label, entry.frame, String(region.index), String(region.page), rectText(region.rect)])));
    return {
      result: { solutions, count: solutions.reduce((sum, entry) => sum + entry.regions.length, 0) },
      text: solutions.length === 0 ? 'No exercise has a solution region. Add one with `mcprep solution add <exercise> --page <n> --rect l,t,r,b`.' : `${plural(solutions.reduce((sum, entry) => sum + entry.regions.length, 0), 'solution region')} on ${plural(solutions.length, 'exercise')}:\n${tableLimited(rows, ['exercise', 'id', 'index', 'page', 'rect (left,top,right,bottom)'], 300)}`,
    };
  },
};

export const solutionRemove: CommandSpec = {
  name: 'solution remove',
  summary: 'Remove one solution region of an exercise (by index), or all of them.',
  writes: true,
  args: [{ name: 'frame', description: FRAME, required: true }],
  options: [
    { name: 'index', type: 'number', value: '<n>', description: 'Which region (0 is the first); needed when there are several. `solution list` shows the indexes.' },
    { name: 'all', type: 'boolean', description: 'Remove all of them.' },
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep solution remove 1.2:5a --index 1', 'mcprep solution remove f12'],
  output: 'The change report.',
  async run(context) {
    const ref = context.args[0] as string;
    const { frame } = await target(context);
    const index = numberOption(context.options, 'index');
    return applyAndReport(context, [{ op: 'solution.remove', id: ref, ...(index !== undefined ? { index } : {}), ...(flag(context.options, 'all') ? { all: true } : {}) }], `removed a solution region from ${ref}`, { ...reportFlags(context.options), show: [frame.id] });
  },
};

export const solutionClear: CommandSpec = {
  name: 'solution clear',
  summary: 'Remove every solution region of an exercise.',
  writes: true,
  args: [{ name: 'frame', description: FRAME, required: true }],
  options: [...REPORT_OPTIONS],
  examples: ['mcprep solution clear 1.2:5a'],
  output: 'The change report.',
  async run(context) {
    const ref = context.args[0] as string;
    const { frame } = await target(context);
    if ((frame.solution?.length ?? 0) === 0) return { result: { applied: false, cleared: 0 }, text: `${ref} has no solution regions.` };
    return applyAndReport(context, [{ op: 'solution.remove', id: ref, all: true }], `cleared the solution of ${ref}`, { ...reportFlags(context.options), show: [frame.id] });
  },
};
