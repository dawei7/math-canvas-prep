import type { Rect } from '../model/types.js';
import { draft, measure, type Draft, type Exercise } from './common.js';
import { excerpt, labelSpan, rowHasItem, rowStartsWithLabel } from './labels.js';
import { startsLikeItem } from './lineclass.js';
import type { PageIndex, PageLines, RegionText } from './regions.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * The checks that read the text layer of the pages: whether the region of an exercise begins with the number the book prints
 * (`label-not-first`, `no-text`) and whether the region of its answer holds that number as the start of an item
 * (`solution-label-missing`, `solution-no-text`). They look at what a person looking at the crop would see first: the text at
 * its left margin, from the top.
 */

const placeKey = (page: number, rect: Rect): string => `${page}|${[rect.left, rect.top, rect.right, rect.bottom].map((value) => value.toFixed(3)).join(',')}`;

const isBlank = (text: RegionText): boolean => text.pieces.length === 0 && text.straddling.length === 0;

/**
 * The left edge of the region cuts through the number that starts the first row. The text layer gives the box of a whole line,
 * so where the number ends is estimated from its share of the characters; a region that starts to the right of the middle
 * of the number does not show it.
 */
function cutsNumber(piece: { text: string; rect: Rect } | undefined, region: Rect, label: string): boolean {
  if (piece === undefined || piece.text.length === 0) return false;
  const span = labelSpan(piece.text, label);
  if (span === undefined) return false;
  const numberWidth = ((piece.rect.right - piece.rect.left) * span) / piece.text.length;
  return region.left > piece.rect.left + 0.5 * numberWidth;
}

/** How far the estimated place of a number may lie left of the region's edge (the place is estimated from the share of the characters). */
const TAIL_SLACK = 0.015;

/** The usual width of one character on a page: the median over its pieces of 20 characters or more (a whole line has no gap in it then). */
const charWidths = new WeakMap<PageLines, number>();
function charWidth(page: PageLines): number {
  let width = charWidths.get(page);
  if (width === undefined) {
    const widths = page.pieces.filter((piece) => piece.text.length >= 20).map((piece) => (piece.rect.right - piece.rect.left) / piece.text.length).sort((a, b) => a - b);
    width = widths.length === 0 ? 0 : (widths[Math.floor(widths.length / 2)] as number);
    charWidths.set(page, width);
  }
  return width;
}

/**
 * A line that comes into the region from the left holds the label as an item ("... is leaning against a 6 .", "side48 . [T] The
 * total cost", "68 . Slope passes through 69 . Slope passes through"), and the label, placed from the right end of the line by the
 * usual width of a character (the gap between the columns is not in the text), lies inside the region: the text layer joined the row
 * of items into one line.
 */
function holdsLabel(line: { text: string; rect: Rect }, region: Rect, label: string, width: number): boolean {
  if (width <= 0) return false;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of line.text.matchAll(new RegExp(`(?:^|[^\\d.])(\\(?${escaped}\\s?[.)])(?=\\s|$)`, 'g'))) {
    const at = (match.index as number) + match[0].indexOf(match[1] as string);
    const start = line.rect.right - (line.text.length - at) * width;
    if (start >= region.left - TAIL_SLACK && start <= region.right) return true;
    // A label near the left end of a long line: the error of the usual width adds up over the characters between it and the right end, so it is
    // also placed from the left end, by the average width of the line itself.
    if (at < line.text.length - at) {
      const fromLeft = line.rect.left + at * ((line.rect.right - line.rect.left) / line.text.length);
      if (fromLeft >= region.left - TAIL_SLACK && fromLeft <= region.right) return true;
    }
  }
  return false;
}

/** An exercise's own region: the first row at its left margin starts with its label. */
export function checkExerciseText(exercises: readonly Exercise[], index: PageIndex, patterns: readonly RegExp[] | undefined): Draft[] {
  const drafts: Draft[] = [];
  for (const exercise of exercises) {
    if (!exercise.book) continue;
    const frame = exercise.frame;
    const page = index.page(frame.page);
    const text = page.read(frame.rect);
    const label = exercise.label as string;
    if (isBlank(text)) {
      drafts.push(
        draft(
          'no-text',
          'warning',
          exercise.ref,
          frame.page,
          `The region of ${exercise.ref} on page ${frame.page} holds no text: a picture, a scan, or a frame that is not on its text.`,
          page.hasText ? 'no text line inside the region' : 'the page has no text layer',
          exercise.where,
        ),
      );
      continue;
    }
    // A text layer that joined two exercises of a row into one line cannot be cut at the column: a line that runs into the
    // region holds the label when the label starts one of its items.
    const marginOk = text.margin !== undefined && rowStartsWithLabel(text.margin, label, patterns);
    // The topmost row starts with the label where the margin row does not: an equation number in the left margin lower down, or a first line that
    // is indented as a paragraph. A number above the label (a numerator, a figure label) is not the first row, and the margin rule stays as it was.
    const topOk = !marginOk && text.topRow !== undefined && rowStartsWithLabel(text.topRow, label, patterns);
    // An exercise that the book prints with no number is labelled "unnumbered": its region has no number to start with, and it must not start
    // like an item of another number either.
    const unnumbered = /^unnumbered$/i.test(label) && text.margin !== undefined && startsLikeItem(text.margin, patterns) === undefined;
    const ok =
      marginOk ||
      topOk ||
      unnumbered ||
      text.straddling.some((line) => rowHasItem(line, label, patterns)) ||
      text.entering.some((line) => holdsLabel(line, frame.rect, label, charWidth(page))) ||
      (text.ownStart !== undefined && rowStartsWithLabel(text.ownStart, label, patterns));
    const cut = ok && (cutsNumber(text.marginPiece, frame.rect, label) || (topOk && cutsNumber(text.topPiece, frame.rect, label)));
    if (ok && !cut) continue;
    // The number is in the first row, glued to other text by the text layer ("where161f .", "This105."): the reader cannot tell
    // where the item starts, a person looking at the region can.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const glued = new RegExp(`(?<=\\p{L})${escaped}(?![\\d]|\\.\\d)|(?<![\\d.])${escaped}(?=\\p{L})`, 'u');
    const firstRow = [text.margin ?? '', ...text.entering.map((line) => line.text)];
    if (!cut && firstRow.some((row) => glued.test(row))) {
      drafts.push(
        draft(
          'label-in-word',
          'warning',
          exercise.ref,
          frame.page,
          `The number ${label} is in the first row of the region of ${exercise.ref} on page ${frame.page}, but the text layer glues it to other text: look at the region, and acknowledge when it starts with its number.`,
          excerpt(firstRow.find((row) => glued.test(row)) as string, VERIFY_LIMITS.evidenceLength),
          exercise.where,
        ),
      );
      continue;
    }
    drafts.push(
      draft(
        'label-not-first',
        'error',
        exercise.ref,
        frame.page,
        cut
          ? `The left edge of the region of ${exercise.ref} on page ${frame.page} cuts through its number ${label}: the text starts at ${measure((text.marginPiece as { rect: Rect }).rect.left)}, the region at ${measure(frame.rect.left)}.`
          : `The region of ${exercise.ref} on page ${frame.page} does not begin with its number ${label}.`,
        excerpt(text.text, VERIFY_LIMITS.evidenceLength),
        exercise.where,
      ),
    );
  }
  return drafts;
}

/** An exercise's solution regions: one of them holds the label as the start of an item. */
export function checkSolutionText(exercises: readonly Exercise[], index: PageIndex, patterns: readonly RegExp[] | undefined): Draft[] {
  // A region that several exercises share (one block for several answers) may hold the label anywhere in it.
  const holders = new Map<string, Set<number>>();
  for (const exercise of exercises) {
    for (const region of exercise.frame.solution ?? []) {
      const key = placeKey(region.page, region.rect);
      const set = holders.get(key);
      if (set) set.add(exercise.order);
      else holders.set(key, new Set([exercise.order]));
    }
  }
  const drafts: Draft[] = [];
  for (const exercise of exercises) {
    const regions = exercise.frame.solution;
    if (!exercise.book || regions === undefined || regions.length === 0) continue;
    const label = exercise.label as string;
    const read = regions.map((region) => ({ region, text: index.page(region.page).read(region.rect) }));
    const withText = read.filter((entry) => !isBlank(entry.text));
    const first = regions[0] as (typeof regions)[number];
    if (withText.length === 0) {
      drafts.push(
        draft(
          'solution-no-text',
          'info',
          exercise.ref,
          first.page,
          `The solution of ${exercise.ref} (page ${first.page}) holds no text: a picture (a graph, say). Its number cannot be checked from the text layer; look at it.`,
          `no text in ${regions.length === 1 ? 'the solution region' : `any of the ${regions.length} solution regions`}`,
          exercise.where,
        ),
      );
      continue;
    }
    // The answer starts in its first region: that is where the label must be. A first region that is a picture (no text) cannot
    // say, and the label may then stand in a later region; a continuation never has to hold it.
    const main = read[0] as (typeof read)[number];
    const candidates = isBlank(main.text) ? withText : [main];
    const cuts: (typeof withText)[number][] = [];
    const found = candidates.some((entry) => {
      const { region, text } = entry;
      if (text.margin !== undefined && rowHasItem(text.margin, label, patterns)) {
        if (!cutsNumber(text.marginPiece, region.rect, label)) return true;
        cuts.push(entry);
        return false;
      }
      if (text.straddling.some((line) => rowHasItem(line, label, patterns))) return true;
      const shared = (holders.get(placeKey(region.page, region.rect))?.size ?? 0) > 1;
      return shared && text.pieces.some((piece) => rowHasItem(piece, label, patterns));
    });
    if (found) continue;
    const cut = cuts[0];
    const shown = cut ?? (candidates[0] as (typeof withText)[number]);
    drafts.push(
      draft(
        'solution-label-missing',
        'error',
        exercise.ref,
        shown.region.page,
        cut
          ? `The left edge of the solution region of ${exercise.ref} on page ${shown.region.page} cuts through its number ${label}: the text starts at ${measure((shown.text.marginPiece as { rect: Rect }).rect.left)}, the region at ${measure(shown.region.rect.left)}.`
          : `The solution region of ${exercise.ref} on page ${shown.region.page} does not start with its number ${label}: it may hold another exercise's answer.`,
        excerpt(shown.text.text, VERIFY_LIMITS.evidenceLength),
        exercise.where,
      ),
    );
  }
  return drafts;
}
