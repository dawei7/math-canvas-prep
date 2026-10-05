import type { OutlineEntry, Rect } from '../model/types.js';
import { A4, buildPdf, type PdfBox, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A synthetic book with a layout that the finder of exercises cannot read and that a census of numbered runs can: the exercises are items "7)" in boxes, under
 * a heading that stands in the left margin ("Try it yourself", no word of any practice set anywhere), set in two columns; the answers are at the back under
 * "Solutions to Try it yourself" as "7) ...", also in two columns. The layout is not simple on purpose: the boxed items have two to six lines, one item runs over
 * the bottom of a column into the next one, one runs over the bottom of a page onto the next, the text of the lessons runs in the same columns, a list of four
 * numbered steps and two numbered notes at the foot of a page are no run, and every page has its running head and its page number. Every text is invented.
 *
 * `truth` is complete: for every exercise and every answer its label, its page, the box that is drawn around it and the region a careful audit frames (the box
 * with three points of white around it), the regions of the rest of it where it runs over, the first words of its text, what each page holds, and the runs a
 * census must find. A person or an agent that works on the book can be measured against it.
 */

const W = A4.width;
const H = A4.height;
const BODY = 10.5;
const LEADING = 14;
const TOP = 112;
const BOTTOM = 735;
const COLUMN_X = [72, 317] as const;
const BOX_X = [66, 311] as const;
const BOX_W = 226;
const HANG = 15;
const GAP = 12;
const MARGIN_X = 10;

const round = (value: number): number => Math.round(value * 10000) / 10000;
const rectOf = (x: number, top: number, width: number, height: number): Rect => ({ left: round(x / W), top: round(top / H), right: round((x + width) / W), bottom: round((top + height) / H) });

/** The heading in the left margin that precedes every set of exercises, and the heading of the answers (the two phrases of the book). */
export const EXOTIC_MARGIN_HEADING = 'Try it yourself';
export const EXOTIC_ANSWERS_HEADING = 'Solutions to Try it yourself';

export interface ExoticPiece {
  page: number;
  /** The zero-based column of the page (0 left, 1 right) the piece stands in. */
  column: number;
  /** The rectangle of the border that is drawn (exercises only), else the lines of the answer with a margin of a point. */
  box: Rect;
  /** The region to frame: the box with three points of white around it (answers: the lines with a few points of margin). */
  rect: Rect;
}

export interface ExoticItem {
  /** The label as printed ("7"), the printed form is `7)`. */
  label: string;
  chapter: number;
  /** Its first piece; the item is framed as this region with the others as continuations. */
  page: number;
  column: number;
  box: Rect;
  rect: Rect;
  /** The pieces of the item that lie in the next column or on the next page, in reading order (empty for an item that stays where it starts). */
  continues: ExoticPiece[];
  /** The first words after the label, to find the item in the text of its region. */
  words: string;
  /** The lines of the item as printed, the label included in the first. */
  lines: string[];
}

export interface ExoticRun {
  /** What the census calls it (`p2:1_paren`), and the first and the last label as printed. */
  id: string;
  first: string;
  last: string;
  count: number;
  pages: number[];
  kind: 'exercises' | 'answers';
  chapter: number;
}

export interface ExoticBook {
  pdf: Uint8Array;
  pageCount: number;
  title: string;
  truth: {
    /** The two phrases the book prints and the finder does not know. */
    marginHeading: string;
    answersHeading: string;
    exercises: ExoticItem[];
    answers: ExoticItem[];
    /** Where each set of exercises starts, with the heading in the margin: the page and the region of that heading. */
    blocks: { chapter: number; page: number; heading: Rect }[];
    /** The page of the heading of the answers. */
    answersPage: number;
    /** What the census must find, in reading order. */
    runs: ExoticRun[];
    /** Numbered lists that are no run (fewer than five items): the list of four steps in the text of chapter 1 and the two notes at the foot of a page. */
    notRuns: { page: number; labels: string[]; what: string }[];
    /** The outline a careful audit gives the book: one section for each chapter (its exercises are filed under it), the answers and the index. */
    outline: OutlineEntry[];
    /** What each page holds, as a survey record would say it. */
    pages: { page: number; kind: 'front' | 'text' | 'exercises' | 'answers' | 'back' }[];
    /** The items that run over a column, and the one that runs over a page (labels of the first chapter and the chapter). */
    overColumn: { chapter: number; label: string }[];
    overPage: { chapter: number; label: string }[];
  };
}

const CHAPTER_ONE: string[][] = [
  ['List the elements of the set', '{x : x is even, 2 < x < 11}.'],
  ['Write A = {1, 2, 3} and B = {3, 4}.', 'Find the union and the intersection', 'of A and B.'],
  ['Is the function f(x) = x squared', 'one-to-one on the real numbers?', 'Give a reason for your answer.'],
  ['How many subsets does a set of', 'five elements have?'],
  ['Draw a Venn diagram for three sets in', 'which exactly two of the three pairs', 'of sets overlap.', '(a) Shade the union of all three.', '(b) Shade what lies in only one set.'],
  ['Let f(x) = 2x + 3. Find the inverse', 'function and check it by composing', 'the two functions.'],
  ['Prove that the intersection of two', 'sets is contained in each of them.'],
  ['State the domain and the range of', 'g(x) = 1 / (x - 2).'],
  ['A club has 30 members; 18 play chess', 'and 14 play go, and 6 play both.', 'How many play neither game?', 'Explain how you counted.'],
  ['Write the negation of the statement', '"every element of A lies in B".'],
  ['Give an example of a function from the', 'integers to the integers that is onto', 'but not one-to-one.'],
  ['Describe the set (A union B) minus', '(A intersect B) in words.'],
  ['Find all pairs (a, b) of whole numbers', 'with 1 < a < b < 7 whose sum is even.'],
  ['Explain why no function can map a set', 'of three elements onto a set of five', 'elements.'],
  ['Show that the composition of two', 'one-to-one functions is one-to-one.'],
  ['Let A have 4 elements and B have 3.', 'How many functions go from A to B?', 'How many of them are onto?'],
  ['Describe in words the set of all x', 'for which |x - 2| < 3.'],
  ['Find a function from the set {1, 2, 3, 4, 5, 6}', 'onto the set {a, b, c} and say how many', 'such functions exist.'],
  ['Write the set of all subsets of {1, 2, 3}', 'and count those with exactly two', 'elements.'],
];

const CHAPTER_TWO: string[][] = [
  ['In how many ways can five books be', 'placed in a row on a shelf?'],
  ['Evaluate 7! / (5! 2!) and explain what', 'it counts.'],
  ['How many numbers of three different', 'digits can be made from 1 to 9?', '(a) With no other condition.', '(b) That are even.'],
  ['A committee of 3 is chosen from 8', 'people. How many committees are there?'],
  ['Show that choosing 2 of n people gives', 'n(n - 1)/2 pairs.'],
  ['How many arrangements of the letters', 'of the word LEVEL are there?'],
  ['A coin is tossed four times. How many', 'sequences have exactly two heads?'],
  ['Prove that the sum of the first n odd', 'numbers is n squared.'],
  ['Find the number of integers from 1 to', '100 that are divisible by 3 or by 5.'],
  ['Explain the difference between a', 'permutation and a combination of two', 'objects chosen from four.'],
];

const ANSWERS_ONE = ['{4, 6, 8, 10}.', 'The union is {1, 2, 3, 4}; the intersection is {3}.', 'No: f(-2) = f(2) = 4.', '32 subsets.', 'Shade the regions as in the lesson.', 'f inverse(x) = (x - 3)/2; both composites give x.', 'Take x in both sets; then x is in each of them.', 'Domain: all x except 2. Range: all y except 0.', '30 - (18 + 14 - 6) = 4 members play neither.', 'Some element of A does not lie in B.', 'f(n) = n halved and rounded down is onto, and f(2) = f(3).', 'The elements that lie in exactly one of the two sets.', '(2, 4), (2, 6), (3, 5), (4, 6).', 'Three elements have at most three images.', 'If f(a) = f(b) after two steps, each step gives a = b.', '81 functions; 36 of them are onto.', 'All x between -1 and 5.', 'f(n) = a, b, c, a, b, c; there are 540 of them.', 'The 8 subsets; three have two elements.'];
const ANSWERS_TWO = ['120 ways.', '21 pairs of objects.', '(a) 504. (b) 224.', '56 committees.', 'The first person has n - 1 partners; divide by two.', '30 arrangements.', '6 sequences.', 'By induction on n; the step adds 2n + 1.', '33 + 20 - 6 = 47.', 'Order matters for a permutation, not for a combination.'];

/** The text of the lesson of chapter 1 (twelve lines, whole sentences) and of chapter 2 (ten lines). */
const PROSE_ONE = [
  'A set is a collection of objects that',
  'are called its elements. We write x in',
  'A when x is an element of the set A.',
  'Two sets are equal when they have the',
  'same elements, however they are listed.',
  'A function assigns to every element of',
  'one set exactly one element of another.',
  'The first set is the domain and the set',
  'of all the values is the range of it.',
  'We call a function one-to-one when two',
  'different elements never share a value.',
  'It is onto when it takes every value.',
];

const PROSE_TWO = [
  'Counting arguments need a clear picture:',
  'decide first what is being arranged and',
  'whether the order of the choices matters.',
  'If order matters we count permutations;',
  'if it does not we count combinations.',
  'Five books on a shelf can be arranged in',
  '5 x 4 x 3 x 2 x 1 ways, written 5!.',
  'Choosing three people from eight gives',
  'fewer groups than arranging three of them',
  'in a row, as the order does not count.',
];

interface Page {
  texts: PdfText[];
  boxes: PdfBox[];
  kind: 'front' | 'text' | 'exercises' | 'answers' | 'back';
}

/** The pages and a cursor that flows lines down a column, then the next column, then the next page. */
class Layout {
  readonly pages: Page[] = [];
  column: 0 | 1 = 0;
  /** Where a column starts on the page. */
  top = TOP;
  y = TOP;

  page(kind: Page['kind'], head = true): Page {
    const index = this.pages.length;
    const made: Page = { texts: [], boxes: [], kind };
    if (head) {
      made.texts.push({ text: 'Synthetic Sets Workbook', x: COLUMN_X[0], y: 52, size: 9 });
      made.texts.push({ text: String(index + 1), x: W / 2 - 3, y: 800, size: 10 });
    }
    this.pages.push(made);
    this.column = 0;
    this.top = TOP;
    this.y = TOP;
    return made;
  }

  get current(): Page {
    return this.pages[this.pages.length - 1] as Page;
  }

  /** Moves to the top of the next column, or of the first column of a new page; returns whether it is a new page. */
  advance(kind: Page['kind']): boolean {
    if (this.column === 0) {
      this.column = 1;
      this.y = this.top;
      return false;
    }
    this.page(kind);
    return true;
  }

  /** A line of running text at the cursor. */
  line(text: string, options: { bold?: boolean; size?: number; indent?: number } = {}, kind: Page['kind'] = 'text'): void {
    if (this.y > BOTTOM) this.advance(kind);
    this.current.texts.push({ text, x: COLUMN_X[this.column] + (options.indent ?? 0), y: this.y, size: options.size ?? BODY, ...(options.bold === true ? { font: 'Helvetica-Bold' as const } : {}) });
    this.y += LEADING;
  }

  prose(lines: readonly string[]): void {
    for (const text of lines) this.line(text);
    this.y += 8;
  }
}

export function buildExoticBook(): ExoticBook {
  const layout = new Layout();
  const title = 'Synthetic Sets Workbook';

  // Front matter: the title and a preface in one column.
  const cover = layout.page('front', false);
  cover.texts.push({ text: title, x: 150, y: 330, size: 24, font: 'Helvetica-Bold' });
  cover.texts.push({ text: 'An invented book for tests', x: 215, y: 362, size: BODY });
  const preface = layout.page('front', false);
  preface.texts.push({ text: 'Preface', x: COLUMN_X[0], y: 110, size: 18, font: 'Helvetica-Bold' });
  ['This workbook is invented. It has two chapters.', 'Each chapter ends with items to work on, and the', 'answers to all of them are at the back.'].forEach((text, k) => preface.texts.push({ text, x: COLUMN_X[0], y: 150 + k * 16, size: BODY }));

  const exercises: ExoticItem[] = [];
  const blocks: ExoticBook['truth']['blocks'] = [];
  const overColumn: ExoticBook['truth']['overColumn'] = [];
  const overPage: ExoticBook['truth']['overPage'] = [];
  const notRuns: ExoticBook['truth']['notRuns'] = [];
  const outline: OutlineEntry[] = [];

  /** An item in its box, cut where the column or the page ends. */
  const boxedItem = (chapter: number, label: number, text: string[]): void => {
    const lines = text.map((line, k) => (k === 0 ? `${label}) ${line}` : line));
    const pieces: { page: number; column: 0 | 1; first: number; last: number }[] = [];
    let start = layout.pages.length - 1;
    lines.forEach((line, k) => {
      if (layout.y > BOTTOM) {
        const newPage = layout.advance('exercises');
        if (newPage) start = layout.pages.length - 1;
      }
      const piece = pieces[pieces.length - 1];
      if (piece === undefined || piece.page !== layout.pages.length - 1 || piece.column !== layout.column) pieces.push({ page: layout.pages.length - 1, column: layout.column, first: layout.y, last: layout.y });
      else piece.last = layout.y;
      layout.current.texts.push({ text: line, x: BOX_X[layout.column] + 6 + (k === 0 ? 0 : HANG), y: layout.y, size: BODY });
      layout.y += LEADING;
    });
    void start;
    const drawn = pieces.map((piece) => {
      const top = piece.first - 11;
      const height = piece.last + 5 - top;
      (layout.pages[piece.page] as Page).boxes.push({ x: BOX_X[piece.column], y: top, w: BOX_W, h: height });
      return { page: piece.page, column: piece.column, box: rectOf(BOX_X[piece.column], top, BOX_W, height), rect: rectOf(BOX_X[piece.column] - 3, top - 3, BOX_W + 6, height + 6) };
    });
    const [first, ...rest] = drawn as [(typeof drawn)[number], ...(typeof drawn)[number][]];
    exercises.push({
      label: String(label),
      chapter,
      page: first.page,
      column: first.column,
      box: first.box,
      rect: first.rect,
      continues: rest,
      words: (lines[0] as string).slice(String(label).length + 2, String(label).length + 22),
      lines,
    });
    if (rest.some((piece) => piece.page === first.page)) overColumn.push({ chapter, label: String(label) });
    if (rest.some((piece) => piece.page !== first.page)) overPage.push({ chapter, label: String(label) });
    layout.y += GAP + 2;
  };

  /** The heading in the left margin, on a row of its own above the first item. */
  const marginHeading = (chapter: number): void => {
    const y = layout.y;
    layout.current.texts.push({ text: EXOTIC_MARGIN_HEADING, x: MARGIN_X, y, size: 7.5, font: 'Helvetica-Bold' });
    blocks.push({ chapter, page: layout.pages.length - 1, heading: rectOf(MARGIN_X - 1, y - 8, 56, 11) });
    outline.push({ title: EXOTIC_MARGIN_HEADING, page: layout.pages.length - 1, depth: 1, id: `ex${chapter}`, top: round((y - 9) / H) });
    layout.y += 26;
  };

  // Chapter 1: the lesson, a list of four steps (no run), and the first set of items.
  layout.page('exercises');
  outline.push({ title: 'Sets and functions', page: layout.pages.length - 1, depth: 0, id: 'ch1', label: '1', top: round(96 / H) });
  layout.line('1 Sets and functions', { bold: true, size: 18 }, 'exercises');
  layout.y += 8;
  layout.prose(PROSE_ONE);
  layout.line('To compare two sets in four steps:');
  const stepsPage = layout.pages.length - 1;
  ['1. List the elements of each set.', '2. Mark the elements that occur twice.', '3. Count the elements of each kind.', '4. Write down the result.'].forEach((text) => layout.line(text, { indent: 16 }));
  notRuns.push({ page: stepsPage, labels: ['1', '2', '3', '4'], what: 'a list of four steps in the text' });
  layout.y += 30;
  marginHeading(1);
  CHAPTER_ONE.forEach((text, k) => boxedItem(1, k + 1, text));

  // Chapter 2: its lesson on a new page, two numbered notes under the text (no run) and the second set.
  layout.page('exercises');
  outline.push({ title: 'Counting', page: layout.pages.length - 1, depth: 0, id: 'ch2', label: '2', top: round(96 / H) });
  layout.line('2 Counting', { bold: true, size: 18 }, 'exercises');
  layout.y += 8;
  layout.prose(PROSE_TWO);
  ['1. A set may also be empty.', '2. The empty set is written with a slash.'].forEach((text) => layout.line(text, { indent: 16, size: 8.5 }));
  notRuns.push({ page: layout.pages.length - 1, labels: ['1', '2'], what: 'two numbered notes under the text' });
  layout.y = 330;
  layout.column = 0;
  marginHeading(2);
  CHAPTER_TWO.forEach((text, k) => boxedItem(2, k + 1, text));

  // The answers at the back: a heading across the page and the answers in two columns, a line to each answer or two.
  layout.page('answers');
  const answersPage = layout.pages.length - 1;
  outline.push({ title: EXOTIC_ANSWERS_HEADING, page: answersPage, depth: 0, id: 'solutions', top: round(86 / H) });
  layout.current.texts.push({ text: EXOTIC_ANSWERS_HEADING, x: 165, y: 100, size: 15, font: 'Helvetica-Bold' });
  layout.top = TOP + 18;
  layout.y = layout.top;
  const answers: ExoticItem[] = [];
  const answer = (chapter: number, label: number, text: string): void => {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = `${label}) `;
    for (const word of words) {
      if ((current + word).length > 36) {
        lines.push(current.trimEnd());
        current = '';
      }
      current += `${word} `;
    }
    lines.push(current.trimEnd());
    const pieces: { page: number; column: 0 | 1; first: number; last: number }[] = [];
    lines.forEach((line, k) => {
      if (layout.y > BOTTOM) layout.advance('answers');
      const piece = pieces[pieces.length - 1];
      if (piece === undefined || piece.page !== layout.pages.length - 1 || piece.column !== layout.column) pieces.push({ page: layout.pages.length - 1, column: layout.column, first: layout.y, last: layout.y });
      else piece.last = layout.y;
      layout.current.texts.push({ text: line, x: COLUMN_X[layout.column] + (k === 0 ? 0 : HANG), y: layout.y, size: BODY });
      layout.y += LEADING;
    });
    const drawn = pieces.map((piece) => ({ page: piece.page, column: piece.column, box: rectOf(COLUMN_X[piece.column] - 2, piece.first - 10, BOX_W - 8, piece.last - piece.first + 14), rect: rectOf(COLUMN_X[piece.column] - 4, piece.first - 11, BOX_W - 4, piece.last - piece.first + 17) }));
    const [first, ...rest] = drawn as [(typeof drawn)[number], ...(typeof drawn)[number][]];
    answers.push({ label: String(label), chapter, page: first.page, column: first.column, box: first.box, rect: first.rect, continues: rest, words: (lines[0] as string).slice(String(label).length + 2, String(label).length + 16), lines });
    layout.y += 6;
  };
  const answerHead = (text: string): void => {
    layout.y += 16;
    layout.line(text, { bold: true, size: 12 }, 'answers');
    layout.y += 2;
  };
  answerHead('Chapter 1');
  ANSWERS_ONE.forEach((text, k) => answer(1, k + 1, text));
  // The answers of chapter 1 stay in the first column; chapter 2 starts at the top of the second one (a heading right under an answer would look like its end).
  if (layout.column !== 0) throw new Error('the answers of chapter 1 must fit in the first column');
  layout.advance('answers');
  answerHead('Chapter 2');
  ANSWERS_TWO.forEach((text, k) => answer(2, k + 1, text));

  // The index, the back matter: a few lines of terms and page numbers in two columns (no labels).
  const index = layout.page('back');
  outline.push({ title: 'Index', page: layout.pages.length - 1, depth: 0, id: 'index', top: round(86 / H) });
  index.texts.push({ text: 'Index', x: COLUMN_X[0], y: 100, size: 18, font: 'Helvetica-Bold' });
  ['union, 3', 'intersection, 3', 'function, 4', 'one-to-one, 4', 'onto, 4', 'subset, 3'].forEach((text, k) => index.texts.push({ text, x: COLUMN_X[0], y: 140 + k * 16, size: BODY }));
  ['permutation, 5', 'combination, 5', 'empty set, 5', 'domain, 4', 'range, 4', 'Venn diagram, 3'].forEach((text, k) => index.texts.push({ text, x: COLUMN_X[1], y: 140 + k * 16, size: BODY }));

  const specs: PdfPageSpec[] = layout.pages.map((entry) => ({ texts: entry.texts, boxes: entry.boxes }));
  const pdf = buildPdf({ title, pages: specs });

  const runOf = (items: ExoticItem[], kind: ExoticRun['kind'], chapter: number): ExoticRun => {
    const first = items[0] as ExoticItem;
    return { id: `p${first.page}:1_paren`, first: '1)', last: `${items.length})`, count: items.length, pages: [...new Set(items.map((item) => item.page))], kind, chapter };
  };
  const one = (list: ExoticItem[], chapter: number): ExoticItem[] => list.filter((item) => item.chapter === chapter);
  const runs: ExoticRun[] = [runOf(one(exercises, 1), 'exercises', 1), runOf(one(exercises, 2), 'exercises', 2), runOf(one(answers, 1), 'answers', 1), runOf(one(answers, 2), 'answers', 2)];
  // The answers of the two chapters stand on one page: the second run's first item is on the same page as the first one's, so its id gets "#2".
  if (runs[2] && runs[3] && runs[2].id === runs[3].id) runs[3] = { ...(runs[3] as ExoticRun), id: `${(runs[3] as ExoticRun).id}#2` };
  return {
    pdf,
    pageCount: layout.pages.length,
    title,
    truth: {
      marginHeading: EXOTIC_MARGIN_HEADING,
      answersHeading: EXOTIC_ANSWERS_HEADING,
      exercises,
      answers,
      blocks,
      answersPage,
      runs,
      notRuns,
      outline,
      pages: layout.pages.map((entry, page) => ({ page, kind: entry.kind })),
      overColumn,
      overPage,
    },
  };
}
