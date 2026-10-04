import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { BOOK_SUMMARY_FORMAT, bookExercisesInOrder, buildBookSummary, type BookSummary } from '../src/book/summary.js';
import type { Frame, OutlineEntry } from '../src/model/types.js';
import { buildAuthoritySample } from '../src/testing/authority-sample.js';
import { bookFrame, bookOutline, ordinary } from './book-helpers.js';
import { frame, rect } from './helpers.js';

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => { compile(schema: object): Validator } };
let valid: Validator;
beforeAll(() => {
  const schema = JSON.parse(readFileSync(new URL('../../../schemas/book-summary.schema.json', import.meta.url), 'utf8')) as object;
  valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
});

const sample = buildAuthoritySample();
const sampleFrames: Frame[] = sample.exercises.map((entry, index) => ({
  id: `f${index + 1}`,
  kind: 'exercise',
  page: entry.page,
  rect: entry.rect,
  authority: 'book',
  label: entry.label,
  section: entry.section,
  ...(entry.continues ? { continues: entry.continues } : {}),
  ...(index % 3 === 0 ? {} : { solution: entry.solution }),
}));

const summaryOf = (frames: readonly Frame[], outline: readonly OutlineEntry[] | undefined, extra: { exercises?: boolean } = {}): BookSummary =>
  buildBookSummary({ title: 'Book', pageCount: 6, frames, outline, ...extra });

describe('the book summary', () => {
  it('counts the exercises of every section and of every subtree, and the totals', () => {
    const summary = summaryOf(sampleFrames, sample.sections);
    expect(summary).toMatchObject({ format: BOOK_SUMMARY_FORMAT, version: 1, generator: { name: 'math-canvas-prep' } });
    expect(summary.sections.map((section) => `${section.id}:${section.exercises}/${section.exercisesTotal}:${section.withSolution}/${section.withSolutionTotal}`)).toEqual([
      'c1:0/8:0/5',
      '1.1:4/4:2/2',
      '1.2:4/4:3/3',
      'c2:0/2:0/1',
      '2.1:2/2:1/1',
      'answers:0/0:0/0',
    ]);
    expect(summary.totals).toEqual({ sections: 6, sectionsWithId: 6, exercises: 10, withSolution: 6, withoutSolution: 4, unfiled: 0, ordinary: { exercises: 0, questions: 0, bookmarks: 0 } });
  });

  it('describes each entry: position, parent, label and first and last exercise label', () => {
    const [c1, s11, , c2] = summaryOf(sampleFrames, sample.sections).sections;
    expect(c1).toMatchObject({ index: 0, id: 'c1', label: 'Chapter 1', title: 'Chapter 1 Integers', page: 0, depth: 0, parent: null });
    expect(c1).not.toHaveProperty('firstLabel');
    expect(s11).toMatchObject({ index: 1, id: '1.1', label: '1.1', page: 0, depth: 1, parent: 0, firstLabel: '1', lastLabel: '3b' });
    expect(typeof s11?.top).toBe('number');
    expect(c2).toMatchObject({ index: 3, parent: null });
  });

  it('lists the own exercises of each section when asked, in reading order', () => {
    const summary = summaryOf([...sampleFrames].reverse(), sample.sections, { exercises: true });
    expect(summary.sections[1]?.items).toEqual([
      { id: 'f1', label: '1', page: 0, solutionRegions: 0 },
      { id: 'f2', label: '2', page: 0, solutionRegions: 1 },
      { id: 'f3', label: '3a', page: 0, solutionRegions: 1 },
      { id: 'f4', label: '3b', page: 0, solutionRegions: 0 },
    ]);
    expect(summary.sections[0]?.items).toEqual([]);
    expect(summaryOf(sampleFrames, sample.sections).sections[1]).not.toHaveProperty('items');
  });

  it('counts the exercises you framed for yourself apart, and exercises under unknown sections as unfiled', () => {
    const frames: Frame[] = [bookFrame('b1', '1.1', '1', 0, 0.35, 0.4), bookFrame('b2', 'ghost', '1', 0, 0.5, 0.55), ordinary('e1', 1, 0.1, 0.2), ordinary('p1', 1, 0.3, 0.4, { unit: 'u' }), ordinary('p2', 1, 0.4, 0.5, { unit: 'u' }), frame('q1', 'question', 2, rect(0.1, 0.1, 0.9, 0.2)), frame('k1', 'bookmark', 2, rect(0.1, 0.3, 0.9, 0.4))];
    const summary = summaryOf(frames, bookOutline());
    expect(summary.totals).toMatchObject({ exercises: 2, withSolution: 0, withoutSolution: 2, unfiled: 1, ordinary: { exercises: 2, questions: 1, bookmarks: 1 } });
    expect(summary.sections.map((section) => section.exercisesTotal)).toEqual([1, 1, 0, 0, 0]);
  });

  it('is empty but valid for a project without an outline or without exercises', () => {
    const none = summaryOf([], undefined);
    expect(none.sections).toEqual([]);
    expect(none.totals).toMatchObject({ sections: 0, exercises: 0 });
    expect(valid(none), JSON.stringify(valid.errors)).toBe(true);
    const unfiled = summaryOf([bookFrame('b1', '1.1', '1', 0, 0.35, 0.4)], undefined);
    expect(unfiled.totals).toMatchObject({ sections: 0, exercises: 1, unfiled: 1 });
  });

  it('carries the document information, the folder and the PDF it was made for', () => {
    const summary = buildBookSummary({
      title: 'Pre-Algebra',
      folder: 'Books/Algebra',
      info: { author: 'A. Author', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, sourceUrl: 'https://example.org/b', notice: 'N' },
      pageCount: 6,
      sha256: 'a'.repeat(64),
      bytes: 1234,
      frames: [],
      outline: bookOutline(),
    });
    expect(Object.keys(summary.document)).toEqual(['title', 'pageCount', 'folder', 'author', 'license', 'sourceUrl', 'notice', 'sha256', 'bytes']);
    expect(summary.document).toMatchObject({ title: 'Pre-Algebra', folder: 'Books/Algebra', pageCount: 6, bytes: 1234 });
    expect(valid(summary), JSON.stringify(valid.errors)).toBe(true);
  });

  it('is valid against its schema, with and without the exercise lists', () => {
    for (const withItems of [false, true]) {
      const summary = summaryOf(sampleFrames, sample.sections, { exercises: withItems });
      expect(valid(JSON.parse(JSON.stringify(summary))), JSON.stringify(valid.errors)).toBe(true);
    }
    expect(valid({ ...summaryOf([], undefined), version: 2 })).toBe(false);
    expect(valid({ ...summaryOf([], undefined), extra: 1 })).toBe(false);
  });

  it('keeps an id that two entries share for the first entry only', () => {
    const outline: OutlineEntry[] = [{ title: 'A', page: 0, depth: 0, id: 'x' }, { title: 'B', page: 3, depth: 0, id: 'x' }];
    const summary = summaryOf([bookFrame('b1', 'x', '1', 0, 0.2, 0.3)], outline, { exercises: true });
    expect(summary.sections.map((section) => section.exercises)).toEqual([1, 0]);
    expect(summary.sections[1]?.items).toEqual([]);
  });
});

describe('the exercises in the order of the book', () => {
  it('goes by section (in the order of the outline) and then by position', () => {
    const frames: Frame[] = [
      bookFrame('c', '1.2', '1', 1, 0.2, 0.3),
      bookFrame('a', '1.1', '2', 0, 0.5, 0.6),
      bookFrame('b', '1.1', '1', 0, 0.35, 0.4),
      bookFrame('z', 'ghost', '1', 0, 0.1, 0.2),
      bookFrame('d', '2.1', '1', 4, 0.2, 0.3),
      ordinary('o', 0, 0.7, 0.8),
    ];
    expect(bookExercisesInOrder(frames, bookOutline()).map((entry) => entry.id)).toEqual(['b', 'a', 'c', 'd', 'z']);
    expect(bookExercisesInOrder(frames, undefined).map((entry) => entry.id)).toEqual(['z', 'b', 'a', 'c', 'd']);
  });
});
