import { describe, expect, it } from 'vitest';
import { proposeExercises, type ExerciseProposal, type SectionExercises } from '../src/audit/exercises.js';
import { parseRangeInstruction } from '../src/audit/layout.js';
import type { LinePart, PageText, TextLine } from '../src/model/types.js';
import { groupTextLines, type RawTextItem } from '../src/pdf/lines.js';
import { heading, line, page, section, type Spec } from './audit-pages.js';

/**
 * Rows of several items in one line, and instructions that name the items they are for: the cells that the text extraction
 * records for a row, the range an instruction line names, and what both do to the proposals. Every text is made up.
 */

describe('the numbers an instruction line names', () => {
  it('reads "For Exercises 1-4", "In Exercises 5 - 10", "For questions 1-5", "For 10-13" and "For Exercise 9"', () => {
    expect(parseRangeInstruction('For Exercises 1-4, find the value of each.')).toEqual([1, 4]);
    expect(parseRangeInstruction('In Exercises 5 - 10, solve each equation.')).toEqual([5, 10]);
    expect(parseRangeInstruction('For questions 1-5 use the table.')).toEqual([1, 5]);
    expect(parseRangeInstruction('For 10-13, use the graph.')).toEqual([10, 13]);
    expect(parseRangeInstruction('For Exercise 9, give a reason.')).toEqual([9, 9]);
    expect(parseRangeInstruction('Solve Problems 3 to 7.')).toEqual([3, 7]);
  });

  it('reads any word before the numbers: "In tasks 10 - 27, solve each one"', () => {
    expect(parseRangeInstruction('In tasks 10 - 27, solve each one for the indicated variable.')).toEqual([10, 27]);
    expect(parseRangeInstruction('For figures 3-5, find the area.')).toEqual([3, 5]);
  });

  it('does not read a line that merely starts with a number, a range that runs backwards or one that is far too long', () => {
    expect(parseRangeInstruction('1-4. Compute the value.')).toBeUndefined();
    expect(parseRangeInstruction('Exercises 5-2 are on the next page.')).toBeUndefined();
    expect(parseRangeInstruction('For exercises 1-200, see the book.')).toBeUndefined();
    expect(parseRangeInstruction('Find the value of x.')).toBeUndefined();
  });
});

describe('the items the text extraction finds in one line (its cells)', () => {
  const sheet = { width: 600, height: 800, rotation: 0 };
  const run = (text: string, left: number, width: number): RawTextItem => ({ text, left, right: left + width, baseline: 100, fontSize: 10, ascent: 0.8, descent: -0.2 });
  const cellsOf = (items: RawTextItem[]): string[] | undefined => groupTextLines(items, sheet).lines[0]?.cells?.map((cell) => cell.text);

  it('records two and three items of one row, each from its number to the next', () => {
    expect(cellsOf([run('1.', 72, 8), run('first', 90, 30), run('2.', 135, 8), run('second', 153, 35)])).toEqual(['1. first', '2. second']);
    expect(cellsOf([run('1.', 72, 8), run('a', 90, 8), run('2.', 112, 8), run('b', 130, 8), run('3.', 152, 8), run('c', 170, 8)])).toEqual(['1. a', '2. b', '3. c']);
  });

  it('records nothing for a number inside an expression, a number that does not follow the one before, or a row of one item', () => {
    // "x - 2." : a number after an operator is part of the expression.
    expect(cellsOf([run('1.', 72, 8), run('x -', 90, 18), run('2.', 112, 8), run('y', 130, 8)])).toBeUndefined();
    expect(cellsOf([run('1.', 72, 8), run('first', 90, 30), run('9.', 135, 8), run('second', 153, 35)])).toBeUndefined();
    expect(cellsOf([run('1.', 72, 8), run('first', 90, 30), run('and more text', 135, 60)])).toBeUndefined();
  });
});

describe('a row of items that the text layer holds in one line', () => {
  const cells = (texts: string[], lefts: number[], top: number): LinePart[] =>
    texts.map((text, at) => ({ text, chars: text.replace(/\s/g, '').length, rect: { left: lefts[at] as number, top, right: (lefts[at] as number) + 0.18, bottom: top + 0.0155 } }));

  const rowLine = (firstLabel: number, top: number): TextLine => {
    const lefts = [0.143, 0.392, 0.642];
    const parts = cells([0, 1, 2].map((k) => `${firstLabel + k}. item ${firstLabel + k}`), lefts, top);
    return { ...line({ text: parts.map((part) => part.text).join(' '), left: 0.143, top, right: 0.82 }), cells: parts, parts };
  };

  const pageWith = (lines: TextLine[]): PageText => {
    const base = page(0, [heading(), { text: 'Solve each problem.', left: 0.143, top: 0.14, bold: true }]);
    return { ...base, lines: [...base.lines, ...lines] };
  };

  it('is cut into the items of its row, each framed by its own cell', () => {
    const set = proposeExercises([pageWith([rowLine(1, 0.2), rowLine(4, 0.25), rowLine(7, 0.3)])], [section(0, 1)]).sections[0] as SectionExercises;
    expect(set.proposals.map((proposal) => proposal.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    const one = set.proposals[0] as ExerciseProposal;
    const two = set.proposals[1] as ExerciseProposal;
    const three = set.proposals[2] as ExerciseProposal;
    expect(one.rect.right).toBeLessThanOrEqual(two.rect.left + 1e-9);
    expect(two.rect.right).toBeLessThanOrEqual(three.rect.left + 1e-9);
    // Each frame stays on its row.
    expect(one.rect.bottom).toBeLessThanOrEqual(set.proposals[3]?.rect.top ?? 1);
    expect(set.gaps).toEqual([]);
    expect(set.duplicates).toEqual([]);
  });
});

describe('an instruction that names the items it is for', () => {
  const specs: Spec[] = [
    heading(),
    { text: 'For Exercises 1-4, simplify each expression.', left: 0.143, top: 0.14 },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ text: `${n}. Compute ${n} + ${n + 1}.`, left: 0.143, top: 0.2 + (n - 1) * 0.05 })),
  ];
  const set = proposeExercises([page(0, specs)], [section(0, 1)]).sections[0] as SectionExercises;
  const labelled = (label: string): ExerciseProposal => set.proposals.find((proposal) => proposal.label === label) as ExerciseProposal;

  it('is the context of those items and of no others, in any weight and at any margin', () => {
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.governs).toEqual(['1', '2', '3', '4']);
    expect(labelled('3').context).toHaveLength(1);
    expect(labelled('5').context).toEqual([]);
    expect(labelled('5').evidence.join(' ')).toContain('the one above names 1 to 4, this item is beyond it');
    expect(labelled('2').evidence.join(' ')).toContain('(names 1 to 4)');
  });

  it('is not taken for an instruction when no item follows it: a sentence of a word problem may start like one', () => {
    const lonely: Spec[] = [heading(), { text: '1. A tank is filled for 2-3 days and then it stays full as long as it rains.', left: 0.143, top: 0.2 }, { text: '2. Compute 2 + 3.', left: 0.143, top: 0.3 }];
    const found = proposeExercises([page(0, lonely)], [section(0, 1)]).sections[0] as SectionExercises;
    expect(found.instructions).toEqual([]);
  });
});
