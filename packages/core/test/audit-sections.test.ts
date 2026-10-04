import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignSectionIds } from '../src/book/sections.js';
import { LIMITS } from '../src/rules/constants.js';
import { PdfDocument } from '../src/pdf/document.js';
import type { PageText } from '../src/model/types.js';
import { readPageNumbers } from '../src/audit/pagenumbers.js';
import { deriveSections, toOutlineEntries, type BookStructure } from '../src/audit/sections.js';
import { chooseTitle, editDistance, normalizeTitle, stripChapterPrefix, titleKey } from '../src/audit/titles.js';
import { parseTocLine } from '../src/audit/toc.js';
import { buildSyntheticBook, type SyntheticBook } from '../src/testing/book.js';
import { buildSampleSheet } from '../src/testing/sample.js';

describe('title normalising', () => {
  it('removes leaders and numbering, reads "&" and a slash between words as "and"', () => {
    expect(normalizeTitle('1.8 Application: Number/Geometry').title).toBe('Application: Number and Geometry');
    expect(normalizeTitle('Parallel & Perpendicular Lines').title).toBe('Parallel and Perpendicular Lines');
    expect(normalizeTitle('Addition/Elimination').title).toBe('Addition and Elimination');
    expect(normalizeTitle('Chapter 4: Systems of Equations').title).toBe('Systems of Equations');
    expect(normalizeTitle('Integers .........................12').title).toBe('Integers');
    expect(normalizeTitle('  Many   spaces   here ').title).toBe('Many spaces here');
    // A slash that is not between two words stays (a fraction in a title).
    expect(normalizeTitle('Rates 3/4 and 1/2').title).toBe('Rates 3/4 and 1/2');
  });

  it('reads the unmapped glyph U+0002 as the "not equal" sign and says so; other control characters are dropped', () => {
    const cleaned = normalizeTitle('Trinomials where a\u00021');
    expect(cleaned.title).toBe('Trinomials where a ≠ 1');
    expect(cleaned.repairs.join(' ')).toContain('U+0002');
    const dropped = normalizeTitle('Roots\u0001 of x');
    expect(dropped.title).toBe('Roots of x');
    expect(normalizeTitle('Roots\u0002', { glyphRepairs: {} }).title).toBe('Roots');
  });

  it('compares spellings by a key that ignores case, spaces, hyphens and "&"', () => {
    expect(titleKey('One-Step Equations')).toBe(titleKey('One Step equations'));
    expect(titleKey('Parallel & Perpendicular')).toBe(titleKey('Parallel and Perpendicular'));
    expect(titleKey('a ≠ 1')).toBe(titleKey('a != 1'));
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('keeps the table of contents spelling unless it looks like a typo that two other places contradict', () => {
    const typo = chooseTitle([
      { source: 'table of contents', text: 'Compound Inequalitites' },
      { source: 'chapter opener', text: 'Compound Inequalities' },
      { source: 'practice heading', text: 'Compound Inequalities' },
      { source: 'lesson heading', text: 'Compound Inequalities' },
    ]);
    expect(typo?.title).toBe('Compound Inequalities');
    expect(typo?.evidence.join(' ')).toContain('typo');
    // A different wording in the opener's list is not a typo: the table of contents stays.
    const wording = chooseTitle([
      { source: 'table of contents', text: 'Application: Distance' },
      { source: 'chapter opener', text: 'Application: Distance, Rate and Time' },
      { source: 'practice heading', text: 'Distance, Rate, and Time Problems' },
    ]);
    expect(wording?.title).toBe('Application: Distance');
    expect(wording?.differences.map((entry) => entry.source)).toEqual(['chapter opener', 'practice heading']);
    // A space the table of contents lost.
    const spaced = chooseTitle([
      { source: 'table of contents', text: 'Trinomials wherea ≠ 1' },
      { source: 'practice heading', text: 'Trinomials where a ≠ 1' },
    ]);
    expect(spaced?.title).toBe('Trinomials where a ≠ 1');
    // Without a table of contents the spelling most places agree on wins.
    const majority = chooseTitle([
      { source: 'practice heading', text: 'Add and Subtract' },
      { source: 'lesson heading', text: 'Add & Subtract Fractions' },
      { source: 'chapter opener', text: 'Add and Subtract' },
    ]);
    expect(majority?.title).toBe('Add and Subtract');
  });

  it('takes the section title out of a lesson heading that starts with the chapter title', () => {
    expect(stripChapterPrefix('Pre-Algebra - Integers')).toBe('Integers');
    expect(stripChapterPrefix('Integers')).toBe('Integers');
    expect(stripChapterPrefix('Slope-Intercept Form')).toBe('Slope-Intercept Form');
  });
});

describe('reading a line of a table of contents', () => {
  it('reads an entry with dot leaders, a weak leader and a number without a leader', () => {
    expect(parseTocLine('0.1 Sets and maps..........................7')).toEqual([{ kind: 'section', label: '0.1', number: '0.1', title: 'Sets and maps', printedPage: 7 }]);
    expect(parseTocLine('1.8 Application: Number/Geometry.64')).toEqual([{ kind: 'section', label: '1.8', number: '1.8', title: 'Application: Number/Geometry', printedPage: 64 }]);
    expect(parseTocLine('1.2 Slope        35')).toEqual([{ kind: 'section', label: '1.2', number: '1.2', title: 'Slope', printedPage: 35 }]);
    expect(parseTocLine('Answers..............................438')).toEqual([{ kind: 'other', title: 'Answers', printedPage: 438 }]);
    expect(parseTocLine('Chapter 3: Inequalities')).toEqual([{ kind: 'chapter', label: 'Chapter 3', number: '3', title: 'Inequalities' }]);
    expect(parseTocLine('Kapitel IV. Folgen und Reihen ........... 120')).toEqual([{ kind: 'chapter', label: 'Kapitel IV', number: 'IV', title: 'Folgen und Reihen', printedPage: 120 }]);
  });

  it('splits a merged line: a chapter heading and entries glued to each other', () => {
    const merged = '6.5 Special Products.......229Chapter 6: Factoring6.4 Trinomials with leading a..............226';
    expect(parseTocLine(merged, { lastSection: '6.3' }).map((piece) => `${piece.kind}:${piece.label}:${piece.title}:${piece.printedPage ?? ''}`)).toEqual([
      'section:6.5:Special Products:229',
      'chapter:Chapter 6:Factoring:',
      'section:6.4:Trinomials with leading a:226',
    ]);
  });

  it('splits a page number from the next label when they are glued, using the sequence of labels', () => {
    const glued = '9.4 Quadratic Formula....................3439.5 Build Quadratics From Roots...348';
    const pieces = parseTocLine(glued, { lastSection: '9.3' });
    expect(pieces.map((piece) => `${piece.label}:${piece.title}:${piece.printedPage}`)).toEqual(['9.4:Quadratic Formula:343', '9.5:Build Quadratics From Roots:348']);
    // 131.2 is page 13 and label 1.2 after 1.1, not page 1 and label 31.2.
    const second = parseTocLine('1.1 Points/Lines........131.2 Triangles & Ratios...16', { lastSection: '0.2' });
    expect(second.map((piece) => `${piece.label}:${piece.printedPage}`)).toEqual(['1.1:13', '1.2:16']);
  });

  it('gives up on a line that is not an entry', () => {
    expect(parseTocLine('Table of Contents')).toEqual([]);
    expect(parseTocLine('Some ordinary sentence of a lesson that ends with a number 12')).toEqual([]);
  });
});

describe('sections of the synthetic book', () => {
  let book: SyntheticBook;
  let doc: PdfDocument;
  let pages: PageText[];
  let structure: BookStructure;
  beforeAll(async () => {
    book = buildSyntheticBook();
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true });
    structure = deriveSections(pages);
  });
  afterAll(async () => {
    await doc.close();
  });

  it('reads the printed page numbers of the footers', () => {
    const numbering = readPageNumbers(pages);
    expect(numbering.offset).toBe(book.truth.pageOffset);
    expect(numbering.pageOf(14)).toBe(13);
    expect(numbering.printed(13)).toBe(14);
    expect(numbering.pageOf(10_000)).toBeUndefined();
  });

  it('finds the chapters and the sections with their labels, ids, titles and pages', () => {
    const chapters = structure.entries.filter((entry) => entry.kind === 'chapter');
    expect(chapters.map((entry) => [entry.id, entry.label, entry.title, entry.page, entry.depth])).toEqual(
      book.truth.chapters.map((chapter) => [chapter.id, chapter.label, chapter.title, chapter.openerPage, 0]),
    );
    const sections = structure.entries.filter((entry) => entry.kind === 'section');
    expect(sections.map((entry) => [entry.id, entry.label, entry.title, entry.page, entry.depth])).toEqual(
      book.truth.sections.map((section) => [section.id, section.label, section.title, section.lessonPage, 1]),
    );
    expect(structure.chapters).toBe(2);
    expect(structure.sections).toBe(4);
  });

  it('puts a section top where its label line is and a chapter top where its heading is', () => {
    for (const entry of structure.entries.filter((candidate) => candidate.kind !== 'other')) {
      expect(entry.top).toBeGreaterThan(0.08);
      expect(entry.top).toBeLessThan(0.12);
    }
  });

  it('keeps the entries in reading order with a chapter before its first section', () => {
    const order = structure.entries.map((entry) => entry.id);
    expect(order).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'Answers']);
    const positions = structure.entries.map((entry) => entry.page + (entry.top ?? 0));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('repairs the typo of the table of contents, reads "&" and a slash as "and", and explains', () => {
    const whole = structure.entries.find((entry) => entry.id === '0.1');
    expect(whole?.title).toBe('Whole Numbers');
    expect(whole?.evidence.join('\n')).toContain('typo');
    expect(whole?.differences.map((entry) => entry.text)).toContain('Whole Numbres');
    expect(structure.entries.find((entry) => entry.id === '1.1')?.title).toBe('Points and Lines');
    expect(structure.entries.find((entry) => entry.id === '1.2')?.title).toBe('Triangles and Ratios');
  });

  it('reads the entries out of the merged line of the table of contents and says so', () => {
    const second = structure.entries.find((entry) => entry.id === '1.2');
    expect(second?.evidence.join('\n')).toContain('merged line');
    expect(second?.evidence.join('\n')).toContain('printed page 16 = page 15');
  });

  it('records where each practice set starts and where it ends (the next thing the book prints)', () => {
    const practice = (id: string) => structure.entries.find((entry) => entry.id === id)?.practice;
    for (const section of book.truth.sections) {
      expect(practice(section.id)?.page, section.id).toBe(section.practiceFirstPage);
    }
    expect(practice('0.1')?.end.page).toBe(book.truth.sections[1]?.lessonPage);
    expect(practice('0.2')?.end.page).toBe(book.truth.chapters[1]?.openerPage);
    expect(practice('1.2')?.end.page).toBe(book.truth.answerKeyPage);
    expect(practice('1.2')?.end.why).toContain('Answers');
    expect(practice('0.1')?.end.why).toContain('0.2');
  });

  it('finds the answer key and lists it as an entry of the contents', () => {
    expect(structure.answerKey?.page).toBe(book.truth.answerKeyPage);
    const answers = structure.entries.find((entry) => entry.id === 'Answers');
    expect(answers?.title).toBe('Answers');
    expect(answers?.page).toBe(book.truth.answerKeyPage);
    expect(answers?.kind).toBe('other');
  });

  it('is confident about what several places agree on and has nothing to report', () => {
    for (const entry of structure.entries) {
      expect(entry.confidence, entry.id).toBeGreaterThanOrEqual(0.85);
      expect(entry.evidence.length, entry.id).toBeGreaterThan(0);
    }
    expect(structure.notes).toEqual([]);
  });

  it('produces entries that fit outline.set', () => {
    const outline = toOutlineEntries(structure);
    expect(outline[0]).toEqual({ title: 'Number Sense', page: 3, depth: 0, id: 'c0', label: 'Chapter 0', top: expect.any(Number) });
    expect(outline.every((entry) => entry.id !== undefined)).toBe(true);
    expect(new Set(outline.map((entry) => entry.id)).size).toBe(outline.length);
  });
});

describe('sections when the book prints less', () => {
  it('finds the sections from the headings alone when there is no table of contents', async () => {
    const book = buildSyntheticBook({ toc: false });
    const doc = await PdfDocument.fromBytes(book.pdf);
    try {
      const result = deriveSections(await doc.allPageText({ fonts: true }));
      expect(result.entries.filter((entry) => entry.kind === 'section').map((entry) => entry.id)).toEqual(['0.1', '0.2', '1.1', '1.2']);
      // Lesson and practice headings carry the "Chapter title - " prefix and the practice wording: the titles are still clean.
      expect(result.entries.find((entry) => entry.id === '0.2')?.title).toBe('Word Problems');
      expect(result.toc.pages).toEqual([]);
      expect(result.answerKey?.page).toBe(book.truth.answerKeyPage);
    } finally {
      await doc.close();
    }
  });

  it('has no answer key entry when the book has none', async () => {
    const book = buildSyntheticBook({ answerKey: false });
    const doc = await PdfDocument.fromBytes(book.pdf);
    try {
      const result = deriveSections(await doc.allPageText({ fonts: true }));
      expect(result.answerKey).toBeUndefined();
      expect(result.entries.some((entry) => entry.kind === 'other')).toBe(false);
      expect(result.entries.find((entry) => entry.id === '1.2')?.practice?.end.why).toContain('end of the book');
    } finally {
      await doc.close();
    }
  });

  it('falls back on generic headings when nothing is numbered, and says so', async () => {
    const doc = await PdfDocument.fromBytes(buildSampleSheet().pdf);
    try {
      const result = deriveSections(await doc.allPageText({ fonts: true }));
      expect(result.sections + result.chapters).toBe(result.entries.length);
      // The ids are the ones the data model gives to entries that have none, and they are valid section ids.
      const expected = assignSectionIds(result.entries.map(({ title, page, depth }) => ({ title, page, depth }))).entries.map((entry) => entry.id);
      expect(result.entries.map((entry) => entry.id)).toEqual(expected);
      expect(new Set(expected).size).toBe(expected.length);
      for (const id of expected) expect(id, id).toMatch(LIMITS.sectionIdPattern);
      expect(result.notes.join(' ')).toContain('generic heading detection');
    } finally {
      await doc.close();
    }
  });
});
