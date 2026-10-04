import type { PageText } from '../model/types.js';
import type { ProjectSession } from '../session.js';
import { measureInk } from './ink-measure.js';
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

export interface VerifySessionOptions extends Omit<VerifyOptions, 'ink'> {
  /** Also render the pages and check that no edge of a region runs through printed ink (`edge-on-ink`). Slower: every page that has a region is drawn once. */
  ink?: boolean;
  /** Called after each page that was rendered for the ink check. */
  onInkPage?: (done: number, total: number) => void;
}

/** Verifies the project of a session against its PDF: reads the pages the check needs, then {@link verifyProject}. */
export async function verifySession(session: ProjectSession, options: VerifySessionOptions = {}): Promise<VerifyReport> {
  const { ink, onInkPage, ...rest } = options;
  const pages = await readPageTexts(session, pagesToVerify(session.project, rest));
  if (ink !== true) return verifyProject(session.project, pages, rest);
  const measured = await measureInk(await session.document(), regionsToMeasure(session.project, rest), onInkPage === undefined ? {} : { onPage: onInkPage });
  return verifyProject(session.project, pages, { ...rest, ink: measured.lookup });
}
