import { A4, buildPdf, type PdfBox, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A small synthetic textbook for testing the book heuristics (sections, exercises, solutions) without a real book.
 * Everything is invented, but the layout follows what printed textbooks do: a printed table of contents with dot
 * leaders (with a typo and with lines that were merged by the text extraction), chapter openers with their own list of
 * sections, lesson pages that start with a small label line above a large heading, practice sets of several kinds
 * (two and three columns that count along the rows, word problems with indented continuation lines, items that stand
 * beside a figure, instructions printed once for a group of items, an instruction and an item that cross a page break)
 * and an answer key at the back (a header for each chapter, a small marker and a header for each section, answers in
 * three columns that flow across a page break, fractions as a small second line).
 *
 * The returned `truth` says what is printed where, so that tests can compare what a heuristic finds with it.
 */

export interface BookAnchor {
  /** Zero-based page. */
  page: number;
  /** A point inside the printed text, in page fractions (origin top-left). */
  x: number;
  y: number;
}

export interface BookTruthSection {
  /** The id a proposal gives the section: the printed label ("0.1"). */
  id: string;
  label: string;
  /** The title as the lesson and the outline should read it (after normalising). */
  title: string;
  /** The title as the printed table of contents spells it (with its typo or its "&"). */
  tocTitle: string;
  chapter: string;
  lessonPage: number;
  practiceFirstPage: number;
  practiceLastPage: number;
}

export interface BookTruthChapter {
  id: string;
  label: string;
  title: string;
  openerPage: number;
}

export interface BookTruthItem {
  section: string;
  label: string;
  /** Page of the line that holds the printed number. */
  page: number;
  /** One anchor per printed line of the item, on all pages it occupies. */
  anchors: BookAnchor[];
  /** Index into `instructions` of the instruction that governs the item. */
  instruction: number;
  /** The layout: the number of columns of the row the item sits in, or `figure` for an item with a figure. */
  layout: 'rows1' | 'rows2' | 'rows3' | 'figure';
  /** The text printed after the number (without the figure's own labels). */
  text: string;
}

export interface BookTruthInstruction {
  section: string;
  anchors: BookAnchor[];
  text: string;
}

export interface BookTruthAnswer {
  section: string;
  label: string;
  page: number;
  anchors: BookAnchor[];
  /** The answer as printed after the number. */
  text: string;
}

export interface BookTruth {
  /** The printed page number is the zero-based page index plus this. */
  pageOffset: number;
  chapters: BookTruthChapter[];
  sections: BookTruthSection[];
  items: BookTruthItem[];
  instructions: BookTruthInstruction[];
  answers: BookTruthAnswer[];
  /** First page of the answer key, when there is one. */
  answerKeyPage?: number;
  /** Zero-based pages of the printed table of contents. */
  tocPages: number[];
  title: string;
}

export interface SyntheticBook {
  pdf: Uint8Array;
  pageCount: number;
  truth: BookTruth;
}

export interface SyntheticBookOptions {
  /** Print the table of contents (default true). */
  toc?: boolean;
  /** Print the answer key at the back (default true). */
  answerKey?: boolean;
  /** Print the small section markers in the answer key (default true); without them only the headers name the sections. */
  markers?: boolean;
}

const W = A4.width;
const H = A4.height;
const LEFT = 85;
const COLUMN_X: Record<1 | 2 | 3, number[]> = { 1: [LEFT], 2: [LEFT, 308], 3: [LEFT, 233, 382] };
const INDENT = 19.5;
const FIRST_Y = 96;
const BOTTOM = 760;
const ROW = 25;
const LEADING = 14.7;
const BODY = 12;
const KEY_PITCH = 25.5;

const TITLE = 'Synthetic Algebra Workbook';

/** The text width of Helvetica, estimated well enough to centre a heading. */
function width(text: string, size: number, bold: boolean): number {
  return text.length * size * (bold ? 0.58 : 0.52);
}

class PageBuilder {
  readonly texts: PdfText[] = [];
  readonly boxes: PdfBox[] = [];
  constructor(readonly index: number) {}

  text(text: string, x: number, baseline: number, size = BODY, bold = false): void {
    const item: PdfText = { text, x, y: baseline, size };
    if (bold) item.font = 'Helvetica-Bold';
    this.texts.push(item);
  }

  centered(text: string, baseline: number, size: number, bold: boolean): void {
    this.text(text, Math.max(20, (W - width(text, size, bold)) / 2), baseline, size, bold);
  }

  anchor(x: number, baseline: number, size = BODY): BookAnchor {
    return { page: this.index, x: Math.round(((x + 3) / W) * 10000) / 10000, y: Math.round(((baseline - 0.3 * size) / H) * 10000) / 10000 };
  }
}

/** A dotted leader line as a table of contents prints it: "1.2 Title.........14". */
function leaders(label: string | undefined, title: string, page: number, total = 40): string {
  const head = `${label !== undefined ? `${label} ` : ''}${title}`;
  const tail = String(page);
  return `${head}${'.'.repeat(Math.max(3, total - head.length - tail.length))}${tail}`;
}

/** The list printed on a chapter opener: a space before the dots and a long leader. */
function openerLine(label: string, title: string, page: number): string {
  return `${label} ${title} ${'.'.repeat(70)}${page}`;
}

const LESSON_TEXT = [
  'This lesson explains the idea with a few worked examples. Read each step',
  'carefully and try to predict the next line before you read it. The practice',
  'set that follows has more problems of the same kind, grouped by what is asked.',
  'Remember that every answer should be checked by substituting it back.',
];

interface SectionPlan {
  label: string;
  title: string;
  tocTitle: string;
  chapter: number;
}

const CHAPTERS = [
  { n: 0, title: 'Number Sense' },
  { n: 1, title: 'Graphs' },
];

const SECTIONS: SectionPlan[] = [
  { label: '0.1', title: 'Whole Numbers', tocTitle: 'Whole Numbres', chapter: 0 },
  { label: '0.2', title: 'Word Problems', tocTitle: 'Word Problems', chapter: 0 },
  { label: '1.1', title: 'Points and Lines', tocTitle: 'Points/Lines', chapter: 1 },
  { label: '1.2', title: 'Triangles and Ratios', tocTitle: 'Triangles & Ratios', chapter: 1 },
];

interface Row {
  label: string;
  text: string;
  /** A fraction's denominator, printed as a small second line. */
  den?: string;
}

interface KeyRow {
  label: string;
  text: string;
  den?: string;
}

export function buildSyntheticBook(options: SyntheticBookOptions = {}): SyntheticBook {
  const withToc = options.toc !== false;
  const withKey = options.answerKey !== false;
  const withMarkers = options.markers !== false;
  const pages: PageBuilder[] = [];
  const truth: BookTruth = { pageOffset: 1, chapters: [], sections: [], items: [], instructions: [], answers: [], tocPages: [], title: TITLE };

  const addPage = (footer = true): PageBuilder => {
    const page = new PageBuilder(pages.length);
    pages.push(page);
    if (footer && page.index >= 2) page.text(String(page.index + 1), W / 2 - 3, 787, 10);
    return page;
  };

  // --- Front matter --------------------------------------------------------------------------------------------------
  const cover = addPage(false);
  cover.centered(TITLE, 330, 24, true);
  cover.centered('An invented textbook for tests', 360, BODY, false);
  const legal = addPage(false);
  legal.text('This book is synthetic. It contains no text of any real book.', LEFT, 120);

  let tocPage: PageBuilder | undefined;
  if (withToc) {
    tocPage = addPage();
    truth.tocPages.push(tocPage.index);
  }

  const sectionStart = new Map<string, number>();
  const practiceFirst = new Map<string, number>();
  const practiceLast = new Map<string, number>();
  const keyRows = new Map<string, KeyRow[]>();
  const chapterOpener = new Map<number, number>();
  const openers: { page: PageBuilder; sections: SectionPlan[] }[] = [];

  // --- Practice sets -------------------------------------------------------------------------------------------------
  class Practice {
    page: PageBuilder;
    y = 0;
    private instructionIndex = -1;

    constructor(private readonly section: SectionPlan) {
      this.page = addPage();
      practiceFirst.set(section.label, this.page.index);
      this.page.centered(`${section.label} Practice - ${section.title}`, 98, 16.9, true);
      this.y = 148;
      this.done();
    }

    private newPage(): void {
      this.page = addPage();
      this.y = FIRST_Y;
    }

    private done(): void {
      practiceLast.set(this.section.label, this.page.index);
    }

    /** Moves the cursor down (to put the next thing near the bottom of the page). */
    moveTo(y: number): void {
      if (y > this.y) this.y = y;
    }

    instruction(lines: string[], indentSecond = false): void {
      const anchors: BookAnchor[] = [];
      lines.forEach((line, index) => {
        if (this.y > BOTTOM) this.newPage();
        const x = LEFT + (index > 0 && indentSecond ? 14 : 0);
        this.page.text(line, x, this.y, BODY, true);
        anchors.push(this.page.anchor(x, this.y));
        this.y += LEADING;
      });
      this.y += 14;
      truth.instructions.push({ section: this.section.label, anchors, text: lines.join(' ') });
      this.instructionIndex = truth.instructions.length - 1;
      this.done();
    }

    private record(layout: BookTruthItem['layout'], row: Row, anchors: BookAnchor[]): void {
      truth.items.push({
        section: this.section.label,
        label: row.label,
        page: (anchors[0] as BookAnchor).page,
        anchors,
        instruction: this.instructionIndex,
        layout,
        text: row.text,
      });
      const list = keyRows.get(this.section.label) ?? [];
      list.push({ label: row.label, text: answerFor(this.section.label, row.label), ...(row.den !== undefined ? { den: '3' } : {}) });
      keyRows.set(this.section.label, list);
      this.done();
    }

    /** Short items in rows of 2 or 3 columns, numbered along the rows. */
    rows(columns: 2 | 3, items: Row[]): void {
      for (let start = 0; start < items.length; start += columns) {
        const row = items.slice(start, start + columns);
        const height = ROW + (row.some((entry) => entry.den !== undefined) ? 8 : 0);
        if (this.y + height > BOTTOM + 8) this.newPage();
        row.forEach((entry, column) => {
          const x = COLUMN_X[columns][column] as number;
          const anchors = [this.page.anchor(x, this.y)];
          this.page.text(`${entry.label}) ${entry.text}`, x, this.y);
          if (entry.den !== undefined) {
            this.page.text(entry.den, x + 34, this.y + 11, 8);
            anchors.push(this.page.anchor(x + 34, this.y + 11, 8));
          }
          this.record(columns === 2 ? 'rows2' : 'rows3', entry, anchors);
        });
        this.y += height;
      }
      this.y += 6;
    }

    /** A word problem: "N. text" with indented continuation lines. A page break may fall between its lines. */
    problem(label: string, lines: string[]): void {
      const anchors: BookAnchor[] = [];
      lines.forEach((line, index) => {
        if (this.y > BOTTOM) this.newPage();
        const x = index === 0 ? LEFT : LEFT + INDENT;
        this.page.text(index === 0 ? `${label}. ${line}` : line, x, this.y);
        anchors.push(this.page.anchor(x, this.y));
        this.y += LEADING;
      });
      this.y += 12;
      this.record('rows1', { label, text: lines.join(' ') }, anchors);
    }

    /** An item whose number stands alone beside a figure (a filled box with small labels), then blank space. */
    figure(label: string, height: number, tags: string[], blank = 28): void {
      if (this.y + height > BOTTOM + 20) this.newPage();
      const top = this.y - 10;
      const labelY = this.y + height / 2 - 4;
      this.page.text(`${label})`, LEFT, labelY);
      const anchors = [this.page.anchor(LEFT, labelY)];
      const boxLeft = LEFT + 62;
      this.page.boxes.push({ x: boxLeft, y: top + 4, w: 120, h: height - 8, fill: 0.82 });
      tags.forEach((tag, index) => {
        const tx = boxLeft + 14 + (index % 3) * 38;
        const ty = top + 22 + Math.floor(index / 3) * 26;
        this.page.text(tag, tx, ty, 10);
        anchors.push(this.page.anchor(tx, ty, 10));
      });
      this.record('figure', { label, text: '' }, anchors);
      this.y += height + blank;
    }

    /** Figure items side by side (one row): the numbers stand alone and a figure hangs below each. */
    figureRow(entries: { label: string; tags: string[] }[], height: number): void {
      if (this.y + height > BOTTOM + 20) this.newPage();
      const labelY = this.y;
      const collected: BookAnchor[][] = [];
      entries.forEach((entry, column) => {
        const x = COLUMN_X[2][column] as number;
        this.page.text(`${entry.label})`, x, labelY);
        const anchors = [this.page.anchor(x, labelY)];
        const boxTop = labelY + 14;
        this.page.boxes.push({ x: x + 16, y: boxTop, w: 110, h: height - 30, fill: 0.84 });
        entry.tags.forEach((tag, index) => {
          const tx = x + 24 + index * 30;
          const ty = boxTop + 18 + (index % 2) * 22;
          this.page.text(tag, tx, ty, 10);
          anchors.push(this.page.anchor(tx, ty, 10));
        });
        collected.push(anchors);
      });
      entries.forEach((entry, column) => this.record('figure', { label: entry.label, text: '' }, collected[column] as BookAnchor[]));
      this.y += height + 18;
    }
  }

  // --- Lessons and openers -------------------------------------------------------------------------------------------
  const lesson = (section: SectionPlan, pageCount = 1): void => {
    const chapter = CHAPTERS[section.chapter] as { n: number; title: string };
    const first = addPage();
    sectionStart.set(section.label, first.index);
    first.text(section.label, LEFT, 94);
    first.centered(`${chapter.title} - ${section.title}`, 114, 16.9, true);
    first.text(`Objective: Work with ${section.title.toLowerCase()}.`, LEFT, 150, BODY, true);
    LESSON_TEXT.forEach((line, index) => first.text(line, LEFT, 180 + index * LEADING));
    first.text('Example 1.', LEFT, 270, BODY, true);
    first.text('3 + 4 Add the numbers. 7 Our Solution', 150, 300);
    for (let extra = 1; extra < pageCount; extra += 1) {
      const next = addPage();
      next.text('Example 2.', LEFT, 110, BODY, true);
      next.text('5 + 6 Add the numbers. 11 Our Solution', 150, 140);
    }
  };

  const opener = (n: number): void => {
    const chapter = CHAPTERS[n] as { n: number; title: string };
    const page = addPage();
    chapterOpener.set(n, page.index);
    page.centered(`Chapter ${chapter.n} : ${chapter.title}`, 98, 16.9, true);
    openers.push({ page, sections: SECTIONS.filter((section) => section.chapter === n) });
  };

  // --- Chapter 0 -----------------------------------------------------------------------------------------------------
  opener(0);
  const s01 = SECTIONS[0] as SectionPlan;
  lesson(s01);
  {
    const practice = new Practice(s01);
    practice.instruction(['Evaluate each expression.']);
    const sums: Row[] = [];
    for (let n = 1; n <= 30; n += 1) sums.push({ label: String(n), text: `${((n * 7) % 19) + 1} - ${((n * 5) % 13) + 2}` });
    practice.rows(2, sums);
    practice.instruction(['Find each product.']);
    const products: Row[] = [];
    for (let n = 31; n <= 47; n += 1) products.push({ label: String(n), text: `(${((n * 3) % 9) + 2})(${((n * 5) % 7) + 2})` });
    practice.rows(2, products);
    practice.instruction(['Find each quotient.']);
    const quotients: Row[] = [];
    for (let n = 48; n <= 70; n += 1) quotients.push({ label: String(n), text: `${(((n * 11) % 8) + 2) * 6} / ${(n % 4) + 2}`, ...(n % 3 === 0 ? { den: '3' } : {}) });
    practice.rows(2, quotients);
  }

  const s02 = SECTIONS[1] as SectionPlan;
  lesson(s02, 2);
  {
    const practice = new Practice(s02);
    practice.instruction(['Solve each word problem.']);
    for (let n = 1; n <= 6; n += 1) {
      practice.problem(String(n), [
        `A shop sells ${n + 3} boxes of pens each day and every box holds ${n + 5} pens.`,
        `How many pens does the shop sell in ${n + 1} days?`,
      ]);
    }
    practice.moveTo(752);
    practice.instruction(['Solve each of the following problems by setting up an equation', 'and then solving it for the unknown number.']);
    for (let n = 7; n <= 10; n += 1) {
      practice.problem(String(n), [
        `The sum of two numbers is ${n * 4}. One number is ${n} more than the other.`,
        'Find both numbers and explain how you found them using an',
        'equation that you can check by substituting.',
      ]);
    }
    practice.moveTo(724);
    practice.problem('11', [
      'A train leaves a station at noon and travels at a steady speed of 60 miles per hour.',
      'A second train leaves two hours later on the same track at 90 miles per hour.',
      'When does the second train catch up with the first train?',
      'Give the time as an hour of the afternoon.',
    ]);
    for (let n = 12; n <= 14; n += 1) practice.problem(String(n), [`Write an equation for a number that is ${n} times as large as ${n - 7}.`, 'Then find the number.']);
  }

  // --- Chapter 1 -----------------------------------------------------------------------------------------------------
  opener(1);
  const s11 = SECTIONS[2] as SectionPlan;
  lesson(s11);
  {
    const practice = new Practice(s11);
    practice.instruction(['State the coordinates of each point.']);
    practice.figure('1', 120, ['D', 'K', 'G', 'J', 'E', 'I']);
    practice.instruction(['Plot each point.']);
    practice.problem('2', ['L(-5, 5) K(1, 0) J(-3, 4)', 'I(-3, 0) H(-4, 2) G(4, -2)']);
    practice.instruction(['Sketch the graph of each line.']);
    const lines: Row[] = [];
    for (let n = 3; n <= 12; n += 1) lines.push({ label: String(n), text: `y = ${n - 6}x + ${n % 5}`, ...(n % 4 === 3 ? { den: '2' } : {}) });
    practice.rows(2, lines);
  }

  const s12 = SECTIONS[3] as SectionPlan;
  lesson(s12);
  {
    const practice = new Practice(s12);
    practice.instruction(['Find the value of each. Round your answers to the nearest', 'tenth.'], true);
    practice.rows(3, [
      { label: '1', text: 'sin 30' },
      { label: '2', text: 'tan 45' },
      { label: '3', text: 'cos 60' },
      { label: '4', text: 'sin 90' },
      { label: '5', text: 'cos 0' },
      { label: '6', text: 'tan 0' },
    ]);
    practice.instruction(['Find the measure of each side indicated.']);
    const labels = [
      ['7', 'A', 'B', 'x'],
      ['8', 'C', '13', 'x'],
      ['9', 'B', '5', 'C'],
      ['10', 'A', '24', 'x'],
      ['11', 'P', 'Q', 'x'],
      ['12', 'R', '9', 'x'],
      ['13', 'T', '6', 'x'],
      ['14', 'S', '8', 'x'],
      ['15', 'U', '7', 'x'],
      ['16', 'V', '4', 'x'],
    ];
    for (let index = 0; index < labels.length; index += 2) {
      practice.figureRow(
        labels.slice(index, index + 2).map(([label, ...tags]) => ({ label: label as string, tags })),
        120,
      );
    }
  }

  // --- The answer key ------------------------------------------------------------------------------------------------
  if (withKey) {
    let page = addPage();
    truth.answerKeyPage = page.index;
    let y = 98;
    SECTIONS.forEach((section, sectionIndex) => {
      const previous = SECTIONS[sectionIndex - 1];
      const newChapter = previous === undefined || previous.chapter !== section.chapter;
      if (sectionIndex > 0) y += newChapter ? 36 : 26;
      if (y + (newChapter ? 41 : 0) + 43 + 3 * KEY_PITCH > BOTTOM) {
        page = addPage();
        y = 98;
      }
      if (newChapter) {
        page.centered(`Answers - Chapter ${section.chapter}`, y, 16.9, true);
        y += 41;
      }
      if (withMarkers) page.text(section.label, LEFT, y, 10);
      page.centered(`${sectionIndex % 2 === 0 ? 'Answers - ' : 'Answers to '}${section.title}`, y + 22, BODY, false);
      const list = keyRows.get(section.label) ?? [];
      let bandTop = y + 43;
      let next = 0;
      let lastRow = bandTop;
      while (next < list.length) {
        const remaining = list.length - next;
        const fit = Math.floor((BOTTOM - bandTop) / KEY_PITCH) + 1;
        const needed = Math.ceil(remaining / 3);
        const splits = needed > fit;
        const perColumn = splits ? fit : needed;
        const columns = splits ? 2 : 3;
        for (let column = 0; column < columns; column += 1) {
          const x = COLUMN_X[3][column] as number;
          for (let row = 0; row < perColumn && next < list.length; row += 1) {
            const entry = list[next] as KeyRow;
            next += 1;
            const baseline = bandTop + row * KEY_PITCH;
            page.text(`${entry.label}) ${entry.text}`, x, baseline);
            const anchors = [page.anchor(x, baseline)];
            if (entry.den !== undefined) {
              page.text(entry.den, x + 26, baseline + 10, 8);
              anchors.push(page.anchor(x + 26, baseline + 10, 8));
            }
            truth.answers.push({ section: section.label, label: entry.label, page: page.index, anchors, text: entry.text });
          }
        }
        lastRow = bandTop + (perColumn - 1) * KEY_PITCH;
        if (next < list.length) {
          page = addPage();
          bandTop = FIRST_Y;
        }
      }
      y = lastRow;
    });
  }

  // --- Chapter opener lists and the table of contents ----------------------------------------------------------------
  const printed = (index: number): number => index + truth.pageOffset;
  const startOf = (section: SectionPlan): number => printed(sectionStart.get(section.label) as number);
  for (const entry of openers) {
    entry.sections.forEach((section, index) => {
      entry.page.text(openerLine(section.label, section.title, startOf(section)), LEFT, 148 + index * 32);
    });
  }
  if (tocPage) {
    tocPage.centered('Table of Contents', 98, 16.9, true);
    const entryText = (section: SectionPlan): string => leaders(section.label, section.tocTitle, startOf(section));
    tocPage.text(`Chapter 0: ${(CHAPTERS[0] as { title: string }).title}`, LEFT, 150, BODY, true);
    tocPage.text(entryText(s01), LEFT, 181);
    // The text extraction of a real book merged lines like this one: a chapter heading and the entries around it
    // glued to each other, even the page number and the next label ("131.2").
    const merged = [s02, s11, s12].map((section) => leaders(section.label, section.tocTitle, startOf(section), 26));
    tocPage.text(`${merged[0]}Chapter 1: ${(CHAPTERS[1] as { title: string }).title}${merged[1]}${merged[2]}`, LEFT, 212, 9);
    if (withKey) tocPage.text(leaders(undefined, 'Answers', printed(truth.answerKeyPage ?? 0)), 308, 150);
  }

  // --- Truth ---------------------------------------------------------------------------------------------------------
  for (const chapter of CHAPTERS) {
    truth.chapters.push({ id: `c${chapter.n}`, label: `Chapter ${chapter.n}`, title: chapter.title, openerPage: chapterOpener.get(chapter.n) as number });
  }
  for (const section of SECTIONS) {
    truth.sections.push({
      id: section.label,
      label: section.label,
      title: section.title,
      tocTitle: section.tocTitle,
      chapter: `c${section.chapter}`,
      lessonPage: sectionStart.get(section.label) as number,
      practiceFirstPage: practiceFirst.get(section.label) as number,
      practiceLastPage: practiceLast.get(section.label) as number,
    });
  }

  const specs: PdfPageSpec[] = pages.map((page) => ({ texts: page.texts, boxes: page.boxes }));
  return { pdf: buildPdf({ title: TITLE, pages: specs }), pageCount: pages.length, truth };
}

/** The answer printed in the key for an item (invented, deterministic). */
function answerFor(section: string, label: string): string {
  const n = Number(label);
  switch (section) {
    case '0.1':
      return String(((n * 7) % 37) - 18);
    case '0.2':
      return `${((n * 13) % 90) + 10} units`;
    case '1.1':
      return `(${(n % 9) - 4}, ${((n * 3) % 9) - 4})`;
    default:
      return `${((n * 3) % 17) + 1}.${n % 10}`;
  }
}
