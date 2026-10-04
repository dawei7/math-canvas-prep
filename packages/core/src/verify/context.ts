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

/** True when a line that tells what to do is printed between two places (positions as `pos`), in the column of the rect, and is in no region of an exercise. */
function instructionBetween(run: Run, from: number, to: number, page: number, rect: Rect): boolean {
  for (let at = Math.max(0, Math.floor(from)); at <= Math.floor(to) && at <= page; at += 1) {
    if (at >= run.project.pdf.pageCount) break;
    const kinds = run.kinds(at);
    for (const piece of run.index.page(at).pieces) {
      if (kinds.kind(piece) !== 'instruction') continue;
      const place = pos(at, piece.rect.top);
      if (place < from || place >= to) continue;
      const across = Math.min(piece.rect.right, rect.right) - Math.max(piece.rect.left, rect.left);
      if (piece.rect.right - piece.rect.left < 0.6 && across < 0.3 * Math.min(piece.rect.right - piece.rect.left, rect.right - rect.left)) continue;
      if (coveredShare(piece.rect, run.covering(at).filter((region) => region.kind === 'exercise' || region.kind === 'continues')) >= VERIFY_LIMITS.coveredShare) continue;
      return true;
    }
  }
  return false;
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

  // --- context-inconsistent: the instruction of its neighbours or the one printed right above it is not the exercise's own --------------
  // The instructions are compared as sets of regions (an instruction that crosses a page break is two regions).
  const keyOf = (exercise: Exercise): string =>
    (exercise.frame.context ?? [])
      .map((region) => regionKey(region.page, region.rect))
      .sort()
      .join(';');
  for (const zone of run.layout.zones) {
    const list = zone.exercises;
    // How many exercises of the zone have each set of instructions: a set that two or more have is the instruction of a group.
    const members = new Map<string, number>();
    // The instruction regions printed in the zone, each with the exercises that have it.
    const printed = new Map<string, { page: number; rect: Rect; at: number; owners: Exercise[] }>();
    for (const exercise of list) {
      const key = keyOf(exercise);
      if (key !== '') members.set(key, (members.get(key) ?? 0) + 1);
      for (const region of exercise.frame.context ?? []) {
        const regionId = regionKey(region.page, region.rect);
        const held = printed.get(regionId);
        if (held) held.owners.push(exercise);
        else printed.set(regionId, { page: region.page, rect: region.rect, at: pos(region.page, region.rect.top), owners: [exercise] });
      }
    }
    for (let i = 0; i < list.length; i += 1) {
      const exercise = list[i] as Exercise;
      const before = list[i - 1];
      const after = list[i + 1];
      const frame = exercise.frame;
      const own = keyOf(exercise);
      const ownKeys = new Set((frame.context ?? []).map((region) => regionKey(region.page, region.rect)));
      const top = pos(frame.page, frame.rect.top);
      // Between the end of the previous exercise and the top of this one: where an instruction of this exercise is printed.
      const from = before !== undefined ? Math.max(...chainOf(before.frame).map((region) => pos(region.page, region.rect.bottom))) - 1e-6 : zone.head - 1e-6;
      const relevant = (rect: Rect): boolean => {
        const across = Math.min(rect.right, frame.rect.right) - Math.max(rect.left, frame.rect.left);
        return rect.right - rect.left >= 0.6 || across >= 0.3 * Math.min(rect.right - rect.left, frame.rect.right - frame.rect.left);
      };
      const above = [...printed.entries()].filter(([, entry]) => entry.at >= from && entry.at < top - 1e-6 && relevant(entry.rect));

      // (a) An instruction printed right above this exercise, which other exercises have and this one does not.
      const lacking = above.filter(([id]) => !ownKeys.has(id));
      if (lacking.length > 0) {
        const [, entry] = lacking[lacking.length - 1] as (typeof lacking)[number];
        const owners = entry.owners.filter((owner) => owner !== exercise);
        drafts.push(
          draft(
            'context-inconsistent',
            'warning',
            exercise.ref,
            frame.page,
            `${exercise.ref} ${own === '' ? 'has no instruction' : 'does not have the instruction'} printed right above it (page ${entry.page}), which is the instruction of ${owners
              .slice(0, 3)
              .map((owner) => owner.ref)
              .join(', ')}${owners.length > 3 ? ` and ${owners.length - 3} more` : ''}.`,
            `the instruction on page ${entry.page} is the one of ${(owners[0] as Exercise).ref}`,
            exercise.where,
          ),
        );
        continue;
      }

      // (b) The exercises before and after it share an instruction that it does not have (it has none, or another that is not printed above it).
      const shared = before !== undefined ? keyOf(before) : '';
      // (b) and (c) read a practice set, where the exercises of a group follow one another: in a lesson with exercises inline they do not.
      const practice = !run.inline.has(zone);
      if (practice && before !== undefined && after !== undefined && shared !== '' && shared === keyOf(after) && own !== shared && !(ownKeys.size > 0 && above.some(([id]) => ownKeys.has(id)))) {
        drafts.push(
          draft(
            'context-inconsistent',
            'warning',
            exercise.ref,
            frame.page,
            `${exercise.ref} ${own === '' ? 'has no instruction' : 'has another instruction'}, though the exercises before and after it (${before.ref} and ${after.ref}) share one.`,
            `${before.ref} and ${after.ref} have the same instruction`,
            exercise.where,
          ),
        );
        continue;
      }

      // (c) It has none, the exercise before it has an instruction that a group shares, and nothing is printed between them: it belongs to that group.
      const group = before !== undefined ? keyOf(before) : '';
      if (practice && before !== undefined && own === '' && group !== '' && (members.get(group) ?? 0) >= 2 && above.length === 0 && !instructionBetween(run, from, top, frame.page, frame.rect)) {
        drafts.push(
          draft(
            'context-inconsistent',
            'warning',
            exercise.ref,
            frame.page,
            `${exercise.ref} has no instruction, though ${before.ref}, printed just before it with no other instruction in between, has one that ${members.get(group) as number} exercises share.`,
            `${before.ref} and ${(members.get(group) as number) - 1} more have the same instruction`,
            exercise.where,
          ),
        );
      }
    }
  }
  return drafts;
}
