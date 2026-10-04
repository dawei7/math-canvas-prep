import { bookReference, isAuthoritative, normalizeLabel } from '../model/authority.js';
import { rectArea } from '../model/rect.js';
import type { Frame, Rect, Region } from '../model/types.js';
import type { Project } from '../project/model.js';
import type { Exercise, Prepared } from './common.js';
import { headingNames, PageKinds, type HeadingNames } from './lineclass.js';
import type { PageIndex } from './regions.js';

/**
 * What the checks that read whole pages share: where the exercises of each section are printed (its zone), where the answer
 * key is, which regions cover which text, and what each line of a page is. Built once for a run of `verifyProject`.
 */

/** A place in the document as one number: the page and the position from its top (0 to just under 1). */
export const pos = (page: number, y: number): number => page + Math.min(Math.max(y, 0), 0.999999);

/** The regions of a frame in the order its text is read: its own region, then its continuations. */
export const chainOf = (frame: Frame): Region[] => [{ page: frame.page, rect: frame.rect }, ...(frame.continues ?? [])];

/** Where the exercises of one section are printed: from the top of the first to where the section ends. */
export interface Zone {
  id: string;
  /** The place of the section in the outline. */
  rank: number;
  exercises: Exercise[];
  start: number;
  /** Exclusive. */
  end: number;
  /** Where the last exercise region of the section ends. */
  lastEnd: number;
  /** The answers follow the exercises of this section (a solution region lies after them in the zone). */
  answers: boolean;
}

/** The pages that carry the answer key at the back of the book: from the first to the last solution region that follows all the exercises. */
export interface KeyZone {
  first: number;
  last: number;
  /** Where the zone of the last section ends. */
  start: number;
}

export interface Layout {
  zones: Zone[];
  key: KeyZone | undefined;
  /** Where the last exercise region of the book ends (-1 without exercises). */
  lastExercise: number;
}

/** The zones and the key of a project, from the outline and the frames (no text needed). */
export function computeLayout(project: Project, state: Prepared): Layout {
  let lastExercise = -1;
  const solutions: { page: number; start: number }[] = [];
  for (const frame of project.frames) {
    if (!isAuthoritative(frame)) continue;
    for (const region of chainOf(frame)) lastExercise = Math.max(lastExercise, pos(region.page, region.rect.bottom));
    for (const region of frame.solution ?? []) solutions.push({ page: region.page, start: pos(region.page, region.rect.top) });
  }
  const behind = solutions.filter((entry) => entry.start > lastExercise);
  let key: KeyZone | undefined;
  if (behind.length > 0 && behind.length * 2 >= solutions.length) {
    const pages = behind.map((entry) => entry.page);
    key = { first: Math.min(...pages), last: Math.max(...pages), start: Math.min(...pages) };
  }

  const tree = state.tree;
  const groups = new Map<string, Exercise[]>();
  for (const exercise of state.exercises) {
    if (!exercise.book) continue;
    const list = groups.get(exercise.section as string);
    if (list) list.push(exercise);
    else groups.set(exercise.section as string, [exercise]);
  }
  const zones: Zone[] = [];
  for (const [id, exercises] of groups) {
    const index = tree.byId.get(id);
    const node = index === undefined ? undefined : tree.nodes[index];
    if (node === undefined) continue;
    let start = Number.POSITIVE_INFINITY;
    let lastEnd = -1;
    for (const exercise of exercises) {
      start = Math.min(start, pos(exercise.frame.page, exercise.frame.rect.top));
      for (const region of chainOf(exercise.frame)) lastEnd = Math.max(lastEnd, pos(region.page, region.rect.bottom));
    }
    let end = Math.max(node.end.page + node.end.top, lastEnd);
    if (key !== undefined) end = Math.max(Math.min(end, key.start), lastEnd);
    const answers = exercises.some((exercise) => (exercise.frame.solution ?? []).some((region) => pos(region.page, region.rect.top) >= lastEnd - 1e-6 && pos(region.page, region.rect.top) < end));
    zones.push({ id, rank: state.sectionRank(id), exercises, start, end, lastEnd, answers });
  }
  zones.sort((a, b) => a.start - b.start || a.rank - b.rank);
  return { zones, key, lastExercise };
}

/** The zero-based pages a zone or the key reaches, inside the document. */
export function pagesOfRange(from: number, to: number, pageCount: number): number[] {
  const pages: number[] = [];
  for (let page = Math.max(0, Math.floor(from)); page <= Math.min(pageCount - 1, Math.ceil(to) - 1); page += 1) pages.push(page);
  return pages;
}

/** A region that covers text: an exercise, a continuation, an instruction or a solution of some frame. */
export interface Covering {
  page: number;
  rect: Rect;
  kind: 'exercise' | 'continues' | 'context' | 'solution';
  frame: Frame;
}

export interface Run {
  project: Project;
  state: Prepared;
  index: PageIndex;
  patterns: RegExp[] | undefined;
  /** A section filter is active: the answer key is not judged as a whole. */
  filtered: boolean;
  layout: Layout;
  names: HeadingNames;
  kinds(page: number): PageKinds;
  covering(page: number): readonly Covering[];
  /** `SECTION:LABEL` of an authoritative frame, else its id. */
  refOf(frame: Frame): string;
  exerciseOf(frame: Frame): Exercise | undefined;
}

export function buildRun(project: Project, state: Prepared, index: PageIndex, patterns: RegExp[] | undefined, filtered: boolean): Run {
  const byPage = new Map<number, Covering[]>();
  const add = (frame: Frame, kind: Covering['kind'], region: Region): void => {
    const list = byPage.get(region.page);
    const entry: Covering = { page: region.page, rect: region.rect, kind, frame };
    if (list) list.push(entry);
    else byPage.set(region.page, [entry]);
  };
  for (const frame of project.frames) {
    add(frame, 'exercise', { page: frame.page, rect: frame.rect });
    for (const region of frame.continues ?? []) add(frame, 'continues', region);
    for (const region of frame.context ?? []) add(frame, 'context', region);
    for (const region of frame.solution ?? []) add(frame, 'solution', region);
  }
  const names = headingNames(project.outline?.entries ?? []);
  const kinds = new Map<number, PageKinds>();
  const exercises = new Map<Frame, Exercise>(state.exercises.map((exercise) => [exercise.frame, exercise]));
  return {
    project,
    state,
    index,
    patterns,
    filtered,
    layout: computeLayout(project, state),
    names,
    kinds(page) {
      let found = kinds.get(page);
      if (!found) {
        found = new PageKinds(index.page(page), names, patterns);
        kinds.set(page, found);
      }
      return found;
    },
    covering: (page) => byPage.get(page) ?? [],
    refOf: (frame) => (isAuthoritative(frame) && frame.section !== undefined && frame.label !== undefined ? bookReference(frame.section, normalizeLabel(frame.label).label) : frame.id),
    exerciseOf: (frame) => exercises.get(frame),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Covering

const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The share of a box (0 to 1) that lies inside the union of the regions. */
export function coveredShare(box: Rect, regions: readonly Covering[]): number {
  const area = rectArea(box);
  if (area <= 0) return 1;
  const hits = regions.filter((region) => overlaps(box, region.rect));
  if (hits.length === 0) return 0;
  const xs = [box.left, box.right];
  const ys = [box.top, box.bottom];
  for (const hit of hits) {
    xs.push(Math.min(Math.max(hit.rect.left, box.left), box.right), Math.min(Math.max(hit.rect.right, box.left), box.right));
    ys.push(Math.min(Math.max(hit.rect.top, box.top), box.bottom), Math.min(Math.max(hit.rect.bottom, box.top), box.bottom));
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    for (let j = 0; j + 1 < ys.length; j += 1) {
      const cell: Rect = { left: xs[i] as number, right: xs[i + 1] as number, top: ys[j] as number, bottom: ys[j + 1] as number };
      const size = (cell.right - cell.left) * (cell.bottom - cell.top);
      if (size <= 0) continue;
      const mx = (cell.left + cell.right) / 2;
      const my = (cell.top + cell.bottom) / 2;
      if (hits.some((hit) => mx >= hit.rect.left && mx <= hit.rect.right && my >= hit.rect.top && my <= hit.rect.bottom)) covered += size;
    }
  }
  return Math.min(1, covered / area);
}
