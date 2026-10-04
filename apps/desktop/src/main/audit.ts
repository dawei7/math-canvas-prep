import { deriveSections, type BookStructure, type PageText, type PdfDocument } from '@mcprep/core';

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
