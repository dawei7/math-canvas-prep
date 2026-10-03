import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McPrepError, countFrames, type FrameKind, type Operation } from '@mcprep/core';
import { flag, listOption, numberList, numberOption, pageNumber, stringOption, usage } from '../args.js';
import { FRAME_HEADERS, frameRows, plural, summarizeFrames, table } from '../format.js';
import type { CommandContext, CommandSpec, OptionSpec } from '../types.js';
import { DRY_RUN, FORCE, GLOBAL_OPTIONS, applyAndReport, parseRegion } from './common.js';

const KINDS = ['exercise', 'question', 'bookmark'];

function kindOf(text: string): FrameKind {
  if (!KINDS.includes(text)) throw usage(`The kind must be exercise, question or bookmark, not "${text}".`);
  return text as FrameKind;
}

const SNAP: OptionSpec = { name: 'snap', type: 'boolean', description: 'Move the top and bottom edges off any line of text they cut through (a line mostly inside is taken whole, mostly outside is left out).' };
const REPORT_OPTIONS: OptionSpec[] = [DRY_RUN, FORCE, ...GLOBAL_OPTIONS];

function reportOptions(context: CommandContext): { dryRun?: boolean; force?: boolean } {
  return { ...(flag(context.options, 'dry-run') ? { dryRun: true } : {}), ...(flag(context.options, 'force') ? { force: true } : {}) };
}

export const framesList: CommandSpec = {
  name: 'frames list',
  summary: 'List the frames in reading order with their positional labels (E1, E2.1, Q1, B1).',
  description:
    'Labels are computed from position, never stored: page by page, top before bottom, left before right; the parts of one exercise count once, at the position of its first part. Adding a frame earlier in the document renumbers the later ones; use the id to refer to a frame.',
  options: [
    { name: 'page', type: 'string', value: '<n>', description: 'Only this zero-based page.' },
    { name: 'kind', type: 'string', value: 'exercise|question|bookmark', description: 'Only this kind.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep frames list', 'mcprep frames list --page 2 --json'],
  output: '{ frames: [{ id, label, kind, page, rect, unit?, part?, partCount?, continues?, context? }], counts: { exercise, question, bookmark } }',
  async run(context) {
    const session = await context.session();
    let frames = summarizeFrames(session.project);
    const page = stringOption(context.options, 'page');
    if (page !== undefined) frames = frames.filter((frame) => frame.page === pageNumber(page));
    const kind = stringOption(context.options, 'kind');
    if (kind !== undefined) frames = frames.filter((frame) => frame.kind === kindOf(kind));
    const counts = countFrames(session.project.frames);
    return {
      result: { frames, counts },
      text: `${plural(frames.length, 'frame')} (project: ${plural(counts.exercise, 'exercise')}, ${plural(counts.question, 'question')}, ${plural(counts.bookmark, 'bookmark')}).\n${table(frameRows(frames), FRAME_HEADERS)}`,
    };
  },
};

export const framesAdd: CommandSpec = {
  name: 'frames add',
  summary: 'Add a frame: an exercise, a question or a bookmark.',
  description:
    'A frame is a rectangle on a zero-based page, in fractions of the page as displayed (origin top-left). An exercise contains its number and statement and everything up to but not including the next exercise\'s number. A rect smaller than the minimum (0.02 wide, 0.01 tall) is enlarged around its centre; with --snap the edges also move off lines of text. Use `frames split` afterwards to cut an exercise into parts, `context add` to attach an instruction printed elsewhere.',
  writes: true,
  options: [
    { name: 'kind', type: 'string', value: 'exercise|question|bookmark', description: 'What the frame is for.', required: true },
    { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page of the main region.', required: true },
    { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'Left, top, right, bottom as fractions of the page (0..1, origin top-left).', required: true },
    SNAP,
    { name: 'id', type: 'string', value: '<id>', description: 'Your own id ([A-Za-z0-9_-], up to 40 characters). Default: generated (f1, f2, ...).' },
    { name: 'unit', type: 'string', value: '<unit>', description: 'Make this frame a part of the exercise with this unit id (prefer `frames split`).' },
    { name: 'context', type: 'string', value: '<page:l,t,r,b>', multiple: true, description: 'A context region (instruction or background printed elsewhere); repeatable, up to 8. Exercises only.' },
    { name: 'continues', type: 'string', value: '<page:l,t,r,b>', multiple: true, description: 'A further region of the same task, e.g. on the next page; repeatable, up to 8. Not for parts.' },
    { name: 'no-enlarge', type: 'boolean', description: 'Refuse a rect below the minimum size instead of enlarging it.' },
    ...REPORT_OPTIONS,
  ],
  examples: [
    'mcprep frames add --kind exercise --page 2 --rect 0.08,0.12,0.92,0.31 --snap',
    'mcprep frames add --kind exercise --page 3 --rect 0.08,0.6,0.92,0.95 --continues 4:0.08,0.05,0.92,0.2',
    'mcprep frames add --kind bookmark --page 5 --rect 0.1,0.4,0.9,0.52',
  ],
  output: 'The change report: { applied, dryRun, created, removed, frames: [...], counts, validation: { ok, errors, warnings, repairs } }',
  async run(context) {
    const op: Operation = {
      op: 'add',
      kind: kindOf(stringOption(context.options, 'kind') as string),
      page: pageNumber(stringOption(context.options, 'page') as string),
      rect: stringOption(context.options, 'rect') as string,
      ...(flag(context.options, 'snap') ? { snap: true } : {}),
      ...(flag(context.options, 'no-enlarge') ? { enlarge: false } : {}),
      ...(stringOption(context.options, 'id') !== undefined ? { id: stringOption(context.options, 'id') as string } : {}),
      ...(stringOption(context.options, 'unit') !== undefined ? { unit: stringOption(context.options, 'unit') as string } : {}),
      ...(listOption(context.options, 'context').length > 0 ? { context: listOption(context.options, 'context').map((text) => parseRegion(text, '--context')) } : {}),
      ...(listOption(context.options, 'continues').length > 0 ? { continues: listOption(context.options, 'continues').map((text) => parseRegion(text, '--continues')) } : {}),
    };
    return applyAndReport(context, [op], `added a ${op.kind}`, reportOptions(context));
  },
};

export const framesUpdate: CommandSpec = {
  name: 'frames update',
  summary: 'Change the page, rectangle or kind of a frame.',
  description: 'A part of an exercise cannot be moved on its own: use `frames area` (the whole exercise), `frames dividers` (the cuts between parts) or `frames move`.',
  writes: true,
  args: [{ name: 'id', description: 'The frame id.', required: true }],
  options: [
    { name: 'kind', type: 'string', value: 'exercise|question|bookmark', description: 'New kind (context is dropped when it stops being an exercise).' },
    { name: 'page', type: 'string', value: '<n>', description: 'New zero-based page.' },
    { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'New rectangle (page fractions).' },
    SNAP,
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep frames update f3 --rect 0.08,0.12,0.92,0.34 --snap', 'mcprep frames update f3 --kind question'],
  output: 'The change report.',
  async run(context) {
    const id = context.args[0] as string;
    const kind = stringOption(context.options, 'kind');
    const page = stringOption(context.options, 'page');
    const rect = stringOption(context.options, 'rect');
    if (kind === undefined && page === undefined && rect === undefined && !flag(context.options, 'snap')) throw usage('`frames update` needs --rect, --page, --kind or --snap.');
    const op: Operation = {
      op: 'update',
      id,
      ...(kind !== undefined ? { kind: kindOf(kind) } : {}),
      ...(page !== undefined ? { page: pageNumber(page) } : {}),
      ...(rect !== undefined ? { rect } : {}),
      ...(flag(context.options, 'snap') ? { snap: true } : {}),
    };
    return applyAndReport(context, [op], `updated ${id}`, { ...reportOptions(context), show: [id] });
  },
};

export const framesDelete: CommandSpec = {
  name: 'frames delete',
  summary: 'Delete a frame (or, with --unit, every part of an exercise).',
  description: 'Deleting a part from the middle of an exercise leaves no gap: the part above takes over its area. An exercise left with one part is an ordinary exercise again. The context of a deleted first part stays with the exercise.',
  writes: true,
  args: [{ name: 'id', description: 'The frame id (or the unit id with --unit).', required: true }],
  options: [{ name: 'unit', type: 'boolean', description: 'The argument is a unit id: delete all of its parts.' }, ...REPORT_OPTIONS],
  examples: ['mcprep frames delete f4', 'mcprep frames delete u3 --unit'],
  output: 'The change report ("removed" lists the deleted ids).',
  async run(context) {
    const id = context.args[0] as string;
    const op: Operation = flag(context.options, 'unit') ? { op: 'delete', unit: id } : { op: 'delete', id };
    return applyAndReport(context, [op], `deleted ${id}`, reportOptions(context));
  },
};

export const framesMove: CommandSpec = {
  name: 'frames move',
  summary: 'Move a frame by a distance in page fractions (an exercise with parts moves as a whole).',
  writes: true,
  args: [{ name: 'id', description: 'The frame id.', required: true }],
  options: [
    { name: 'dx', type: 'number', value: '<fraction>', description: 'To the right (negative: to the left).' },
    { name: 'dy', type: 'number', value: '<fraction>', description: 'Down (negative: up).' },
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep frames move f2 --dy 0.02', 'mcprep frames move f2 --dx -0.01 --dy -0.03'],
  output: 'The change report.',
  async run(context) {
    const dx = numberOption(context.options, 'dx') ?? 0;
    const dy = numberOption(context.options, 'dy') ?? 0;
    if (dx === 0 && dy === 0) throw usage('`frames move` needs --dx and/or --dy.');
    return applyAndReport(context, [{ op: 'move', id: context.args[0] as string, dx, dy }], `moved ${context.args[0] as string}`, { ...reportOptions(context), show: [context.args[0] as string] });
  },
};

export const framesSplit: CommandSpec = {
  name: 'frames split',
  summary: 'Cut an exercise into parts: (a), (b), (c) become parts 1.1, 1.2, 1.3 of one exercise.',
  description:
    '--at gives the y positions (page fractions) where the parts after the first start, each at its marker line (use `lines` or `propose` to find them; --snap moves a divider onto the nearest line). The parts always tile one area. By default the first part starts at the top of the frame, so the statement before (a) stays inside it (what the Android app\'s own splitter does). Recommended: give --first, the y where the first part starts (at its marker), and the text above becomes context of the exercise, which every check then receives. The original frame keeps its id as the first part.',
  writes: true,
  args: [{ name: 'id', description: 'The exercise frame (or a part, to cut it again).', required: true }],
  options: [
    { name: 'at', type: 'string', value: '<y1,y2,...>', description: 'Where the parts after the first start (page fractions, top to bottom).', required: true },
    { name: 'first', type: 'number', value: '<y>', description: 'Where the first part starts (default: the top of the frame).' },
    { name: 'preamble', type: 'string', value: 'keep|context|drop', description: 'What becomes of the text above --first: context (default when --first is given), or drop (leave it out). Without --first it stays in the first part (keep).' },
    SNAP,
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep frames split f1 --at 0.4,0.52 --snap', 'mcprep frames split f1 --first 0.32 --at 0.4,0.52 --preamble context --snap'],
  output: 'The change report ("created" lists the new parts).',
  async run(context) {
    const id = context.args[0] as string;
    const first = numberOption(context.options, 'first');
    const preamble = stringOption(context.options, 'preamble');
    if (preamble !== undefined && !['keep', 'context', 'drop'].includes(preamble)) throw usage('--preamble must be keep, context or drop.');
    const op: Operation = {
      op: 'split',
      id,
      at: numberList(stringOption(context.options, 'at') as string, '--at'),
      ...(first !== undefined ? { first } : {}),
      ...(preamble !== undefined ? { preamble: preamble as 'keep' | 'context' | 'drop' } : {}),
      ...(flag(context.options, 'snap') ? { snap: true } : {}),
    };
    return applyAndReport(context, [op], `cut ${id} into parts`, { ...reportOptions(context), show: [id] });
  },
};

export const framesMerge: CommandSpec = {
  name: 'frames merge',
  summary: 'Merge parts back into one frame.',
  description: 'Give a unit id (--unit) to merge all its parts, or two or more neighbouring part ids to merge those.',
  writes: true,
  args: [{ name: 'ids', description: 'Neighbouring part ids to merge.', variadic: true }],
  options: [{ name: 'unit', type: 'string', value: '<unit>', description: 'Merge all parts of this unit.' }, ...REPORT_OPTIONS],
  examples: ['mcprep frames merge --unit u3', 'mcprep frames merge f2 f5'],
  output: 'The change report.',
  async run(context) {
    const unit = stringOption(context.options, 'unit');
    if (unit === undefined && context.args.length < 2) throw usage('`frames merge` needs --unit <unit>, or at least two part ids.');
    const op: Operation = unit !== undefined ? { op: 'merge', unit } : { op: 'merge', ids: context.args };
    return applyAndReport(context, [op], 'merged parts', { ...reportOptions(context), show: context.args });
  },
};

export const framesDividers: CommandSpec = {
  name: 'frames dividers',
  summary: 'Set the cuts between the parts of an exercise (move, add or remove them).',
  description: 'The area of the parts on the page stays; the cuts become exactly these. More cuts add parts (new ids), fewer remove the last ones. No cuts at all turns it back into one frame.',
  writes: true,
  args: [{ name: 'id', description: 'Any part of the exercise.', required: true }],
  options: [
    { name: 'at', type: 'string', value: '<y1,y2,...>', description: 'The new cuts (page fractions, top to bottom). Use "" for none.', required: true },
    { name: 'page', type: 'string', value: '<n>', description: 'Which page of a unit that spans several (default: the page of the frame).' },
    SNAP,
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep frames dividers f3 --at 0.38,0.5 --snap'],
  output: 'The change report.',
  async run(context) {
    const at = stringOption(context.options, 'at') as string;
    const page = stringOption(context.options, 'page');
    const op: Operation = {
      op: 'dividers',
      id: context.args[0] as string,
      at: at.trim() === '' ? [] : numberList(at, '--at'),
      ...(page !== undefined ? { page: pageNumber(page) } : {}),
      ...(flag(context.options, 'snap') ? { snap: true } : {}),
    };
    return applyAndReport(context, [op], `set the cuts of ${context.args[0] as string}`, { ...reportOptions(context), show: [context.args[0] as string] });
  },
};

export const framesArea: CommandSpec = {
  name: 'frames area',
  summary: 'Move or resize a whole exercise with parts (the cuts between the parts stay where they are).',
  writes: true,
  args: [{ name: 'id', description: 'Any part of the exercise.', required: true }],
  options: [{ name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'The new area: left and right apply to every part, top to the first part, bottom to the last.', required: true }, SNAP, ...REPORT_OPTIONS],
  examples: ['mcprep frames area f3 --rect 0.08,0.3,0.92,0.7'],
  output: 'The change report.',
  async run(context) {
    const op: Operation = { op: 'area', id: context.args[0] as string, rect: stringOption(context.options, 'rect') as string, ...(flag(context.options, 'snap') ? { snap: true } : {}) };
    return applyAndReport(context, [op], `resized ${context.args[0] as string}`, { ...reportOptions(context), show: [context.args[0] as string] });
  },
};

export const framesApply: CommandSpec = {
  name: 'frames apply',
  summary: 'Apply many operations at once, atomically, with one validation at the end.',
  description:
    'The file holds { "operations": [ ... ] } (or just the list). Each operation has an "op": add, update, delete, move, split, merge, dividers, area, context.add, context.remove, context.set, continues.add, continues.remove, outline.set, outline.add, outline.clear, meta.set, with the same fields as the matching commands. An "add" may carry "ref": "a" and later operations may say "id": "@a" for the frame it created, so you need not guess generated ids. Any failure, or any new validation error, rejects the whole batch and nothing is written. This is how to mark a 60-page sheet in one call.',
  writes: true,
  args: [{ name: 'file', description: 'A JSON file, or - for standard input.', required: true }],
  options: [...REPORT_OPTIONS],
  examples: ['mcprep frames apply batch.json', 'mcprep frames apply batch.json --dry-run', 'cat batch.json | mcprep frames apply -'],
  output: 'The change report with "steps": [{ index, op, created, removed, notes }].',
  async run(context) {
    const source = context.args[0] as string;
    const text = source === '-' ? await context.readStdin() : await readFile(resolve(context.io.cwd, source), 'utf8').catch((error: unknown) => {
      throw new McPrepError('E_FILE', `Cannot read "${source}": ${(error as Error).message}`);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw usage(`${source === '-' ? 'Standard input' : source} is not valid JSON: ${(error as Error).message}`);
    }
    const operations = Array.isArray(parsed) ? parsed : (parsed as { operations?: unknown }).operations;
    if (!Array.isArray(operations)) throw usage('The batch must be a list of operations, or an object with an "operations" list.');
    const done = await applyAndReport(context, operations as Operation[], `applied ${plural(operations.length, 'operation')}`, reportOptions(context));
    return done;
  },
};

