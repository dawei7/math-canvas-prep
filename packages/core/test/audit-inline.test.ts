import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLabelledAnswers, findLabelledItems, labelledItemPatterns, sectionOfLabel, withSingulars } from '../src/audit/labelled.js';
import { proposeExercises, type BookExercises, type ExerciseProposal } from '../src/audit/exercises.js';
import { numberBookmarks } from '../src/audit/bookmarks.js';
import { deriveSections, deriveSectionsFromBookmarks, type BookEntry, type BookStructure } from '../src/audit/sections.js';
import { DEFAULT_BOOK_PATTERNS } from '../src/audit/scan.js';
import { proposeSolutions, type BookSolutions, type SolutionProposal } from '../src/audit/solutions.js';
import type { PageText, Rect } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import type { Project } from '../src/project/model.js';
import { buildInlineBook, type InlineBook } from '../src/testing/inline-book.js';
import { verifyProject } from '../src/verify/verify.js';

/**
 * Exercises printed inside the lessons ("1.1.2 Aufgabe: ... Lösung") and answers headed by their number ("Lösung 1.1.2 ... zurück"):
 * the synthetic text of `buildInlineBook` goes through the real text extraction and the whole audit.
 */

describe('exercises and answers printed inside the text', () => {
  let book: InlineBook;
  let doc: PdfDocument;
  let pages: PageText[];
  let structure: BookStructure;
  let exercises: BookExercises;
  let solutions: BookSolutions;
  const proposals = (): ExerciseProposal[] => exercises.sections.flatMap((section) => section.proposals);
  const exercise = (label: string): ExerciseProposal => proposals().find((proposal) => proposal.label === label) as ExerciseProposal;
  const answer = (label: string): SolutionProposal => solutions.sections.flatMap((section) => section.answers).find((entry) => entry.label === label) as SolutionProposal;
  const inside = (rect: Rect, piece: Rect): boolean => piece.left >= rect.left - 1e-6 && piece.right <= rect.right + 1e-6 && piece.top >= rect.top - 1e-6 && piece.bottom <= rect.bottom + 1e-6;

  beforeAll(async () => {
    book = buildInlineBook();
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true, ink: true, inkMap: true });
    structure = deriveSections(pages);
    exercises = proposeExercises(pages, structure.entries);
    solutions = proposeSolutions(pages, structure.entries, proposals().map((proposal) => ({ section: proposal.section, label: proposal.label })));
  });
  afterAll(async () => {
    await doc.close();
  });

  it('is a book whose text layer lists a wide formula as two columns (the order of the list is not the reading order)', () => {
    expect(pages[book.wideFormulaPage]?.columns).toBe(2);
  });

  it('finds the sections from their headings and does not say that they have no exercises', () => {
    expect(structure.entries.filter((entry) => entry.kind === 'section').map((entry) => entry.id)).toEqual(['1.1', '1.2']);
    expect(structure.notes.join(' ')).not.toContain('no practice heading found');
    expect(structure.notes.join(' ')).toContain('6 exercises are printed inside the text of 2 sections');
  });

  it('proposes every exercise under the section named by the first two numbers of its label, with the gaps of the shared counter', () => {
    expect(proposals().map((proposal) => `${proposal.section}:${proposal.label}`)).toEqual(book.exercises.map((entry) => `${entry.section}:${entry.label}`));
    expect(exercises.sections.map((section) => [section.section, section.first, section.last])).toEqual([
      ['1.1', '1.1.2', '1.1.3'],
      ['1.2', '1.2.2', '1.2.6'],
    ]);
    for (const truth of book.exercises) expect(exercise(truth.label).page, truth.label).toBe(truth.page);
  });

  it('ends an exercise at the link word at the right margin, which is part of its region', () => {
    const four = pages[0]?.lines.find((line) => line.text.trim() === 'Lösung') as { rect: Rect };
    const two = exercise('1.1.2');
    expect(inside(two.rect, four.rect)).toBe(true);
    expect(two.rect.bottom - four.rect.bottom).toBeLessThan(0.02);
    expect(two.evidence.join(' ')).toContain('ends at the link "Lösung" at the right margin');
  });

  it('runs an exercise over the page break and puts the link of its second page into the second region', () => {
    const three = exercise('1.1.3');
    expect(three.continues?.map((region) => region.page)).toEqual([1]);
    const link = pages[1]?.lines.find((line) => line.text.trim() === 'Lösung') as { rect: Rect };
    expect(inside((three.continues?.[0] as { rect: Rect }).rect, link.rect)).toBe(true);
    expect(exercises.sections[0]?.notes.join(' ')).toContain('1.1.3 (pages 0-1, 1 continuation region)');
  });

  it('keeps both halves of a wide formula in the region, whatever order the text layer lists them in', () => {
    const product = exercise('1.2.2');
    // The six rows of the matrices: the left halves and the right halves, between the statement and "and give the result."
    const lines = pages[book.wideFormulaPage]?.lines ?? [];
    const first = lines.find((line) => line.text.trim().startsWith('1.2.2 Aufgabe')) as { rect: Rect };
    const last = lines.find((line) => line.text.trim() === 'and give the result.') as { rect: Rect };
    const pieces = lines.filter((line) => /^\d+ \d+ \d+$/.test(line.text.trim()) && line.rect.top > first.rect.top && line.rect.bottom < last.rect.top);
    expect(pieces).toHaveLength(12);
    expect(new Set(pieces.map((piece) => piece.column))).toEqual(new Set([0, 1]));
    for (const piece of pieces) expect(inside(product.rect, piece.rect), piece.text).toBe(true);
  });

  it('says which exercise has no link word and which link word belongs to no exercise', () => {
    const notes = exercises.sections.flatMap((section) => section.notes).join(' ');
    expect(notes).toContain('the exercise 1.2.4 has no link word at the right margin');
    expect(exercise('1.2.4').evidence.join(' ')).toContain('no link word at the right margin');
    expect(exercise('1.2.4').confidence).toBeLessThan(exercise('1.2.3').confidence);
    // The link of 1.2.6 stands alone at the top of the next page: it ends the exercise without being a region of it.
    expect(exercise('1.2.6').continues).toBeUndefined();
    expect(exercise('1.2.6').evidence.join(' ')).toContain('ends at the link "Lösung" at the right margin');
    expect(notes).not.toContain('1.2.6 has');
    expect(exercises.notes.join(' ')).toContain(`belong to no exercise (page ${book.strayLinkPage})`);
  });

  it('proposes an answer for each exercise that has one, headed by the word before its number and ending at the link back', () => {
    expect(solutions.sections.flatMap((section) => section.answers.map((entry) => entry.label))).toEqual(['1.1.2', '1.1.3', '1.2.2', '1.2.3', '1.2.6']);
    expect(answer('1.1.2').text).toBe('Lösung 1.1.2');
    expect(answer('1.1.2').evidence.join(' ')).toContain('ends at the link "zurück" at the right margin');
    expect(answer('1.1.2').regions.map((region) => region.page)).toEqual([3]);
    expect(solutions.notes.join(' ')).toContain('5 answers are entries of an answer chapter');
  });

  it('runs an answer over the page break, and leaves out a last page that holds nothing but the link back', () => {
    expect(answer('1.1.3').regions.map((region) => region.page)).toEqual([3, 4]);
    expect(solutions.sections[0]?.notes.join(' ')).toContain('1.1.3 (pages 3-4, 1 continuation region)');
    // The answer to 1.2.3 ends at the bottom of page 4; its link back stands alone on page 5.
    expect(answer('1.2.3').regions.map((region) => region.page)).toEqual([4]);
    expect(answer('1.2.3').evidence.join(' ')).toContain('ends at the link "zurück" at the right margin');
  });

  it('reports the exercise that has no answer, and counts the coverage', () => {
    expect(solutions.sections.find((section) => section.section === '1.2')?.withoutAnswer).toEqual(['1.2.4']);
    expect(solutions.sections.find((section) => section.section === '1.2')?.notes.join(' ')).toContain('no answer for the exercise 1.2.4');
    expect(solutions.coverage).toMatchObject({ exercises: 6, answered: 5 });
  });

  it('passes exercises verify, which reads "1.2.3 Aufgabe" and "Lösung 1.2.3" as the number of an exercise and of an answer', () => {
    const answers = new Map(solutions.sections.flatMap((section) => section.answers.map((entry) => [`${entry.section}:${entry.label}`, entry.regions] as const)));
    const project = {
      format: 'mcprep.project',
      version: 1,
      pdf: { path: 'x.pdf', sha256: '0', bytes: 0, pageCount: pages.length },
      frames: proposals().map((proposal, index) => ({
        id: `f${index + 1}`,
        kind: 'exercise',
        authority: 'book',
        page: proposal.page,
        rect: proposal.rect,
        section: proposal.section,
        label: proposal.label,
        ...(proposal.continues ? { continues: proposal.continues } : {}),
        ...(answers.has(`${proposal.section}:${proposal.label}`) ? { solution: answers.get(`${proposal.section}:${proposal.label}`) } : {}),
      })),
      outline: { source: 'derived', entries: structure.entries.map((entry) => ({ title: entry.title, page: entry.page, depth: entry.depth, id: entry.id, label: entry.label, ...(entry.top !== undefined ? { top: entry.top } : {}) })) },
    } as unknown as Project;
    const report = verifyProject(project, (page) => pages[page]);
    expect(report.summary.errors).toBe(0);
  });

  it('reads nothing of this kind when the item words are not the words of the book (the words are options)', () => {
    const none = proposeExercises(pages, structure.entries, { patterns: { itemWords: ['nothing'] } });
    expect(none.sections.flatMap((section) => section.proposals)).toEqual([]);
    expect(none.sections[0]?.notes.join(' ')).toContain('no practice set was found for this section');
    const other = proposeExercises(pages, structure.entries, { patterns: { itemWords: ['aufgabe', 'satz'] } });
    expect(other.sections.flatMap((section) => section.proposals).length).toBeGreaterThan(5);
  });

  it('is only read when there are at least three anchors: a single line like it in another book is no layout', () => {
    expect(findLabelledItems(pages.slice(0, 1)).length).toBe(2);
    const alone = proposeExercises(pages.slice(0, 1), structure.entries.slice(0, 2), {});
    expect(alone.sections.flatMap((section) => section.proposals)).toEqual([]);
    expect(findLabelledAnswers(pages).length).toBe(5);
  });
});

describe('answers that are headed by a number the exercises do not have', () => {
  it('are not read as the answers of a book whose exercises have other numbers', async () => {
    const book = buildInlineBook();
    const doc = await PdfDocument.fromBytes(book.pdf);
    try {
      const pages = await doc.allPageText({ fonts: true });
      const structure = deriveSections(pages);
      const refs = [{ section: '1.1', label: '5' }, { section: '1.1', label: '6' }, { section: '1.2', label: '7' }];
      const result = proposeSolutions(pages, structure.entries, refs);
      expect(result.notes.join(' ')).not.toContain('entries of an answer chapter');
      expect(result.sections.flatMap((section) => section.answers)).toEqual([]);
    } finally {
      await doc.close();
    }
  });
});

describe('the words and the sections of this layout', () => {
  it('reads the singular of a plural word and keeps the words of a phrase', () => {
    expect(withSingulars(['exercises', 'aufgaben', 'lösungen', 'answer key', 'review'])).toEqual(expect.arrayContaining(['exercise', 'aufgabe', 'aufgab', 'lösung', 'answer key', 'review']));
    expect(withSingulars(['problems'])).toContain('problem');
    expect(withSingulars(['entries'])).toContain('entry');
  });

  const entries = (...labels: string[]): BookEntry[] => labels.map((label, index) => ({ title: `Section ${label}`, page: index * 10, depth: 1, id: label, label, kind: 'section', confidence: 1, evidence: [], differences: [] }));

  it('files "N.M.K" under the section N.M, else under the nearest section whose label starts it, else under the section the page is in', () => {
    const sections = entries('1.1', '1.2', '2.1');
    expect(sectionOfLabel('1.2.7', 99, sections)?.id).toBe('1.2');
    expect(sectionOfLabel('2.1.40', 0, sections)?.id).toBe('2.1');
    // 3.4 does not exist: no label starts it either, the page decides (page 12 is in "1.2", which starts at page 10)
    expect(sectionOfLabel('3.4.1', 12, sections)?.id).toBe('1.2');
    // "1" starts "1.9.1" but is no section: the page decides
    expect(sectionOfLabel('1.9.1', 25, sections)?.id).toBe('2.1');
    expect(sectionOfLabel('1.1.2', 0, [])).toBeUndefined();
  });

  it('gives the patterns by which a text check reads the number of such an exercise and answer', () => {
    const [item, wordFirst, answer] = labelledItemPatterns(DEFAULT_BOOK_PATTERNS) as [RegExp, RegExp, RegExp];
    expect(item.exec('1.2.3 Aufgabe: Berechne x.')?.[1]).toBe('1.2.3');
    expect(item.exec('Lösung 1.2.3')).toBeNull();
    expect(answer.exec('Lösung 1.2.3 und so weiter')?.[1]).toBe('1.2.3');
    expect(answer.exec('Solution 4.1.12')?.[1]).toBe('4.1.12');
    expect(answer.exec('1.2.3 Aufgabe')).toBeNull();
    // The word first: "Aufgabe 1.3 (Title). ...", also with a colon, a dash or nothing after the number; not a sentence that names one.
    expect(wordFirst.exec('Aufgabe 1.3 (Brüche). Kürzen Sie.')?.[1]).toBe('1.3');
    expect(wordFirst.exec('Exercise 12.2.51: compute')?.[1]).toBe('12.2.51');
    expect(wordFirst.exec('Aufgabe 2.4')?.[1]).toBe('2.4');
    expect(wordFirst.exec('Aufgabe 2.4 zeigt, dass es geht')).toBeNull();
    expect(wordFirst.exec('Aufgabe 5. Berechne')).toBeNull();
    expect(wordFirst.exec('1.2.3 Aufgabe: Berechne x.')).toBeNull();
  });
});

describe('a book whose headings carry no numbers', () => {
  let doc: PdfDocument;
  let pages: PageText[];
  beforeAll(async () => {
    doc = await PdfDocument.fromBytes(buildInlineBook({ unnumbered: true }).pdf);
    pages = await doc.allPageText({ fonts: true, ink: true });
  });
  afterAll(async () => {
    await doc.close();
  });

  it('has no numbers in its headings, and the bookmarks give the sections by counting', async () => {
    // The headings are not numbered: the generic detection gives titles as ids, which the bookmarks improve on.
    expect(deriveSections(pages).generic).toBe(true);
    const bookmarks = (await doc.outline()) ?? [];
    expect(bookmarks.map((entry) => [entry.title, entry.depth])).toEqual([['Part A', 0], ['Foundations', 1], ['Sets', 2], ['Maps', 2], ['Solutions of the exercises', 0]]);
    const structure = deriveSectionsFromBookmarks(pages, bookmarks) as BookStructure;
    expect(structure.entries.filter((entry) => entry.kind === 'section').map((entry) => [entry.id, entry.label, entry.title, entry.page])).toEqual([
      ['1.1', '1.1', 'Sets', 0],
      ['1.2', '1.2', 'Maps', 1],
    ]);
    expect(structure.entries.filter((entry) => entry.kind === 'chapter').map((entry) => [entry.id, entry.label])).toEqual([['c1', 'Chapter 1']]);
    // The chapters are at depth 1, under a part: chosen because the numbers of the printed exercises (1.1.x, 1.2.x) fit that count.
    expect(structure.notes.join(' ')).toContain('chapters at depth 1');
    expect(structure.notes.join(' ')).toContain('2 of the 2 section numbers that the printed exercises show fit');
    // The heading of each section is found on its page.
    expect(structure.entries.find((entry) => entry.id === '1.2')?.top).toBeGreaterThan(0.2);
  });

  it('then proposes the exercises and the answers of these sections like any other book', async () => {
    const structure = deriveSectionsFromBookmarks(pages, (await doc.outline()) ?? []) as BookStructure;
    const exercises = proposeExercises(pages, structure.entries);
    expect(exercises.sections.map((section) => [section.section, section.proposals.map((proposal) => proposal.label)])).toEqual([
      ['1.1', ['1.1.2', '1.1.3']],
      ['1.2', ['1.2.2', '1.2.3', '1.2.4', '1.2.6']],
    ]);
  });

  it('counts at the top level when nothing printed says otherwise, and counts nothing when there are no chapters with sections', () => {
    const flat = [
      { title: 'A', page: 0, depth: 0 },
      { title: 'A one', page: 0, depth: 1 },
      { title: 'B', page: 1, depth: 0 },
      { title: 'B one', page: 1, depth: 1 },
      { title: 'B two', page: 2, depth: 1 },
    ];
    const bare = pages.map((page) => ({ ...page, lines: [] }));
    const numbered = numberBookmarks(flat, bare);
    expect(numbered?.chapterDepth).toBe(0);
    expect(numbered?.entries.map((entry) => entry.id)).toEqual(['c1', '1.1', 'c2', '2.1', '2.2']);
    // With a part above the chapters (few parts, many chapters) the chapters are the level below the parts.
    const parted = [
      { title: 'Part', page: 0, depth: 0 },
      ...[1, 2, 3, 4].flatMap((n) => [
        { title: `Chapter ${n}`, page: n, depth: 1 },
        { title: `Section ${n}a`, page: n, depth: 2 },
        { title: `Section ${n}b`, page: n, depth: 2 },
      ]),
    ];
    const withParts = numberBookmarks(parted, bare);
    expect(withParts?.chapterDepth).toBe(1);
    expect(withParts?.entries.filter((entry) => entry.depth === 1).map((entry) => entry.id)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2']);
    expect(numberBookmarks([{ title: 'only', page: 0, depth: 0 }, { title: 'other', page: 1, depth: 0 }], bare)).toBeUndefined();
    expect(numberBookmarks([], bare)).toBeUndefined();
  });
});
