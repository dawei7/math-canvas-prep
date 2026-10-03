import { isBelowMinimum } from '../model/rect.js';
import type { Frame } from '../model/types.js';
import { LIMITS } from './constants.js';
import { issue, type Issue } from './issues.js';

/** The frames of every unit, by unit id. Frames without a unit are not listed. */
export function groupUnits(frames: readonly Frame[]): Map<string, Frame[]> {
  const units = new Map<string, Frame[]>();
  for (const frame of frames) {
    if (frame.unit === undefined) continue;
    const members = units.get(frame.unit);
    if (members) members.push(frame);
    else units.set(frame.unit, [frame]);
  }
  return units;
}

/** The parts of a unit on one page, top to bottom (then left to right). */
export function partsOnPage(frames: readonly Frame[], unit: string, page: number): Frame[] {
  return frames
    .filter((frame) => frame.unit === unit && frame.page === page)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

const fmt = (value: number): string => (Math.round(value * 100000) / 100000).toString();

/**
 * The tiling rule of docs/BUNDLE_FORMAT.md ("Parts"): on every page they occupy, the parts of a unit tile one area.
 * Sorted from top to bottom each part's top equals the previous part's bottom (within 0.002), and all parts there have
 * the same left and right (within 0.002). Deviations up to the tolerance are snapped (reported as repairs); larger ones
 * are errors. Returns the frames with the snapping applied (the input is not modified).
 */
export function checkUnits(
  frames: readonly Frame[],
  skip: ReadonlySet<string> = new Set(),
): { frames: Frame[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const copies = new Map<string, Frame>();
  for (const frame of frames) copies.set(frame.id, { ...frame, rect: { ...frame.rect } });
  const tolerance = LIMITS.tileTolerance + 1e-9;

  for (const [unit, members] of groupUnits(frames)) {
    if (skip.has(unit)) continue;
    if (members.length === 1) {
      const only = members[0] as Frame;
      issues.push(
        issue('warning', 'unit-single', `Unit "${unit}" has only one frame (${only.id}); it counts as an ordinary exercise.`, {
          frameId: only.id,
          unit,
          fix: 'Cut the exercise into at least two parts, or remove the unit from the frame.',
        }),
      );
    }
    const pages = [...new Set(members.map((frame) => frame.page))].sort((a, b) => a - b);
    for (const page of pages) {
      const parts = partsOnPage(members, unit, page).map((frame) => copies.get(frame.id) as Frame);
      const first = parts[0];
      if (!first || parts.length < 2) continue;
      let edgesOk = true;
      for (const part of parts.slice(1)) {
        const dl = Math.abs(part.rect.left - first.rect.left);
        const dr = Math.abs(part.rect.right - first.rect.right);
        if (dl > tolerance || dr > tolerance) {
          edgesOk = false;
          issues.push(
            issue(
              'error',
              'unit-edges',
              `Part ${part.id} of unit "${unit}" on page ${page} does not share the left and right edges of ${first.id} (left ${fmt(part.rect.left)} vs ${fmt(first.rect.left)}, right ${fmt(part.rect.right)} vs ${fmt(first.rect.right)}). Parts must be stacked in one column.`,
              {
                frameId: part.id,
                unit,
                page,
                fix: `Give every part of the unit on this page left ${fmt(first.rect.left)} and right ${fmt(first.rect.right)}, or make side-by-side columns separate exercises.`,
              },
            ),
          );
        }
      }
      if (!edgesOk) continue;
      for (const part of parts.slice(1)) {
        if (part.rect.left !== first.rect.left || part.rect.right !== first.rect.right) {
          issues.push(
            issue('repair', 'unit-snapped', `Part ${part.id} of unit "${unit}": left and right are snapped to those of ${first.id}.`, {
              frameId: part.id,
              unit,
              page,
            }),
          );
          part.rect.left = first.rect.left;
          part.rect.right = first.rect.right;
        }
      }
      for (let k = 1; k < parts.length; k += 1) {
        const upper = parts[k - 1] as Frame;
        const lower = parts[k] as Frame;
        const gap = lower.rect.top - upper.rect.bottom;
        if (gap === 0) continue;
        if (Math.abs(gap) <= tolerance) {
          // As the app does: a gap is closed by the part above, an overlap is split down the middle.
          if (gap > 0) upper.rect.bottom = lower.rect.top;
          else {
            const at = (lower.rect.top + upper.rect.bottom) / 2;
            upper.rect.bottom = at;
            lower.rect.top = at;
          }
          issues.push(
            issue('repair', 'unit-snapped', `Parts ${upper.id} and ${lower.id} of unit "${unit}" are snapped to meet exactly (${fmt(Math.abs(gap))} apart).`, {
              frameId: lower.id,
              unit,
              page,
            }),
          );
          continue;
        }
        if (gap > 0) {
          issues.push(
            issue(
              'error',
              'unit-gap',
              `Parts ${upper.id} and ${lower.id} of unit "${unit}" on page ${page} leave a gap of ${fmt(gap)} (${upper.id} ends at ${fmt(upper.rect.bottom)}, ${lower.id} starts at ${fmt(lower.rect.top)}).`,
              {
                frameId: lower.id,
                unit,
                page,
                fix: `Set the top of ${lower.id} to ${fmt(upper.rect.bottom)} (or the bottom of ${upper.id} to ${fmt(lower.rect.top)}): the parts of a unit tile one area with no gap.`,
                data: { gap, upper: upper.id, lower: lower.id },
              },
            ),
          );
        } else {
          issues.push(
            issue(
              'error',
              'unit-overlap',
              `Parts ${upper.id} and ${lower.id} of unit "${unit}" on page ${page} overlap by ${fmt(-gap)} (${upper.id} ends at ${fmt(upper.rect.bottom)}, ${lower.id} starts at ${fmt(lower.rect.top)}).`,
              {
                frameId: lower.id,
                unit,
                page,
                fix: `Set the top of ${lower.id} to ${fmt(upper.rect.bottom)} (or the bottom of ${upper.id} to ${fmt(lower.rect.top)}): the parts of a unit never overlap.`,
                data: { overlap: -gap, upper: upper.id, lower: lower.id },
              },
            ),
          );
        }
      }
      // Snapping can only move an edge by the tolerance; make sure no part became thinner than the minimum.
      for (const part of parts) {
        if (isBelowMinimum(part.rect)) {
          issues.push(
            issue('error', 'rect-too-small', `Part ${part.id} of unit "${unit}" is below the minimum size after its edges were snapped.`, {
              frameId: part.id,
              unit,
              page,
              fix: `Make the part at least ${LIMITS.minHeight} tall.`,
            }),
          );
        }
      }
    }
  }
  return { frames: frames.map((frame) => copies.get(frame.id) as Frame), issues };
}
