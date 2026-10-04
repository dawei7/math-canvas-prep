import type { PageText } from '../model/types.js';
import type { ProjectSession } from '../session.js';
import { pagesToVerify, verifyProject, type PageSource } from './verify.js';
import type { VerifyOptions, VerifyReport } from './types.js';

/**
 * The text of the given pages of the session's PDF, read once, as the lookup the checks take. The PDF is read for its text
 * layer only: nothing is rendered and nothing leaves the machine.
 */
export async function readPageTexts(session: ProjectSession, pages: readonly number[]): Promise<PageSource> {
  const pdf = await session.document();
  const texts = new Map<number, PageText>();
  for (const page of pages) texts.set(page, await pdf.pageText(page));
  return (page) => texts.get(page);
}

/** Verifies the project of a session against its PDF: reads the pages the check needs, then {@link verifyProject}. */
export async function verifySession(session: ProjectSession, options: VerifyOptions = {}): Promise<VerifyReport> {
  const pages = await readPageTexts(session, pagesToVerify(session.project, options));
  return verifyProject(session.project, pages, options);
}
