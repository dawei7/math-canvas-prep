import { buildPdf, paragraph, type PdfBox, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A synthetic book of any length for looking at whole pages (the overview sheets): US letter pages that repeat eight kinds of page, the
 * kinds a real textbook has: a chapter opener, a lesson, text in two columns, a page with a shaded box, a page with a figure, a
 * practice set of numbered items in two columns, a practice set with parts, and an answer key in three columns. Each page has a running head and a
 * printed page number, and a small gray tab at its left edge whose shade tells the page apart from its neighbours (`structureMarker`), so
 * that a test can find out which page it is looking at in a picture. Every word is invented.
 */

export type StructurePageKind = 'opener' | 'lesson' | 'columns' | 'box' | 'figure' | 'exercises' | 'parts' | 'answers';

export const STRUCTURE_KINDS: readonly StructurePageKind[] = ['opener', 'lesson', 'columns', 'box', 'figure', 'exercises', 'parts', 'answers'];
export const STRUCTURE_PAGE = { width: 612, height: 792 } as const;
/** The tab at the left edge of every page, in points of the page (origin top-left). */
export const STRUCTURE_TAB = { x: 0, y: 380, width: 18, height: 90 } as const;

export interface StructureBook {
  pdf: Uint8Array;
  pageCount: number;
  /** The kind of every page. */
  kinds: StructurePageKind[];
}

/** The shade of the tab of a page, 0 (black) to 255 (white): the pages of any 24 in a row differ by more than 8. */
export function structureMarker(page: number): number {
  return Math.round(255 * (0.05 + 0.035 * (page % 24)));
}

const WORDS = ['the', 'sum', 'of', 'two', 'values', 'is', 'equal', 'to', 'their', 'product', 'when', 'each', 'rate', 'changes', 'by', 'one', 'unit', 'along', 'a', 'line', 'and', 'every', 'graph', 'shows', 'how', 'slopes', 'grow', 'with', 'time'];

/** `count` lines of invented words, the same for the same seed. */
function sentences(count: number, seed: number, perLine = 11): string[] {
  let state = (seed + 1) * 2654435761;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  return Array.from({ length: count }, () => {
    const words = Array.from({ length: perLine }, () => WORDS[next() % WORDS.length] as string);
    return `${(words[0] as string).replace(/^./, (letter) => letter.toUpperCase())} ${words.slice(1).join(' ')}.`;
  });
}

function page(index: number, kind: StructurePageKind): PdfPageSpec {
  const chapter = Math.floor(index / 8) + 1;
  const texts: PdfText[] = [
    { text: 'Synthetic Structures', x: 72, y: 44, size: 9 },
    { text: `Chapter ${chapter}`, x: 480, y: 44, size: 9 },
    { text: String(index + 1), x: 300, y: 756, size: 10 },
  ];
  const boxes: PdfBox[] = [{ ...{ x: STRUCTURE_TAB.x, y: STRUCTURE_TAB.y, w: STRUCTURE_TAB.width, h: STRUCTURE_TAB.height }, fill: structureMarker(index) / 255 }];
  const add = (lines: string[], x: number, y: number, size = 10, bold = false): number => {
    const made = paragraph({ lines, x, y, size, ...(bold ? { font: 'Helvetica-Bold' as const } : {}) });
    texts.push(...made.texts);
    return made.next;
  };
  const seed = index * 7;
  switch (kind) {
    case 'opener': {
      add([`Chapter ${chapter}`], 72, 170, 30, true);
      add(['Synthetic structures of the page'], 72, 200, 15);
      add([`${chapter}.1 A lesson with a heading`, `${chapter}.2 Text in two columns`, `${chapter}.3 Boxes and figures`, `${chapter}.4 Exercises`], 72, 280, 11);
      break;
    }
    case 'lesson': {
      let y = add([`${chapter}.1 A lesson with a heading`], 72, 100, 18, true) + 8;
      for (let block = 0; block < 3; block += 1) y = add(sentences(7, seed + block), 72, y, 10) + 12;
      break;
    }
    case 'columns': {
      const y = add([`${chapter}.2 Text in two columns`], 72, 100, 18, true) + 8;
      add(sentences(32, seed, 6), 72, y, 10);
      add(sentences(32, seed + 1, 6), 330, y, 10);
      break;
    }
    case 'box': {
      let y = add(sentences(6, seed), 72, 100, 10) + 16;
      boxes.push({ x: 72, y, w: 468, h: 96, fill: 0.9 });
      add(['Key idea'], 84, y + 20, 11, true);
      add(sentences(4, seed + 1, 9), 84, y + 38, 10);
      y += 120;
      add(sentences(12, seed + 2), 72, y, 10);
      break;
    }
    case 'figure': {
      let y = add(sentences(5, seed), 72, 100, 10) + 16;
      boxes.push({ x: 150, y, w: 312, h: 190 });
      add(['synthetic plot'], 270, y + 98, 10);
      y += 214;
      y = add([`Figure ${chapter}.1: a plot that is invented`], 150, y, 9) + 16;
      add(sentences(10, seed + 1), 72, y, 10);
      break;
    }
    case 'exercises': {
      let y = add([`${chapter}.4 Exercises`], 72, 100, 18, true) + 6;
      y = add(['Find the value of each expression.'], 72, y, 10, true) + 6;
      for (let item = 0; item < 12; item += 1) {
        const x = item % 2 === 0 ? 72 : 320;
        const row = Math.floor(item / 2);
        add([`${item + 1}.  ${sentences(1, seed + item, 4)[0] as string}`], x, y + row * 44, 10);
      }
      break;
    }
    case 'parts': {
      let y = add(['Use the information above to answer each part.'], 72, 100, 10, true) + 10;
      for (let item = 0; item < 4; item += 1) {
        y = add([`${item + 13}.  ${sentences(1, seed + item, 9)[0] as string}`, `(a)  ${sentences(1, seed + item + 9, 7)[0] as string}`, `(b)  ${sentences(1, seed + item + 18, 7)[0] as string}`], 72, y, 10) + 22;
      }
      break;
    }
    case 'answers': {
      let y = add([`Answers to the exercises of chapter ${chapter}`], 72, 100, 14, true) + 10;
      y = add(['Section 1.4'], 72, y, 9, true) + 4;
      for (let column = 0; column < 3; column += 1) {
        add(Array.from({ length: 42 }, (_unused, row) => `${column * 42 + row + 1}.  ${(row * 7 + column * 3) % 19}`), 72 + column * 160, y, 9);
      }
      break;
    }
  }
  return { ...STRUCTURE_PAGE, texts, boxes };
}

/** A synthetic book of `pageCount` pages (default 40). */
export function buildStructureBook(pageCount = 40): StructureBook {
  const kinds = Array.from({ length: pageCount }, (_unused, index) => STRUCTURE_KINDS[index % STRUCTURE_KINDS.length] as StructurePageKind);
  return { pdf: buildPdf({ title: 'Synthetic Structures', pages: kinds.map((kind, index) => page(index, kind)) }), pageCount, kinds };
}
