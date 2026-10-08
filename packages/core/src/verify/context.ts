import type { Rect } from '../model/types.js';
import { draft, type Draft, type Exercise } from './common.js';
import { excerpt } from './labels.js';
import { aloneOnRow, isCaption, isEquationTag, labelNumber, namedNumbers, namesNumber, type NamedNumbers } from './lineclass.js';
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

const COUNT_WORDS: Record<string, number> = { both: 2, beiden: 2, beide: 2, two: 2, zwei: 2, three: 3, drei: 3, four: 4, vier: 4, five: 5, 'fünf': 5, six: 6, sechs: 6 };
const COUNT_BEFORE = /\b(both|beiden|beide|two|zwei|three|drei|four|vier|five|fünf|six|sechs|\d)\s+(?:folgenden|nächsten|following|next)\b/iu;
const COUNT_AFTER = /\b(?:folgenden|nächsten|following|next)\s+(beiden|beide|two|zwei|three|drei|four|vier|five|fünf|six|sechs|\d)\b/iu;
const UMLAUTS: Record<string, string> = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' };
/** A text layer of LaTeX sets an umlaut as a diaeresis before its letter ("n¨achsten"): put them together again. */
const joinUmlauts = (text: string): string => text.normalize('NFC').replace(/(?:\u00a8| ?\u0308)\s?([aouAOU])/gu, (_, vowel: string) => UMLAUTS[vowel] as string);

/** How many exercises an instruction says it is for ("die beiden folgenden Aufgaben", "the next three exercises"), from the text of its regions. */
export function statedCount(run: Run, regions: readonly { page: number; rect: Rect }[]): number | undefined {
  const text = regions
    .flatMap((region) => run.index.page(region.page).pieces.filter((piece) => piece.rect.top >= region.rect.top - 0.004 && piece.rect.bottom <= region.rect.bottom + 0.004 && piece.rect.left >= region.rect.left - 0.01 && piece.rect.right <= region.rect.right + 0.01).map((piece) => piece.text))
    .join(' ');
  const folded = joinUmlauts(text);
  const match = COUNT_BEFORE.exec(folded) ?? COUNT_AFTER.exec(folded);
  if (!match) return undefined;
  const word = (match[1] as string).toLowerCase();
  return /^\d$/.test(word) ? Number(word) : COUNT_WORDS[word];
}

/**
 * True when a heading is printed between two places (positions as `pos`), in the column of the rect, in no region: a heading of the outline,
 * a bold or larger line alone on its row, or a short line of words set alone and centred over the column ("Aufgaben zum Abgeben").
 * A heading starts another part of the section, and the group of an instruction printed before it ends there.
 */
function headingBetween(run: Run, from: number, to: number, rect: Rect): boolean {
  const centre = (rect.left + rect.right) / 2;
  const width = rect.right - rect.left;
  for (let at = Math.max(0, Math.floor(from)); at <= Math.floor(to); at += 1) {
    if (at >= run.project.pdf.pageCount) break;
    const kinds = run.kinds(at);
    const page = run.index.page(at);
    for (const piece of page.pieces) {
      const place = pos(at, piece.rect.top);
      if (place < from || place >= to || piece.headerFooter) continue;
      if (piece.rect.right < rect.left || piece.rect.left > rect.right) continue;
      if (coveredShare(piece.rect, run.covering(at)) >= VERIFY_LIMITS.coveredShare) continue;
      const kind = kinds.kind(piece);
      if (kind === 'heading') return true;
      const text = piece.text.trim();
      const middle = (piece.rect.left + piece.rect.right) / 2;
      const centred = Math.abs(middle - centre) <= 0.03 && piece.rect.right - piece.rect.left <= 0.6 * width;
      if (kind === 'text' && centred && /^[\p{L}][\p{L}\d .:()-]*$/u.test(text) && /\p{L}{4}/u.test(text) && aloneOnRow(page, piece)) return true;
    }
  }
  return false;
}

/** A footnote stands below this share of the page and is set at most this share of the body size. */
const FOOTNOTE_FROM = 0.6;
const FOOTNOTE_SIZE = 0.9;

/**
 * True when the region holds only a footnote: every piece of text in it lies in the lower part of the page and is set smaller than the
 * text. A footnote given to the exercise whose mark it explains is printed at the foot of the page, below later exercises; it is never
 * the instruction of the exercise that follows it.
 */
function isFootnote(run: Run, page: number, rect: Rect): boolean {
  const lines = run.index.page(page);
  const body = lines.bodySize;
  if (body <= 0 || rect.top < FOOTNOTE_FROM - 0.02) return false;
  const pieces = lines.pieces.filter((piece) => !piece.headerFooter && piece.rect.top >= rect.top - 0.004 && piece.rect.bottom <= rect.bottom + 0.004);
  return pieces.length > 0 && pieces.every((piece) => piece.fontSize > 0 && piece.fontSize <= FOOTNOTE_SIZE * body);
}

/**
 * True when the region lies on the text of an exercise (the region or a continuation of any exercise): the statement of an earlier exercise that is
 * attached as the setup of a later one ("same setup as 4.28") is the text of that exercise, not an instruction printed above the later one.
 */
function isExerciseText(run: Run, page: number, rect: Rect): boolean {
  return coveredShare(rect, run.covering(page).filter((region) => region.kind === 'exercise' || region.kind === 'continues')) >= VERIFY_LIMITS.coveredShare;
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

/** True when the regions show a figure or a table and no instruction: no text at all, or a caption ("Figure 4.4: ..."), and no line that tells what to do. */
function isFigureOnly(run: Run, regions: readonly { page: number; rect: Rect }[]): boolean {
  if (regions.length === 0 || holdsInstruction(run, regions)) return false;
  let lines = 0;
  let caption = false;
  for (const region of regions) {
    if (region.page < 0 || region.page >= run.project.pdf.pageCount) continue;
    for (const piece of run.index.page(region.page).pieces) {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      const middle = (piece.rect.top + piece.rect.bottom) / 2;
      if (piece.headerFooter || centre < region.rect.left || centre > region.rect.right || middle < region.rect.top || middle > region.rect.bottom) continue;
      lines += 1;
      // A displayed equation that an exercise cites by its number ("(11.1.3)") is a figure of its own as well: the number stands alone at its right end.
      if (isCaption(piece.text) || isEquationTag(piece.text)) caption = true;
    }
  }
  return lines === 0 || caption;
}

/** A region of this many lines or more (the text of a topic, a definition with its conditions, a worked derivation) is an item that an exercise cites, not the line of a group's instruction. */
const CITED_LINES = 5;

/**
 * True when the regions hold an item that an exercise cites rather than an instruction for a group: a figure or a table (see `isFigureOnly`), or a paragraph
 * of at least `CITED_LINES` lines (its sentences may tell what to do, as the steps of a proof do, and are still the text of the item).
 */
function isCitedItem(run: Run, regions: readonly { page: number; rect: Rect }[]): boolean {
  if (isFigureOnly(run, regions)) return true;
  let lines = 0;
  for (const region of regions) {
    if (region.page < 0 || region.page >= run.project.pdf.pageCount) continue;
    for (const piece of run.index.page(region.page).pieces) {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      const middle = (piece.rect.top + piece.rect.bottom) / 2;
      if (!piece.headerFooter && centre >= region.rect.left && centre <= region.rect.right && middle >= region.rect.top && middle <= region.rect.bottom) lines += 1;
    }
  }
  return lines >= CITED_LINES;
}

/** True when a line of text in the regions tells what to do (an instruction, as the lines of a page are classified). */
function holdsInstruction(run: Run, regions: readonly { page: number; rect: Rect }[]): boolean {
  return regions.some((region) => {
    if (region.page < 0 || region.page >= run.project.pdf.pageCount) return false;
    const kinds = run.kinds(region.page);
    return run.index.page(region.page).pieces.some((piece) => {
      const centre = (piece.rect.left + piece.rect.right) / 2;
      const middle = (piece.rect.top + piece.rect.bottom) / 2;
      return kinds.kind(piece) === 'instruction' && centre >= region.rect.left && centre <= region.rect.right && middle >= region.rect.top && middle <= region.rect.bottom;
    });
  });
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
          // A line inside the text of another exercise is part of that exercise ("numbers 1 to 36" in the statement of exercise 4,
          // "questions 13 and 14" in a part of exercise 15), not an instruction: it is judged like the instructions of `context-not-nearest`.
          if (coveredShare(piece.rect, run.covering(page).filter((region) => region.kind === 'exercise' || region.kind === 'continues')) >= VERIFY_LIMITS.coveredShare) continue;
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
    // A footnote given to the exercise whose mark it explains, or the statement of an earlier exercise that is the setup of this one, is no
    // instruction that a later line could replace.
    if (contexts.every((region) => isFootnote(run, region.page, region.rect) || isExerciseText(run, region.page, region.rect))) continue;
    const to = pos(frame.page, frame.rect.top);
    // The instructions are printed above the exercise; one attached from below is wrong, and then the nearest one above is looked for.
    const printedAbove = contexts.filter((region) => pos(region.page, region.rect.top) < to);
    // A figure or a table printed below the exercises it serves ("see Figure 1.2.3") is attached from below and holds no instruction to compare; a
    // figure of the chapter text that an exercise cites, printed pages before it, is not an instruction that a later line could replace.
    if ((!holdsInstruction(run, contexts) && printedAbove.length === 0) || isCitedItem(run, contexts)) continue;
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
      const above = [...printed.entries()].filter(([, entry]) => entry.at >= from && entry.at < top - 1e-6 && relevant(entry.rect) && !isFootnote(run, entry.page, entry.rect));

      // (a) An instruction printed right above this exercise, which other exercises have and this one does not.
      // An instruction that names numbers ("In Exercises 9 - 15") is not the instruction of an exercise outside them, though it is printed right above it.
      const ownNumber = labelNumber(frame.label as string);
      const outside = (regions: readonly { page: number; rect: Rect }[]): boolean => {
        if (ownNumber === undefined) return false;
        return regions.some((region) => {
          const named = namedBy(run, region.page, region.rect);
          return named !== undefined && !namesNumber(named.named, ownNumber);
        });
      };
      // A figure or a table that an exercise cites is its own, not the instruction of a group: it is neither lacking nor shared.
      // An instruction that only one other exercise has is no group's: that exercise cites the item (the text of a topic, a table), and this one need not.
      const lacking = above.filter(([id, entry]) => !ownKeys.has(id) && !outside([entry]) && !isCitedItem(run, [entry]) && !isExerciseText(run, entry.page, entry.rect) && entry.owners.filter((owner) => owner !== exercise).length >= 2);
      if (lacking.length > 0) {
        const [, entry] = lacking[lacking.length - 1] as (typeof lacking)[number];
        const owners = entry.owners.filter((owner) => owner !== exercise);
        // A heading between the instruction and the exercise: where the instruction holds is said by its words, not by where it is printed.
        const acrossHeading = headingBetween(run, pos(entry.page, entry.rect.bottom), top, frame.rect);
        // An instruction printed above this exercise that the exercise after it does not have either starts further down: it is not the instruction of
        // the first exercise of its group (that exercise and the next one have it), and where it starts is read in the exercises.
        const skipsNext = own === '' && after !== undefined && !owners.includes(after);
        const groupEnd = acrossHeading || skipsNext;
        drafts.push(
          draft(
            groupEnd ? 'context-group-end' : 'context-inconsistent',
            'warning',
            exercise.ref,
            frame.page,
            `${exercise.ref} ${own === '' ? 'has no instruction' : 'does not have the instruction'} printed ${acrossHeading ? 'above it, across a heading' : 'right above it'} (page ${entry.page}), which is the instruction of ${owners
              .slice(0, 3)
              .map((owner) => owner.ref)
              .join(', ')}${owners.length > 3 ? ` and ${owners.length - 3} more` : ''}${skipsNext && !acrossHeading ? `, not of ${(after as Exercise).ref}, the exercise after it` : ''}.`,
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
      if (practice && before !== undefined && after !== undefined && shared !== '' && shared === keyOf(after) && own !== shared && !(ownKeys.size > 0 && above.some(([id]) => ownKeys.has(id))) && !outside(before.frame.context ?? []) && !isCitedItem(run, before.frame.context ?? [])) {
        // An exercise with no instruction in the middle of a group whose instruction does not say how many exercises it is for ("In the exercises that
        // follow, X denotes ...") may be one that does not use it: that is read in the exercise, and the finding can be acknowledged with the page,
        // for a second reviewer to confirm. Another instruction of its own, or an instruction that counts its exercises, is an error.
        const hole = own === '' && statedCount(run, before.frame.context ?? []) === undefined;
        drafts.push(
          draft(
            hole ? 'context-group-end' : 'context-inconsistent',
            'warning',
            exercise.ref,
            frame.page,
            `${exercise.ref} ${own === '' ? 'has no instruction' : 'has another instruction'}, though the exercises before and after it (${before.ref} and ${after.ref}) share one${hole ? ' that does not say how many exercises it is for' : ''}.`,
            `${before.ref} and ${after.ref} have the same instruction`,
            exercise.where,
          ),
        );
        continue;
      }

      // (c) It has none, the exercise before it has an instruction that a group shares, and nothing is printed between them: it belongs to that group.
      // Unless the instruction says how many exercises it is for ("die beiden folgenden Aufgaben", "the next three exercises") and the group has
      // exactly that many: then the group ends with the exercise before.
      const group = before !== undefined ? keyOf(before) : '';
      const counted = group !== '' && before !== undefined ? statedCount(run, before.frame.context ?? []) : undefined;
      const complete = counted !== undefined && counted === (members.get(group) ?? 0);
      // A heading printed between them ("Aufgaben zum Abgeben") ends the group as well. An instruction that does not say how many exercises it is
      // for ("In den folgenden Aufgaben geht es um Primzahlen") ends where its subject ends: that is read in the exercises, and
      // the finding can be acknowledged with the page, for a second reviewer to confirm.
      if (practice && before !== undefined && own === '' && group !== '' && !complete && !outside(before.frame.context ?? []) && !isCitedItem(run, before.frame.context ?? []) && (members.get(group) ?? 0) >= 2 && above.length === 0 && !instructionBetween(run, from, top, frame.page, frame.rect) && !headingBetween(run, from, top, frame.rect)) {
        drafts.push(
          draft(
            counted === undefined ? 'context-group-end' : 'context-inconsistent',
            'warning',
            exercise.ref,
            frame.page,
            `${exercise.ref} has no instruction, though ${before.ref}, printed just before it with no other instruction in between, has one that ${members.get(group) as number} exercises share${counted === undefined ? ' and that does not say how many exercises it is for' : `, and it says it is for ${counted}`}.`,
            `${before.ref} and ${(members.get(group) as number) - 1} more have the same instruction`,
            exercise.where,
          ),
        );
      }
    }
  }
  return drafts;
}
