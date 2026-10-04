import { buildSectionTree, sectionPath } from '../book/sections.js';
import { bookExercisesInOrder } from '../book/summary.js';
import { bookReference, normalizeLabel } from '../model/authority.js';
import { rectArea, rectHeight } from '../model/rect.js';
import type { Frame, Rect } from '../model/types.js';
import type { Project } from '../project/model.js';
import { PageIndex } from '../verify/regions.js';
import type { PageSource } from '../verify/verify.js';
import { EXERCISE_REASONS, SAMPLE_DEFAULTS, SAMPLE_FORMAT, SAMPLE_LIMITS, SAMPLE_VERSION, SOLUTION_REASONS, type ExerciseReason, type SampleEntry, type SampleOptions, type SampleReport, type SolutionReason } from './types.js';

/**
 * The review sample, by rules that a person can apply by hand (docs/AUDIT_A_BOOK.md, "A fixed sample to look at"):
 *
 * 1. the first and the last exercise of every section;
 * 2. one exercise of each layout kind the book has, the first one in the order of the book: it has a continuation, its
 *    instruction is on another page, it stands with one other or two others in a row, the longest region, the smallest region,
 *    a region much taller than the median of its section (beside a figure);
 * 3. up to N exercises in all, filled with an even stride over the rest in the order of the book (index floor(k * M / count));
 * 4. for the answers: those of the exercises above (first those of rule 1), the answer with the most lines, a picture-only
 *    answer, the first answer of every chapter's key, then an even stride up to N.
 *
 * The rules never drop what they name: N fills the sample up, it does not cut it. Nothing is random and the order of the frames
 * in the file does not matter: the order of the book is the order of the sections in the outline and, within one, reading order.
 */

interface Item {
  frame: Frame;
  ref: string;
  /** The position in the order of the book. */
  order: number;
  section: string;
}

/** Ranking a measure must not depend on float noise: `0.1` is `0.1`, whichever way it was computed. */
const rounded = (value: number, digits = 5): number => Math.round(value * 10 ** digits) / 10 ** digits;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

const hasSolution = (item: Item): boolean => (item.frame.solution?.length ?? 0) > 0;

/** The exercises of the book with their references, in the order of the book. */
function itemsOf(project: Project): Item[] {
  return bookExercisesInOrder(project.frames, project.outline?.entries)
    .filter((frame) => frame.label !== undefined && frame.section !== undefined)
    .map((frame, order) => ({ frame, order, section: frame.section as string, ref: bookReference(frame.section as string, normalizeLabel(frame.label as string).label) }));
}

/** The pages whose text the sample reads: those of the solution regions (for the answer with the most lines and the picture-only one). */
export function pagesToSample(project: Project): number[] {
  const pages = new Set<number>();
  for (const item of itemsOf(project)) for (const region of item.frame.solution ?? []) pages.add(region.page);
  return [...pages].filter((page) => Number.isInteger(page) && page >= 0 && page < project.pdf.pageCount).sort((a, b) => a - b);
}

/** Exercises in one row: they share a band of a page and stand in different columns. */
function rowsOf(items: readonly Item[]): { first: Item; columns: number }[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = `${item.section}\u0000${item.frame.page}`;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const rows: { first: Item; columns: number }[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.frame.rect.top - b.frame.rect.top || a.frame.rect.left - b.frame.rect.left || a.order - b.order);
    const clusters: Item[][] = [];
    for (const item of sorted) {
      const cluster = clusters[clusters.length - 1];
      const head = cluster?.[0]?.frame.rect;
      if (cluster && head) {
        const overlap = Math.min(head.bottom, item.frame.rect.bottom) - Math.max(head.top, item.frame.rect.top);
        const smaller = Math.min(head.bottom - head.top, item.frame.rect.bottom - item.frame.rect.top);
        if (smaller > 0 && overlap / smaller >= SAMPLE_LIMITS.rowOverlap) {
          cluster.push(item);
          continue;
        }
      }
      clusters.push([item]);
    }
    for (const cluster of clusters) {
      let columns = 0;
      let last = Number.NEGATIVE_INFINITY;
      for (const item of [...cluster].sort((a, b) => a.frame.rect.left - b.frame.rect.left)) {
        if (item.frame.rect.left - last >= SAMPLE_LIMITS.columnGap) {
          columns += 1;
          last = item.frame.rect.left;
        }
      }
      rows.push({ first: cluster.reduce((best, item) => (item.order < best.order ? item : best)), columns });
    }
  }
  return rows;
}

/** An even stride over the list: `count` entries, the k-th at index floor(k * M / count); all of them when there are not more than `count`. */
function stride<T>(list: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= list.length) return [...list];
  return Array.from({ length: count }, (_unused, k) => list[Math.floor((k * list.length) / count)] as T);
}

/** A map of what picked each item, rules in the order they were applied. */
class Picks<R extends string> {
  readonly reasons = new Map<Item, R[]>();
  add(item: Item, reason: R): void {
    const list = this.reasons.get(item);
    if (!list) this.reasons.set(item, [reason]);
    else if (!list.includes(reason)) list.push(reason);
  }
  has(item: Item): boolean {
    return this.reasons.has(item);
  }
  get size(): number {
    return this.reasons.size;
  }
}

export function sampleProject(project: Project, pages: PageSource, options: SampleOptions = {}): SampleReport {
  const wantExercises = Math.max(0, Math.floor(options.exercises ?? SAMPLE_DEFAULTS.exercises));
  const wantSolutions = Math.max(0, Math.floor(options.solutions ?? SAMPLE_DEFAULTS.solutions));
  const items = itemsOf(project);
  const notes: string[] = [];
  if (items.length === 0) {
    return {
      format: SAMPLE_FORMAT,
      version: SAMPLE_VERSION,
      options: { exercises: wantExercises, solutions: wantSolutions },
      summary: { sections: 0, exercises: 0, withSolution: 0, sampledExercises: 0, sampledSolutions: 0 },
      exercises: [],
      solutions: [],
      notes: ['The project has no book exercises: audit a book first (`exercises propose --apply`).'],
    };
  }

  const sections = new Map<string, Item[]>();
  for (const item of items) {
    const list = sections.get(item.section);
    if (list) list.push(item);
    else sections.set(item.section, [item]);
  }

  // ---- the exercises --------------------------------------------------------------------------------------------------
  const picked = new Picks<ExerciseReason>();
  if (wantExercises > 0) {
    for (const list of sections.values()) {
      picked.add(list[0] as Item, 'first-in-section');
      picked.add(list[list.length - 1] as Item, 'last-in-section');
    }

    const firstWith = (reason: ExerciseReason, test: (item: Item) => boolean, missing: string): void => {
      const found = items.find(test);
      if (found) picked.add(found, reason);
      else notes.push(missing);
    };
    firstWith('has-continuation', (item) => (item.frame.continues?.length ?? 0) > 0, 'No exercise continues on another region (a continuation).');
    firstWith('context-on-another-page', (item) => (item.frame.context ?? []).some((region) => region.page !== item.frame.page), 'No exercise has its instruction on another page than its own.');
    const rows = rowsOf(items);
    const firstRow = (test: (columns: number) => boolean): Item | undefined => rows.filter((row) => test(row.columns)).reduce<Item | undefined>((best, row) => (best === undefined || row.first.order < best.order ? row.first : best), undefined);
    const two = firstRow((columns) => columns === 2);
    if (two) picked.add(two, 'two-in-a-row');
    else notes.push('No two exercises stand in one row.');
    const three = firstRow((columns) => columns >= 3);
    if (three) picked.add(three, 'three-in-a-row');
    else notes.push('No three exercises stand in one row.');

    if (items.length > 0) {
      const extreme = (better: (candidate: number, best: number) => boolean, measure: (rect: Rect) => number): Item =>
        items.reduce((best, item) => (better(rounded(measure(item.frame.rect)), rounded(measure(best.frame.rect))) ? item : best));
      picked.add(extreme((candidate, best) => candidate > best, rectHeight), 'longest');
      picked.add(extreme((candidate, best) => candidate < best, rectArea), 'smallest');
    }

    const medians = new Map<string, number>();
    for (const [id, list] of sections) if (list.length >= SAMPLE_LIMITS.figureMinSection) medians.set(id, median(list.map((item) => rounded(rectHeight(item.frame.rect), 4))));
    firstWith(
      'beside-a-figure',
      (item) => {
        const centre = medians.get(item.section);
        const height = rounded(rectHeight(item.frame.rect), 4);
        return centre !== undefined && height >= SAMPLE_LIMITS.figureHeight && height >= SAMPLE_LIMITS.figureFactor * centre;
      },
      'No exercise is much taller than the others of its section (a figure beside it).',
    );

    const rest = items.filter((item) => !picked.has(item));
    for (const item of stride(rest, wantExercises - picked.size)) picked.add(item, 'stride');
  }

  // ---- the answers ----------------------------------------------------------------------------------------------------
  const withSolution = items.filter(hasSolution);
  const answers = new Picks<SolutionReason>();
  if (wantSolutions > 0) {
    for (const item of items) {
      const reasons = picked.reasons.get(item);
      if (!reasons || !hasSolution(item)) continue;
      if (reasons.includes('first-in-section')) answers.add(item, 'of-first-in-section');
      if (reasons.includes('last-in-section')) answers.add(item, 'of-last-in-section');
      if (reasons.some((reason) => reason !== 'first-in-section' && reason !== 'last-in-section')) answers.add(item, 'of-sampled-exercise');
    }

    const index = new PageIndex(pages);
    const read = withSolution
      .filter((item) => (item.frame.solution ?? []).every((region) => pages(region.page) !== undefined))
      .map((item) => {
        const texts = (item.frame.solution ?? []).map((region) => index.page(region.page).read(region.rect));
        return { item, lines: texts.reduce((sum, text) => sum + text.lines, 0), blank: texts.every((text) => text.pieces.length === 0 && text.straddling.length === 0) };
      });
    const most = read.reduce<(typeof read)[number] | undefined>((best, entry) => (best === undefined || entry.lines > best.lines ? entry : best), undefined);
    if (most !== undefined && most.lines >= 2) answers.add(most.item, 'most-lines');
    else notes.push('No answer has more than one line of text.');
    const picture = read.find((entry) => entry.blank);
    if (picture) answers.add(picture.item, 'picture-only');
    else notes.push('No answer is a picture without text.');

    const tree = buildSectionTree(project.outline?.entries ?? [], project.pdf.pageCount);
    const chapters = new Map<number, Item[]>();
    for (const item of withSolution) {
      const node = tree.byId.get(item.section);
      if (node === undefined) continue;
      const chapter = (sectionPath(tree, tree.nodes[node] as (typeof tree.nodes)[number])[0] as (typeof tree.nodes)[number]).index;
      const list = chapters.get(chapter);
      if (list) list.push(item);
      else chapters.set(chapter, [item]);
    }
    const earliest = (a: Item, b: Item): number => {
      const x = (a.frame.solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number];
      const y = (b.frame.solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number];
      return x.page - y.page || x.rect.top - y.rect.top || x.rect.left - y.rect.left || a.order - b.order;
    };
    for (const list of chapters.values()) answers.add([...list].sort(earliest)[0] as Item, 'first-of-chapter-key');

    const rest = withSolution.filter((item) => !answers.has(item));
    for (const item of stride(rest, wantSolutions - answers.size)) answers.add(item, 'stride');
  }

  const toEntries = (picks: Picks<ExerciseReason | SolutionReason>, kind: 'exercise' | 'solution'): SampleEntry[] =>
    [...picks.reasons.entries()]
      .sort(([a], [b]) => a.order - b.order)
      .map(([item, reasons]) => ({
        ref: item.ref,
        reason: reasons[0] as ExerciseReason | SolutionReason,
        reasons,
        page: kind === 'exercise' ? item.frame.page : ((item.frame.solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number]).page,
        kind,
        region: kind === 'exercise' ? 'main' : 'solution:0',
      }));
  const exercises = toEntries(picked, 'exercise');
  const solutions = toEntries(answers, 'solution');
  return {
    format: SAMPLE_FORMAT,
    version: SAMPLE_VERSION,
    options: { exercises: wantExercises, solutions: wantSolutions },
    summary: { sections: sections.size, exercises: items.length, withSolution: withSolution.length, sampledExercises: exercises.length, sampledSolutions: solutions.length },
    exercises,
    solutions,
    notes,
  };
}

/** The reasons that exist, for the documentation and its test. */
export const SAMPLE_REASONS = { exercises: EXERCISE_REASONS, solutions: SOLUTION_REASONS } as const;
