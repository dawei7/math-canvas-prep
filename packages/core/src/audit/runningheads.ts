import type { PageText, TextLine } from '../model/types.js';
import { headerKey } from '../pdf/lines.js';

const BAND = 0.14;

/** A running head has to stand on this many pages. */
const MIN_PAGES = 3;

/** A running head is a phrase: a short line that repeats (an answer such as "Answers vary.") is not one. */
const MIN_CHARS = 16;

/** A line that starts like an item ("3. x = 2", "(3)") is an answer or an exercise, never a head. */
const startsLikeItem = (text: string): boolean => /^\s*\(?\d{1,3}[.)](?:\s|$)/.test(text);

/** A line in the top band of its page, with words and not starting like an item, can be a running head. */
const candidate = (line: TextLine, key: string): boolean => line.rect.bottom <= BAND && line.chars >= MIN_CHARS && /\p{L}{4}/u.test(key) && !/^#[.)]\s/.test(key);

/** Two lines are on one row when they share at least half the height of the smaller. */
function sameRow(a: TextLine, b: TextLine): boolean {
  const shared = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
  return shared >= 0.5 * Math.min(a.rect.bottom - a.rect.top, b.rect.bottom - b.rect.top);
}

/** Copies of the pages with `headerFooter` set on the lines `isHead` names; pages that need no change are the same objects, and a list without any change is returned as it is. */
function flagged(pages: readonly PageText[], headsOf: (page: PageText) => ((line: TextLine) => boolean) | undefined): readonly PageText[] {
  let changed = false;
  const result = pages.map((page) => {
    const isHead = headsOf(page);
    if (isHead === undefined || !page.lines.some(isHead)) return page;
    changed = true;
    return { ...page, lines: page.lines.map((line) => (isHead(line) ? { ...line, headerFooter: true } : line)) };
  });
  return changed ? result : pages;
}

const cache = new WeakMap<readonly PageText[], readonly PageText[]>();
const rowCache = new WeakMap<readonly PageText[], readonly PageText[]>();

/**
 * Running heads that change with the section ("1.2. Lengths and Gaps") repeat on a handful of pages only, so the sample of
 * pages that the reader looks at to find the running heads and footers of a document may miss them. They are found again here
 * from every page: a line in the top band that holds words and whose text, digits blurred, stands on at least three pages is a
 * running line (a line that starts with a label, "3. x = 2", is an answer or an item, never a head); so is a line of the top band
 * that stands on the row of a running line (the title of the chapter next to the page number: "14   Prerequisites"). The pages
 * that carry such lines come back as copies with `headerFooter` set on them; pages that need no change are the same objects, and
 * a list without any change is returned as it is. `keep` names lines that are never taken for a head (the heading that ends a
 * set of exercises, the caption of a table that goes on, the marker of a section in an answer key): they may stand at the top of
 * a page and repeat on the pages after it.
 */
export function withRunningHeads(pages: readonly PageText[], keep?: (text: string) => boolean): readonly PageText[] {
  const known = keep === undefined ? cache.get(pages) : undefined;
  if (known) return known;
  const where = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.headerFooter === true || line.rect.bottom > BAND || keep?.(line.text) === true) continue;
      const key = headerKey(line.text);
      if (!candidate(line, key)) continue;
      const set = where.get(key);
      if (set) set.add(page.page);
      else where.set(key, new Set([page.page]));
    }
  }
  const keys = new Set<string>();
  for (const [key, set] of where) if (set.size >= MIN_PAGES) keys.add(key);
  const repeats = (line: TextLine): boolean => keys.has(headerKey(line.text));
  const out = flagged(pages, (page) => {
    const isKept = (line: TextLine): boolean => line.headerFooter === true || line.rect.bottom > BAND || keep?.(line.text) === true;
    const anchors = page.lines.filter((line) => line.rect.bottom <= BAND && (line.headerFooter === true || (!isKept(line) && repeats(line))));
    if (keys.size === 0 && anchors.length === 0) return undefined;
    return (line) => !isKept(line) && (repeats(line) || (!startsLikeItem(line.text) && /\p{L}{3}/u.test(line.text) && anchors.some((anchor) => anchor !== line && sameRow(anchor, line))));
  });
  if (keep === undefined) cache.set(pages, out);
  return out;
}

/**
 * Only the second kind of running lines: the lines of the top band that stand on the row of a page number or another running line
 * the reader flagged ("14   Prerequisites"). The answers of a key repeat short lines too, so they are not read for repeats.
 */
export function withHeadRows(pages: readonly PageText[], keep?: (text: string) => boolean): readonly PageText[] {
  const known = keep === undefined ? rowCache.get(pages) : undefined;
  if (known) return known;
  const out = flagged(pages, (page) => {
    const anchors = page.lines.filter((line) => line.headerFooter === true && line.rect.bottom <= BAND);
    if (anchors.length === 0) return undefined;
    return (line) => line.headerFooter !== true && line.rect.bottom <= BAND && keep?.(line.text) !== true && !startsLikeItem(line.text) && /\p{L}{3}/u.test(line.text) && anchors.some((anchor) => sameRow(anchor, line));
  });
  if (keep === undefined) rowCache.set(pages, out);
  return out;
}
