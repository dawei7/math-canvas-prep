import type { Rect } from '../model/types.js';
import { draft, type Draft, type Exercise } from './common.js';
import { excerpt } from './labels.js';
import { labelNumber, namedNumbers, namesNumber, type NamedNumbers } from './lineclass.js';
import type { Piece } from './regions.js';
import { chainOf, coveredShare, pagesOfRange, pos, type Covering, type Run, type Zone } from './run.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * The instruction printed for a group of exercises is stored as the `context` of each of them. Three checks on that:
 * an instruction that names numbers ("Exercises 5 - 10", "For 10-13", "Problems 3 and 4") is attached to an exercise
 * whose number it does not name (`context-range`) or is not attached to one that it names (`context-missing`), and the
 * attached instruction is not the last instruction printed above the exercise (`context-not-nearest`).
 */

const regionKey = (page: number, rect: Rect): string => `${page}|${[rect.left, rect.top, rect.right, rect.bottom].map((value) => value.toFixed(4)).join(',')}`;

/** The regions of an exercise that show text to the learner: its own regions and its instructions. */
function shown(exercise: Exercise): Covering[] {
  const frame = exercise.frame;
  return [
    ...chainOf(frame).map((region, index): Covering => ({ page: region.page, rect: region.rect, kind: index === 0 ? 'exercise' : 'continues', frame })),
    ...(frame.context ?? []).map((region): Covering => ({ page: region.page, rect: region.rect, kind: 'context', frame })),
  ];
}

const isCovered = (piece: Piece, page: number, exercise: Exercise): boolean =>
  coveredShare(
    piece.rect,
    shown(exercise).filter((region) => region.page === page),
  ) >= VERIFY_LIMITS.coveredShare;

/** The ranges of numbers an instruction region names, and the line that names them. */
function namedBy(run: Run, page: number, rect: Rect): { named: NamedNumbers; line: string } | undefined {
  const ranges: NamedNumbers['ranges'] = [];
  let line: string | undefined;
  for (const piece of run.index.page(page).pieces) {
    if (piece.headerFooter) continue;
    const centre = (piece.rect.left + piece.rect.right) / 2;
    const middle = (piece.rect.top + piece.rect.bottom) / 2;
    if (centre < rect.left || centre > rect.right || middle < rect.top || middle > rect.bottom) continue;
    const found = namedNumbers(piece.text);
    if (found === undefined) continue;
    ranges.push(...found.ranges);
    line ??= piece.text;
  }
  return ranges.length === 0 || line === undefined ? undefined : { named: { ranges }, line };
}

function zoneOf(run: Run, exercise: Exercise): Zone | undefined {
  return run.layout.zones.find((zone) => zone.id === exercise.section);
}

export function checkContexts(run: Run): Draft[] {
  const drafts: Draft[] = [];
  const pageCount = run.project.pdf.pageCount;

  // --- context-range: the instruction names numbers, and this exercise is not one of them --------------------------------------
  const cache = new Map<string, ReturnType<typeof namedBy>>();
  for (const exercise of run.state.exercises) {
    if (!exercise.book || exercise.frame.context === undefined) continue;
    const n = labelNumber(exercise.frame.label as string);
    if (n === undefined) continue;
    for (const region of exercise.frame.context) {
      if (region.page < 0 || region.page >= pageCount) continue;
      const key = regionKey(region.page, region.rect);
      if (!cache.has(key)) cache.set(key, namedBy(run, region.page, region.rect));
      const found = cache.get(key);
      if (found === undefined || namesNumber(found.named, n)) continue;
      drafts.push(
        draft(
          'context-range',
          'error',
          exercise.ref,
          region.page,
          `The instruction of ${exercise.ref} on page ${region.page} names other exercises than ${exercise.frame.label as string}: "${excerpt(found.line, 60)}".`,
          excerpt(found.line, VERIFY_LIMITS.evidenceLength),
          exercise.where,
        ),
      );
    }
  }

  // --- context-missing: an instruction of the section names this exercise, and it is not attached --------------------------------
  for (const zone of run.layout.zones) {
    for (const page of pagesOfRange(zone.start, zone.end, pageCount)) {
      for (const piece of run.index.page(page).pieces) {
        if (piece.headerFooter) continue;
        const at = pos(page, (piece.rect.top + piece.rect.bottom) / 2);
        if (at < zone.start || at >= zone.end) continue;
        const named = namedNumbers(piece.text);
        if (named === undefined) continue;
        for (const exercise of zone.exercises) {
          const n = labelNumber(exercise.frame.label as string);
          if (n === undefined || !namesNumber(named, n)) continue;
          if (pos(exercise.frame.page, exercise.frame.rect.top) < at - 1e-6) continue;
          if (isCovered(piece, page, exercise)) continue;
          drafts.push(
            draft(
              'context-missing',
              'error',
              exercise.ref,
              page,
              `The instruction on page ${page} names exercise ${exercise.frame.label as string} ("${excerpt(piece.text, 60)}"), but it is not the instruction of ${exercise.ref}.`,
              excerpt(piece.text, VERIFY_LIMITS.evidenceLength),
              exercise.where,
            ),
          );
        }
      }
    }
  }

  // --- context-not-nearest: a later instruction is printed between the attached one and the exercise ------------------------------
  for (const exercise of run.state.exercises) {
    const contexts = exercise.frame.context;
    if (!exercise.book || contexts === undefined || contexts.length === 0) continue;
    const zone = zoneOf(run, exercise);
    if (zone === undefined) continue;
    const frame = exercise.frame;
    const to = pos(frame.page, frame.rect.top);
    // The instructions are printed above the exercise; one attached from below is wrong, and then the nearest one above is looked for.
    const printedAbove = contexts.filter((region) => pos(region.page, region.rect.top) < to);
    const from = printedAbove.length > 0 ? Math.max(...printedAbove.map((region) => pos(region.page, region.rect.bottom))) : Math.max(0, frame.page - 1);
    if (to <= from) continue;
    let nearest: { piece: Piece; page: number; at: number } | undefined;
    for (let page = Math.floor(from); page <= frame.page; page += 1) {
      if (page < 0 || page >= pageCount) continue;
      const kinds = run.kinds(page);
      for (const piece of run.index.page(page).pieces) {
        if (kinds.kind(piece) !== 'instruction') continue;
        const at = pos(page, piece.rect.top);
        if (at <= from + 1e-6 || pos(page, piece.rect.bottom) > to + 0.004 || (nearest !== undefined && at <= nearest.at)) continue;
        const width = piece.rect.right - piece.rect.left;
        const across = Math.min(piece.rect.right, frame.rect.right) - Math.max(piece.rect.left, frame.rect.left);
        if (width < 0.6 && across < 0.3 * Math.min(width, frame.rect.right - frame.rect.left)) continue;
        if (isCovered(piece, page, exercise)) continue;
        // A line inside the text of another exercise is part of that exercise (the last sentence of a word problem), not an instruction.
        if (coveredShare(piece.rect, run.covering(page).filter((region) => region.kind === 'exercise' || region.kind === 'continues')) >= VERIFY_LIMITS.coveredShare) continue;
        nearest = { piece, page, at };
      }
    }
    if (nearest === undefined) continue;
    drafts.push(
      draft(
        'context-not-nearest',
        'warning',
        exercise.ref,
        nearest.page,
        `A later instruction is printed above ${exercise.ref} than the one it has (page ${nearest.page}: "${excerpt(nearest.piece.text, 60)}").`,
        excerpt(nearest.piece.text, VERIFY_LIMITS.evidenceLength),
        exercise.where,
      ),
    );
  }

  // --- context-inconsistent: both neighbours share an instruction that this exercise does not have ------------------------------
  const keyOf = (exercise: Exercise): string =>
    (exercise.frame.context ?? [])
      .map((region) => regionKey(region.page, region.rect))
      .sort()
      .join(';');
  for (const zone of run.layout.zones) {
    const list = zone.exercises;
    for (let i = 1; i + 1 < list.length; i += 1) {
      const [before, exercise, after] = [list[i - 1] as Exercise, list[i] as Exercise, list[i + 1] as Exercise];
      const shared = keyOf(before);
      if (shared === '' || shared !== keyOf(after) || keyOf(exercise) === shared) continue;
      // An instruction of its own, printed between the previous exercise and this one, makes a group of one: that is the book's.
      const start = pos(before.frame.page, before.frame.rect.bottom) - 1e-6;
      const end = pos(exercise.frame.page, exercise.frame.rect.top);
      const own = exercise.frame.context ?? [];
      if (own.length > 0 && own.every((region) => pos(region.page, region.rect.top) >= start && pos(region.page, region.rect.top) < end)) continue;
      drafts.push(
        draft(
          'context-inconsistent',
          'warning',
          exercise.ref,
          exercise.frame.page,
          `${exercise.ref} ${own.length === 0 ? 'has no instruction' : 'has another instruction'}, though the exercises before and after it (${before.ref} and ${after.ref}) share one.`,
          `${before.ref} and ${after.ref} have the same instruction`,
          exercise.where,
        ),
      );
    }
  }
  return drafts;
}
