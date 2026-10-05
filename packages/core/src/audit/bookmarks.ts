import type { OutlineEntry, PageText } from '../model/types.js';
import { chaptersHoldingItems, findLabelledItems } from './labelled.js';
import { DEFAULT_BOOK_PATTERNS, type BookPatterns } from './scan.js';

/**
 * The bookmarks of a PDF as the sections of a book whose headings carry no numbers. The bookmarks have a title, a page and a
 * depth; the numbers are counted: at the depth of the chapters every entry is the next chapter (they count through the whole
 * book, also when numbered parts stand above them), and at the depth below every entry is the next section of the chapter it is in
 * (the count starts again in each chapter). Which depth holds the chapters is decided by the numbers the book prints with its
 * exercises ("1.2.3 Aufgabe:" belongs to section 1.2): the depth whose counted sections show most of those numbers wins; without
 * such exercises, the depth below the parts (when the top level is much shorter than the one under it), else the top level.
 */

export interface NumberedBookmarks {
  entries: OutlineEntry[];
  /** The bookmarks are one level of numbered chapters, and the chapters are the sections (their exercises are numbered "chapter.exercise"). */
  flat?: boolean;
  /** The depth that was taken for the chapters. */
  chapterDepth: number;
  /** How many of the numbers printed with exercises fit a counted section, and how many numbers there are. */
  fit: { found: number; of: number };
}

const clean = (title: string): string => title.replace(/\s+/g, ' ').trim();

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';

/** The pairs "chapter.section" that counting at this depth gives. */
function counted(bookmarks: readonly OutlineEntry[], chapterDepth: number): Set<string> {
  const pairs = new Set<string>();
  let chapter = 0;
  let section = 0;
  for (const entry of bookmarks) {
    if (entry.depth === chapterDepth) {
      chapter += 1;
      section = 0;
    } else if (entry.depth === chapterDepth + 1 && chapter > 0) {
      section += 1;
      pairs.add(`${chapter}.${section}`);
    }
  }
  return pairs;
}

/** The top of each heading on its page, where the heading line can be found. */
function placeHeadings(entries: OutlineEntry[], pages: readonly PageText[], band = 0.105): void {
  for (const entry of entries) {
    const lines = pages[entry.page]?.lines ?? [];
    const numbered = entry.label !== undefined && /^\d/.test(entry.label) ? entry.label : undefined;
    const head = entry.title.slice(0, 10);
    const hit = lines.find((line) => {
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (line.rect.top < band) return false;
      if (numbered && text.startsWith(`${numbered} `) && text.includes(head)) return true;
      return line.fontSize >= 14 && text.includes(entry.title.slice(0, 12));
    });
    if (hit) entry.top = Math.round(Math.max(0, Math.min(1, hit.rect.top - 0.004)) * 10000) / 10000;
  }
}

/**
 * One level of bookmarks that are the chapters of a book whose exercises print the chapter first ("Aufgabe 1.3 (Title)."): the
 * chapters are the sections. The titles print their number ("1 Einführung ..."), which is taken when the numbers rise; else the
 * bookmarks are counted. Undefined when the printed exercises do not name these chapters.
 */
function flatChapters(bookmarks: readonly OutlineEntry[], pages: readonly PageText[], patterns: Partial<BookPatterns>): NumberedBookmarks | undefined {
  const reads = bookmarks.map((entry) => /^(\d{1,3})\.?\s+(\S.*)$/.exec(clean(entry.title)));
  const rising = reads.every((found, at) => found !== null && (at === 0 || Number(found[1]) > Number((reads[at - 1] as RegExpExecArray)[1])));
  const numbers = bookmarks.map((_entry, at) => (rising ? String(Number((reads[at] as RegExpExecArray)[1])) : String(at + 1)));
  const words: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...patterns };
  if (!chaptersHoldingItems(numbers, pages, words)) return undefined;
  const entries: OutlineEntry[] = bookmarks.map((bookmark, at) => ({
    title: rising ? ((reads[at] as RegExpExecArray)[2] as string) : clean(bookmark.title),
    page: bookmark.page,
    depth: 0,
    id: numbers[at] as string,
    label: numbers[at] as string,
  }));
  // (The chapter heading of an exercise booklet stands right under the running head.)
  placeHeadings(entries, pages, 0.05);
  const printed = new Set(findLabelledItems(pages, words).map((hit) => hit.label.split('.')[0] as string));
  return { entries, flat: true, chapterDepth: bookmarks[0]?.depth ?? 0, fit: { found: numbers.filter((number) => printed.has(number)).length, of: printed.size } };
}

export function numberBookmarks(bookmarks: readonly OutlineEntry[], pages: readonly PageText[], patterns: Partial<BookPatterns> = {}): NumberedBookmarks | undefined {
  if (bookmarks.length < 2) return undefined;
  const depths = [...new Set(bookmarks.map((entry) => entry.depth))].sort((a, b) => a - b);
  if (depths.length === 1) return flatChapters(bookmarks, pages, patterns);
  const printed = new Set(findLabelledItems(pages, { ...DEFAULT_BOOK_PATTERNS, ...patterns }).map((hit) => hit.label.split('.').slice(0, 2).join('.')));
  let chapterDepth = depths[0] as number;
  let best = -1;
  for (const depth of depths) {
    if (!depths.includes(depth + 1)) continue;
    const fit = [...counted(bookmarks, depth)].filter((pair) => printed.has(pair)).length;
    if (fit > best) {
      best = fit;
      chapterDepth = depth;
    }
  }
  if (best <= 0) {
    // Nothing printed to calibrate by: below the numbered parts when there are few of them, else the top level.
    const top = bookmarks.filter((entry) => entry.depth === depths[0]).length;
    const below = depths.length > 1 ? bookmarks.filter((entry) => entry.depth === depths[1]).length : 0;
    chapterDepth = depths.length > 2 && top * 3 <= below ? (depths[1] as number) : (depths[0] as number);
    if (!depths.includes(chapterDepth + 1)) return undefined;
  }
  const entries: OutlineEntry[] = [];
  const used = new Set<string>();
  const unique = (id: string): string => {
    let candidate = id;
    for (let k = 2; used.has(candidate); k += 1) candidate = `${id}-${k}`;
    used.add(candidate);
    return candidate;
  };
  let chapter = 0;
  let section = 0;
  let sub = 0;
  for (const bookmark of bookmarks) {
    const title = clean(bookmark.title);
    // The depths are the ones of a derived outline: a chapter (and a part above it) is 0, a section 1, what is under a section 2.
    if (bookmark.depth < chapterDepth) {
      entries.push({ title, page: bookmark.page, depth: 0, id: unique(slug(title)) });
    } else if (bookmark.depth === chapterDepth) {
      chapter += 1;
      section = 0;
      sub = 0;
      entries.push({ title, page: bookmark.page, depth: 0, id: unique(`c${chapter}`), label: `Chapter ${chapter}` });
    } else if (bookmark.depth === chapterDepth + 1 && chapter > 0) {
      section += 1;
      sub = 0;
      entries.push({ title, page: bookmark.page, depth: 1, id: unique(`${chapter}.${section}`), label: `${chapter}.${section}` });
    } else if (chapter > 0 && section > 0) {
      sub += 1;
      entries.push({ title, page: bookmark.page, depth: 2, id: unique(`${chapter}.${section}.${sub}`), label: `${chapter}.${section}.${sub}` });
    } else entries.push({ title, page: bookmark.page, depth: 0, id: unique(slug(title)) });
  }
  placeHeadings(entries, pages);
  const pairs = counted(bookmarks, chapterDepth);
  return { entries, chapterDepth, fit: { found: [...printed].filter((pair) => pairs.has(pair)).length, of: printed.size } };
}
