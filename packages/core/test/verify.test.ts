import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Frame, PageText, Rect } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { buildAuthoritySample } from '../src/testing/authority-sample.js';
import { VERIFY_CODES, VERIFY_FORMAT, VERIFY_VERSION, type VerifyCode, type VerifyFinding, type VerifyReport } from '../src/verify/types.js';
import { pagesToVerify, verifyProject, type PageSource } from '../src/verify/verify.js';
import { rejected } from './helpers.js';
import { COVERAGE_CODES, Workbook, around, pagesOf, sectionEntries } from './verify-helpers.js';

// ---------------------------------------------------------------------------------------------------------------------
// The synthetic workbook of the authority tests: a clean book

const sample = buildAuthoritySample();

function sampleProject(change: (frames: Frame[]) => Frame[] = (frames) => frames): Project {
  const frames: Frame[] = sample.exercises.map((entry, index) => ({
    id: `f${index + 1}`,
    kind: 'exercise',
    page: entry.page,
    rect: entry.rect,
    authority: 'book',
    label: entry.label,
    section: entry.section,
    ...(entry.context ? { context: entry.context } : {}),
    ...(entry.continues ? { continues: entry.continues } : {}),
    solution: entry.solution,
  }));
  return { ...newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: sample.pageCount }, title: sample.title }), outline: { source: 'manual', entries: sample.sections }, frames: change(frames) };
}

let samplePages: PageSource | undefined;
async function pagesOfSample(): Promise<PageSource> {
  samplePages ??= await pagesOf(sample.pdf);
  return samplePages;
}

const codes = (report: VerifyReport): string[] => report.findings.map((finding) => finding.code);
const find = (report: VerifyReport, code: VerifyCode, ref?: string): VerifyFinding | undefined => report.findings.find((finding) => finding.code === code && (ref === undefined || finding.ref === ref));

describe('the check of a clean book', () => {
  it('finds nothing wrong in the synthetic workbook except what it prints: two labels that are not plain numbers', async () => {
    const report = verifyProject(sampleProject(), await pagesOfSample());
    expect(report.format).toBe(VERIFY_FORMAT);
    expect(report.version).toBe(VERIFY_VERSION);
    expect(report.summary).toEqual({ exercises: 10, authoritative: 10, sections: 3, solutions: 10, errors: 0, warnings: 0, infos: 1 });
    expect(report.findings).toEqual([
      { code: 'non-numeric-label', severity: 'info', ref: '1.1', page: 0, message: expect.stringContaining('2 labels of section 1.1') as string, evidence: '3a, 3b' },
    ]);
    expect(report.sections).toEqual([
      { id: '1.1', label: '1.1', exercises: 4, firstLabel: '1', lastLabel: '3b', withSolution: 4, gaps: [], duplicates: [] },
      { id: '1.2', label: '1.2', exercises: 4, firstLabel: '1', lastLabel: '4', withSolution: 4, gaps: [], duplicates: [] },
      { id: '2.1', label: '2.1', exercises: 2, firstLabel: '1', lastLabel: '2', withSolution: 2, gaps: [], duplicates: [] },
    ]);
  });

  it('reads the pages it needs, the exercises and the answer key, and the two pages beside each of them (they tell a running head from text)', () => {
    expect(pagesToVerify(sampleProject())).toEqual([0, 1, 2, 3]);
    // The pages of section 2.1 are 2 and 3; 0 and 1 stand beside them, the pages after them do not exist.
    expect(pagesToVerify(sampleProject(), { sections: ['2.1'] })).toEqual([0, 1, 2, 3]);
  });

  it('only looks at the sections it is asked for, and says when a section does not exist', async () => {
    const report = verifyProject(sampleProject(), await pagesOfSample(), { sections: ['1.2', '2.1'] });
    expect(report.summary).toMatchObject({ exercises: 6, authoritative: 6, sections: 2 });
    expect(report.sections.map((section) => section.id)).toEqual(['1.2', '2.1']);
    const wrong = await rejected(Promise.resolve().then(() => verifyProject(sampleProject(), () => undefined, { sections: ['9.9'] })));
    expect(wrong.code).toBe('E_USAGE');
    expect(wrong.message).toContain('9.9');
    expect(wrong.hint).toContain('1.1');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A small book of one section: six exercises on page 0, their answers on page 1

interface Small {
  book: Workbook;
  frames: Frame[];
}

/** Six exercises 1 to 6 in one column of page 0 (y = 100, 140, ... 300) and their answers on page 1. */
function small(): Small {
  const book = new Workbook(3);
  book.outline = sectionEntries([
    { id: 'a', page: 0, top: 0.02 },
    { id: 'key', page: 1, top: 0.02 },
  ]);
  const frames: Frame[] = [];
  for (let n = 1; n <= 6; n += 1) {
    const frame = book.exercise('a', String(n), 0, 72, 100 + 40 * (n - 1));
    book.answer(frame, 1, 72, 100 + 25 * (n - 1), `${n}. ${n * 11}`);
    frames.push(frame);
  }
  return { book, frames };
}

async function check(book: Workbook, options?: Parameters<typeof verifyProject>[2]): Promise<VerifyReport> {
  return verifyProject(book.project(), await pagesOf(book.pdf()), options);
}

describe('label-not-first and no-text: the region of an exercise', () => {
  it('is clean when every region starts with its number', async () => {
    const { book } = small();
    const report = await check(book);
    expect(report.findings).toEqual([]);
    expect(report.summary).toMatchObject({ exercises: 6, authoritative: 6, solutions: 6, errors: 0, warnings: 0, infos: 0 });
  });

  it('reports a region that starts above its number, with the first 40 characters it holds', async () => {
    const { book, frames } = small();
    // Exercise 3 reaches up into the line of exercise 2.
    (frames[2] as Frame).rect = { ...(frames[2] as Frame).rect, top: (frames[1] as Frame).rect.top + 0.005 };
    const report = await check(book);
    const found = find(report, 'label-not-first', 'a:3');
    expect(found).toMatchObject({ severity: 'error', page: 0, evidence: '2. Evaluate the expression. 3. Evaluate ' });
    expect(found?.evidence.length).toBe(40);
    expect(found?.message).toContain('a:3');
  });

  it('reports a number that is not the label, and a region that starts with another exercise', async () => {
    const { book, frames } = small();
    (frames[4] as Frame).label = '9';
    const report = await check(book);
    expect(find(report, 'label-not-first', 'a:9')?.evidence).toBe('5. Evaluate the expression.');
  });

  it('accepts what a book prints around a number: parentheses, a closing mark or none, a label glued to the text', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    book.exercise('s', '1', 0, 72, 100, { marker: '(1)' });
    book.exercise('s', '2', 0, 72, 140, { marker: '2)' });
    book.exercise('s', '3', 0, 72, 180, { marker: '3' });
    book.exercise('s', '4', 0, 72, 220, { marker: '4.Glued' });
    book.exercise('s', '5', 0, 72, 260, { marker: '(5.)' });
    book.exercise('s', '6', 0, 72, 300, { marker: '#6.' });
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'label-not-first').map((finding) => finding.ref)).toEqual(['s:6']);
  });

  it('does not take the start of a decimal for a label', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    book.exercise('s', '1', 0, 72, 100, { marker: '1.5', words: 'is the number to round.' });
    const report = await check(book);
    expect(find(report, 'label-not-first', 's:1')?.evidence).toBe('1.5 is the number to round.');
  });

  it('knows the parts of a printed exercise: 3a starts from (a) or a), not from 3', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    book.exercise('s', '3a', 0, 72, 100, { marker: '(a)' });
    book.exercise('s', '3b', 0, 72, 140, { marker: 'b)' });
    book.exercise('s', '3c', 0, 72, 180, { marker: '3c)' });
    book.exercise('s', '3d', 0, 72, 220, { marker: 'e)' });
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'label-not-first').map((finding) => finding.ref)).toEqual(['s:3d']);
  });

  it('looks at the left margin of the region, not at the highest text: a numerator, an exponent or a figure label above the number', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    const fraction = book.exercise('s', '9', 0, 72, 112, { words: '= x + 1' });
    // The numerator and an exponent stand above the number and to the right of it.
    book.text(0, 130, 98, '2x + 3', 9);
    book.text(0, 190, 94, '2', 7);
    fraction.rect = { ...fraction.rect, top: 0.095 };
    const figure = book.exercise('s', '10', 0, 72, 230, { words: '' });
    book.text(0, 150, 200, 'A', 10);
    book.text(0, 220, 208, 'B', 10);
    figure.rect = { ...figure.rect, top: 0.22 };
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'label-not-first')).toEqual([]);
  });

  it('reports a region whose left edge cuts through the number, which a line-wise reader would still include', async () => {
    const { book, frames } = small();
    (frames[1] as Frame).rect = { ...(frames[1] as Frame).rect, left: (frames[1] as Frame).rect.left + 0.02 };
    const report = await check(book);
    const found = find(report, 'label-not-first', 'a:2');
    expect(found?.message).toContain('cuts through its number 2');
    expect(found?.evidence).toBe('2. Evaluate the expression.');
    expect(report.findings.filter((finding) => finding.code === 'label-not-first')).toHaveLength(1);
  });

  it('cannot cut a line that the text layer joined across two columns: it holds the label when the label starts one of its items', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    // One text run for both exercises of a row.
    book.text(0, 72, 100, `1. Solve the first equation${' '.repeat(40)}2. Solve the second equation`);
    const left = { id: 'f1', kind: 'exercise', page: 0, authority: 'book', label: '1', section: 's', rect: around(0, 72, 100, { width: 200 }).rect } as const;
    const right = { id: 'f2', kind: 'exercise', page: 0, authority: 'book', label: '2', section: 's', rect: { left: 0.52, top: left.rect.top, right: 0.95, bottom: left.rect.bottom } } as const;
    const wrong = { id: 'f3', kind: 'exercise', page: 0, authority: 'book', label: '7', section: 's', rect: right.rect } as const;
    book.frames.push({ ...left }, { ...right }, { ...wrong });
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'no-text')).toEqual([]);
    expect(report.findings.filter((finding) => finding.code === 'label-not-first').map((finding) => finding.ref)).toEqual(['s:7']);
  });

  it('trusts the pieces of a joined line over the line: a region on the wrong column does not hold its label through the whole line', () => {
    const left = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.22 };
    const right = { left: 0.55, top: 0.2, right: 0.75, bottom: 0.22 };
    const page: PageText = {
      page: 0,
      size: { width: 595, height: 842, rotation: 0 },
      columns: 2,
      hasText: true,
      lines: [{ text: '1) first   2) second', rect: { left: 0.1, top: 0.2, right: 0.75, bottom: 0.22 }, fontSize: 11, column: 0, chars: 18, parts: [{ text: '1) first', chars: 7, rect: left }, { text: '2) second', chars: 8, rect: right }] }],
    };
    const make = (secondOn: Rect): Project => ({
      ...newProject({ pdf: { path: 'x.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: 1 }, title: 'T' }),
      outline: { source: 'manual', entries: sectionEntries([{ id: 's', page: 0 }]) },
      frames: [
        { id: 'a', kind: 'exercise', page: 0, rect: { left: 0.09, top: 0.19, right: 0.35, bottom: 0.23 }, authority: 'book', label: '1', section: 's' },
        { id: 'b', kind: 'exercise', page: 0, rect: secondOn, authority: 'book', label: '2', section: 's' },
      ],
    });
    const lookup = (number: number): PageText | undefined => (number === 0 ? page : undefined);
    expect(verifyProject(make({ left: 0.5, top: 0.19, right: 0.8, bottom: 0.23 }), lookup).findings.filter((finding) => finding.code === 'label-not-first')).toEqual([]);
    const wrong = verifyProject(make({ left: 0.09, top: 0.19, right: 0.35, bottom: 0.23 }), lookup).findings.filter((finding) => finding.code === 'label-not-first');
    expect(wrong.map((finding) => finding.ref)).toEqual(['s:2']);
    expect(wrong[0]?.evidence).toBe('1) first');
  });

  it('leaves a running header out of what it reads: validate reports a header inside a region', async () => {
    const book = new Workbook(3);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    for (let page = 0; page < 3; page += 1) book.text(page, 72, 40, 'Synthetic Workbook Header', 9);
    const frame = book.exercise('s', '1', 0, 72, 100);
    frame.rect = { ...frame.rect, top: 0.03 };
    const report = await check(book);
    expect(codes(report)).not.toContain('label-not-first');
  });

  it('reports a region without text: a blank place, and a scanned page', async () => {
    const { book, frames } = small();
    (frames[0] as Frame).rect = { left: 0.1, top: 0.7, right: 0.9, bottom: 0.76 };
    book.scan[2] = [{ left: 0.1, top: 0.2, right: 0.9, bottom: 0.25 }];
    (frames[1] as Frame).page = 2;
    (frames[1] as Frame).rect = { left: 0.1, top: 0.19, right: 0.9, bottom: 0.26 };
    const report = await check(book);
    expect(find(report, 'no-text', 'a:1')).toMatchObject({ severity: 'warning', page: 0, evidence: 'no text line inside the region' });
    expect(find(report, 'no-text', 'a:2')).toMatchObject({ severity: 'warning', page: 2, evidence: 'the page has no text layer' });
    expect(codes(report)).not.toContain('label-not-first');
  });

  it('reads the pieces of a joined row separately: a region holds the column it frames, not its neighbour', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    // Two exercises side by side at the same height: the text layer may join them into one line.
    const left = book.exercise('s', '1', 0, 72, 100, { words: 'Solve x + 2 = 5.', width: 190 });
    const right = book.exercise('s', '2', 0, 320, 100, { words: 'Solve x - 2 = 5.', width: 190 });
    for (let row = 1; row <= 6; row += 1) {
      book.exercise('s', String(row * 2 + 1), 0, 72, 100 + row * 30, { words: 'Solve x + 3 = 9.', width: 190 });
      book.exercise('s', String(row * 2 + 2), 0, 320, 100 + row * 30, { words: 'Solve x - 3 = 9.', width: 190 });
    }
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(left.rect.right).toBeLessThan(right.rect.left);
  });
});

describe('solution-label-missing and solution-no-text: the region of an answer', () => {
  it('reports an answer region that holds another number', async () => {
    const { book, frames } = small();
    const second = (frames[1] as Frame).solution as Frame['solution'];
    (frames[1] as Frame).solution = (frames[2] as Frame).solution;
    (frames[2] as Frame).solution = second;
    const report = await check(book);
    expect(find(report, 'solution-label-missing', 'a:2')).toMatchObject({ severity: 'error', page: 1, evidence: '3. 33' });
    expect(find(report, 'solution-label-missing', 'a:3')).toMatchObject({ evidence: '2. 22' });
  });

  it('finds the label at the start of an item later in the first row, in a range and in a list', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    const ids = ['1', '3', '5', '6', '9', '10'];
    const frames = ids.map((label, at) => book.exercise('s', label, 0, 72, 100 + 30 * at));
    // One row of a key that flows in columns: the text layer may give "1. 115 3. A = 52 5. 45" as one line.
    book.text(1, 72, 100, '1. 115');
    book.text(1, 200, 100, '3. A = 52');
    book.text(1, 330, 100, '5. 45');
    const row = around(1, 72, 100, { width: 450 });
    frames[0]!.solution = [row];
    frames[1]!.solution = [row];
    frames[2]!.solution = [row];
    // A range and a list in front of one answer.
    book.text(1, 72, 160, '6-7. both true');
    frames[3]!.solution = [around(1, 72, 160)];
    book.text(1, 72, 200, '9, 10, 12. all even');
    frames[4]!.solution = [around(1, 72, 200)];
    frames[5]!.solution = [around(1, 72, 200)];
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'solution-label-missing')).toEqual([]);
    // 7 is covered by "6-7." but not 8; and 4 is not in "1, 3, 5" lists
    frames[3]!.label = '8';
    const wrong = await check(book);
    expect(find(wrong, 'solution-label-missing', 's:8')).toBeDefined();
  });

  it('does not take a value for an item: the 5 of "1. 5" is no answer to exercise 5', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    const frame = book.exercise('s', '5', 0, 72, 100);
    book.answer(frame, 1, 72, 100, '1. 5 cm');
    const report = await check(book);
    expect(find(report, 'solution-label-missing', 's:5')?.evidence).toBe('1. 5 cm');
  });

  it('lets exercises that share one block of answers find their label on any row of it', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    const first = book.exercise('s', '1', 0, 72, 100);
    const second = book.exercise('s', '2', 0, 72, 140);
    const third = book.exercise('s', '3', 0, 72, 180);
    book.text(1, 72, 100, '1. 10');
    book.text(1, 72, 118, '2. 20');
    const block = around(1, 72, 100, { lines: 2, leading: 18 });
    first.solution = [block];
    second.solution = [block];
    book.text(1, 72, 300, '3. 30');
    third.solution = [around(1, 72, 300)];
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'solution-label-missing')).toEqual([]);
    // A region that only one exercise has must start with its label: the block, held by 2 alone, starts with 1.
    second.solution = [around(1, 72, 100, { lines: 2, leading: 18 })];
    first.solution = [around(1, 72, 300)];
    const alone = await check(book);
    expect(alone.findings.filter((finding) => finding.code === 'solution-label-missing').map((finding) => finding.ref).sort()).toEqual(['s:1', 's:2']);
  });

  it('accepts the answer of a part under the number of its exercise or from its marker', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    const a = book.exercise('s', '3a', 0, 72, 100, { marker: '(a)' });
    const b = book.exercise('s', '3b', 0, 72, 140, { marker: '(b)' });
    const c = book.exercise('s', '4a', 0, 72, 180, { marker: '(a)' });
    book.answer(a, 1, 72, 100, '3. (a) 4 (b) 7');
    b.solution = a.solution as Frame['solution'];
    book.answer(c, 1, 72, 140, '(a) 12');
    const report = await check(book);
    expect(report.findings.filter((finding) => finding.code === 'solution-label-missing')).toEqual([]);
  });

  it('says so for an answer that is a picture, as information', async () => {
    const { book, frames } = small();
    book.scan[2] = [{ left: 0.1, top: 0.4, right: 0.5, bottom: 0.45 }];
    (frames[0] as Frame).solution = [{ page: 2, rect: { left: 0.1, top: 0.39, right: 0.5, bottom: 0.46 } }];
    (frames[1] as Frame).solution = [{ page: 1, rect: { left: 0.1, top: 0.7, right: 0.9, bottom: 0.76 } }];
    const report = await check(book);
    expect(find(report, 'solution-no-text', 'a:1')).toMatchObject({ severity: 'info', page: 2 });
    expect(find(report, 'solution-no-text', 'a:2')).toMatchObject({ severity: 'info', page: 1 });
    expect(codes(report)).not.toContain('solution-label-missing');
  });
});

describe('overlap, context-overlaps-frame and duplicate-region: places that are shared', () => {
  it('reports two exercises that lie on each other, once', async () => {
    const { book, frames } = small();
    // Exercise 2 grows up over half of exercise 1's line and the line above it.
    (frames[1] as Frame).rect = { ...(frames[1] as Frame).rect, top: (frames[0] as Frame).rect.top + 0.01 };
    const report = await check(book);
    const found = report.findings.filter((finding) => finding.code === 'overlap');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', ref: 'a:1', page: 0 });
    expect(found[0]?.message).toContain('a:1 and a:2');
  });

  it('lets regions touch: an overlap of a couple of points is not one', async () => {
    const { book, frames } = small();
    (frames[1] as Frame).rect = { ...(frames[1] as Frame).rect, top: (frames[0] as Frame).rect.bottom - 0.0015 };
    const report = await check(book);
    expect(codes(report)).not.toContain('overlap');
  });

  it('reports an exercise whose continuation lies on another exercise', async () => {
    const { book, frames } = small();
    const target = (frames[3] as Frame).rect;
    (frames[0] as Frame).continues = [{ page: 0, rect: { ...target, top: target.top + 0.002 } }];
    const report = await check(book);
    expect(find(report, 'overlap', 'a:1')?.message).toContain('its continuation');
  });

  it('does not compare the parts of one unit, which tile an area', async () => {
    const book = new Workbook(1);
    const a = book.ordinary(0, 72, 100, '(a) first part', { unit: 'u1' });
    const b = book.ordinary(0, 72, 130, '(b) second part', { unit: 'u1' });
    b.rect = { ...b.rect, top: a.rect.top + 0.005 };
    const report = await check(book);
    expect(codes(report)).not.toContain('overlap');
  });

  it('reports two exercises with the same region as duplicates, not as an overlap', async () => {
    const { book, frames } = small();
    (frames[3] as Frame).rect = { ...(frames[1] as Frame).rect };
    const report = await check(book);
    expect(find(report, 'duplicate-region', 'a:2')).toMatchObject({ severity: 'error', page: 0 });
    expect(codes(report)).not.toContain('overlap');
  });

  it('reports an instruction region that lies on an exercise, for each exercise and each region once', async () => {
    const { book, frames } = small();
    const instruction = { page: 0, rect: { ...(frames[1] as Frame).rect } };
    (frames[1] as Frame).context = [instruction];
    (frames[2] as Frame).context = [instruction];
    const report = await check(book);
    const found = report.findings.filter((finding) => finding.code === 'context-overlaps-frame');
    expect(found.map((finding) => finding.ref)).toEqual(['a:2']);
    expect(found[0]).toMatchObject({ severity: 'warning', page: 0 });
    expect(found[0]?.message).toContain('Its own instruction and the instruction of a:3');
    // The same region on another exercise's own region.
    (frames[0] as Frame).context = [{ page: 0, rect: { ...(frames[4] as Frame).rect } }];
    const other = await check(book);
    expect(find(other, 'context-overlaps-frame', 'a:5')?.message).toContain('The instruction of a:1');
  });

  it('lets the instruction of exercises stand above them without a finding', async () => {
    const { book, frames } = small();
    for (const frame of frames) frame.context = [{ page: 0, rect: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.09 } }];
    const report = await check(book);
    expect(report.findings).toEqual([]);
  });
});

describe('region-size: a region that is not the size of one printed exercise', () => {
  it('reports a region that is too tall, too narrow or too small', async () => {
    const { book, frames } = small();
    (frames[0] as Frame).rect = { left: 0.1, top: 0.05, right: 0.9, bottom: 0.52 };
    (frames[1] as Frame).rect = { left: 0.1, top: 0.2, right: 0.14, bottom: 0.26 };
    (frames[2] as Frame).rect = { left: 0.1, top: 0.3, right: 0.2, bottom: 0.315 };
    const report = await check(book);
    expect(find(report, 'region-size', 'a:1')?.evidence).toBe('region 0.1,0.05,0.9,0.52');
    expect(find(report, 'region-size', 'a:1')?.message).toContain('height 0.47 is more than 0.45');
    expect(find(report, 'region-size', 'a:2')?.message).toContain('width 0.04 is less than 0.05');
    expect(find(report, 'region-size', 'a:3')?.message).toContain('area 0.0015 is less than 0.002');
    expect(find(report, 'region-size', 'a:1')?.severity).toBe('warning');
    expect(find(report, 'region-size', 'a:4')).toBeUndefined();
  });
});

describe('section-unknown and section-page: where the exercises are filed', () => {
  it('reports an exercise filed under an id the outline does not have', async () => {
    const { book, frames } = small();
    (frames[1] as Frame).section = 'zzz';
    const report = await check(book);
    expect(find(report, 'section-unknown', 'zzz:2')).toMatchObject({ severity: 'error', page: 0 });
    expect(report.sections.map((section) => section.id)).toEqual(['a', 'zzz']);
    expect(report.sections[1]).toMatchObject({ id: 'zzz', label: null, exercises: 1 });
  });

  it('reports an exercise on a page before its section starts, or after the next section has started', async () => {
    const book = new Workbook(4);
    book.outline = sectionEntries([
      { id: 'one', page: 1, top: 0.05 },
      { id: 'two', page: 2, top: 0.05 },
      { id: 'three', page: 3, top: 0.05 },
    ]);
    book.exercise('one', '1', 0, 72, 100);
    book.exercise('one', '2', 1, 72, 100);
    // Printed on the page where the next section starts: only the position on the page could tell, which is validate's job.
    book.exercise('one', '3', 2, 72, 100);
    book.exercise('two', '1', 2, 72, 140);
    book.exercise('two', '2', 3, 72, 100);
    book.exercise('three', '1', 3, 72, 140);
    const report = await check(book);
    const found = report.findings.filter((finding) => finding.code === 'section-page');
    expect(found.map((finding) => finding.ref)).toEqual(['one:1']);
    expect(found[0]?.evidence).toBe('page 0; the section starts on page 1');
    // After the heading of the next section: two page 3, whose next entry (three) starts on page 3 is fine, one on page 3 is not.
    book.exercise('one', '4', 3, 72, 180);
    const later = await check(book);
    const flagged = later.findings.filter((finding) => finding.code === 'section-page');
    expect(flagged.map((finding) => finding.ref)).toEqual(['one:1', 'one:4']);
    expect(flagged[1]?.evidence).toBe('page 3; the next section starts on page 2');
  });

  it('lets a chapter hold the pages of its sections', async () => {
    const book = new Workbook(4);
    book.outline = sectionEntries([
      { id: 'c1', page: 0, depth: 0 },
      { id: '1.1', page: 1, depth: 1 },
      { id: 'c2', page: 3, depth: 0 },
    ]);
    book.exercise('c1', '1', 0, 72, 100);
    book.exercise('c1', '2', 2, 72, 100);
    book.exercise('1.1', '1', 1, 72, 100);
    const report = await check(book);
    expect(codes(report)).not.toContain('section-page');
  });
});

describe('the numbers of a section', () => {
  /** A section with these labels on page 0, one exercise per line, in the order given. */
  async function numbered(labels: string[], options: { solutions?: boolean } = {}): Promise<VerifyReport> {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    labels.forEach((label, at) => {
      const frame = book.exercise('s', label, 0, 72, 80 + 30 * at);
      if (options.solutions !== false) book.answer(frame, 1, 72, 80 + 30 * at, `${label}. x`);
    });
    return check(book);
  }

  it('reports the numbers missing between the first and the last, each run once', async () => {
    const report = await numbered(['1', '2', '3', '6', '7', '10', '11']);
    const gaps = report.findings.filter((finding) => finding.code === 'gap');
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ severity: 'warning', ref: 's', page: 0, evidence: '4, 5 missing; the numbers run from 1 to 11' });
    expect(gaps[1]?.evidence).toBe('8, 9 missing; the numbers run from 1 to 11');
    expect(report.sections[0]).toMatchObject({ firstLabel: '1', lastLabel: '11', gaps: ['4', '5', '8', '9'] });
  });

  it('names the first and the last number as the book counts, in numeric order and not in reading order', async () => {
    const report = await numbered(['2', '1', '3', '10', '9']);
    expect(report.sections[0]).toMatchObject({ firstLabel: '1', lastLabel: '10', exercises: 5 });
    const parts = await numbered(['5', '5a', '5b', 'A.1']);
    expect(parts.sections[0]).toMatchObject({ firstLabel: '5', lastLabel: '5b' });
    const letters = await numbered(['B.2', 'A.1']);
    expect(letters.sections[0]).toMatchObject({ firstLabel: 'B.2', lastLabel: 'A.1' });
  });

  it('starts where the book starts, not at 1', async () => {
    const report = await numbered(['11', '12', '13', '14']);
    expect(codes(report)).toEqual([]);
  });

  it('reports a label that two exercises have (a project written by hand or with --force can hold it)', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    const first = book.exercise('s', '1', 0, 72, 100);
    const second = book.exercise('s', '2', 0, 72, 140);
    const third = book.exercise('s', '2', 0, 72, 180);
    for (const [frame, y] of [[first, 100], [second, 140], [third, 180]] as const) book.answer(frame, 1, 72, y, `${frame.label}. x`);
    const report = await check(book);
    const found = find(report, 'duplicate', 's:2');
    expect(found).toMatchObject({ severity: 'error', page: 0 });
    expect(found?.evidence).toBe(`${second.id} on page 0, ${third.id} on page 0`);
    expect(report.sections[0]?.duplicates).toEqual(['2']);
    expect(codes(report)).not.toContain('order');
  });

  it('says once that labels are not plain numbers, and still checks the numbers that start with one', async () => {
    const report = await numbered(['1', '2', '4', '5a', '5b', 'A.3']);
    const found = report.findings.filter((finding) => finding.code === 'non-numeric-label');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'info', ref: 's', evidence: '5a, 5b, A.3' });
    expect(find(report, 'gap')?.evidence).toBe('3 missing; the numbers run from 1 to 5');
  });

  it('reports an exercise whose number does not fit its place on the page', async () => {
    const report = await numbered(['1', '2', '4', '3', '5', '6']);
    const found = report.findings.filter((finding) => finding.code === 'order');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', ref: 's:3', page: 0 });
    expect(found[0]?.evidence).toBe('reads after 4 and before 5');
  });

  it('reports a number that is far above the others of its section', async () => {
    const report = await numbered(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '300']);
    const found = find(report, 'label-outlier', 's:300');
    expect(found).toMatchObject({ severity: 'warning', evidence: 'number 300, median 6' });
    // The stray number is not taken for the end of the section: no gap from 10 to 300.
    expect(codes(report)).not.toContain('gap');
    expect(codes(report)).not.toContain('order');
  });

  it('says how many exercises have an answer: nothing for most, a warning for fewer than four in five, information for none', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([
      { id: 'all', page: 0 },
      { id: 'most', page: 0 },
      { id: 'some', page: 0 },
      { id: 'none', page: 0 },
    ]);
    const make = (section: string, count: number, solved: number): void => {
      for (let n = 1; n <= count; n += 1) {
        const frame = book.exercise(section, String(n), 0, 72, 60 + (book.frames.length % 24) * 30);
        if (n <= solved) book.answer(frame, 1, 72, 60 + (book.frames.length % 24) * 30, `${n}. x`);
      }
    };
    make('all', 5, 5);
    make('most', 5, 4);
    make('some', 5, 3);
    make('none', 3, 0);
    const report = await check(book);
    const found = report.findings.filter((finding) => finding.code === 'no-solution');
    expect(found.map((finding) => [finding.ref, finding.severity])).toEqual([['some', 'warning'], ['none', 'info']]);
    expect(found[0]?.evidence).toBe('without a solution: some:4, some:5');
    expect(found[1]?.evidence).toBe('no solution region on any of 3');
    expect(report.sections.map((section) => [section.id, section.withSolution, section.exercises])).toEqual([['all', 5, 5], ['most', 4, 5], ['some', 3, 5], ['none', 0, 3]]);
    expect(report.summary).toMatchObject({ authoritative: 18, solutions: 12 });
  });
});

describe('the order of exercises on pages of columns', () => {
  /** A page of two columns of six exercises, numbered as `number(column, row)` says. */
  async function columns(number: (column: number, row: number) => string, jitter = 0): Promise<VerifyReport> {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const label = number(column, row);
        const frame = book.exercise('s', label, 0, column === 0 ? 72 : 320, 100 + row * 40 - (column === 1 ? jitter : 0), { width: 190 });
        book.answer(frame, 1, 72, 100 + (Number(label) - 1) * 20, `${label}. x`);
      }
    }
    return check(book);
  }

  it('is quiet when the numbers alternate between the columns row by row, also when the right column sits a hair higher', async () => {
    expect(codes(await columns((column, row) => String(row * 2 + column + 1)))).toEqual([]);
    expect(codes(await columns((column, row) => String(row * 2 + column + 1), 3))).toEqual([]);
  });

  it('is quiet when the numbers run down the left column and then down the right one', async () => {
    expect(codes(await columns((column, row) => String(column * 6 + row + 1)))).toEqual([]);
  });

  it('reports a number that breaks either order', async () => {
    const report = await columns((column, row) => (column === 0 && row === 2 ? '13' : String(row * 2 + column + 1)));
    expect(report.findings.filter((finding) => finding.code === 'order').map((finding) => finding.ref)).toEqual(['s:13']);
  });
});

describe('the report is the same for everyone', () => {
  it('lists errors, then warnings, then infos; by code; by the order of the book', async () => {
    const { book, frames } = small();
    (frames[4] as Frame).rect = { left: 0.1, top: 0.7, right: 0.9, bottom: 0.76 };
    (frames[0] as Frame).label = '9';
    (frames[5] as Frame).solution = [];
    const report = await check(book);
    const order = report.findings.map((finding) => finding.severity);
    expect(order).toEqual([...order].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
    const ranks = report.findings.map((finding) => VERIFY_CODES.findIndex((entry) => entry.code === finding.code));
    const errors = report.findings.filter((finding) => finding.severity === 'error').length;
    expect(ranks.slice(0, errors)).toEqual([...ranks.slice(0, errors)].sort((a, b) => a - b));
  });

  it('does not depend on the order of the frames in the file', async () => {
    const { book, frames } = small();
    (frames[2] as Frame).rect = { ...(frames[2] as Frame).rect, top: (frames[1] as Frame).rect.top + 0.005 };
    (frames[4] as Frame).label = '12';
    const pages = await pagesOf(book.pdf());
    const first = verifyProject(book.project(), pages);
    const shuffled = book.project();
    shuffled.frames = [...shuffled.frames].reverse();
    shuffled.frames.push(shuffled.frames.shift() as Frame);
    expect(verifyProject(shuffled, pages)).toEqual(first);
    expect(first.findings.length).toBeGreaterThan(1);
  });

  it('counts what it found in the summary', async () => {
    const { book, frames } = small();
    (frames[0] as Frame).label = '9';
    const report = await check(book);
    expect(report.summary.errors).toBe(report.findings.filter((finding) => finding.severity === 'error').length);
    expect(report.summary.warnings).toBe(report.findings.filter((finding) => finding.severity === 'warning').length);
    expect(report.summary.infos).toBe(report.findings.filter((finding) => finding.severity === 'info').length);
  });
});

describe('the words of a book that numbers differently', () => {
  it('reads the label of "Problem 12." with an item pattern that gives it in group 1', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0 }]);
    book.exercise('s', '12', 0, 72, 100, { marker: 'Problem 12.' });
    book.exercise('s', '13', 0, 72, 140, { marker: 'Problem 13.' });
    const without = await check(book);
    expect(without.findings.filter((finding) => finding.code === 'label-not-first')).toHaveLength(2);
    const withPattern = await check(book, { itemPatterns: [/^Problem\s+(\d+)\./g] });
    expect(withPattern.findings.filter((finding) => finding.code === 'label-not-first')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Every code has a test

/** One scenario for each code: it builds a project that must give a finding with that code. TypeScript insists on all of them. */
const scenarios: Record<Exclude<VerifyCode, (typeof COVERAGE_CODES)[number]>, () => Promise<VerifyReport>> = {
  'label-not-first': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).label = '9';
    return check(book);
  },
  'no-text': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).rect = { left: 0.1, top: 0.7, right: 0.9, bottom: 0.76 };
    return check(book);
  },
  'solution-label-missing': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).solution = (frames[1] as Frame).solution as Frame['solution'];
    return check(book);
  },
  'solution-no-text': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).solution = [{ page: 2, rect: { left: 0.1, top: 0.5, right: 0.9, bottom: 0.56 } }];
    return check(book);
  },
  overlap: async () => {
    const { book, frames } = small();
    (frames[1] as Frame).rect = { ...(frames[1] as Frame).rect, top: (frames[0] as Frame).rect.top + 0.01 };
    return check(book);
  },
  'context-overlaps-frame': async () => {
    const { book, frames } = small();
    (frames[1] as Frame).context = [{ page: 0, rect: { ...(frames[1] as Frame).rect } }];
    return check(book);
  },
  'duplicate-region': async () => {
    const { book, frames } = small();
    (frames[1] as Frame).rect = { ...(frames[0] as Frame).rect };
    return check(book);
  },
  'region-size': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).rect = { left: 0.1, top: 0.05, right: 0.9, bottom: 0.52 };
    return check(book);
  },
  'section-unknown': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).section = 'nowhere';
    return check(book);
  },
  'section-page': async () => {
    const { book, frames } = small();
    (frames[0] as Frame).page = 2;
    return check(book);
  },
  gap: async () => {
    const { book, frames } = small();
    (frames[2] as Frame).label = '30';
    (frames[3] as Frame).label = '4';
    return check(book);
  },
  duplicate: async () => {
    const { book, frames } = small();
    (frames[1] as Frame).label = '1';
    return check(book);
  },
  'non-numeric-label': async () => {
    const { book, frames } = small();
    (frames[1] as Frame).label = 'B.2';
    return check(book);
  },
  order: async () => {
    const { book, frames } = small();
    (frames[1] as Frame).label = '3';
    (frames[2] as Frame).label = '2';
    (frames[2] as Frame).rect = { ...(frames[2] as Frame).rect };
    return check(book);
  },
  'no-solution': async () => {
    const { book, frames } = small();
    for (const frame of frames) delete frame.solution;
    return check(book);
  },
  'label-outlier': async () => {
    const { book, frames } = small();
    (frames[5] as Frame).label = '99';
    return check(book);
  },
};

describe('every code of a finding', () => {
  it.each(VERIFY_CODES.map((entry) => entry.code).filter((code) => !(COVERAGE_CODES as readonly string[]).includes(code)))('is reported for a book that has its problem: %s', async (code) => {
    const report = await scenarios[code as keyof typeof scenarios]();
    expect(codes(report)).toContain(code);
    const severities = VERIFY_CODES.find((entry) => entry.code === code)?.severities as readonly string[];
    expect(severities).toContain(find(report, code)?.severity);
  });

  it('is documented in docs/AUDIT_A_BOOK.md with what it means and what to do', () => {
    const text = readFileSync(new URL('../../../docs/AUDIT_A_BOOK.md', import.meta.url), 'utf8');
    for (const entry of VERIFY_CODES) expect(text, entry.code).toMatch(new RegExp(`\\| \`${entry.code}\` \\|`));
  });
});
