import { buildSectionTree, type SectionNode, type SectionTree } from '../book/sections.js';
import { bookExercisesInOrder } from '../book/summary.js';
import { bookReference, normalizeLabel } from '../model/authority.js';
import { rectArea, rectHeight } from '../model/rect.js';
import type { Frame, Rect } from '../model/types.js';
import type { Project } from '../project/model.js';
import { PageIndex } from '../verify/regions.js';
import type { PageSource } from '../verify/verify.js';
import { EXERCISE_REASONS, SAMPLE_DEFAULTS, SAMPLE_FORMAT, SAMPLE_LIMITS, SAMPLE_VERSION, SOLUTION_REASONS, type ExerciseReason, type SampleEntry, type SampleOptions, type SampleReport, type SolutionReason } from './types.js';

/**
 * The review sample, by rules that a person can apply by hand (docs/AUDIT_A_BOOK.md, "A fixed sample to look at"). The caps
 * (`exercises`, default 40, and `solutions`, default 20) are hard: the rules are applied in order, each adds its exercises that
 * are not in the sample yet until the cap is reached, and a rule that does not fit what is left is thinned by an even stride,
 * never cut off at the end.
 *
 * Exercises: (1) one exercise of each layout kind the book has, the first in the order of the book (a continuation, an
 * instruction on another page, two in a row, three in a row, the longest region, the smallest, one beside a figure);
 * (2) the first and the last exercise of every chapter; (3) the first and the last exercise of every section, or, when what is
 * left of the cap is less than twice the number of sections, of an even stride of sections that keeps the first and the last;
 * (4) an even stride over the rest. Answers: (1) those of the exercises of rule 1, then the answer with the most lines, a
 * picture-only answer, the first answer of every chapter's key, then those of the other sampled exercises in the order they were
 * picked, then an even stride over the rest.
 *
 * `perSection` is the thorough review: rule 3 ignores the cap and takes every section, and the answers of every sampled exercise
 * are taken. Nothing is random and the order of the frames in the file does not matter: the order of the book is the order of
 * the sections in the outline and, within one, reading order.
 */

interface Item {
  frame: Frame;
  ref: string;
  /** The position in the order of the book. */
  order: number;
  section: string;
}

/** An item and why it is picked (by one rule, or by several of its picks that coincide). */
interface Entry<R extends string> {
  item: Item;
  reasons: R[];
}

/** Ranking a measure must not depend on float noise: `0.1` is `0.1`, whichever way it was computed. */
const rounded = (value: number, digits = 5): number => Math.round(value * 10 ** digits) / 10 ** digits;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

const hasSolution = (item: Item): boolean => (item.frame.solution?.length ?? 0) > 0;

/** `1 exercise`, `2 exercises`. */
const counted = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

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

/**
 * An even stride over a list that keeps both ends: all of it when there are not more than `count` entries, else `count` of them,
 * the k-th (k = 0 ... count - 2) at index floor(k * M / count), M being the length of the list, and the last entry of the list
 * in place of the last of them (with `count` of 1, the first). Nothing for a count of 0 or less.
 */
function thin<T>(list: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= list.length) return [...list];
  if (count === 1) return [list[0] as T];
  return Array.from({ length: count }, (_unused, k) => list[k === count - 1 ? list.length - 1 : Math.floor((k * list.length) / count)] as T);
}

/** Every item once, at the place it first appears, with all the reasons it has. */
function merged<R extends string>(entries: readonly Entry<R>[]): Entry<R>[] {
  const byItem = new Map<Item, Entry<R>>();
  for (const entry of entries) {
    const held = byItem.get(entry.item);
    if (!held) byItem.set(entry.item, { item: entry.item, reasons: [...entry.reasons] });
    else for (const reason of entry.reasons) if (!held.reasons.includes(reason)) held.reasons.push(reason);
  }
  return [...byItem.values()];
}

/** What is in the sample and why, built rule by rule within a cap. */
class Selection<R extends string> {
  /** The reasons of each item, in the order the items were picked and the rules applied. */
  readonly reasons = new Map<Item, R[]>();
  /** The rule that picked each item first. */
  readonly rule = new Map<Item, number>();

  constructor(
    private readonly cap: number,
    private readonly unit: 'exercise' | 'answer',
    private readonly notes: string[],
  ) {}

  get size(): number {
    return this.reasons.size;
  }

  has(item: Item): boolean {
    return this.reasons.has(item);
  }

  private add(item: Item, reason: R, rule: number): void {
    const list = this.reasons.get(item);
    if (!list) {
      this.reasons.set(item, [reason]);
      this.rule.set(item, rule);
    } else if (!list.includes(reason)) list.push(reason);
  }

  /**
   * One rule: its entries that are in the sample already only gain the reason; the others are taken as far as `limit` (the cap, or
   * Infinity for a rule that ignores it) allows, thinned by an even stride when they do not all fit, which the notes say.
   */
  take(rule: number, entries: readonly Entry<R>[], what: string, options: { limit?: number; quiet?: boolean } = {}): void {
    const all = merged(entries);
    for (const entry of all) if (this.has(entry.item)) for (const reason of entry.reasons) this.add(entry.item, reason, rule);
    const fresh = all.filter((entry) => !this.has(entry.item));
    const limit = options.limit ?? this.cap;
    const chosen = thin(fresh, limit - this.size);
    for (const entry of chosen) for (const reason of entry.reasons) this.add(entry.item, reason, rule);
    if (chosen.length < fresh.length && options.quiet !== true) this.notes.push(`${what}: ${chosen.length} of ${fresh.length} taken, thinned by an even stride to stay within ${counted(this.cap, this.unit)}.`);
  }
}

/** The chapter of each section: the outline entry of depth 0 above it (or the entries at the top of an outline that has none). */
function chapterFinder(tree: SectionTree): (section: string) => number | undefined {
  const zero = tree.nodes.some((node) => node.depth === 0);
  const isChapter = (node: SectionNode): boolean => (zero ? node.depth === 0 : node.parent < 0);
  const found = new Map<string, number | undefined>();
  return (section) => {
    if (found.has(section)) return found.get(section);
    let at = tree.byId.get(section);
    let chapter: number | undefined;
    while (at !== undefined && at >= 0) {
      const node = tree.nodes[at] as SectionNode;
      if (isChapter(node)) {
        chapter = node.index;
        break;
      }
      at = node.parent;
    }
    found.set(section, chapter);
    return chapter;
  };
}

export function sampleProject(project: Project, pages: PageSource, options: SampleOptions = {}): SampleReport {
  const wantExercises = Math.max(0, Math.floor(options.exercises ?? SAMPLE_DEFAULTS.exercises));
  const wantSolutions = Math.max(0, Math.floor(options.solutions ?? SAMPLE_DEFAULTS.solutions));
  const perSection = options.perSection === true;
  const items = itemsOf(project);
  const notes: string[] = [];
  if (items.length === 0) {
    return {
      format: SAMPLE_FORMAT,
      version: SAMPLE_VERSION,
      options: { exercises: wantExercises, solutions: wantSolutions, perSection },
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
  const tree = buildSectionTree(project.outline?.entries ?? [], project.pdf.pageCount);
  const chapterOf = chapterFinder(tree);
  const chapters = new Map<number, Item[]>();
  for (const item of items) {
    const chapter = chapterOf(item.section);
    if (chapter === undefined) continue;
    const list = chapters.get(chapter);
    if (list) list.push(item);
    else chapters.set(chapter, [item]);
  }
  const firstAndLast = (list: readonly Item[]): Entry<ExerciseReason>[] => [
    { item: list[0] as Item, reasons: ['first-in-section'] },
    { item: list[list.length - 1] as Item, reasons: ['last-in-section'] },
  ];

  // ---- the exercises --------------------------------------------------------------------------------------------------
  const picked = new Selection<ExerciseReason>(wantExercises, 'exercise', notes);
  if (wantExercises > 0) {
    // 1. One exercise of each layout kind the book has.
    const kinds: Entry<ExerciseReason>[] = [];
    const firstWith = (reason: ExerciseReason, test: (item: Item) => boolean, missing: string): void => {
      const found = items.find(test);
      if (found) kinds.push({ item: found, reasons: [reason] });
      else notes.push(missing);
    };
    firstWith('has-continuation', (item) => (item.frame.continues?.length ?? 0) > 0, 'No exercise continues on another region (a continuation).');
    firstWith('context-on-another-page', (item) => (item.frame.context ?? []).some((region) => region.page !== item.frame.page), 'No exercise has its instruction on another page than its own.');
    const rows = rowsOf(items);
    const firstRow = (test: (columns: number) => boolean): Item | undefined => rows.filter((row) => test(row.columns)).reduce<Item | undefined>((best, row) => (best === undefined || row.first.order < best.order ? row.first : best), undefined);
    const two = firstRow((columns) => columns === 2);
    if (two) kinds.push({ item: two, reasons: ['two-in-a-row'] });
    else notes.push('No two exercises stand in one row.');
    const three = firstRow((columns) => columns >= 3);
    if (three) kinds.push({ item: three, reasons: ['three-in-a-row'] });
    else notes.push('No three exercises stand in one row.');
    const extreme = (better: (candidate: number, best: number) => boolean, measure: (rect: Rect) => number): Item =>
      items.reduce((best, item) => (better(rounded(measure(item.frame.rect)), rounded(measure(best.frame.rect))) ? item : best));
    kinds.push({ item: extreme((candidate, best) => candidate > best, rectHeight), reasons: ['longest'] });
    kinds.push({ item: extreme((candidate, best) => candidate < best, rectArea), reasons: ['smallest'] });
    const medians = new Map<string, number>();
    for (const [id, list] of sections) if (list.length >= SAMPLE_LIMITS.figureMinSection) medians.set(id, median(list.map((item) => rounded(rectHeight(item.frame.rect)))));
    firstWith(
      'beside-a-figure',
      (item) => {
        const centre = medians.get(item.section);
        const height = rounded(rectHeight(item.frame.rect));
        return centre !== undefined && height >= SAMPLE_LIMITS.figureHeight && height >= SAMPLE_LIMITS.figureFactor * centre;
      },
      'No exercise is much taller than the others of its section (a figure beside it).',
    );
    picked.take(1, kinds, 'The layout kinds');

    // 2. The first and the last exercise of every chapter.
    picked.take(2, [...chapters.values()].flatMap(firstAndLast), 'The first and the last exercise of every chapter');

    // 3. The first and the last exercise of every section; of an even stride of sections when less than twice as many are left.
    const lists = [...sections.values()];
    const left = wantExercises - picked.size;
    const count = perSection || left >= 2 * lists.length ? lists.length : Math.max(0, Math.floor(left / 2));
    picked.take(3, thin(lists, count).flatMap(firstAndLast), 'The first and the last exercise of every section', { limit: perSection ? Number.POSITIVE_INFINITY : wantExercises });
    if (count < lists.length) {
      notes.push(
        count === 0
          ? `Sections: no room is left in ${counted(wantExercises, 'exercise')} for the first and the last exercise of the ${lists.length} sections; --per-section takes every section.`
          : `Sections: the first and the last exercise of ${count} of the ${lists.length} sections (an even stride that keeps the first and the last section) to stay within ${counted(wantExercises, 'exercise')}; --per-section takes every section.`,
      );
    }
    if (perSection && picked.size > wantExercises) notes.push(`--per-section: the first and the last exercise of every section are in the sample, so it has ${counted(picked.size, 'exercise')}, more than the ${wantExercises} asked for.`);

    // 4. An even stride over the rest.
    picked.take(4, items.filter((item) => !picked.has(item)).map((item) => ({ item, reasons: ['stride'] as ExerciseReason[] })), 'The remaining exercises', { quiet: true });
  }

  // ---- the answers ----------------------------------------------------------------------------------------------------
  const withSolution = items.filter(hasSolution);
  const answers = new Selection<SolutionReason>(wantSolutions, 'answer', notes);
  if (wantSolutions > 0) {
    // What the answer of a sampled exercise is there for: it is the first or the last of its section, or was picked otherwise.
    const derived = (item: Item): SolutionReason[] => {
      const reasons = picked.reasons.get(item) ?? [];
      const out: SolutionReason[] = [];
      if (reasons.includes('first-in-section')) out.push('of-first-in-section');
      if (reasons.includes('last-in-section')) out.push('of-last-in-section');
      if (reasons.some((reason) => reason !== 'first-in-section' && reason !== 'last-in-section')) out.push('of-sampled-exercise');
      return out;
    };
    const sampled = [...picked.reasons.keys()].filter(hasSolution);
    const ofSample = (list: readonly Item[]): Entry<SolutionReason>[] => list.map((item) => ({ item, reasons: derived(item) }));

    // 1. The answers of the exercises of the layout kinds.
    answers.take(1, ofSample(sampled.filter((item) => picked.rule.get(item) === 1)), 'The answers of the layout kinds');

    // 2 and 3. The answer with the most lines of text, and an answer that is only a picture (from the text of the pages read).
    const index = new PageIndex(pages);
    const read = withSolution
      .filter((item) => (item.frame.solution ?? []).every((region) => pages(region.page) !== undefined))
      .map((item) => {
        const texts = (item.frame.solution ?? []).map((region) => index.page(region.page).read(region.rect));
        return { item, lines: texts.reduce((sum, text) => sum + text.lines, 0), blank: texts.every((text) => text.pieces.length === 0 && text.straddling.length === 0) };
      });
    const most = read.reduce<(typeof read)[number] | undefined>((best, entry) => (best === undefined || entry.lines > best.lines ? entry : best), undefined);
    if (most !== undefined && most.lines >= 2) answers.take(2, [{ item: most.item, reasons: ['most-lines'] }], 'The answer with the most lines');
    else notes.push('No answer has more than one line of text.');
    const picture = read.find((entry) => entry.blank);
    if (picture) answers.take(3, [{ item: picture.item, reasons: ['picture-only'] }], 'The answer that is only a picture');
    else notes.push('No answer is a picture without text.');

    // 4. The first answer of every chapter's key: the exercise of the chapter whose first solution region comes first on the pages.
    const earliest = (a: Item, b: Item): number => {
      const x = (a.frame.solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number];
      const y = (b.frame.solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number];
      return x.page - y.page || x.rect.top - y.rect.top || x.rect.left - y.rect.left || a.order - b.order;
    };
    const keys: Entry<SolutionReason>[] = [];
    for (const list of chapters.values()) {
      const answered = list.filter(hasSolution);
      if (answered.length > 0) keys.push({ item: [...answered].sort(earliest)[0] as Item, reasons: ['first-of-chapter-key'] });
    }
    answers.take(4, keys, "The first answer of every chapter's key");

    // 5. The answers of the sampled exercises that are not in yet, in the order the exercises were picked; --per-section takes all of them.
    answers.take(5, ofSample(sampled), 'The answers of the other sampled exercises', { limit: perSection ? Number.POSITIVE_INFINITY : wantSolutions });
    if (perSection && answers.size > wantSolutions) notes.push(`--per-section: the answers of every sampled exercise are in the sample, so it has ${counted(answers.size, 'answer')}, more than the ${wantSolutions} asked for.`);

    // 6. An even stride over the remaining answers.
    answers.take(6, withSolution.filter((item) => !answers.has(item)).map((item) => ({ item, reasons: ['stride'] as SolutionReason[] })), 'The remaining answers', { quiet: true });
  }

  const toEntries = (picks: Selection<ExerciseReason | SolutionReason>, kind: 'exercise' | 'solution'): SampleEntry[] =>
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
    options: { exercises: wantExercises, solutions: wantSolutions, perSection },
    summary: { sections: sections.size, exercises: items.length, withSolution: withSolution.length, sampledExercises: exercises.length, sampledSolutions: solutions.length },
    exercises,
    solutions,
    notes,
  };
}

/** The reasons that exist, for the documentation and its test. */
export const SAMPLE_REASONS = { exercises: EXERCISE_REASONS, solutions: SOLUTION_REASONS } as const;
