import { flag, numberOption, pageNumber, stringOption, usage } from '../args.js';
import type { CommandSpec, OptionSpec } from '../types.js';
import { DRY_RUN, FORCE, GLOBAL_OPTIONS, applyAndReport } from './common.js';

const SNAP: OptionSpec = { name: 'snap', type: 'boolean', description: 'Move the top and bottom edges off any line of text they cut through.' };
const COMMON: OptionSpec[] = [DRY_RUN, FORCE, ...GLOBAL_OPTIONS];
const reportOptions = (options: Record<string, unknown>): { dryRun?: boolean; force?: boolean } => ({ ...(options['dry-run'] === true ? { dryRun: true } : {}), ...(options['force'] === true ? { force: true } : {}) });

export const contextAdd: CommandSpec = {
  name: 'context add',
  summary: 'Attach a region of context (the instruction, question or background printed elsewhere) to an exercise.',
  description:
    'Context is shown first when the exercise is shown and goes to the AI tutor with every check. Use it for an instruction printed once above several tasks, or text on another page. For an exercise with parts it is kept on the first part and applies to all of them. Up to 8 regions per exercise; only exercises can have context.',
  writes: true,
  args: [{ name: 'id', description: 'The exercise frame (any part of an exercise with parts).', required: true }],
  options: [
    { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page of the context.', required: true },
    { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'The context region (page fractions).', required: true },
    SNAP,
    ...COMMON,
  ],
  examples: ['mcprep context add f3 --page 1 --rect 0.08,0.11,0.92,0.17 --snap'],
  output: 'The change report.',
  async run(context) {
    const id = context.args[0] as string;
    return applyAndReport(
      context,
      [{ op: 'context.add', id, page: pageNumber(stringOption(context.options, 'page') as string), rect: stringOption(context.options, 'rect') as string, ...(flag(context.options, 'snap') ? { snap: true } : {}) }],
      `added context to ${id}`,
      { ...reportOptions(context.options), show: [id] },
    );
  },
};

export const contextRemove: CommandSpec = {
  name: 'context remove',
  summary: 'Remove a context region of an exercise.',
  writes: true,
  args: [{ name: 'id', description: 'The exercise frame.', required: true }],
  options: [
    { name: 'index', type: 'number', value: '<n>', description: 'Which region (0 is the first); needed when there are several.' },
    { name: 'all', type: 'boolean', description: 'Remove all of them.' },
    ...COMMON,
  ],
  examples: ['mcprep context remove f3', 'mcprep context remove f3 --index 1'],
  output: 'The change report.',
  async run(context) {
    const id = context.args[0] as string;
    const index = numberOption(context.options, 'index');
    return applyAndReport(context, [{ op: 'context.remove', id, ...(index !== undefined ? { index } : {}), ...(flag(context.options, 'all') ? { all: true } : {}) }], `removed context from ${id}`, { ...reportOptions(context.options), show: [id] });
  },
};

export const continuesAdd: CommandSpec = {
  name: 'continues add',
  summary: 'Add a further region of the same task, for example where an exercise goes on in the next column or on the next page.',
  description: 'Regions follow the main region in reading order; up to 8. An exercise with parts cannot continue: give each page its own parts (same unit) instead.',
  writes: true,
  args: [{ name: 'id', description: 'The frame.', required: true }],
  options: [
    { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page of the continuation.', required: true },
    { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'The continuation region (page fractions).', required: true },
    SNAP,
    ...COMMON,
  ],
  examples: ['mcprep continues add f4 --page 3 --rect 0.08,0.07,0.92,0.19 --snap'],
  output: 'The change report.',
  async run(context) {
    const id = context.args[0] as string;
    return applyAndReport(
      context,
      [{ op: 'continues.add', id, page: pageNumber(stringOption(context.options, 'page') as string), rect: stringOption(context.options, 'rect') as string, ...(flag(context.options, 'snap') ? { snap: true } : {}) }],
      `added a continuation to ${id}`,
      { ...reportOptions(context.options), show: [id] },
    );
  },
};

export const continuesRemove: CommandSpec = {
  name: 'continues remove',
  summary: 'Remove a continuation region.',
  writes: true,
  args: [{ name: 'id', description: 'The frame.', required: true }],
  options: [
    { name: 'index', type: 'number', value: '<n>', description: 'Which region (0 is the first); needed when there are several.' },
    { name: 'all', type: 'boolean', description: 'Remove all of them.' },
    ...COMMON,
  ],
  examples: ['mcprep continues remove f4'],
  output: 'The change report.',
  async run(context) {
    const id = context.args[0] as string;
    const index = numberOption(context.options, 'index');
    if (index !== undefined && !Number.isInteger(index)) throw usage('--index must be a whole number.');
    return applyAndReport(context, [{ op: 'continues.remove', id, ...(index !== undefined ? { index } : {}), ...(flag(context.options, 'all') ? { all: true } : {}) }], `removed a continuation from ${id}`, { ...reportOptions(context.options), show: [id] });
  },
};
