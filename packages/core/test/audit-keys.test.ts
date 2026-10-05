import { describe, expect, it } from 'vitest';
import { findCandidates, selectSequence, type PLine } from '../src/audit/layout.js';
import type { BookEntry } from '../src/audit/sections.js';
import type { BookPatterns } from '../src/audit/scan.js';
import { proposeSolutions, looksLikeFlow, type BookSolutions, type ExerciseRef } from '../src/audit/solutions.js';
import { DEFAULT_ITEM_PATTERNS } from '../src/audit/exercises.js';
import type { PageText } from '../src/model/types.js';
import { line, page, type Spec } from './audit-pages.js';

/**
 * Answer keys in the forms a held-out book may print: markers of a section ("Section 1.1 (p. 5)", the label alone, a pattern of
 * the sidecar) that must follow the order of the sections, answers printed for a range of exercises, answers printed for some
 * exercises only, keys that run on like a paragraph, and the sequence of numbers that tells an answer from a number inside one.
 * Pages are built by hand and every text is made up.
 */

const sections = (...labels: string[]): BookEntry[] =>
  labels.map((label, index) => ({ title: `Section ${label}`, page: index, depth: 1, id: label, label, kind: 'section' as const, confidence: 1, evidence: [], differences: [] }));

const keyHead: Spec = { text: 'Answers - Chapter 1', left: 0.36, top: 0.08, size: 16.9, bold: true };

const answerLines = (from: number, count: number, top: number, step = 1): Spec[] => Array.from({ length: count }, (_, k) => ({ text: `${from + k * step}. answer ${from + k * step}`, left: 0.143, top: top + k * 0.03 }));

const refs = (section: string, count: number): ExerciseRef[] => Array.from({ length: count }, (_, k) => ({ section, label: String(k + 1) }));

const run = (pages: PageText[], entries: BookEntry[], exercises?: ExerciseRef[], patterns?: Partial<BookPatterns>): BookSolutions =>
  proposeSolutions(pages, entries, exercises, { answerKey: { page: 0, top: 0.05 }, ...(patterns ? { patterns } : {}) });

const labelsOf = (result: BookSolutions, section: string): string[] => result.sections.find((entry) => entry.section === section)?.answers.map((answer) => answer.label) ?? [];

describe('the markers that tell where the answers of a section start', () => {
  const key = (marker: (label: string) => string): PageText =>
    page(0, [keyHead, { text: marker('1.1'), left: 0.143, top: 0.14, size: 12 }, ...answerLines(1, 3, 0.18), { text: marker('1.2'), left: 0.143, top: 0.32, size: 12 }, ...answerLines(1, 4, 0.36)]);

  it('reads "Section 1.1 (p. 5)" as the start of the answers of section 1.1, the way most books of this layout print it', () => {
    const result = run([key((label) => `Section ${label} (p. 5)`)], sections('1.1', '1.2'));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3']);
    expect(labelsOf(result, '1.2')).toEqual(['1', '2', '3', '4']);
    expect(result.sections[0]?.answers[0]?.evidence.join(' ')).toContain('marker "1.1"');
  });

  it('reads the label alone on a line the same way', () => {
    const result = run([key((label) => label)], sections('1.1', '1.2'));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3']);
    expect(labelsOf(result, '1.2')).toEqual(['1', '2', '3', '4']);
  });

  it('reads the markers a sidecar gives as patterns (group 1 is the label), and only those', () => {
    const own = key((label) => `Teil ${label}`);
    const found = run([own], sections('1.1', '1.2'), undefined, { answerMarkers: ['^Teil\\s+(\\d+\\.\\d+)'] });
    expect(labelsOf(found, '1.1')).toEqual(['1', '2', '3']);
    expect(labelsOf(found, '1.2')).toEqual(['1', '2', '3', '4']);
    // The default pattern does not know "Teil": the answers cannot be told apart by section.
    const unknown = run([own], sections('1.1', '1.2'));
    expect(labelsOf(unknown, '1.1')).not.toEqual(['1', '2', '3']);
  });

  it('takes a marker only for a section that comes next in the order of the book: a table value that looks like a label is not one', () => {
    const labels = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '2.1'];
    // "2.1" stands alone in the middle of the answers of 1.1 (a value of a table), "1.1" again after the marker of 1.2.
    const specs: Spec[] = [
      keyHead,
      { text: '1.1', left: 0.143, top: 0.14, size: 12 },
      ...answerLines(1, 2, 0.18),
      { text: '2.1', left: 0.143, top: 0.25, size: 12 },
      { text: '3. answer 3', left: 0.143, top: 0.28 },
      { text: '1.2', left: 0.143, top: 0.36, size: 12 },
      ...answerLines(1, 2, 0.4),
      { text: '1.1', left: 0.143, top: 0.5, size: 12 },
      { text: '3. answer 3', left: 0.143, top: 0.54 },
    ];
    const result = run([page(0, specs)], sections(...labels));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3']);
    expect(labelsOf(result, '1.2')).toEqual(['1', '2', '3']);
    expect(labelsOf(result, '2.1')).toEqual([]);
    expect(result.notes.join(' ')).toContain('2 lines like a section marker were not taken for one because the section does not come next in the book\'s order');
  });
});

describe('the top of a page of the key', () => {
  const first = page(0, [keyHead, { text: 'Section 1.1 (p. 5)', left: 0.143, top: 0.14, size: 12 }, ...answerLines(1, 3, 0.18)]);

  it('keeps the marker of a section that stands in the margin, at the very top of its page', () => {
    const second = page(1, [{ text: 'Section 1.2 (p. 9)', left: 0.143, top: 0.012, size: 12 }, ...answerLines(1, 4, 0.06)]);
    const result = run([first, second], sections('1.1', '1.2'));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3']);
    expect(labelsOf(result, '1.2')).toEqual(['1', '2', '3', '4']);
  });

  it('keeps an answer that stands in the margin, the first of its page', () => {
    const second = page(1, [{ text: '4. answer 4', left: 0.143, top: 0.012 }, ...answerLines(5, 2, 0.05)]);
    const result = run([first, second], sections('1.1'));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('leaves a head in the margin out of an answer that is a number alone at the bottom of its page: the region does not reach up to the head', () => {
    // A running head that no reader flagged, over the right column, and "5." alone at the foot of that column: its figure is drawn above or beside the number.
    const head: Spec = { text: 'Chapter 1. Basics of Counting, Answer Key', left: 0.579, top: 0.025 };
    const second = page(1, [head, { text: '4. answer 4', left: 0.143, top: 0.2 }, { text: '5.', left: 0.409, top: 0.9 }]);
    const result = run([first, second], sections('1.1'));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3', '4', '5']);
    const five = result.sections.find((entry) => entry.section === '1.1')?.answers[4];
    expect(five?.regions[0]?.rect.top).toBeGreaterThan(0.85);
  });
});

describe('answers printed for a range of exercises', () => {
  const book = (): PageText[] => [
    page(0, [keyHead, { text: '1.1', left: 0.143, top: 0.14, size: 12 }, { text: '1-3. Answers will vary.', left: 0.143, top: 0.18 }, { text: '4. 56', left: 0.143, top: 0.21 }, { text: '5-6. Yes, both are right.', left: 0.143, top: 0.24 }, { text: '7. 12', left: 0.143, top: 0.27 }]),
  ];

  it('gives the same region to every exercise of the range and says so', () => {
    const result = run(book(), sections('1.1'), refs('1.1', 7));
    const answers = result.sections[0]?.answers ?? [];
    expect(answers.map((answer) => answer.label)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(answers.filter((answer) => answer.range !== undefined).map((answer) => [answer.label, answer.range])).toEqual([['1', '1-3'], ['2', '1-3'], ['3', '1-3'], ['5', '5-6'], ['6', '5-6']]);
    expect(answers[0]?.regions).toEqual(answers[2]?.regions);
    expect(answers[0]?.regions).not.toEqual(answers[3]?.regions);
    expect(answers[0]?.evidence.join(' ')).toContain('one answer is printed for the exercises 1-3');
    expect(result.sections[0]?.withoutAnswer).toEqual([]);
  });

  it('prefers an answer printed for the exercise itself to a share of a range', () => {
    const pages = [page(0, [keyHead, { text: '1.1', left: 0.143, top: 0.14, size: 12 }, { text: '1-3. Answers will vary.', left: 0.143, top: 0.18 }, { text: '2. but this one is 17', left: 0.143, top: 0.21 }])];
    const answers = run(pages, sections('1.1'), refs('1.1', 3)).sections[0]?.answers ?? [];
    expect(answers.find((answer) => answer.label === '2')?.range).toBeUndefined();
    expect(answers.find((answer) => answer.label === '1')?.range).toBe('1-3');
  });
});

describe('answers printed for some exercises only', () => {
  const pages = (): PageText[] => [page(0, [keyHead, { text: '1.1', left: 0.143, top: 0.14, size: 12 }, ...answerLines(1, 4, 0.18, 2), { text: '1.2', left: 0.143, top: 0.36, size: 12 }, ...answerLines(1, 3, 0.4)])];

  it('says once for the section and once for the book that the answers are selected, not once for every exercise', () => {
    const result = run(pages(), sections('1.1', '1.2'), [...refs('1.1', 10), ...refs('1.2', 3)]);
    const first = result.sections.find((entry) => entry.section === '1.1');
    expect(first?.selected).toBe(true);
    expect(first?.coverage).toEqual({ exercises: 10, answered: 4 });
    expect(first?.notes).toContain('answers printed for 4 of 10 exercises (selected answers)');
    // ... and not, in addition, one line for each exercise without an answer.
    expect(first?.notes.filter((note) => note.startsWith('no answer for the exercise'))).toEqual([]);
    expect(result.sections.find((entry) => entry.section === '1.2')?.selected).toBeUndefined();
    expect(result.coverage).toEqual({ exercises: 13, answered: 7, sections: 2, selectedSections: 1 });
    expect(result.notes.filter((note) => note.includes('selected answers only'))).toHaveLength(1);
    expect(result.notes.join(' ')).toContain('answers printed for 7 of 13 exercises (54 %): this book prints selected answers only (1 section with some exercises unanswered); an exercise without an answer is not a defect');
  });

  it('finds answers whose numbers are further apart than the numbers of exercises are (1, 3, 5, 7)', () => {
    const result = run(pages(), sections('1.1', '1.2'), [...refs('1.1', 10), ...refs('1.2', 3)]);
    expect(labelsOf(result, '1.1')).toEqual(['1', '3', '5', '7']);
  });

  it('does not take a number inside an answer for an answer when the exercises say where the numbers end', () => {
    // Exercise 4 is the last; "40." lines inside the answer of 3 are values, not answers.
    const specs: Spec[] = [keyHead, { text: '1.1', left: 0.143, top: 0.14, size: 12 }, ...answerLines(1, 3, 0.18), { text: '40. a value inside the answer of 3', left: 0.143, top: 0.28 }, { text: '4. answer 4', left: 0.143, top: 0.31 }];
    const result = run([page(0, specs)], sections('1.1'), refs('1.1', 4));
    expect(labelsOf(result, '1.1')).toEqual(['1', '2', '3', '4']);
  });
});

describe('keys that run on like a paragraph', () => {
  const start = (label: string, left: number, top: number): PLine => {
    const entry: PLine = { page: 0, index: Math.round(top * 1000 + left * 10), line: line({ text: `${label}. answer`, left, top }), role: 'start' };
    return entry;
  };

  it('is told from a key set in columns by the places where the numbers inside the lines stand', () => {
    // Four rows of three answers: the numbers of the second and third column stand at the same x in every row: a set key.
    const columns = [0.143, 0.392, 0.642];
    const set: PLine[] = [];
    for (let row = 0; row < 4; row += 1) columns.forEach((left, at) => set.push(start(String(row * 3 + at + 1), left, 0.2 + row * 0.03)));
    expect(looksLikeFlow(set)).toBe(false);
    // The same count of numbers at places that depend on the words before them: a paragraph.
    const flow: PLine[] = [];
    for (let row = 0; row < 4; row += 1) [0.143, 0.31 + row * 0.047, 0.55 - row * 0.031].forEach((left, at) => flow.push(start(String(row * 3 + at + 1), left, 0.2 + row * 0.03)));
    expect(looksLikeFlow(flow)).toBe(true);
  });

  it('is not guessed from a few lines', () => {
    expect(looksLikeFlow([start('1', 0.143, 0.2), start('2', 0.4, 0.2), start('3', 0.143, 0.23), start('4', 0.43, 0.23)])).toBe(false);
  });
});

describe('the sequence of numbers that tells an answer from a number inside one', () => {
  const lineOf = (text: string, top: number, index: number): PLine => ({ page: 0, index, line: line({ text, left: 0.143, top }), role: 'other' });

  it('stops at the last number the exercises have (plus a little), and jumps further apart only when asked to', () => {
    const lines = ['1. a', '2. b', '3. c', '4. d', '5. e', '6. f', '30. a value', '31. another value'].map((text, at) => lineOf(text, 0.2 + at * 0.03, at));
    const candidates = findCandidates(lines, DEFAULT_ITEM_PATTERNS);
    expect(selectSequence(candidates, lines, {}).chosen.map((candidate) => candidate.label)).toEqual(['1', '2', '3', '4', '5', '6', '30', '31']);
    const limited = selectSequence(candidates, lines, { maxNumber: 9 });
    expect(limited.chosen.map((candidate) => candidate.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(limited.rejected.map((entry) => entry.text.slice(0, 3))).toEqual(['30.', '31.']);
    const wide = ['1. a', '5. b', '9. c', '13. d', '17. e'].map((text, at) => lineOf(text, 0.2 + at * 0.03, at));
    const found = findCandidates(wide, DEFAULT_ITEM_PATTERNS);
    expect(selectSequence(found, wide, { maxJump: 15 }).chosen.map((candidate) => candidate.label)).toEqual(['1', '5', '9', '13', '17']);
    expect(selectSequence(found, wide, {}).chosen.map((candidate) => candidate.label)).toEqual(['1']);
  });
});
