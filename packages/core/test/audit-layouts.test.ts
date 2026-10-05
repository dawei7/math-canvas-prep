import { describe, expect, it } from 'vitest';
import type { Frame, PageText, Region, TextLine } from '../src/model/types.js';
import { compareSolution, compareWithProposal, exerciseToOperation, exercisesToOperations, solutionToOperation } from '../src/audit/ops.js';
import { bookKey } from '../src/model/authority.js';
import { enlargeToMinimum, roundRect } from '../src/model/rect.js';
import { proposeExercises, type ExerciseOptions } from '../src/audit/exercises.js';
import { detachFragments, endsLikeAnItem, explodeMergedRows, type PLine } from '../src/audit/layout.js';
import { INK_BANDS } from '../src/model/types.js';
import { mapWithInk } from './ink-helpers.js';
import { locateSections, type BookEntry } from '../src/audit/sections.js';

/**
 * Practice pages built by hand, line by line, for the layouts that a generated PDF cannot make on purpose: lines the
 * text extraction merged, a number without its closing mark, a paragraph line that starts with a number, pages
 * without font information.
 */

interface Spec {
  text: string;
  left: number;
  top: number;
  right?: number;
  size?: number;
  bold?: boolean;
  /** The height of the line's box; the default is one line of text. */
  height?: number;
}

const HEIGHT = 0.0155;

function line(spec: Spec, withFonts: boolean): TextLine {
  const size = spec.size ?? 12;
  const right = spec.right ?? Math.min(0.95, spec.left + spec.text.length * 0.0075 * (size / 12));
  return {
    text: spec.text,
    rect: { left: spec.left, top: spec.top, right, bottom: spec.top + (spec.height ?? HEIGHT * (size / 12)) },
    fontSize: size,
    column: 0,
    chars: spec.text.replace(/\s/g, '').length,
    ...(withFonts ? { bold: spec.bold === true } : {}),
  };
}

function page(index: number, specs: Spec[], withFonts = true): PageText {
  const lines = specs.map((spec) => line(spec, withFonts));
  // A page number in the footer, flagged the way the reader flags running footers.
  lines.push({ ...line({ text: String(index + 1), left: 0.5, top: 0.926, size: 10 }, withFonts), headerFooter: true });
  return { page: index, size: { width: 595, height: 842, rotation: 0 }, lines, columns: 1, hasText: true };
}

/** A section whose practice set starts at line 0 of page `first` (the heading) and ends at the end of the book. */
function section(first: number, pageCount: number): BookEntry {
  return {
    title: 'Practice',
    page: first,
    depth: 1,
    id: '1.1',
    label: '1.1',
    kind: 'section',
    confidence: 1,
    evidence: [],
    differences: [],
    practice: { page: first, top: 0.1, index: 0, text: '1.1 Practice - Title', end: { page: pageCount, top: 0, why: 'the end of the book' } },
  };
}

const heading: Spec = { text: '1.1 Practice - Title', left: 0.33, top: 0.1, size: 16.9, bold: true };

function run(pages: PageText[], options: ExerciseOptions = {}) {
  const result = proposeExercises(pages, [section(0, pages.length)], options);
  return { result, set: result.sections[0] as NonNullable<(typeof result.sections)[number]> };
}

/** Two columns of short items: left 1, 3, 5 ... and right 2, 4, 6 ... `count` items from `from`, rows 0.03 apart. */
function twoColumns(from: number, count: number, top = 0.2): Spec[] {
  const specs: Spec[] = [];
  for (let k = 0; k < count; k += 1) {
    const n = from + k;
    specs.push({ text: `${n}) item ${n} text`, left: n % 2 === 1 ? 0.143 : 0.517, top: top + Math.floor(k / 2) * 0.03 });
  }
  return specs;
}

describe('lines the text extraction merged', () => {
  it('cuts "5) first 6) second" into two items where the second column starts', () => {
    const specs = twoColumns(1, 4);
    // Items 5 and 6 come out of the extraction as one line.
    specs.push({ text: '5) item 5 text and more 6) item 6 text and more', left: 0.143, top: 0.26, right: 0.8 });
    specs.push(...twoColumns(7, 6, 0.29));
    const { set } = run([page(0, [heading, { text: 'Solve each.', left: 0.143, top: 0.15, bold: true }, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const five = set.proposals.find((entry) => entry.label === '5');
    const six = set.proposals.find((entry) => entry.label === '6');
    expect(five?.rect.right).toBeLessThanOrEqual((six?.rect.left ?? 0) + 1e-9);
    expect(six?.rect.left).toBeGreaterThan(0.49);
    expect(six?.rect.left).toBeLessThan(0.52);
    expect(set.gaps).toEqual([]);
  });

  it('does not cut at a number that closes an interval or follows a minus sign', () => {
    // "( - inf, - 5) U ..." holds "5)" where the second column starts, but what comes before it is an unfinished bracket.
    const specs: Spec[] = [
      { text: '1) item 1 text', left: 0.143, top: 0.2 },
      { text: '2) m > − 4 or m < − 5 : ( − ∞, − 5) ⋃ [ − 4, ∞)', left: 0.143, top: 0.23, right: 0.8 },
      { text: '3) item 3 text', left: 0.143, top: 0.26 },
      { text: '4) item 4 text', left: 0.517, top: 0.2 },
      { text: '5) item 5 text', left: 0.517, top: 0.23 },
      { text: '6) item 6 text', left: 0.517, top: 0.26 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(set.duplicates).toEqual([]);
    expect(set.proposals.find((entry) => entry.label === '2')?.rect.right).toBeGreaterThan(0.7);
  });

  it('does not cut a sentence that holds a number and a dot', () => {
    const specs: Spec[] = [
      { text: '1) If the side is increased by 5 the area is multiplied by 4. Find the', left: 0.143, top: 0.2, right: 0.83 },
      { text: 'side of the original square.', left: 0.176, top: 0.22 },
      { text: '2) Another problem, with a second sentence 3. Find it.', left: 0.143, top: 0.26, right: 0.8 },
      { text: '3) A third problem.', left: 0.143, top: 0.3 },
      { text: '4) A fourth problem.', left: 0.143, top: 0.33 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4']);
    expect(set.rejected).toEqual([]);
  });
});

describe('where a joined line may be cut', () => {
  it('cuts only after something that can end an item', () => {
    expect(endsLikeAnItem('5) first item')).toBe(true);
    expect(endsLikeAnItem('(−∞, −5]')).toBe(true);
    // A fill-in item may end with an equals sign.
    expect(endsLikeAnItem('3 + 4 =')).toBe(true);
    expect(endsLikeAnItem('2) m > − 4 or m < − 5 : ( − ∞, − ')).toBe(false);
    expect(endsLikeAnItem('f(x) = 3 +')).toBe(false);
    expect(endsLikeAnItem('x ∈ (−∞, 3) ∪')).toBe(false);
    expect(endsLikeAnItem('a,')).toBe(false);
    expect(endsLikeAnItem('   ')).toBe(false);
  });

  it('gives each item of a row that joins two columns the height of the piece that stands where it does', () => {
    const numbered = (n: number, left: number, top: number): PLine => ({
      page: 0,
      index: n,
      role: 'other',
      line: { text: `${n}) answer ${n}`, rect: { left, top, right: left + 0.17, bottom: top + 0.0155 }, fontSize: 12, column: 0, chars: 12 },
    });
    const joined: PLine = {
      page: 0,
      index: 40,
      role: 'other',
      line: {
        text: '17) (2x + 7y2)(y − 4x) 26) (7a − 2)(8b − 7)',
        rect: { left: 0.39, top: 0.6476, right: 0.81, bottom: 0.6776 },
        fontSize: 12,
        column: 0,
        chars: 36,
        parts: [
          { text: '17) (2x + 7y2)(y − 4x)', chars: 18, rect: { left: 0.39, top: 0.6476, right: 0.56, bottom: 0.6633 } },
          { text: '26) (7a − 2)(8b − 7)', chars: 17, rect: { left: 0.64, top: 0.6603, right: 0.81, bottom: 0.6776 } },
        ],
      },
    };
    const lines = [numbered(13, 0.39, 0.5), numbered(14, 0.39, 0.55), numbered(15, 0.39, 0.6), numbered(22, 0.64, 0.5), numbered(23, 0.64, 0.55), numbered(24, 0.64, 0.6), joined];
    const exploded = explodeMergedRows(lines).filter((entry) => entry.line.text.startsWith('17)') || entry.line.text.startsWith('26)'));
    expect(exploded.map((entry) => entry.line.text.slice(0, 3))).toEqual(['17)', '26)']);
    const [first, second] = exploded as [PLine, PLine];
    expect([first.line.rect.top, first.line.rect.bottom]).toEqual([0.6476, 0.6633]);
    expect([second.line.rect.top, second.line.rect.bottom]).toEqual([0.6603, 0.6776]);
    expect(first.line.parts).toBeUndefined();
    expect(second.line.rect.left).toBeCloseTo(0.64, 6);
  });

  it('sets the sign of a root that stands beside a line free, and keeps the rows of a fraction with theirs', () => {
    const joined = (parts: PLine['line']['parts'], text: string, rect: PLine['line']['rect']): PLine => ({ page: 0, index: 7, role: 'other', line: { text, rect, fontSize: 12, column: 0, chars: text.length, ...(parts ? { parts } : {}) } });
    // "20) 9, - 1" and the sign of the root of the next row, 0.03 to its right and a little lower.
    const root = joined(
      [
        { text: '20) 9, − 1', chars: 8, rect: { left: 0.517, top: 0.5598, right: 0.5776, bottom: 0.5776 } },
        { text: '√', chars: 1, rect: { left: 0.612, top: 0.5732, right: 0.629, bottom: 0.591 } },
      ],
      '20) 9, − 1 √',
      { left: 0.517, top: 0.5598, right: 0.629, bottom: 0.591 },
    );
    const split = detachFragments([root]);
    expect(split.map((entry) => entry.line.text)).toEqual(['20) 9, − 1', '√']);
    expect(split[0]?.line.rect).toEqual({ left: 0.517, top: 0.5598, right: 0.5776, bottom: 0.5776 });
    expect(split[0]?.line.parts).toBeUndefined();
    expect(split[1]?.line.rect).toEqual({ left: 0.612, top: 0.5732, right: 0.629, bottom: 0.591 });
    expect(split[0]?.index).toBeLessThan(split[1]?.index ?? 0);
    // The rows of a fraction stand above one another, so they stay one line.
    const fraction = joined(
      [
        { text: '24) 2', chars: 4, rect: { left: 0.517, top: 0.118, right: 0.566, bottom: 0.135 } },
        { text: 'a', chars: 1, rect: { left: 0.55, top: 0.1, right: 0.57, bottom: 0.118 } },
      ],
      '24) 2 a',
      { left: 0.517, top: 0.1, right: 0.57, bottom: 0.135 },
    );
    expect(detachFragments([fraction])).toHaveLength(1);
    // The denominator of a fraction under the number is more than a glyph, and stays with its item although it lies below and to the right.
    const denominator = joined(
      [
        { text: '32)', chars: 3, rect: { left: 0.517, top: 0.2005, right: 0.544, bottom: 0.2148 } },
        { text: 'a - b', chars: 4, rect: { left: 0.56, top: 0.2098, right: 0.613, bottom: 0.2367 } },
      ],
      '32) a - b',
      { left: 0.517, top: 0.2005, right: 0.613, bottom: 0.2367 },
    );
    expect(detachFragments([denominator])).toHaveLength(1);
    // Two items of two columns are the business of explodeMergedRows, not of this.
    const items = joined(
      [
        { text: '17) first answer', chars: 14, rect: { left: 0.39, top: 0.6476, right: 0.56, bottom: 0.6633 } },
        { text: '26) second answer', chars: 15, rect: { left: 0.64, top: 0.6603, right: 0.81, bottom: 0.6776 } },
      ],
      '17) first answer 26) second answer',
      { left: 0.39, top: 0.6476, right: 0.81, bottom: 0.6776 },
    );
    expect(detachFragments([items])).toHaveLength(1);
    expect(detachFragments([joined(undefined, '5) plain', { left: 0.1, top: 0.2, right: 0.2, bottom: 0.22 })])).toHaveLength(1);
  });

  it('keeps the whole height of a row when the extraction says nothing about its pieces', () => {
    const numbered = (n: number, left: number, top: number): PLine => ({
      page: 0,
      index: n,
      role: 'other',
      line: { text: `${n}) answer ${n}`, rect: { left, top, right: left + 0.17, bottom: top + 0.0155 }, fontSize: 12, column: 0, chars: 12 },
    });
    const joined: PLine = {
      page: 0,
      index: 40,
      role: 'other',
      line: { text: '17) first answer 26) second answer', rect: { left: 0.39, top: 0.6476, right: 0.81, bottom: 0.6776 }, fontSize: 12, column: 0, chars: 30 },
    };
    const lines = [numbered(13, 0.39, 0.5), numbered(14, 0.39, 0.55), numbered(15, 0.39, 0.6), numbered(22, 0.64, 0.5), numbered(23, 0.64, 0.55), numbered(24, 0.64, 0.6), joined];
    const exploded = explodeMergedRows(lines).filter((entry) => entry.line.text.startsWith('17)') || entry.line.text.startsWith('26)'));
    expect(exploded).toHaveLength(2);
    for (const entry of exploded) expect([entry.line.rect.top, entry.line.rect.bottom]).toEqual([0.6476, 0.6776]);
  });
});

describe('the rows of stacked fractions', () => {
  it('give the numerator that stands between two items to the item it stacks on', () => {
    // The second item is a fraction: its numerator row is read before the line that holds its number, and it lies nearer to
    // the item above than the nearest-line rules allow (the line of the number is narrow, the row is wide).
    const specs: Spec[] = [
      { text: '1) first item', left: 0.143, top: 0.2 },
      { text: 'a numerator above', left: 0.18, top: 0.3, right: 0.26, height: 0.0249 },
      { text: '2) 2', left: 0.143, top: 0.318, right: 0.196, height: 0.0167 },
      { text: 'a a - 2', left: 0.18, top: 0.338, right: 0.26, size: 8, height: 0.0119 },
      { text: 'y12 - xy1 - x22', left: 0.18, top: 0.367, right: 0.28, height: 0.0239 },
      { text: '3) 1', left: 0.143, top: 0.3874, right: 0.196, height: 0.0167 },
      { text: 'y2 - xy + x2', left: 0.18, top: 0.3985, right: 0.28, height: 0.02 },
      { text: '4) last item', left: 0.143, top: 0.46 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    const two = set.proposals.find((entry) => entry.label === '2');
    const three = set.proposals.find((entry) => entry.label === '3');
    expect(two && three).toBeTruthy();
    // The numerator row of item 3 starts at 0.367: item 2 ends above it, item 3 begins at it.
    expect(two?.rect.bottom).toBeLessThanOrEqual(0.367);
    expect(three?.rect.top).toBeLessThanOrEqual(0.367);
    expect(three?.rect.top).toBeGreaterThan(0.35);
    // Item 2 keeps its own numerator and denominator.
    expect(two?.rect.top).toBeLessThanOrEqual(0.3);
    expect(two?.rect.bottom).toBeGreaterThan(0.345);
  });
});

describe('small fragments between two rows', () => {
  it('belong to the row whose text they stand in, even when they overlap it a little less than half', () => {
    // The sign of a root of the second row reaches up between the rows: it overlaps the second row by 0.0052 and the first by nothing.
    const specs: Spec[] = [
      { text: '1) a statement before', left: 0.143, top: 0.19 },
      { text: '2) - 2 - 48v', left: 0.143, top: 0.2195, right: 0.2739, height: 0.0177 },
      { text: 'sqrt', left: 0.2089, top: 0.2384, right: 0.2257, height: 0.0182 },
      { text: '3) - 7 320n', left: 0.143, top: 0.2514, right: 0.2671, height: 0.0178 },
      { text: '4) the next item', left: 0.143, top: 0.31 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    const first = set.proposals.find((entry) => entry.label === '2');
    const second = set.proposals.find((entry) => entry.label === '3');
    expect(first && second).toBeTruthy();
    // Item 2 ends with its own line (0.2372 plus a hair); the root sign is the next item's.
    expect(first?.rect.bottom).toBeLessThan(0.245);
    expect(second?.rect.top).toBeLessThanOrEqual(0.2384);
  });

  it('stay with the item they stack on when ink above touches them: only the coordinates of a figure go by the ink', () => {
    // The numerator of item 2 stands 0.006 above its number and 0.08 under the text of item 1; ink of the line above reaches down to it.
    const specs: Spec[] = [
      { text: '1) first item', left: 0.143, top: 0.2 },
      { text: 'n + 1', left: 0.205, top: 0.296, right: 0.26, height: 0.016 },
      { text: '2) 2', left: 0.143, top: 0.318, right: 0.196, height: 0.0167 },
      { text: '3) third item', left: 0.143, top: 0.36 },
      { text: '4) fourth item', left: 0.143, top: 0.4 },
    ];
    const touching: PageText = { ...page(0, [heading, ...specs]), inkMap: mapWithInk([{ from: 0.25, to: 0.2955, left: 0.2, right: 0.27 }]) };
    const { set } = run([touching]);
    const one = set.proposals.find((entry) => entry.label === '1');
    const two = set.proposals.find((entry) => entry.label === '2');
    expect(one?.rect.bottom).toBeLessThan(0.296);
    expect(two?.rect.top).toBeLessThanOrEqual(0.296);
  });
});

describe('edges that run through the ink of the next line', () => {
  /** Three one-line items; ink that starts at 0.2188 lies where the first item's frame would end (0.2195). */
  function tight(withMap: boolean): PageText {
    const base = page(0, [heading, { text: '1) first item', left: 0.143, top: 0.2 }, { text: '2) second item', left: 0.143, top: 0.24 }, { text: '3) third item', left: 0.143, top: 0.28 }]);
    // The first item's text box ends at 0.2155; its frame would end at 0.2195, in the ink that starts at 0.2188 (the second's glyph).
    return withMap ? { ...base, inkMap: mapWithInk([{ from: 0.2188, to: 0.2215, left: 0.12, right: 0.4 }]) } : base;
  }

  it('end in the white between the lines, below the own text', () => {
    const plain = run([tight(false)]).set.proposals.find((entry) => entry.label === '1');
    const nudged = run([tight(true)]).set.proposals.find((entry) => entry.label === '1');
    expect(plain?.rect.bottom).toBeGreaterThan(0.2188);
    expect(nudged?.rect.bottom).toBeLessThan(0.2188);
    // Never above the own line.
    expect(nudged?.rect.bottom).toBeGreaterThanOrEqual(0.2155);
  });

  it('are left where they are when the white is not within reach', () => {
    const base = tight(false);
    const blocked: PageText = { ...base, inkMap: mapWithInk([{ from: 0.2156, to: 0.226, left: 0.12, right: 0.4 }]) };
    const plain = run([base]).set.proposals.find((entry) => entry.label === '1');
    const held = run([blocked]).set.proposals.find((entry) => entry.label === '1');
    expect(held?.rect.bottom).toBe(plain?.rect.bottom);
  });
});

describe('a heading below an item', () => {
  it('ends the frame of a figure that reaches down over ink: the next chapter is not part of it', () => {
    const specs: Spec[] = [heading];
    for (const [n, top] of [[1, 0.15], [2, 0.18], [3, 0.21], [4, 0.24]] as const) specs.push({ text: `${n}) item ${n} of the set`, left: 0.143, top });
    specs.push({ text: '5)', left: 0.143, top: 0.3 });
    // A heading set larger than the body text, 0.2 below the label, and drawings between the two.
    specs.push({ text: 'Chapter 2', left: 0.143, top: 0.5, size: 20, bold: true });
    const base = page(0, specs);
    const ink = new Array<number>(INK_BANDS).fill(0);
    for (let band = Math.floor(0.32 * INK_BANDS); band < Math.ceil(0.46 * INK_BANDS); band += 1) ink[band] = 0.2;
    for (let band = Math.floor(0.5 * INK_BANDS); band < Math.ceil(0.52 * INK_BANDS); band += 1) ink[band] = 0.3;
    const { set } = run([{ ...base, ink }]);
    const figure = set.proposals.find((entry) => entry.label === '5');
    expect(figure?.layout).toBe('figure');
    // The drawing is inside, the heading is not.
    expect(figure?.rect.bottom).toBeGreaterThan(0.45);
    expect(figure?.rect.bottom).toBeLessThanOrEqual(0.5);
  });
});

describe('figures that stand beside other columns', () => {
  /** Three columns of numbers: the middle one holds figures (the number stands alone, the drawing is ink without text). */
  function figurePage(): PageText {
    const specs: Spec[] = [heading];
    // Left column: text answers down the page, one right below the label of figure 8.
    for (const [n, top] of [[1, 0.2], [2, 0.26], [3, 0.32], [4, 0.38], [5, 0.44], [6, 0.5], [7, 0.56]] as const) specs.push({ text: `${n}) answer ${n} of the left column`, left: 0.143, top });
    // Middle column: labels only; the drawings lie below them.
    for (const [n, top] of [[8, 0.3], [9, 0.42], [10, 0.54]] as const) specs.push({ text: `${n})`, left: 0.392, top });
    // Right column: labels only.
    for (const [n, top] of [[11, 0.38], [12, 0.51]] as const) specs.push({ text: `${n})`, left: 0.64, top });
    const base = page(0, specs);
    // Ink: a drawing under each label of the middle column, from 0.02 below the label to 0.02 above the next one.
    const ink = new Array<number>(INK_BANDS).fill(0);
    for (const [from, to] of [[0.32, 0.4], [0.44, 0.52]] as const) for (let band = Math.floor(from * INK_BANDS); band < Math.ceil(to * INK_BANDS); band += 1) ink[band] = 0.2;
    return { ...base, ink };
  }

  it('reaches over the whole drawing although an item of another column starts right below its label', () => {
    const { set } = run([figurePage()]);
    const figure = set.proposals.find((entry) => entry.label === '9');
    expect(figure?.layout).toBe('figure');
    // The drawing of 9 ends at 0.52; the left column has item 5 at 0.44 and the right column item 12 at 0.51.
    expect(figure?.rect.bottom).toBeGreaterThan(0.5);
    expect(figure?.rect.bottom).toBeLessThan(0.54);
    // It does not reach into the column on the right.
    expect(figure?.rect.right).toBeLessThanOrEqual(0.64);
  });
});

describe('numbers that are not items', () => {
  it('keeps a paragraph line that starts with a number out of the items', () => {
    const specs: Spec[] = [
      { text: '1. A boy is ten years older than his brother. Five years ago the sum of their ages was', left: 0.143, top: 0.2, right: 0.85 },
      { text: '50. How old are they now?', left: 0.176, top: 0.22 },
      { text: '2. A second problem.', left: 0.143, top: 0.26 },
      { text: '3. A third problem.', left: 0.143, top: 0.3 },
      { text: '4. A fourth problem.', left: 0.143, top: 0.34 },
      { text: '5. A fifth problem.', left: 0.143, top: 0.38 },
    ];
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(set.rejected.map((entry) => entry.text)).toEqual(['50. How old are they now?']);
    expect(set.rejected[0]?.reason).toContain('indented');
    // The line belongs to item 1, not to nothing.
    expect(set.proposals[0]?.rect.bottom).toBeGreaterThan(0.22 + HEIGHT - 0.001);
    expect(set.notes.join(' ')).not.toContain('belong to no item');
  });

  it('reads a number printed without its closing mark when the sequence asks for it, and says so', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 8; n += 1) specs.push({ text: n === 5 ? '5 (2)(3) times something' : `${n}) item ${n} text`, left: 0.143, top: 0.2 + n * 0.03 });
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(set.proposals.find((entry) => entry.label === '5')?.confidence).toBeLessThan(0.7);
    expect(set.proposals.find((entry) => entry.label === '5')?.evidence[0]).toContain('closing mark');
    expect(set.notes.join(' ')).toContain('without its closing mark');
  });

  it('reports a gap instead of skipping it, and a duplicate with the one that was used', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 9; n += 1) if (n !== 4) specs.push({ text: `${n}) item ${n}`, left: 0.143, top: 0.2 + n * 0.03 });
    specs.push({ text: '7) a stray second seven', left: 0.143, top: 0.6 });
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.gaps).toEqual(['4']);
    expect(set.duplicates).toEqual(['7']);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '5', '6', '7', '8', '9']);
    expect(set.notes.join(' ')).toContain('no line starts with the number 4');
    expect(set.notes.join(' ')).toContain('printed more than once');
  });

  it('puts a number far from the run aside', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 6; n += 1) specs.push({ text: `${n}) item ${n}`, left: 0.143, top: 0.2 + n * 0.03 });
    specs.push({ text: '45) a number far away', left: 0.143, top: 0.5 });
    const { set } = run([page(0, [heading, ...specs])]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(set.rejected[0]?.reason).toContain('does not belong to the run');
  });
});

describe('instructions', () => {
  const items = (from: number, count: number, top: number): Spec[] => Array.from({ length: count }, (_unused, k) => ({ text: `${from + k}) item ${from + k}`, left: 0.143, top: top + k * 0.03 }));

  it('uses bold lines as instructions and gives each item the one above it', () => {
    const { set } = run([
      page(0, [heading, { text: 'First instruction.', left: 0.143, top: 0.15, bold: true }, ...items(1, 3, 0.2), { text: 'Second instruction.', left: 0.143, top: 0.32, bold: true }, ...items(4, 3, 0.37)]),
    ]);
    expect(set.proposals.map((entry) => entry.context.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(set.instructions.map((entry) => [entry.text, entry.governs])).toEqual([
      ['First instruction.', ['1', '2', '3']],
      ['Second instruction.', ['4', '5', '6']],
    ]);
    const first = set.proposals[0]?.context[0];
    expect(first?.rect.top).toBeLessThan(0.15);
    expect(first?.rect.bottom).toBeGreaterThan(0.15 + HEIGHT);
    // The frame of item 3 stops above the second instruction.
    expect(set.proposals[2]?.rect.bottom).toBeLessThan(0.32);
  });

  it('carries an instruction over the page break and joins its two halves', () => {
    const first = page(0, [heading, ...items(1, 3, 0.2), { text: 'Solve each of the following problems by setting up', left: 0.143, top: 0.86, bold: true }]);
    const second = page(1, [{ text: 'an equation.', left: 0.143, top: 0.1, bold: true }, ...items(4, 4, 0.16)]);
    const { set } = run([first, second]);
    expect(set.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(set.proposals.slice(0, 3).every((entry) => entry.context.length === 0)).toBe(true);
    for (const entry of set.proposals.slice(3)) {
      expect(entry.context.map((region) => region.page)).toEqual([0, 1]);
    }
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).toBe('Solve each of the following problems by setting up an equation.');
    // The items on page 1 are not mistaken for continuations of the instruction.
    expect(set.proposals[3]?.page).toBe(1);
  });

  it('takes the second piece of a long bold instruction that the column detection cut in two', () => {
    const { set } = run([
      page(0, [
        heading,
        { text: 'Write the point-slope form of', left: 0.143, top: 0.15, right: 0.456, bold: true },
        { text: 'the equation of the line through the', left: 0.469, top: 0.15, bold: true },
        { text: 'given points.', left: 0.143, top: 0.168, bold: true },
        ...items(1, 3, 0.22),
      ]),
    ]);
    expect(set.instructions).toHaveLength(1);
    expect(set.instructions[0]?.text).toBe('Write the point-slope form of the equation of the line through the given points.');
    expect(set.proposals[0]?.context[0]?.rect.right).toBeGreaterThan(0.7);
    expect(set.notes.join(' ')).not.toContain('belong to no item');
  });

  it('gives no context to the items of a set that prints no instruction (and no bold line)', () => {
    const { set } = run([page(0, [heading, ...items(1, 5, 0.18)])]);
    expect(set.proposals.every((entry) => entry.context.length === 0)).toBe(true);
    expect(set.instructions).toEqual([]);
  });

  it('finds instructions by their position when the pages carry no font information, and says so', () => {
    const { result, set } = run([page(0, [heading, { text: 'Evaluate each expression.', left: 0.143, top: 0.15 }, ...items(1, 5, 0.2)], false)]);
    expect(set.instructions.map((entry) => entry.text)).toEqual(['Evaluate each expression.']);
    expect(set.proposals.every((entry) => entry.context.length === 1)).toBe(true);
    expect(result.notes.join(' ')).toContain('font information');
  });
});

describe('items that continue on the next page', () => {
  it('continues the item of the column the lines belong to', () => {
    const left = (n: number, top: number): Spec => ({ text: `${n}) item ${n} of the left column`, left: 0.143, top });
    const right = (n: number, top: number): Spec => ({ text: `${n}) item ${n} of the right column`, left: 0.517, top });
    const first = page(0, [heading, { text: 'Solve.', left: 0.143, top: 0.15, bold: true }, left(1, 0.2), right(2, 0.2), left(3, 0.8), right(4, 0.8), { text: 'goes on in the left column, below', left: 0.18, top: 0.818 }, { text: 'and in the right', left: 0.55, top: 0.818 }]);
    const second = page(1, [
      { text: 'the left column has more text', left: 0.18, top: 0.1 },
      { text: 'the right column has more text', left: 0.55, top: 0.1 },
      left(5, 0.2),
      right(6, 0.2),
      left(7, 0.25),
      right(8, 0.25),
    ]);
    const { set } = run([first, second]);
    const byLabel = (label: string) => set.proposals.find((entry) => entry.label === label);
    expect(byLabel('3')?.continues?.map((region) => [region.page, region.rect.left < 0.2])).toEqual([[1, true]]);
    expect(byLabel('4')?.continues?.map((region) => [region.page, region.rect.left > 0.45])).toEqual([[1, true]]);
    expect(byLabel('1')?.continues).toBeUndefined();
    expect(byLabel('5')?.continues).toBeUndefined();
  });
});

describe('numbering that is not the default', () => {
  it('reads labels like A.3 with a pattern of its own and makes a frame id from them', () => {
    const specs: Spec[] = [];
    for (let k = 1; k <= 4; k += 1) specs.push({ text: `3.${k}) statement ${k}`, left: 0.143, top: 0.15 + k * 0.03 });
    const { set } = run([page(0, [heading, ...specs])], { itemPatterns: [{ name: '3.1)', regex: /^(\d+\.\d+)\)\s*(.*)$/ }] });
    // The sequence rule works on whole numbers: 3.1 .. 3.4 all read as 3, so the repeats are reported, not mixed up.
    expect(set.proposals.length).toBeGreaterThanOrEqual(1);
    expect(set.proposals[0]?.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});

describe('operations', () => {
  it('turns a proposal into an add operation of an authoritative exercise', () => {
    const { set } = run([page(0, [heading, { text: 'Solve.', left: 0.143, top: 0.15, bold: true }, { text: '1) first', left: 0.143, top: 0.2 }, { text: '2) second', left: 0.143, top: 0.23 }])]);
    const proposal = set.proposals[0];
    expect(proposal).toBeDefined();
    if (!proposal) return;
    const answer: Region = { page: 5, rect: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.22 } };
    const op = exerciseToOperation(proposal, { solution: [answer] });
    // The frame gets a generated id and is named SECTION:LABEL: the operation carries neither an id nor a ref, and no unit.
    expect(op).toMatchObject({ op: 'add', authority: 'book', label: '1', section: '1.1', page: 0 });
    expect(op).not.toHaveProperty('id');
    expect(op).not.toHaveProperty('ref');
    expect(op).not.toHaveProperty('replace');
    expect(op.rect).toEqual([proposal.rect.left, proposal.rect.top, proposal.rect.right, proposal.rect.bottom]);
    expect(op.context?.[0]?.rect).toHaveLength(4);
    expect(op.solution).toEqual([{ page: 5, rect: [0.1, 0.2, 0.3, 0.22] }]);
    const all = exercisesToOperations(set.proposals);
    expect(all.map((entry) => entry.label)).toEqual(set.proposals.map((entry) => entry.label));
    expect(all.every((entry) => entry.solution === undefined)).toBe(true);
    const keyed = exercisesToOperations(set.proposals, new Map([[bookKey('1.1', '2'), [answer]]]), new Set([bookKey('1.1', '1')]));
    expect(keyed[0]).toMatchObject({ label: '1', replace: true });
    expect(keyed[1]).toMatchObject({ label: '2' });
    expect(keyed[1]?.solution).toHaveLength(1);
    expect(keyed[1]).not.toHaveProperty('replace');
  });

  it('replaces the instruction even when there is none, and the solution only when one was found', () => {
    const { set } = run([page(0, [heading, { text: '1) first', left: 0.143, top: 0.2 }, { text: '2) second', left: 0.143, top: 0.23 }])]);
    const proposal = set.proposals[0];
    expect(proposal?.context).toEqual([]);
    if (!proposal) return;
    const plain = exerciseToOperation(proposal);
    expect(plain).not.toHaveProperty('context');
    const replacing = exerciseToOperation(proposal, { replace: true });
    expect(replacing).toMatchObject({ replace: true, context: [] });
    expect(replacing).not.toHaveProperty('solution');
  });

  it('names the exercise of a solution.set by SECTION:LABEL', () => {
    const op = solutionToOperation('1.1:5', [{ page: 3, rect: { left: 0.1, top: 0.2, right: 0.4, bottom: 0.25 } }]);
    expect(op).toEqual({ op: 'solution.set', id: '1.1:5', regions: [{ page: 3, rect: [0.1, 0.2, 0.4, 0.25] }] });
  });

  describe('comparing a proposal with the frame the project has', () => {
    const { set } = run([page(0, [heading, { text: 'Solve.', left: 0.143, top: 0.15, bold: true }, { text: '1) first', left: 0.143, top: 0.2 }, { text: '2) second', left: 0.143, top: 0.23 }])]);
    const proposal = set.proposals[0] as (typeof set.proposals)[number];
    const answer: Region = { page: 5, rect: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.22 } };
    const stored = (changes: Partial<Frame> = {}): Frame => ({
      id: 'f1',
      kind: 'exercise',
      page: proposal.page,
      // A stored rectangle is rounded to five digits.
      rect: { left: Math.round(proposal.rect.left * 1e5) / 1e5, top: Math.round(proposal.rect.top * 1e5) / 1e5, right: Math.round(proposal.rect.right * 1e5) / 1e5, bottom: Math.round(proposal.rect.bottom * 1e5) / 1e5 },
      authority: 'book',
      label: proposal.label,
      section: proposal.section,
      ...(proposal.context.length > 0 ? { context: proposal.context } : {}),
      ...changes,
    });

    it('calls the same frame unchanged, with or without an answer to compare', () => {
      expect(compareWithProposal(stored(), proposal)).toBe('unchanged');
      expect(compareWithProposal(stored({ solution: [answer] }), proposal, [answer])).toBe('unchanged');
      // An answer that was not proposed does not make a frame differ.
      expect(compareWithProposal(stored({ solution: [answer] }), proposal)).toBe('unchanged');
    });

    it('asks for the answer when the frame has none, and calls a different answer changed', () => {
      expect(compareWithProposal(stored(), proposal, [answer])).toBe('needs-solution');
      expect(compareSolution(stored(), [answer])).toBe('needs-solution');
      expect(compareWithProposal(stored({ solution: [{ page: 5, rect: { left: 0.1, top: 0.4, right: 0.3, bottom: 0.42 } }] }), proposal, [answer])).toBe('changed');
    });

    it('calls a frame changed when the rectangle, the page, the continuation or the instruction differ', () => {
      expect(compareWithProposal(stored({ rect: { ...proposal.rect, bottom: proposal.rect.bottom + 0.02 } }), proposal)).toBe('changed');
      expect(compareWithProposal(stored({ page: proposal.page + 1 }), proposal)).toBe('changed');
      expect(compareWithProposal(stored({ continues: [answer] }), proposal)).toBe('changed');
      expect(compareWithProposal(stored({ context: [answer] }), proposal)).toBe('changed');
    });

    it('compares a rectangle below the minimum size with what the project stores for it (enlarged)', () => {
      const thin = { ...proposal, rect: { left: 0.2, top: 0.3, right: 0.5, bottom: 0.304 } };
      const enlarged = stored({ rect: roundRect(enlargeToMinimum(thin.rect)), context: thin.context });
      expect(compareWithProposal(enlarged, thin)).toBe('unchanged');
    });
  });
});

describe('sections that the project already has', () => {
  it('finds the practice set of a section without a numbered label by the heading "Exercises" inside it', () => {
    const lesson = page(0, [{ text: 'Sets', left: 0.33, top: 0.1, size: 16.9, bold: true }, { text: 'A set is a collection of things that are different from each other.', left: 0.143, top: 0.2 }, { text: 'Example 1.', left: 0.143, top: 0.3, bold: true }, { text: 'Some more text in the lesson to make it a page of body text lines.', left: 0.143, top: 0.35 }]);
    const exercises = page(1, [
      { text: 'Exercises', left: 0.36, top: 0.1, size: 16.9, bold: true },
      { text: 'Decide which are sets.', left: 0.143, top: 0.15, bold: true },
      { text: '1) the numbers 1, 2, 3', left: 0.143, top: 0.2 },
      { text: '2) the tall people', left: 0.143, top: 0.23 },
      { text: '3) the letters of a word', left: 0.143, top: 0.26 },
    ]);
    const next = page(2, [{ text: 'Maps', left: 0.33, top: 0.1, size: 16.9, bold: true }, { text: 'A map sends each element of a set to one element of another set.', left: 0.143, top: 0.2 }]);
    const pages = [lesson, exercises, next];
    const located = locateSections(pages, [
      { title: 'Sets', page: 0, depth: 1, id: 's1' },
      { title: 'Maps', page: 2, depth: 1, id: 's2' },
    ]);
    const sets = located.entries.find((entry) => entry.id === 's1');
    expect(sets?.kind).toBe('section');
    expect(sets?.practice?.page).toBe(1);
    expect(sets?.practice?.end.page).toBe(2);
    expect(located.entries.find((entry) => entry.id === 's2')?.practice).toBeUndefined();
    expect(located.notes.join(' ')).toContain('s2: no practice heading found');
    const result = proposeExercises(pages, located.entries);
    expect(result.sections.find((entry) => entry.section === 's1')?.proposals.map((entry) => entry.label)).toEqual(['1', '2', '3']);
    expect(result.sections.find((entry) => entry.section === 's1')?.proposals[0]?.context.length).toBe(1);
    expect(result.sections.find((entry) => entry.section === 's1')?.proposals[0]?.id).toBe('xs1-1');
  });
});

describe('the labels of a graph under its ink', () => {
  /** Four graphs, one under the other, each a number that stands alone with the coordinates of the graph; the lowest label of the first one (0.30) is further from the text above it than from the number below. */
  function graphs(withInk: boolean): PageText {
    const specs: Spec[] = [heading];
    for (const [n, top] of [[1, 0.2], [2, 0.325], [3, 0.45], [4, 0.575]] as const) {
      specs.push({ text: `${n})`, left: 0.143, top });
      specs.push({ text: '(0,10)', left: 0.169, top: top + 0.02 });
      specs.push({ text: '(1,0) (5,0)', left: 0.189, top: top + 0.045, right: 0.25 });
      specs.push({ text: '(3,-8)', left: 0.254, top: top + 0.1, height: 0.0142 });
    }
    const base = page(0, specs);
    // The ink of each graph goes down to the coordinates under it (the first to 0.2985, touching the line at 0.30).
    const tops = [0.2, 0.325, 0.45, 0.575];
    return withInk ? { ...base, inkMap: mapWithInk(tops.map((top) => ({ from: top + 0.015, to: top + 0.0985, left: 0.165, right: 0.26 }))) } : base;
  }

  it('belong to the graph above them when the ink of the graph reaches them, not to the number below', () => {
    const plain = run([graphs(false)]).set.proposals.find((entry) => entry.label === '1');
    const inked = run([graphs(true)]).set.proposals.find((entry) => entry.label === '1');
    // Without the ink the label under the graph goes to the number under it: the frame of the first graph ends above it.
    expect(plain?.rect.bottom).toBeLessThan(0.3);
    // With it the label is the graph's, and the frame ends under it (0.3142, a hair of padding).
    expect(inked?.rect.bottom).toBeGreaterThan(0.3142);
    expect(inked?.rect.bottom).toBeLessThan(0.325);
  });

  it('leave the next graph its own coordinates, and every graph all of its own', () => {
    const inked = run([graphs(true)]).set;
    for (const [label, top] of [['1', 0.2], ['2', 0.325], ['3', 0.45], ['4', 0.575]] as const) {
      const found = inked.proposals.find((entry) => entry.label === label);
      expect(found?.rect.top).toBeLessThanOrEqual(top);
      expect(found?.rect.bottom).toBeGreaterThan(top + 0.1 + 0.0142);
      if (label !== '4') expect(found?.rect.bottom).toBeLessThan(top + 0.125);
    }
    const second = inked.proposals.find((entry) => entry.label === '2');
    expect(second?.rect.top).toBeGreaterThan(0.3142);
  });
});

describe('rows of items that stand wherever the text before them ends', () => {
  /** Three rows of four items in four columns (left 0.13, 0.33, 0.52, 0.72); the fourth row has 13 at the first column and 14, 15 further right than any column. */
  function flow(withFlow: boolean): Spec[] {
    const lefts = [0.13, 0.33, 0.52, 0.72];
    const specs: Spec[] = [];
    for (let k = 0; k < 12; k += 1) specs.push({ text: `${k + 1}) item ${k + 1}`, left: lefts[k % 4] as number, top: 0.2 + Math.floor(k / 4) * 0.035, right: (lefts[k % 4] as number) + 0.09 });
    specs.push({ text: '13) item 13', left: 0.13, top: 0.31, right: 0.22 });
    specs.push({ text: withFlow ? '14) a long expression' : '14) item 14', left: withFlow ? 0.39 : 0.33, top: 0.31, right: withFlow ? 0.5 : 0.42 });
    // (In the grid, 15 stands in its column and its text reaches to 0.69, right up to the left edge of the next column.)
    specs.push({ text: withFlow ? '15)' : '15) item 15 with a long text', left: withFlow ? 0.65 : 0.52, top: 0.31, right: withFlow ? 0.6725 : 0.69 });
    // The expression of 15 goes on at the left edge of the last column, right under 12.
    specs.push({ text: '( a + b) 2 + ( c + d) 2', left: 0.701, top: 0.31, right: 0.86 });
    specs.push({ text: '16) item 16', left: 0.13, top: 0.35, right: 0.22 });
    return specs;
  }

  it('give the text that goes on after the number to that item, not to the item above it in the next column', () => {
    const { set } = run([page(0, [heading, ...flow(true)])]);
    const fifteen = set.proposals.find((entry) => entry.label === '15');
    const twelve = set.proposals.find((entry) => entry.label === '12');
    expect(fifteen?.rect.right).toBeGreaterThan(0.85);
    expect(twelve?.rect.bottom).toBeLessThan(0.3);
  });

  it('leave the text at the left edge of a column to the item above when the row has its items in the columns', () => {
    // The same text, with 15 in its column and its text reaching up to the fourth column: what stands at the left edge of that column under 12 goes on from 12.
    const { set } = run([page(0, [heading, ...flow(false)])]);
    const twelve = set.proposals.find((entry) => entry.label === '12');
    expect(twelve?.rect.bottom).toBeGreaterThan(0.31);
  });
});

describe('the labels of a figure in the right half of the page', () => {
  /** Item 2 is a figure in the second column at the top; item 3 runs over both columns lower down and has a figure in the right half. */
  function page2(): Spec[] {
    return [
      { text: '1) the first item has a statement', left: 0.143, top: 0.2, right: 0.45 },
      { text: '2)', left: 0.517, top: 0.2, right: 0.54 },
      { text: 'A', left: 0.6, top: 0.22, right: 0.62 },
      { text: 'B', left: 0.7, top: 0.24, right: 0.72 },
      { text: '3) a statement that runs over both columns of the page, long', left: 0.143, top: 0.6, right: 0.86 },
      { text: 'C', left: 0.6, top: 0.64, right: 0.62 },
      { text: 'D', left: 0.7, top: 0.66, right: 0.72 },
      { text: '4) the last item', left: 0.143, top: 0.8, right: 0.4 },
    ];
  }

  it('belong to the item that runs over them, not to the figure of the column far above', () => {
    const { set } = run([page(0, [heading, ...page2()])]);
    const two = set.proposals.find((entry) => entry.label === '2');
    const three = set.proposals.find((entry) => entry.label === '3');
    // The labels C and D are the third item's: its frame reaches over them, and the figure above ends with its own labels.
    expect(three?.rect.bottom).toBeGreaterThan(0.675);
    expect(two?.rect.bottom).toBeLessThan(0.3);
  });

  it('stay with the figure when they are within a quarter of the page of it, though an item runs over them', () => {
    const specs = page2().map((spec) => (spec.text === 'C' ? { ...spec, top: 0.45 } : spec.text === 'D' ? { ...spec, top: 0.47 } : spec.text.startsWith('3)') ? { ...spec, top: 0.35 } : spec));
    const { set } = run([page(0, [heading, ...specs])]);
    const two = set.proposals.find((entry) => entry.label === '2');
    expect(two?.rect.bottom).toBeGreaterThan(0.48);
  });

  it('are not given to an item that starts above the figure', () => {
    // The first item runs over both columns, from above the figure, and over the labels (at the far right, where no label of the figure stands);
    // the third is a short line: only the figure is left for them.
    const specs = page2().map((spec) => (spec.text.startsWith('1)') ? { ...spec, top: 0.15, right: 0.86 } : spec.text.startsWith('3)') ? { ...spec, right: 0.45 } : spec.text === 'C' ? { ...spec, left: 0.8, right: 0.82 } : spec.text === 'D' ? { ...spec, left: 0.82, right: 0.84 } : spec));
    const { set } = run([page(0, [heading, ...specs])]);
    const two = set.proposals.find((entry) => entry.label === '2');
    expect(two?.rect.bottom).toBeGreaterThan(0.67);
  });

  it('stay with the figure when no item runs over them', () => {
    // The third item is a short line of the first column: nothing of it is over the labels at the right.
    const specs = page2().map((spec) => (spec.text.startsWith('3)') ? { ...spec, right: 0.45 } : spec));
    const { set } = run([page(0, [heading, ...specs])]);
    const two = set.proposals.find((entry) => entry.label === '2');
    expect(two?.rect.bottom).toBeGreaterThan(0.67);
  });
});

describe('a paragraph under a row of short items that introduces a graph and the exercises under it', () => {
  function rows(): Spec[] {
    const lefts = [0.13, 0.33, 0.52, 0.72];
    const specs: Spec[] = [];
    for (let k = 0; k < 8; k += 1) specs.push({ text: `${78 + k}) (f + g)(${k})`, left: lefts[k % 4] as number, top: 0.3 + Math.floor(k / 4) * 0.04, right: (lefts[k % 4] as number) + 0.1 });
    specs.push({ text: 'The chart below shows the weight w of a sunflower as a function of its age d in days.', left: 0.118, top: 0.41, right: 0.88 });
    specs.push({ text: 'Use it for the questions in Exercises 86 - 87.', left: 0.118, top: 0.4255, right: 0.55 });
    specs.push({ text: 'y', left: 0.445, top: 0.45, right: 0.452 });
    specs.push({ text: '8', left: 0.418, top: 0.47, right: 0.425 });
    specs.push({ text: '5 10 15 20 D', left: 0.458, top: 0.6, right: 0.56 });
    specs.push({ text: '86) Find and interpret w(0).', left: 0.131, top: 0.65, right: 0.4 });
    specs.push({ text: '87) How heavy is it at 10?', left: 0.131, top: 0.68, right: 0.4 });
    return specs;
  }

  it('is no second line of an item of the row, and nothing under it is a label of a figure of the row (also where no instruction is read)', () => {
    const { set } = run([page(0, [heading, ...rows()])], { instructions: 'none' });
    for (const label of ['82', '83', '84', '85']) {
      const found = set.proposals.find((entry) => entry.label === label);
      expect(found?.rect.bottom).toBeLessThan(0.405);
    }
  });

  it('is the second line of the item above it under a row of three, or when it runs over one column only (the rules for the paragraph are for rows of four and lines over two columns)', () => {
    const three = rows().filter((spec) => !spec.text.startsWith('85)'));
    const threeRow = run([page(0, [heading, ...three])], { instructions: 'none' }).set.proposals.find((entry) => entry.label === '82');
    expect(threeRow?.rect.bottom).toBeGreaterThan(0.41);
    const narrow = rows().map((spec) => (spec.text.startsWith('The chart below') ? { ...spec, right: 0.4 } : spec));
    const oneColumn = run([page(0, [heading, ...narrow])], { instructions: 'none' }).set.proposals.find((entry) => entry.label === '82');
    expect(oneColumn?.rect.bottom).toBeGreaterThan(0.41);
  });

  it('is the instruction of the exercises it names, though the numbers stand in its second line', () => {
    const { set } = run([page(0, [heading, ...rows()])]);
    for (const label of ['86', '87']) {
      const found = set.proposals.find((entry) => entry.label === label);
      expect(found?.context).toHaveLength(1);
      expect(found?.context[0]?.rect.top).toBeLessThan(0.415);
      expect(found?.context[0]?.rect.bottom).toBeGreaterThan(0.435);
    }
  });
});

describe('the caption of the figure under an instruction', () => {
  function figureFirst(caption: string): Spec[] {
    return [
      { text: '1) item before', left: 0.143, top: 0.2 },
      { text: 'The full plot of y = g(x) is shown below. In Exercises 3 - 4, use it and the shifting rule to', left: 0.118, top: 0.28, right: 0.88 },
      { text: 'sketch every shifted copy of it.', left: 0.118, top: 0.2955, right: 0.45 },
      { text: 'y', left: 0.5, top: 0.33, right: 0.507 },
      { text: '4', left: 0.484, top: 0.36, right: 0.491 },
      { text: caption, left: 0.118, top: 0.5, right: 0.4, bold: true },
      { text: '3) y = f(x) + 1', left: 0.143, top: 0.55, right: 0.3 },
      { text: '4) y = f(x) + 2', left: 0.143, top: 0.58, right: 0.3 },
      { text: '5) y = f(x) + 3', left: 0.143, top: 0.61, right: 0.3 },
    ];
  }

  it('belongs to the paragraph above it that names the same exercises: one instruction, over the figure', () => {
    const { set } = run([page(0, [heading, { text: '2) item two', left: 0.143, top: 0.23 }, ...figureFirst('The plot for Ex. 3 - 4')])]);
    for (const label of ['3', '4']) {
      const found = set.proposals.find((entry) => entry.label === label);
      expect(found?.context).toHaveLength(1);
      // From the paragraph (0.28) to the caption (0.5): the graph between is part of it.
      expect(found?.context[0]?.rect.top).toBeLessThan(0.285);
      expect(found?.context[0]?.rect.bottom).toBeGreaterThan(0.51);
    }
  });

  it('is an instruction of its own when an item stands between the paragraph and it', () => {
    const specs = figureFirst('The plot for Ex. 3 - 4').filter((spec) => !spec.text.startsWith('3)'));
    specs.push({ text: '3) y = f(x) + 1', left: 0.143, top: 0.4, right: 0.3 });
    const { set } = run([page(0, [heading, { text: '2) item two', left: 0.143, top: 0.23 }, ...specs])]);
    const three = set.proposals.find((entry) => entry.label === '3');
    // The paragraph alone is its instruction; the caption under the item is the instruction of 4.
    expect(three?.context[0]?.rect.bottom).toBeLessThan(0.4);
    const four = set.proposals.find((entry) => entry.label === '4');
    expect(four?.context[0]?.rect.top ?? 0).toBeGreaterThan(0.45);
  });

  it('is an instruction of its own when it names other exercises than the paragraph does', () => {
    const { set } = run([page(0, [heading, { text: '2) item two', left: 0.143, top: 0.23 }, ...figureFirst('The plot for Ex. 5 - 6')])]);
    const found = set.proposals.find((entry) => entry.label === '3');
    expect(found?.context[0]?.rect.top ?? 0).toBeGreaterThan(0.4);
  });
});
