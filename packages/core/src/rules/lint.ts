import { containsRect, intersection, overlapOfSmaller, rectArea, rectHeight, rectsEqual } from '../model/rect.js';
import type { Frame, PageText, Rect, TextLine } from '../model/types.js';
import { AUTHORING } from './constants.js';
import { issue, type Issue } from './issues.js';
import { groupUnits } from './units.js';

/**
 * Warnings: things the format allows but that are probably not what you want. They never block an export.
 */

interface NamedRegion {
  frame: Frame;
  where: string;
  page: number;
  rect: Rect;
}

const fmt = (value: number): string => (Math.round(value * 10000) / 10000).toString();

/** One line of text is about 0.015 of an A4 page; a frame thinner than this probably cuts a line. */
const THIN = 0.015;

/** An overlap counts when it is at least this share of the smaller region (and at least a quarter of a line tall). */
const OVERLAP_SHARE = 0.1;
const OVERLAP_MIN_HEIGHT = 0.004;

export function lintFrames(frames: readonly Frame[]): Issue[] {
  const issues: Issue[] = [];
  if (frames.length === 0) {
    issues.push(
      issue('warning', 'no-frames', 'There are no frames; the bundle would only carry the PDF.', {
        fix: 'Add exercises, questions or bookmarks (for example with `mcprep propose` and `mcprep frames add`).',
      }),
    );
  }

  const regions: NamedRegion[] = [];
  for (const frame of frames) {
    regions.push({ frame, where: 'frame', page: frame.page, rect: frame.rect });
    frame.continues?.forEach((region, index) =>
      regions.push({ frame, where: `continues[${index}]`, page: region.page, rect: region.rect }),
    );
  }

  for (const entry of regions) {
    if (rectHeight(entry.rect) < THIN) {
      issues.push(
        issue('warning', 'thin-frame', `${entry.frame.id} (${entry.where}) is ${fmt(rectHeight(entry.rect))} tall, thinner than one text line (about ${THIN}); it probably cuts a line.`, {
          frameId: entry.frame.id,
          page: entry.page,
          fix: 'Make the frame taller or snap its edges to the text lines.',
        }),
      );
    }
  }

  const byPage = new Map<number, NamedRegion[]>();
  for (const entry of regions) {
    const list = byPage.get(entry.page);
    if (list) list.push(entry);
    else byPage.set(entry.page, [entry]);
  }
  const reported = new Set<string>();
  for (const [page, list] of byPage) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i] as NamedRegion;
        const b = list[j] as NamedRegion;
        if (a.frame.id === b.frame.id) continue;
        if (a.frame.unit !== undefined && a.frame.unit === b.frame.unit) continue;
        const common = intersection(a.rect, b.rect);
        if (!common) continue;
        const share = rectArea(common) / Math.min(rectArea(a.rect), rectArea(b.rect));
        if (share < OVERLAP_SHARE || rectHeight(common) < OVERLAP_MIN_HEIGHT) continue;
        const key = [a.frame.id, b.frame.id].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        const aInB = containsRect(b.rect, a.rect, 0.002);
        const bInA = containsRect(a.rect, b.rect, 0.002);
        if (aInB || bInA) {
          const [inner, outer] = aInB ? [a, b] : [b, a];
          issues.push(
            issue('warning', 'contained', `${inner.frame.id} (${inner.frame.kind}) lies inside ${outer.frame.id} (${outer.frame.kind}) on page ${page}; independent frames should not contain each other.`, {
              frameId: inner.frame.id,
              page,
              fix: `Shrink ${outer.frame.id} or delete ${inner.frame.id}.`,
              data: { other: outer.frame.id },
            }),
          );
        } else {
          issues.push(
            issue('warning', 'overlap', `${a.frame.id} (${a.frame.kind}) and ${b.frame.id} (${b.frame.kind}) overlap by ${Math.round(share * 100)}% of the smaller one on page ${page}; independent frames should not overlap.`, {
              frameId: a.frame.id,
              page,
              fix: `Move an edge of ${a.frame.id} or ${b.frame.id} so they only touch.`,
              data: { other: b.frame.id },
            }),
          );
        }
      }
    }
  }

  const units = groupUnits(frames);
  for (const frame of frames) {
    if (!frame.context) continue;
    const own = frame.unit !== undefined ? (units.get(frame.unit) ?? [frame]) : [frame];
    frame.context.forEach((region, index) => {
      for (const part of own) {
        const regionsOfPart = [{ page: part.page, rect: part.rect }, ...(part.continues ?? [])];
        for (const target of regionsOfPart) {
          if (target.page !== region.page) continue;
          const common = intersection(target.rect, region.rect);
          if (common && rectArea(common) / Math.min(rectArea(target.rect), rectArea(region.rect)) >= OVERLAP_SHARE) {
            issues.push(
              issue('warning', 'context-overlaps-frame', `The context region ${index} of ${frame.id} overlaps ${part.id} itself, so the same text would be shown twice.`, {
                frameId: frame.id,
                page: region.page,
                fix: 'Context is for text printed elsewhere; shrink the frame or the context so they do not overlap.',
              }),
            );
            return;
          }
        }
      }
    });
  }

  for (const [unit, members] of units) {
    const sets = members.map((member) => JSON.stringify(member.context ?? []));
    const withContext = members.filter((member) => (member.context?.length ?? 0) > 0);
    if (withContext.length > 1 && new Set(sets.filter((text) => text !== '[]')).size > 1) {
      issues.push(
        issue('warning', 'unit-context-differs', `Parts of unit "${unit}" carry different context; the importer gives every part the union of all of them.`, {
          unit,
          frameId: (withContext[0] as Frame).id,
          fix: 'Attach the context of a unit once, to its first part.',
        }),
      );
    }
  }
  issues.push(...lintSolutions(frames));
  return issues;
}

/** Two regions count as the same place when every edge is within this distance. */
const SAME_PLACE = 0.005;

/**
 * Solution regions: one that overlaps its own exercise shows the exercise instead of the answer, and one that is the
 * region of another exercise points at an exercise, not at a key. Solution regions are matched against the exercise
 * regions of their page by a search on `top`, so thousands of both are no problem.
 */
function lintSolutions(frames: readonly Frame[]): Issue[] {
  const issues: Issue[] = [];
  if (!frames.some((frame) => frame.solution !== undefined && frame.solution.length > 0)) return issues;

  for (const frame of frames) {
    if (!frame.solution) continue;
    const own: { page: number; rect: Rect }[] = [{ page: frame.page, rect: frame.rect }, ...(frame.continues ?? [])];
    frame.solution.forEach((region, index) => {
      const hit = own.find((target) => target.page === region.page && overlapOfSmaller(target.rect, region.rect) >= OVERLAP_SHARE);
      if (!hit) return;
      issues.push(
        issue('warning', 'solution-overlaps-frame', `The solution region ${index} of ${frame.id} overlaps the exercise itself on page ${region.page}, so the learner's own task would be sent as the answer key.`, {
          frameId: frame.id,
          page: region.page,
          fix: `A solution is printed elsewhere (usually the answer key at the back): \`mcprep solution remove ${frame.id} --index ${index}\`, then \`solution add ${frame.id} --page <key page> --rect ...\`.`,
        }),
      );
    });
  }

  const exerciseRegions = new Map<number, { frame: Frame; rect: Rect }[]>();
  const addRegion = (frame: Frame, page: number, rect: Rect): void => {
    const list = exerciseRegions.get(page);
    if (list) list.push({ frame, rect });
    else exerciseRegions.set(page, [{ frame, rect }]);
  };
  for (const frame of frames) {
    if (frame.kind !== 'exercise') continue;
    addRegion(frame, frame.page, frame.rect);
    frame.continues?.forEach((region) => addRegion(frame, region.page, region.rect));
  }
  for (const list of exerciseRegions.values()) list.sort((a, b) => a.rect.top - b.rect.top);

  for (const frame of frames) {
    if (!frame.solution) continue;
    frame.solution.forEach((region, index) => {
      const list = exerciseRegions.get(region.page);
      if (!list) return;
      // The first entry whose top is not above (region.top - SAME_PLACE).
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((list[middle] as { rect: Rect }).rect.top < region.rect.top - SAME_PLACE) low = middle + 1;
        else high = middle;
      }
      for (let i = low; i < list.length; i += 1) {
        const candidate = list[i] as { frame: Frame; rect: Rect };
        if (candidate.rect.top > region.rect.top + SAME_PLACE) break;
        if (candidate.frame.id === frame.id || !rectsEqual(candidate.rect, region.rect, SAME_PLACE)) continue;
        issues.push(
          issue('warning', 'solution-is-exercise', `The solution region ${index} of ${frame.id} is the same place as the exercise ${candidate.frame.id} on page ${region.page}: it points at an exercise, not at a solution.`, {
            frameId: frame.id,
            page: region.page,
            fix: `Check the key page: \`mcprep solution remove ${frame.id} --index ${index}\` and add the region of the answer instead.`,
            data: { other: candidate.frame.id },
          }),
        );
        break;
      }
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks against the text of the page

function horizontallyInside(line: TextLine, rect: Rect): boolean {
  const centre = (line.rect.left + line.rect.right) / 2;
  return centre >= rect.left && centre <= rect.right;
}

/**
 * Edges that cut through a line of text, running headers or footers inside a frame, and frames with no text at all.
 * `pages` holds the analysed text of the pages that are available (a page without an entry is skipped).
 */
export function lintAgainstText(frames: readonly Frame[], pages: ReadonlyMap<number, PageText>): Issue[] {
  const issues: Issue[] = [];
  const reportedCuts = new Set<string>();
  const check = (frame: Frame, where: string, page: number, rect: Rect): void => {
    const text = pages.get(page);
    if (!text?.hasText) return;
    const near = text.lines.filter((line) => horizontallyInside(line, rect));
    for (const [edge, y] of [
      ['top', rect.top],
      ['bottom', rect.bottom],
    ] as const) {
      for (const line of near) {
        const height = rectHeight(line.rect);
        if (height <= 0) continue;
        if (y > line.rect.top + 0.2 * height && y < line.rect.bottom - 0.2 * height) {
          const key = `${page}|${fmt(y)}|${line.rect.top}`;
          if (reportedCuts.has(key)) continue;
          reportedCuts.add(key);
          const insideShare = edge === 'top' ? (line.rect.bottom - y) / height : (y - line.rect.top) / height;
          const takeWhole = insideShare >= 0.5;
          const target =
            edge === 'top'
              ? takeWhole
                ? Math.max(0, line.rect.top - AUTHORING.startPadding)
                : line.rect.bottom
              : takeWhole
                ? line.rect.bottom + AUTHORING.endPadding
                : line.rect.top - AUTHORING.endPadding;
          issues.push(
            issue('warning', 'clips-line', `The ${edge} edge of ${frame.id} (${where}) cuts through the text line "${line.text.slice(0, 50)}" on page ${page}.`, {
              frameId: frame.id,
              page,
              fix: `Move the ${edge} edge to ${fmt(target)} (${takeWhole ? 'take the line whole' : 'leave the line out'}) or add --snap.`,
              data: { edge, y, suggested: target, line: line.text },
            }),
          );
        }
      }
    }
    const inside = near.filter((line) => line.rect.top >= rect.top - 0.002 && line.rect.bottom <= rect.bottom + 0.002);
    if (inside.some((line) => line.headerFooter === true)) {
      issues.push(
        issue('warning', 'includes-header-footer', `${frame.id} (${where}) on page ${page} includes a running header or footer.`, {
          frameId: frame.id,
          page,
          fix: 'Frame only the exercise text, without page headers, footers and page numbers.',
        }),
      );
    }
  };
  for (const frame of frames) {
    check(frame, 'frame', frame.page, frame.rect);
    frame.continues?.forEach((region, index) => check(frame, `continues[${index}]`, region.page, region.rect));
    frame.solution?.forEach((region, index) => check(frame, `solution[${index}]`, region.page, region.rect));
  }
  return issues;
}
