import type { Rect } from '../model/types.js';
import { draft, type Draft } from './common.js';
import { excerpt } from './labels.js';
import { chainOf, type Run } from './run.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * A running head or a page foot inside a region of an exercise (its text, a continuation, an instruction or an answer): the head of a page is
 * printed on every page, never part of an exercise or an answer. The text of a region is read without it, so no other check sees it; the picture does.
 * (A line of digits is not looked at: the reader tags the limit of an integral or a table digit as a foot now and then.)
 */
const WORDS = /\p{L}{3}/u;
/** The heading that an answer starts with ("Lösung", "Solution 3", "Answer"): the reader takes it for a head where it stands on every answer page, but it is the answer's own. */
const ANSWER_HEADING = /^(?:lösung(?:en)?|lösungsvorschlag|solutions?|answers?|antwort(?:en)?|hints?|hinweise?)\b/iu;

export function checkFurniture(run: Run): Draft[] {
  const drafts: Draft[] = [];
  const pageCount = run.project.pdf.pageCount;
  for (const exercise of run.state.exercises) {
    if (!exercise.book) continue;
    const frame = exercise.frame;
    const regions: { page: number; rect: Rect; what: string }[] = [
      ...chainOf(frame).map((region, at) => ({ page: region.page, rect: region.rect, what: at === 0 ? 'text' : 'continuation' })),
      ...(frame.context ?? []).map((region) => ({ page: region.page, rect: region.rect, what: 'instruction' })),
      ...(frame.solution ?? []).map((region) => ({ page: region.page, rect: region.rect, what: 'answer' })),
    ];
    for (const region of regions) {
      if (region.page < 0 || region.page >= pageCount) continue;
      const held = run.index
        .page(region.page)
        .pieces.filter((piece) => {
          if (!piece.headerFooter || piece.furnitureBy === undefined || !WORDS.test(piece.text) || ANSWER_HEADING.test(piece.text.trim())) return false;
          const centre = (piece.rect.left + piece.rect.right) / 2;
          const middle = (piece.rect.top + piece.rect.bottom) / 2;
          return centre >= region.rect.left && centre <= region.rect.right && middle >= region.rect.top && middle <= region.rect.bottom;
        });
      const first = held[0];
      if (first === undefined) continue;
      drafts.push(
        draft(
          'furniture-in-region',
          'warning',
          exercise.ref,
          region.page,
          `The ${region.what} region of ${exercise.ref} on page ${region.page} holds a running head or a page foot: "${excerpt(first.text, 60)}". It is printed on every page and is no part of the exercise.`,
          excerpt(first.text, VERIFY_LIMITS.evidenceLength),
          exercise.where,
        ),
      );
    }
  }
  return drafts;
}

