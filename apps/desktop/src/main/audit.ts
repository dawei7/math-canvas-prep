import {
  deriveSections,
  locateSections,
  proposeExercises,
  proposeSolutions,
  type BookEntry,
  type BookStructure,
  type OutlineEntry,
  type PageText,
  type PdfDocument,
  type PlaceOnPage,
} from '@mcprep/core';
import type { BookRequest, BookResult } from '../shared/api.js';

/**
 * The long jobs of auditing a book, run in the main process: the PDF is read page by page, the heuristics themselves take a
 * fraction of a second, and between the steps the job reports its progress and looks whether the person stopped it. A job is
 * stopped between two pages or two steps; a step that is running is finished first (a page takes milliseconds, a heuristic
 * well under a second on a book of 500 pages).
 *
 * pdf.js does its work in chains of promises that never give the event loop a turn: a loop that only awaits pages keeps the
 * main process from sending the progress, from hearing the click on Stop and from answering the window for the whole job
 * (measured: 2 000 pages, 4.7 seconds, not one timer fired). Every loop here therefore hands the turn back about every 25
 * milliseconds, see {@link pacer}.
 */

/** What a job tells the window and asks the window: how far it is, and whether it should stop. */
export interface AuditHooks {
  report(phase: string, done: number, total: number): void;
  /** Throws {@link AuditCancelled} when the person stopped the job. */
  check(): void;
}

export class AuditCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'AuditCancelled';
  }
}

/** A problem the person can do something about (no sections yet, a section that is not there), not a bug. */
export class AuditProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditProblem';
  }
}

/** Lets the main process do what is waiting (send the progress, hear a click on Stop) before the job goes on. */
export const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Hands the turn back to the main process when `sliceMs` have passed since the last time; call it after every page. */
export function pacer(sliceMs = 25): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await breathe();
    since = performance.now();
  };
}

export const READING_PAGES = 'Reading the text of the pages';

/** Every page with its lines and the fonts (bold lines mark headings and instructions), exactly as `allPageText` reads them. */
export async function readPages(pdf: PdfDocument, hooks: AuditHooks): Promise<PageText[]> {
  const pages: PageText[] = [];
  const turn = pacer();
  hooks.report(READING_PAGES, 0, pdf.pageCount);
  for (let page = 0; page < pdf.pageCount; page += 1) {
    hooks.check();
    pages.push(await pdf.pageText(page, { fonts: true }));
    hooks.report(READING_PAGES, page + 1, pdf.pageCount);
    await turn();
  }
  return pages;
}

/** Adds the ink profile and the ink map to the pages in `wanted` (figures, answers that are drawn, the white between lines). */
export async function addInk(pdf: PdfDocument, pages: PageText[], wanted: Iterable<number>, phase: string, hooks: AuditHooks): Promise<void> {
  const list = [...new Set(wanted)].filter((page) => pages[page] !== undefined && pages[page]?.inkMap === undefined).sort((a, b) => a - b);
  const turn = pacer();
  hooks.report(phase, 0, list.length);
  for (let at = 0; at < list.length; at += 1) {
    hooks.check();
    const page = list[at] as number;
    pages[page] = { ...(pages[page] as PageText), ink: await pdf.inkProfile(page), inkMap: await pdf.inkMap(page) };
    hooks.report(phase, at + 1, list.length);
    await turn();
  }
}

/** The chapters and sections of the book from its printed contents and its headings. */
export async function runDerive(pdf: PdfDocument, hooks: AuditHooks): Promise<BookStructure> {
  const pages = await readPages(pdf, hooks);
  hooks.check();
  const phase = 'Looking for the contents and the headings';
  hooks.report(phase, 0, 1);
  await breathe();
  const structure = deriveSections(pages);
  hooks.check();
  hooks.report(phase, 1, 1);
  return structure;
}

// ---------------------------------------------------------------------------------------------------------------------
// The exercises and the answers

/**
 * The sections of the window's outline, with the practice set of each found on the pages and the place of the answer key.
 * Exercises are filed under sections by id: without ids there is nothing to file them under.
 */
function locate(pages: readonly PageText[], outline: readonly OutlineEntry[]): { entries: BookEntry[]; answerKey?: PlaceOnPage; notes: string[] } {
  if (!outline.some((entry) => entry.id !== undefined)) {
    throw new AuditProblem('The book has no sections with ids yet, and exercises are filed under sections. Find them first: Sections tab, Derive sections.');
  }
  return locateSections(pages, outline);
}

/** The sections to search: all, or those named by id or printed number. */
export function chooseSections(entries: readonly BookEntry[], ids: readonly string[] | undefined): BookEntry[] {
  if (ids === undefined || ids.length === 0) return [...entries];
  const sections = entries.filter((entry) => entry.kind === 'section');
  const known = new Set(sections.flatMap((entry) => [entry.id, ...(entry.label !== undefined ? [entry.label] : [])]));
  for (const id of ids) if (!known.has(id)) throw new AuditProblem(`There is no section "${id}" that can have a practice set (a section below a chapter, with an id).`);
  return sections.filter((entry) => ids.includes(entry.id) || (entry.label !== undefined && ids.includes(entry.label)));
}

/** The pages of the practice sets (the ink map of a page tells where the white between two lines is), at most 40 pages of a set. */
export function practicePages(entries: readonly BookEntry[]): Set<number> {
  const pages = new Set<number>();
  for (const entry of entries) {
    const practice = entry.practice;
    if (!practice) continue;
    for (let page = practice.page; page <= Math.min(practice.end.page, practice.page + 40); page += 1) pages.add(page);
  }
  return pages;
}

/** The numbered exercises of the practice sets of the chosen sections. Reads every page, then the practice pages as pictures. */
export async function runExercises(pdf: PdfDocument, request: Extract<BookRequest, { kind: 'exercises' }>, hooks: AuditHooks): Promise<BookResult> {
  const pages = await readPages(pdf, hooks);
  hooks.check();
  const sections = locate(pages, request.outline);
  const chosen = chooseSections(sections.entries, request.sections);
  await addInk(pdf, pages, practicePages(chosen), 'Looking at the white between the lines', hooks);
  const phase = 'Looking for the exercises';
  hooks.report(phase, 0, 1);
  await breathe();
  const exercises = proposeExercises(pages, chosen);
  hooks.check();
  hooks.report(phase, 1, 1);
  return { kind: 'exercises', exercises, notes: [...sections.notes, ...exercises.notes] };
}

/** The answers of the answer key, matched to the exercises the window has. Reads every page, then the pages of the key as pictures. */
export async function runSolutions(pdf: PdfDocument, request: Extract<BookRequest, { kind: 'solutions' }>, hooks: AuditHooks): Promise<BookResult> {
  if (request.exercises.length === 0) {
    throw new AuditProblem('The book has no book exercises yet, and an answer belongs to an exercise. Find the exercises first (Propose, Book exercises).');
  }
  const pages = await readPages(pdf, hooks);
  hooks.check();
  const sections = locate(pages, request.outline);
  const key = new Set<number>();
  if (sections.answerKey) for (let page = sections.answerKey.page; page < pages.length; page += 1) key.add(page);
  await addInk(pdf, pages, key, 'Looking at the answer key', hooks);
  const phase = 'Looking for the answers';
  hooks.report(phase, 0, 1);
  await breathe();
  const solutions = proposeSolutions(pages, sections.entries, request.exercises, sections.answerKey ? { answerKey: sections.answerKey } : {});
  hooks.check();
  hooks.report(phase, 1, 1);
  return { kind: 'solutions', solutions, notes: solutions.notes, ...(sections.answerKey ? { answerKey: sections.answerKey } : {}) };
}
