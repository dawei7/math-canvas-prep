import type { Rect } from '../model/types.js';
import { draft, measure, type Draft, type Exercise } from './common.js';
import { VERIFY_LIMITS, type EdgeInk, type InkLookup } from './types.js';

/**
 * `edge-on-ink`: an edge of a region that runs through the ink of a printed glyph cuts a letter, a digit or a line of the
 * neighbouring text in two. The text layer cannot see that (it gives the box of a whole line); the rendered page can. The
 * measuring is `measureInk` (it renders each page once); this is the check on what it measured.
 */

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

const percent = (share: number): string => `${Math.round(share * 100)}%`;

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
        if (!(share > VERIFY_LIMITS.inkEdgeShare)) continue;
        const entry = draft(
          'edge-on-ink',
          'warning',
          exercise.ref,
          region.page,
          `The ${side} edge of the ${region.what} of ${exercise.ref} on page ${region.page} runs through printed ink: ${percent(share)} of the pixels along it are dark, so a glyph is cut.`,
          `${side} edge ${percent(share)} dark; region ${[region.rect.left, region.rect.top, region.rect.right, region.rect.bottom].map((value) => measure(value)).join(',')}`,
          { ...exercise.where, page: region.page, top: region.rect.top, left: region.rect.left },
        );
        entry.weight = share;
        drafts.push(entry);
      }
    }
  }
  return drafts;
}
