import { buildPdf, type PdfBox, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A small synthetic exercise booklet: a cover, a notice that stands in the bottom of its page, the printed contents on two pages (a
 * line for each chapter and one for each exercise, with leader dots and a page number), five exercises in two chapters and an
 * imprint. Each exercise starts with its word and its number, "Aufgabe 1.2 (Mengen). ...", at the top of a page of its own, under a
 * running head that holds the title of its chapter and the page number; the rest of the page is room to answer in, and two
 * exercises draw a figure (no text) and one prints fields to fill in; the statement of each exercise stands in a box that the template
 * draws (a light fill, a dark border of two points) from the left to the right margin of the text block, and what is under the
 * box (the figure, the fields) is outside of it. The second page of the contents has the running head of the first chapter too. The bookmarks (optional) are the two chapters, "1 Erste Schritte". Every text is made up; the words are
 * German because the layout is.
 */

export interface BookletExercise {
  /** The chapter, which is the section the exercise belongs to. */
  section: string;
  /** The number as printed: "1.2". */
  label: string;
  page: number;
  title: string;
  /** The first words of the statement, to find it again in the text of a region. */
  words: string;
  /** The box drawn around the statement (fractions of the page): its border is ink, the region holds the whole box. */
  box: { top: number; bottom: number };
  /** The vertical extent of what is drawn under the text (fractions of the page), when the exercise holds a figure. */
  figure?: { top: number; bottom: number };
  /** Where the last ink of the exercise is: the bottom of its last line or of its figure (fractions of the page). */
  lastInk: number;
}

export interface Booklet {
  pdf: Uint8Array;
  pageCount: number;
  chapters: { number: string; title: string; page: number }[];
  exercises: BookletExercise[];
  coverPage: number;
  noticePage: number;
  /** The two pages of the printed contents (none when the booklet has no contents). */
  contentsPages: number[];
  /** The left edge of the border on the left of the boxes and the right edge of the border on their right (fractions of the page width). */
  boxSides: { left: number; right: number };
  imprintPage: number;
}

export interface BookletOptions {
  /** Give the PDF its bookmarks (the two chapters, "1 Erste Schritte"). */
  bookmarks?: boolean;
  /** Print the contents on two pages after the notice (default); without them the exercises start on page 2. */
  contents?: boolean;
}

const HEIGHT = 842;
const WIDTH = 595;
const LEFT = 90;
const PITCH = 16;


/** A line of the printed contents: the title, leader dots up to the right margin and the printed page number. */
const contentsLine = (title: string, printedPage: number): string => `${title}${'.'.repeat(Math.max(8, Math.round((400 - title.length * 5.4) / 3.06)))}${printedPage}`;

/** The running head of a page: the title of the chapter at the left, the printed page number at the right. */
const runningHead = (texts: PdfText[], title: string, page: number): void => {
  texts.push({ text: title, x: LEFT, y: 42, size: 10 });
  texts.push({ text: String(page + 1), x: 498, y: 42, size: 10 });
};

const BOX_LEFT = 70;
const BOX_WIDTH = 448.5;
const BORDER = 1.8;

/** The box around the lines whose first and last baselines are given: a light fill and a dark border, the box and its top and bottom in points. */
function drawBox(boxes: PdfBox[], firstBaseline: number, lastBaseline: number): { top: number; bottom: number } {
  const top = firstBaseline - 24;
  const bottom = lastBaseline + 13;
  const height = bottom - top;
  boxes.push({ x: BOX_LEFT, y: top, w: BOX_WIDTH, h: height, fill: 0.95 });
  boxes.push({ x: BOX_LEFT, y: top, w: BOX_WIDTH, h: BORDER, fill: 0.3 });
  boxes.push({ x: BOX_LEFT, y: bottom - BORDER, w: BOX_WIDTH, h: BORDER, fill: 0.3 });
  boxes.push({ x: BOX_LEFT, y: top, w: BORDER, h: height, fill: 0.3 });
  boxes.push({ x: BOX_LEFT + BOX_WIDTH - BORDER, y: top, w: BORDER, h: height, fill: 0.3 });
  return { top, bottom };
}

const lines = (texts: PdfText[], y: number, words: string[], x = LEFT + 14): number => {
  words.forEach((text, k) => texts.push({ text, x, y: y + k * PITCH, size: 11 }));
  return y + (words.length - 1) * PITCH;
};

export function buildBooklet(options: BookletOptions = {}): Booklet {
  const pages: PdfPageSpec[] = [];
  const exercises: BookletExercise[] = [];
  const contents = options.contents !== false;
  // The page of the first exercise: after the cover, the notice and, when there are, two pages of contents.
  const first = contents ? 4 : 2;
  const chapters = [
    { number: '1', title: 'Erste Schritte', page: first },
    { number: '2', title: 'Zweiter Teil', page: first + 3 },
  ];
  const headOf = (page: number): string => (page < (chapters[1]?.page ?? 0) ? chapters[0]?.title ?? '' : chapters[1]?.title ?? '');

  // The cover and the notice at the foot of the next page: nothing at the top of either.
  pages.push({
    texts: [
      { text: 'Erika Beispiel', x: 60, y: 267, size: 12 },
      { text: 'Grundlagen der Beispiele I', x: 60, y: 315, size: 24 },
      { text: 'Übungsheft', x: 60, y: 382, size: 12 },
    ],
  });
  pages.push({
    texts: [
      { text: 'Dieses Heft ist ein erfundenes Beispiel. Seine Aufgaben stammen aus keinem Kurs, und es darf', x: 30, y: 748, size: 8 },
      { text: 'ohne Genehmigung kopiert, verändert und weitergegeben werden, solange dieser', x: 30, y: 760, size: 8 },
      { text: 'Hinweis erhalten bleibt.', x: 30, y: 772, size: 8 },
    ],
  });

  // The printed contents: a line for each chapter and one for each exercise, each with leaders and its page; the second page of it
  // carries the running head of the first chapter.
  const listed = [
    { text: '1 Erste Schritte', page: first + 1, indent: 0 },
    { text: 'Aufgabe 1.1 (Zahlen)', page: first + 1, indent: 1 },
    { text: 'Aufgabe 1.2 (Mengen)', page: first + 2, indent: 1 },
    { text: 'Aufgabe 1.3 (Tabellen)', page: first + 3, indent: 1 },
    { text: '2 Zweiter Teil', page: first + 4, indent: 0 },
    { text: 'Aufgabe 2.1 (Logik)', page: first + 4, indent: 1 },
    { text: 'Aufgabe 2.2 (Graphen)', page: first + 5, indent: 1 },
  ];
  const entry = (item: (typeof listed)[number], k: number, top: number): PdfText => ({ text: contentsLine(item.text, item.page), x: 100 + 17 * item.indent, y: top + k * 20, size: 11 });
  if (contents) {
    pages.push({ texts: [{ text: 'Inhaltsverzeichnis', x: 100, y: 96, size: 15, font: 'Helvetica-Bold' }, ...listed.slice(0, 5).map((item, k) => entry(item, k, 132))] });
    const texts: PdfText[] = [];
    runningHead(texts, headOf(3), 3);
    texts.push(...listed.slice(5).map((item, k) => entry(item, k, 100)));
    pages.push({ texts });
  }

  const exercisePage = (index: number, build: (texts: PdfText[], boxes: PdfBox[]) => void): void => {
    const texts: PdfText[] = [];
    const boxes: PdfBox[] = [];
    runningHead(texts, headOf(index), index);
    build(texts, boxes);
    pages.push({ texts, boxes });
  };

  // 1.1: the first exercise of its chapter, under the heading of the chapter; three lines and room to answer in.
  exercisePage(first + 0, (texts, boxes) => {
    texts.push({ text: '1 Erste Schritte', x: 80, y: 100, size: 15, font: 'Helvetica-Bold' });
    const bottom = lines(texts, 140, ['Aufgabe 1.1 (Zahlen). Schreiben Sie die Zahlen 3, 17 und 42 als Dualzahlen und', 'geben Sie jeweils die Anzahl der benötigten Stellen an. Rechnen Sie anschließend', 'jede Dualzahl wieder in eine Dezimalzahl um.'], 80 + 6);
    const frame = drawBox(boxes, 140, bottom);
    exercises.push({ section: '1', label: '1.1', page: first + 0, title: 'Zahlen', words: 'Schreiben Sie die Zahlen', box: { top: frame.top / HEIGHT, bottom: frame.bottom / HEIGHT }, lastInk: frame.bottom / HEIGHT });
  });
  // 1.2: a figure drawn without text under two lines.
  exercisePage(first + 1, (texts, boxes) => {
    const bottom = lines(texts, 97, ['Aufgabe 1.2 (Mengen). Zeichnen Sie ein Venn-Diagramm für die Mengen A und B und', 'kennzeichnen Sie den Durchschnitt der beiden Mengen.'], 86);
    const frame = drawBox(boxes, 97, bottom);
    boxes.push({ x: 140, y: 230, w: 300, h: 170, fill: 0.75 });
    exercises.push({ section: '1', label: '1.2', page: first + 1, title: 'Mengen', words: 'Zeichnen Sie ein Venn-Diagramm', box: { top: frame.top / HEIGHT, bottom: frame.bottom / HEIGHT }, figure: { top: 230 / HEIGHT, bottom: 400 / HEIGHT }, lastInk: 400 / HEIGHT });
  });
  // 1.3: fields to fill in, the last one far down the page; they stand a little left of the text.
  exercisePage(first + 2, (texts, boxes) => {
    const bottom = lines(texts, 97, ['Aufgabe 1.3 (Tabellen). Ergänzen Sie die Wahrheitstabelle und tragen Sie die', 'Werte der drei Ausdrücke ein.'], 86);
    const frame = drawBox(boxes, 97, bottom);
    texts.push({ text: 'p und q =', x: 80, y: 200, size: 11 });
    texts.push({ text: 'p oder q =', x: 80, y: 250, size: 11 });
    texts.push({ text: 'nicht p =', x: 80, y: 480, size: 11 });
    exercises.push({ section: '1', label: '1.3', page: first + 2, title: 'Tabellen', words: 'Ergänzen Sie die Wahrheitstabelle', box: { top: frame.top / HEIGHT, bottom: frame.bottom / HEIGHT }, lastInk: 484 / HEIGHT });
  });
  // 2.1: the first exercise of the second chapter, whose running head stands on two pages only.
  exercisePage(first + 3, (texts, boxes) => {
    texts.push({ text: '2 Zweiter Teil', x: 80, y: 100, size: 15, font: 'Helvetica-Bold' });
    const bottom = lines(texts, 140, ['Aufgabe 2.1 (Logik). Ist die folgende Aussage wahr? Begründen Sie Ihre Antwort', 'mit einer Wahrheitstabelle.'], 86);
    const frame = drawBox(boxes, 140, bottom);
    exercises.push({ section: '2', label: '2.1', page: first + 3, title: 'Logik', words: 'Ist die folgende Aussage wahr', box: { top: frame.top / HEIGHT, bottom: frame.bottom / HEIGHT }, lastInk: frame.bottom / HEIGHT });
  });
  // 2.2: a small figure.
  exercisePage(first + 4, (texts, boxes) => {
    const bottom = lines(texts, 97, ['Aufgabe 2.2 (Graphen). Zeichnen Sie einen Graphen mit vier Knoten, in dem jeder', 'Knoten genau zwei Nachbarn hat.'], 86);
    const frame = drawBox(boxes, 97, bottom);
    boxes.push({ x: 200, y: 190, w: 180, h: 100, fill: 0.8 });
    exercises.push({ section: '2', label: '2.2', page: first + 4, title: 'Graphen', words: 'Zeichnen Sie einen Graphen', box: { top: frame.top / HEIGHT, bottom: frame.bottom / HEIGHT }, figure: { top: 190 / HEIGHT, bottom: 290 / HEIGHT }, lastInk: 290 / HEIGHT });
  });
  // The imprint: its text stands in the bottom of the page, there is no running head.
  pages.push({
    texts: [
      { text: '123 456 789 (01/99)', x: 82, y: 746, size: 10 },
      { text: 'Nur ein Beispiel ohne Gewähr', x: 376, y: 760, size: 8 },
      { text: '© 2026 Beispielhochschule', x: 376, y: 772, size: 8 },
      { text: 'K7-12-Y', x: 82, y: 790, size: 15 },
    ],
  });

  const pdf = buildPdf({
    title: 'Ein Übungsheft',
    pages,
    ...(options.bookmarks === true ? { outline: chapters.map((chapter) => ({ title: `${chapter.number} ${chapter.title}`, page: chapter.page, depth: 0 })) } : {}),
  });
  return { pdf, pageCount: pages.length, chapters: [...chapters], exercises, coverPage: 0, noticePage: 1, contentsPages: contents ? [2, 3] : [], boxSides: { left: BOX_LEFT / WIDTH, right: (BOX_LEFT + BOX_WIDTH) / WIDTH }, imprintPage: pages.length - 1 };
}
