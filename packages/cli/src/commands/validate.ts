import { flag } from '../args.js';
import { issueLines, plural, table } from '../format.js';
import type { CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

export const validate: CommandSpec = {
  name: 'validate',
  summary: 'Check the project against every rule of the bundle format; errors name the frame and the fix.',
  description:
    'Errors are what the importer would reject (exit code 4). Repairs are what it fixes silently (a value a hair outside the page, parts that miss tiling by under 0.002); the writer fixes them too. Warnings are allowed but suspicious: overlapping frames, a frame inside another, a frame thinner than a line, an edge that cuts through a line of text, a running header or footer inside a frame, a unit with one frame. For a book audited as an authority the rules are also: a label and a section with every authoritative exercise, the pair (section, label) unique, every section the id of an outline entry, solution regions only on exercises (at most 8, on pages of the document), valid outline ids, labels and tops; warnings for a label written with the "." or ")" the book prints, an exercise printed in another section than the one it is filed under, and a solution region that lies on the exercise or on another exercise.',
  options: [
    { name: 'no-text', type: 'boolean', description: 'Skip the checks that read the printed lines of the PDF (faster).' },
    { name: 'strict', type: 'boolean', description: 'Also fail (exit code 4) when there are warnings.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep validate', 'mcprep validate --strict --json'],
  output: '{ ok, errors: Issue[], warnings: Issue[], repairs: Issue[], counts: { exercise, question, bookmark }, book: { exercises, withSolution }, numbers: [{ id, label, kind, number, part?, partCount? }] }; an Issue is { severity, code, message, frameId?, unit?, page?, fix?, data? }; counts and numbers are the positional ones (authoritative book exercises are in book, named by their label)',
  async run(context) {
    const session = await context.session();
    const validation = await session.validate({ text: !flag(context.options, 'no-text') });
    const failed = !validation.ok || (flag(context.options, 'strict') && validation.warnings.length > 0);
    const book = validation.book.exercises > 0 ? `, ${plural(validation.book.exercises, 'book exercise')} (${validation.book.withSolution} with a solution)` : '';
    const lines = [
      `${validation.ok ? 'Valid' : 'NOT valid'}: ${plural(validation.errors.length, 'error')}, ${plural(validation.repairs.length, 'repair')}, ${plural(validation.warnings.length, 'warning')}. ${plural(validation.counts.exercise, 'exercise')}, ${plural(validation.counts.question, 'question')}, ${plural(validation.counts.bookmark, 'bookmark')}${book}.`,
      ...issueLines([...validation.errors, ...validation.repairs, ...validation.warnings], '', 100),
    ];
    if (validation.numbers.length > 0 && lines.length < 4) lines.push(table(validation.numbers.map((entry) => [entry.id, entry.label]), ['id', 'label']));
    return {
      result: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings, repairs: validation.repairs, counts: validation.counts, book: validation.book, numbers: validation.numbers },
      warnings: validation.warnings,
      text: lines.join('\n'),
      exitCode: failed ? 4 : 0,
    };
  },
};
