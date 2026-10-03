import { describe, expect, it } from 'vitest';
import { findHeaderFooterKeys, groupTextLines, headerKey, markHeaderFooter, type RawTextItem } from '../src/pdf/lines.js';
import type { PageText } from '../src/model/types.js';

const page = { width: 600, height: 800, rotation: 0 };

function item(text: string, left: number, baseline: number, fontSize = 10, width?: number): RawTextItem {
  return { text, left, right: left + (width ?? text.length * fontSize * 0.5), baseline, fontSize, ascent: 0.8, descent: -0.2 };
}

describe('grouping text runs into lines', () => {
  it('joins runs on one baseline with spaces only where there is a gap', () => {
    const { lines } = groupTextLines([item('Exercise', 72, 100, 10, 40), item('1.', 116, 100, 10, 10), item('Compute', 130, 100, 10, 35), item('f', 167, 100, 10, 5), item('(x)', 172.2, 100, 10, 15)], page);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Exercise 1. Compute f(x)');
  });

  it('keeps superscripts and subscripts with their line', () => {
    const { lines } = groupTextLines([item('x', 72, 100), item('2', 77, 96, 7), item(' + y', 80.5, 100), item('i', 91, 103, 7)], page);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('x2 + yi');
  });

  it('keeps consecutive lines apart and orders them top to bottom', () => {
    const { lines } = groupTextLines([item('second', 72, 130), item('first', 72, 100), item('third', 72, 160)], page);
    expect(lines.map((line) => line.text)).toEqual(['first', 'second', 'third']);
  });

  it('expresses boxes as fractions of the displayed page', () => {
    const { lines } = groupTextLines([item('hello', 60, 400, 10, 30)], page);
    const box = lines[0]?.rect;
    expect(box?.left).toBeCloseTo(0.1);
    expect(box?.right).toBeCloseTo(0.15);
    expect(box?.top).toBeCloseTo((400 - 8) / 800);
    expect(box?.bottom).toBeCloseTo((400 + 2) / 800);
    expect(lines[0]?.fontSize).toBe(10);
  });

  it('merges the rows of a fraction into one line', () => {
    // Numerator, bar row and denominator overlap vertically by about a quarter.
    const rows = [item('a+b', 120, 93.2, 10, 20), item('x =', 100, 100, 10, 14), item('c', 126, 106.9, 10, 5)];
    const { lines } = groupTextLines(rows, page);
    expect(lines).toHaveLength(1);
  });

  it('splits a row at a wide gap (an equation number at the right margin)', () => {
    const { lines } = groupTextLines([item('x = 1', 100, 200, 10, 25), item('(1)', 520, 200, 10, 15)], page);
    expect(lines.map((line) => line.text)).toEqual(['x = 1', '(1)']);
  });

  it('ignores empty runs and runs without a font size', () => {
    const { lines } = groupTextLines([item('', 10, 10), item('   ', 10, 10), { ...item('x', 10, 10), fontSize: 0 }], page);
    expect(lines).toEqual([]);
  });

  it('finds two columns and reads the left one first', () => {
    const items: RawTextItem[] = [];
    for (let row = 0; row < 12; row += 1) {
      items.push(item(`left column line ${row}`, 60, 100 + row * 14, 10, 200));
      items.push(item(`right column line ${row}`, 320, 100 + row * 14, 10, 210));
    }
    const result = groupTextLines(items, page);
    expect(result.columns).toBe(2);
    expect(result.gutter).toBeGreaterThan(0.4);
    expect(result.gutter).toBeLessThan(0.6);
    expect(result.lines.slice(0, 12).every((line) => line.text.startsWith('left') && line.column === 0)).toBe(true);
    expect(result.lines.slice(12).every((line) => line.text.startsWith('right') && line.column === 1)).toBe(true);
  });

  it('keeps a full-width title above two columns in front of both', () => {
    const items: RawTextItem[] = [item('A title across the whole page width of the paper', 60, 60, 16, 480)];
    for (let row = 0; row < 10; row += 1) {
      items.push(item(`left ${row}`, 60, 100 + row * 14, 10, 200));
      items.push(item(`right ${row}`, 320, 100 + row * 14, 10, 210));
    }
    const result = groupTextLines(items, page);
    expect(result.columns).toBe(2);
    expect(result.lines[0]?.text).toContain('A title');
    expect(result.lines[1]?.text).toBe('left 0');
  });

  it('does not invent columns on a single-column page with indented lines', () => {
    const items: RawTextItem[] = [];
    for (let row = 0; row < 14; row += 1) items.push(item(`a paragraph line number ${row} of text`, row % 3 === 0 ? 90 : 72, 100 + row * 14, 10, 400));
    expect(groupTextLines(items, page).columns).toBe(1);
  });
});

describe('running headers and footers', () => {
  const pageWith = (number: number, header: string, footer: string, body: string): PageText => ({
    page: number,
    size: page,
    columns: 1,
    hasText: true,
    lines: [
      { text: header, rect: { left: 0.1, top: 0.03, right: 0.5, bottom: 0.045 }, fontSize: 9, column: 0, chars: header.length },
      { text: body, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.315 }, fontSize: 11, column: 0, chars: body.length },
      { text: footer, rect: { left: 0.45, top: 0.95, right: 0.55, bottom: 0.96 }, fontSize: 9, column: 0, chars: footer.length },
    ],
  });

  it('blurs digits in the key', () => {
    expect(headerKey('Page 3 of 9')).toBe(headerKey('Page 4 of 9'));
    expect(headerKey('Chapter 1')).not.toBe(headerKey('Chapter A'));
  });

  it('marks lines that repeat in the top or bottom band of several pages', () => {
    const pages = [1, 2, 3, 4].map((n) => pageWith(n, 'Analysis I', `Page ${n}`, `body text of page ${n}`));
    const keys = findHeaderFooterKeys(pages);
    expect(keys.has(headerKey('Analysis I'))).toBe(true);
    expect(keys.has(headerKey('Page 1'))).toBe(true);
    expect(keys.has(headerKey('body text of page 1'))).toBe(false);
    const marked = markHeaderFooter(pages[0] as PageText, keys);
    expect(marked.lines.map((line) => line.headerFooter === true)).toEqual([true, false, true]);
  });

  it('does not mark a line that appears once, or a body line that repeats', () => {
    const pages = [pageWith(1, 'Unique title', 'Page 1', 'same body'), pageWith(2, 'Other header', 'Page 2', 'same body'), pageWith(3, 'Third header', 'Page 3', 'same body')];
    const keys = findHeaderFooterKeys(pages);
    expect(keys.has(headerKey('Unique title'))).toBe(false);
    expect(keys.has(headerKey('same body'))).toBe(false);
  });
});
