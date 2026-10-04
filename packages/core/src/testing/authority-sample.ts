import type { OutlineEntry, Rect, Region } from '../model/types.js';
import { buildPdf, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A synthetic four-page workbook for tests, examples and documentation of the authority workflow: two chapters with
 * sections whose exercises carry the numbers the book prints (1., 2., 3. with (a) and (b)), an exercise that continues on
 * the next page, and an answer key on the last page. Its text is invented; nothing in it comes from a real book.
 *
 * The same numbers appear in `exercises` (where each exercise is, with the statement it shares and where its answer is
 * printed) and in `sections` (the outline with ids, labels and heading positions), so that a test can mark the whole book
 * and know what the result must be.
 */

export interface AuthoritySampleExercise {
  /** The id of the outline entry (the section) the exercise belongs to. */
  section: string;
  /** The number as the book prints it, without the closing "." or ")". */
  label: string;
  page: number;
  rect: Rect;
  /** The statement printed once above `3a` and `3b`. */
  context?: Region[];
  continues?: Region[];
  /** Where the answer is printed: one line of the key. */
  solution: Region[];
}

export interface AuthoritySample {
  pdf: Uint8Array;
  title: string;
  pageCount: number;
  /** The PDF's own bookmarks (no ids). */
  pdfOutline: { title: string; page: number; depth: number }[];
  /** The sections of the book: the outline with ids, printed labels and the position of each heading. */
  sections: OutlineEntry[];
  exercises: AuthoritySampleExercise[];
}

const LEFT = 72;
const HEIGHT = 842;
const HEADER = 'Synthetic Pre-Algebra Workbook';

/** A one-line region around the text whose baseline is `y` points from the top. */
function line(page: number, y: number): Region {
  return { page, rect: { left: 0.1, top: round((y - 11) / HEIGHT), right: 0.9, bottom: round((y + 5) / HEIGHT) } };
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

export function buildAuthoritySample(): AuthoritySample {
  const pages: PdfPageSpec[] = [];
  const total = 4;
  const chrome = (n: number): PdfText[] => [
    { text: HEADER, x: LEFT, y: 40, size: 9 },
    { text: `Page ${n} of ${total}`, x: 270, y: 806, size: 9 },
  ];
  const bold = (text: string, y: number, size: number): PdfText => ({ text, x: LEFT, y, size, font: 'Helvetica-Bold' });
  const plain = (text: string, y: number): PdfText => ({ text, x: LEFT, y, size: 11 });

  pages.push({
    texts: [
      ...chrome(1),
      bold('Pre-Algebra Workbook', 110, 20),
      bold('Chapter 1  Integers', 170, 16),
      bold('1.1  Adding integers', 230, 13),
      bold('Exercises 1.1', 262, 11),
      plain('1. Compute 3 + (-5).', 290),
      plain('2. Compute (-4) + (-6).', 320),
      plain('3. Evaluate each sum.', 350),
      plain('a) 7 + (-9)', 368),
      plain('b) (-2) + 11', 386),
    ],
  });
  pages.push({
    texts: [
      ...chrome(2),
      bold('1.2  Subtracting integers', 100, 13),
      plain('1. Compute 5 - 8.', 140),
      plain('2. Compute (-3) - (-7).', 170),
      plain('3. Which is larger, (-2) - 4 or (-2) + 4? Explain.', 200),
      plain('4. A diver is 12 m below the surface and rises 5 m, then dives', 770),
    ],
  });
  pages.push({
    texts: [
      ...chrome(3),
      plain('3 m more. How far below the surface is the diver now?', 96),
      bold('Chapter 2  Fractions', 170, 16),
      bold('2.1  Equivalent fractions', 230, 13),
      plain('1. Write 2/3 with the denominator 12.', 290),
      plain('2. Are 3/4 and 9/12 equal? Explain.', 320),
    ],
  });
  pages.push({
    texts: [
      ...chrome(4),
      bold('Answers', 100, 16),
      bold('Section 1.1', 140, 11),
      plain('1. -2', 160),
      plain('2. -10', 176),
      plain('3a. -2', 192),
      plain('3b. 9', 208),
      bold('Section 1.2', 240, 11),
      plain('1. -3', 260),
      plain('2. 4', 276),
      plain('3. (-2) + 4 is larger', 292),
      plain('4. 10 m below', 308),
      bold('Section 2.1', 340, 11),
      plain('1. 8/12', 360),
      plain('2. Yes: 9/12 = 3/4', 376),
    ],
  });

  const pdfOutline = [
    { title: 'Chapter 1 Integers', page: 0, depth: 0 },
    { title: '1.1 Adding integers', page: 0, depth: 1 },
    { title: '1.2 Subtracting integers', page: 1, depth: 1 },
    { title: 'Chapter 2 Fractions', page: 2, depth: 0 },
    { title: '2.1 Equivalent fractions', page: 2, depth: 1 },
    { title: 'Answers', page: 3, depth: 0 },
  ];
  const top = (y: number, size: number): number => round((y - size) / HEIGHT);
  const sections: OutlineEntry[] = [
    { title: 'Chapter 1 Integers', page: 0, depth: 0, id: 'c1', label: 'Chapter 1', top: top(170, 16) },
    { title: '1.1 Adding integers', page: 0, depth: 1, id: '1.1', label: '1.1', top: top(230, 13) },
    { title: '1.2 Subtracting integers', page: 1, depth: 1, id: '1.2', label: '1.2', top: top(100, 13) },
    { title: 'Chapter 2 Fractions', page: 2, depth: 0, id: 'c2', label: 'Chapter 2', top: top(170, 16) },
    { title: '2.1 Equivalent fractions', page: 2, depth: 1, id: '2.1', label: '2.1', top: top(230, 13) },
    { title: 'Answers', page: 3, depth: 0, id: 'answers', top: top(100, 16) },
  ];

  const statement = [line(0, 350)];
  const exercises: AuthoritySampleExercise[] = [
    { section: '1.1', label: '1', ...line(0, 290), solution: [line(3, 160)] },
    { section: '1.1', label: '2', ...line(0, 320), solution: [line(3, 176)] },
    { section: '1.1', label: '3a', ...line(0, 368), context: statement, solution: [line(3, 192)] },
    { section: '1.1', label: '3b', ...line(0, 386), context: statement, solution: [line(3, 208)] },
    { section: '1.2', label: '1', ...line(1, 140), solution: [line(3, 260)] },
    { section: '1.2', label: '2', ...line(1, 170), solution: [line(3, 276)] },
    { section: '1.2', label: '3', ...line(1, 200), solution: [line(3, 292)] },
    { section: '1.2', label: '4', ...line(1, 770), continues: [line(2, 96)], solution: [line(3, 308)] },
    { section: '2.1', label: '1', ...line(2, 290), solution: [line(3, 360)] },
    { section: '2.1', label: '2', ...line(2, 320), solution: [line(3, 376)] },
  ];

  return { pdf: buildPdf({ title: 'Pre-Algebra Workbook', pages, outline: pdfOutline }), title: 'Pre-Algebra Workbook', pageCount: total, pdfOutline, sections, exercises };
}
