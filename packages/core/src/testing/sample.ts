import { buildPdf, paragraph, type PdfBox, type PdfPageSpec, type PdfText } from './pdf-writer.js';

/**
 * The synthetic sample used by the tests, the examples and the documentation: a three-page "exercise sheet" with a
 * running header and footer, exercises with and without parts, an instruction printed above two exercises (context),
 * an exercise that continues on the next page, a definition and a remark worth a bookmark or a question, a figure box,
 * and an outline. Its text is invented; nothing in it comes from a real book or exam.
 */

export interface SampleSheet {
  pdf: Uint8Array;
  /** The text the sample is built from, to find lines in tests. */
  texts: { page: number; text: string }[][];
  title: string;
  outline: { title: string; page: number; depth: number }[];
}

const LEFT = 72;
const HEADER = 'Sample University - Calculus I';

function pageFrame(pageNumber: number, total: number): PdfText[] {
  return [
    { text: HEADER, x: LEFT, y: 40, size: 9 },
    { text: `Page ${pageNumber} of ${total}`, x: 270, y: 806, size: 9 },
  ];
}

export function buildSampleSheet(): SampleSheet {
  const pages: PdfPageSpec[] = [];
  const total = 3;

  // Page 1: title, exercise 1 and exercise 2 with three parts.
  {
    const texts: PdfText[] = [...pageFrame(1, total)];
    texts.push({ text: 'Calculus Sheet 1', x: LEFT, y: 110, size: 20, font: 'Helvetica-Bold' });
    texts.push({ text: 'Differentiation and integration (synthetic sample)', x: LEFT, y: 134, size: 11 });
    let y = 200;
    const first = paragraph({
      x: LEFT,
      y,
      lines: [
        'Exercise 1. Compute the derivative of f(x) = x^3 - 2x + 5 and evaluate',
        'it at x = 2. Show every step of your computation.',
      ],
    });
    texts.push(...first.texts);
    y = first.next + 28;
    const second = paragraph({
      x: LEFT,
      y,
      lines: [
        'Exercise 2. Let g(x) = sin(x) + x^2 on the interval [0, pi]. Answer the',
        'following questions.',
        '(a) Compute the derivative g\'(x).',
        '(b) Find all critical points of g in the interval [0, pi].',
        '(c) Decide for each critical point whether it is a local minimum or a',
        '     local maximum, and justify your answer.',
      ],
    });
    texts.push(...second.texts);
    pages.push({ texts });
  }

  // Page 2: instruction (context), exercise 3, the beginning of exercise 4.
  {
    const texts: PdfText[] = [...pageFrame(2, total)];
    const instruction = paragraph({
      x: LEFT,
      y: 110,
      lines: [
        'Instructions for Exercises 3 and 4',
        'Justify every answer with a short proof. You may use the standard rules',
        'of differentiation without proving them again.',
      ],
    });
    instruction.texts[0] = { ...(instruction.texts[0] as PdfText), font: 'Helvetica-Bold' };
    texts.push(...instruction.texts);
    const third = paragraph({
      x: LEFT,
      y: 220,
      lines: [
        'Exercise 3. Prove that h(x) = |x| is not differentiable at x = 0.',
        'Hint: compare the one-sided limits of the difference quotient.',
      ],
    });
    texts.push(...third.texts);
    const fourth = paragraph({
      x: LEFT,
      y: 640,
      lines: [
        'Exercise 4. Let p be a polynomial of degree n >= 1 with real coefficients',
        'and let a < b be two real numbers with p(a) = p(b) = 0. Show that the',
        'derivative p\' has at least one zero in the open interval',
      ],
    });
    texts.push(...fourth.texts);
    pages.push({ texts });
  }

  // Page 3: the end of exercise 4, a definition, exercise 5 with two parts and a figure, a remark.
  {
    const texts: PdfText[] = [...pageFrame(3, total)];
    const rest = paragraph({
      x: LEFT,
      y: 96,
      lines: ['(a, b), counted with multiplicity. State the theorem that you use.'],
    });
    texts.push(...rest.texts);
    const definition = paragraph({
      x: LEFT,
      y: 180,
      lines: [
        'Definition 5.1 (Derivative)',
        'Let f be defined near a. If the limit of (f(a + h) - f(a)) / h as h tends',
        'to 0 exists, it is called the derivative of f at a and is written f\'(a).',
      ],
    });
    definition.texts[0] = { ...(definition.texts[0] as PdfText), font: 'Helvetica-Bold' };
    texts.push(...definition.texts);
    const fifth = paragraph({
      x: LEFT,
      y: 290,
      lines: [
        'Exercise 5. Let f(x) = x^2 for x in [0, 2].',
        'a) Sketch the graph of f and mark the tangent line at x = 1.',
        'b) Compute the area under the graph with an integral.',
      ],
    });
    texts.push(...fifth.texts);
    const boxes: PdfBox[] = [{ x: 160, y: 360, w: 270, h: 110 }];
    texts.push({ text: 'Figure 1: the parabola', x: 235, y: 420, size: 10 });
    const remark = paragraph({
      x: LEFT,
      y: 520,
      lines: [
        'Remark. The tangent line at a point is the best linear approximation of',
        'the function near that point.',
      ],
    });
    texts.push(...remark.texts);
    pages.push({ texts, boxes });
  }

  const outline = [
    { title: 'Differentiation', page: 0, depth: 0 },
    { title: 'Exercises 1 and 2', page: 0, depth: 1 },
    { title: 'Proofs', page: 1, depth: 0 },
    { title: 'Definitions and area', page: 2, depth: 0 },
  ];
  const title = 'Calculus Sheet 1';
  return {
    pdf: buildPdf({ title, pages, outline }),
    texts: pages.map((page, index) => (page.texts ?? []).map((item) => ({ page: index, text: item.text }))),
    title,
    outline,
  };
}
