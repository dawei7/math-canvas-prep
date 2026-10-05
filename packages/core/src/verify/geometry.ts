import { intersection, rectArea, rectHeight, rectWidth, rectsEqual } from '../model/rect.js';
import type { Rect } from '../model/types.js';
import { draft, measure, type Draft, type Exercise } from './common.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * The checks that need no text: two exercises that share a place on a page (`overlap`, `duplicate-region`), an instruction
 * region that lies on an exercise (`context-overlaps-frame`) and a region that is too large, too narrow or too small to be
 * one printed exercise (`region-size`). Regions are indexed by page and swept from top to bottom, so thousands of
 * exercises on a few hundred pages cost a few comparisons each.
 */

/** One region an exercise occupies on a page. */
export interface OwnRegion {
  exercise: Exercise;
  page: number;
  rect: Rect;
  /** The main region of the exercise (not one of its continuations). */
  main: boolean;
}

const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;
const rectText = (rect: Rect): string => [rect.left, rect.top, rect.right, rect.bottom].map((value) => measure(value)).join(',');

/** The regions the exercises occupy (main and continuations), by page, each page's list sorted from top to bottom. */
export function ownRegionsByPage(exercises: readonly Exercise[]): Map<number, OwnRegion[]> {
  const byPage = new Map<number, OwnRegion[]>();
  const add = (entry: OwnRegion): void => {
    const list = byPage.get(entry.page);
    if (list) list.push(entry);
    else byPage.set(entry.page, [entry]);
  };
  for (const exercise of exercises) {
    add({ exercise, page: exercise.frame.page, rect: exercise.frame.rect, main: true });
    for (const region of exercise.frame.continues ?? []) add({ exercise, page: region.page, rect: region.rect, main: false });
  }
  for (const list of byPage.values()) list.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.exercise.order - b.exercise.order);
  return byPage;
}

interface PairHit {
  kind: 'duplicate-region' | 'overlap';
  first: OwnRegion;
  second: OwnRegion;
  share: number;
  height: number;
  width: number;
}

/** A hit that replaces another of the same two exercises: a duplicate beats an overlap, a larger overlap a smaller one. */
const stronger = (hit: PairHit, held: PairHit): boolean => (hit.kind === held.kind ? hit.share > held.share : hit.kind === 'duplicate-region');

/**
 * Two exercises whose regions lie on each other: `duplicate-region` when their main regions are the same place, `overlap`
 * when the common part is more than a twentieth of the smaller region and at least a quarter of a line tall (less than that
 * and the regions only touch). Each pair of exercises is reported once, for the first of them in the order of the book.
 */
export function checkSharedPlaces(byPage: ReadonlyMap<number, readonly OwnRegion[]>): Draft[] {
  const pairs = new Map<string, PairHit>();
  for (const list of byPage.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i] as OwnRegion;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j] as OwnRegion;
        if (b.rect.top >= a.rect.bottom) break;
        if (a.exercise === b.exercise) continue;
        const unit = a.exercise.frame.unit;
        if (unit !== undefined && unit === b.exercise.frame.unit) continue;
        const common = intersection(a.rect, b.rect);
        if (!common) continue;
        const [first, second] = a.exercise.order <= b.exercise.order ? [a, b] : [b, a];
        const smaller = Math.min(rectArea(a.rect), rectArea(b.rect));
        const share = smaller > 0 ? rectArea(common) / smaller : 0;
        const height = rectHeight(common);
        const same = rectsEqual(a.rect, b.rect, VERIFY_LIMITS.sameRegionTolerance);
        if (!same && !(share > VERIFY_LIMITS.overlapShare && height >= VERIFY_LIMITS.overlapMinHeight)) continue;
        const hit: PairHit = { kind: same ? 'duplicate-region' : 'overlap', first, second, share, height, width: rectWidth(common) };
        const key = `${first.exercise.order}|${second.exercise.order}`;
        const held = pairs.get(key);
        if (!held || stronger(hit, held)) pairs.set(key, hit);
      }
    }
  }
  const drafts: Draft[] = [];
  for (const hit of pairs.values()) {
    const { first, second } = hit;
    const a = first.exercise;
    const b = second.exercise;
    const named = (region: OwnRegion): string => (region.main ? region.exercise.ref : `${region.exercise.ref} (its continuation)`);
    if (hit.kind === 'duplicate-region') {
      drafts.push(draft('duplicate-region', 'error', a.ref, first.page, `${a.ref} and ${b.ref} have the same region on page ${first.page}: one of them is framed on the other's text.`, `both ${rectText(first.rect)}`, a.where));
    } else {
      drafts.push(
        draft(
          'overlap',
          'error',
          a.ref,
          first.page,
          `${named(first)} and ${named(second)} overlap by ${percent(hit.share)} of the smaller region on page ${first.page}.`,
          `common part ${measure(hit.width)} wide and ${measure(hit.height)} tall; ${rectText(first.rect)} and ${rectText(second.rect)}`,
          a.where,
        ),
      );
    }
  }
  return drafts;
}

/**
 * An instruction region (a `context` region) that lies on the region of an exercise: the text would be shown twice, or the
 * exercise's first line would be cut into the instruction. One finding for each exercise and each such region, however many
 * exercises share the region.
 */
export function checkContextOverlaps(exercises: readonly Exercise[], byPage: ReadonlyMap<number, readonly OwnRegion[]>): Draft[] {
  const regions = new Map<string, { page: number; rect: Rect; owners: Exercise[] }>();
  for (const exercise of exercises) {
    for (const region of exercise.frame.context ?? []) {
      const key = `${region.page}|${rectText(region.rect)}`;
      const held = regions.get(key);
      if (held) held.owners.push(exercise);
      else regions.set(key, { page: region.page, rect: region.rect, owners: [exercise] });
    }
  }
  const drafts: Draft[] = [];
  const done = new Set<string>();
  for (const [key, entry] of regions) {
    for (const own of byPage.get(entry.page) ?? []) {
      if (own.rect.top >= entry.rect.bottom) break;
      const common = intersection(entry.rect, own.rect);
      if (!common) continue;
      const smaller = Math.min(rectArea(entry.rect), rectArea(own.rect));
      const share = smaller > 0 ? rectArea(common) / smaller : 0;
      if (share < VERIFY_LIMITS.contextOverlapShare || rectHeight(common) < VERIFY_LIMITS.overlapMinHeight) continue;
      const mark = `${own.exercise.order}|${key}`;
      if (done.has(mark)) continue;
      done.add(mark);
      const target = own.exercise;
      const others = entry.owners.filter((owner) => owner !== target);
      const parts = [
        ...(entry.owners.includes(target) ? ['its own instruction'] : []),
        ...(others.length > 0 ? [`the instruction of ${others.slice(0, 3).map((owner) => owner.ref).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}`] : []),
      ].join(' and ');
      drafts.push(
        draft(
          'context-overlaps-frame',
          'warning',
          target.ref,
          own.page,
          `${parts.charAt(0).toUpperCase()}${parts.slice(1)} (a context region) lies ${percent(share)} on ${target.ref}${own.main ? '' : ' (its continuation)'} on page ${own.page}: the same text would be shown twice.`,
          `context region ${rectText(entry.rect)} and region ${rectText(own.rect)} share ${measure(rectHeight(common))} of the page height`,
          target.where,
        ),
      );
    }
  }
  return drafts;
}

/**
 * A region taller than `maxHeight`, narrower than `minWidth` or smaller than `minArea`: not one printed exercise. A continuation
 * of an exercise that spans pages may be as tall as a page, so it is only measured for width and area.
 */
export function checkRegionSizes(exercises: readonly Exercise[], byPage: ReadonlyMap<number, readonly OwnRegion[]> = new Map()): Draft[] {
  const drafts: Draft[] = [];
  for (const exercise of exercises) {
    if (exercise.frame.unit !== undefined) continue;
    const regions = [{ page: exercise.frame.page, rect: exercise.frame.rect, main: true }, ...(exercise.frame.continues ?? []).map((region) => ({ ...region, main: false }))];
    for (const { page, rect, main } of regions) {
      const height = rectHeight(rect);
      const width = rectWidth(rect);
      const area = rectArea(rect);
      const found: string[] = [];
      // An exercise that is alone on its page (a booklet prints one to a page, with room to answer in) may be as tall as the page.
      const alone = (byPage.get(page) ?? []).every((entry) => entry.exercise === exercise);
      if (main && height > VERIFY_LIMITS.maxHeight && !alone) found.push(`height ${measure(height)} is more than ${VERIFY_LIMITS.maxHeight}`);
      if (width < VERIFY_LIMITS.minWidth) found.push(`width ${measure(width)} is less than ${VERIFY_LIMITS.minWidth}`);
      if (area < VERIFY_LIMITS.minArea) found.push(`area ${measure(area, 5)} is less than ${VERIFY_LIMITS.minArea}`);
      if (found.length === 0) continue;
      drafts.push(
        draft(
          'region-size',
          'warning',
          exercise.ref,
          page,
          `The ${main ? 'region' : 'continuation region'} of ${exercise.ref} on page ${page} is not the size of one printed exercise: ${found.join('; ')}.`,
          `region ${rectText(rect)}`,
          main ? exercise.where : { ...exercise.where, page, top: rect.top, left: rect.left },
        ),
      );
    }
  }
  return drafts;
}
