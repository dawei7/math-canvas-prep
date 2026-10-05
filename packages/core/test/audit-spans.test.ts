import { describe, expect, it } from 'vitest';
import { proposeExercises, type ExerciseProposal, type SectionExercises } from '../src/audit/exercises.js';
import { proposeSolutions, type SolutionProposal } from '../src/audit/solutions.js';
import type { BookEntry } from '../src/audit/sections.js';
import type { PageText } from '../src/model/types.js';
import { heading, inkProfile, page, paragraph, section, type Spec } from './audit-pages.js';

/**
 * An exercise that goes on after the end of its page or column: over pages that have no item of their own, from one column
 * into the next, over a page that holds only a figure. Pages are built by hand and every text is made up.
 */

const instruction: Spec = { text: 'Solve each problem.', left: 0.143, top: 0.14, bold: true };

const item = (n: number, top: number, left = 0.143, column = 0): Spec => ({ text: `${n}. Compute ${n} + ${n + 1}.`, left, top, column });

function run(pages: PageText[]): SectionExercises {
  const result = proposeExercises(pages, [section(0, pages.length)]);
  return result.sections[0] as SectionExercises;
}

const labelled = (set: SectionExercises, label: string): ExerciseProposal => set.proposals.find((entry) => entry.label === label) as ExerciseProposal;

/** The pages of a span, as the notes of a section name them. */
const spanNote = (set: SectionExercises): string => set.notes.find((note) => /go on after|goes on after/.test(note)) ?? '';

describe('an exercise that runs over pages without items of their own', () => {
  // Exercise 3 starts at the bottom of page 0, page 1 is a full page of lines without a number, page 2 has five more and then items 4 and 5.
  const pages = (): PageText[] => [
    page(0, [heading(), instruction, item(1, 0.2), item(2, 0.25), { text: '3. A long problem with a table and a proof; read all of it first.', left: 0.143, top: 0.8 }, ...paragraph('first page of problem three', 5, 0.8175)]),
    page(1, paragraph('middle page of problem three', 46, 0.07)),
    page(2, [...paragraph('last page of problem three', 5, 0.07), item(4, 0.2), item(5, 0.25)]),
  ];

  it('gives the exercise a region on every page it runs over, and leaves no line without an owner', () => {
    const set = run(pages());
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    const three = labelled(set, '3');
    expect(three.continues?.map((region) => region.page)).toEqual([1, 2]);
    expect(set.notes.some((note) => /belong to no item/.test(note))).toBe(false);
    // The text of the last page ends where the next number starts.
    const last = three.continues?.[1];
    expect(last?.rect.top).toBeLessThan(0.1);
    expect(last?.rect.bottom).toBeGreaterThan(0.07 + 4 * 0.0175);
    expect(last?.rect.bottom).toBeLessThan(labelled(set, '4').rect.top);
  });

  it('lists the span in the notes with its pages and its regions', () => {
    const set = run(pages());
    expect(spanNote(set)).toContain('3 (pages 0-2, 2 continuation regions)');
    expect(labelled(set, '3').evidence.join(' ')).toContain('continues on page 1, 2');
  });

  it('never takes a numbered line of another item', () => {
    // A numbered line in the middle of page 1 is an item of its own: the span ends above it and the item starts there.
    const broken = pages();
    broken[1] = page(1, [...paragraph('middle page of problem three', 20, 0.07), item(4, 0.5), ...paragraph('after four, a line of its own', 3, 0.53)]);
    broken[2] = page(2, [item(5, 0.2), item(6, 0.25)]);
    const set = run(broken);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    const three = labelled(set, '3');
    expect(three.continues?.map((region) => region.page)).toEqual([1]);
    expect(three.continues?.[0]?.rect.bottom).toBeLessThan(labelled(set, '4').rect.top);
  });

  it('does not run on after an exercise that ends in the middle of its page', () => {
    // Exercise 3 ends high on page 0: the lines at the top of page 1 are not its text, they are left over (and the notes say so).
    const short = pages();
    short[0] = page(0, [heading(), instruction, item(1, 0.2), item(2, 0.25), item(3, 0.3)]);
    short[1] = page(1, [...paragraph('a stray paragraph', 3, 0.07), item(4, 0.3)]);
    short[2] = page(2, [item(5, 0.2)]);
    const set = run(short);
    expect(labelled(set, '3').continues).toBeUndefined();
    expect(set.notes.join(' ')).toContain('3 lines belong to no item');
  });

  it('stops after nine pages and says that the rest is not framed', () => {
    // Exercise 3 runs over eleven pages: the first eight continuation regions are kept.
    const long: PageText[] = [page(0, [heading(), instruction, item(1, 0.2), item(2, 0.25), { text: '3. A very long problem.', left: 0.143, top: 0.8 }, ...paragraph('first page', 5, 0.8175)])];
    for (let k = 1; k <= 10; k += 1) long.push(page(k, paragraph(`page ${k} of the problem`, 46, 0.07)));
    long.push(page(11, [...paragraph('the last page', 3, 0.07), item(4, 0.2)]));
    const set = run(long);
    const three = labelled(set, '3');
    expect(three.continues).toHaveLength(8);
    expect(three.continues?.map((region) => region.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(spanNote(set)).toContain('beyond the limit of 8 continuation regions');
  });
});

describe('an exercise that runs from one column into the next', () => {
  // Two columns: the left one ends with exercise 3, which goes on at the top of the right one; the right one ends with exercise 6,
  // which goes on at the top of the left column of the next page.
  const left = 0.143;
  const right = 0.55;
  const pages = (): PageText[] => [
    page(
      0,
      [
        heading(),
        instruction,
        item(1, 0.2),
        item(2, 0.3),
        { text: '3. A problem that fills the end of the left column.', left, top: 0.78, right: 0.45 },
        ...paragraph('left column, problem three', 6, 0.7975, 0.17, 0, true),
        ...paragraph('right column, still problem three', 4, 0.2, 0.577, 1, true),
        item(4, 0.32, right, 1),
        item(5, 0.5, right, 1),
        { text: '6. A problem that fills the end of the right column.', left: right, top: 0.78, column: 1, right: 0.95 },
        ...paragraph('right column, problem six', 6, 0.7975, 0.577, 1, true),
      ],
      { columns: 2 },
    ),
    page(1, [...paragraph('left column, still problem six', 4, 0.1, 0.17, 0, true), item(7, 0.3), item(8, 0.4, right, 1)], { columns: 2 }),
  ];

  it('gives the exercise a region in the next column, in reading order, and one on the next page', () => {
    const set = run(pages());
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const three = labelled(set, '3');
    expect(three.continues).toHaveLength(1);
    const across = three.continues?.[0];
    expect(across?.page).toBe(0);
    expect(across?.rect.left).toBeGreaterThan(0.5);
    expect(across?.rect.bottom).toBeLessThan(labelled(set, '4').rect.top);
    const six = labelled(set, '6');
    expect(six.continues).toHaveLength(1);
    expect(six.continues?.[0]?.page).toBe(1);
    expect(six.continues?.[0]?.rect.right).toBeLessThan(0.5);
    expect(six.continues?.[0]?.rect.bottom).toBeLessThan(labelled(set, '7').rect.top);
    expect(set.notes.some((note) => /belong to no item/.test(note))).toBe(false);
    expect(spanNote(set)).toContain('3 (page 0, in the next column, 1 continuation region)');
    expect(spanNote(set)).toContain('6 (pages 0-1, 1 continuation region)');
  });
});

describe('an exercise with a page that holds only a figure', () => {
  const figure = inkProfile([{ from: 0.2, to: 0.7 }]);
  const start = (): PageText =>
    page(0, [heading(), instruction, item(1, 0.2), item(2, 0.25), { text: '3. Use the figure on the next page to answer the questions.', left: 0.143, top: 0.8 }, ...paragraph('before the figure', 5, 0.8175)]);

  it('covers the figure page when the text of the exercise goes on after it', () => {
    const set = run([start(), page(1, [], { ink: figure }), page(2, [...paragraph('after the figure', 3, 0.07), item(4, 0.2)])]);
    const three = labelled(set, '3');
    expect(three.continues?.map((region) => region.page)).toEqual([1, 2]);
    const covered = three.continues?.[0];
    expect(covered?.rect.top).toBeGreaterThan(0.18);
    expect(covered?.rect.top).toBeLessThan(0.21);
    expect(covered?.rect.bottom).toBeGreaterThan(0.69);
    expect(covered?.rect.bottom).toBeLessThan(0.72);
    expect(three.evidence.join(' ')).toContain('with a page that holds only a figure');
  });

  it('leaves the figure page out when a number follows it', () => {
    const set = run([start(), page(1, [], { ink: figure }), page(2, [item(4, 0.2), item(5, 0.25)])]);
    expect(labelled(set, '3').continues).toBeUndefined();
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The same for the answers of a key

const answerEntries = (...labels: string[]): BookEntry[] =>
  labels.map((label, index) => ({ title: `Section ${label}`, page: index, depth: 1, id: label, label, kind: 'section' as const, confidence: 1, evidence: [], differences: [] }));

/** The top of a key: the header of the chapter, the small marker of section 1.1 and the header of its answers. */
const keyTop: Spec[] = [
  { text: 'Answers - Chapter 1', left: 0.36, top: 0.1, size: 16.9 },
  { text: '1.1', left: 0.143, top: 0.15, size: 10 },
  { text: 'Answers - Section 1.1', left: 0.4, top: 0.17 },
];

const answer = (n: number, top: number, left = 0.143, column = 0): Spec => ({ text: `${n}) answer ${n}`, left, top, column });

describe('an answer that runs over pages or columns', () => {
  it('gets a region on every page it runs over and leaves no line of the key without an answer', () => {
    const pages = [
      page(0, [...keyTop, answer(1, 0.22), answer(2, 0.25), answer(3, 0.28), { text: '4) the long answer: a table, then the working', left: 0.143, top: 0.8 }, ...paragraph('long answer, first page', 5, 0.8175)]),
      page(1, paragraph('long answer, middle page', 46, 0.07)),
      page(2, [...paragraph('long answer, last page', 5, 0.07), answer(5, 0.2), answer(6, 0.25)]),
    ];
    const result = proposeSolutions(pages, answerEntries('1.1'), undefined, { answerKey: { page: 0, top: 0.1 } });
    const found = result.sections[0]?.answers ?? [];
    expect(found.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    const four = found.find((entry) => entry.label === '4') as SolutionProposal;
    expect(four.regions.map((region) => region.page)).toEqual([0, 1, 2]);
    expect(four.evidence.join(' ')).toContain('goes on in 2 further regions');
    expect(four.regions[2]?.rect.bottom).toBeLessThan((found.find((entry) => entry.label === '5') as SolutionProposal).regions[0]?.rect.top ?? 0);
    expect(result.notes.some((note) => /belong to no answer/.test(note))).toBe(false);
    expect(result.sections[0]?.notes).toContain('one answer goes on after the end of its page or column: 4 (pages 0-2, 2 continuation regions)');
  });

  it('keeps at most eight regions of an answer and says so', () => {
    const pages: PageText[] = [page(0, [...keyTop, answer(1, 0.22), { text: '2) a very long answer', left: 0.143, top: 0.8 }, ...paragraph('long answer, first page', 5, 0.8175)])];
    for (let k = 1; k <= 9; k += 1) pages.push(page(k, paragraph(`long answer, page ${k}`, 46, 0.07)));
    pages.push(page(10, [...paragraph('long answer, last page', 3, 0.07), answer(3, 0.2)]));
    const result = proposeSolutions(pages, answerEntries('1.1'), undefined, { answerKey: { page: 0, top: 0.1 } });
    const two = result.sections[0]?.answers.find((entry) => entry.label === '2') as SolutionProposal;
    expect(two.regions).toHaveLength(8);
    expect(two.regions.map((region) => region.page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.sections[0]?.notes.join(' ')).toContain('beyond the limit of 7 continuation regions');
  });

  it('goes from the bottom of one column to the top of the next, and from the last column to the next page', () => {
    const right = 0.55;
    const pages = [
      page(
        0,
        [
          ...keyTop,
          answer(1, 0.22),
          answer(2, 0.4),
          { text: '3) a long answer that fills the rest of the column', left: 0.143, top: 0.78, right: 0.45 },
          ...paragraph('answer three, the left column', 6, 0.7975, 0.17, 0, true),
          ...paragraph('answer three, in the right column', 4, 0.22, 0.577, 1, true),
          answer(4, 0.34, right, 1),
          { text: '5) a long answer that fills the end of the right column', left: right, top: 0.78, column: 1, right: 0.95 },
          ...paragraph('answer five, in the right column', 6, 0.7975, 0.577, 1, true),
        ],
        { columns: 2 },
      ),
      page(1, [...paragraph('answer five, on the next page', 4, 0.1, 0.17, 0, true), answer(6, 0.3), answer(7, 0.4, right, 1)], { columns: 2 }),
    ];
    const result = proposeSolutions(pages, answerEntries('1.1'), undefined, { answerKey: { page: 0, top: 0.1 } });
    const found = result.sections[0]?.answers ?? [];
    expect(found.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const three = found.find((entry) => entry.label === '3') as SolutionProposal;
    expect(three.regions.map((region) => region.page)).toEqual([0, 0]);
    expect(three.regions[1]?.rect.left).toBeGreaterThan(0.5);
    const five = found.find((entry) => entry.label === '5') as SolutionProposal;
    expect(five.regions.map((region) => region.page)).toEqual([0, 1]);
    expect(five.regions[1]?.rect.right).toBeLessThan(0.5);
    expect(result.notes.some((note) => /belong to no answer/.test(note))).toBe(false);
  });
});

describe('an instruction that runs over two page breaks', () => {
  it('is one context with a region on each of its three pages', () => {
    const bold = (specs: Spec[]): Spec[] => specs.map((spec) => ({ ...spec, bold: true, left: 0.143 }));
    const set = run([
      page(0, [heading(), instruction, item(1, 0.2), item(2, 0.25), ...bold(paragraph('a long instruction, first page', 3, 0.85))]),
      page(1, bold(paragraph('a long instruction, middle page', 46, 0.07))),
      page(2, [...bold(paragraph('a long instruction, last page', 3, 0.07)), item(3, 0.2), item(4, 0.25)]),
    ]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4']);
    expect(labelled(set, '3').context.map((region) => region.page)).toEqual([0, 1, 2]);
    expect(labelled(set, '4').context.map((region) => region.page)).toEqual([0, 1, 2]);
    expect(labelled(set, '1').context).toHaveLength(1);
    expect(set.instructions).toHaveLength(2);
  });
});

describe('lines that are not the text of the item before', () => {
  const open = (): Spec[] => [heading(), instruction, item(1, 0.2), { text: '2. A problem that fills the end of the page.', left: 0.143, top: 0.8 }, ...paragraph('problem two, first page', 5, 0.8175)];

  it('leaves a short row at the top of the next column (the numerator of a fraction) to the notes', () => {
    // The row stands above the first item of the left column, so no item of that column claims it.
    const set = run([page(0, [...open(), { text: '3 5', left: 0.6, top: 0.18, column: 1 }, item(3, 0.32, 0.55, 1)], { columns: 2 })]);
    expect(labelled(set, '2').continues).toBeUndefined();
    expect(set.notes.join(' ')).toContain('1 line belong to no item');
  });

  it('leaves a stretch that stands low on the next page, away from the left edge of the items, to the notes', () => {
    const stretch = (top: number): Spec[] => paragraph('a stretch of text that stands somewhere', 3, top, 0.4);
    const low = run([page(0, open()), page(1, [...stretch(0.5), item(3, 0.7)])]);
    expect(labelled(low, '2').continues).toBeUndefined();
    expect(low.notes.join(' ')).toContain('3 lines belong to no item');
    // The same stretch at the top of the page is the text of the item that fills the end of the page before.
    const high = run([page(0, open()), page(1, [...stretch(0.07), item(3, 0.7)])]);
    expect(labelled(high, '2').continues?.map((region) => region.page)).toEqual([1]);
  });
});

describe('lines under an item of the next page', () => {
  it('are not the text of the item that fills the end of the page before: only a line above the first item of its column goes on', () => {
    const open: Spec[] = [heading(), instruction, item(1, 0.2), { text: '2. A problem that fills the end of the page.', left: 0.143, top: 0.8 }, ...paragraph('problem two, first page', 5, 0.8175)];
    // A table that stands far under item 3 (more than one line of gap) has no item to belong to; it must not run on from item 2.
    const set = run([page(0, open), page(1, [item(3, 0.1), ...paragraph('a table that stands far under item three', 3, 0.5)])]);
    expect(labelled(set, '2').continues).toBeUndefined();
    expect(set.notes.join(' ')).toContain('3 lines belong to no item');
  });
});
