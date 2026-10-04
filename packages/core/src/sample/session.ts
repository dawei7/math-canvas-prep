import type { ProjectSession } from '../session.js';
import { readPageTexts } from '../verify/session.js';
import { pagesToSample, sampleProject } from './sample.js';
import type { SampleOptions, SampleReport } from './types.js';

/** The review sample of the project of a session: reads the pages of the answers (their text layer only), then {@link sampleProject}. */
export async function sampleSession(session: ProjectSession, options: SampleOptions = {}): Promise<SampleReport> {
  const pages = await readPageTexts(session, pagesToSample(session.project));
  return sampleProject(session.project, pages, options);
}
