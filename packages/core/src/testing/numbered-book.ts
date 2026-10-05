import type { OutlineEntry, Rect } from '../model/types.js';
import { A4, buildPdf, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A synthetic textbook for the census of numbered runs: exercise sets headed "1.6 Exercises" (a number and a word, set larger than the text) followed by
 * items "1. Title. text ..." that are numbered on through the chapter, a hanging indent for the lines of an item and in each set one item (the tenth)
 * that runs over a page break; a numbered bibliography of nine entries; a printed contents (lines with leader dots) and an index (numbered entries with lists of page numbers), both of which a
 * census must leave out; a list of four steps in the text (no run); and an answer key at the back that prints the odd items only. Every text is invented.
 *
 * The `truth` says what is printed where, with the region a careful audit gives each exercise and each answer, so that the census, the gate and the
 * repairs can be compared with it.
 */

const W = A4.width;
const H = A4.height;
const LEFT = 85;
const HANG = 108;
const RIGHT = 535;
const PITCH = 15;
const BOTTOM = 765;
const TOP = 100;
const BODY = 11;

export interface NumberedBookItem {
  /** The label as printed ("7"). */
  label: string;
  /** The chapter whose exercise set (or whose answers) it belongs to. */
  chapter: number;
  /** The page of its first line. */
  page: number;
  /** The region around its lines on that page. */
  rect: Rect;
  /** The regions of the rest of it, when it runs over a page break. */
  continues: { page: number; rect: Rect }[];
  /** The first words after the label, to find it in the text of a region. */
  words: string;
}

export interface NumberedBookSet {
  chapter: number;
  /** The id of the outline entry the exercises belong to ("1.6"). */
  section: string;
  /** The heading as printed ("1.6 Exercises"), and the page it is on. */
  heading: string;
  headingPage: number;
  items: NumberedBookItem[];
}

export interface NumberedBookKey {
  chapter: number;
  /** The heading above the answers of the chapter ("A.1 Chapter 1"). */
  heading: string;
  page: number;
  /** Only the odd items are printed. */
  items: NumberedBookItem[];
}

export interface NumberedBookRun {
  /** The id the census gives it (`p3:1`). */
  id: string;
  first: string;
  last: string;
  count: number;
  step: 1 | 2;
  pages: number[];
  /** What it is: an exercise set, an answer key or another list. */
  kind: 'exercises' | 'answers' | 'references';
}

export interface NumberedBook {
  pdf: Uint8Array;
  pageCount: number;
  title: string;
  sets: NumberedBookSet[];
  keys: NumberedBookKey[];
  /** The numbered bibliography: not an exercise set, a fact of the book. */
  references: { page: number; first: string; last: string; count: number; quote: string };
  /** The page of the printed contents, of the index and of the list of four steps (the census must find no run on any of them). */
  contentsPage: number;
  indexPage: number;
  stepsPage: number;
  /** The runs a census finds, in reading order. */
  runs: NumberedBookRun[];
  /** The outline a careful audit gives the book: the chapters, the exercise sets under them (the sections the exercises are filed under), the index, the references and the answers. */
  outline: OutlineEntry[];
  /** For each page what it holds, as a survey record would say. */
  pages: { page: number; kind: 'front' | 'text' | 'exercises' | 'answers' | 'back' }[];
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

/** The region around lines whose first baseline is `first` and last `last` (the margins of the page at the left of the label and at the right of the text). */
function region(first: number, last: number): Rect {
  return { left: round((LEFT - 4) / W), top: round((first - 11) / H), right: round(RIGHT / W), bottom: round((last + 5) / H) };
}

const PRACTICE = [
  ['Orchard yields', 'The table below shows the yield of forty apple trees over three seasons.', 'How many cases and how many variables does the data frame have?'],
  ['Bridge traffic', 'A county counted the cars that crossed a bridge on each day of a month.', 'Is the count a discrete or a continuous variable? Explain.'],
  ['Library visits', 'Researchers asked 200 residents how often they visited the library last year.', 'Identify the population of interest and the sample.', 'Is the study observational or an experiment?'],
  ['Seed trial', 'A botanist planted 60 seeds in two beds and gave only one bed extra water.', 'What are the explanatory and response variables?'],
  ['Bus delays', 'The minutes of delay of 35 buses were recorded on one morning.', 'Describe the shape of the distribution and name a measure of its centre.'],
  ['Reading scores', 'A school tested 90 pupils before and after a new reading programme.', 'Are the two measurements paired? Why or why not?', 'State one possible source of bias in this design.'],
  ['Pond samples', 'Water samples from 25 ponds were tested for acidity at the same hour.', 'Which kind of sampling would give each pond the same chance?'],
  ['Phone survey', 'A phone survey reached 500 households; 120 of them did not answer at all.', 'Name the bias that non-response may cause and its likely direction.', 'How could the survey reduce it?'],
  ['Test scores', 'The scores of eleven pupils on the same test were 61, 70, 72, 75, 78, 80, 81, 83, 85, 90 and 97.', 'Find the median and the range of the scores.', 'Would one more score of 20 change the median much?'],
  ['Weather log', 'A log gives the daily high temperature and whether it rained, for 120 days.', 'Classify each of the two variables as numerical or categorical.'],
  ['Bike lanes', 'A city compared the number of accidents before and after it painted its bike lanes.', 'Can the comparison show that the lanes caused the change? Explain.'],
  ['Tree rings', 'The width of the rings of 18 trunks was measured at one height.', 'Which graph shows the relation of width and age best, and why?', 'Describe what a strong trend would look like.'],
  ['Cafe prices', 'The price of a coffee was noted in 30 cafes of one town and of a neighbouring town.', 'Name the variables and say how they are related in this study.'],
  ['Night shifts', 'A hospital recorded the number of night shifts worked by 45 nurses in a year.', 'Is the mean or the median the better summary if two nurses worked far more than the rest?'],
];

const ANSWER = ['23 observations and 7 variables.', '(a) Discrete. (b) The count is a whole number.', '(a) All residents. (b) The 200 asked. (c) Observational.', 'Explanatory: water. Response: growth.', 'Right skewed; the median is 4 minutes.', '(a) Yes, the same pupils. (b) Pupils may improve with practice.', 'A simple random sample of the ponds.', '(a) Non-response bias. (b) Fewer households are reached.', 'The median is 80 and the range is 77.', 'Numerical: temperature. Categorical: rain.', 'No: many other things changed as well.', 'A scatterplot of width against age.', 'Price and town; price may depend on the town.', 'The median.'];

/** A text broken into lines of at most `max` characters at its spaces (the page writer does not wrap: a line that is too long runs off the page). */
function wrap(text: string, max = 70): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** The lines of exercise `n` of a set (the first starts with the label, a title and a full stop; the questions follow, every text wrapped to the width of the text). */
function itemLines(n: number): string[] {
  const entry = PRACTICE[(n - 1) % PRACTICE.length] as string[];
  const [title, statement, ...questions] = entry as [string, string, ...string[]];
  return [...wrap(`${n}. ${title}. ${statement}`), ...questions.flatMap((question) => wrap(question))];
}

interface Segment {
  page: number;
  first: number;
  last: number;
}

/** Lines laid out one after the other down the pages, an item cut where the page ends. */
class Flow {
  y = 0;
  segments: Segment[] = [];

  constructor(
    private readonly page: () => PdfText[],
    private readonly next: () => void,
    private readonly pageIndex: () => number,
  ) {}

  /** Puts the lines of one item down (the first at the left margin, the others hanging) and says where they went. */
  item(lines: string[], size = BODY): { segments: Segment[] } {
    const segments: Segment[] = [];
    lines.forEach((text, k) => {
      if (this.y > BOTTOM) this.next();
      const last = segments[segments.length - 1];
      if (last === undefined || last.page !== this.pageIndex()) segments.push({ page: this.pageIndex(), first: this.y, last: this.y });
      else last.last = this.y;
      this.page().push({ text, x: k === 0 ? LEFT + 5 : HANG, y: this.y, size });
      this.y += PITCH;
    });
    return { segments };
  }
}

export function buildNumberedBook(): NumberedBook {
  const pages: PdfPageSpec[] = [];
  const kinds: NumberedBook['pages'] = [];
  const outline: OutlineEntry[] = [];
  const add = (kind: NumberedBook['pages'][number]['kind'], furniture = true): PdfText[] => {
    const texts: PdfText[] = [];
    const index = pages.length;
    if (furniture && index >= 2) {
      texts.push({ text: 'Synthetic Statistics Workbook', x: LEFT, y: 50, size: 9 });
      texts.push({ text: String(index + 1), x: W / 2 - 3, y: 800, size: 10 });
    }
    pages.push({ texts });
    kinds.push({ page: index, kind });
    return texts;
  };
  const current = (): PdfText[] => (pages[pages.length - 1] as PdfPageSpec).texts as PdfText[];
  const head = (texts: PdfText[], text: string, y: number, size = 16.5, bold = false): void => {
    texts.push({ text, x: LEFT, y, size, ...(bold ? { font: 'Helvetica-Bold' as const } : {}) });
  };
  const paragraphLines = (texts: PdfText[], lines: string[], y: number, x = LEFT): number => {
    lines.forEach((text, k) => texts.push({ text, x, y: y + k * 16, size: BODY }));
    return y + lines.length * 16;
  };

  // --- The printed contents: leader dots and page numbers (it must be left out) --------------------------------------------------------
  const cover = add('front', false);
  cover.push({ text: 'Synthetic Statistics Workbook', x: 120, y: 330, size: 24, font: 'Helvetica-Bold' });
  cover.push({ text: 'An invented textbook for tests', x: 200, y: 360, size: BODY });
  const contents = add('front', false);
  head(contents, 'Contents', 98, 18, true);
  const entries: [string, number][] = [
    ['1.1 Hello data', 4],
    ['1.2 Data basics', 6],
    ['1.3 Sampling principles', 8],
    ['1.4 Study designs', 10],
    ['1.5 Variables', 12],
    ['1.6 Exercises', 14],
    ['2.1 Summaries', 18],
    ['2.2 Graphs', 20],
    ['2.3 Shapes of data', 22],
    ['2.4 Comparing groups', 24],
    ['2.5 Exercises', 26],
  ];
  entries.forEach(([title, pageNumber], k) => contents.push({ text: `${title} ${'.'.repeat(Math.max(8, 52 - title.length - String(pageNumber).length))} ${pageNumber}`, x: LEFT, y: 140 + k * 22, size: BODY }));

  // --- Chapter 1: a lesson with a list of four steps (no run) -----------------------------------------------------------------------------
  const lesson = add('text');
  const stepsPage = pages.length - 1;
  outline.push({ title: 'Hello data', page: stepsPage, depth: 0, id: 'ch1', label: '1', top: round(90 / H) });
  head(lesson, '1 Hello data', 110, 22, true);
  let y = paragraphLines(lesson, ['A data frame has one row for each case and one column for each variable.', 'The table of the next section shows how the rows and the columns are named,', 'and the exercises at the end of the chapter practise the words.'], 150);
  y = paragraphLines(lesson, ['To summarise a data set in four steps:'], y + 16);
  ['1. Collect the data in a table.', '2. Name every variable and its type.', '3. Draw a graph of each variable.', '4. Describe the shape and the centre.'].forEach((text, k) => lesson.push({ text, x: LEFT + 20, y: y + 6 + k * 16, size: BODY }));
  paragraphLines(lesson, ['These steps are used again in every chapter of this workbook.'], y + 90);

  // --- The exercise sets ------------------------------------------------------------------------------------------------------------------
  const sets: NumberedBookSet[] = [];
  const keysOf = new Map<number, NumberedBookItem[]>();
  const exerciseSet = (chapter: number, section: string, count: number): void => {
    const texts = add('exercises');
    const headingPage = pages.length - 1;
    head(texts, `${section} Exercises`, 108);
    texts.push({ text: 'Answers to odd-numbered exercises can be found in Appendix A.', x: LEFT, y: 140, size: BODY });
    const flow = new Flow(current, () => {
      add('exercises');
      flow.y = TOP;
    }, () => pages.length - 1);
    flow.y = 176;
    const items: NumberedBookItem[] = [];
    for (let n = 1; n <= count; n += 1) {
      const lines = itemLines(n);
      const { segments } = flow.item(lines);
      flow.y += 12;
      const [first, ...rest] = segments as [Segment, ...Segment[]];
      items.push({ label: String(n), chapter, page: first.page, rect: region(first.first, first.last), continues: rest.map((segment) => ({ page: segment.page, rect: region(segment.first, segment.last) })), words: lines[0]?.slice(String(n).length + 2, String(n).length + 22) ?? '' });
    }
    sets.push({ chapter, section, heading: `${section} Exercises`, headingPage, items });
    outline.push({ title: 'Exercises', page: headingPage, depth: 1, id: section, label: section, top: round(98 / H) });
    keysOf.set(chapter, items);
  };
  exerciseSet(1, '1.6', 14);
  const lesson2 = add('text');
  head(lesson2, '2 Summarising data', 110, 22, true);
  outline.push({ title: 'Summarising data', page: pages.length - 1, depth: 0, id: 'ch2', label: '2', top: round(90 / H) });
  paragraphLines(lesson2, ['A summary of one variable gives its centre and its spread.', 'The graphs of this chapter show both at one glance.'], 150);
  exerciseSet(2, '2.5', 14);

  // --- The index: numbered entries with lists of page numbers (it must be left out) ----------------------------------------------------------
  const indexPage = pages.length;
  const index = add('back');
  head(index, 'Index', 98, 18, true);
  outline.push({ title: 'Index', page: indexPage, depth: 0, id: 'index', top: round(85 / H) });
  ['mean', 'median', 'range', 'sample', 'variable', 'case', 'bias', 'table'].forEach((term, k) => index.push({ text: `${k + 1}. ${term}, ${4 + k}, ${9 + 2 * k}, ${30 + k}`, x: LEFT, y: 140 + k * 20, size: BODY }));

  // --- The bibliography: a numbered list that is no exercise set ------------------------------------------------------------------------------
  const referencesPage = pages.length;
  const references = add('back');
  head(references, 'References', 98, 18, true);
  outline.push({ title: 'References', page: referencesPage, depth: 0, id: 'references', top: round(85 / H) });
  const authors = ['Abel, A. (1999)', 'Baker, B. (2003)', 'Cole, C. (2007)', 'Dunn, D. (2010)', 'Evans, E. (2012)', 'Frost, F. (2015)', 'Grant, G. (2018)', 'Hill, H. (2019)', 'Ivey, I. (2021)'];
  authors.forEach((author, k) => {
    references.push({ text: `${k + 1}. ${author}. A study of tables and samples, part ${k + 1}.`, x: LEFT, y: 140 + k * 36, size: BODY });
    references.push({ text: `Journal of Invented Statistics ${3 + k}, pages ${10 + k}-${20 + k}.`, x: HANG, y: 155 + k * 36, size: BODY });
  });

  // --- The answers to the odd exercises at the back --------------------------------------------------------------------------------------------
  const answers = add('answers');
  const answersPage = pages.length - 1;
  head(answers, 'Appendix A  Answers to odd-numbered exercises', 108);
  outline.push({ title: 'Answers to odd-numbered exercises', page: answersPage, depth: 0, id: 'answers', top: round(96 / H) });
  const keys: NumberedBookKey[] = [];
  let at = 150;
  for (const [chapter, items] of keysOf) {
    answers.push({ text: `A.${chapter} Chapter ${chapter}`, x: LEFT, y: at, size: 12, font: 'Helvetica-Bold' });
    at += 26;
    const printed: NumberedBookItem[] = [];
    const odd = items.filter((item) => Number(item.label) % 2 === 1).slice(0, chapter === 1 ? 5 : 6);
    for (const item of odd) {
      const n = Number(item.label);
      answers.push({ text: `${n}. ${ANSWER[(n - 1) % ANSWER.length] as string}`, x: LEFT + 5, y: at, size: BODY });
      printed.push({ label: item.label, chapter, page: answersPage, rect: region(at, at), continues: [], words: (ANSWER[(n - 1) % ANSWER.length] as string).slice(0, 14) });
      at += 22;
    }
    keys.push({ chapter, heading: `A.${chapter} Chapter ${chapter}`, page: answersPage, items: printed });
    at += 14;
  }

  const pdf = buildPdf({ title: 'Synthetic Statistics Workbook', pages });
  const runPages = (items: NumberedBookItem[]): number[] => [...new Set(items.map((item) => item.page))];
  const runs: NumberedBookRun[] = [
    ...sets.map((set): NumberedBookRun => ({ id: `p${set.items[0]?.page as number}:1`, first: '1.', last: `${set.items.length}.`, count: set.items.length, step: 1, pages: runPages(set.items), kind: 'exercises' })),
    { id: `p${referencesPage}:1`, first: '1.', last: '9.', count: 9, step: 1, pages: [referencesPage], kind: 'references' },
    ...keys.map((key): NumberedBookRun => ({ id: `p${answersPage}:1${key.chapter === 1 ? '' : '#2'}`, first: '1.', last: `${key.items.length * 2 - 1}.`, count: key.items.length, step: 2, pages: [answersPage], kind: 'answers' })),
  ];
  runs.sort((a, b) => Number(a.id.slice(1, a.id.indexOf(':'))) - Number(b.id.slice(1, b.id.indexOf(':'))));
  return {
    pdf,
    pageCount: pages.length,
    title: 'Synthetic Statistics Workbook',
    sets,
    keys,
    references: { page: referencesPage, first: '1.', last: '9.', count: 9, quote: 'A study of tables and samples, part 1' },
    contentsPage: 1,
    indexPage,
    stepsPage,
    runs,
    outline,
    pages: kinds,
  };
}
