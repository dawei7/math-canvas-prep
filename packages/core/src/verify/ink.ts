import type { Rect } from '../model/types.js';
import { draft, measure, type Draft, type Exercise } from './common.js';
import type { PageIndex } from './regions.js';
import { VERIFY_LIMITS, type EdgeDetail, type EdgeFix, type EdgeSide, type InkLookup } from './types.js';

/**
 * `edge-on-ink`: an edge of a region that runs through the ink of a printed glyph cuts a letter, a digit or a line of the
 * neighbouring text in two. The text layer cannot see that (it gives the box of a whole line); the rendered page can. The
 * measuring is `measureInk` (it renders each page once); this is the check on what it measured. An edge is reported when
 *
 * - the ink goes on across it at `VERIFY_LIMITS.inkCrossPixels` pixels or more (the pixels along the edge at which the row or column
 *   just inside the region and the one just outside it are both dark: a glyph, a rule or the border of a box is cut), or
 * - more than `VERIFY_LIMITS.inkEdgeShare` of the pixels in the three rows or columns around it are dark (the edge lies on ink).
 *
 * What the finding is about is what a person or an agent can change (`explainEdges` looked at it):
 *
 * - a position of the same edge within `inkFixWindow` pixels at which the rule is passed: a warning that names it ("move it to y=0.5123");
 * - none, and the ink that goes across the edge is only tips (a descender of the line above poking 1 or 2 pixels into the region, an ascender
 *   of the line below; nothing is cut): `edge-interlocked`, information, nothing to repair;
 * - none, and more is cut (a figure, a formula, a box, a rule): a warning, with the nearest clear position outwards within `inkFarWindow`
 *   pixels as a hint when there is one.
 */

const SIDES: readonly EdgeSide[] = ['top', 'bottom', 'left', 'right'];

/** A share as a percentage: whole above 10 percent, with a decimal below (a hair cut is one percent or less of the edge). */
const percent = (share: number): string => (share >= 0.1 ? `${Math.round(share * 100)}%` : `${(Math.round(share * 1000) / 10).toString()}%`);

interface Region {
  page: number;
  rect: Rect;
  what: string;
  /** How `crop --region` names it (`solution:1`), for the regions that are not the exercise's own. */
  name?: string;
}

const axisOf = (side: EdgeSide): 'y' | 'x' => (side === 'top' || side === 'bottom' ? 'y' : 'x');
const directionOf = (side: EdgeSide, move: number): string => (side === 'top' || side === 'bottom' ? (move < 0 ? 'up' : 'down') : move < 0 ? 'to the left' : 'to the right');
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const points = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** A distance as a finding says it: pixels, and points when the length of a pixel is known. */
function distanceOf(pixels: number, pointsPerPixel: number | undefined): string {
  return pointsPerPixel === undefined ? plural(pixels, 'pixel') : `${plural(pixels, 'pixel')}, ${points(pixels * pointsPerPixel)} point${pixels * pointsPerPixel === 1 ? '' : 's'}`;
}

/** Whether the ink that goes across an edge is only tips (every piece of it pokes across by at most `inkTipPixels`, no run along the edge): nothing is cut that a rectangle could save. */
export const isInterlocked = (detail: EdgeDetail): boolean => detail.poke <= VERIFY_LIMITS.inkTipPixels && detail.run < VERIFY_LIMITS.inkThickRun;

/** The text a region holds, to tell that a move of an edge leaves what the region says as it is (the checks of the text read the same lines). */
function sameText(index: PageIndex, page: number, before: Rect, after: Rect): boolean {
  const a = index.page(page).read(before);
  const b = index.page(page).read(after);
  return a.pieces.join('\u0001') === b.pieces.join('\u0001') && a.straddling.join('\u0001') === b.straddling.join('\u0001');
}

/** A region of an exercise on a page, to see that a move of an edge does not run into the region of another exercise. */
interface Placed {
  ref: string;
  rect: Rect;
}

/**
 * How far a move may leave a region in the region of another exercise: two regions that both move to this overlap by less than `overlapMinHeight`
 * (a move is not offered when it leaves more, unless the regions overlapped that much before and it does not make it more).
 */
const INTRUSION = VERIFY_LIMITS.overlapMinHeight / 2 - 0.0001;

/** How much of its extent along the move the edge's region shares with another region: the height for a horizontal edge, the width for a vertical one. */
function sharedExtent(side: EdgeSide, a: Rect, b: Rect): number {
  const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (across <= 0 || down <= 0) return 0;
  return side === 'top' || side === 'bottom' ? down : across;
}

/**
 * The finding of an edge is about what can be changed: with the text of the pages (`index`) a position is only named when moving the edge there
 * leaves the text that the region holds as it is (so that the repair does not make a finding of the text checks, a label that is no longer first,
 * a line that is left behind, instead of the one it removes) and does not run into the region of another exercise (an `overlap`).
 */
export function checkInk(exercises: readonly Exercise[], lookup: InkLookup, index?: PageIndex): Draft[] {
  const drafts: Draft[] = [];
  const done = new Set<string>();
  const placed = new Map<number, Placed[]>();
  for (const exercise of exercises) {
    const frame = exercise.frame;
    for (const region of [{ page: frame.page, rect: frame.rect }, ...(frame.continues ?? []), ...(frame.context ?? []), ...(frame.solution ?? [])]) {
      const list = placed.get(region.page) ?? [];
      list.push({ ref: exercise.ref, rect: region.rect });
      placed.set(region.page, list);
    }
  }
  const intrudes = (ref: string, page: number, side: EdgeSide, before: Rect, after: Rect): boolean =>
    (placed.get(page) ?? []).some((other) => other.ref !== ref && sharedExtent(side, after, other.rect) > Math.max(INTRUSION, sharedExtent(side, before, other.rect)));
  for (const exercise of exercises) {
    const frame = exercise.frame;
    const regions: Region[] = [
      { page: frame.page, rect: frame.rect, what: 'region' },
      ...(frame.continues ?? []).map((region, at): Region => ({ ...region, what: 'continuation region', name: `continues:${at}` })),
      ...(frame.context ?? []).map((region, at): Region => ({ ...region, what: 'instruction region', name: `context:${at}` })),
      ...(frame.solution ?? []).map((region, at): Region => ({ ...region, what: 'solution region', name: `solution:${at}` })),
    ];
    for (const region of regions) {
      const key = `${region.page}|${[region.rect.left, region.rect.top, region.rect.right, region.rect.bottom].map((value) => value.toFixed(5)).join(',')}`;
      if (done.has(key)) continue;
      done.add(key);
      const ink = lookup({ page: region.page, rect: region.rect });
      if (ink === undefined) continue;
      for (const side of SIDES) {
        const share = ink[side];
        const crossed = ink.cross?.[side] ?? 0;
        const cuts = crossed >= VERIFY_LIMITS.inkCrossPixels;
        if (!cuts && !(share > VERIFY_LIMITS.inkEdgeShare)) continue;
        const detail = ink.detail?.[side];
        const length = ink.length === undefined ? 0 : side === 'top' || side === 'bottom' ? ink.length.horizontal : ink.length.vertical;
        const crossedShare = length > 0 ? crossed / length : 0;
        const pointsPerPixel = ink.pointsPerPixel;
        const where = `The ${side} edge of the ${region.what}${region.name !== undefined ? ` (${region.name})` : ''} of ${exercise.ref} on page ${region.page}`;
        const facts = cuts
          ? `cuts printed ink: the ink goes on across it at ${plural(crossed, 'pixel')}${length > 0 ? ` of its ${length} (${percent(crossedShare)})` : ''}, so a glyph or a line is cut`
          : `runs through printed ink: ${percent(share)} of the pixels along it are dark, so a glyph is cut`;
        const measured = `${side} edge ${percent(share)} dark; ink goes across it at ${crossed} px`;
        const regionText = `region ${[region.rect.left, region.rect.top, region.rect.right, region.rect.bottom].map((value) => measure(value)).join(',')}`;
        const windowPoints = points(VERIFY_LIMITS.inkFixWindow * (pointsPerPixel ?? 0.5));
        const named = (fix: EdgeFix): string => `${axisOf(side)}=${fix.position} (${distanceOf(Math.abs(fix.move), pointsPerPixel)} ${directionOf(side, fix.move)})`;
        const reach = detail !== undefined && detail.poke > VERIFY_LIMITS.inkTipPixels ? `; the ink reaches more than ${plural(VERIFY_LIMITS.inkTipPixels, 'pixel')} to each side of it` : '';

        let code: 'edge-on-ink' | 'edge-interlocked' = 'edge-on-ink';
        let severity: 'warning' | 'info' = 'warning';
        let message: string;
        let evidence: string;
        const moved = (fix: EdgeFix): Rect => ({ ...region.rect, [side]: fix.position });
        const safe = detail?.fixes.find((fix) => (index === undefined || sameText(index, region.page, region.rect, moved(fix))) && !intrudes(exercise.ref, region.page, side, region.rect, moved(fix)));
        const far = detail?.far !== undefined && !intrudes(exercise.ref, region.page, side, region.rect, moved(detail.far)) ? detail.far : undefined;
        if (safe !== undefined) {
          const fix = safe;
          message = `${where} ${facts}. Move it to ${named(fix)}: there ${fix.crossing === 0 ? 'no ink goes' : 'only a tip of ink goes'} across it.`;
          evidence = `${measured}; move ${side} to ${axisOf(side)}=${fix.position} (${fix.move > 0 ? '+' : ''}${fix.move} px); ${regionText}`;
        } else if (detail !== undefined && isInterlocked(detail)) {
          code = 'edge-interlocked';
          severity = 'info';
          message = `${where} is crossed by ink that no position within ${windowPoints} points avoids: ${cuts ? `only tips poke across it, at most ${plural(detail.poke, 'pixel')} deep` : 'it lies on ink and cuts nothing'}; the lines are set too tightly for a rectangle to separate them. Nothing to repair.`;
          evidence = `${measured}${cuts ? `, at most ${detail.poke} px deep` : ''}; no clear position within ${VERIFY_LIMITS.inkFixWindow} px that leaves the text of the region as it is; ${regionText}`;
        } else if (far !== undefined) {
          message = `${where} ${facts}${reach}. No position within ${windowPoints} points clears it; the nearest clear position outwards is ${named(far)}: the edge cuts a figure, a formula or a box that reaches that far. Look at the crop (\`mcprep crop ${exercise.ref}\`) and move the edge there if what it cuts belongs to this region.`;
          evidence = `${measured}; no clear position within ${VERIFY_LIMITS.inkFixWindow} px; nearest outwards ${axisOf(side)}=${far.position} (${far.move > 0 ? '+' : ''}${far.move} px); ${regionText}`;
        } else if (detail !== undefined) {
          const farPoints = points(VERIFY_LIMITS.inkFarWindow * (pointsPerPixel ?? 0.5));
          message = `${where} ${facts}${reach}. No position within ${farPoints} points outwards clears it: it cuts a figure, a box or a formula that interlocks with its neighbours or reaches further than that, and a rectangle cannot avoid it. Look at the crop (\`mcprep crop ${exercise.ref}\`): take the whole of it into the region, or acknowledge the finding when the book prints it so.`;
          evidence = `${measured}; no clear position within ${VERIFY_LIMITS.inkFarWindow} px outwards; ${regionText}`;
        } else {
          // A measure that did not look at what could be done: the finding is as it was before, without a position.
          message = `${where} ${facts}.`;
          evidence = `${measured}; ${regionText}`;
        }
        const entry = draft(code, severity, exercise.ref, region.page, message, evidence, { ...exercise.where, page: region.page, top: region.rect.top, left: region.rect.left });
        entry.weight = Math.max(share, crossedShare);
        drafts.push(entry);
      }
    }
  }
  return drafts;
}
