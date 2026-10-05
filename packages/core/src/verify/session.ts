import type { PageText } from '../model/types.js';
import type { PdfDocument } from '../pdf/document.js';
import type { ProjectSession } from '../session.js';
import { measureInk } from './ink-measure.js';
import { censusOf, type CensusReport } from './runs.js';
import { pagesToVerify, regionsToMeasure, verifyProject, type PageSource } from './verify.js';
import type { VerifyOptions, VerifyReport } from './types.js';

/**
 * The text of the given pages of the session's PDF, read once, as the lookup the checks take. The PDF is read for its text
 * layer only (with the fonts, so that bold lines are known): nothing is rendered and nothing leaves the machine.
 */
export async function readPageTexts(session: ProjectSession, pages: readonly number[]): Promise<PageSource> {
  const pdf = await session.document();
  const texts = new Map<number, PageText>();
  for (const page of pages) texts.set(page, await pdf.pageText(page, { fonts: true }));
  return (page) => texts.get(page);
}

/** The whole book as it was read, once for each open PDF: the gate, an acknowledgement and a review in one process do not read the pages again. */
const wholeBooks = new WeakMap<PdfDocument, Promise<PageSource>>();

/**
 * The text of EVERY page of the session's PDF, read once for the open document (the census of numbered runs reads the whole book, also a
 * project that has no exercise). The pages are read without their fonts: that is several times faster, a page that was read with them
 * already (the pages of the exercises) is not read again, and the census does not depend on which pages carry them.
 */
export async function readWholeBook(session: ProjectSession, onPage?: (done: number, total: number) => void): Promise<PageSource> {
  const pdf = await session.document();
  const held = wholeBooks.get(pdf);
  if (held !== undefined) return held;
  const reading = (async (): Promise<PageSource> => {
    const texts: PageText[] = [];
    for (let page = 0; page < pdf.pageCount; page += 1) {
      texts.push(await pdf.pageText(page));
      onPage?.(page + 1, pdf.pageCount);
    }
    return (page) => texts[page];
  })();
  wholeBooks.set(pdf, reading);
  // A reading that failed is not kept: the next call tries again.
  reading.catch(() => wholeBooks.delete(pdf));
  return reading;
}

/** `mcprep exercises census`: every run of numbered items in the whole book, and whether the project covers it. Reads every page; nothing is changed. */
export async function censusSession(session: ProjectSession, options: { minRun?: number; keywords?: readonly string[]; onPage?: (done: number, total: number) => void } = {}): Promise<CensusReport> {
  const pages = await readWholeBook(session, options.onPage);
  return censusOf(session.project, pages, { ...(options.minRun !== undefined ? { minRun: options.minRun } : {}), ...(options.keywords !== undefined ? { keywords: options.keywords } : {}) });
}

export interface VerifySessionOptions extends Omit<VerifyOptions, 'ink' | 'numberedRuns'> {
  /** Also render the pages and check that no edge of a region runs through printed ink (`edge-on-ink`). Slower: every page that has a region is drawn once. */
  ink?: boolean;
  /** Called after each page that was rendered for the ink check. */
  onInkPage?: (done: number, total: number) => void;
  /**
   * The census of numbered runs (`numbered-run-uncovered`) reads every page of the book and is part of the report unless this is false. It is never
   * made for a section filter (`sections`): that asks about some sections only.
   */
  census?: boolean;
}

/** Verifies the project of a session against its PDF: reads the pages the check needs, then {@link verifyProject}. */
export async function verifySession(session: ProjectSession, options: VerifySessionOptions = {}): Promise<VerifyReport> {
  const { ink, onInkPage, census, ...rest } = options;
  const pages = await readPageTexts(session, pagesToVerify(session.project, rest));
  // The pages of the exercises are read first, with their fonts; the rest of the book follows, without them.
  const whole = census !== false && (rest.sections ?? []).length === 0 ? await readWholeBook(session) : undefined;
  const given: VerifyOptions = { ...rest, ...(whole !== undefined ? { numberedRuns: whole } : {}) };
  if (ink !== true) return verifyProject(session.project, pages, given);
  const measured = await measureInk(await session.document(), regionsToMeasure(session.project, rest), onInkPage === undefined ? {} : { onPage: onInkPage });
  return verifyProject(session.project, pages, { ...given, ink: measured.lookup });
}
