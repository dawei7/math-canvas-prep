import { isAuthoritative } from '../model/authority.js';
import { compareReadingOrder } from '../model/numbering.js';
import type { Frame, OutlineEntry } from '../model/types.js';
import { LIMITS } from '../rules/constants.js';

/**
 * Sections are the entries of the outline (docs/BUNDLE_FORMAT.md, section 4). An entry's extent runs from its page (and
 * `top`) to the next entry of the same or a lower depth; the entries below it are its subsections. Everything here is pure
 * and linear (or logarithmic per lookup), so a book with thousands of exercises and hundreds of sections is no problem.
 */

/** A place in the document: a zero-based page and a position from the top of it (0 to 1). */
export interface Position {
  page: number;
  top: number;
}

export interface SectionNode {
  /** The entry's place in the outline (reading order), from 0. */
  index: number;
  entry: OutlineEntry;
  /** The id that frames name in `section`, when the entry has one. */
  id: string | undefined;
  depth: number;
  /** Index of the nearest entry above this one that is shallower, or -1 for a top-level entry. */
  parent: number;
  /** Indexes of the entries directly below. */
  children: number[];
  /** Index just after the last entry below this one (this entry's subtree is `index + 1 ... subtreeEnd - 1`). */
  subtreeEnd: number;
  /** Where the heading starts; an entry without `top` starts at the top of its page. */
  start: Position;
  /** Where the next entry of the same or a lower depth starts (the end of the document for the last ones). Exclusive. */
  end: Position;
}

export interface SectionTree {
  nodes: SectionNode[];
  /** Indexes of the top-level entries. */
  roots: number[];
  /** The first entry that has each id (a duplicate id is an error that validation reports). */
  byId: Map<string, number>;
  duplicateIds: string[];
  pageCount: number;
}

export function comparePosition(a: Position, b: Position): number {
  if (a.page !== b.page) return a.page < b.page ? -1 : 1;
  if (a.top !== b.top) return a.top < b.top ? -1 : 1;
  return 0;
}

/** Builds the tree of an outline in one pass. `pageCount` is where the last sections end. */
export function buildSectionTree(entries: readonly OutlineEntry[], pageCount: number): SectionTree {
  const nodes: SectionNode[] = [];
  const byId = new Map<string, number>();
  const duplicateIds: string[] = [];
  const roots: number[] = [];
  const documentEnd: Position = { page: pageCount, top: 0 };
  const open: number[] = [];

  entries.forEach((entry, index) => {
    const start: Position = { page: entry.page, top: entry.top ?? 0 };
    // Entries of the same or a greater depth that are still open end where this one starts.
    while (open.length > 0 && (nodes[open[open.length - 1] as number] as SectionNode).depth >= entry.depth) {
      const closed = nodes[open.pop() as number] as SectionNode;
      closed.end = start;
      closed.subtreeEnd = index;
    }
    const parent = open.length > 0 ? (open[open.length - 1] as number) : -1;
    const node: SectionNode = { index, entry, id: entry.id, depth: entry.depth, parent, children: [], subtreeEnd: entries.length, start, end: documentEnd };
    nodes.push(node);
    if (parent >= 0) (nodes[parent] as SectionNode).children.push(index);
    else roots.push(index);
    open.push(index);
    if (entry.id !== undefined) {
      if (byId.has(entry.id)) duplicateIds.push(entry.id);
      else byId.set(entry.id, index);
    }
  });
  return { nodes, roots, byId, duplicateIds, pageCount };
}

const byStart = new WeakMap<SectionTree, number[]>();

function startOrder(tree: SectionTree): number[] {
  let order = byStart.get(tree);
  if (!order) {
    order = tree.nodes.map((node) => node.index).sort((a, b) => comparePosition((tree.nodes[a] as SectionNode).start, (tree.nodes[b] as SectionNode).start) || a - b);
    byStart.set(tree, order);
  }
  return order;
}

function contains(node: SectionNode, at: Position): boolean {
  return comparePosition(node.start, at) <= 0 && comparePosition(at, node.end) < 0;
}

export interface LocateOptions {
  /** Only entries that have an id (the ones a frame can name in `section`); a position inside an anonymous subsection belongs to the nearest ancestor with an id. */
  withId?: boolean;
}

/**
 * The deepest section whose extent contains the position, or undefined for a position before the first entry (front
 * matter). A binary search finds the last entry that starts at or before the position; the entries above it are tried
 * until one still contains the position.
 */
export function locateSection(tree: SectionTree, page: number, top: number, options: LocateOptions = {}): SectionNode | undefined {
  const at: Position = { page, top };
  const order = startOrder(tree);
  let low = 0;
  let high = order.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (comparePosition((tree.nodes[order[middle] as number] as SectionNode).start, at) <= 0) {
      last = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (last < 0) return undefined;
  let node: SectionNode | undefined = tree.nodes[order[last] as number];
  while (node && !contains(node, at)) node = node.parent >= 0 ? tree.nodes[node.parent] : undefined;
  if (!node) {
    // An outline that is not in reading order: fall back to the latest entry that contains the position.
    for (let i = tree.nodes.length - 1; i >= 0; i -= 1) {
      const candidate = tree.nodes[i] as SectionNode;
      if (contains(candidate, at)) {
        node = candidate;
        break;
      }
    }
  }
  if (options.withId === true) while (node && node.id === undefined) node = node.parent >= 0 ? tree.nodes[node.parent] : undefined;
  return node;
}

/** The section a frame is printed in (its top edge decides, as a reader would). */
export function sectionOfFrame(tree: SectionTree, frame: Pick<Frame, 'page' | 'rect'>, options: LocateOptions = {}): SectionNode | undefined {
  return locateSection(tree, frame.page, frame.rect.top, options);
}

/** The entry with this id, or undefined. */
export function findSection(tree: SectionTree, id: string): SectionNode | undefined {
  const index = tree.byId.get(id);
  return index === undefined ? undefined : tree.nodes[index];
}

/** The entry and the entries above it, from the top-level one down: a breadcrumb. */
export function sectionPath(tree: SectionTree, node: SectionNode): SectionNode[] {
  const path: SectionNode[] = [];
  let current: SectionNode | undefined = node;
  while (current) {
    path.unshift(current);
    current = current.parent >= 0 ? tree.nodes[current.parent] : undefined;
  }
  return path;
}

/** True when `ancestor` is `node` itself or one of the entries above it. */
export function isWithin(tree: SectionTree, node: SectionNode, ancestor: SectionNode): boolean {
  return node.index >= ancestor.index && node.index < ancestor.subtreeEnd;
}

/** `0.1 Integers`: the label the book prints, then the title. */
export function describeSection(entry: OutlineEntry): string {
  const label = entry.label?.trim();
  const title = entry.title.trim();
  if (label === undefined || label === '' || title.toLowerCase().startsWith(label.toLowerCase())) return title;
  return `${label} ${title}`;
}

/** The authoritative exercises by the section they name, each list in reading order. */
export function exercisesBySection(frames: readonly Frame[]): Map<string, Frame[]> {
  const groups = new Map<string, Frame[]>();
  for (const frame of frames) {
    if (!isAuthoritative(frame) || frame.section === undefined) continue;
    const list = groups.get(frame.section);
    if (list) list.push(frame);
    else groups.set(frame.section, [frame]);
  }
  for (const list of groups.values()) list.sort(compareReadingOrder);
  return groups;
}

export interface SectionCount {
  /** Authoritative exercises that name this entry. */
  exercises: number;
  /** Of those, how many carry at least one solution region. */
  withSolution: number;
  /** The same for this entry and everything below it. */
  exercisesTotal: number;
  withSolutionTotal: number;
}

export interface SectionCounts {
  /** One per entry of the tree, in the same order. */
  perNode: SectionCount[];
  /** Authoritative exercises that name an id the outline does not have (validation reports each one as an error). */
  unplaced: Frame[];
  totals: { exercises: number; withSolution: number };
}

/** Counts the authoritative exercises per section and per subtree, and in total, in one pass over the frames. */
export function countSections(tree: SectionTree, frames: readonly Frame[]): SectionCounts {
  const perNode: SectionCount[] = tree.nodes.map(() => ({ exercises: 0, withSolution: 0, exercisesTotal: 0, withSolutionTotal: 0 }));
  const unplaced: Frame[] = [];
  const totals = { exercises: 0, withSolution: 0 };
  for (const frame of frames) {
    if (!isAuthoritative(frame)) continue;
    totals.exercises += 1;
    const solved = frame.solution !== undefined && frame.solution.length > 0;
    if (solved) totals.withSolution += 1;
    const index = frame.section === undefined ? undefined : tree.byId.get(frame.section);
    if (index === undefined) {
      unplaced.push(frame);
      continue;
    }
    const count = perNode[index] as SectionCount;
    count.exercises += 1;
    if (solved) count.withSolution += 1;
  }
  // Children follow their parents, so one pass from the end adds every subtree into its parent.
  for (let i = tree.nodes.length - 1; i >= 0; i -= 1) {
    const count = perNode[i] as SectionCount;
    count.exercisesTotal += count.exercises;
    count.withSolutionTotal += count.withSolution;
    const parent = (tree.nodes[i] as SectionNode).parent;
    if (parent >= 0) {
      const above = perNode[parent] as SectionCount;
      above.exercisesTotal += count.exercisesTotal;
      above.withSolutionTotal += count.withSolutionTotal;
    }
  }
  return { perNode, unplaced, totals };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ids

/** What an id may be made of: letters, digits, `.`, `_`, `-`; it starts with a letter or digit; at most 60 characters. */
export function cleanSectionId(text: string): string | undefined {
  const cleaned = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, LIMITS.sectionIdMax);
  return LIMITS.sectionIdPattern.test(cleaned) ? cleaned : undefined;
}

const LEADING_NUMBER = /^\s*(?:(?:chapter|section|ch\.?|kapitel|chapitre|cap[ií]tulo|§)\s*)?(\d+(?:\.\d+)*)/i;

/**
 * An id for an entry that has none, so that exercises can name it: the printed label ("1.2"), else the number at the start
 * of the title, else a short form of the title, else `s<position>`; made unique among `used` with a numeric suffix. The id
 * is added to `used`.
 */
export function deriveSectionId(entry: Pick<OutlineEntry, 'title' | 'label'>, index: number, used: Set<string>): string {
  const candidates = [
    entry.label !== undefined ? cleanSectionId(entry.label) : undefined,
    cleanSectionId(LEADING_NUMBER.exec(entry.title)?.[1] ?? ''),
    cleanSectionId(entry.title.slice(0, 40)),
    `s${index + 1}`,
  ].filter((candidate): candidate is string => candidate !== undefined);
  const base = candidates[0] as string;
  let id = base;
  for (let n = 2; used.has(id); n += 1) {
    const suffix = `-${n}`;
    id = `${base.slice(0, LIMITS.sectionIdMax - suffix.length)}${suffix}`;
  }
  used.add(id);
  return id;
}

/** Ids for all the entries that have none (see {@link deriveSectionId}); entries that already have one keep it. */
export function assignSectionIds(entries: readonly OutlineEntry[]): { entries: OutlineEntry[]; assigned: { index: number; id: string }[] } {
  const used = new Set<string>();
  for (const entry of entries) if (entry.id !== undefined) used.add(entry.id);
  const assigned: { index: number; id: string }[] = [];
  const result = entries.map((entry, index): OutlineEntry => {
    if (entry.id !== undefined) return entry;
    const id = deriveSectionId(entry, index, used);
    assigned.push({ index, id });
    return { ...entry, id };
  });
  return { entries: result, assigned };
}
