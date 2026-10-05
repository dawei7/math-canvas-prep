import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/model/types.js';
import { RUN_LIMITS } from '../src/verify/runs.js';
import { VERIFY_CODES, type VerifyCode, type VerifyFinding, type VerifyOptions, type VerifyReport } from '../src/verify/types.js';
import { verifyProject } from '../src/verify/verify.js';
import { Workbook, around, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * The finding numbered-run-uncovered inside `verifyProject`: the census of numbered runs, made for the whole book when the text of every page is
 * given. Every book is synthetic: a few printed lines, some of them framed.
 */

const BOLD = 'Helvetica-Bold';
const CODE: VerifyCode = 'numbered-run-uncovered';

async function check(book: Workbook, options: VerifyOptions = {}): Promise<VerifyReport> {
  const pages = await pagesOf(book.pdf());
  return verifyProject(book.project(), pages, { numberedRuns: pages, ...options });
}
const census = (report: VerifyReport): VerifyFinding[] => report.findings.filter((finding) => finding.code === CODE);

/** `count` lines `n. ...` on a page, `pitch` points apart from `y`; unframed. */
function list(book: Workbook, page: number, count: number, options: { y?: number; pitch?: number; from?: number } = {}): void {
  const from = options.from ?? 1;
  for (let n = from; n < from + count; n += 1) book.text(page, 72, (options.y ?? 150) + (n - from) * (options.pitch ?? 30), `${n}. A synthetic line of the list, number ${n}, with some words.`);
}

/** A page of a framed set: six exercises 1 to 6 of section `a` (each framed as an authoritative exercise). */
function framedSet(book: Workbook, page: number): Frame[] {
  const frames: Frame[] = [];
  for (let n = 1; n <= 6; n += 1) frames.push(book.exercise('a', String(n), page, 72, 120 + 40 * (n - 1)));
  return frames;
}

describe('numbered-run-uncovered', () => {
  it('is in the table of the codes as a warning', () => {
    expect(VERIFY_CODES.find((entry) => entry.code === CODE)).toEqual({ code: CODE, severities: ['warning'] });
  });

  it('is reported for a numbered list that no region covers: the run id as ref, the first page of the items, the heading above them in the message', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    framedSet(book, 0);
    book.text(1, 72, 100, 'Further reading', 14, BOLD);
    list(book, 1, 7);
    const report = await check(book);
    expect(census(report)).toHaveLength(1);
    const found = census(report)[0] as VerifyFinding;
    expect(found).toMatchObject({ severity: 'warning', ref: 'p1:1', page: 1, evidence: '1. A synthetic line of the list, number' });
    expect(found.message).toBe("Page 1: 7 numbered items (1. to 7.) lie outside every exercise, context and answer region; the line above them reads 'Further reading'. If they are exercises, frame them; if the book prints another kind of list there (a bibliography, steps of a method), acknowledge it with the page and a quote.");
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
  });

  it('needs the text of the whole book: without it the report is the one it always was', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    framedSet(book, 0);
    list(book, 1, 7);
    const pages = await pagesOf(book.pdf());
    expect(census(verifyProject(book.project(), pages))).toEqual([]);
    expect(census(verifyProject(book.project(), pages, { numberedRuns: pages }))).toHaveLength(1);
  });

  it('is quiet when the run is framed: every item inside an exercise region', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    framedSet(book, 0);
    list(book, 1, 7);
    for (let n = 1; n <= 7; n += 1) book.frames.push({ id: `g${n}`, kind: 'exercise', page: 1, rect: around(1, 72, 150 + (n - 1) * 30).rect, authority: 'book', label: String(n), section: 'a' });
    expect(census(await check(book))).toEqual([]);
  });

  it('is reported for a project with no exercise at all: the book that the finder read as empty', async () => {
    const book = new Workbook(2);
    book.text(0, 72, 100, '1.4 Exercises', 18, BOLD);
    list(book, 0, 14, { y: 140, pitch: 40 });
    const report = await check(book);
    expect(report.summary).toMatchObject({ exercises: 0, authoritative: 0, sections: 0 });
    expect(census(report)).toMatchObject([{ severity: 'warning', ref: 'p0:1', page: 0 }]);
    expect(census(report)[0]?.message).toContain('Page 0: 14 numbered items (1. to 14.)');
    expect(census(report)[0]?.message).toContain("the line above them reads '1.4 Exercises'");
  });

  it('says how many items lie outside when the project covers most of the run but not all of it', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    for (let n = 1; n <= 8; n += 1) book.exercise('a', String(n), 0, 72, 100 + 40 * (n - 1));
    list(book, 1, 4, { from: 9, y: 100 });
    const found = census(await check(book));
    // The items 9 to 12 stand on the next page after the framed 1 to 8: one run of twelve, two thirds covered.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ref: 'p0:1', page: 1 });
    expect(found[0]?.message).toContain('Page 1: 4 of the 12 numbered items of the run 1. to 12. (from 9. on) lie outside every exercise, context and answer region');
  });

  it('is judged on the runs of 5 items or more in a project that covers fewer than three runs, and on 8 or more in one that covers three', async () => {
    const withCovered = (covered: number): Workbook => {
      const book = new Workbook(covered + 2);
      book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
      for (let page = 0; page < covered; page += 1) framedSet(book, page);
      list(book, covered, 7);
      list(book, covered + 1, 8);
      return book;
    };
    expect(RUN_LIMITS).toMatchObject({ minRun: 5, auditedRuns: 3, auditedMinRun: 8 });
    // The longer run comes first among the findings of one code (the weight is the number of items outside).
    const few = census(await check(withCovered(2)));
    expect(few.map((found) => found.ref)).toEqual(['p3:1', 'p2:1']);
    const audited = census(await check(withCovered(3)));
    expect(audited.map((found) => found.ref)).toEqual(['p4:1']);
    expect(audited[0]?.message).toContain('8 numbered items (1. to 8.)');
  });

  it('is not made for a section filter: the census reads the whole book', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    framedSet(book, 0);
    list(book, 1, 7);
    expect(census(await check(book))).toHaveLength(1);
    expect(census(await check(book, { sections: ['a'] }))).toEqual([]);
  });

  it('does not count the list of four steps, the contents or an index of numbered entries', async () => {
    const book = new Workbook(3);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    framedSet(book, 0);
    list(book, 1, 4);
    ['Variables', 'Sampling', 'Studies', 'Graphs', 'Shapes', 'Centres'].forEach((title, k) => book.text(2, 72, 120 + k * 22, `${k + 1}. ${title} ${'.'.repeat(30)} ${10 + 2 * k}`));
    expect(census(await check(book))).toEqual([]);
  });

  it('gives the same report for the same project whatever the order of the frames in the file', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1' }]);
    framedSet(book, 0);
    list(book, 1, 9);
    const first = await check(book);
    book.frames.reverse();
    expect(await check(book)).toEqual(first);
  });
});
