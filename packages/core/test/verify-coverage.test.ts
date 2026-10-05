import { describe, expect, it } from 'vitest';
import type { Frame, Rect, Region } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { buildSpanBook } from '../src/testing/span.js';
import type { PdfText } from '../src/testing/pdf-writer.js';
import { VERIFY_CODES, type EdgeCount, type EdgeDetail, type EdgeInk, type VerifyCode, type VerifyFinding, type VerifyOptions, type VerifyReport } from '../src/verify/types.js';
import { verifyProject, type PageSource } from '../src/verify/verify.js';
import { STOP_HEADING } from './audit-pages.js';
import { COVERAGE_CODES, Workbook, around, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * The checks that read whole pages and not only the regions: text left behind, instructions, the answer key, spans of regions
 * and the ink on the edges. Every book here is synthetic: a few printed lines and the frames around them.
 */

const BOLD = 'Helvetica-Bold';

async function check(book: Workbook, options?: VerifyOptions): Promise<VerifyReport> {
  return verifyProject(book.project(), await pagesOf(book.pdf()), options);
}
const all = (report: VerifyReport, code: VerifyCode): VerifyFinding[] => report.findings.filter((finding) => finding.code === code);
const refs = (report: VerifyReport, code: VerifyCode): string[] => all(report, code).map((finding) => finding.ref);
const codes = (report: VerifyReport): string[] => [...new Set(report.findings.map((finding) => finding.code))];

/** Six exercises 1 to 6 on page 0 (y = 100, 140, ... 300), their answers on page 1 (y = 100, 125, ... 225), the key from page 1. */
function small(): { book: Workbook; frames: Frame[] } {
  const book = new Workbook(3);
  book.outline = sectionEntries([
    { id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Whole Numbers' },
    { id: 'key', page: 1, top: 0.02, title: 'Answers' },
  ]);
  const frames: Frame[] = [];
  for (let n = 1; n <= 6; n += 1) {
    const frame = book.exercise('a', String(n), 0, 72, 100 + 40 * (n - 1));
    book.answer(frame, 1, 72, 100 + 25 * (n - 1), `${n}. ${n * 11}`);
    frames.push(frame);
  }
  return { book, frames };
}

describe('text left behind: the lines of the exercises of a section that no region holds', () => {
  it('is quiet when every printed line is in a region, and does not count furniture and headings', async () => {
    const { book } = small();
    book.text(0, 72, 520, 'Practice', 14, BOLD);
    book.text(0, 292, 815, '12', 10);
    expect((await check(book)).findings).toEqual([]);
  });

  it('reports a line that no region holds, once for a block of lines, under the exercise it goes on from', async () => {
    const { book } = small();
    book.text(0, 72, 500, 'A remark that belongs to no exercise.');
    book.text(0, 72, 514, 'It runs over two lines.');
    book.text(0, 72, 320, 'The statement goes on here.');
    const report = await check(book);
    const found = all(report, 'text-left-behind');
    expect(found.map((finding) => finding.severity)).toEqual(['warning', 'warning']);
    expect(found.map((finding) => finding.ref)).toEqual(['a:6', 'a']);
    expect(found[0]?.message).toContain('right below the region of a:6');
    expect(found[1]).toMatchObject({ page: 0, evidence: 'A remark that belongs to no exercise. It' });
    expect(found[1]?.message).toContain('2 lines');
  });

  it('reports a numbered line as a missed exercise, an error named by its number', async () => {
    const { book } = small();
    book.text(0, 72, 340, '7. Evaluate the expression.');
    book.text(0, 72, 354, 'and give the answer.');
    book.text(0, 72, 400, '(a) A part with no exercise.');
    const report = await check(book);
    expect(refs(report, 'numbered-text-left-behind')).toEqual(['a:7', 'a:(a)']);
    expect(all(report, 'numbered-text-left-behind')[0]).toMatchObject({ severity: 'error', page: 0 });
    expect(all(report, 'numbered-text-left-behind')[0]?.message).toContain('2 lines');
    expect(all(report, 'text-left-behind')).toEqual([]);
  });

  it('takes the numbered lines under a heading that names answers for answers, not for missed exercises, up to the next heading', async () => {
    const { book } = small();
    book.text(0, 72, 340, STOP_HEADING, 14, BOLD);
    book.text(0, 72, 370, '1. Examples could be circles.');
    book.text(0, 72, 400, '2. A line has no width.');
    // A heading ends the block: a numbered line under it is a missed exercise again.
    book.text(0, 72, 440, 'More Practice', 14, BOLD);
    book.text(0, 72, 470, '8. Evaluate the expression.');
    expect(refs(await check(book), 'numbered-text-left-behind')).toEqual(['a:8']);
  });

  it('still looks for answers that no region holds under the heading of the answer key', async () => {
    const { book } = small();
    book.text(1, 72, 60, 'Answers', 14, BOLD);
    book.text(1, 72, 250, '7. 77');
    const report = await check(book);
    expect(refs(report, 'answer-left-behind')).toEqual(['key:7']);
  });

  it('takes a heading for what it is: the title of a section, a bold line alone on its row, a section marker', async () => {
    const { book } = small();
    book.text(0, 72, 350, 'Some Whole Numbers');
    book.text(0, 72, 380, 'Mixed Review', 14, BOLD);
    book.text(0, 72, 410, '1.1');
    expect(all(await check(book), 'text-left-behind')).toEqual([]);
    const plain = small();
    plain.book.text(0, 72, 380, 'Mixed Review of the whole chapter, that goes on and on.', 11);
    expect(all(await check(plain.book), 'text-left-behind')).toHaveLength(1);
  });

  it('does not take an instruction for a heading: a bold line that tells what to do is text that was left behind', async () => {
    const { book } = small();
    book.text(0, 72, 400, 'Find each product.', 11, BOLD);
    const found = all(await check(book), 'text-left-behind');
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe('Find each product.');
  });

  it('says once that a page has no region at all', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Whole Numbers' }]);
    for (let n = 1; n <= 10; n += 1) book.exercise('a', String(n), 0, 72, 60 + 30 * n);
    for (let n = 0; n < 6; n += 1) book.text(1, 72, 100 + 30 * n, `A line of a page that nobody framed, number ${n}.`);
    const found = all(await check(book), 'text-left-behind');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', ref: 'a', page: 1 });
    expect(found[0]?.message).toContain('Page 1 has 6 lines of text and no region at all');
  });

  it('does not judge pages before the first exercise of a section or after where it ends', async () => {
    const { book } = small();
    book.text(0, 72, 50, 'The lesson of the section comes first and has no region.');
    expect(all(await check(book), 'text-left-behind')).toEqual([]);
  });

  it('finds an exercise missed at the start of the set: a numbered line just above the first exercise, and only a numbered one', async () => {
    const { book } = small();
    book.frames.shift();
    book.text(0, 72, 85, 'The practice set starts here.');
    book.text(0, 72, 20, '3. A numbered line high above in the lesson.');
    const report = await check(book);
    expect(refs(report, 'numbered-text-left-behind')).toEqual(['a:1']);
    expect(all(report, 'text-left-behind')).toEqual([]);
    // A dotted number counts examples and definitions too: such a line above the exercises is no exercise that was missed.
    const dotted = small();
    dotted.book.frames.shift();
    dotted.book.text(0, 72, 85, '1.1.1 A rule printed above the exercises.');
    expect(refs(await check(dotted.book), 'numbered-text-left-behind')).toEqual(['a:1']);
    const only = small();
    only.book.text(0, 72, 85, '1.1.1 A rule printed above the exercises.');
    expect(all(await check(only.book), 'numbered-text-left-behind')).toEqual([]);
  });
});

describe('the answer key: answers that no solution region holds', () => {
  it('reports a numbered line as an answer that belongs to no exercise, under the marker of its section when there is one', async () => {
    const { book } = small();
    book.text(1, 72, 260, '7. 77');
    expect(refs(await check(book), 'answer-left-behind')).toEqual(['key:7']);
    const marked = small();
    marked.book.text(1, 72, 60, '1.1', 10);
    marked.book.text(1, 72, 260, '7. 77');
    expect(refs(await check(marked.book), 'answer-left-behind')).toEqual(['a:7']);
    expect(all(await check(marked.book), 'answer-left-behind')[0]).toMatchObject({ severity: 'error', page: 1 });
  });

  it('reports a line right under a solution region as an answer that was cut off, a warning named by its exercise', async () => {
    const { book } = small();
    book.text(1, 72, 240, 'which goes on in a second line');
    const report = await check(book);
    expect(all(report, 'answer-clipped')).toMatchObject([{ severity: 'warning', ref: 'a:6', page: 1 }]);
  });

  it('says as information that other text of the key is in no region', async () => {
    const { book } = small();
    book.text(1, 72, 500, 'A note printed in the answer key.');
    const found = all(await check(book), 'text-left-behind');
    expect(found).toMatchObject([{ severity: 'info', ref: 'key', page: 1 }]);
  });

  it('judges the whole key, to the end of its last page, and the answers of the checked sections when only some are checked', async () => {
    const { book } = small();
    book.text(1, 72, 500, '7. 77');
    expect(refs(await check(book), 'answer-left-behind')).toEqual(['key:7']);
    expect(all(await check(book, { sections: ['a'] }), 'answer-left-behind')).toEqual([]);
  });

  it('takes the answers that follow each section as the part of the zone after its exercises', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([
      { id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Whole Numbers' },
      { id: 'b', page: 1, top: 0.02, label: '1.2', title: 'Word Problems' },
    ]);
    const first = book.exercise('a', '1', 0, 72, 100);
    book.answer(first, 0, 72, 300, '1. 11');
    book.text(0, 72, 330, '2. 22');
    book.exercise('b', '1', 1, 72, 100);
    const report = await check(book);
    expect(refs(report, 'answer-left-behind')).toEqual(['a:2']);
  });
});

describe('spans: an exercise that goes on over page breaks', () => {
  const span = (change: (frames: Frame[]) => void = () => undefined): { project: Project; pages: Promise<PageSource> } => {
    const book = buildSpanBook();
    change(book.frames);
    const project = { ...newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: book.pageCount }, title: 'Span' }), outline: { source: 'manual' as const, entries: book.outline }, frames: book.frames };
    return { project, pages: pagesOf(book.pdf) };
  };
  const run = async (change?: (frames: Frame[]) => void, options?: VerifyOptions): Promise<VerifyReport> => {
    const { project, pages } = span(change);
    return verifyProject(project, await pages, options);
  };
  const e3 = (frames: Frame[]): Frame => frames.find((frame) => frame.label === '3') as Frame;

  it('is clean when the main region and its two continuations hold every line of the span', async () => {
    const report = await run();
    expect(report.findings.map((finding) => `${finding.severity} ${finding.code}`)).toEqual(['info no-solution']);
  });

  it('reports the lines between two regions of one exercise as a skipped part of the span, not as text left behind', async () => {
    const report = await run((frames) => {
      e3(frames).continues = [(e3(frames).continues as Region[])[1] as Region];
    });
    const found = all(report, 'span-gap');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', ref: '0.1:3', page: 1 });
    expect(found[0]?.message).toContain('page 0 to page 2');
    expect(all(report, 'text-left-behind')).toEqual([]);
  });

  it('finds a continuation that was shrunk so that it leaves its last lines out', async () => {
    const report = await run((frames) => {
      const [middle, last] = e3(frames).continues as Region[];
      e3(frames).continues = [{ ...(middle as Region), rect: { ...(middle as Region).rect, bottom: (middle as Region).rect.bottom - 0.07 } }, last as Region];
    });
    expect(refs(report, 'span-gap')).toEqual(['0.1:3']);
  });

  it('finds the end of a span that stops early, as text left behind under its last region', async () => {
    const report = await run((frames) => {
      const [middle, last] = e3(frames).continues as Region[];
      e3(frames).continues = [middle as Region, { ...(last as Region), rect: { ...(last as Region).rect, bottom: (last as Region).rect.bottom - 0.03 } }];
    });
    const found = all(report, 'text-left-behind');
    expect(found).toMatchObject([{ severity: 'warning', ref: '0.1:3', page: 2 }]);
  });

  it('reports continuations that are not in reading order', async () => {
    const report = await run((frames) => {
      e3(frames).continues = [...(e3(frames).continues as Region[])].reverse();
    });
    const found = all(report, 'continuation-order');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]).toMatchObject({ severity: 'error', ref: '0.1:3' });
  });

  it('accepts a continuation in the next column and further down the same page', async () => {
    const book = new Workbook(1);
    book.outline = sectionEntries([{ id: 's', page: 0, top: 0.02 }]);
    const frame = book.exercise('s', '1', 0, 72, 100, { extra: { continues: [around(0, 320, 100)] } });
    book.text(0, 320, 100, 'goes on in the right column');
    expect(codes(await check(book))).not.toContain('continuation-order');
    frame.continues = [around(0, 72, 100)];
    expect(codes(await check(book))).toContain('continuation-order');
  });

  it('does not ask for a number on a continuation, and does not size its height like one printed exercise', async () => {
    const report = await run();
    expect(codes(report)).not.toContain('label-not-first');
    expect(codes(report)).not.toContain('region-size');
  });

  it('takes the continuation of an exercise on another exercise for an overlap, and the same place for a duplicate', async () => {
    const overlap = await run((frames) => {
      const four = frames.find((frame) => frame.label === '4') as Frame;
      e3(frames).continues = [(e3(frames).continues as Region[])[0] as Region, { page: 2, rect: { ...four.rect, top: four.rect.top + 0.003 } }];
    });
    expect(codes(overlap)).toContain('overlap');
    const duplicate = await run((frames) => {
      const four = frames.find((frame) => frame.label === '4') as Frame;
      e3(frames).continues = [(e3(frames).continues as Region[])[0] as Region, { page: 2, rect: { ...four.rect } }];
    });
    expect(codes(duplicate)).toContain('duplicate-region');
  });

  it('warns when a frame holds eight continuations and text follows the last one', async () => {
    const book = new Workbook(10);
    book.outline = sectionEntries([{ id: 's', page: 0, top: 0.02 }]);
    const continues: Region[] = [];
    for (let page = 1; page <= 8; page += 1) {
      book.text(page, 72, 100, `a line of part ${page} of the very long exercise`);
      continues.push(around(page, 72, 100));
    }
    book.exercise('s', '1', 0, 72, 100, { extra: { continues } });
    book.text(8, 72, 120, 'and still it goes on');
    const report = await check(book);
    expect(all(report, 'continuation-limit')).toMatchObject([{ severity: 'warning', ref: 's:1', page: 8 }]);
    const shorter = new Workbook(10);
    shorter.outline = sectionEntries([{ id: 's', page: 0, top: 0.02 }]);
    shorter.exercise('s', '1', 0, 72, 100, { extra: { continues: continues.slice(0, 7).map((region) => ({ ...region })) } });
    expect(codes(await check(shorter))).not.toContain('continuation-limit');
  });
});

describe('instructions: the context of an exercise', () => {
  it('reports an instruction that names other exercises than the one it is attached to', async () => {
    const { book, frames } = small();
    book.text(0, 72, 60, 'Exercises 4 - 6. Evaluate each expression.', 11, BOLD);
    const instruction = around(0, 72, 60, { width: 260 });
    for (const frame of frames) frame.context = [instruction];
    const report = await check(book);
    expect(refs(report, 'context-range')).toEqual(['a:1', 'a:2', 'a:3']);
    expect(all(report, 'context-range')[0]).toMatchObject({ severity: 'error', page: 0 });
  });

  it('reads a range and a list worded in the ways books word them', async () => {
    const cases: [string, string[]][] = [
      ['For 4-6, evaluate each expression.', ['a:1', 'a:2', 'a:3']],
      ['Problems 2 and 3. Evaluate each expression.', ['a:1', 'a:4']],
      ['In Exercises 1 to 3, evaluate each.', ['a:4']],
      ['Evaluate each expression.', []],
    ];
    for (const [words, expected] of cases) {
      const { book, frames } = small();
      book.text(0, 72, 60, words, 11, BOLD);
      const instruction = around(0, 72, 60, { width: 260 });
      for (const frame of frames.slice(0, 4)) frame.context = [instruction];
      expect(refs(await check(book), 'context-range'), words).toEqual(expected);
    }
  });

  it('reports an exercise that an instruction of its section names but that does not have it', async () => {
    const { book } = small();
    book.text(0, 72, 120, 'Exercises 2 - 3. Solve each.', 11, BOLD);
    const report = await check(book);
    expect(refs(report, 'context-missing')).toEqual(['a:2', 'a:3']);
    expect(all(report, 'context-missing')[0]).toMatchObject({ severity: 'error', page: 0 });
  });

  it('is quiet when the instruction is attached, or is part of the exercise own region', async () => {
    const { book, frames } = small();
    book.text(0, 72, 120, 'Exercises 2 - 3. Solve each.', 11, BOLD);
    const instruction = around(0, 72, 120, { width: 260 });
    (frames[1] as Frame).context = [instruction];
    (frames[2] as Frame).context = [instruction];
    expect(codes(await check(book))).not.toContain('context-missing');
  });

  it('warns when a later instruction stands between the attached one and the exercise', async () => {
    const { book, frames } = small();
    book.text(0, 72, 60, 'Evaluate each expression.', 11, BOLD);
    book.text(0, 72, 200, 'Find each product.', 11, BOLD);
    const first = around(0, 72, 60, { width: 200 });
    for (const frame of frames) frame.context = [first];
    const report = await check(book);
    expect(refs(report, 'context-not-nearest')).toEqual(['a:4', 'a:5', 'a:6']);
    expect(all(report, 'context-not-nearest')[0]).toMatchObject({ severity: 'warning', page: 0, evidence: 'Find each product.' });
    // Attached to the exercises that follow it, the later instruction is the nearest.
    const second = around(0, 72, 200, { width: 200 });
    for (const frame of frames.slice(3)) frame.context = [second];
    expect(codes(await check(book))).not.toContain('context-not-nearest');
  });
});

describe('the answer key by section', () => {
  /** Sections a (1.1) and b (1.2), two exercises each; the key has a marker for each. */
  function two(): { book: Workbook; frames: Frame[] } {
    const book = new Workbook(2);
    book.outline = sectionEntries([
      { id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Whole Numbers' },
      { id: 'b', page: 0, top: 0.2, label: '1.2', title: 'Word Problems' },
      { id: 'key', page: 1, top: 0.02, title: 'Answers' },
    ]);
    const frames = [book.exercise('a', '1', 0, 72, 100), book.exercise('a', '2', 0, 72, 140), book.exercise('b', '1', 0, 72, 240), book.exercise('b', '2', 0, 72, 280)];
    book.text(1, 72, 60, '1.1', 10);
    book.answer(frames[0] as Frame, 1, 72, 100, '1. 11');
    book.answer(frames[1] as Frame, 1, 72, 125, '2. 22');
    book.text(1, 72, 170, '1.2', 10);
    book.answer(frames[2] as Frame, 1, 72, 210, '1. 33');
    book.answer(frames[3] as Frame, 1, 72, 235, '2. 44');
    return { book, frames };
  }

  it('is clean when every answer stands under the marker of its section', async () => {
    expect((await check(two().book)).findings).toEqual([]);
  });

  it('reports an answer region under the marker of another section', async () => {
    const { book, frames } = two();
    const [a2, b1] = [frames[1] as Frame, frames[2] as Frame];
    [a2.solution, b1.solution] = [b1.solution, a2.solution];
    const report = await check(book);
    expect(refs(report, 'solution-section-mismatch')).toEqual(['a:2', 'b:1']);
    expect(all(report, 'solution-section-mismatch')[0]).toMatchObject({ severity: 'error', page: 1, evidence: 'under the marker of b' });
  });

  it('takes a heading that starts with the label of a section as its marker, though its title is not in it, and not one that starts with a longer label', async () => {
    // Sections 1.10 and 1.1, in this order; the key has a bold heading for each, in a large size: "1.1 Review Answers", "1.10 Review Answers".
    const book = new Workbook(2);
    book.outline = sectionEntries([
      { id: 'b', page: 0, top: 0.02, label: '1.10', title: 'Word Problems' },
      { id: 'a', page: 0, top: 0.2, label: '1.1', title: 'Whole Numbers' },
      { id: 'key', page: 1, top: 0.02, title: 'Answers' },
    ]);
    const frames = [book.exercise('b', '1', 0, 72, 100), book.exercise('b', '2', 0, 72, 140), book.exercise('a', '1', 0, 72, 240), book.exercise('a', '2', 0, 72, 280)];
    book.text(1, 72, 60, '1.1 Review Answers', 18, 'Helvetica-Bold');
    // The first answer takes two lines: the second starts with another label, which is no marker: only a heading is.
    const first = book.answer(frames[2] as Frame, 1, 72, 100, '1. 11');
    book.text(1, 72, 112, '1.10: a decimal');
    first.rect.bottom += 0.02;
    book.answer(frames[3] as Frame, 1, 72, 135, '2. 22');
    book.text(1, 72, 170, '1.10 Review Answers', 18, 'Helvetica-Bold');
    book.answer(frames[0] as Frame, 1, 72, 210, '1. 33');
    book.answer(frames[1] as Frame, 1, 72, 235, '2. 44');
    expect((await check(book)).findings).toEqual([]);
    // Swapped, the answers of 1.10 lie under the marker of 1.1 and the other way round.
    const [a1, b1] = [frames[2] as Frame, frames[0] as Frame];
    [a1.solution, b1.solution] = [b1.solution, a1.solution];
    expect(refs(await check(book), 'solution-section-mismatch')).toEqual(['b:1', 'a:1']);
  });

  it('takes no number inside an answer for a marker, though it is the label of a section, nor a line of an answer that holds a title', async () => {
    // The first answer of 1.1 has a second line "1.2" (a table cell: the label of section 1.2) and a third that holds the title of 1.2.
    const { book, frames } = two();
    const first = (frames[0] as Frame).solution?.[0] as Region;
    book.text(1, 72, 112, '1.2');
    book.text(1, 72, 124, 'Word Problems, answered');
    first.rect.bottom += 0.04;
    // The second answer moves down under them.
    book.pages[1] = (book.pages[1] as PdfText[]).filter((entry) => entry.text !== '2. 22');
    (frames[1] as Frame).solution = [];
    book.answer(frames[1] as Frame, 1, 72, 145, '2. 22');
    const report = await check(book);
    expect(refs(report, 'solution-section-mismatch')).toEqual([]);
  });

  it('takes a title that another title holds for no marker: "Fractions" is in the heading of "Proofs about Fractions"', async () => {
    // Sections b (1.2, "Proofs about Fractions") and a (1.1, "Fractions"), in this order; the key has a heading with the title of each and no label.
    const book = new Workbook(2);
    book.outline = sectionEntries([
      { id: 'b', page: 0, top: 0.02, label: '1.2', title: 'Proofs about Fractions' },
      { id: 'a', page: 0, top: 0.2, label: '1.1', title: 'Fractions' },
      { id: 'key', page: 1, top: 0.02, title: 'Answers' },
    ]);
    const frames = [book.exercise('b', '1', 0, 72, 100), book.exercise('b', '2', 0, 72, 140), book.exercise('a', '1', 0, 72, 240), book.exercise('a', '2', 0, 72, 280)];
    book.text(1, 72, 60, 'Fractions, Review', 18, 'Helvetica-Bold');
    book.answer(frames[2] as Frame, 1, 72, 100, '1. 11');
    book.answer(frames[3] as Frame, 1, 72, 125, '2. 22');
    book.text(1, 72, 170, 'Proofs about Fractions, Review', 18, 'Helvetica-Bold');
    book.answer(frames[0] as Frame, 1, 72, 210, '1. 33');
    book.answer(frames[1] as Frame, 1, 72, 235, '2. 44');
    expect((await check(book)).findings).toEqual([]);
  });

  it('takes a bold line that starts with the label of a section for its marker, though it ends in a colon and reads as an instruction', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([
      { id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Whole Numbers' },
      { id: 'b', page: 0, top: 0.2, label: '1.2', title: 'Word Problems' },
      { id: 'key', page: 1, top: 0.02, title: 'Answers' },
    ]);
    const frames = [book.exercise('a', '1', 0, 72, 100), book.exercise('a', '2', 0, 72, 140), book.exercise('b', '1', 0, 72, 240), book.exercise('b', '2', 0, 72, 280)];
    book.text(1, 72, 60, '1.1 Review Answers', 18, 'Helvetica-Bold');
    book.answer(frames[0] as Frame, 1, 72, 100, '1. 11');
    book.answer(frames[1] as Frame, 1, 72, 125, '2. 22');
    book.text(1, 72, 170, '1.2 Word Problems - Third Edition, Extension:', 11, 'Helvetica-Bold');
    book.answer(frames[2] as Frame, 1, 72, 210, '1. 33');
    book.answer(frames[3] as Frame, 1, 72, 235, '2. 44');
    // (The line itself is text that no region holds: the text check says so, and nothing about the sections.)
    expect(refs(await check(book), 'solution-section-mismatch')).toEqual([]);
    const [a2, b1] = [frames[1] as Frame, frames[2] as Frame];
    [a2.solution, b1.solution] = [b1.solution, a2.solution];
    expect(refs(await check(book), 'solution-section-mismatch')).toEqual(['a:2', 'b:1']);
  });

  it('warns about an answer that is out of order in its column of the key', async () => {
    const { book, frames } = small();
    const swapped = (frames[1] as Frame).solution;
    (frames[1] as Frame).solution = (frames[2] as Frame).solution;
    (frames[2] as Frame).solution = swapped;
    const report = await check(book);
    expect(all(report, 'solution-order')).toHaveLength(1);
    expect(all(report, 'solution-order')[0]).toMatchObject({ severity: 'warning', page: 1 });
    expect(codes(report)).toContain('solution-label-missing');
  });

  it('keeps every column of the key in order on its own, and leaves answers that share a block out', async () => {
    const book = new Workbook(2);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02 }, { id: 'key', page: 1, top: 0.02 }]);
    const frames = [1, 2, 3, 4].map((n) => book.exercise('a', String(n), 0, 72, 100 + 30 * n));
    book.text(1, 72, 100, '1. 11');
    book.text(1, 72, 125, '2. 22');
    book.text(1, 320, 100, '3. 33');
    book.text(1, 320, 125, '4. 44');
    const columns = [around(1, 72, 100, { lines: 2, leading: 25, width: 100 }), around(1, 320, 100, { lines: 2, leading: 25, width: 100 })];
    (frames[0] as Frame).solution = [around(1, 72, 100, { width: 100 })];
    (frames[1] as Frame).solution = [around(1, 72, 125, { width: 100 })];
    (frames[2] as Frame).solution = [around(1, 320, 100, { width: 100 })];
    (frames[3] as Frame).solution = [around(1, 320, 125, { width: 100 })];
    expect(codes(await check(book))).not.toContain('solution-order');
    (frames[0] as Frame).solution = [columns[0] as Region];
    (frames[1] as Frame).solution = [columns[0] as Region];
    expect(codes(await check(book))).not.toContain('solution-order');
  });
});

describe('edge-on-ink: an edge that runs through printed glyphs', () => {
  it('is only checked when the ink was measured, and reports each side, the worst first', async () => {
    const { book } = small();
    expect(codes(await check(book))).not.toContain('edge-on-ink');
    const lookup: VerifyOptions['ink'] = (region) => (Math.abs(region.rect.top - 0.1057) < 0.001 ? { top: 0.4, bottom: 0.01, left: 0, right: 0.03 } : { top: 0, bottom: 0.2, left: 0, right: 0 });
    const report = await check(book, { ink: lookup });
    const found = all(report, 'edge-on-ink');
    expect(found.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(found[0]?.message).toContain('top edge');
    expect(found[0]?.evidence).toContain('40%');
    expect(found.some((finding) => finding.message.includes('right edge'))).toBe(true);
    // Twelve regions (six exercises, six answers); the first exercise and the first answer stand at the same height and have a clean bottom.
    expect(found.filter((finding) => finding.message.includes('bottom edge'))).toHaveLength(10);
    const shares = found.map((finding) => Number(/(\d+)% dark/.exec(finding.evidence)?.[1]));
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
  });

  it('reports an edge that the ink goes across, with the number of pixels, also when few of the pixels around it are dark', async () => {
    const { book } = small();
    // One percent of the pixels around the edge are dark (below the share that reports it) and the ink goes across it at 6 pixels at
    // the top of a:1 (its region, and its answer, which stands at the same height) and at 1 pixel elsewhere (a graze, not reported).
    const lookup: VerifyOptions['ink'] = (region) => ({
      top: 0.01,
      bottom: 0,
      left: 0,
      right: 0,
      cross: { top: Math.abs(region.rect.top - 0.1057) < 0.001 ? 6 : 1, bottom: 0, left: 0, right: 0 },
      length: { horizontal: 400, vertical: 40 },
    });
    const found = all(await check(book, { ink: lookup }), 'edge-on-ink');
    expect(found.map((finding) => finding.ref)).toEqual(['a:1', 'a:1']);
    expect(found.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(found[0]?.message).toContain('The top edge of the region of a:1');
    expect(found[0]?.message).toContain('cuts printed ink: the ink goes on across it at 6 pixels of its 400 (1.5%)');
    expect(found[0]?.evidence).toContain('top edge 1% dark; ink goes across it at 6 px');
    expect(found[1]?.message).toContain('solution region (solution:0) of a:1');
  });

  it('reports two pixels and not one, and a share above two percent without any crossing as before', async () => {
    const { book } = small();
    const at = (cross: number, share: number): VerifyOptions['ink'] => () => ({ top: share, bottom: 0, left: 0, right: 0, cross: { top: cross, bottom: 0, left: 0, right: 0 }, length: { horizontal: 400, vertical: 40 } });
    expect(all(await check(book, { ink: at(1, 0.01) }), 'edge-on-ink')).toHaveLength(0);
    expect(all(await check(book, { ink: at(2, 0.01) }), 'edge-on-ink')).toHaveLength(12);
    const share = all(await check(book, { ink: at(0, 0.05) }), 'edge-on-ink');
    expect(share).toHaveLength(12);
    expect(share[0]?.message).toContain('runs through printed ink: 5% of the pixels along it are dark');
    expect(share[0]?.evidence).toContain('ink goes across it at 0 px');
    // An edge that is cut and has much ink around it comes before one that only grazes, the worst first.
    const both = all(await check(book, { ink: (region) => ({ top: Math.abs(region.rect.top - 0.1057) < 0.001 ? 0.5 : 0.03, bottom: 0, left: 0, right: 0, cross: { top: 400, bottom: 0, left: 0, right: 0 } }) }), 'edge-on-ink');
    expect(both[0]?.message).toContain('cuts printed ink: the ink goes on across it at 400 pixels');
    expect(both[0]?.evidence).toContain('top edge 50% dark');
  });

  it('knows a measure that took no crossing (it only has the share), and an edge of no length', async () => {
    const { book } = small();
    const found = all(await check(book, { ink: () => ({ top: 0.5, bottom: 0, left: 0, right: 0, cross: { top: 3, bottom: 0, left: 0, right: 0 } }) }), 'edge-on-ink');
    expect(found[0]?.message).toContain('cuts printed ink: the ink goes on across it at 3 pixels, so a glyph or a line is cut.');
  });
});

describe('edge-on-ink: what a person or an agent can change about an edge', () => {
  const clean: EdgeInk = { top: 0, bottom: 0, left: 0, right: 0, cross: { top: 0, bottom: 0, left: 0, right: 0 }, length: { horizontal: 400, vertical: 40 }, pointsPerPixel: 0.5 };
  const sameRect = (a: Rect, b: Rect): boolean => Math.abs(a.left - b.left) + Math.abs(a.top - b.top) + Math.abs(a.right - b.right) + Math.abs(a.bottom - b.bottom) < 1e-9;
  const round4 = (value: number): number => Math.round(value * 10000) / 10000;
  /** An ink measure in which one edge of one region fails the rule, with what `explainEdges` found about it. */
  const failing = (target: Rect, side: 'top' | 'bottom' | 'left' | 'right', cross: number, share: number, detail: EdgeDetail): NonNullable<VerifyOptions['ink']> => (region) =>
    sameRect(region.rect, target) ? { ...clean, [side]: share, cross: { ...clean.cross, [side]: cross } as EdgeCount, detail: { [side]: detail } } : clean;
  const infosOf = (report: VerifyReport, code: VerifyCode): VerifyFinding[] => report.findings.filter((finding) => finding.code === code);

  it('names the position where the rule is passed, and says how far it is', async () => {
    const { book, frames } = small();
    const target = (frames[1] as Frame).rect;
    const fix = { position: round4(target.top - 0.003), move: -4, crossing: 0 };
    const found = all(await check(book, { ink: failing(target, 'top', 6, 0.03, { run: 2, poke: 5, fixes: [fix] }) }), 'edge-on-ink');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', ref: 'a:2' });
    expect(found[0]?.message).toContain('The top edge of the region of a:2');
    expect(found[0]?.message).toContain(`Move it to y=${fix.position} (4 pixels, 2 points up): there no ink goes across it.`);
    expect(found[0]?.evidence).toContain(`move top to y=${fix.position} (-4 px)`);
    // The other sides say x and left or right.
    const side = all(await check(book, { ink: failing(target, 'right', 3, 0.01, { run: 2, poke: 2, fixes: [{ position: round4(target.right + 0.0015), move: 3, crossing: 1 }] }) }), 'edge-on-ink');
    expect(side[0]?.message).toContain(`Move it to x=${round4(target.right + 0.0015)} (3 pixels, 1.5 points to the right): there only a tip of ink goes across it.`);
  });

  it('only names a position that leaves the text of the region as it is, and one that does not run into another exercise', async () => {
    const { book, frames } = small();
    const target = (frames[1] as Frame).rect;
    // The first position takes the line of the exercise above into the region; the second moves 3 pixels.
    const takesALine = { position: (frames[0] as Frame).rect.top, move: -40, crossing: 0 };
    const small3 = { position: round4(target.top - 0.0018), move: -3, crossing: 0 };
    const named = all(await check(book, { ink: failing(target, 'top', 6, 0.03, { run: 2, poke: 5, fixes: [takesALine, small3] }) }), 'edge-on-ink');
    expect(named[0]?.message).toContain(`Move it to y=${small3.position}`);
    // Only that position: the edge is then only a tip that cannot be separated.
    const only = await check(book, { ink: failing(target, 'top', 6, 0.03, { run: 2, poke: 2, fixes: [takesALine] }) });
    expect(all(only, 'edge-on-ink')).toHaveLength(0);
    expect(infosOf(only, 'edge-interlocked')).toHaveLength(1);
    // The exercise above lies on this one: three pixels up run into it (more than the overlap rule would let two regions take), one pixel does not.
    (frames[0] as Frame).rect = { ...(frames[0] as Frame).rect, bottom: target.top };
    const run3 = { position: round4(target.top - 0.003), move: -5, crossing: 0 };
    const run1 = { position: round4(target.top - 0.0008), move: -1, crossing: 0 };
    const runs = all(await check(book, { ink: failing(target, 'top', 6, 0.03, { run: 2, poke: 5, fixes: [run3, run1] }) }), 'edge-on-ink');
    expect(runs[0]?.message).toContain(`Move it to y=${run1.position}`);
    const none = all(await check(book, { ink: failing(target, 'top', 6, 0.03, { run: 2, poke: 5, fixes: [run3] }) }), 'edge-on-ink');
    expect(none[0]?.message).toContain('No position within 20 points outwards clears it');
  });

  it('is information, edge-interlocked, when no position is clear and the ink that goes across is only tips; counted, not a warning', async () => {
    const { book, frames } = small();
    const target = (frames[1] as Frame).rect;
    const report = await check(book, { ink: failing(target, 'bottom', 8, 0.05, { run: 2, poke: 2, fixes: [] }) });
    expect(all(report, 'edge-on-ink')).toHaveLength(0);
    const info = infosOf(report, 'edge-interlocked');
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ severity: 'info', ref: 'a:2' });
    expect(info[0]?.message).toContain('The bottom edge of the region of a:2');
    expect(info[0]?.message).toContain('only tips poke across it, at most 2 pixels deep');
    expect(info[0]?.message).toContain('Nothing to repair');
    expect(info[0]?.evidence).toContain('ink goes across it at 8 px, at most 2 px deep');
    expect(report.summary.infos).toBeGreaterThanOrEqual(1);
    // An edge that lies on ink and cuts nothing is the same, said so.
    const touch = infosOf(await check(book, { ink: failing(target, 'top', 0, 0.06, { run: 0, poke: 0, fixes: [] }) }), 'edge-interlocked');
    expect(touch[0]?.message).toContain('it lies on ink and cuts nothing');
  });

  it('stays a warning when more is cut: a piece of ink that goes deeper than tips, or a run along the edge', async () => {
    const { book, frames } = small();
    const target = (frames[1] as Frame).rect;
    // Deeper than a tip (a numerator, a figure): a warning with the nearest clear position outwards as a hint.
    const far = { position: round4(target.top - 0.0105), move: -22, crossing: 0 };
    const hint = all(await check(book, { ink: failing(target, 'top', 6, 0.02, { run: 2, poke: 4, fixes: [], far }) }), 'edge-on-ink');
    expect(hint).toHaveLength(1);
    expect(hint[0]?.severity).toBe('warning');
    expect(hint[0]?.message).toContain('the ink reaches more than 3 pixels to each side of it');
    expect(hint[0]?.message).toContain(`No position within 3 points clears it; the nearest clear position outwards is y=${far.position} (22 pixels, 11 points up)`);
    expect(hint[0]?.message).toContain('mcprep crop a:2');
    expect(hint[0]?.evidence).toContain(`nearest outwards y=${far.position} (-22 px)`);
    // Nothing clear within 20 points: the edge cuts what a rectangle cannot keep whole.
    const none = all(await check(book, { ink: failing(target, 'top', 6, 0.02, { run: 2, poke: 4, fixes: [] }) }), 'edge-on-ink');
    expect(none[0]?.message).toContain('No position within 20 points outwards clears it');
    expect(none[0]?.message).toContain('acknowledge the finding when the book prints it so');
    // A rule, a border or a thick stroke along the edge is a cut even when the pieces are not deep.
    const thick = await check(book, { ink: failing(target, 'top', 9, 0.02, { run: 4, poke: 1, fixes: [] }) });
    expect(all(thick, 'edge-on-ink')).toHaveLength(1);
    expect(infosOf(thick, 'edge-interlocked')).toHaveLength(0);
    // The regions that are not the exercise's own are named the way crop names them.
    const solution = (frames[1] as Frame).solution?.[0] as Region;
    const own = all(await check(book, { ink: failing(solution.rect, 'bottom', 9, 0.02, { run: 4, poke: 1, fixes: [] }) }), 'edge-on-ink');
    expect(own[0]?.message).toContain('The bottom edge of the solution region (solution:0) of a:2 on page 1');
  });
});

describe('context-inconsistent: an exercise between two that share an instruction', () => {
  it('warns when it has none or another one, not when its own instruction is printed right above it', async () => {
    const { book, frames } = small();
    book.text(0, 72, 60, 'Evaluate each expression.', 11, BOLD);
    // The instruction that a wrong exercise has is printed far from them (on a page after the exercises).
    book.text(2, 72, 45, 'Solve each equation.', 11, BOLD);
    book.text(0, 72, 160, 'Simplify each fraction.', 11, BOLD);
    const shared = around(0, 72, 60, { width: 200 });
    for (const frame of frames) frame.context = [shared];
    expect(codes(await check(book))).not.toContain('context-inconsistent');
    const dropped = frames[2] as Frame;
    delete dropped.context;
    expect(refs(await check(book), 'context-inconsistent')).toEqual(['a:3']);
    dropped.context = [around(2, 72, 45, { width: 200 })];
    expect(refs(await check(book), 'context-inconsistent')).toEqual(['a:3']);
    // An instruction of its own, printed between the exercise before and this one, is a group of one: the book's.
    dropped.context = [around(0, 72, 160, { width: 200 })];
    expect(codes(await check(book))).not.toContain('context-inconsistent');
    // The first exercise of the group lacks the instruction printed right above it.
    delete (frames[0] as Frame).context;
    expect(refs(await check(book), 'context-inconsistent')).toEqual(['a:1']);
  });

  /**
   * Eight exercises: 1 to 4 under one instruction line (page 0), 5 to 8 under an instruction of two lines that crosses a page break (one
   * region at the bottom of page 0, one at the top of page 1), so that their instruction is a set of two regions.
   */
  function twoGroups(): { book: Workbook; frames: Frame[] } {
    const book = new Workbook(3);
    book.outline = sectionEntries([
      { id: 'a', page: 0, top: 0.02, label: '1.1', title: 'Whole Numbers' },
      { id: 'key', page: 2, top: 0.02, title: 'Answers' },
    ]);
    book.text(0, 72, 60, 'Evaluate each expression.', 11, BOLD);
    book.text(0, 72, 770, 'Solve each of the following problems by setting up an equation', 11, BOLD);
    book.text(1, 72, 60, 'and then solving it for the unknown number.', 11, BOLD);
    const first = around(0, 72, 60, { width: 200 });
    const crossing = [around(0, 72, 770, { width: 400 }), around(1, 72, 60, { width: 400 })];
    const frames: Frame[] = [];
    for (let n = 1; n <= 4; n += 1) frames.push(book.exercise('a', String(n), 0, 72, 100 + 40 * (n - 1), { extra: { context: [first] } }));
    for (let n = 5; n <= 8; n += 1) frames.push(book.exercise('a', String(n), 1, 72, 100 + 40 * (n - 5), { extra: { context: crossing } }));
    return { book, frames };
  }

  it('compares the instructions as sets of regions: an instruction of two regions across a page break', async () => {
    expect(codes(await check(twoGroups().book))).not.toContain('context-inconsistent');
    // The first exercise of the second group has none: it is the instruction printed right above it, and the next exercises have it.
    const start = twoGroups();
    delete (start.frames[4] as Frame).context;
    const found = all(await check(start.book), 'context-inconsistent');
    expect(refs(await check(start.book), 'context-inconsistent')).toEqual(['a:5']);
    expect(found[0]).toMatchObject({ severity: 'warning', page: 1 });
    expect(found[0]?.message).toContain('has no instruction printed right above it');
    expect(found[0]?.message).toContain('a:6');
    // One region of the two is not the instruction: the exercise in the middle of the group has half of it.
    const half = twoGroups();
    (half.frames[5] as Frame).context = [(half.frames[5] as Frame).context?.[0] as Region];
    expect(refs(await check(half.book), 'context-inconsistent')).toEqual(['a:6']);
    // The last exercise of the group has none, and nothing is printed between it and the one before: it belongs to that group.
    const end = twoGroups();
    delete (end.frames[7] as Frame).context;
    const last = all(await check(end.book), 'context-inconsistent');
    expect(last.map((finding) => finding.ref)).toEqual(['a:8']);
    expect(last[0]?.message).toContain('a:7');
    expect(last[0]?.message).toContain('3 exercises share');
    // A group of one with an instruction of its own is not judged.
    const alone = twoGroups();
    delete (alone.frames[7] as Frame).context;
    alone.book.text(1, 72, 200, 'Check your answer.', 11, BOLD);
    expect(refs(await check(alone.book), 'context-inconsistent')).toEqual([]);
  });

  it('says nothing about a book that prints no instruction, or in a lesson with its exercises inline', async () => {
    const plain = twoGroups();
    for (const frame of plain.frames) delete frame.context;
    expect(codes(await check(plain.book))).not.toContain('context-inconsistent');
  });
});

describe('stray-frame: a frame that no book exercise is', () => {
  it('is reported in a project that holds book exercises, not in one that does not, and not when sections are chosen', async () => {
    const { book } = small();
    book.ordinary(0, 72, 400, 'A remark framed for oneself.');
    const found = all(await check(book), 'stray-frame');
    expect(found).toMatchObject([{ severity: 'warning', page: 0 }]);
    expect(found[0]?.ref).toMatch(/^f\d+$/);
    expect(all(await check(book, { sections: ['a'] }), 'stray-frame')).toEqual([]);
    const plain = new Workbook(1);
    plain.outline = sectionEntries([{ id: 's', page: 0 }]);
    plain.ordinary(0, 72, 100, 'Just an exercise framed for oneself.');
    expect(codes(await check(plain))).not.toContain('stray-frame');
  });
});

describe('the new codes', () => {
  it('are in the table of the codes, each with the severities it can have', () => {
    for (const code of COVERAGE_CODES) expect(VERIFY_CODES.find((entry) => entry.code === code), code).toBeDefined();
  });
});
