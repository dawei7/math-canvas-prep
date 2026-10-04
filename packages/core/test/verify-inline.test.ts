import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/model/types.js';
import { parseNumeric, compareNumeric } from '../src/verify/labels.js';
import type { VerifyCode, VerifyFinding, VerifyOptions, VerifyReport } from '../src/verify/types.js';
import { verifyProject } from '../src/verify/verify.js';
import { Workbook, around, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * A text book with its exercises inline between the paragraphs of the lesson, numbered N.M.K (the last number counts examples and
 * definitions too), and the solutions of the chapter at its end, each headed "Lösung N.M.K". Everything here is invented.
 */

const KEYWORD_FIRST = [/^L(?:ö|oe)sung\s+(\d+(?:\.\d+)*)/u];

async function check(book: Workbook, options?: VerifyOptions): Promise<VerifyReport> {
  return verifyProject(book.project(), await pagesOf(book.pdf()), options);
}
const all = (report: VerifyReport, code: VerifyCode): VerifyFinding[] => report.findings.filter((finding) => finding.code === code);
const refs = (report: VerifyReport, code: VerifyCode): string[] => all(report, code).map((finding) => finding.ref);
const loud = (report: VerifyReport): VerifyFinding[] => report.findings.filter((finding) => finding.severity !== 'info');

/** A paragraph of `lines` full lines of prose, the first at baseline `y`. */
function prose(book: Workbook, page: number, y: number, lines: number, tag: string): void {
  for (let k = 0; k < lines; k += 1) book.text(page, 72, y + 15 * k, `${tag} line ${k + 1} of the lesson, set in a full line that runs up to the right margin of the text.`);
}

/** Exercises 1.1.2 and 1.1.5 on page 0, 1.1.8 to 1.1.11 on page 1, their solutions on page 2: each solution headed "Lösung" and its label. */
function inline(): { book: Workbook; frames: Frame[] } {
  const book = new Workbook(3);
  book.outline = sectionEntries([{ id: '1.1', page: 0, top: 0.02, label: '1.1', title: 'Matrices' }]);
  const frames: Frame[] = [];
  const add = (label: string, page: number, y: number): void => {
    frames.push(book.exercise('1.1', label, page, 72, y, { marker: label, words: 'Aufgabe: add the numbers and write the sum down.', width: 330 }));
  };
  prose(book, 0, 100, 6, 'First');
  add('1.1.2', 0, 215);
  prose(book, 0, 260, 6, 'Second');
  add('1.1.5', 0, 380);
  prose(book, 0, 420, 6, 'Third');
  prose(book, 1, 100, 2, 'Fourth');
  add('1.1.8', 1, 140);
  prose(book, 1, 180, 5, 'Fifth');
  add('1.1.9', 1, 280);
  prose(book, 1, 320, 5, 'Sixth');
  add('1.1.10', 1, 420);
  prose(book, 1, 460, 5, 'Seventh');
  add('1.1.11', 1, 560);
  prose(book, 1, 600, 5, 'Eighth');
  frames.forEach((frame, index) => {
    const y = 100 + 45 * index;
    book.text(2, 72, y, `Lösung ${frame.label as string} The sum is ${index + 3}.`);
    frame.solution = [around(2, 72, y, { width: 330 })];
  });
  return { book, frames };
}

describe('dotted labels: numbers compared number by number', () => {
  it('reads 1.3.10 as 1, 3 and 10 and puts it after 1.3.8', () => {
    expect(parseNumeric('1.3.10')).toEqual({ n: 1, suffix: '', parts: [1, 3, 10], dotted: true });
    expect(parseNumeric('5a')).toEqual({ n: 5, suffix: 'a', parts: [5], dotted: false });
    expect(parseNumeric('A.3')).toBeUndefined();
    const sorted = ['1.3.10', '1.3.8', '1.2.30', '1.3', '1.3.8a'].map((label) => ({ label, ...(parseNumeric(label) as NonNullable<ReturnType<typeof parseNumeric>>) })).sort(compareNumeric);
    expect(sorted.map((entry) => entry.label)).toEqual(['1.2.30', '1.3', '1.3.8', '1.3.8a', '1.3.10']);
  });

  it('does not report an order, a gap or a stray number for labels that run 2, 5, 8, 9, 10, 11 and names the first and last as numbers', async () => {
    const { book } = inline();
    const report = await check(book, { itemPatterns: KEYWORD_FIRST });
    expect(loud(report)).toEqual([]);
    expect(report.sections).toEqual([{ id: '1.1', label: '1.1', exercises: 6, firstLabel: '1.1.2', lastLabel: '1.1.11', withSolution: 6, gaps: [], duplicates: [] }]);
    expect(report.findings.map((finding) => finding.code)).toEqual(['inline-section']);
  });

  it('still reports an order that does not hold, and a label printed twice', async () => {
    const swapped = inline();
    const [nine, ten] = [swapped.frames[3] as Frame, swapped.frames[4] as Frame];
    [nine.label, ten.label] = [ten.label, nine.label];
    expect(refs(await check(swapped.book, { itemPatterns: KEYWORD_FIRST }), 'order').length).toBeGreaterThanOrEqual(1);
    const twice = inline();
    (twice.frames[4] as Frame).label = '1.1.9';
    expect(refs(await check(twice.book, { itemPatterns: KEYWORD_FIRST }), 'duplicate')).toEqual(['1.1:1.1.9']);
  });

  it('does not take the last number of a dotted label for a plain number: no gap, no outlier, no note about labels', async () => {
    const { book, frames } = inline();
    (frames[5] as Frame).label = '1.1.250';
    const report = await check(book, { itemPatterns: KEYWORD_FIRST });
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).not.toContain('gap');
    expect(codes).not.toContain('label-outlier');
    expect(codes).not.toContain('non-numeric-label');
  });
});

describe('solutions headed by a keyword and the label ("Lösung 1.1.2")', () => {
  it('are found with the item pattern, which applies to the solution regions as to the exercises', async () => {
    const { book } = inline();
    expect(all(await check(book, { itemPatterns: KEYWORD_FIRST }), 'solution-label-missing')).toEqual([]);
  });

  it('are not found without it: each region is then one that does not start with its number', async () => {
    const { book } = inline();
    const report = await check(book);
    expect(refs(report, 'solution-label-missing')).toHaveLength(6);
    expect(all(report, 'solution-label-missing')[0]?.evidence).toBe('Lösung 1.1.2 The sum is 3.');
  });
});

describe('an inline section: the text between the exercises is the lesson, not text left behind', () => {
  it('says so once, as information, and checks no zone', async () => {
    const { book } = inline();
    const report = await check(book, { itemPatterns: KEYWORD_FIRST });
    const info = all(report, 'inline-section');
    expect(info).toMatchObject([{ severity: 'info', ref: '1.1', page: 0 }]);
    expect(info[0]?.message).toContain('not together in a block');
    for (const code of ['text-left-behind', 'numbered-text-left-behind'] as const) expect(all(report, code), code).toEqual([]);
  });

  it('is judged by what is between the exercises: a practice set of the same exercises is checked as one', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Matrices' }]);
    for (let n = 1; n <= 8; n += 1) book.exercise('a', String(n), 0, 72, 80 + 30 * n);
    book.text(0, 72, 500, 'A line that belongs to no exercise.');
    const report = await check(book);
    expect(all(report, 'inline-section')).toEqual([]);
    expect(all(report, 'text-left-behind')).toHaveLength(1);
  });

  it('does not take fewer than three exercises for a block, and says nothing about them', async () => {
    const { book } = inline();
    book.frames.splice(2);
    const report = await check(book, { itemPatterns: KEYWORD_FIRST });
    expect(all(report, 'inline-section')).toEqual([]);
    expect(all(report, 'text-left-behind')).toEqual([]);
  });
});

describe('region-open-end: an exercise region must end where its own text ends', () => {
  /** An exercise of three full lines at the end of page 1 with its region, and what follows it. */
  function long(options: { cut?: boolean; follow: 'gap' | 'direct' | 'short-direct' }): { book: Workbook; frames: Frame[] } {
    const { book, frames } = inline();
    const lines = ['An exercise of three lines, the first of which carries the label and runs up to the right margin,', 'the second of which is a full line as well and goes on right up to the margin of the text block,', options.follow === 'short-direct' ? 'the last one, a short line.' : 'and the third one is a full line too that ends where the right margin of the text block is.'];
    lines.forEach((line, index) => book.text(1, 72, 680 + 15 * index, index === 0 ? `1.1.12 ${line}` : line));
    const frame: Frame = { id: 'long', kind: 'exercise', page: 1, rect: around(1, 72, 680, { lines: options.cut === true ? 2 : 3, leading: 15, width: 470 }).rect, authority: 'book', label: '1.1.12', section: '1.1' };
    frames.push(frame);
    book.frames.push(frame);
    const y = options.follow === 'gap' ? 740 : 725;
    book.text(1, 72, y, 'And now the lesson goes on with the next paragraph, which has nothing to do with the exercise.');
    return { book, frames };
  }

  it('is quiet when the text ends in a gap, and when a short last line ends the paragraph', async () => {
    expect(all(await check(long({ follow: 'gap' }).book, { itemPatterns: KEYWORD_FIRST }), 'region-open-end')).toEqual([]);
    expect(all(await check(long({ follow: 'short-direct' }).book, { itemPatterns: KEYWORD_FIRST }), 'region-open-end')).toEqual([]);
  });

  it('warns when the text goes on directly below the region: a line of the exercise that the region leaves out', async () => {
    const report = await check(long({ cut: true, follow: 'gap' }).book, { itemPatterns: KEYWORD_FIRST });
    const found = all(report, 'region-open-end');
    expect(found).toMatchObject([{ severity: 'warning', ref: '1.1:1.1.12', page: 1 }]);
    expect(found[0]?.evidence).toContain('and the third one is a full line');
  });

  it('warns for a last line that reaches the margin and is followed at once by a paragraph', async () => {
    expect(refs(await check(long({ follow: 'direct' }).book, { itemPatterns: KEYWORD_FIRST }), 'region-open-end')).toEqual(['1.1:1.1.12']);
  });

  it('is quiet when what follows is the next exercise or a numbered item', async () => {
    const { book } = inline();
    expect(all(await check(book, { itemPatterns: KEYWORD_FIRST }), 'region-open-end')).toEqual([]);
  });
});

describe('region-holds-item: no region holds the line that starts another exercise', () => {
  it('reports a region that reaches down into the next exercise of its section', async () => {
    const { book, frames } = inline();
    const nine = frames[3] as Frame;
    nine.rect = { ...nine.rect, bottom: (frames[4] as Frame).rect.bottom - 0.002 };
    const report = await check(book, { itemPatterns: KEYWORD_FIRST });
    expect(all(report, 'region-holds-item')).toMatchObject([{ severity: 'error', ref: '1.1:1.1.9', page: 1 }]);
    expect(all(report, 'region-holds-item')[0]?.evidence).toContain('1.1.10');
  });

  it('is quiet when every region holds only its own exercise', async () => {
    const { book } = inline();
    expect(all(await check(book, { itemPatterns: KEYWORD_FIRST }), 'region-holds-item')).toEqual([]);
  });
});

describe('spans in an inline book: continuations and solutions of several regions stay quiet', () => {
  it('has no finding for an exercise on two pages and for an answer of two regions', async () => {
    const book = new Workbook(4);
    book.outline = sectionEntries([{ id: '2.1', page: 0, top: 0.02, label: '2.1', title: 'Spaces' }]);
    const frames: Frame[] = [];
    prose(book, 0, 100, 6, 'First');
    frames.push(book.exercise('2.1', '2.1.1', 0, 72, 220, { marker: '2.1.1', words: 'Aufgabe: short.', width: 330 }));
    prose(book, 0, 260, 22, 'Second');
    // An exercise of two lines at the bottom of page 0 that goes on for two lines at the top of page 1.
    book.text(0, 72, 700, '2.1.2 Aufgabe: a long exercise that starts at the bottom of the page and goes on,');
    book.text(0, 72, 715, 'with a second line, which ends in the middle,');
    book.text(1, 72, 100, 'it continues at the top of the next page,');
    book.text(1, 72, 115, 'and ends here.');
    const span: Frame = { id: 'span', kind: 'exercise', page: 0, rect: around(0, 72, 700, { lines: 2, width: 470 }).rect, authority: 'book', label: '2.1.2', section: '2.1', continues: [around(1, 72, 100, { lines: 2, width: 470 })] };
    frames.push(span);
    book.frames.push(span);
    prose(book, 1, 160, 8, 'Third');
    frames.push(book.exercise('2.1', '2.1.3', 1, 72, 330, { marker: '2.1.3', words: 'Aufgabe: short again.', width: 330 }));
    prose(book, 1, 370, 8, 'Fourth');
    // Their answers at the end: one of two regions, the second at the top of the next page.
    book.text(2, 72, 600, 'Lösung 2.1.1 The first answer.');
    book.text(2, 72, 700, 'Lösung 2.1.2 The second answer begins at the bottom of the page');
    book.text(3, 72, 100, 'and ends at the top of the next page.');
    book.text(3, 72, 140, 'Lösung 2.1.3 The third answer.');
    (frames[0] as Frame).solution = [around(2, 72, 600, { width: 330 })];
    (span as Frame).solution = [around(2, 72, 700, { width: 470 }), around(3, 72, 100, { width: 470 })];
    (frames[2] as Frame).solution = [around(3, 72, 140, { width: 330 })];
    const report = await check(book, { itemPatterns: KEYWORD_FIRST });
    expect(loud(report)).toEqual([]);
  });
});
