import type { Region } from '../model/types.js';
import { draft, type Draft, type Exercise } from './common.js';
import { measure } from './common.js';
import { chainOf } from './run.js';

/**
 * An exercise (or an answer) that goes on over a page break or into the next column is stored as its main region and up to
 * eight continuations, in the order the text is read: a later page, or the same page in a column to the right or further down.
 * Regions that are out of that order (a deleted or swapped one) would show the text in the wrong order.
 */

const SMALL = 0.004;
const COLUMN = 0.02;

/** True when `next` does not come after `current` in reading order. */
export function outOfReadingOrder(current: Region, next: Region): boolean {
  if (next.page !== current.page) return next.page < current.page;
  const further = next.rect.top >= current.rect.bottom - SMALL;
  const beside = next.rect.left >= current.rect.right - COLUMN;
  return !(further || beside);
}

function problems(exercise: Exercise, regions: readonly Region[], what: 'continuation' | 'solution'): Draft[] {
  const drafts: Draft[] = [];
  for (let i = 0; i + 1 < regions.length; i += 1) {
    const current = regions[i] as Region;
    const next = regions[i + 1] as Region;
    if (!outOfReadingOrder(current, next)) continue;
    drafts.push(
      draft(
        'continuation-order',
        'error',
        exercise.ref,
        next.page,
        `The ${what === 'solution' ? 'solution regions' : 'regions'} of ${exercise.ref} are not in reading order: region ${i + 2} (page ${next.page}, from ${measure(next.rect.top)} down) does not come after region ${i + 1} (page ${current.page}, to ${measure(current.rect.bottom)}).`,
        `page ${current.page} then page ${next.page}; ${what} ${i + 1} ends at ${measure(current.rect.bottom)}, ${i + 2} starts at ${measure(next.rect.top)}`,
        { ...exercise.where, page: next.page, top: next.rect.top, left: next.rect.left },
      ),
    );
  }
  return drafts;
}

export function checkContinuations(exercises: readonly Exercise[]): Draft[] {
  const drafts: Draft[] = [];
  for (const exercise of exercises) {
    if (exercise.frame.continues !== undefined && exercise.frame.continues.length > 0) drafts.push(...problems(exercise, chainOf(exercise.frame), 'continuation'));
    if (exercise.frame.solution !== undefined && exercise.frame.solution.length > 1) drafts.push(...problems(exercise, exercise.frame.solution, 'solution'));
  }
  return drafts;
}
