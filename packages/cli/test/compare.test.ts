import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditedBook } from './audited.js';
import type { Result } from './helpers.js';

interface Section {
  label: string;
  status: string;
  count: number | null;
  referenceCount: number | null;
  difference: number | null;
  firstPage: number | null;
  firstLabel: string | null;
  lastLabel: string | null;
  titleDiffers: boolean;
}
interface Report {
  format: string;
  version: number;
  totals: { referenceExercises: number; exercises: number; difference: number };
  sections: Section[];
  chapters: { label: string; sections: number; referenceExercises: number; exercises: number; equal: number }[];
  differences: { kind: string; label: string; message: string }[];
}
const reportOf = (done: Result): Report => done.json.result as unknown as Report;

/** The reference of the synthetic workbook: the sections as the book prints them, with the counts of the audit unless changed. */
const SECTIONS = [
  { label: '0.1', title: 'Whole Numbers', exercise_count: 70 },
  { label: '0.2', title: 'Word Problems', exercise_count: 14 },
  { label: '1.1', title: 'Points and Lines', exercise_count: 12 },
  { label: '1.2', title: 'Triangles and Ratios', exercise_count: 16 },
];

describe('book compare', () => {
  it('has no difference when the reference is what the audit holds, and says so with exit code 0', async () => {
    const cli = await auditedBook();
    await writeFile(join(cli.dir, 'reference.json'), JSON.stringify({ sections: SECTIONS }));
    const done = await cli(['book', 'compare', 'reference.json']);
    expect(done.code).toBe(0);
    const report = reportOf(done);
    expect(report).toMatchObject({ format: 'math-canvas-compare', version: 1, totals: { referenceExercises: 112, exercises: 112, difference: 0 }, differences: [] });
    expect(report.sections.map((section) => section.status)).toEqual(['equal', 'equal', 'equal', 'equal']);
    expect(report.sections[0]).toMatchObject({ label: '0.1', count: 70, referenceCount: 70, difference: 0, firstLabel: '1', lastLabel: '70', firstPage: 5, titleDiffers: false });
    const text = await cli(['book', 'compare', 'reference.json'], { json: false });
    expect(text.stdout).toContain('No difference');
  });

  it('lists a count that differs, a section on one side only and a title, and exits with code 4', async () => {
    const cli = await auditedBook();
    const sections = [{ ...(SECTIONS[0] as object), exercise_count: 72 }, { ...(SECTIONS[1] as object), title: 'Word Puzzles' }, SECTIONS[2], { label: '2.1', title: 'Circles', exercise_count: 9 }];
    await writeFile(join(cli.dir, 'reference.json'), JSON.stringify({ sections }));
    const done = await cli(['book', 'compare', 'reference.json', '--details', 'compare.json']);
    expect(done.code).toBe(4);
    const report = reportOf(done);
    expect(report.differences.map((entry) => `${entry.kind} ${entry.label}`)).toEqual(['count 0.1', 'title 0.2', 'missing 2.1', 'extra 1.2']);
    expect(report.sections.find((section) => section.label === '0.1')).toMatchObject({ status: 'count', difference: -2 });
    expect(report.sections.find((section) => section.label === '2.1')).toMatchObject({ status: 'missing', count: null, referenceCount: 9 });
    expect(report.sections.find((section) => section.label === '1.2')).toMatchObject({ status: 'extra', referenceCount: null, count: 16 });
    expect(report.totals).toEqual({ referenceExercises: 72 + 14 + 12 + 9, exercises: 112, difference: 112 - 107 });
    const written = JSON.parse(await readFile(join(cli.dir, 'compare.json'), 'utf8')) as Report;
    expect(written.differences).toHaveLength(4);
    const text = await cli(['book', 'compare', 'reference.json'], { json: false });
    expect(text.stdout).toContain('4 differences to look at');
    expect(text.code).toBe(4);
  });

  it('reads the form with chapters, and adds the chapter offset to their numbers', async () => {
    const cli = await auditedBook();
    const chapters = [
      { number: 1, title: 'Number Sense', sections: [{ number: 1, title: 'Whole Numbers', exercise_count: 70 }, { number: 2, title: 'Word Problems', exercise_count: 14 }] },
      { number: 2, title: 'Graphs', sections: [{ number: 1, title: 'Points and Lines', exercise_count: 12 }, { number: 2, title: 'Triangles and Ratios', exercise_count: 15 }] },
    ];
    await writeFile(join(cli.dir, 'chapters.json'), JSON.stringify({ chapters }));
    const shifted = await cli(['book', 'compare', 'chapters.json', '--chapter-offset', '-1']);
    expect(shifted.code).toBe(4);
    const report = reportOf(shifted);
    expect(report.differences.map((entry) => `${entry.kind} ${entry.label}`)).toEqual(['count 1.2']);
    expect(report.chapters).toMatchObject([
      { label: '0', sections: 2, referenceExercises: 84, exercises: 84, equal: 2 },
      { label: '1', sections: 2, referenceExercises: 27, exercises: 28, equal: 1 },
    ]);
    // Without the offset the labels are 1.1, 1.2, 2.1 and 2.2: the audit has 0.1 and 0.2 as extras and no 2.x.
    const plain = reportOf(await cli(['book', 'compare', 'chapters.json']));
    expect(plain.differences.map((entry) => entry.kind)).toContain('missing');
    expect(plain.differences.map((entry) => entry.kind)).toContain('extra');
  });

  it('says what is wrong with a reference it cannot read', async () => {
    const cli = await auditedBook();
    await writeFile(join(cli.dir, 'bad.json'), JSON.stringify({ lists: [] }));
    const wrong = await cli(['book', 'compare', 'bad.json']);
    expect(wrong.code).toBe(2);
    expect(wrong.json.error?.hint).toContain('exercise_count');
    await writeFile(join(cli.dir, 'broken.json'), '{ not json');
    expect((await cli(['book', 'compare', 'broken.json'])).code).toBe(3);
    expect((await cli(['book', 'compare', 'missing.json'])).code).toBe(3);
    expect((await cli(['book', 'compare'])).code).toBe(2);
  });
});
