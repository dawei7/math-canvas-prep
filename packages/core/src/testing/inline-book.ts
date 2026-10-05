import { buildPdf, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * A small synthetic text whose exercises are printed inside the lessons: "1.1.2 Aufgabe: ..." with a link word ("Lösung") alone at
 * the right margin, and an answer chapter whose entries start with "Lösung 1.1.2" and end with a link back ("zurück") at the right
 * margin. The number after the section is a counter shared with the definitions and the rules, so there are gaps. One exercise runs
 * over a page break, so does one answer, one exercise holds a wide formula whose two halves the text layer lists as two columns, one
 * exercise has no link and one link belongs to no exercise. Every text is made up.
 */

export interface InlineExercise {
  section: string;
  label: string;
  page: number;
  /** The pages that follow the first one, when the statement runs over a page break. */
  continuesOn: number[];
  /** Whether a link word stands at its end. */
  link: boolean;
  /** The first words after the label, to find it again in the text of a region. */
  words: string;
}

export interface InlineAnswer {
  label: string;
  page: number;
  continuesOn: number[];
}

export interface InlineBook {
  pdf: Uint8Array;
  pageCount: number;
  exercises: InlineExercise[];
  answers: InlineAnswer[];
  /** The page that carries the link word that belongs to no exercise. */
  strayLinkPage: number;
  /** The page with the two halves of a formula side by side. */
  wideFormulaPage: number;
  sections: { label: string; title: string; page: number }[];
}

const LEFT = 85;
const LINK = 455;
const PITCH = 16;

const run = (texts: PdfText[], x: number, y: number, lines: string[], font: PdfText['font'] = 'Helvetica'): number => {
  lines.forEach((text, k) => texts.push({ text, x, y: y + k * PITCH, size: 12, font }));
  return y + lines.length * PITCH;
};

const head = (texts: PdfText[], text: string, y: number, size = 17): void => {
  texts.push({ text, x: LEFT, y, size, font: 'Helvetica-Bold' });
};

/** The running head of a page, a page number at the bottom and nothing else: furniture. */
const furniture = (texts: PdfText[], title: string, page: number): void => {
  texts.push({ text: title, x: page % 2 === 0 ? LEFT : 330, y: 58, size: 10 });
  texts.push({ text: String(page + 1), x: 292, y: 810, size: 10 });
};

export interface InlineBookOptions {
  /**
   * Print the headings of the chapter and the sections without their numbers ("Sets", not "1.1 Sets") and give the PDF bookmarks
   * (a part, its chapter, its two sections), so that the numbers have to be counted.
   */
  unnumbered?: boolean;
}

export function buildInlineBook(options: InlineBookOptions = {}): InlineBook {
  const numbered = options.unnumbered !== true;
  const pages: PdfPageSpec[] = [];
  const exercises: InlineExercise[] = [];
  const answers: InlineAnswer[] = [];

  // Page 0: the chapter, section 1.1 with an exercise that runs over the page break.
  {
    const texts: PdfText[] = [];
    furniture(texts, '1.1. Sets', 0);
    head(texts, numbered ? '1 Foundations' : 'Foundations', 120, 24);
    head(texts, numbered ? '1.1 Sets' : 'Sets', 190);
    let y = run(texts, LEFT, 225, ['A set is a collection of objects. Two sets are equal when they hold the', 'same objects.']);
    y = run(texts, LEFT, y + 10, ['1.1.1 Definition: The union of two sets holds the objects of both.']);
    y = run(texts, LEFT, y + 14, ['1.1.2 Aufgabe: Compute the union of A = {1, 2} and B = {2, 3} and', 'write it as a list.']);
    texts.push({ text: 'Lösung', x: LINK, y: y + 8, size: 12 });
    y = run(texts, LEFT, y + 40, ['Sets can be drawn as circles, and the union is the area of both circles', 'together, as you see in the next picture of the two sets.']);
    y = run(texts, LEFT, y + 30, ['1.1.3 Aufgabe: Show that the intersection of two sets does not depend on', 'the order of the sets. Start from the definition of the intersection,', 'write down what it means for an object to lie in A and in B, and then']);
    // The statement runs on at the top of the next page.
    exercises.push({ section: '1.1', label: '1.1.2', page: 0, continuesOn: [], link: true, words: 'Compute the union' });
    exercises.push({ section: '1.1', label: '1.1.3', page: 0, continuesOn: [1], link: true, words: 'Show that the intersection' });
    void y;
    // push the third line down to the bottom of the page so that the break falls inside the statement
    const last = texts[texts.length - 1] as PdfText;
    const middle = texts[texts.length - 2] as PdfText;
    const first = texts[texts.length - 3] as PdfText;
    first.y = 735;
    middle.y = 751;
    last.y = 767;
    pages.push({ texts });
  }
  // Page 1: the statement goes on, its link, section 1.2 with the wide formula. The lines are short, so that the matrix with its two
  // halves side by side is what the text layer reads as two columns.
  {
    const texts: PdfText[] = [];
    furniture(texts, '1.1. Sets', 1);
    let y = run(texts, LEFT, 100, ['compare both sides.']);
    texts.push({ text: 'Lösung', x: LINK, y: y + 6, size: 12 });
    head(texts, numbered ? '1.2 Maps' : 'Maps', 190);
    y = run(texts, LEFT, 225, ['A map sends every object', 'to exactly one object.']);
    y = run(texts, LEFT, y + 14, ['1.2.1 Satz: A composition', 'of maps is a map.']);
    y = run(texts, LEFT, y + 14, ['1.2.2 Aufgabe: Compute the', 'product AB of the matrices:']);
    for (let row = 0; row < 6; row += 1) {
      texts.push({ text: `${row + 1} ${row + 2} ${row + 3}`, x: LEFT + 30, y: y + 4 + row * PITCH, size: 12 });
      texts.push({ text: `${row + 4} ${row + 5} ${row + 6}`, x: 360, y: y + 4 + row * PITCH, size: 12 });
    }
    y = run(texts, LEFT, y + 4 + 6 * PITCH + 4, ['and give the result.']);
    texts.push({ text: 'Lösung', x: LINK, y: y + 6, size: 12 });
    exercises.push({ section: '1.2', label: '1.2.2', page: 1, continuesOn: [], link: true, words: 'Compute the' });
    pages.push({ texts });
  }
  // Page 2: more exercises of 1.2, one without a link, a link without an exercise.
  {
    const texts: PdfText[] = [];
    furniture(texts, '1.2. Maps', 2);
    let y = run(texts, LEFT, 100, ['1.2.3 Aufgabe: Is the map x -> x * x from the integers to the integers one-to-one?']);
    texts.push({ text: 'Lösung', x: LINK, y: y + 6, size: 12 });
    y = run(texts, LEFT, y + 34, ['1.2.4 Aufgabe: Name a map that is one-to-one and not onto.']);
    y = run(texts, LEFT, y + 24, ['1.2.5 Satz: A one-to-one map has a left inverse.']);
    texts.push({ text: 'Lösung', x: LINK, y: y + 6, size: 12 });
    run(texts, LEFT, y + 40, ['That is all about maps for now.']);
    // The last exercise of the page ends at the bottom of it; its link stands alone at the top of the next page.
    texts.push({ text: '1.2.6 Aufgabe: Is every onto map from a finite set to itself', x: LEFT, y: 751, size: 12 });
    texts.push({ text: 'also one-to-one? Explain.', x: LEFT, y: 767, size: 12 });
    exercises.push({ section: '1.2', label: '1.2.3', page: 2, continuesOn: [], link: true, words: 'Is the map' });
    exercises.push({ section: '1.2', label: '1.2.4', page: 2, continuesOn: [], link: false, words: 'Name a map' });
    exercises.push({ section: '1.2', label: '1.2.6', page: 2, continuesOn: [], link: true, words: 'Is every onto map' });
    pages.push({ texts });
  }
  // Page 3: the answer chapter begins; the answer to 1.1.3 runs over the page break.
  {
    const texts: PdfText[] = [];
    furniture(texts, 'Solutions of the exercises for Chapter 1', 3);
    texts.push({ text: 'Lösung', x: LINK, y: 100, size: 12 });
    head(texts, 'Alle Lösungen', 145, 24);
    let y = run(texts, LEFT, 190, ['Lösung 1.1.2'], 'Helvetica-Bold');
    y = run(texts, LEFT, y + 2, ['The union is {1, 2, 3}.']);
    texts.push({ text: 'zurück', x: LINK, y: y + 6, size: 12 });
    y = run(texts, LEFT, y + 36, ['Lösung 1.1.3'], 'Helvetica-Bold');
    y = run(texts, LEFT, y + 2, ['Let x lie in the intersection of A and B. Then x lies in A and in B.', 'So x lies in B and in A, which is the intersection of B and A.', 'Hence the two sets hold the same objects: the intersection of A and B,']);
    const last = texts[texts.length - 1] as PdfText;
    const middle = texts[texts.length - 2] as PdfText;
    const first = texts[texts.length - 3] as PdfText;
    first.y = 735;
    middle.y = 751;
    last.y = 767;
    answers.push({ label: '1.1.2', page: 3, continuesOn: [] });
    answers.push({ label: '1.1.3', page: 3, continuesOn: [4] });
    void y;
    pages.push({ texts });
  }
  // Page 4: the answer goes on, the other answers.
  {
    const texts: PdfText[] = [];
    furniture(texts, 'Solutions of the exercises for Chapter 1', 4);
    let y = run(texts, LEFT, 100, ['taken in either order, are equal. This proves the claim.']);
    texts.push({ text: 'zurück', x: LINK, y: y + 6, size: 12 });
    y = run(texts, LEFT, y + 36, ['Lösung 1.2.2'], 'Helvetica-Bold');
    y = run(texts, LEFT, y + 2, ['AB = (19 22 43 50) after multiplying row by column.']);
    texts.push({ text: 'zurück', x: LINK, y: y + 6, size: 12 });
    // The answer to 1.2.3 ends at the bottom of the page and its link back stands alone at the top of the next one.
    texts.push({ text: 'Lösung 1.2.3', x: LEFT, y: 735, size: 12, font: 'Helvetica-Bold' });
    texts.push({ text: 'No: the numbers 2 and -2 have the same square, so the map is not', x: LEFT, y: 751, size: 12 });
    texts.push({ text: 'one-to-one.', x: LEFT, y: 767, size: 12 });
    answers.push({ label: '1.2.2', page: 4, continuesOn: [] });
    answers.push({ label: '1.2.3', page: 4, continuesOn: [] });
    void y;
    pages.push({ texts });
  }
  // Page 5: the link back of the last answer, alone.
  {
    const texts: PdfText[] = [];
    furniture(texts, 'Solutions of the exercises for Chapter 1', 5);
    texts.push({ text: 'zurück', x: LINK, y: 110, size: 12 });
    let y = run(texts, LEFT, 150, ['Lösung 1.2.6'], 'Helvetica-Bold');
    y = run(texts, LEFT, y + 2, ['Yes: an onto map of a finite set is one-to-one by counting.']);
    texts.push({ text: 'zurück', x: LINK, y: y + 6, size: 12 });
    answers.push({ label: '1.2.6', page: 5, continuesOn: [] });
    pages.push({ texts });
  }
  const pdf = buildPdf({
    title: 'Inline exercises',
    pages,
    ...(numbered
      ? {}
      : {
          outline: [
            { title: 'Part A', page: 0, depth: 0 },
            { title: 'Foundations', page: 0, depth: 1 },
            { title: 'Sets', page: 0, depth: 2 },
            { title: 'Maps', page: 1, depth: 2 },
            { title: 'Solutions of the exercises', page: 3, depth: 0 },
          ],
        }),
  });
  return {
    pdf,
    pageCount: pages.length,
    exercises,
    answers,
    strayLinkPage: 2,
    wideFormulaPage: 1,
    sections: [
      { label: '1.1', title: 'Sets', page: 0 },
      { label: '1.2', title: 'Maps', page: 1 },
    ],
  };
}
