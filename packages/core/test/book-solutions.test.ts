import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument } from '../src/pdf/document.js';
import type { PageText, Rect, TextLine } from '../src/model/types.js';
import { exercisesToOperations } from '../src/book/ops.js';
import { proposeExercises } from '../src/book/exercises.js';
import { deriveSections, type BookEntry, type BookStructure } from '../src/book/sections.js';
import { proposeSolutions, type BookSolutions, type SolutionProposal } from '../src/book/solutions.js';
import { buildSyntheticBook, type BookAnchor, type SyntheticBook } from '../src/testing/book.js';

const inside = (rect: Rect, anchor: BookAnchor): boolean => anchor.x >= rect.left && anchor.x <= rect.right && anchor.y >= rect.top && anchor.y <= rect.bottom;
const holds = (answer: SolutionProposal, anchor: BookAnchor): boolean => answer.regions.some((region) => region.page === anchor.page && inside(region.rect, anchor));

describe('answers of the synthetic book', () => {
  let book: SyntheticBook;
  let doc: PdfDocument;
  let pages: PageText[];
  let structure: BookStructure;
  let result: BookSolutions;
  const refs = (): { section: string; label: string }[] => book.truth.items.map((item) => ({ section: item.section, label: item.label }));
  const answers = (): SolutionProposal[] => result.sections.flatMap((section) => section.answers);
  beforeAll(async () => {
    book = buildSyntheticBook();
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true, ink: true });
    structure = deriveSections(pages);
    result = proposeSolutions(pages, structure.entries, refs(), structure.answerKey ? { answerKey: structure.answerKey } : {});
  });
  afterAll(async () => {
    await doc.close();
  });

  it('finds every answer of every section and matches it to its exercise, with nothing left over on either side', () => {
    expect(result.key).toEqual({ firstPage: book.truth.answerKeyPage, lastPage: book.pageCount - 1 });
    for (const section of result.sections) {
      const expected = book.truth.answers.filter((answer) => answer.section === section.section).map((answer) => answer.label);
      expect(section.answers.map((answer) => answer.label), section.section).toEqual(expected);
      expect(section.withoutAnswer, section.section).toEqual([]);
      expect(section.withoutExercise, section.section).toEqual([]);
      expect(section.gaps, section.section).toEqual([]);
      expect(section.notes, section.section).toEqual([]);
      expect(section.headers.length, section.section).toBe(1);
    }
    expect(answers().length).toBe(book.truth.answers.length);
    expect(result.notes).toEqual([]);
  });

  it('follows a section across the page break and across the columns (the band runs over all columns)', () => {
    const first = result.sections[0]?.answers ?? [];
    expect(new Set(first.map((answer) => answer.regions[0]?.page)).size).toBe(2);
    expect(first.map((answer) => answer.label)).toEqual(Array.from({ length: 70 }, (_unused, index) => String(index + 1)));
  });

  it('holds the printed answer, its fraction line included, and nothing of the other answers', () => {
    for (const truth of book.truth.answers) {
      const answer = answers().find((candidate) => candidate.section === truth.section && candidate.label === truth.label);
      expect(answer, `${truth.section} ${truth.label}`).toBeDefined();
      if (!answer) continue;
      for (const anchor of truth.anchors) expect(holds(answer, anchor), `${truth.section} ${truth.label} should hold ${JSON.stringify(anchor)}`).toBe(true);
      for (const other of book.truth.answers) {
        if (other === truth) continue;
        for (const anchor of other.anchors) {
          expect(holds(answer, anchor), `${truth.section} ${truth.label} must not hold ${other.section} ${other.label}`).toBe(false);
        }
      }
    }
  });

  it('gives the answer the id of its exercise and evidence that names the band', () => {
    const answer = answers().find((candidate) => candidate.section === '0.2' && candidate.label === '7') as SolutionProposal;
    expect(answer.exercise).toBe('x0_2-7');
    expect(answer.evidence.join(' ')).toContain('marker "0.2"');
    expect(answer.confidence).toBeGreaterThanOrEqual(0.85);
    expect(answer.text).toMatch(/^7\)/);
  });

  it('puts the solution into the add operation of the exercise it belongs to', () => {
    const exercises = proposeExercises(pages, structure.entries);
    const proposals = exercises.sections.flatMap((section) => section.proposals);
    const solutions = new Map<string, readonly { page: number; rect: Rect }[]>(answers().map((answer) => [answer.exercise, answer.regions]));
    const ops = exercisesToOperations(proposals, solutions);
    expect(ops.length).toBe(proposals.length);
    expect(ops.every((op) => (op.solution?.length ?? 0) >= 1)).toBe(true);
    const five = ops.find((op) => op.section === '1.1' && op.label === '5');
    expect(five?.solution?.[0]?.page).toBeGreaterThanOrEqual(book.truth.answerKeyPage ?? 0);
  });

  it('reports exercises without an answer and answers without an exercise', () => {
    const fewer = refs().filter((ref) => !(ref.section === '0.2' && ref.label === '3'));
    fewer.push({ section: '0.2', label: '99' });
    const partial = proposeSolutions(pages, structure.entries, fewer, structure.answerKey ? { answerKey: structure.answerKey } : {});
    const section = partial.sections.find((entry) => entry.section === '0.2');
    expect(section?.withoutAnswer).toEqual(['99']);
    expect(section?.withoutExercise).toEqual(['3']);
    expect(section?.notes.join(' ')).toContain('no answer for the exercise 99');
    expect(section?.notes.join(' ')).toContain('answer 3 has no exercise');
  });

  it('works without exercises to match and says when there is no answer key', async () => {
    const plain = proposeSolutions(pages, structure.entries, undefined, structure.answerKey ? { answerKey: structure.answerKey } : {});
    expect(plain.sections.flatMap((section) => section.answers).length).toBe(book.truth.answers.length);
    expect(plain.sections.every((section) => section.withoutAnswer.length === 0)).toBe(true);
    const bare = buildSyntheticBook({ answerKey: false });
    const copy = await PdfDocument.fromBytes(bare.pdf);
    try {
      const barePages = await copy.allPageText({ fonts: true });
      const none = proposeSolutions(barePages, deriveSections(barePages).entries);
      expect(none.sections).toEqual([]);
      expect(none.notes.join(' ')).toContain('No answer key');
    } finally {
      await copy.close();
    }
  });

  it('names the bands by their headers when the key prints no markers', async () => {
    const unmarked = buildSyntheticBook({ markers: false });
    const copy = await PdfDocument.fromBytes(unmarked.pdf);
    try {
      const unmarkedPages = await copy.allPageText({ fonts: true, ink: true });
      const sections = deriveSections(unmarkedPages);
      const found = proposeSolutions(unmarkedPages, sections.entries, undefined, sections.answerKey ? { answerKey: sections.answerKey } : {});
      for (const section of found.sections) {
        const expected = unmarked.truth.answers.filter((answer) => answer.section === section.section).map((answer) => answer.label);
        expect(section.answers.map((answer) => answer.label), section.section).toEqual(expected);
        expect(section.answers[0]?.evidence.join(' ')).toContain('header');
      }
    } finally {
      await copy.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Layouts of a key that a generated PDF does not make: built by hand

interface Spec {
  text: string;
  left: number;
  top: number;
  right?: number;
  size?: number;
}

function line(spec: Spec): TextLine {
  const size = spec.size ?? 12;
  return {
    text: spec.text,
    rect: { left: spec.left, top: spec.top, right: spec.right ?? Math.min(0.95, spec.left + spec.text.length * 0.0075), bottom: spec.top + 0.0155 * (size / 12) },
    fontSize: size,
    column: 0,
    chars: spec.text.replace(/\s/g, '').length,
    bold: false,
  };
}

function page(index: number, specs: Spec[]): PageText {
  const lines = specs.map(line);
  lines.push({ ...line({ text: String(index + 1), left: 0.5, top: 0.926, size: 10 }), headerFooter: true });
  return { page: index, size: { width: 595, height: 842, rotation: 0 }, lines, columns: 1, hasText: true };
}

function entries(...labels: string[]): BookEntry[] {
  return labels.map((label, index) => ({ title: `Section ${label}`, page: index, depth: 1, id: label, label, kind: 'section' as const, confidence: 1, evidence: [], differences: [] }));
}

const chapterHeader = (top: number): Spec => ({ text: 'Answers - Chapter 1', left: 0.36, top, size: 16.9 });

describe('keys with a layout of their own', () => {
  it('reads answers that flow down the columns and merged rows of a flowing key (numbers a column apart)', () => {
    // Section 1.1 has 12 answers in three columns of 4; one row of the second and third columns was merged.
    const specs: Spec[] = [chapterHeader(0.1), { text: '1.1', left: 0.143, top: 0.15, size: 10 }, { text: 'Answers - Section 1.1', left: 0.4, top: 0.17 }];
    for (let k = 0; k < 4; k += 1) {
      specs.push({ text: `${k + 1}) a${k + 1}`, left: 0.143, top: 0.22 + k * 0.03 });
      if (k === 2) specs.push({ text: '7) a7 11) a11', left: 0.392, top: 0.22 + k * 0.03, right: 0.75 });
      else {
        specs.push({ text: `${k + 5}) a${k + 5}`, left: 0.392, top: 0.22 + k * 0.03 });
        specs.push({ text: `${k + 9}) a${k + 9}`, left: 0.642, top: 0.22 + k * 0.03 });
      }
    }
    const result = proposeSolutions([page(0, specs)], entries('1.1'), undefined, { answerKey: { page: 0, top: 0.1 } });
    expect(result.sections[0]?.answers.map((answer) => answer.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(result.sections[0]?.gaps).toEqual([]);
    const seven = result.sections[0]?.answers.find((answer) => answer.label === '7');
    const eleven = result.sections[0]?.answers.find((answer) => answer.label === '11');
    expect((seven?.regions[0]?.rect.right ?? 1) <= (eleven?.regions[0]?.rect.left ?? 0)).toBe(true);
  });

  it('puts an answer that goes on in its own column below the first line into one region', () => {
    const specs: Spec[] = [chapterHeader(0.1), { text: '1.1', left: 0.143, top: 0.15, size: 10 }];
    specs.push({ text: '1) $3500 @ 6%;', left: 0.143, top: 0.22 }, { text: '$5000 @ 3.5%', left: 0.176, top: 0.24 });
    specs.push({ text: '2) $7000 @ 9%', left: 0.143, top: 0.27 }, { text: '3) 12', left: 0.143, top: 0.3 }, { text: '4) 13', left: 0.143, top: 0.33 });
    const result = proposeSolutions([page(0, specs)], entries('1.1'), undefined, { answerKey: { page: 0, top: 0.1 } });
    const one = result.sections[0]?.answers.find((answer) => answer.label === '1');
    expect(one?.regions[0]?.rect.bottom).toBeGreaterThan(0.24 + 0.0155);
    expect(one?.regions[0]?.rect.bottom).toBeLessThan(0.27);
  });

  it('assigns a band with a damaged header to the next section in order, and says it did', () => {
    const first: Spec[] = [chapterHeader(0.1), { text: '1.1', left: 0.143, top: 0.15, size: 10 }, { text: 'Answers - Section 1.1', left: 0.4, top: 0.17 }];
    for (let k = 1; k <= 4; k += 1) first.push({ text: `${k}) r${k}`, left: 0.143, top: 0.2 + k * 0.03 });
    // The band of 1.2 has a header whose text layer is garbled (a huge wrong font size) and no marker.
    const second: Spec[] = [{ text: 'Answers - Sect\u0002on 1.2 5)x 6)y', left: 0.3, top: 0.2, right: 0.8, size: 120 }];
    for (let k = 1; k <= 4; k += 1) second.push({ text: `${k}) s${k}`, left: 0.143, top: 0.3 + k * 0.03 });
    const result = proposeSolutions([page(0, first), page(1, second)], entries('1.1', '1.2'), undefined, { answerKey: { page: 0, top: 0.1 } });
    expect(result.sections[0]?.answers.map((answer) => answer.label)).toEqual(['1', '2', '3', '4']);
    expect(result.sections[1]?.answers.map((answer) => answer.label)).toEqual(['1', '2', '3', '4']);
    expect(result.sections[1]?.answers[0]?.evidence.join(' ')).toContain('follows the previous section');
    expect(result.sections[1]?.answers[0]?.confidence).toBeLessThan(0.8);
  });

  it('keeps graph answers (a number that stands alone, a figure below it) with their column and says nothing is lost', () => {
    const specs: Spec[] = [chapterHeader(0.1), { text: '1.1', left: 0.143, top: 0.15, size: 10 }, { text: 'Answers - Section 1.1', left: 0.4, top: 0.17 }];
    specs.push({ text: '1)', left: 0.143, top: 0.22 }, { text: '2)', left: 0.392, top: 0.22 }, { text: '3)', left: 0.642, top: 0.22 });
    // labels of a figure that reach beyond the column of its number
    specs.push({ text: 'A', left: 0.2, top: 0.26, size: 10 }, { text: 'B', left: 0.45, top: 0.27, size: 10 }, { text: 'C', left: 0.7, top: 0.28, size: 10 });
    specs.push({ text: '4)', left: 0.143, top: 0.5 }, { text: '5)', left: 0.392, top: 0.5 }, { text: '6)', left: 0.642, top: 0.5 });
    const ink = new Array<number>(400).fill(0);
    for (let band = 100; band < 160; band += 1) ink[band] = 0.4;
    const withInk = { ...page(0, specs), ink };
    const result = proposeSolutions([withInk], entries('1.1'), undefined, { answerKey: { page: 0, top: 0.1 } });
    const answers = result.sections[0]?.answers ?? [];
    expect(answers.map((answer) => answer.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    const one = answers[0]?.regions[0]?.rect as Rect;
    const two = answers[1]?.regions[0]?.rect as Rect;
    // The figure reaches down over the ink (0.25 to 0.4) and the label A is inside the frame of 1, B inside the frame of 2.
    expect(one.bottom).toBeGreaterThan(0.38);
    expect(one.bottom).toBeLessThan(0.5);
    expect(one.right).toBeLessThanOrEqual(two.left + 1e-6);
    expect(two.right).toBeGreaterThan(0.5);
    expect(result.notes).toEqual([]);
  });
});
