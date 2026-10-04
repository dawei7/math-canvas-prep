import { createHash } from 'node:crypto';
import { newProject, type Frame, type OutlineEntry, type PageSize, type PageText, type Project, type Region, type TextLine } from '@mcprep/core';
import { buildPdf, type PdfPageSpec, type PdfText } from '@mcprep/core/testing';

/**
 * A synthetic workbook of the size the owner has in mind, for tests of speed: thousands of book exercises on two-column
 * practice pages (44 small frames on one page), their answers in a dense answer key at the back of the same PDF, and a
 * hundred sections (ten chapters, ninety sections) that each begin at the top of a page. The labels restart at 1 in every
 * section, as a workbook's practice sets do. Everything in it is invented.
 */

export interface BigBookOptions {
  exercises?: number;
  /** Outline entries in all: chapters of nine sections each, the chapter's own entry included. */
  sections?: number;
  perPage?: number;
  /** Answers per key page. */
  keyPerPage?: number;
}

export interface BigBook {
  pdf: Uint8Array;
  sha256: string;
  project: Project;
  /** The text of every page as the editor reads it (without having to read the PDF). */
  pageTexts: PageText[];
  pageSizes: PageSize[];
  pageCount: number;
  practicePages: number;
  keyPages: number;
}

const HEIGHT = 842;
const WIDTH = 595;
/** Words for the exercises, so that the lines of a page are not all the same up to their numbers (that is what a running header is). */
const VERBS = ['Solve', 'Simplify', 'Factor', 'Expand', 'Evaluate', 'Compute', 'Find', 'Check', 'Rewrite', 'Reduce', 'Estimate'];
const NOUNS = ['sum', 'product', 'root', 'square', 'fraction', 'quotient', 'difference', 'power', 'average', 'ratio', 'factor', 'term', 'value', 'sign', 'pair', 'total', 'area'];
const round = (value: number): number => Math.round(value * 100000) / 100000;

export function buildBigBook(options: BigBookOptions = {}): BigBook {
  const exercises = options.exercises ?? 5000;
  const sectionTotal = options.sections ?? 100;
  const perPage = options.perPage ?? 44;
  const keyPerPage = options.keyPerPage ?? 240;
  const practicePages = Math.ceil(exercises / perPage);
  const keyPages = Math.ceil(exercises / keyPerPage);
  const pageCount = practicePages + keyPages;
  const half = perPage / 2;
  const rowPitch = 0.86 / half;

  // Ten chapters; each chapter's own entry, then its sections. Every section starts at the top of a page.
  const chapterCount = Math.max(1, Math.round(sectionTotal / 10));
  const leafCount = sectionTotal - chapterCount;
  const leavesPerChapter = Math.ceil(leafCount / chapterCount);
  const leafStart = (leaf: number): number => Math.floor((leaf * practicePages) / leafCount);
  const outline: OutlineEntry[] = [];
  const leafOf: { id: string; first: number }[] = [];
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const chapter = Math.floor(leaf / leavesPerChapter);
    if (leaf % leavesPerChapter === 0) outline.push({ title: `Chapter ${chapter + 1}`, page: leafStart(leaf), depth: 0, id: `c${chapter + 1}`, label: `Chapter ${chapter + 1}`, top: 0.02 });
    const id = `${chapter + 1}.${(leaf % leavesPerChapter) + 1}`;
    outline.push({ title: `${id} Practice set ${leaf + 1}`, page: leafStart(leaf), depth: 1, id, label: id, top: 0.04 });
    leafOf.push({ id, first: leafStart(leaf) });
  }

  const frames: Frame[] = [];
  const pageLines: TextLine[][] = Array.from({ length: pageCount }, () => []);
  const pdfPages: PdfPageSpec[] = Array.from({ length: pageCount }, () => ({ texts: [] as PdfText[] }));
  const line = (page: number, rect: { left: number; top: number; right: number; bottom: number }, text: string, size: number, column = 0): void => {
    pageLines[page]?.push({ text, rect, fontSize: size, column, chars: text.length });
    (pdfPages[page]?.texts as PdfText[]).push({ text, x: rect.left * WIDTH, y: ((rect.top + rect.bottom) / 2 + 0.004) * HEIGHT, size });
  };

  const labelCount = new Map<string, number>();
  for (let i = 0; i < exercises; i += 1) {
    const page = Math.floor(i / perPage);
    const slot = i % perPage;
    const column = slot < half ? 0 : 1;
    const row = slot % half;
    const top = round(0.07 + row * rowPitch);
    const left = column === 0 ? 0.07 : 0.53;
    // The section: the last one that starts on or before this page.
    let at = leafOf.length - 1;
    while (at > 0 && (leafOf[at] as { first: number }).first > page) at -= 1;
    const section = leafOf[at] as { id: string; first: number };
    const number = (labelCount.get(section.id) ?? 0) + 1;
    labelCount.set(section.id, number);
    const rect = { left, top, right: round(left + 0.4), bottom: round(top + rowPitch * 0.88) };
    const keyPage = practicePages + Math.floor(i / keyPerPage);
    const keySlot = i % keyPerPage;
    const keyColumn = Math.floor(keySlot / 60);
    const keyRow = keySlot % 60;
    const keyRect = { left: round(0.06 + keyColumn * 0.235), top: round(0.06 + keyRow * 0.0155), right: round(0.06 + keyColumn * 0.235 + 0.17), bottom: round(0.06 + keyRow * 0.0155 + 0.0125) };
    const frame: Frame = { id: `f${i + 1}`, kind: 'exercise', page, rect, authority: 'book', label: String(number), section: section.id, solution: [{ page: keyPage, rect: keyRect }] };
    // The first exercise of a section carries the instruction printed above the practice set.
    if (number === 1) frame.context = [{ page: section.first, rect: { left: 0.07, top: 0.045, right: 0.93, bottom: 0.062 } }];
    frames.push(frame);
    line(page, rect, `${number}. ${VERBS[(i * 7 + page) % VERBS.length]} the ${NOUNS[(i * 13 + page * 5) % NOUNS.length]} of x + ${number} in set ${section.id}.`, 9, column);
    line(keyPage, keyRect, `${number}) ${number}`, 8, keyColumn);
  }
  for (let page = 0; page < practicePages; page += 1) {
    line(page, { left: 0.07, top: 0.02, right: 0.5, bottom: 0.034 }, 'Synthetic Practice Workbook', 8);
    const starting = leafOf.filter((leaf) => leaf.first === page);
    for (const leaf of starting) line(page, { left: 0.07, top: 0.045, right: 0.93, bottom: 0.062 }, `${leaf.id} Solve each equation.`, 10);
  }
  for (let page = practicePages; page < pageCount; page += 1) line(page, { left: 0.06, top: 0.02, right: 0.5, bottom: 0.034 }, 'Answers', 12);

  const pdf = buildPdf({ title: 'Synthetic Practice Workbook', pages: pdfPages });
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const base = newProject({ pdf: { path: 'practice.pdf', sha256, bytes: pdf.length, pageCount }, title: 'Synthetic Practice Workbook', folder: 'Books/Practice', now: new Date('2026-10-04T12:00:00Z') });
  const project: Project = { ...base, frames, outline: { source: 'manual', entries: outline }, seq: exercises };
  const pageSizes: PageSize[] = Array.from({ length: pageCount }, () => ({ width: WIDTH, height: HEIGHT, rotation: 0 }));
  const pageTexts: PageText[] = pageLines.map((lines, page) => ({ page, size: { width: WIDTH, height: HEIGHT, rotation: 0 }, lines: lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left), columns: page < practicePages ? 2 : 4, hasText: true }));
  return { pdf, sha256, project, pageTexts, pageSizes, pageCount, practicePages, keyPages };
}

/** The regions of a frame on a page, for the checks of a test. */
export const regionsOn = (frame: Frame, page: number): Region[] => [...(frame.context ?? []), ...(frame.solution ?? [])].filter((region) => region.page === page);
