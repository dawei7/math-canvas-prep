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
 * follows its parent and is one deeper (a reader tolerates jumps by clamping, which is reported as a repair). The optional
 * `id` (the key by which a frame's `section` finds its entry) must be well formed and unique, `label` at most 24
 * characters, `top` a number from 0 to 1.
 */
export function checkOutline(raw: unknown, pageCount: number): OutlineCheck {
  const issues: Issue[] = [];
  if (!Array.isArray(raw)) {
    return { entries: [], issues: [issue('error', 'outline-not-array', 'The outline entries must be a list.')] };
  }
  const entries: OutlineEntry[] = [];
  const firstWithId = new Map<string, number>();
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
    const named = typeof title === 'string' && title.trim().length > 0 ? `${where} ("${title.trim().slice(0, 40)}")` : where;
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

    let id: string | undefined;
    const rawId = item['id'];
    if (rawId !== undefined && rawId !== null) {
      if (typeof rawId !== 'string' || !LIMITS.sectionIdPattern.test(rawId)) {
        issues.push(
          issue('error', 'outline-bad-id', `The id of ${named} must be 1 to ${LIMITS.sectionIdMax} characters of A-Z a-z 0-9 . _ - starting with a letter or digit, not ${JSON.stringify(rawId)}.`, {
            fix: 'Give the entry an id such as "1.2" or "c3" (`mcprep outline update ... --new-id`).',
          }),
        );
        ok = false;
      } else if (firstWithId.has(rawId)) {
        issues.push(
          issue('error', 'outline-duplicate-id', `The id "${rawId}" of ${named} is already the id of outline entry ${firstWithId.get(rawId) as number}.`, {
            fix: 'Every outline entry that exercises refer to needs an id of its own.',
            data: { id: rawId },
          }),
        );
        ok = false;
      } else {
        id = rawId;
        firstWithId.set(rawId, index);
      }
    }

    let label: string | undefined;
    const rawLabel = item['label'];
    if (rawLabel !== undefined && rawLabel !== null) {
      if (typeof rawLabel !== 'string' || rawLabel.trim().length > LIMITS.outlineLabelMax) {
        issues.push(
          issue('error', 'outline-bad-label', `The label of ${named} must be a text of at most ${LIMITS.outlineLabelMax} characters, not ${JSON.stringify(rawLabel).slice(0, 60)}.`, {
            fix: 'The label is the number printed with the heading, such as "1.1" or "Chapter 3"; shorten it or leave it out.',
          }),
        );
        ok = false;
      } else if (rawLabel.trim().length > 0) label = rawLabel.trim();
    }

    let top: number | undefined;
    const rawTop = item['top'];
    if (rawTop !== undefined && rawTop !== null) {
      if (typeof rawTop !== 'number' || !Number.isFinite(rawTop) || rawTop < 0 || rawTop > 1) {
        issues.push(
          issue('error', 'outline-bad-top', `The top of ${named} (${JSON.stringify(rawTop)}) must be a number from 0 to 1: where the heading starts on its page, measured from the top.`, {
            fix: 'Use a fraction of the page height (0.1 is a tenth of the way down), or leave it out.',
          }),
        );
        ok = false;
      } else top = rawTop;
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
    const entry: OutlineEntry = { title: (title as string).trim(), page: page as number, depth: fixed };
    if (id !== undefined) entry.id = id;
    if (label !== undefined) entry.label = label;
    if (top !== undefined) entry.top = top;
    entries.push(entry);
  });
  return { entries, issues };
}

/**
 * Makes entries fit the format before they are stored: titles cleaned and cut to 200 characters, pages and depths
 * clamped, empty titles dropped, labels cut to 24 characters, `top` kept inside 0..1. An id that is not well formed is
 * dropped (the operations that take ids check them before they get here). Used on outlines that come from the PDF or
 * from heuristics.
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
    const clean: OutlineEntry = { title, page, depth };
    if (entry.id !== undefined && LIMITS.sectionIdPattern.test(entry.id)) clean.id = entry.id;
    const label = entry.label === undefined ? '' : cleanTitle(entry.label).slice(0, LIMITS.outlineLabelMax).trim();
    if (label.length > 0) clean.label = label;
    if (entry.top !== undefined && Number.isFinite(entry.top)) clean.top = Math.min(1, Math.max(0, entry.top));
    result.push(clean);
  }
  return result;
}
