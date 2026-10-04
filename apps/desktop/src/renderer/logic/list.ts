import { describeSection, type Frame } from '@mcprep/core/pure';
import { labelOf, type BookModel, type FrameIndex } from './model.js';
import type { FramesFilter } from './store.js';

/**
 * The arithmetic of a long list that draws only the rows in view (a book can have thousands of frames and hundreds of
 * sections; a row for each would make every change of the project slow). Fixed row heights make it a division.
 */

/** The rows to draw for a viewport: [first, end), with `overscan` rows more on each side, never outside 0..count. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): { first: number; end: number } {
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight) + overscan);
  return { first: Math.min(first, count), end: Math.max(Math.min(first, count), end) };
}

/** Where to scroll so that row `index` is in view, or undefined when it already is (centred when it has to move). */
export function scrollToReveal(index: number, scrollTop: number, viewport: number, rowHeight: number): number | undefined {
  const top = index * rowHeight;
  if (top >= scrollTop && top + rowHeight <= scrollTop + viewport) return undefined;
  return Math.max(0, top - viewport / 2 + rowHeight / 2);
}

// ---------------------------------------------------------------------------------------------------------------------
// The rows of the Frames list

export type FrameRow =
  /** A section (or "framed by you") with what is in it; click to fold it. */
  | { type: 'group'; key: string; title: string; count: number; solved: number | undefined; collapsed: boolean; sectionIndex: number | undefined; problem: boolean }
  | { type: 'frame'; key: string; frame: Frame; label: string; book: boolean; part: boolean }
  /** The first line of an exercise a person cut into parts. */
  | { type: 'unit'; key: string; frame: Frame; label: string; parts: number };

export interface FrameRows {
  rows: FrameRow[];
  /** Where each frame is in `rows` (a frame in a folded group is not). */
  indexOfFrame: Map<string, number>;
  /** How many frames are listed, of how many there are with this filter. */
  shown: number;
  total: number;
}

export const FRAME_ROW_HEIGHT = 34;
export const UNPLACED_KEY = 'sec:?';
export const ORDINARY_KEY = 'ordinary';
export const sectionGroupKey = (id: string): string => `sec:${id}`;

/**
 * The Frames list as rows: the book exercises grouped by the section they are filed under (in the order of the book, each
 * group in the order a book counts), then what a person framed for themselves in reading order. A filter picks one of the
 * two kinds, a query keeps the frames whose number (`5a`, `1.2:5a`, `E3`) or id contains it, and a folded group shows only
 * its heading. One pass over the frames: typing in the search box is never slower than the project is long.
 */
export function buildFrameRows(input: { index: FrameIndex; model: BookModel; filter: FramesFilter; query: string; collapsed: Readonly<Record<string, true>> }): FrameRows {
  const { index, model, filter, collapsed } = input;
  const query = input.query.trim().toLowerCase();
  const rows: FrameRow[] = [];
  const indexOfFrame = new Map<string, number>();
  let shown = 0;
  let total = 0;
  const matches = (frame: Frame, label: string): boolean => query === '' || label.toLowerCase().includes(query) || `${frame.section ?? ''}:${label}`.toLowerCase().includes(query) || frame.id.toLowerCase() === query;
  const push = (row: FrameRow, frame?: Frame): void => {
    if (frame) indexOfFrame.set(frame.id, rows.length);
    rows.push(row);
  };

  const bookGroup = (key: string, title: string, frames: readonly Frame[], sectionIndex: number | undefined, problem: boolean): void => {
    total += frames.length;
    const wanted = frames.filter((frame) => matches(frame, frame.label ?? frame.id));
    if (wanted.length === 0) return;
    const folded = query === '' && collapsed[key] === true;
    const solved = wanted.reduce((sum, frame) => sum + (frame.solution !== undefined && frame.solution.length > 0 ? 1 : 0), 0);
    push({ type: 'group', key, title, count: wanted.length, solved, collapsed: folded, sectionIndex, problem });
    if (folded) return;
    for (const frame of wanted) {
      shown += 1;
      push({ type: 'frame', key: frame.id, frame, label: frame.label ?? frame.id, book: true, part: false }, frame);
    }
  };

  if (filter !== 'ordinary') {
    for (const node of model.tree.nodes) {
      if (node.id === undefined || model.tree.byId.get(node.id) !== node.index) continue;
      const frames = model.groups.get(node.id);
      if (frames && frames.length > 0) bookGroup(sectionGroupKey(node.id), describeSection(node.entry), frames, node.index, false);
    }
    if (model.unplaced.length > 0) bookGroup(UNPLACED_KEY, 'Filed under a section that does not exist', model.unplaced, undefined, true);
  }

  if (filter !== 'book' && index.ordinary.length > 0) {
    const grouped = filter === 'all' && index.book.length > 0;
    const matching = index.ordinary.filter((frame) => matches(frame, labelOf(index, frame)));
    total += index.ordinary.length;
    if (matching.length > 0) {
      const folded = grouped && query === '' && collapsed[ORDINARY_KEY] === true;
      if (grouped) push({ type: 'group', key: ORDINARY_KEY, title: 'Framed by you', count: matching.length, solved: undefined, collapsed: folded, sectionIndex: undefined, problem: false });
      if (!folded) {
        const seen = new Set<string>();
        for (const frame of matching) {
          const label = labelOf(index, frame);
          const part = frame.unit !== undefined;
          if (part && !seen.has(frame.unit as string)) {
            seen.add(frame.unit as string);
            push({ type: 'unit', key: `unit:${frame.unit}`, frame, label: `E${index.numbers.get(frame.id)?.number ?? ''}`, parts: index.numbers.get(frame.id)?.partCount ?? 2 });
          }
          shown += 1;
          push({ type: 'frame', key: frame.id, frame, label, book: false, part }, frame);
        }
      }
    }
  }
  return { rows, indexOfFrame, shown, total };
}
