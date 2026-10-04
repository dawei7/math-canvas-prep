import { deriveSectionId, type Frame, type OutlineEntry } from '@mcprep/core/pure';
import type { BookModel } from './model.js';
import type { SectionFilter } from './store.js';

/**
 * The Sections list: the outline of the book as rows (with the number of book exercises and of solutions in each section
 * and under it), what is wrong with it, and what may be done with an entry. Pure functions of the project, tested without a
 * window and quick for hundreds of sections.
 */

export interface SectionRow {
  /** The place of the entry in the outline. */
  index: number;
  entry: OutlineEntry;
  depth: number;
  /** The key a folded row is remembered by: the id, else the position. */
  key: string;
  hasChildren: boolean;
  collapsed: boolean;
  /** Book exercises filed under the entry itself, and under it and everything below it. */
  own: number;
  total: number;
  /** Of those, how many have a hidden solution. */
  ownSolved: number;
  totalSolved: number;
  /** What is wrong with the entry itself, in a few words. */
  problems: string[];
}

export const sectionKey = (entry: OutlineEntry, index: number): string => (entry.id !== undefined ? entry.id : `#${index}`);

/** The title without the number that the label already shows ("1.2 Subtracting" with the label "1.2"). */
export function titleWithoutLabel(entry: OutlineEntry): string {
  const label = entry.label?.trim();
  if (label !== undefined && label !== '' && entry.title.toLowerCase().startsWith(label.toLowerCase())) {
    const rest = entry.title.slice(label.length).replace(/^[\s.:)-]+/, '');
    if (rest !== '') return rest;
  }
  return entry.title;
}

export interface SectionWarnings {
  /** Ids that two entries share (an error: only the first can hold exercises). */
  duplicateIds: string[];
  /** Entries without an id: no exercise can be filed under them. */
  withoutId: number[];
  /** Book exercises that name a section the outline does not have. */
  unplaced: Frame[];
  /** Entries with no book exercise in them or below them, and entries whose exercises lack a solution. */
  empty: number;
  unsolved: number;
}

export function sectionWarnings(model: BookModel): SectionWarnings {
  const withoutId: number[] = [];
  let empty = 0;
  let unsolved = 0;
  for (const node of model.tree.nodes) {
    if (node.id === undefined) withoutId.push(node.index);
    const count = model.counts.perNode[node.index];
    if (!count) continue;
    if (count.exercisesTotal === 0) empty += 1;
    if (count.exercises > count.withSolution) unsolved += 1;
  }
  return { duplicateIds: [...new Set(model.tree.duplicateIds)], withoutId, unplaced: model.unplaced, empty, unsolved };
}

/** What is wrong with an entry itself. */
function problemsOf(model: BookModel, index: number): string[] {
  const node = model.tree.nodes[index];
  if (!node) return [];
  const problems: string[] = [];
  if (node.id === undefined) problems.push('no id');
  else if (model.tree.byId.get(node.id) !== index) problems.push('id used twice');
  return problems;
}

/**
 * The rows of the list. All of them while nothing is folded away (a folded entry hides everything below it); with a filter
 * a flat list of the entries that match (still indented, so that their place in the book can be seen), whatever is folded.
 */
export function buildSectionRows(model: BookModel, options: { collapsed: Readonly<Record<string, true>>; filter: SectionFilter; query?: string }): SectionRow[] {
  const rows: SectionRow[] = [];
  const query = (options.query ?? '').trim().toLowerCase();
  const filtering = options.filter !== 'all' || query !== '';
  const nodes = model.tree.nodes;
  for (let at = 0; at < nodes.length; at += 1) {
    const node = nodes[at];
    if (!node) continue;
    const entry = node.entry;
    const key = sectionKey(entry, at);
    const count = model.counts.perNode[at];
    const own = count?.exercises ?? 0;
    const total = count?.exercisesTotal ?? 0;
    const ownSolved = count?.withSolution ?? 0;
    const totalSolved = count?.withSolutionTotal ?? 0;
    const problems = problemsOf(model, at);
    const collapsed = !filtering && options.collapsed[key] === true;
    let keep = true;
    if (options.filter === 'empty') keep = total === 0;
    else if (options.filter === 'unsolved') keep = own > ownSolved;
    else if (options.filter === 'problems') keep = problems.length > 0;
    if (keep && query !== '') keep = `${entry.label ?? ''} ${entry.title} ${entry.id ?? ''}`.toLowerCase().includes(query);
    if (keep) rows.push({ index: at, entry, depth: node.depth, key, hasChildren: node.children.length > 0, collapsed, own, total, ownSolved, totalSolved, problems });
    // A folded entry hides its whole subtree.
    if (collapsed) at = node.subtreeEnd - 1;
  }
  return rows;
}

/** An id for an entry that has none: its printed label, else the number in its title, else a short form of its title. */
export function suggestSectionId(model: BookModel, index: number): string | undefined {
  const entry = model.entries[index];
  if (!entry) return undefined;
  const used = new Set(model.tree.byId.keys());
  if (entry.id !== undefined) used.delete(entry.id);
  return deriveSectionId(entry, index, used);
}

/** Whether the entry can go one level deeper (+1) or shallower (-1): its subtree must fit between depth 0 and 8. */
export function canShiftDepth(model: BookModel, index: number, delta: 1 | -1): boolean {
  const node = model.tree.nodes[index];
  if (!node) return false;
  if (delta < 0) return node.depth > 0;
  const previous = model.entries[index - 1];
  if (!previous || node.depth > previous.depth) return false;
  let deepest = node.depth;
  for (let at = index; at < node.subtreeEnd; at += 1) deepest = Math.max(deepest, (model.entries[at] as OutlineEntry).depth);
  return deepest < 8;
}

/** The siblings an entry can be moved past: whether a previous and a next one exist. */
export function canMove(model: BookModel, index: number): { up: boolean; down: boolean } {
  const node = model.tree.nodes[index];
  if (!node) return { up: false, down: false };
  const siblings = node.parent >= 0 ? (model.tree.nodes[node.parent]?.children ?? []) : model.tree.roots;
  const at = siblings.indexOf(index);
  return { up: at > 0, down: at >= 0 && at < siblings.length - 1 };
}

/** The ids of an entry and, with `subtree`, of everything below it. */
export function idsUnder(model: BookModel, index: number, subtree: boolean): string[] {
  const node = model.tree.nodes[index];
  if (!node) return [];
  const end = subtree ? node.subtreeEnd : index + 1;
  const ids: string[] = [];
  for (let at = index; at < end; at += 1) {
    const id = (model.entries[at] as OutlineEntry).id;
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** How many book exercises are filed under these section ids. */
export function exercisesUnder(model: BookModel, ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) count += model.groups.get(id)?.length ?? 0;
  return count;
}

// Deriving the sections from the printed text of the book (the heuristics of the core, run in the main process by
// `DocumentService.deriveSections`) is in logic/derive.ts (what is new, different, the same; what applying does to the
// outline and to the exercises filed under it), `Store.deriveSections` and components/DeriveReview.tsx.
