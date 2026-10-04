import {
  buildSectionTree,
  compareReadingOrder,
  countSections,
  describeSection,
  isAuthoritative,
  numberFrames,
  type Frame,
  type FrameKind,
  type FrameNumber,
  type OutlineEntry,
  type Rect,
  type SectionCounts,
  type SectionTree,
} from '@mcprep/core/pure';
import { compareLabels } from './book.js';

/**
 * What the panels and the page view need to know about a project, computed once per version of the project and shared:
 * `frameIndex` for the frames (positional numbers, frames of each page, units, counts), `bookModel` for the sections and
 * the book exercises filed under them. Both are cached by the identity of the arrays the project is made of, and the
 * project is replaced, never changed, by every edit; so a component asking again after an unrelated change gets the same
 * object, and nothing is recomputed per keystroke, per scroll or per selected frame.
 */

// ------------------------------------------------------------------------------------------------------------ frames

export interface PageRegion {
  /** The frame the region belongs to. */
  frame: Frame;
  rect: Rect;
  /** The place of the region in the frame's list (`continues`, `context` or `solution`). */
  index: number;
}

/** What is drawn on one page: frames, continuations, context and solution regions. */
export interface PageContent {
  frames: Frame[];
  continues: PageRegion[];
  context: PageRegion[];
  solution: PageRegion[];
}

export interface FrameIndex {
  frames: readonly Frame[];
  byId: Map<string, Frame>;
  /** Positional numbers (E1, E2.1, Q1, B3). Book exercises have none: they are named by their printed number. */
  numbers: Map<string, FrameNumber>;
  /** Positional counts of what a person framed for themselves; the parts of an exercise count once. */
  counts: Record<FrameKind, number>;
  /** The book exercises in the order of `frames`, and how many have a hidden solution. */
  book: Frame[];
  bookWithSolution: number;
  /** The parts of each unit, in reading order. */
  units: Map<string, Frame[]>;
  pages: Map<number, PageContent>;
  /** How many frames start on each page (the badge of a thumbnail). */
  perPage: Map<number, number>;
  /** Every frame that is not a book exercise, in reading order. */
  ordinary: Frame[];
}

const EMPTY_PAGE: PageContent = { frames: [], continues: [], context: [], solution: [] };

const indexCache = new WeakMap<readonly Frame[], FrameIndex>();

function pageOf(pages: Map<number, PageContent>, page: number): PageContent {
  let content = pages.get(page);
  if (!content) {
    content = { frames: [], continues: [], context: [], solution: [] };
    pages.set(page, content);
  }
  return content;
}

/** Builds (once per version of the frames) the lookups the editor uses. Linear in the frames and their regions. */
export function frameIndex(frames: readonly Frame[]): FrameIndex {
  const cached = indexCache.get(frames);
  if (cached) return cached;
  const byId = new Map<string, Frame>();
  const units = new Map<string, Frame[]>();
  const pages = new Map<number, PageContent>();
  const perPage = new Map<number, number>();
  const book: Frame[] = [];
  const ordinary: Frame[] = [];
  let bookWithSolution = 0;
  for (const frame of frames) {
    byId.set(frame.id, frame);
    perPage.set(frame.page, (perPage.get(frame.page) ?? 0) + 1);
    pageOf(pages, frame.page).frames.push(frame);
    frame.continues?.forEach((region, index) => pageOf(pages, region.page).continues.push({ frame, rect: region.rect, index }));
    frame.context?.forEach((region, index) => pageOf(pages, region.page).context.push({ frame, rect: region.rect, index }));
    frame.solution?.forEach((region, index) => pageOf(pages, region.page).solution.push({ frame, rect: region.rect, index }));
    if (isAuthoritative(frame)) {
      book.push(frame);
      if (frame.solution !== undefined && frame.solution.length > 0) bookWithSolution += 1;
    } else {
      ordinary.push(frame);
      if (frame.unit !== undefined) {
        const members = units.get(frame.unit);
        if (members) members.push(frame);
        else units.set(frame.unit, [frame]);
      }
    }
  }
  ordinary.sort(compareReadingOrder);
  for (const members of units.values()) members.sort(compareReadingOrder);
  const numbers = numberFrames(frames);
  const counts: Record<FrameKind, number> = { exercise: 0, question: 0, bookmark: 0 };
  for (const entry of numbers.values()) if (entry.part === undefined || entry.part === 1) counts[entry.kind] += 1;
  const index: FrameIndex = { frames, byId, numbers, counts, book, bookWithSolution, units, pages, perPage, ordinary };
  indexCache.set(frames, index);
  return index;
}

/** The content of a page (an empty one for a page without frames). */
export const pageContent = (index: FrameIndex, page: number): PageContent => index.pages.get(page) ?? EMPTY_PAGE;

/** The label to show for a frame: the number the book prints for a book exercise, else the positional number (E3, Q1). */
export function labelOf(index: FrameIndex, frame: Frame): string {
  if (isAuthoritative(frame)) return frame.label ?? frame.id;
  return index.numbers.get(frame.id)?.label ?? frame.id;
}

// ------------------------------------------------------------------------------------------------------------ sections

export interface BookModel {
  /** The sections: the entries of the project's own outline. */
  entries: readonly OutlineEntry[];
  pageCount: number;
  tree: SectionTree;
  counts: SectionCounts;
  /** The book exercises filed under each section id, in the order a book counts (2 before 10, 5a before 5b). */
  groups: Map<string, Frame[]>;
  /** Book exercises that name a section the outline does not have, by section and number. */
  unplaced: Frame[];
  /** Entries that have no id: no exercise can be filed under them. */
  withoutId: number;
}

const NO_ENTRIES: readonly OutlineEntry[] = [];
const modelCache = new WeakMap<readonly Frame[], WeakMap<readonly OutlineEntry[], BookModel>>();

const byLabel = (a: Frame, b: Frame): number => compareLabels(a.label ?? '', b.label ?? '') || compareReadingOrder(a, b);

/** The sections with the exercises filed under them, counted per section and per subtree. Cached per version. */
export function bookModel(frames: readonly Frame[], entries: readonly OutlineEntry[] | undefined, pageCount: number): BookModel {
  const outline = entries ?? NO_ENTRIES;
  let byOutline = modelCache.get(frames);
  if (!byOutline) {
    byOutline = new WeakMap();
    modelCache.set(frames, byOutline);
  }
  const cached = byOutline.get(outline);
  if (cached && cached.pageCount === pageCount) return cached;
  const tree = buildSectionTree(outline, pageCount);
  const counts = countSections(tree, frames);
  const groups = new Map<string, Frame[]>();
  for (const frame of frames) {
    if (!isAuthoritative(frame) || frame.section === undefined) continue;
    const list = groups.get(frame.section);
    if (list) list.push(frame);
    else groups.set(frame.section, [frame]);
  }
  for (const list of groups.values()) list.sort(byLabel);
  const unplaced = [...counts.unplaced].sort((a, b) => compareLabels(a.section ?? '', b.section ?? '') || byLabel(a, b));
  const withoutId = tree.nodes.reduce((sum, node) => sum + (node.id === undefined ? 1 : 0), 0);
  const model: BookModel = { entries: outline, pageCount, tree, counts, groups, unplaced, withoutId };
  byOutline.set(outline, model);
  return model;
}

/** The choices of a section menu: every entry that has an id, in the order of the book, indented by depth. */
export function sectionChoices(model: BookModel): { id: string; text: string; index: number }[] {
  const choices: { id: string; text: string; index: number }[] = [];
  for (const node of model.tree.nodes) {
    if (node.id === undefined || model.tree.byId.get(node.id) !== node.index) continue;
    choices.push({ id: node.id, index: node.index, text: `${'  '.repeat(Math.min(node.depth, 4))}${describeSection(node.entry)} (${node.id})` });
  }
  return choices;
}

/** The section entry an id names, or undefined. */
export function entryOfSection(model: BookModel, id: string | undefined): OutlineEntry | undefined {
  if (id === undefined) return undefined;
  const at = model.tree.byId.get(id);
  return at === undefined ? undefined : model.entries[at];
}
