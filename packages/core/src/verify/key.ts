import { findSection } from '../book/sections.js';
import { draft, type Draft, type Exercise } from './common.js';
import { compareNumeric, excerpt, foldText, parseNumeric } from './labels.js';
import { pos, type Run } from './run.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * The answer key at the back of a book is often set in sections: a small marker with the section's number and a header with its
 * title. The answers under a marker belong to that section; two checks use that: an answer region that lies under the marker of
 * another section than its exercise's (`solution-section-mismatch`), and answers of one section that do not run in the order
 * of their numbers within a column (`solution-order`).
 */

export interface Marker {
  section: string;
  at: number;
}

const markersOf = new WeakMap<Run, Marker[]>();

/** Lines of the key pages that name a section that has exercises: its label alone on a row, or a heading that holds its (unique) title. */
export function keyMarkers(run: Run): Marker[] {
  const cached = markersOf.get(run);
  if (cached) return cached;
  const markers: Marker[] = [];
  const key = run.layout.key;
  if (key !== undefined) {
    const ids = new Set<string>();
    for (const frame of run.project.frames) if (frame.authority === 'book' && frame.section !== undefined) ids.add(frame.section);
    const tree = run.state.tree;
    const named: { id: string; title: string; label: string | undefined }[] = [];
    const titleCount = new Map<string, number>();
    for (const id of ids) {
      const node = findSection(tree, id);
      if (node === undefined) continue;
      const title = foldText(node.entry.title).toLowerCase();
      const label = node.entry.label === undefined ? undefined : foldText(node.entry.label).toLowerCase();
      named.push({ id, title, label });
      titleCount.set(title, (titleCount.get(title) ?? 0) + 1);
    }
    for (let page = key.first; page <= Math.min(key.last, run.project.pdf.pageCount - 1); page += 1) {
      const kinds = run.kinds(page);
      for (const piece of run.index.page(page).pieces) {
        const kind = kinds.kind(piece);
        if (kind !== 'heading' && kind !== 'text') continue;
        const lower = piece.text.toLowerCase();
        for (const entry of named) {
          const byLabel = entry.label !== undefined && entry.label.length >= 3 && /\D/.test(entry.label) && lower === entry.label;
          const byTitle = entry.title.length >= 6 && titleCount.get(entry.title) === 1 && kind === 'heading' && lower.includes(entry.title) && lower.length <= entry.title.length + 30;
          if (byLabel || byTitle) markers.push({ section: entry.id, at: pos(page, piece.rect.top) });
        }
      }
    }
    markers.sort((a, b) => a.at - b.at);
  }
  markersOf.set(run, markers);
  return markers;
}

/** The section whose marker is the last one above the place (a page and a position from the top), or undefined. */
export function sectionAtKey(run: Run, page: number, top: number): string | undefined {
  const at = pos(page, top);
  let found: string | undefined;
  for (const marker of keyMarkers(run)) {
    if (marker.at > at + 1e-9) break;
    found = marker.section;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------

interface Answer {
  exercise: Exercise;
  page: number;
  top: number;
  left: number;
  parts: number[];
  suffix: string;
}

const COLUMN_GAP = 0.08;
const compareKeys = (a: Answer, b: Answer): number => compareNumeric(a, b);

/** The items to take out so that the rest is in order: the longest run in order is kept (the earliest of equally long ones). */
function outOfOrder(sequence: readonly Answer[]): Set<Answer> {
  const length = new Array<number>(sequence.length).fill(1);
  const before = new Array<number>(sequence.length).fill(-1);
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (compareKeys(sequence[j] as Answer, sequence[i] as Answer) <= 0 && (length[j] as number) + 1 > (length[i] as number)) {
        length[i] = (length[j] as number) + 1;
        before[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < sequence.length; i += 1) if ((length[i] as number) > (length[end] as number)) end = i;
  const kept = new Set<number>();
  for (let at = sequence.length === 0 ? -1 : end; at >= 0; at = before[at] as number) kept.add(at);
  return new Set(sequence.filter((_item, index) => !kept.has(index)));
}

export function checkKeys(run: Run): Draft[] {
  const drafts: Draft[] = [];
  const key = run.layout.key;
  if (key === undefined) return drafts;
  const inKey = (page: number, top: number): boolean => pos(page, top) > run.layout.lastExercise;
  const bySection = new Map<string, Answer[]>();
  for (const exercise of run.state.exercises) {
    if (!exercise.book) continue;
    const first = exercise.frame.solution?.[0];
    if (first === undefined || !inKey(first.page, first.rect.top)) continue;

    // The answer lies under the marker of another section.
    const marker = sectionAtKey(run, first.page, first.rect.top);
    if (marker !== undefined && marker !== exercise.section) {
      drafts.push(
        draft(
          'solution-section-mismatch',
          'error',
          exercise.ref,
          first.page,
          `The answer region of ${exercise.ref} on page ${first.page} lies under the marker of section ${marker} in the key, not under the one of its own section ${exercise.section as string}.`,
          `under the marker of ${marker}`,
          exercise.where,
        ),
      );
    }

    const numeric = parseNumeric(exercise.label as string);
    if (numeric === undefined) continue;
    const list = bySection.get(exercise.section as string) ?? [];
    list.push({ exercise, page: first.page, top: first.rect.top, left: first.rect.left, parts: numeric.parts, suffix: numeric.suffix });
    bySection.set(exercise.section as string, list);
  }

  // The answers of one section run in the order of their numbers, column by column.
  for (const answers of bySection.values()) {
    // Answers that share one region (a block for several exercises) have no order of their own.
    const places = new Map<string, number>();
    const placeOf = (answer: Answer): string => `${answer.page}|${answer.top.toFixed(3)}|${answer.left.toFixed(3)}`;
    for (const answer of answers) places.set(placeOf(answer), (places.get(placeOf(answer)) ?? 0) + 1);
    const unique = answers.filter((answer) => places.get(placeOf(answer)) === 1);
    if (unique.length < 2) continue;
    const byLeft = [...unique].sort((a, b) => a.left - b.left || a.exercise.order - b.exercise.order);
    const columns: Answer[][] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const answer of byLeft) {
      const column = columns[columns.length - 1];
      if (column && answer.left - last <= COLUMN_GAP) column.push(answer);
      else columns.push([answer]);
      last = answer.left;
    }
    for (const column of columns) {
      column.sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left || a.exercise.order - b.exercise.order);
      const stray = outOfOrder(column);
      column.forEach((answer, at) => {
        if (!stray.has(answer)) return;
        const previous = column[at - 1];
        const next = column[at + 1];
        drafts.push(
          draft(
            'solution-order',
            'warning',
            answer.exercise.ref,
            answer.page,
            `The answer of ${answer.exercise.ref} is out of order in the key: in its column it stands between ${previous ? previous.exercise.frame.label as string : 'the start'} and ${next ? next.exercise.frame.label as string : 'the end'}, which the numbers do not allow.`,
            excerpt(`after ${previous ? previous.exercise.frame.label as string : '(nothing)'}, before ${next ? next.exercise.frame.label as string : '(nothing)'}`, VERIFY_LIMITS.evidenceLength),
            { ...answer.exercise.where, page: answer.page, top: answer.top, left: answer.left },
          ),
        );
      });
    }
  }
  return drafts;
}
