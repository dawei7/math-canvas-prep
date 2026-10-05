import { describe, expect, it } from 'vitest';
import { readPageNumbers } from '../src/audit/pagenumbers.js';
import { parseToc } from '../src/audit/toc.js';
import type { PageText } from '../src/model/types.js';
import { page, type Spec } from './audit-pages.js';

/**
 * The printed contents and the printed page numbers of a book whose layout is not the one the tool was made on: chapter lines
 * with and without the chapter word, a contents that goes on over a second page, page numbers in the running head. Pages are
 * built by hand and every text is made up.
 */

const heading = (text: string, top: number, size = 14, left = 0.12): Spec => ({ text, left, top, size, bold: true });
const entry = (text: string, top: number): Spec => ({ text, left: 0.12, top });
const summary = (pages: PageText[], words = ['chapter']): string[] => parseToc(pages, readPageNumbers(pages), { chapterWords: words }).entries.map((found) => `${found.kind} ${found.number ?? ''} ${found.title}`.replace(/\s+/g, ' '));

describe('the printed contents', () => {
  it('reads chapter lines with the chapter word, and a contents that goes on over a second page without a heading of its own', () => {
    const pages = [
      page(0, [heading('Contents', 0.08, 17), entry('Chapter 1 Triangles ........ 5', 0.14), entry('1.1 Angles ........ 6', 0.17), entry('1.2 Sides ........ 12', 0.2), entry('Chapter 2 Circles ........ 20', 0.23), entry('2.1 Arcs ........ 21', 0.26)]),
      page(1, [entry('2.2 Chords ........ 28', 0.1), entry('2.3 Areas ........ 33', 0.13)]),
    ];
    expect(summary(pages)).toEqual(['chapter 1 Triangles', 'section 1.1 Angles', 'section 1.2 Sides', 'chapter 2 Circles', 'section 2.1 Arcs', 'section 2.2 Chords', 'section 2.3 Areas']);
    expect(parseToc(pages, readPageNumbers(pages), { chapterWords: ['chapter'] }).tocPages).toEqual([0, 1]);
  });

  it('reads a chapter line that is a number and a title ("1 Triangles") when the sections that follow it carry its number', () => {
    const pages = [page(0, [heading('Contents', 0.08, 17), entry('1 Triangles ........ 5', 0.14), entry('1.1 Angles ........ 6', 0.17), entry('1.2 Sides ........ 12', 0.2), entry('2 Circles ........ 20', 0.23), entry('2.1 Arcs ........ 21', 0.26)])];
    expect(summary(pages)).toEqual(['chapter 1 Triangles', 'section 1.1 Angles', 'section 1.2 Sides', 'chapter 2 Circles', 'section 2.1 Arcs']);
  });

  it('does not take a number and a title for a chapter when no section of that number follows it (an index, a table of values)', () => {
    const pages = [page(0, [heading('Contents', 0.08, 17), entry('1 Triangles ........ 5', 0.14), entry('1.1 Angles ........ 6', 0.17), entry('1.2 Sides ........ 12', 0.2), entry('7 Index ........ 400', 0.23), entry('Answers ........ 380', 0.26)])];
    expect(summary(pages)).toEqual(['chapter 1 Triangles', 'section 1.1 Angles', 'section 1.2 Sides', 'other Answers']);
  });
});

describe('the printed page numbers', () => {
  /** A page whose body is one line and whose number is where the argument says: a footer, or a running head with changing words. */
  const numbered = (index: number, number: number, where: 'footer' | 'head'): PageText => {
    const base = page(index, [{ text: 'a line of body text that is long enough to count as text', left: 0.12, top: 0.3 }]);
    const body = base.lines.filter((candidate) => candidate.headerFooter !== true);
    const text = String(number);
    if (where === 'footer') return { ...base, lines: [...body, { text, rect: { left: 0.5, top: 0.93, right: 0.52, bottom: 0.945 }, fontSize: 10, column: 0, chars: text.length, headerFooter: true }] };
    // The words of the head change from page to page: nothing marks it as a running line, the number is what repeats.
    const words = `Section ${index} title of this page`;
    const left = index % 2 === 0;
    const head = [
      { text, rect: { left: left ? 0.12 : 0.85, top: 0.06, right: left ? 0.14 : 0.87, bottom: 0.072 }, fontSize: 10, column: 0, chars: text.length },
      { text: words, rect: { left: left ? 0.6 : 0.12, top: 0.06, right: left ? 0.6 + words.length * 0.007 : 0.12 + words.length * 0.007, bottom: 0.072 }, fontSize: 10, column: 0, chars: words.length },
    ];
    return { ...base, lines: [...head, ...body] };
  };

  it('reads the number from the footer', () => {
    const pages = Array.from({ length: 12 }, (_, at) => numbered(at, at + 5, 'footer'));
    expect(readPageNumbers(pages)).toMatchObject({ offset: 5, agreeing: 12 });
  });

  it('reads the number from the running head, at the left on one page and at the right on the next, with words that change', () => {
    const pages = Array.from({ length: 12 }, (_, at) => numbered(at, at + 10, 'head'));
    expect(readPageNumbers(pages)).toMatchObject({ offset: 10, agreeing: 12 });
  });

  it('gives no offset when the numbers of the pages do not agree on one', () => {
    const pages = Array.from({ length: 12 }, (_, at) => numbered(at, ((at * 7) % 13) + 3, 'footer'));
    const found = readPageNumbers(pages);
    expect(found.offset).toBeUndefined();
    expect(found.agreeing).toBe(0);
  });
});
