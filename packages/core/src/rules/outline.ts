import type { OutlineEntry } from '../model/types.js';
import { LIMITS } from './constants.js';
import { issue, type Issue } from './issues.js';

export interface OutlineCheck {
  entries: OutlineEntry[];
  issues: Issue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Collapses whitespace and removes control characters; what a title looks like in a contents list. */
export function cleanTitle(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Section 4 of the format: `title` 1 to 200 characters, `page` zero-based within the document, `depth` 0 to 8, a child
 * follows its parent and is one deeper (a reader tolerates jumps by clamping, which is reported as a repair).
 */
export function checkOutline(raw: unknown, pageCount: number): OutlineCheck {
  const issues: Issue[] = [];
  if (!Array.isArray(raw)) {
    return { entries: [], issues: [issue('error', 'outline-not-array', 'The outline entries must be a list.')] };
  }
  const entries: OutlineEntry[] = [];
  let previousDepth = -1;
  raw.forEach((item, index) => {
    const where = `outline entry ${index}`;
    if (!isRecord(item)) {
      issues.push(issue('error', 'outline-bad-entry', `${where} is not an object with title, page and depth.`));
      return;
    }
    const title = item['title'];
    const page = item['page'];
    const depth = item['depth'];
    let ok = true;
    if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > LIMITS.outlineTitleMax) {
      issues.push(
        issue('error', 'outline-bad-title', `The title of ${where} must be 1 to ${LIMITS.outlineTitleMax} characters.`, {
          fix: 'Shorten or fill in the title.',
        }),
      );
      ok = false;
    }
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page >= pageCount) {
      issues.push(
        issue('error', 'outline-bad-page', `The page of ${where} (${JSON.stringify(page)}) must be a zero-based page of the document (0..${Math.max(0, pageCount - 1)}).`, {
          fix: 'Pages are zero-based.',
        }),
      );
      ok = false;
    }
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > LIMITS.outlineDepthMax) {
      issues.push(
        issue('error', 'outline-bad-depth', `The depth of ${where} (${JSON.stringify(depth)}) must be a whole number from 0 to ${LIMITS.outlineDepthMax}.`),
      );
      ok = false;
    }
    if (!ok) return;
    let fixed = depth as number;
    if (fixed > previousDepth + 1) {
      issues.push(
        issue('repair', 'outline-depth-clamped', `The depth of ${where} ("${String(title).trim().slice(0, 40)}") jumps from ${previousDepth} to ${fixed}; it is clamped to ${previousDepth + 1}.`),
      );
      fixed = previousDepth + 1;
    }
    previousDepth = fixed;
    entries.push({ title: (title as string).trim(), page: page as number, depth: fixed });
  });
  return { entries, issues };
}

/**
 * Makes entries fit the format before they are stored: titles cleaned and cut to 200 characters, pages and depths
 * clamped, empty titles dropped. Used on outlines that come from the PDF or from heuristics.
 */
export function normalizeOutline(entries: readonly OutlineEntry[], pageCount: number): OutlineEntry[] {
  const result: OutlineEntry[] = [];
  let previousDepth = -1;
  for (const entry of entries) {
    const title = cleanTitle(entry.title).slice(0, LIMITS.outlineTitleMax);
    if (title.length === 0) continue;
    const page = Math.min(Math.max(0, Math.trunc(entry.page)), Math.max(0, pageCount - 1));
    let depth = Math.min(Math.max(0, Math.trunc(entry.depth)), LIMITS.outlineDepthMax);
    depth = Math.min(depth, previousDepth + 1);
    previousDepth = depth;
    result.push({ title, page, depth });
  }
  return result;
}
