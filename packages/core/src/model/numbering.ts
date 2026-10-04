import { isAuthoritative } from './authority.js';
import type { Frame, FrameKind } from './types.js';

/**
 * Positional numbering, exactly as the Android app computes it and as docs/BUNDLE_FORMAT.md describes it: numbers are
 * never stored. Separately for exercises, questions and bookmarks: page by page, top before bottom, left before right;
 * the parts of one unit count once, at the position of the unit's first part (a unit of three parts at exercise
 * position 4 becomes 4.1, 4.2, 4.3). The order of the frames in the file does not matter.
 *
 * Authoritative exercises (authority "book") take no part in it: they are named by their printed label and their
 * section, so they get no entry here and are not counted.
 */
export interface FrameNumber {
  id: string;
  kind: FrameKind;
  /** Position among the frames of the same kind (a unit counts once), from 1. */
  number: number;
  /** Part number within the unit, from 1, or undefined for a frame that is not one of several parts. */
  part?: number;
  partCount?: number;
  /** `E4`, `E4.2`, `Q1`, `B3`. */
  label: string;
}

export const KIND_PREFIX: Record<FrameKind, string> = { exercise: 'E', question: 'Q', bookmark: 'B' };

/** Page, then top, then left; frames in exactly the same place are ordered by id so the order never wobbles. */
export function compareReadingOrder(a: Frame, b: Frame): number {
  if (a.page !== b.page) return a.page < b.page ? -1 : 1;
  if (a.rect.top !== b.rect.top) return a.rect.top < b.rect.top ? -1 : 1;
  if (a.rect.left !== b.rect.left) return a.rect.left < b.rect.left ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortInReadingOrder(frames: readonly Frame[]): Frame[] {
  return [...frames].sort(compareReadingOrder);
}

export function numberFrames(frames: readonly Frame[]): Map<string, FrameNumber> {
  const result = new Map<string, FrameNumber>();
  for (const kind of ['exercise', 'question', 'bookmark'] as const) {
    const groups = new Map<string, Frame[]>();
    for (const frame of frames) {
      if (frame.kind !== kind || isAuthoritative(frame)) continue;
      const key = kind === 'exercise' && frame.unit !== undefined ? `unit:${frame.unit}` : `frame:${frame.id}`;
      const members = groups.get(key);
      if (members) members.push(frame);
      else groups.set(key, [frame]);
    }
    const ordered = [...groups.values()]
      .map((members) => members.sort(compareReadingOrder))
      .sort((a, b) => compareReadingOrder(a[0] as Frame, b[0] as Frame));
    ordered.forEach((members, index) => {
      const number = index + 1;
      members.forEach((frame, partIndex) => {
        const isPart = members.length > 1;
        const entry: FrameNumber = {
          id: frame.id,
          kind,
          number,
          label: isPart ? `${KIND_PREFIX[kind]}${number}.${partIndex + 1}` : `${KIND_PREFIX[kind]}${number}`,
        };
        if (isPart) {
          entry.part = partIndex + 1;
          entry.partCount = members.length;
        }
        result.set(frame.id, entry);
      });
    });
  }
  return result;
}

/** Counts per kind, a unit of several parts counting once for exercises. Authoritative exercises are not counted here. */
export function countFrames(frames: readonly Frame[]): Record<FrameKind, number> {
  const counts: Record<FrameKind, number> = { exercise: 0, question: 0, bookmark: 0 };
  for (const entry of numberFrames(frames).values()) {
    if (entry.part === undefined || entry.part === 1) counts[entry.kind] += 1;
  }
  return counts;
}

/** How many frames (parts counted one by one, authoritative exercises included) there are of each kind. */
export function countFramesRaw(frames: readonly Frame[]): Record<FrameKind, number> {
  const counts: Record<FrameKind, number> = { exercise: 0, question: 0, bookmark: 0 };
  for (const frame of frames) counts[frame.kind] += 1;
  return counts;
}

/** The authoritative exercises of a document: how many there are and how many carry a hidden solution. */
export function countBook(frames: readonly Frame[]): { exercises: number; withSolution: number } {
  let exercises = 0;
  let withSolution = 0;
  for (const frame of frames) {
    if (!isAuthoritative(frame)) continue;
    exercises += 1;
    if (frame.solution && frame.solution.length > 0) withSolution += 1;
  }
  return { exercises, withSolution };
}
