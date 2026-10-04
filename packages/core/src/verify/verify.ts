import type { PageText, Rect } from '../model/types.js';
import type { Project } from '../project/model.js';
import { LIMITS } from '../rules/constants.js';
import { McPrepError } from '../rules/issues.js';
import { isAuthoritative } from '../model/authority.js';
import { draft, prepare, type Draft, type Prepared } from './common.js';
import { checkContexts } from './context.js';
import { checkContinuations } from './continuation.js';
import { checkCoverage } from './coverage.js';
import { checkContextOverlaps, checkRegionSizes, checkSharedPlaces, ownRegionsByPage } from './geometry.js';
import { checkInk } from './ink.js';
import { checkKeys } from './key.js';
import { PageIndex } from './regions.js';
import { buildRun, chainOf, computeLayout, pagesOfRange, zoneLead } from './run.js';
import { checkSections } from './sequence.js';
import { checkExerciseText, checkSolutionText } from './text.js';
import { SEVERITY_RANK, VERIFY_CODES, VERIFY_FORMAT, VERIFY_VERSION, type VerifyOptions, type VerifyReport } from './types.js';

/** The text of a page (a PDF read with `PdfDocument.pageText`), or undefined for a page that was not read. */
export type PageSource = (page: number) => PageText | undefined;

const CODE_RANK = new Map<string, number>(VERIFY_CODES.map((entry, index) => [entry.code, index]));

/** The sections to look at, checked against what the project has; undefined for all of them. */
function chosenSections(project: Project, options: VerifyOptions): ReadonlySet<string> | undefined {
  const wanted = (options.sections ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  if (wanted.length === 0) return undefined;
  const known = new Set<string>();
  for (const entry of project.outline?.entries ?? []) if (entry.id !== undefined) known.add(entry.id);
  for (const frame of project.frames) if (frame.authority === 'book' && frame.section !== undefined) known.add(frame.section);
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length > 0) {
    const names = [...known].slice(0, 12).join(', ');
    throw new McPrepError('E_USAGE', `There ${missing.length === 1 ? 'is no section' : 'are no sections'} ${missing.map((id) => `"${id}"`).join(', ')} in this project.`, {
      hint: known.size === 0 ? 'The project has no sections yet: `mcprep outline derive --book --apply`.' : `The sections are ${names}${known.size > 12 ? ', ...' : ''} (\`mcprep outline\` lists them).`,
    });
  }
  return new Set(wanted);
}

/** The patterns without the flags that make a regular expression remember where it stopped. */
const stateless = (patterns: readonly RegExp[] | undefined): RegExp[] | undefined =>
  patterns && patterns.length > 0 ? patterns.map((pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))) : undefined;

function prepared(project: Project, options: VerifyOptions): Prepared {
  return prepare(project.frames, project.outline?.entries, project.pdf.pageCount, chosenSections(project, options));
}

/**
 * The pages whose text the check reads: every page of an authoritative exercise (its regions, instructions and solutions), the
 * pages of the zone of each section (from its first exercise to where it ends), the pages of the answer key, and the pages a
 * span of regions passes over.
 */
export function pagesToVerify(project: Project, options: VerifyOptions = {}): number[] {
  const state = prepared(project, options);
  const pageCount = project.pdf.pageCount;
  const pages = new Set<number>();
  for (const exercise of state.exercises) {
    if (!exercise.book) continue;
    const frame = exercise.frame;
    pages.add(frame.page);
    for (const region of frame.solution ?? []) pages.add(region.page);
    for (const region of frame.context ?? []) pages.add(region.page);
    const chain = chainOf(frame);
    for (let i = 0; i < chain.length; i += 1) {
      const region = chain[i] as (typeof chain)[number];
      pages.add(region.page);
      const next = chain[i + 1];
      if (next !== undefined) for (let page = region.page; page <= next.page; page += 1) pages.add(page);
    }
    if ((frame.continues?.length ?? 0) >= LIMITS.maxRegions) pages.add((chain[chain.length - 1] as (typeof chain)[number]).page + 1);
  }
  const layout = computeLayout(project, state);
  for (const zone of layout.zones) for (const page of pagesOfRange(zoneLead(zone), zone.end, pageCount)) pages.add(page);
  if (layout.key !== undefined && chosenSections(project, options) === undefined) for (let page = layout.key.first; page <= layout.key.last; page += 1) pages.add(page);
  return [...pages].filter((page) => Number.isInteger(page) && page >= 0 && page < pageCount).sort((a, b) => a - b);
}

/** The regions whose edges `edge-on-ink` looks at: every region of every exercise that is checked. */
export function regionsToMeasure(project: Project, options: VerifyOptions = {}): { page: number; rect: Rect }[] {
  const regions: { page: number; rect: Rect }[] = [];
  for (const exercise of prepared(project, options).exercises) {
    const frame = exercise.frame;
    regions.push(...chainOf(frame), ...(frame.context ?? []), ...(frame.solution ?? []));
  }
  return regions;
}

/**
 * An audited book holds only the exercises the book prints. A frame that is none of them (an exercise, question or bookmark framed
 * for oneself) is something the audit did not mean to leave in: a stray region.
 */
function checkStrays(project: Project, state: Prepared): Draft[] {
  if (!project.frames.some((frame) => isAuthoritative(frame))) return [];
  const drafts: Draft[] = [];
  for (const frame of project.frames) {
    if (isAuthoritative(frame)) continue;
    drafts.push(
      draft(
        'stray-frame',
        'warning',
        frame.id,
        frame.page,
        `The frame ${frame.id} on page ${frame.page} (${frame.kind}) is no exercise of the book, in a project that is audited as a book: a stray region.`,
        `${frame.kind} at ${[frame.rect.left, frame.rect.top, frame.rect.right, frame.rect.bottom].map((value) => Math.round(value * 1000) / 1000).join(',')}`,
        { section: state.sectionRank(undefined), page: frame.page, top: frame.rect.top, left: frame.rect.left },
      ),
    );
  }
  return drafts;
}

const compareDrafts = (a: Draft, b: Draft): number =>
  SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
  (CODE_RANK.get(a.finding.code) as number) - (CODE_RANK.get(b.finding.code) as number) ||
  (b.weight ?? 0) - (a.weight ?? 0) ||
  a.where.section - b.where.section ||
  a.where.page - b.where.page ||
  a.where.top - b.where.top ||
  a.where.left - b.where.left ||
  (a.finding.ref < b.finding.ref ? -1 : a.finding.ref > b.finding.ref ? 1 : 0) ||
  (a.finding.message < b.finding.message ? -1 : a.finding.message > b.finding.message ? 1 : 0);

/**
 * Checks the exercises of a project against the text of its pages and against each other. It needs no pixels and no network
 * and gives the same report for the same project whatever the order of the frames in the file: findings are sorted (errors,
 * warnings, infos; by code; by the order of the book). The text of the pages in `pagesToVerify` must be available from
 * `pages`; an exercise whose page is not has no text, which is reported as `no-text`.
 */
export function verifyProject(project: Project, pages: PageSource, options: VerifyOptions = {}): VerifyReport {
  const state = prepared(project, options);
  const index = new PageIndex(pages);
  const patterns = stateless(options.itemPatterns);
  const own = ownRegionsByPage(state.exercises);
  const sectioned = checkSections(state);
  const run = buildRun(project, state, index, patterns, chosenSections(project, options) !== undefined);
  const drafts: Draft[] = [
    ...checkExerciseText(state.exercises, index, patterns),
    ...checkSolutionText(state.exercises, index, patterns),
    ...checkSharedPlaces(own),
    ...checkContextOverlaps(state.exercises, own),
    ...checkRegionSizes(state.exercises),
    ...sectioned.drafts,
    ...checkContinuations(state.exercises),
    ...checkCoverage(run),
    ...checkContexts(run),
    ...checkKeys(run),
    ...(options.ink !== undefined ? checkInk(state.exercises, options.ink) : []),
    ...(chosenSections(project, options) === undefined ? checkStrays(project, state) : []),
  ];
  drafts.sort(compareDrafts);
  const findings = drafts.map((entry) => entry.finding);
  const book = state.exercises.filter((exercise) => exercise.book);
  return {
    format: VERIFY_FORMAT,
    version: VERIFY_VERSION,
    summary: {
      exercises: state.exercises.length,
      authoritative: book.length,
      sections: sectioned.sections.length,
      solutions: book.filter((exercise) => (exercise.frame.solution?.length ?? 0) > 0).length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      infos: findings.filter((finding) => finding.severity === 'info').length,
    },
    findings,
    sections: sectioned.sections,
  };
}
