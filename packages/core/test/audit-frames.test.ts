import { describe, expect, it } from 'vitest';
import { flagRunningHeads, proposeExercises, type ExerciseProposal, type SectionExercises } from '../src/audit/exercises.js';
import { buildBlocks, frameItems, reassignFragments, separateFrames, type Block, type Candidate, type FramedItem, type FrameContext, type ItemAcc, type Layout, type PLine } from '../src/audit/layout.js';
import { withHeadRows, withRunningHeads } from '../src/audit/runningheads.js';
import { DEFAULT_BOOK_PATTERNS, isPageNumber } from '../src/audit/scan.js';
import type { BookEntry } from '../src/audit/sections.js';
import type { PageText, Rect, TextLine } from '../src/model/types.js';
import { STOP_HEADING, heading, inkProfile, line, page, section, type Spec } from './audit-pages.js';

/**
 * The frames of the items of a set: what ends them (the end of the set), what is cut out of them (instructions that are set in
 * the weight of the text), how frames that lie on each other are cut apart, and the fragments that stand next to another item.
 * Pages are built by hand, every text is made up.
 */

const item = (n: number, top: number, left = 0.143, text = `Compute ${n} + ${n + 1}.`): Spec => ({ text: `${n}. ${text}`, left, top });

function run(pages: PageText[], entry: BookEntry = section(0, pages.length)): SectionExercises {
  return proposeExercises(pages, [entry]).sections[0] as SectionExercises;
}

const labelled = (set: SectionExercises, label: string): ExerciseProposal => set.proposals.find((entry) => entry.label === label) as ExerciseProposal;

describe('instructions that are set in the weight of the text', () => {
  // Three items set tight, a blank line, a paragraph of two lines, a blank line, two more items. No line is bold.
  const body = (): Spec[] => [
    heading(),
    item(1, 0.2),
    item(2, 0.2175),
    item(3, 0.235),
    { text: 'Look at the sketch below and answer the next two questions about it.', left: 0.13, top: 0.29 },
    { text: 'Give every length with one decimal place.', left: 0.13, top: 0.3075 },
    item(4, 0.35),
    item(5, 0.3675),
  ];

  it('finds a paragraph after a blank line that the items below follow, and keeps it out of the item above', () => {
    const set = run([page(0, body())]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).toContain('Look at the sketch below');
    expect(set.instructions[0]?.governs).toEqual(['4', '5']);
    expect(labelled(set, '3').context).toEqual([]);
    expect(labelled(set, '4').context).toHaveLength(1);
    expect(labelled(set, '3').rect.bottom).toBeLessThan(0.29);
  });

  it('keeps a second paragraph of an item, hanging under the text of its number, with that item', () => {
    const specs = body();
    // The paragraph is indented like the text of item 3.
    specs[4] = { ...(specs[4] as Spec), left: 0.17 };
    specs[5] = { ...(specs[5] as Spec), left: 0.17 };
    const set = run([page(0, specs)]);
    expect(set.instructions).toHaveLength(0);
    expect(labelled(set, '3').rect.bottom).toBeGreaterThan(0.31);
  });

  it('does not take a paragraph that no item follows', () => {
    const specs = body().slice(0, 6);
    const set = run([page(0, specs)]);
    expect(set.instructions).toHaveLength(0);
  });

  it('adds to the bold instructions of a set: a book may set only some of them in bold', () => {
    const specs = body();
    specs.splice(1, 0, { text: 'Solve each problem.', left: 0.143, top: 0.15, bold: true });
    const set = run([page(0, specs)]);
    expect(set.instructions.map((entry) => entry.text)).toEqual(['Solve each problem.', expect.stringContaining('Look at the sketch below')]);
  });

  it('does not take as an instruction the short pieces of a fraction that stand a little apart from the item above', () => {
    // "3 2 11x + 10" is the top of the fraction of item 3, set a bit under item 2 and followed by item 3: no words, no paragraph.
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2175), { text: '3 2 11x + 10', left: 0.143, top: 0.2425 }, item(3, 0.2575)])]);
    expect(set.instructions).toHaveLength(0);
    expect(labelled(set, '3').context).toEqual([]);
  });
});

describe('instructions that name their items', () => {
  const sentence = 'See the sketch below for questions 3-4.';

  it('are read from anywhere in a paragraph, and govern the items they name and no others', () => {
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2175), { text: sentence, left: 0.13, top: 0.26 }, item(3, 0.31), item(4, 0.3275), item(5, 0.345)])]);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.governs).toEqual(['3', '4']);
    expect(labelled(set, '5').context).toEqual([]);
    expect(labelled(set, '3').context).toHaveLength(1);
  });

  it('are not read inside the text of an item: a line that hangs under the text of its number is a reference', () => {
    const set = run([page(0, [heading(), item(1, 0.2), { text: 'Compare with questions 3-4 of the last set.', left: 0.17, top: 0.2175 }, item(3, 0.235), item(4, 0.2525)])]);
    expect(set.instructions).toHaveLength(0);
  });

  it('name the item that comes next: a sentence that names earlier exercises is no instruction for the ones below it', () => {
    // "The method of Exercises 1 - 2 works for Exercises 5 - 6." stands before item 5: it is a remark, and the first range is
    // not the one of the item that follows.
    const remark = 'The method of Exercises 1 - 2 works for the ones below.';
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2175), { text: remark, left: 0.13, top: 0.26 }, item(3, 0.31), item(4, 0.3275)])]);
    // Read as a range it would govern 1 and 2 only and leave 3 and 4 without; it is the paragraph that the items below follow.
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.governs).toEqual(['3', '4']);
    expect(labelled(set, '3').context).toHaveLength(1);
  });

  it('hold the lines under them down to the first item: a list of steps, a formula displayed in the sentence', () => {
    const steps: Spec[] = [
      { text: 'For every system listed in Exercises 3 - 4:', left: 0.13, top: 0.26 },
      { text: '• Mark the zeros of the curve, if there are any.', left: 0.18, top: 0.2755 },
      { text: '• Write down a few sample values of the curve.', left: 0.18, top: 0.2935 },
      { text: '• Draw the curve through the sample values, then check.', left: 0.18, top: 0.3115 },
      { text: 'Let f be the function defined by f(x) = 3x + 2 with all real numbers x', left: 0.3, top: 0.3295 },
      { text: 'and compute the values.', left: 0.13, top: 0.3475 },
    ];
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2175), ...steps, item(3, 0.4), item(4, 0.4175)])]);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).toContain('and compute the values.');
    expect(set.instructions[0]?.governs).toEqual(['3', '4']);
    // Item 2 does not reach down over the instruction.
    expect(labelled(set, '2').rect.bottom).toBeLessThan(0.26);
  });

  it('leave the short pieces of the first item above its number to the item: only a long indented line is a displayed formula', () => {
    const specs: Spec[] = [
      { text: 'For every system listed in Exercises 3 - 4:', left: 0.13, top: 0.26 },
      { text: 'Simplify each expression and write the result.', left: 0.13, top: 0.2755 },
      { text: '3 2 11x + 10', left: 0.2, top: 0.3025 },
    ];
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2175), ...specs, item(3, 0.32), item(4, 0.3375)])]);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).not.toContain('11x');
  });

  it('carry over the page break: an instruction that ends its page with its list governs the items at the top of the next one', () => {
    const steps: Spec[] = [
      { text: 'For every system listed in Exercises 3 - 4:', left: 0.13, top: 0.7 },
      { text: '• Mark the zeros of the curve, if there are any.', left: 0.18, top: 0.7155 },
      { text: '• Draw the curve through the sample values.', left: 0.18, top: 0.7335 },
    ];
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2175), ...steps]), page(1, [item(3, 0.15), item(4, 0.1675), item(5, 0.185)])]);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.governs).toEqual(['3', '4']);
    expect(labelled(set, '3').context).toHaveLength(1);
    expect(labelled(set, '4').context).toHaveLength(1);
    expect(labelled(set, '5').context).toEqual([]);
    expect(labelled(set, '2').rect.bottom).toBeLessThan(0.7);
  });
});

describe('the regions of an item that goes on over a page break', () => {
  it('are one when the carry from the page before and the chain of columns took the same lines', () => {
    const first = pline(1, '1. Complete the chart.', rectOf(0.143, 0.9, 0.4, 0.9155));
    const item = makeItem(1, first);
    const top = { page: 1, index: 0, role: 'other' as const, line: textLine('Table 2:', rectOf(0.143, 0.06, 0.25, 0.0755)) };
    const cell = { page: 1, index: 1, role: 'other' as const, line: textLine('p q r', rectOf(0.143, 0.09, 0.3, 0.1055)) };
    item.extra.set(1, [cell]);
    item.spans.push({ page: 1, column: 0, lines: [top, cell] });
    const pages = [page(0, []), page(1, [])];
    const framed = frameItems([item], contextOf([item], pages));
    const regions = framed[0]?.frame.continues ?? [];
    expect(regions).toHaveLength(1);
    expect(regions[0]?.page).toBe(1);
    // The union: from the first line of the span to the last.
    expect(regions[0]?.rect.top).toBeLessThan(0.06);
    expect(regions[0]?.rect.bottom).toBeGreaterThan(0.1055);
  });

  it('stay apart when they lie in different columns of the page', () => {
    const item = makeItem(1, pline(1, '1. Complete the chart.', rectOf(0.143, 0.9, 0.4, 0.9155)));
    const left = { page: 1, index: 0, role: 'other' as const, line: textLine('left column text', rectOf(0.143, 0.06, 0.4, 0.0755)) };
    const right = { page: 1, index: 1, role: 'other' as const, line: textLine('right column text', rectOf(0.6, 0.06, 0.85, 0.0755)) };
    item.extra.set(1, [left]);
    item.spans.push({ page: 1, column: 1, lines: [right] });
    const framed = frameItems([item], contextOf([item], [page(0, []), page(1, [])]));
    expect(framed[0]?.frame.continues).toHaveLength(2);
  });
});

describe('the end of the set', () => {
  it('ends the frame of the last item above the heading of what follows, although ink lies under it', () => {
    const ink = inkProfile([{ from: 0.25, to: 0.7 }]);
    const pages = [
      page(0, [heading(), item(1, 0.2), item(2, 0.22), item(3, 0.24), { text: 'Answers', left: 0.1, top: 0.4 }, { text: '1. a', left: 0.12, top: 0.45 }], { ink }),
    ];
    const entry: BookEntry = { ...section(0, 1), practice: { page: 0, top: 0.1, index: 0, text: '1.1 Practice - Title', end: { page: 0, top: 0.4, why: 'the answers of the section' } } };
    const set = run(pages, entry);
    expect(set.proposals.map((proposal) => proposal.label)).toEqual(['1', '2', '3']);
    expect(labelled(set, '3').rect.bottom).toBeLessThan(0.4);
    // Without the end the frame would reach over the ink and the answers below.
    const open = run(pages, { ...entry, practice: { ...(entry.practice as NonNullable<BookEntry['practice']>), end: { page: 1, top: 0, why: 'the end of the book' } } });
    expect(labelled(open, '3').rect.bottom).toBeGreaterThan(0.4);
  });

  it('is not reached over by the frame above it when a paragraph of text that belongs to no item stands under the ink', () => {
    const ink = inkProfile([{ from: 0.25, to: 0.7 }]);
    const paragraphText: Spec = { text: 'A paragraph that belongs to no item, set under it.', left: 0.143, top: 0.4 };
    const pages = [page(0, [heading(), { text: 'Solve each problem.', left: 0.143, top: 0.14, bold: true }, item(1, 0.2), paragraphText], { ink })];
    const set = run(pages);
    expect(set.proposals.map((proposal) => proposal.label)).toEqual(['1']);
    expect(labelled(set, '1').rect.bottom).toBeLessThan(0.4);
    expect(set.notes.join(' ')).toContain('1 line belong to no item');
  });
});

describe('frames that lie on each other', () => {
  it('are cut apart between the lines when the items stand so close that the paddings meet', () => {
    // Lines 0.0155 tall, 0.0125 apart: the boxes of the lines overlap a little, and so do the frames, by more than a sliver.
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.2125), item(3, 0.225), item(4, 0.2375)])]);
    for (const label of ['1', '2', '3']) {
      const upper = labelled(set, label).rect;
      const lower = labelled(set, String(Number(label) + 1)).rect;
      expect(upper.bottom, label).toBeLessThanOrEqual(lower.top + 1e-9);
    }
    expect(labelled(set, '2').evidence.join(' ')).toContain('the frame was cut apart from the frames of');
    // Every frame still holds its own line.
    expect(labelled(set, '2').rect.top).toBeLessThanOrEqual(0.2125 + 0.002);
    expect(labelled(set, '2').rect.bottom).toBeGreaterThanOrEqual(0.2125 + 0.0155 - 0.002);
  });

  it('are left alone when they do not lie on each other (and nothing says they were cut)', () => {
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.25), item(3, 0.3)])]);
    expect(set.proposals.every((proposal) => !proposal.evidence.join(' ').includes('cut apart'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Items built by hand: where the rules that go by columns give a fragment to the wrong item

const rectOf = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

function textLine(text: string, rect: Rect, size = 12): TextLine {
  return { text, rect, fontSize: size, column: 0, chars: text.replace(/\s/g, '').length, bold: false };
}

function pline(index: number, text: string, rect: Rect): PLine {
  return { page: 0, index, role: 'other', line: textLine(text, rect) };
}

function makeItem(n: number, start: PLine, extra: PLine[] = [], band = 1, column = 0): ItemAcc {
  const candidate: Candidate = { label: String(n), n, suffix: '', lead: `${n}.`, rest: start.line.text.replace(/^\d+\.\s*/, ''), page: 0, index: start.index, line: start.line, weak: false };
  return { candidate, start, own: [start, ...extra], extra: new Map(), spans: [], band, column, page: 0, figure: false, block: undefined };
}

function contextOf(items: ItemAcc[], pages: PageText[]): FrameContext {
  const byColumn = new Map<string, ItemAcc[]>();
  for (const entry of items) byColumn.set(`${entry.page}:${entry.band}:${entry.column}`, [...(byColumn.get(`${entry.page}:${entry.band}:${entry.column}`) ?? []), entry]);
  const layout: Layout = { items, bodyRight: 0.95, bodyTop: 0.1, startSize: 12, boundaries: new Map(), orphans: [] };
  return { pages, items, byColumn, layout };
}

describe('a fragment that stands next to another item', () => {
  // Item 23 on the first row, item 29 on a lower row; the denominator "2(3)" stands under the line of 29 but was given to 23.
  const build = (): { a: ItemAcc; b: ItemAcc; fragment: PLine } => {
    const fragment = pline(5, '2(3)', rectOf(0.5, 0.516, 0.532, 0.533));
    const a = makeItem(23, pline(1, '23. (-8) - 9', rectOf(0.523, 0.427, 0.642, 0.447)), [fragment]);
    const b = makeItem(29, pline(2, '29. -2 - (2) - 4(3)(-1)', rectOf(0.389, 0.497, 0.607, 0.523)));
    return { a, b, fragment };
  };

  it('is given to the item whose row it touches, when its own item does not touch it', () => {
    const { a, b, fragment } = build();
    const changed = reassignFragments([a, b], 12, new Set([a]));
    expect([...changed]).toEqual(expect.arrayContaining([a, b]));
    expect(a.own).not.toContain(fragment);
    expect(b.own).toContain(fragment);
  });

  it('stays where it is when the item that holds it is not among those that may give fragments away', () => {
    const { a, b, fragment } = build();
    const changed = reassignFragments([a, b], 12, new Set([b]));
    expect(changed.size).toBe(0);
    expect(a.own).toContain(fragment);
  });

  it('stays with the figure that holds it: the labels of a figure are not the fragments of an expression', () => {
    const { a, b, fragment } = build();
    a.figure = true;
    expect(reassignFragments([a, b], 12).size).toBe(0);
    expect(a.own).toContain(fragment);
  });

  it('is only looked at when frames lie on each other: a set without overlaps is framed exactly by itemFrame', () => {
    // Two items far apart, a fragment that touches neither's row but sits near the second: nothing overlaps, nothing moves.
    const fragment = pline(5, '2(3)', rectOf(0.5, 0.516, 0.532, 0.533));
    const a = makeItem(1, pline(1, '1. Compute 1 + 2.', rectOf(0.143, 0.2, 0.3, 0.2155)), [fragment]);
    const b = makeItem(2, pline(2, '2. Compute 2 + 3.', rectOf(0.143, 0.6, 0.3, 0.6155)));
    const pages = [page(0, [])];
    const framed = frameItems([a, b], contextOf([a, b], pages));
    expect(a.own).toContain(fragment);
    expect(framed.every((entry) => entry.frame.cut === undefined)).toBe(true);
  });

  it('is repaired when they do lie on each other, and the compact item is no longer taken for a figure', () => {
    // Item 1's frame reaches down over the line of item 2 because the fragment is its own; after the repair the frames are apart.
    const fragment = pline(5, '2(3)', rectOf(0.2, 0.236, 0.24, 0.252));
    const a = makeItem(1, pline(1, '1. -2 - (2)', rectOf(0.143, 0.2, 0.3, 0.2155)), [fragment, pline(6, '3', rectOf(0.2, 0.216, 0.21, 0.232))]);
    const b = makeItem(2, pline(2, '2. -4 - (2)(3)', rectOf(0.143, 0.24, 0.3, 0.2555)));
    const pages = [page(0, [])];
    const framed = frameItems([a, b], contextOf([a, b], pages));
    const frameA = framed.find((entry) => entry.item === a) as FramedItem;
    const frameB = framed.find((entry) => entry.item === b) as FramedItem;
    expect(b.own).toContain(fragment);
    // What is left of the overlap is a sliver below the limit at which frames count as lying on each other.
    expect(frameA.frame.rect.bottom - frameB.frame.rect.top).toBeLessThan(0.004);
  });
});

describe('separating frames', () => {
  const framedItem = (n: number, own: Rect, frame: Rect): FramedItem => {
    const entry = makeItem(n, pline(n, `${n}. text`, own));
    return { item: entry, frame: { rect: { ...frame }, continues: [], figure: false } };
  };

  it('cuts two items one above the other in the middle of the gap between their text', () => {
    const a = framedItem(1, rectOf(0.1, 0.2, 0.5, 0.215), rectOf(0.09, 0.194, 0.51, 0.229));
    const b = framedItem(2, rectOf(0.1, 0.225, 0.5, 0.24), rectOf(0.09, 0.219, 0.51, 0.254));
    separateFrames([a, b]);
    expect(a.frame.rect.bottom).toBeCloseTo(0.22, 6);
    expect(b.frame.rect.top).toBeCloseTo(0.22, 6);
    expect(a.frame.cut).toEqual(['2']);
    expect(b.frame.cut).toEqual(['1']);
  });

  it('cuts two items side by side in the middle between their text', () => {
    const a = framedItem(1, rectOf(0.1, 0.2, 0.3, 0.215), rectOf(0.09, 0.194, 0.45, 0.229));
    const b = framedItem(2, rectOf(0.4, 0.2, 0.6, 0.215), rectOf(0.35, 0.194, 0.61, 0.229));
    separateFrames([a, b]);
    expect(a.frame.rect.right).toBeCloseTo(0.35, 6);
    expect(b.frame.rect.left).toBeCloseTo(0.35, 6);
  });

  it('leaves frames that only touch, and a sliver of less than the limits, as they are', () => {
    const a = framedItem(1, rectOf(0.1, 0.2, 0.5, 0.215), rectOf(0.09, 0.194, 0.51, 0.222));
    const b = framedItem(2, rectOf(0.1, 0.225, 0.5, 0.24), rectOf(0.09, 0.2195, 0.51, 0.254));
    separateFrames([a, b]);
    expect(a.frame.rect.bottom).toBe(0.222);
    expect(b.frame.rect.top).toBe(0.2195);
    expect(a.frame.cut).toBeUndefined();
  });

  it('cannot cut apart items whose text overlaps (a line was given to the wrong item) and leaves them', () => {
    const a = framedItem(1, rectOf(0.1, 0.2, 0.5, 0.26), rectOf(0.09, 0.194, 0.51, 0.264));
    const b = framedItem(2, rectOf(0.1, 0.23, 0.5, 0.245), rectOf(0.09, 0.224, 0.51, 0.249));
    separateFrames([a, b]);
    expect(a.frame.rect.bottom).toBe(0.264);
    expect(b.frame.rect.top).toBe(0.224);
  });
});

describe('running heads that change with the section', () => {
  const head = (index: number, text: string, top = 0.06): PageText => ({
    ...page(index, [{ text: '3. x = 2', left: 0.3, top: 0.5 }]),
    lines: [line({ text, left: 0.1, top }), line({ text: '3. x = 2', left: 0.3, top: 0.5 })],
  });

  it('flags a line of the top band that holds words and repeats on three pages, and nothing else', () => {
    const pages = [head(0, '1.2. Lengths and Gaps'), head(1, '1.2. Lengths and Gaps'), head(2, '1.2. Lengths and Gaps'), head(3, '1.3. Turns and Sizes'), head(4, '1.3. Turns and Sizes')];
    const marked = withRunningHeads(pages);
    expect(marked[0]?.lines[0]?.headerFooter).toBe(true);
    expect(marked[2]?.lines[0]?.headerFooter).toBe(true);
    // Two pages are too few for a head, and a line that starts like an item is never one.
    expect(marked[3]?.lines[0]?.headerFooter).toBeUndefined();
    expect(marked[0]?.lines[1]?.headerFooter).toBeUndefined();
  });

  it('gives back the very same pages when there is nothing to flag, and the same answer for the same pages', () => {
    const pages = [head(0, '1.2. Lengths and Gaps'), head(1, '1.3. Turns and Sizes')];
    expect(withRunningHeads(pages)).toBe(pages);
    expect(withRunningHeads(pages)).toBe(withRunningHeads(pages));
  });

  it('keeps a line in the middle of the page and a line of digits out of it', () => {
    const pages = [0, 1, 2].map((index) => ({ ...page(index, []), lines: [line({ text: 'Practice problems for this section', left: 0.1, top: 0.4 }), line({ text: '12', left: 0.5, top: 0.06 })] }));
    const marked = withRunningHeads(pages);
    expect(marked).toBe(pages);
  });

  it('never takes for a head a line that `keep` names, however often it repeats', () => {
    const pages = [0, 1, 2, 3].map((index) => head(index, STOP_HEADING));
    expect(withRunningHeads(pages)[0]?.lines[0]?.headerFooter).toBe(true);
    expect(withRunningHeads(pages, (text) => text.startsWith('Review'))).toBe(pages);
  });

  it('does not take a short line that repeats for a head: it is an answer', () => {
    const pages = [0, 1, 2, 3].map((index) => head(index, 'Answers vary.'));
    expect(withRunningHeads(pages)).toBe(pages);
  });
});

describe('the running heads of a book with sets and answers', () => {
  const heads = (text: string): PageText[] => [0, 1, 2, 3].map((index) => ({ ...page(index, []), lines: [line({ text, left: 0.1, top: 0.06 })] }));

  it('are flagged, but not the heading that ends a set or the caption of a table that goes on', () => {
    expect(flagRunningHeads(heads('Chapter 2. Triangles and Congruence'), DEFAULT_BOOK_PATTERNS)[0]?.lines[0]?.headerFooter).toBe(true);
    const ends = heads(STOP_HEADING);
    expect(flagRunningHeads(ends, DEFAULT_BOOK_PATTERNS)).toBe(ends);
    const answers = heads('Answers to the exercises of the chapter');
    expect(flagRunningHeads(answers, DEFAULT_BOOK_PATTERNS)).toBe(answers);
    const table = heads('TABLE 9.2: (continued)');
    expect(flagRunningHeads(table, DEFAULT_BOOK_PATTERNS)).toBe(table);
  });

  it('are all flagged when a book names no words that end a set', () => {
    const ends = heads(STOP_HEADING);
    expect(flagRunningHeads(ends, { stopWords: [], answerWords: [] })[0]?.lines[0]?.headerFooter).toBe(true);
  });
});

describe('blocks of instruction lines', () => {
  const pline = (pageIndex: number, index: number, top: number, role: PLine['role']): PLine => ({
    page: pageIndex,
    index,
    role,
    line: line({ text: role === 'instruction' ? 'Solve each problem.' : `${index}. Compute it.`, left: 0.143, top }),
  });

  it('go on at the top of the very next page: one block', () => {
    const blocks = buildBlocks([pline(0, 0, 0.9, 'instruction'), pline(1, 0, 0.05, 'instruction'), pline(1, 1, 0.1, 'start')], 0.0175);
    expect(blocks).toHaveLength(1);
    expect([...(blocks[0] as Block).pages.keys()]).toEqual([0, 1]);
  });

  it('end at a page that has no instruction line, whatever is on it: the instruction after it is a new block', () => {
    const blocks = buildBlocks([pline(0, 0, 0.9, 'instruction'), pline(1, 0, 0.3, 'other'), pline(2, 0, 0.05, 'instruction'), pline(2, 1, 0.1, 'start')], 0.0175);
    expect(blocks).toHaveLength(2);
  });
});

describe('the margin at the top of a page', () => {
  // Item 3 is the last item of page 0; page 1 starts with a line that no reader flagged as a running head, and then item 4.
  const book = (margin: Spec): PageText[] => [page(0, [heading(), item(1, 0.2), item(2, 0.22), item(3, 0.8)]), page(1, [margin, item(4, 0.12), item(5, 0.14)])];
  const text = 'Practice problems of this section';

  it('holds a head, never the continuation of the item above the page break', () => {
    const set = run(book({ text, left: 0.143, top: 0.012 }));
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(labelled(set, '3').continues).toBeUndefined();
  });

  it('holds the same line as a continuation when it stands lower, below the margin', () => {
    const set = run(book({ text, left: 0.143, top: 0.06 }));
    expect(labelled(set, '3').continues).toHaveLength(1);
  });

  it('holds the first item of a page when that item stands in the margin', () => {
    const set = run([page(0, [heading(), item(1, 0.2), item(2, 0.22)]), page(1, [item(3, 0.012), item(4, 0.04)])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4']);
  });
});

describe('the title of the chapter on the row of the page number', () => {
  // The page number is flagged by the reader (it repeats on every page), the title changes with the chapter and is not.
  const withHead = (index: number, title: string, specs: Spec[]): PageText => {
    const base = page(index, specs);
    return { ...base, lines: [...base.lines, { ...line({ text: String(index + 12), left: 0.118, top: 0.09 }), headerFooter: true }, line({ text: title, left: 0.7, top: 0.09 })] };
  };

  it('is a running head: it is flagged on the row of a flagged line, on one page only, and nothing else on that row that starts like an item', () => {
    const pages = [withHead(0, 'Prerequisites', [{ text: '3. x = 2', left: 0.3, top: 0.5 }]), page(1, [{ text: 'Prerequisites', left: 0.7, top: 0.09 }])];
    const marked = withRunningHeads(pages);
    const title = (index: number): TextLine | undefined => marked[index]?.lines.find((entry) => entry.text === 'Prerequisites');
    expect(title(0)?.headerFooter).toBe(true);
    // On a page that has no flagged line on that row it stays as it is.
    expect(title(1)?.headerFooter).toBeUndefined();
    expect(marked[0]?.lines.find((entry) => entry.text === '3. x = 2')?.headerFooter).toBeUndefined();
  });

  it('is found by withHeadRows too, which does not read repeated lines for heads (a key repeats short answers)', () => {
    const repeated = [0, 1, 2, 3].map((index) => ({ ...page(index, []), lines: [line({ text: 'Answers will vary here.', left: 0.1, top: 0.06 })] }));
    expect(withHeadRows(repeated)).toBe(repeated);
    expect(withRunningHeads(repeated)[0]?.lines[0]?.headerFooter).toBe(true);
    const pages = [withHead(0, 'Prerequisites', [])];
    expect(withHeadRows(pages)[0]?.lines.find((entry) => entry.text === 'Prerequisites')?.headerFooter).toBe(true);
    expect(withHeadRows(pages, (text) => text === 'Prerequisites')[0]?.lines.find((entry) => entry.text === 'Prerequisites')?.headerFooter).toBeUndefined();
  });

  it('and the page number beside it: a flagged bare number alone on its row is the page number, a digit next to a symbol is not', () => {
    const flagged = (text: string, left: number, top: number): TextLine => ({ ...line({ text, left, top }), headerFooter: true });
    const number = flagged('14', 0.118, 0.09);
    const title = line({ text: 'Prerequisites', left: 0.7, top: 0.09 });
    expect(isPageNumber(number, [number, title])).toBe(true);
    // A digit that touches the text of its row (the index of a root) is part of that line.
    const index = flagged('6', 0.5, 0.1);
    const root = line({ text: '35) 6, - 2', left: 0.517, top: 0.104 });
    expect(isPageNumber(index, [index, root])).toBe(false);
    // The "1." that starts the answers of a key is an answer, and a number nobody flagged is none.
    expect(isPageNumber(flagged('1.', 0.118, 0.09), [])).toBe(false);
    expect(isPageNumber(line({ text: '14', left: 0.118, top: 0.09 }), [])).toBe(false);
  });

  it('does not go on from the item above the page break', () => {
    const first = page(0, [heading(), item(1, 0.2), item(2, 0.22), item(3, 0.8)]);
    const second = withHead(1, 'Prerequisites', [item(4, 0.2), item(5, 0.22)]);
    const set = run([first, second]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(labelled(set, '3').continues).toBeUndefined();
  });
});
