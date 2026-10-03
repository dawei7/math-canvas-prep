import { describe, expect, it } from 'vitest';
import { lineStart, linesInRect, snapDivider, snapRectToLines } from '../src/geometry/snap.js';
import type { TextLine } from '../src/model/types.js';
import { detectParts, keptDividers } from '../src/propose/parts.js';
import { rect } from './helpers.js';

/** A line of 0.012 height whose top is `top`. */
function line(text: string, top: number, left = 0.1, right = 0.9, height = 0.012): TextLine {
  return { text, rect: rect(left, top, right, top + height), fontSize: 11, column: 0, chars: text.replace(/\s/g, '').length };
}

describe('snapping to text lines', () => {
  const lines = [line('one', 0.1), line('two', 0.12), line('three', 0.14), line('four', 0.16)];

  it('takes a line whole when most of it is inside the frame and leaves it out when most is outside', () => {
    // The top edge cuts line "two" (0.12..0.132) at 0.1255: 54% of it is inside, so it is taken whole.
    const takenWhole = snapRectToLines(rect(0.1, 0.1255, 0.9, 0.3), lines);
    expect(takenWhole.rect.top).toBeCloseTo(0.12 - 0.006);
    expect(takenWhole.changes[0]).toMatchObject({ edge: 'top', how: 'whole' });
    // At 0.1285 only 29% is inside: the line is left out, the edge moves to its bottom.
    const leftOut = snapRectToLines(rect(0.1, 0.1285, 0.9, 0.3), lines);
    expect(leftOut.rect.top).toBeGreaterThanOrEqual(0.132 - 1e-9);
    expect(leftOut.changes[0]).toMatchObject({ edge: 'top', how: 'out' });
  });

  it('does the same for the bottom edge', () => {
    // The bottom edge at 0.1 + 0.0075 cuts line one (0.1..0.112) with 62% inside: taken whole.
    const whole = snapRectToLines(rect(0.05, 0.05, 0.9, 0.1075), lines);
    expect(whole.rect.bottom).toBeCloseTo(0.112 + 0.004);
    // At 0.1035 only 29% of line one is inside: left out, so the bottom moves above it.
    const out = snapRectToLines(rect(0.05, 0.05, 0.9, 0.1035), lines);
    expect(out.rect.bottom).toBeLessThanOrEqual(0.1);
  });

  it('leaves edges that sit between lines alone', () => {
    const result = snapRectToLines(rect(0.1, 0.1135, 0.9, 0.1195), lines);
    expect(result.changes).toEqual([]);
    expect(result.rect).toEqual(rect(0.1, 0.1135, 0.9, 0.1195));
  });

  it('ignores lines beside the frame (another column)', () => {
    const other = [line('right column', 0.1, 0.6, 0.95)];
    const result = snapRectToLines(rect(0.05, 0.105, 0.5, 0.3), other);
    expect(result.changes).toEqual([]);
  });

  it('returns the original when snapping would leave less than a minimum piece', () => {
    // The top edge leaves line two out (29% inside, so it moves to 0.132) and the bottom edge leaves line three out
    // (12% inside, so it moves to 0.136): 0.004 would be left, less than a minimum piece.
    const result = snapRectToLines(rect(0.1, 0.1285, 0.9, 0.1415), lines);
    expect(result.rect).toEqual(rect(0.1, 0.1285, 0.9, 0.1415));
    expect(result.changes).toEqual([]);
  });

  it('moves a divider onto the start of the nearest line within 0.03 and no further', () => {
    expect(snapDivider(0.12, lines)).toBeCloseTo(0.12 - 0.006);
    expect(snapDivider(0.5, lines)).toBe(0.5);
    expect(snapDivider(0.2, [])).toBe(0.2);
    expect(lineStart(line('x', 0.002))).toBe(0);
  });

  it('never starts a part inside the line above it: the start sits at the bottom of that line when it is closer than the padding', () => {
    // Lines 0.012 tall and 0.014 apart leave a gap of 0.002, less than the padding of 0.006.
    const tight = [line('(a) first', 0.2), line('(b) second', 0.214)];
    expect(lineStart(tight[1] as TextLine)).toBeCloseTo(0.214 - 0.006);
    expect(lineStart(tight[1] as TextLine, 0.006, tight)).toBeCloseTo(0.212);
    expect(snapDivider(0.215, tight)).toBeCloseTo(0.212);
    const far = [line('(a) first', 0.2), line('(b) second', 0.25)];
    expect(lineStart(far[1] as TextLine, 0.006, far)).toBeCloseTo(0.244);
    // A line in another column does not count.
    const other = [line('left', 0.2, 0.1, 0.4), line('right', 0.214, 0.6, 0.9)];
    expect(lineStart(other[1] as TextLine, 0.006, other)).toBeCloseTo(0.208);
  });

  it('lists the lines of a rect: beside it and at least half inside', () => {
    const inside = linesInRect(lines, rect(0.1, 0.119, 0.9, 0.151));
    expect(inside.map((entry) => entry.text)).toEqual(['two', 'three']);
    expect(linesInRect(lines, rect(0.1, 0.1255, 0.9, 0.2)).map((entry) => entry.text)).toEqual(['two', 'three', 'four']);
  });
});

describe('part markers (the idea of the app splitter)', () => {
  const at = (texts: string[], first = 0.2, step = 0.02): TextLine[] => texts.map((text, index) => line(text, first + index * step));

  it('finds (a) (b) (c) and gives the dividers before (b) and (c), the first part starting at (a)', () => {
    const lines = at(['Exercise 2. Let f be a function.', '(a) Compute f(1).', '(b) Compute f(2).', '(c) Compute f(3).']);
    const found = detectParts(lines);
    expect(found?.style).toBe('letter');
    expect(found?.markers.map((marker) => marker.ordinal)).toEqual([1, 2, 3]);
    expect(found?.dividers[0]).toBeCloseTo(0.24 - 0.006);
    expect(found?.dividers[1]).toBeCloseTo(0.26 - 0.006);
    expect(found?.firstStart).toBeCloseTo(0.22 - 0.006);
  });

  it('understands a) a. (i) i) 1) and 3.1 styles', () => {
    expect(detectParts(at(['a) One', 'b) Two']))?.style).toBe('letter');
    expect(detectParts(at(['a. One', 'b. Two']))?.style).toBe('letter-dot');
    expect(detectParts(at(['(i) One', '(ii) Two', '(iii) Three']))?.style).toBe('roman');
    expect(detectParts(at(['(1) One', '(2) Two']))?.style).toBe('number');
    expect(detectParts(at(['1) One', '2) Two']))?.style).toBe('number');
    expect(detectParts(at(['1. One', '2. Two', '3. Three']))?.style).toBe('number-dot');
    expect(detectParts(at(['3.1 Differentiate f', '3.2 Integrate f']))?.style).toBe('dotted');
  });

  it('needs at least two markers that count up by one', () => {
    expect(detectParts(at(['(a) lonely', 'plain text']))).toBeUndefined();
    expect(detectParts(at(['(a) one', '(c) three']))).toBeUndefined();
    expect(detectParts(at(['(b) two', '(a) one']))).toBeUndefined();
    expect(detectParts([])).toBeUndefined();
  });

  it('prefers the longer run and, on a tie, the style with higher priority', () => {
    const mixed = at(['(a) one', '(b) two', '(c) three', '1. x', '2. y']);
    expect(detectParts(mixed)?.style).toBe('letter');
    // "(i)" is both the letter i and the roman numeral one; with the same run length the letter style wins.
    const tie = detectParts(at(['(i) one', '(ii) two']));
    expect(tie?.style).toBe('roman');
  });

  it('treats a run that does not begin at the first ordinal as parts that all start a new piece', () => {
    const found = detectParts(at(['Compute (a) f(1).', '(b) Compute f(2).', '(c) Compute f(3).']));
    expect(found?.markers.map((marker) => marker.ordinal)).toEqual([2, 3]);
    expect(found?.dividers).toHaveLength(2);
    expect(found?.firstStart).toBeUndefined();
  });

  it('does not take a stray letter in a sentence', () => {
    expect(detectParts(at(['The set (a) is open.', 'Another line.', 'And (b) is closed.']))).toBeUndefined();
  });

  it('drops dividers that would leave a sliver', () => {
    const area = rect(0.1, 0.2, 0.9, 0.5);
    expect(keptDividers(area, [0.3, 0.305, 0.4, 0.495])).toEqual([0.3, 0.4]);
    expect(keptDividers(area, [0.1, 0.6])).toEqual([]);
    expect(keptDividers(area, [])).toEqual([]);
  });
});
