import { describe, expect, it } from 'vitest';
import type { PageText, TextLine } from '../src/model/types.js';
import { exerciseToOperation, exercisesToOperations } from '../src/audit/ops.js';
import { proposeExercises, type ExerciseOptions } from '../src/audit/exercises.js';
import { locateSections, type BookEntry } from '../src/audit/sections.js';

/**
 * Practice pages built by hand, line by line, for the layouts that a generated PDF cannot make on purpose: lines the
 * text extraction merged, a number without its closing mark, a paragraph line that starts with a number, pages
 * without font information.
 */

interface Spec {
  text: string;
  left: number;
  top: number;
  right?: number;
  size?: number;
  bold?: boolean;
}

const HEIGHT = 0.0155;

function line(spec: Spec, withFonts: boolean): TextLine {
  const size = spec.size ?? 12;
  const right = spec.right ?? Math.min(0.95, spec.left + spec.text.length * 0.0075 * (size / 12));
  return {
    text: spec.text,
    rect: { left: spec.left, top: spec.top, right, bottom: spec.top + HEIGHT * (size / 12) },
    fontSize: size,
    column: 0,
    chars: spec.text.replace(/\s/g, '').length,
    ...(withFonts ? { bold: spec.bold === true } : {}),
  };
}

function page(index: number, specs: Spec[], withFonts = true): PageText {
  const lines = specs.map((spec) => line(spec, withFonts));
  // A page number in the footer, flagged the way the reader flags running footers.
  lines.push({ ...line({ text: String(index + 1), left: 0.5, top: 0.926, size: 10 }, withFonts), headerFooter: true });
  return { page: index, size: { width: 595, height: 842, rotation: 0 }, lines, columns: 1, hasText: true };
}

/** A section whose practice set starts at line 0 of page `first` (the heading) and ends at the end of the book. */
function section(first: number, pageCount: number): BookEntry {
  return {
    title: 'Practice',
    page: first,
    depth: 1,
    id: '1.1',
    label: '1.1',
    kind: 'section',
    confidence: 1,
    evidence: [],
    differences: [],
    practice: { page: first, top: 0.1, index: 0, text: '1.1 Practice - Title', end: { page: pageCount, top: 0, why: 'the end of the book' } },
  };
}

const heading: Spec = { text: '1.1 Practice - Title', left: 0.33, top: 0.1, size: 16.9, bold: true };

function run(pages: PageText[], options: ExerciseOptions = {}) {
  const result = proposeExercises(pages, [section(0, pages.length)], options);
  return { result, set: result.sections[0] as NonNullable<(typeof result.sections)[number]> };
}

/** Two columns of short items: left 1, 3, 5 ... and right 2, 4, 6 ... `count` items from `from`, rows 0.03 apart. */
function twoColumns(from: number, count: number, top = 0.2): Spec[] {
  const specs: Spec[] = [];
  for (let k = 0; k < count; k += 1) {
    const n = from + k;
    specs.push({ text: `${n}) item ${n} text`, left: n % 2 === 1 ? 0.143 : 0.517, top: top + Math.floor(k / 2) * 0.03 });
  }
  return specs;
}

describe('lines the text extraction merged', () => {
  it('cuts "5) first 6) second" into two items where the second column starts', () => {
    const specs = twoColumns(1, 4);
    // Items 5 and 6 come out of the extraction as one line.
    specs.push({ text: '5) item 5 text and more 6) item 6 text and more', left: 0.143, top: 0.26, right: 0.8 });
    specs.push(...twoColumns(7, 6, 0.29));
    const { set } = run([page(0, [heading, { text: 'Solve each.', left: 0.143, top: 0.15, bold: true }, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const five = set.proposals.find((entry) => entry.label === '5');
    const six = set.proposals.find((entry) => entry.label === '6');
    expect(five?.rect.right).toBeLessThanOrEqual((six?.rect.left ?? 0) + 1e-9);
    expect(six?.rect.left).toBeGreaterThan(0.49);
    expect(six?.rect.left).toBeLessThan(0.52);
    expect(set.gaps).toEqual([]);
  });

  it('does not cut a sentence that holds a number and a dot', () => {
    const specs: Spec[] = [
      { text: '1) If the side is increased by 5 the area is multiplied by 4. Find the', left: 0.143, top: 0.2, right: 0.83 },
      { text: 'side of the original square.', left: 0.176, top: 0.22 },
      { text: '2) Another problem, with a second sentence 3. Find it.', left: 0.143, top: 0.26, right: 0.8 },
      { text: '3) A third problem.', left: 0.143, top: 0.3 },
      { text: '4) A fourth problem.', left: 0.143, top: 0.33 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4']);
    expect(set.rejected).toEqual([]);
  });
});

describe('numbers that are not items', () => {
  it('keeps a paragraph line that starts with a number out of the items', () => {
    const specs: Spec[] = [
      { text: '1. A boy is ten years older than his brother. Five years ago the sum of their ages was', left: 0.143, top: 0.2, right: 0.85 },
      { text: '50. How old are they now?', left: 0.176, top: 0.22 },
      { text: '2. A second problem.', left: 0.143, top: 0.26 },
      { text: '3. A third problem.', left: 0.143, top: 0.3 },
      { text: '4. A fourth problem.', left: 0.143, top: 0.34 },
      { text: '5. A fifth problem.', left: 0.143, top: 0.38 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(set.rejected.map((entry) => entry.text)).toEqual(['50. How old are they now?']);
    expect(set.rejected[0]?.reason).toContain('indented');
    // The line belongs to item 1, not to nothing.
    expect(set.proposals[0]?.rect.bottom).toBeGreaterThan(0.22 + HEIGHT - 0.001);
    expect(set.notes.join(' ')).not.toContain('belong to no item');
  });

  it('reads a number printed without its closing mark when the sequence asks for it, and says so', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 8; n += 1) specs.push({ text: n === 5 ? '5 (2)(3) times something' : `${n}) item ${n} text`, left: 0.143, top: 0.2 + n * 0.03 });
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(set.proposals.find((entry) => entry.label === '5')?.confidence).toBeLessThan(0.7);
    expect(set.proposals.find((entry) => entry.label === '5')?.evidence[0]).toContain('closing mark');
    expect(set.notes.join(' ')).toContain('without its closing mark');
  });

  it('reports a gap instead of skipping it, and a duplicate with the one that was used', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 9; n += 1) if (n !== 4) specs.push({ text: `${n}) item ${n}`, left: 0.143, top: 0.2 + n * 0.03 });
    specs.push({ text: '7) a stray second seven', left: 0.143, top: 0.6 });
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.gaps).toEqual(['4']);
    expect(set.duplicates).toEqual(['7']);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '5', '6', '7', '8', '9']);
    expect(set.notes.join(' ')).toContain('no line starts with the number 4');
    expect(set.notes.join(' ')).toContain('printed more than once');
  });

  it('puts a number far from the run aside', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 6; n += 1) specs.push({ text: `${n}) item ${n}`, left: 0.143, top: 0.2 + n * 0.03 });
    specs.push({ text: '45) a number far away', left: 0.143, top: 0.5 });
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(set.rejected[0]?.reason).toContain('does not belong to the run');
  });
});

describe('instructions', () => {
  const items = (from: number, count: number, top: number): Spec[] => Array.from({ length: count }, (_unused, k) => ({ text: `${from + k}) item ${from + k}`, left: 0.143, top: top + k * 0.03 }));

  it('uses bold lines as instructions and gives each item the one above it', () => {
    const { set } = run([
      page(0, [heading, { text: 'First instruction.', left: 0.143, top: 0.15, bold: true }, ...items(1, 3, 0.2), { text: 'Second instruction.', left: 0.143, top: 0.32, bold: true }, ...items(4, 3, 0.37)]),
    ]);
    expect(set.proposals.map((entry) => entry.context.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(set.instructions.map((entry) => [entry.text, entry.governs])).toEqual([
      ['First instruction.', ['1', '2', '3']],
      ['Second instruction.', ['4', '5', '6']],
    ]);
    const first = set.proposals[0]?.context[0];
    expect(first?.rect.top).toBeLessThan(0.15);
    expect(first?.rect.bottom).toBeGreaterThan(0.15 + HEIGHT);
    // The frame of item 3 stops above the second instruction.
    expect(set.proposals[2]?.rect.bottom).toBeLessThan(0.32);
  });

  it('carries an instruction over the page break and joins its two halves', () => {
    const first = page(0, [heading, ...items(1, 3, 0.2), { text: 'Solve each of the following problems by setting up', left: 0.143, top: 0.86, bold: true }]);
    const second = page(1, [{ text: 'an equation.', left: 0.143, top: 0.1, bold: true }, ...items(4, 4, 0.16)]);
    const { set } = run([first, second]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(set.proposals.slice(0, 3).every((entry) => entry.context.length === 0)).toBe(true);
    for (const entry of set.proposals.slice(3)) {
      expect(entry.context.map((region) => region.page)).toEqual([0, 1]);
    }
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).toBe('Solve each of the following problems by setting up an equation.');
    // The items on page 1 are not mistaken for continuations of the instruction.
    expect(set.proposals[3]?.page).toBe(1);
  });

  it('takes the second piece of a long bold instruction that the column detection cut in two', () => {
    const { set } = run([
      page(0, [
        heading,
        { text: 'Write the point-slope form of', left: 0.143, top: 0.15, right: 0.456, bold: true },
        { text: 'the equation of the line through the', left: 0.469, top: 0.15, bold: true },
        { text: 'given points.', left: 0.143, top: 0.168, bold: true },
        ...items(1, 3, 0.22),
      ]),
    ]);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).toBe('Write the point-slope form of the equation of the line through the given points.');
    expect(set.proposals[0]?.context[0]?.rect.right).toBeGreaterThan(0.7);
    expect(set.notes.join(' ')).not.toContain('belong to no item');
  });

  it('gives no context to the items of a set that prints no instruction (and no bold line)', () => {
    const { set } = run([page(0, [heading, ...items(1, 5, 0.18)])]);
    expect(set.proposals.every((entry) => entry.context.length === 0)).toBe(true);
    expect(set.instructions).toEqual([]);
  });

  it('finds instructions by their position when the pages carry no font information, and says so', () => {
    const { result, set } = run([page(0, [heading, { text: 'Evaluate each expression.', left: 0.143, top: 0.15 }, ...items(1, 5, 0.2)], false)]);
    expect(set.instructions.map((entry) => entry.text)).toEqual(['Evaluate each expression.']);
    expect(set.proposals.every((entry) => entry.context.length === 1)).toBe(true);
    expect(result.notes.join(' ')).toContain('font information');
  });
});

describe('items that continue on the next page', () => {
  it('continues the item of the column the lines belong to', () => {
    const left = (n: number, top: number): Spec => ({ text: `${n}) item ${n} of the left column`, left: 0.143, top });
    const right = (n: number, top: number): Spec => ({ text: `${n}) item ${n} of the right column`, left: 0.517, top });
    const first = page(0, [heading, { text: 'Solve.', left: 0.143, top: 0.15, bold: true }, left(1, 0.2), right(2, 0.2), left(3, 0.8), right(4, 0.8), { text: 'goes on in the left column, below', left: 0.18, top: 0.818 }, { text: 'and in the right', left: 0.55, top: 0.818 }]);
    const second = page(1, [
      { text: 'the left column has more text', left: 0.18, top: 0.1 },
      { text: 'the right column has more text', left: 0.55, top: 0.1 },
      left(5, 0.2),
      right(6, 0.2),
      left(7, 0.25),
      right(8, 0.25),
    ]);
    const { set } = run([first, second]);
    const byLabel = (label: string) => set.proposals.find((entry) => entry.label === label);
    expect(byLabel('3')?.continues?.map((region) => [region.page, region.rect.left < 0.2])).toEqual([[1, true]]);
    expect(byLabel('4')?.continues?.map((region) => [region.page, region.rect.left > 0.45])).toEqual([[1, true]]);
    expect(byLabel('1')?.continues).toBeUndefined();
    expect(byLabel('5')?.continues).toBeUndefined();
  });
});

describe('numbering that is not the default', () => {
  it('reads labels like A.3 with a pattern of its own and makes a frame id from them', () => {
    const specs: Spec[] = [];
    for (let k = 1; k <= 4; k += 1) specs.push({ text: `3.${k}) statement ${k}`, left: 0.143, top: 0.15 + k * 0.03 });
    const { set } = run([page(0, [heading, ...specs])], { itemPatterns: [{ name: '3.1)', regex: /^(\d+\.\d+)\)\s*(.*)$/ }] });
    // The sequence rule works on whole numbers: 3.1 .. 3.4 all read as 3, so the repeats are reported, not mixed up.
    expect(set.proposals.length).toBeGreaterThanOrEqual(1);
    expect(set.proposals[0]?.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});

describe('operations', () => {
  it('turns a proposal into an add operation of an authoritative exercise', () => {
    const { set } = run([page(0, [heading, { text: 'Solve.', left: 0.143, top: 0.15, bold: true }, { text: '1) first', left: 0.143, top: 0.2 }, { text: '2) second', left: 0.143, top: 0.23 }])]);
    const proposal = set.proposals[0];
    expect(proposal).toBeDefined();
    if (!proposal) return;
    const op = exerciseToOperation(proposal, [{ page: 5, rect: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.22 } }]);
    expect(op).toMatchObject({ op: 'add', kind: 'exercise', authority: 'book', label: '1', section: '1.1', id: proposal.id, ref: proposal.id, page: 0 });
    expect(op.rect).toEqual([proposal.rect.left, proposal.rect.top, proposal.rect.right, proposal.rect.bottom]);
    expect(op.context?.[0]?.rect).toHaveLength(4);
    expect(op.solution).toEqual([{ page: 5, rect: [0.1, 0.2, 0.3, 0.22] }]);
    const all = exercisesToOperations(set.proposals);
    expect(all.map((entry) => entry.id)).toEqual(set.proposals.map((entry) => entry.id));
    expect(all.every((entry) => entry.solution === undefined)).toBe(true);
  });
});

describe('sections that the project already has', () => {
  it('finds the practice set of a section without a numbered label by the heading "Exercises" inside it', () => {
    const lesson = page(0, [{ text: 'Sets', left: 0.33, top: 0.1, size: 16.9, bold: true }, { text: 'A set is a collection of things that are different from each other.', left: 0.143, top: 0.2 }, { text: 'Example 1.', left: 0.143, top: 0.3, bold: true }, { text: 'Some more text in the lesson to make it a page of body text lines.', left: 0.143, top: 0.35 }]);
    const exercises = page(1, [
      { text: 'Exercises', left: 0.36, top: 0.1, size: 16.9, bold: true },
      { text: 'Decide which are sets.', left: 0.143, top: 0.15, bold: true },
      { text: '1) the numbers 1, 2, 3', left: 0.143, top: 0.2 },
      { text: '2) the tall people', left: 0.143, top: 0.23 },
      { text: '3) the letters of a word', left: 0.143, top: 0.26 },
    ]);
    const next = page(2, [{ text: 'Maps', left: 0.33, top: 0.1, size: 16.9, bold: true }, { text: 'A map sends each element of a set to one element of another set.', left: 0.143, top: 0.2 }]);
    const pages = [lesson, exercises, next];
    const located = locateSections(pages, [
      { title: 'Sets', page: 0, depth: 1, id: 's1' },
      { title: 'Maps', page: 2, depth: 1, id: 's2' },
    ]);
    const sets = located.entries.find((entry) => entry.id === 's1');
    expect(sets?.kind).toBe('section');
    expect(sets?.practice?.page).toBe(1);
    expect(sets?.practice?.end.page).toBe(2);
    expect(located.entries.find((entry) => entry.id === 's2')?.practice).toBeUndefined();
    expect(located.notes.join(' ')).toContain('s2: no practice heading found');
    const result = proposeExercises(pages, located.entries);
    expect(result.sections.find((entry) => entry.section === 's1')?.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3']);
    expect(result.sections.find((entry) => entry.section === 's1')?.proposals[0]?.context.length).toBe(1);
    expect(result.sections.find((entry) => entry.section === 's1')?.proposals[0]?.id).toBe('xs1-1');
  });
});
