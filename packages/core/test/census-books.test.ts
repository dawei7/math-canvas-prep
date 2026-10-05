import { describe, expect, it } from 'vitest';
import type { PageText, Rect } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import { buildExoticBook, buildNumberedBook, EXOTIC_ANSWERS_HEADING, EXOTIC_MARGIN_HEADING } from '../src/testing.js';
import { findNumberedRuns, surveyNumberedRuns } from '../src/verify/runs.js';

/**
 * The two synthetic books of the census, measured against what they say about themselves: every region of the truth holds exactly the lines of its
 * item, no region holds a line of another, and the runs of the truth are the runs of the detector. A truth that is wrong would make every test built on
 * it wrong in the same way.
 */

async function textOf(pdf: Uint8Array): Promise<PageText[]> {
  const doc = await PdfDocument.fromBytes(pdf);
  try {
    return await doc.allPageText({ fonts: true });
  } finally {
    await doc.close();
  }
}

const EPS = 0.002;
const within = (inner: Rect, outer: Rect): boolean => inner.left >= outer.left - EPS && inner.right <= outer.right + EPS && inner.top >= outer.top - EPS && inner.bottom <= outer.bottom + EPS;
const touches = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const linesIn = (texts: PageText[], page: number, rect: Rect): string[] => (texts[page]?.lines ?? []).filter((line) => within(line.rect, rect)).map((line) => line.text);
const crossing = (texts: PageText[], page: number, rect: Rect): string[] => (texts[page]?.lines ?? []).filter((line) => touches(line.rect, rect) && !within(line.rect, rect)).map((line) => line.text);

describe('the synthetic textbook of the census (buildNumberedBook)', () => {
  const book = buildNumberedBook();

  it('has the pages its truth lists, and no page of the survey is left out', async () => {
    const texts = await textOf(book.pdf);
    expect(texts).toHaveLength(book.pageCount);
    expect(book.pages.map((entry) => entry.page)).toEqual(texts.map((_text, page) => page));
    expect(book.pages.map((entry) => entry.kind)).toEqual(['front', 'front', 'text', 'exercises', 'exercises', 'text', 'exercises', 'exercises', 'back', 'back', 'answers']);
    expect(book.sets.map((set) => `${set.section}:${set.items.length}`)).toEqual(['1.6:14', '2.5:14']);
    expect(book.outline.map((entry) => `${entry.id}@${entry.page}/${entry.depth}`)).toEqual(['ch1@2/0', '1.6@3/1', 'ch2@5/0', '2.5@6/1', 'index@8/0', 'references@9/0', 'answers@10/0']);
  });

  it('frames every exercise and every answer around its own lines and no other: the first line starts with the label, no line is cut, regions do not touch each other', async () => {
    const texts = await textOf(book.pdf);
    const all = [...book.sets.flatMap((set) => set.items), ...book.keys.flatMap((key) => key.items)];
    for (const item of all) {
      const lines = linesIn(texts, item.page, item.rect);
      expect(lines[0], `${item.chapter}:${item.label}`).toMatch(new RegExp(`^${item.label}\\. `));
      expect(lines.filter((line) => /^\d+\. /.test(line)), `${item.chapter}:${item.label}`).toHaveLength(1);
      expect(lines.join(' '), `${item.chapter}:${item.label}`).toContain(item.words.trim());
      expect(crossing(texts, item.page, item.rect), `${item.chapter}:${item.label}`).toEqual([]);
      for (const more of item.continues) {
        expect(linesIn(texts, more.page, more.rect).length, `${item.chapter}:${item.label} continues`).toBeGreaterThan(0);
        expect(crossing(texts, more.page, more.rect)).toEqual([]);
      }
    }
    const regions = all.flatMap((item) => [{ page: item.page, rect: item.rect, of: `${item.chapter}:${item.label}` }, ...item.continues.map((more) => ({ page: more.page, rect: more.rect, of: `${item.chapter}:${item.label}` }))]);
    for (const a of regions) for (const b of regions) if (a !== b && a.page === b.page) expect(touches(a.rect, b.rect), `${a.of} and ${b.of}`).toBe(false);
    // One exercise of each set runs over the page break: its first lines are at the foot of a page, the rest at the top of the next.
    expect(book.sets.flatMap((set) => set.items).filter((item) => item.continues.length > 0).map((item) => `${item.chapter}:${item.label}`)).toEqual(['1:10', '2:10']);
  });

  it('has the runs its truth lists: the detector finds exactly them, and nothing on the contents, the index or the list of steps', async () => {
    const texts = await textOf(book.pdf);
    const { runs, leftOut } = surveyNumberedRuns(texts);
    expect(runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, step: run.step, pages: run.pages }))).toEqual(book.runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, step: run.step, pages: run.pages })));
    expect(leftOut.map((left) => `${left.reason}@${left.firstPage}`)).toEqual(['contents@1', 'contents@1', 'contents@8']);
    expect(runs.some((run) => run.pages.includes(book.stepsPage))).toBe(false);
    expect(book.runs.map((run) => run.kind)).toEqual(['exercises', 'exercises', 'references', 'answers', 'answers']);
    expect(findNumberedRuns(texts).every((run) => run.coverage === 0 && !run.covered)).toBe(true);
  });
});

describe('the synthetic book whose layout the finder cannot read (buildExoticBook)', () => {
  const book = buildExoticBook();
  const { truth } = book;

  it('prints the two phrases of its truth and no practice word anywhere', async () => {
    const texts = await textOf(book.pdf);
    const everything = texts.flatMap((page) => page.lines.map((line) => line.text));
    expect(everything).toContain(EXOTIC_MARGIN_HEADING);
    expect(everything).toContain(EXOTIC_ANSWERS_HEADING);
    expect(truth.marginHeading).toBe('Try it yourself');
    expect(truth.answersHeading).toBe('Solutions to Try it yourself');
    expect(everything.join(' ')).not.toMatch(/exercise|practice|problem|review|homework|question/i);
    for (const block of truth.blocks) expect(linesIn(texts, block.page, block.heading)).toEqual([EXOTIC_MARGIN_HEADING]);
    expect(texts[truth.answersPage]?.lines.some((line) => line.text === EXOTIC_ANSWERS_HEADING)).toBe(true);
  });

  it('frames every exercise and every answer around exactly its own lines, also where it runs over a column or a page', async () => {
    const texts = await textOf(book.pdf);
    for (const item of [...truth.exercises, ...truth.answers]) {
      const ref = `${item.chapter}:${item.label}`;
      const pieces = [{ page: item.page, rect: item.rect }, ...item.continues.map((more) => ({ page: more.page, rect: more.rect }))];
      const found = pieces.flatMap((piece) => linesIn(texts, piece.page, piece.rect));
      expect(found, ref).toEqual(item.lines);
      expect(item.lines[0], ref).toMatch(new RegExp(`^${item.label}\\) `));
      for (const piece of pieces) expect(crossing(texts, piece.page, piece.rect), ref).toEqual([]);
    }
    const regions = [...truth.exercises, ...truth.answers].flatMap((item) => [{ page: item.page, rect: item.rect, of: `${item.chapter}:${item.label}` }, ...item.continues.map((more) => ({ page: more.page, rect: more.rect, of: `${item.chapter}:${item.label}` }))]);
    for (const a of regions) for (const b of regions) if (a !== b && a.page === b.page) expect(touches(a.rect, b.rect), `${a.of} and ${b.of}`).toBe(false);
    expect(truth.overColumn).toEqual([{ chapter: 1, label: '6' }]);
    expect(truth.overPage).toEqual([{ chapter: 1, label: '19' }]);
    for (const crossed of [...truth.overColumn, ...truth.overPage]) expect(truth.exercises.find((item) => item.chapter === crossed.chapter && item.label === crossed.label)?.continues.length).toBeGreaterThan(0);
    expect(truth.exercises.map((item) => item.label).slice(0, 3)).toEqual(['1', '2', '3']);
    expect(truth.exercises.filter((item) => item.chapter === 1)).toHaveLength(19);
    expect(truth.exercises.filter((item) => item.chapter === 2)).toHaveLength(10);
    expect(truth.answers.filter((item) => item.chapter === 1)).toHaveLength(19);
    expect(truth.answers.filter((item) => item.chapter === 2)).toHaveLength(10);
  });

  it('has the runs its truth lists, two columns of boxed items "7)" and answers "7)", and the lists that are no run', async () => {
    const texts = await textOf(book.pdf);
    const runs = findNumberedRuns(texts);
    expect(runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, pages: run.pages }))).toEqual(truth.runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, pages: run.pages })));
    expect(runs.every((run) => run.scheme === 'k)')).toBe(true);
    // The four steps and the two notes are numbered lists of fewer than five items.
    for (const notRun of truth.notRuns) {
      const printed = texts[notRun.page]?.lines.filter((line) => /^\d\. /.test(line.text)).map((line) => line.text.charAt(0)) ?? [];
      expect(printed).toEqual(notRun.labels);
    }
    expect(truth.pages.map((entry) => entry.kind)).toEqual(['front', 'front', 'exercises', 'exercises', 'exercises', 'answers', 'back']);
    expect(truth.outline.map((entry) => `${entry.id}@${entry.page}/${entry.depth}`)).toEqual(['ch1@2/0', 'ex1@2/1', 'ch2@4/0', 'ex2@4/1', 'solutions@5/0', 'index@6/0']);
  });
});
