import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/model/types.js';
import { DEFAULT_RUN_KEYWORDS, RUN_LIMITS, findNumberedRuns, surveyNumberedRuns } from '../src/verify/runs.js';
import { blank, book, listing, page, prose, type L } from './runs-helpers.js';

/**
 * The census of numbered runs on lines made by hand: no PDF, only the lines with their boxes. A run is five or more items numbered one after the other;
 * the heading above it is only reported.
 */

const ids = (pages: Parameters<typeof findNumberedRuns>[0], options: Parameters<typeof findNumberedRuns>[1] = {}): string[] => findNumberedRuns(pages, options).map((run) => run.id);

describe('a run of consecutive items', () => {
  it('is found with its pages, labels, count, scheme, heading and the first words of its first item', () => {
    const lines: L[] = [{ text: '1.4 Exercises', x: 0.1, y: 0.1, size: 16.5 }, { text: 'Answers to odd-numbered exercises can be found in the appendix of this book.', x: 0.1, y: 0.15 }, ...listing({ from: 1, to: 8, y: 0.2 })];
    const [run, ...others] = findNumberedRuns(book(page(lines)));
    expect(others).toEqual([]);
    expect(run).toMatchObject({ id: 'p0:1', pages: [0], firstPage: 0, lastPage: 0, first: '1.', last: '8.', count: 8, missing: 0, scheme: 'k.', step: 1, heading: '1.4 Exercises', covered: false, coverage: 0 });
    expect(run?.start).toBe('1. Find the value of x when 1 is added to 3 and the sum is halved.'.slice(0, 60));
    expect(run?.firstItem.page).toBe(0);
    expect(run?.firstItem.rect.top).toBeCloseTo(0.2, 6);
    expect(run?.lastItem.rect.top).toBeCloseTo(0.55, 6);
    expect(run?.items.map((item) => item.label)).toEqual(['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.']);
    expect(run?.parity).toBeUndefined();
  });

  it('needs five items: four are no run, the minimum is an option', () => {
    const four = book(page([...prose(6), ...listing({ from: 1, to: 4, y: 0.3 }), ...prose(3, 0.6)]));
    expect(findNumberedRuns(four)).toEqual([]);
    expect(ids(four, { minRun: 4 })).toEqual(['p0:1']);
    expect(ids(book(page(listing({ from: 1, to: 5 }))))).toEqual(['p0:1']);
    expect(RUN_LIMITS.minRun).toBe(5);
  });

  it('reads the label forms 8.  8)  (8) and the dotted label of one chapter, each as a scheme of its own', () => {
    const forms: [string, (n: number) => string, string][] = [
      ['k.', (n) => `${n}.`, 'k.'],
      ['k)', (n) => `${n})`, 'k)'],
      ['(k)', (n) => `(${n})`, '(k)'],
      ['k.m', (n) => `4.${n}`, 'k.m'],
    ];
    for (const [, label, scheme] of forms) {
      const [run] = findNumberedRuns(book(page(listing({ from: 3, to: 9, label }))));
      expect(run, scheme).toMatchObject({ scheme, count: 7, first: label(3) });
    }
    // The dotted label keeps its chapter: 4.9 and 5.1 are no two items of one list.
    const lines = listing({ from: 6, to: 9, label: (n) => `4.${n}` });
    const next = listing({ from: 1, to: 3, label: (n) => `5.${n}`, y: 0.5 });
    expect(findNumberedRuns(book(page([...lines, ...next])))).toEqual([]);
    // A decimal number at the start of a line is no label of the plain form, and 1.5, 2.5, 3.5 are no dotted label of one chapter either.
    expect(findNumberedRuns(book(page(listing({ from: 1, to: 8, label: (n) => `${n}.5` }))))).toEqual([]);
  });

  it('does not read a line that starts with a label and has no text, a part marker, or a number without a closing mark', () => {
    const bare = listing({ from: 1, to: 8, text: () => '' }).map((entry) => ({ ...entry, text: entry.text.trim() }));
    expect(findNumberedRuns(book(page(bare)))).toEqual([]);
    expect(findNumberedRuns(book(page(listing({ from: 1, to: 8, label: (n) => `${n}a.` }))))).toEqual([]);
    expect(findNumberedRuns(book(page(listing({ from: 1, to: 8, label: (n) => `${n}` }))))).toEqual([]);
    expect(findNumberedRuns(book(page(listing({ from: 1, to: 8, label: (n) => `(${String.fromCharCode(96 + n)})` }))))).toEqual([]);
  });

  it('takes a line that does not start with a label as the continuation of the item above', () => {
    const lines: L[] = [];
    for (let n = 1; n <= 6; n += 1) {
      lines.push({ text: `${n}. Title ${n}. The first line of the item and its beginning.`, x: 0.1, y: 0.1 + n * 0.07 });
      lines.push({ text: 'goes on in a second line without any label of its own', x: 0.13, y: 0.1 + n * 0.07 + 0.02 });
    }
    expect(findNumberedRuns(book(page(lines)))).toMatchObject([{ count: 6, first: '1.', last: '6.' }]);
  });
});

describe('the numbers of a run', () => {
  it('rise by two in a key that prints only the odd (or the even) items', () => {
    const odd = findNumberedRuns(book(page(listing({ from: 1, to: 19, step: 2 }))));
    expect(odd).toMatchObject([{ first: '1.', last: '19.', count: 10, step: 2, parity: 'odd', missing: 0 }]);
    const even = findNumberedRuns(book(page(listing({ from: 2, to: 12, step: 2 }))));
    expect(even).toMatchObject([{ first: '2.', last: '12.', count: 6, step: 2, parity: 'even' }]);
  });

  it('may lack one label in ten: the text layer drops lines and books skip numbers', () => {
    const lines = listing({ from: 1, to: 12 }).filter((entry) => !entry.text.startsWith('5.'));
    expect(findNumberedRuns(book(page(lines)))).toMatchObject([{ count: 11, missing: 1, first: '1.', last: '12.' }]);
    const key = listing({ from: 1, to: 15, step: 2 }).filter((entry) => !entry.text.startsWith('7.'));
    expect(findNumberedRuns(book(page(key)))).toMatchObject([{ count: 7, missing: 1, step: 2 }]);
    // Two missing labels in a short stretch are too many: no run of five is left.
    const gaps = listing({ from: 1, to: 8 }).filter((entry) => !entry.text.startsWith('3.') && !entry.text.startsWith('6.'));
    expect(findNumberedRuns(book(page(gaps)))).toEqual([]);
    // Three missing in a row break a run in two (and the five items before them are a run of their own).
    const hole = listing({ from: 1, to: 14 }).filter((entry) => !/^(6|7|8)\./.test(entry.text));
    expect(findNumberedRuns(book(page(hole))).map((run) => `${run.first}-${run.last}`)).toEqual(['1.-5.', '9.-14.']);
  });

  it('ignores a number that repeats and takes a run that restarts as another run', () => {
    const lines = [...listing({ from: 1, to: 6 }), { text: '3. A stray line that repeats the number three.', x: 0.12, y: 0.6 }, ...listing({ from: 1, to: 5, y: 0.65 })];
    const runs = findNumberedRuns(book(page(lines)));
    expect(runs.map((run) => `${run.id} ${run.count}`)).toEqual(['p0:1 6', 'p0:1#2 5']);
  });

  it('are not a run when they are all years or when they stand in the running head of the pages', () => {
    const years = listing({ from: 1996, to: 2002, text: () => 'The population was counted again and it had grown by a few thousand.' });
    expect(findNumberedRuns(book(page(years)))).toEqual([]);
    expect(surveyNumberedRuns(book(page(years))).leftOut).toMatchObject([{ reason: 'years', count: 7 }]);
    const heads = book(
      ...[1, 2, 3, 4, 5, 6].map((n) => page([{ text: `${n}. Foundations of the subject`, x: 0.12, y: 0.03 }, ...prose(8, 0.2)])),
    );
    expect(findNumberedRuns(heads)).toEqual([]);
    expect(surveyNumberedRuns(heads).leftOut).toMatchObject([{ reason: 'running-head', count: 6 }]);
    // Footnotes at the foot of one page, five of them, are no running head.
    const notes = page([...prose(10, 0.1), ...listing({ from: 1, to: 5, y: 0.86, pitch: 0.02 })]);
    expect(findNumberedRuns(book(notes))).toMatchObject([{ count: 5 }]);
  });

  it('are not a run when every item has one or two characters, unless there are ten of them (an answer key)', () => {
    const letters = listing({ from: 1, to: 8, text: (n) => String.fromCharCode(96 + n) });
    expect(findNumberedRuns(book(page(letters)))).toEqual([]);
    expect(surveyNumberedRuns(book(page(letters))).leftOut).toMatchObject([{ reason: 'short-items', count: 8 }]);
    const key = listing({ from: 1, to: 12, text: (n) => String.fromCharCode(96 + (n % 4)) });
    expect(findNumberedRuns(book(page(key)))).toMatchObject([{ count: 12 }]);
    // Words after the number make an item, however short the item is.
    expect(findNumberedRuns(book(page(listing({ from: 1, to: 6, text: () => 'yes' }))))).toHaveLength(1);
  });
});

describe('items in columns, rows and across pages', () => {
  it('goes on from one column to the next and from one page to the next, the labels carried over', () => {
    const left = listing({ from: 1, to: 6, x: 0.08, y: 0.15, column: 0 });
    const right = listing({ from: 7, to: 12, x: 0.55, y: 0.15, column: 1 });
    const two = page([...left, ...right], 0, 2);
    const next = page(listing({ from: 13, to: 17, y: 0.1 }), 1);
    const [run] = findNumberedRuns(book(two, next));
    expect(run).toMatchObject({ count: 17, first: '1.', last: '17.', pages: [0, 1], firstPage: 0, lastPage: 1 });
    expect(findNumberedRuns(book(two, next))).toHaveLength(1);
    // Two pages of prose in between do not break it; after three the next five items are a run of their own.
    expect(findNumberedRuns(book(two, page(prose(5)), page(listing({ from: 13, to: 17 })))).map((entry) => entry.count)).toEqual([17]);
    expect(findNumberedRuns(book(two, page(prose(5)), page(prose(5)), page(listing({ from: 13, to: 17 })))).map((entry) => entry.count)).toEqual([12, 5]);
  });

  it('joins a left column that runs down and then a right column when the lines come row by row', () => {
    // No gutter was found: the reader gives the rows in order 1 11 2 12 3 13 ...
    const lines: L[] = [];
    for (let row = 0; row < 10; row += 1) {
      lines.push({ text: `${row + 1}. Find the value of x in the first column, row ${row + 1}.`, x: 0.08, y: 0.1 + row * 0.04 });
      lines.push({ text: `${row + 11}. Find the value of x in the second column, row ${row + 1}.`, x: 0.55, y: 0.1 + row * 0.04 });
    }
    expect(findNumberedRuns(book(page(lines)))).toMatchObject([{ count: 20, first: '1.', last: '20.' }]);
  });

  it('reads two and three items side by side, as separate lines of a row or as the cells of one line', () => {
    const rows: L[] = [];
    for (let row = 0; row < 4; row += 1) {
      rows.push({ text: `${row * 2 + 1}) sin ${row * 10}`, x: 0.08, y: 0.1 + row * 0.04 });
      rows.push({ text: `${row * 2 + 2}) cos ${row * 10}`, x: 0.5, y: 0.1 + row * 0.04 });
    }
    expect(findNumberedRuns(book(page(rows)))).toMatchObject([{ count: 8, scheme: 'k)' }]);
    const cells: L[] = [];
    for (let row = 0; row < 3; row += 1) {
      const n = row * 3 + 19;
      const parts = [`${n}. sin ${row}2`, `${n + 1}. cos ${row}4`, `${n + 2}. tan ${row}6`];
      cells.push({ text: parts.join(' '), x: 0.08, y: 0.1 + row * 0.04, cells: parts.map((text, k) => ({ text, x: 0.08 + k * 0.16 })) });
    }
    expect(findNumberedRuns(book(page(cells)))).toMatchObject([{ count: 9, first: '19.', last: '27.' }]);
  });

  it('is not made of the lines of a table row that merely start with a number', () => {
    const table: L[] = Array.from({ length: 8 }, (_unused, k) => ({ text: `${k + 1} Iron Man 2008 98.62 319.03`, x: 0.12, y: 0.2 + k * 0.03 }));
    expect(findNumberedRuns(book(page(table)))).toEqual([]);
  });

  it('keeps two lists side by side apart when they stand in one column each and the numbers start again', () => {
    const lines: L[] = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push({ text: `${row + 1}. Solve the equation of the left list, number ${row + 1}.`, x: 0.08, y: 0.1 + row * 0.04 });
      lines.push({ text: `${row + 1}. Solve the equation of the right list, number ${row + 1}.`, x: 0.55, y: 0.1 + row * 0.04 });
    }
    const runs = findNumberedRuns(book(page(lines)));
    expect(runs.map((run) => run.count)).toEqual([6, 6]);
    expect(runs[0]?.items.every((item) => item.rect.left < 0.3)).toBe(true);
    expect(runs[1]?.items.every((item) => item.rect.left > 0.4)).toBe(true);
    expect(runs.map((run) => run.id)).toEqual(['p0:1', 'p0:1#2']);
  });
});

describe('keyword labels', () => {
  const keyword = (word: string, label: (n: number) => string, from: number, to: number): L[] => listing({ from, to, label: (n) => `${word} ${label(n)}`, pitch: 0.06 });

  it('reads Exercise 4.2, Problem 7, Question 12, Task 5, Aufgabe 1.26 and Uebung 3 as runs of the keyword', () => {
    const cases: [string, (n: number) => string, number, number, string][] = [
      ['Exercise', (n) => `4.${n}`, 2, 8, 'Exercise'],
      ['Problem', (n) => `${n}`, 7, 12, 'Problem'],
      ['Question', (n) => `${n}.`, 12, 17, 'Question'],
      ['Task', (n) => `${n}:`, 5, 10, 'Task'],
      ['Aufgabe', (n) => `1.${n}`, 26, 31, 'Aufgabe'],
      ['Uebung', (n) => `${n}`, 3, 8, 'Uebung'],
    ];
    for (const [word, label, from, to, name] of cases) {
      const [run] = findNumberedRuns(book(page(keyword(word, label, from, to))));
      expect(run, word).toMatchObject({ scheme: 'keyword', keyword: name, count: to - from + 1 });
    }
    expect(findNumberedRuns(book(page(keyword('Exercise', (n) => `4.${n}`, 2, 8))))[0]).toMatchObject({ id: 'p0:Exercise_4.2', first: 'Exercise 4.2', last: 'Exercise 4.8' });
    expect(DEFAULT_RUN_KEYWORDS).toContain('aufgabe');
  });

  it('is not made of a keyword that is no label (the plural of a range, a word that only starts with it), and a word of the book is an option', () => {
    expect(findNumberedRuns(book(page(keyword('Exercises', (n) => `${n}`, 1, 8))))).toEqual([]);
    expect(findNumberedRuns(book(page(keyword('Problems', (n) => `${n}`, 1, 8))))).toEqual([]);
    expect(findNumberedRuns(book(page(keyword('Example', (n) => `${n}`, 1, 8))))).toEqual([]);
    expect(ids(book(page(keyword('Example', (n) => `${n}`, 1, 8))), { keywords: [...DEFAULT_RUN_KEYWORDS, 'example'] })).toEqual(['p0:Example_1']);
    expect(ids(book(page(keyword('Exercise', (n) => `${n}`, 1, 8))), { keywords: [] })).toEqual([]);
    // A keyword label may stand alone on its line, the statement is below it.
    const alone: L[] = Array.from({ length: 6 }, (_unused, k) => ({ text: `Aufgabe 1.${k + 1}`, x: 0.1, y: 0.1 + k * 0.06 }));
    expect(findNumberedRuns(book(page(alone)))).toMatchObject([{ scheme: 'keyword', count: 6 }]);
  });
});

describe('what is no list of exercises, answers or the like', () => {
  const leaders = (label: (n: number) => string): L[] => listing({ from: 1, to: 8, label, text: (n) => `Case study and the data of chapter one ${'.'.repeat(30)} ${n * 7}` });

  it('ignores a page of contents: lines that end in a page number after leader dots, or have a bare number at the right of the row', () => {
    expect(findNumberedRuns(book(page(leaders((n) => `1.${n}`))))).toEqual([]);
    expect(surveyNumberedRuns(book(page(leaders((n) => `1.${n}`)))).leftOut).toMatchObject([{ reason: 'contents', count: 8 }]);
    const wide: L[] = [];
    for (let n = 1; n <= 8; n += 1) {
      wide.push({ text: `1.${n} Sampling principles and strategies`, x: 0.12, y: 0.1 + n * 0.04 });
      wide.push({ text: String(n * 12), x: 0.85, y: 0.1 + n * 0.04 });
    }
    expect(findNumberedRuns(book(page(wide)))).toEqual([]);
    expect(surveyNumberedRuns(book(page(wide))).leftOut[0]?.reason).toBe('contents');
  });

  it('ignores an index of numbered entries with their lists of page numbers, but not a list of numbers that is an answer', () => {
    const index: L[] = listing({ from: 1, to: 8, text: (n) => `mean, ${n + 3}, ${n + 9}, ${n + 40}` });
    expect(findNumberedRuns(book(page(index)))).toEqual([]);
    const answers = listing({ from: 1, to: 8, text: (n) => `${n}, ${n + 1}, ${n + 5}, ${n + 7}` });
    expect(findNumberedRuns(book(page(answers)))).toMatchObject([{ count: 8 }]);
  });

  it('ignores the headings of the book printed again as a list: the outline of a chapter before its sections', () => {
    const titles = ['Points and lines', 'Angles at a point', 'Triangles', 'Quadrilaterals', 'Circles and arcs', 'Solids'];
    const outline: L[] = titles.map((title, k) => ({ text: `7.${k + 1} ${title.toUpperCase()}`, x: 0.12, y: 0.2 + k * 0.04 }));
    const sections = titles.map((title, k) => page([{ text: `7.${k + 1} ${title.toUpperCase()}`, x: 0.12, y: 0.1, size: 18 }, ...prose(12, 0.2)], k + 1));
    const pages = book(page(outline), ...sections);
    expect(findNumberedRuns(pages)).toEqual([]);
    expect(surveyNumberedRuns(pages).leftOut).toMatchObject([{ reason: 'headings', count: 6 }]);
    // The same lines with no section that prints them again are a list of items.
    expect(findNumberedRuns(book(page(outline)))).toMatchObject([{ count: 6 }]);
  });

  it('does not take a heading set larger for an item, and reports it as the line above the run', () => {
    const lines: L[] = [{ text: '3. Methods of the study', x: 0.1, y: 0.08, size: 18 }, ...listing({ from: 1, to: 6, y: 0.2 })];
    const [run] = findNumberedRuns(book(page([...prose(10, 0.3), ...lines.slice(0, 1), ...listing({ from: 1, to: 6, y: 0.55 })])));
    expect(run).toMatchObject({ count: 6, first: '1.', heading: '3. Methods of the study' });
  });

  it('is not misled by pages without text and by pages that were not read', () => {
    // A page without text, or one that was not read, between two pages of one list does not break it ...
    expect(findNumberedRuns([page(listing({ from: 1, to: 6 }), 0), blank(1), page(listing({ from: 7, to: 9 }), 2)])).toMatchObject([{ count: 9, pages: [0, 2] }]);
    expect(findNumberedRuns([page(listing({ from: 1, to: 6 }), 0), undefined, page(listing({ from: 7, to: 9 }), 2)])).toMatchObject([{ count: 9, pages: [0, 2] }]);
    // ... three of them do.
    expect(findNumberedRuns([page(listing({ from: 1, to: 6 }), 0), blank(1), undefined, page(listing({ from: 7, to: 9 }), 3)]).map((run) => run.count)).toEqual([6]);
    expect(findNumberedRuns(() => undefined, { pageCount: 5 })).toEqual([]);
    expect(findNumberedRuns([])).toEqual([]);
  });
});

describe('the heading above a run', () => {
  it('is the nearest line above the first item that is no item and is set larger or bolder, else the nearest short line, else none', () => {
    const items = listing({ from: 1, to: 6, y: 0.4 });
    const larger: L[] = [{ text: 'Chapter exercises and review', x: 0.1, y: 0.1, size: 15 }, { text: 'Do the work below and show every step of the solution that you find.', x: 0.1, y: 0.3 }, ...items];
    expect(findNumberedRuns(book(page(larger)))[0]?.heading).toBe('Chapter exercises and review');
    const bold: L[] = [{ text: 'Practice', x: 0.1, y: 0.1, bold: true }, { text: 'Do the work below and show every step of the solution that you find.', x: 0.1, y: 0.3 }, ...items];
    expect(findNumberedRuns(book(page(bold)))[0]?.heading).toBe('Practice');
    const short: L[] = [{ text: 'Do the work below and show every step of the solution that you find.', x: 0.1, y: 0.2 }, { text: 'Evaluate each.', x: 0.1, y: 0.3 }, ...items];
    expect(findNumberedRuns(book(page(short)))[0]?.heading).toBe('Evaluate each.');
    const none: L[] = [{ text: 'Do the work below and show every step of the solution that you find.', x: 0.1, y: 0.2 }, ...items];
    expect(findNumberedRuns(book(page(none)))[0]?.heading).toBeUndefined();
  });

  it('is looked for on the pages before when the run starts at the top of its page, and reported up to eighty characters', () => {
    const before = page([...prose(6), { text: 'Exercises', x: 0.1, y: 0.92, size: 16 }], 0);
    const first = page(listing({ from: 1, to: 6, y: 0.06 }), 1);
    expect(findNumberedRuns(book(before, first))[0]?.heading).toBe('Exercises');
    const long = page([{ text: 'W'.repeat(95), x: 0.1, y: 0.1, size: 16 }, ...listing({ from: 1, to: 6 })]);
    expect(findNumberedRuns(book(long))[0]?.heading).toHaveLength(80);
  });
});

describe('the ids and the cover of a run', () => {
  it('names a run by the page of its first item and its first label; a second one with the same name gets #2', () => {
    const first = page(listing({ from: 1, to: 6 }), 0);
    const second = page(listing({ from: 1, to: 6 }), 4);
    expect(ids(book(first, blank(1), blank(2), blank(3), second))).toEqual(['p0:1', 'p4:1']);
    expect(ids(book(page(listing({ from: 8, to: 13, label: (n) => `(${n})` }))))).toEqual(['p0:8_parens']);
    expect(ids(book(page(listing({ from: 8, to: 13, label: (n) => `${n})` }))))).toEqual(['p0:8_paren']);
    expect(ids(book(page(listing({ from: 1, to: 6, label: (n) => `12.${n}` }))))).toEqual(['p0:12.1']);
  });

  it('is covered when at least 80 percent of its item lines lie inside the regions of the project, and each item says whether its own does', () => {
    const lines = listing({ from: 1, to: 10, y: 0.1, pitch: 0.05 });
    const pages = book(page(lines));
    const region = (to: number): Rect => ({ left: 0.05, top: 0.05, right: 0.95, bottom: 0.1 + to * 0.05 });
    const regions = (page: number, upTo: number) => (page === 0 ? [{ rect: region(upTo) }] : []);
    const nine = findNumberedRuns(pages, { regions: (p) => regions(p, 9) })[0];
    expect(nine).toMatchObject({ coverage: 0.9, covered: true });
    expect(nine?.items.filter((item) => item.covered)).toHaveLength(9);
    const seven = findNumberedRuns(pages, { regions: (p) => regions(p, 7) })[0];
    expect(seven).toMatchObject({ coverage: 0.7, covered: false });
    expect(seven?.items.map((item) => item.covered)).toEqual([true, true, true, true, true, true, true, false, false, false]);
    expect(findNumberedRuns(pages)[0]).toMatchObject({ coverage: 0, covered: false });
    // A line is inside when half of its box is.
    const half = findNumberedRuns(pages, { regions: () => [{ rect: { left: 0.05, top: 0.1, right: 0.95, bottom: 0.1 + 0.007 } }] })[0];
    expect(half?.items[0]?.covered).toBe(true);
    expect(half?.items[1]?.covered).toBe(false);
  });

  it('is the same for a list of pages and for a lookup with the number of pages', () => {
    const pages = book(page(listing({ from: 1, to: 6 })), page(listing({ from: 7, to: 12 })));
    expect(findNumberedRuns((index) => pages[index], { pageCount: 2 })).toEqual(findNumberedRuns(pages));
  });
});

describe('what is read of a page', () => {
  it('leaves out the running head and the page number that the reader flagged and the ones that repeat in the top band', () => {
    const lines: L[] = [{ text: '1. Foundations', x: 0.1, y: 0.03, headerFooter: true }, ...listing({ from: 1, to: 6, y: 0.2 })];
    expect(findNumberedRuns(book(page(lines)))).toMatchObject([{ count: 6, firstItem: { rect: { top: 0.2 } } }]);
  });

  it('does not depend on whether the lines say that they are bold, unless every page says it', () => {
    const marked = (bold: boolean): L[] => [{ text: '3.1 Methods of the study', x: 0.1, y: 0.1, bold }, ...listing({ from: 1, to: 6 }), ...prose(3, 0.7)];
    expect(findNumberedRuns(book(page(marked(true))))).toMatchObject([{ count: 6 }]);
    expect(findNumberedRuns(book(page(marked(false))))).toMatchObject([{ count: 6 }]);
  });
});
