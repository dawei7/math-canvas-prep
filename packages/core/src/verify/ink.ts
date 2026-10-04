import type { Rect } from '../model/types.js';
import { draft, measure, type Draft, type Exercise } from './common.js';
import { VERIFY_LIMITS, type EdgeInk, type InkLookup } from './types.js';

/**
 * `edge-on-ink`: an edge of a region that runs through the ink of a printed glyph cuts a letter, a digit or a line of the
 * neighbouring text in two. The text layer cannot see that (it gives the box of a whole line); the rendered page can. The
 * measuring is `measureInk` (it renders each page once); this is the check on what it measured. An edge is reported when
 *
 * - the ink goes on across it at `VERIFY_LIMITS.inkCrossPixels` pixels or more (the pixels along the edge at which the row or column
 *   just inside the region and the one just outside it are both dark: a glyph, a rule or the border of a box is cut), or
 * - more than `VERIFY_LIMITS.inkEdgeShare` of the pixels in the three rows or columns around it are dark (the edge lies on ink).
 */

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

/** A share as a percentage: whole above 10 percent, with a decimal below (a hair cut is one percent or less of the edge). */
const percent = (share: number): string => (share >= 0.1 ? `${Math.round(share * 100)}%` : `${(Math.round(share * 1000) / 10).toString()}%`);

interface Region {
  page: number;
  rect: Rect;
  what: string;
}

export function checkInk(exercises: readonly Exercise[], lookup: InkLookup): Draft[] {
  const drafts: Draft[] = [];
  const done = new Set<string>();
  for (const exercise of exercises) {
    const frame = exercise.frame;
    const regions: Region[] = [
      { page: frame.page, rect: frame.rect, what: 'region' },
      ...(frame.continues ?? []).map((region): Region => ({ ...region, what: 'continuation region' })),
      ...(frame.context ?? []).map((region): Region => ({ ...region, what: 'instruction region' })),
      ...(frame.solution ?? []).map((region): Region => ({ ...region, what: 'solution region' })),
    ];
    for (const region of regions) {
      const key = `${region.page}|${[region.rect.left, region.rect.top, region.rect.right, region.rect.bottom].map((value) => value.toFixed(5)).join(',')}`;
      if (done.has(key)) continue;
      done.add(key);
      const ink: EdgeInk | undefined = lookup({ page: region.page, rect: region.rect });
      if (ink === undefined) continue;
      for (const side of SIDES) {
        const share = ink[side];
        const crossed = ink.cross?.[side] ?? 0;
        const cuts = crossed >= VERIFY_LIMITS.inkCrossPixels;
        if (!cuts && !(share > VERIFY_LIMITS.inkEdgeShare)) continue;
        const length = ink.length === undefined ? 0 : side === 'top' || side === 'bottom' ? ink.length.horizontal : ink.length.vertical;
        const crossedShare = length > 0 ? crossed / length : 0;
        const where = `The ${side} edge of the ${region.what} of ${exercise.ref} on page ${region.page}`;
        const entry = draft(
          'edge-on-ink',
          'warning',
          exercise.ref,
          region.page,
          cuts
            ? `${where} cuts printed ink: the ink goes on across it at ${crossed} pixel${crossed === 1 ? '' : 's'}${length > 0 ? ` of its ${length} (${percent(crossedShare)})` : ''}, so a glyph or a line is cut.`
            : `${where} runs through printed ink: ${percent(share)} of the pixels along it are dark, so a glyph is cut.`,
          `${side} edge ${percent(share)} dark; ink goes across it at ${crossed} px; region ${[region.rect.left, region.rect.top, region.rect.right, region.rect.bottom].map((value) => measure(value)).join(',')}`,
          { ...exercise.where, page: region.page, top: region.rect.top, left: region.rect.left },
        );
        entry.weight = Math.max(share, crossedShare);
        drafts.push(entry);
      }
    }
  }
  return drafts;
}
