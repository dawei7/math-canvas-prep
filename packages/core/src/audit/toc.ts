import type { PageText, TextLine } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import type { PageNumbering } from './pagenumbers.js';

/**
 * The printed table of contents of a book, and the lists of sections printed on chapter openers. Both are read from
 * the text layer, which is rarely clean: leaders of dots come out as one long run of dots (or fewer, when the title is
 * long), page numbers stick to the dots, and lines that overlap on the page are merged by the text extraction into
 * one line that holds several entries, a chapter heading, even the page number of one entry and the label of the next
 * ("....3439.5 Build ..."). The parser splits such lines again: it reads one entry after the other, and when a page
 * number and the next label are glued it picks the split that fits the sequence of labels.
 */

export type TocKind = 'chapter' | 'section' | 'other';

/** What a line of the contents can be: a chapter, a section, a part of a section ("1.1.4 Exercises") or something unnumbered. */
export type TocEntryKind = TocKind | 'subsection';

export interface TocEntry {
  kind: TocEntryKind;
  /** "Chapter 6", "6.4"; absent for an entry without a printed number. */
  label?: string;
  /** The number part of the label: "6", "6.4", "6.4.2". */
  number?: string;
  /** For a part of a section: the label of the section ("6.4"). */
  section?: string;
  /** For a chapter: its line starts with a bare number ("6 More Topics"), not with a word such as "Chapter". */
  plain?: boolean;
  /** The title as printed: leaders and numbering removed, not yet normalised. */
  title: string;
  printedPage?: number;
  /** Zero-based page the printed number maps to. */
  page?: number;
  /** `toc`: the table of contents proper; `opener`: the list of sections printed on a chapter opener. */
  source: 'toc' | 'opener';
  /** The page the entry was read from, and the text of the line. */
  readOn: number;
  line: string;
  /** The line held several entries (the text extraction merged them). */
  merged: boolean;
}

export interface TocWords {
  /** Words that open a chapter heading ("Chapter 3"). */
  chapter: string[];
}

export const DEFAULT_CHAPTER_WORDS = ['chapter', 'part', 'unit', 'kapitel', 'teil', 'chapitre', 'capítulo', 'capitulo', 'capitolo', 'unidad'];

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface TocPiece {
  kind: TocEntryKind;
  label?: string;
  number?: string;
  section?: string;
  plain?: boolean;
  title: string;
  printedPage?: number;
}

/** The label that is expected after `last`, to choose between ways to split glued digits. */
function plausibleNext(last: string | undefined, candidate: string): boolean {
  const next = /^(\d{1,2})\.(\d{1,2})$/.exec(candidate);
  if (!next) return false;
  const major = Number(next[1]);
  const minor = Number(next[2]);
  if (last === undefined) return minor <= 1;
  const previous = /^(\d{1,2})\.(\d{1,2})$/.exec(last);
  if (!previous) return false;
  const lastMajor = Number(previous[1]);
  const lastMinor = Number(previous[2]);
  return (major === lastMajor && minor === lastMinor + 1) || (major === lastMajor + 1 && minor <= 1);
}

export interface ParseState {
  /** The label of the last section read before this line, in reading order. */
  lastSection?: string;
}

/**
 * Reads the entries out of one line of a table of contents. `chapterWords` are the words that open a chapter heading.
 * Returns the pieces in the order they are printed; `state.lastSection` is updated.
 */
export function parseTocLine(text: string, state: ParseState = {}, chapterWords: readonly string[] = DEFAULT_CHAPTER_WORDS): TocPiece[] {
  const chapterHead = new RegExp(`^(${chapterWords.map(escapeWord).join('|')})\\s+(\\d+|[IVXLC]+)\\b\\s*[:.\\-–—]?\\s*`, 'iu');
  const sectionHead = /^(\d{1,2}\.\d{1,2})(?:\s+|(?=\p{L}))/u;
  const partHead = /^(\d{1,2}\.\d{1,2}\.\d{1,3})\.?\s+(?=\S)/u;
  const plainChapterHead = /^(\d{1,2})\s+(?=\p{Lu})/u;
  const gluedLabel = /(?<=[\p{L})\]])(\d{1,2}\.\d{1,2})(?=\s+\p{Lu})/u;
  const strongLeader = /(?:\.{3,}|(?:\.\s+){3,}\.?)\s*(\d+)/u;
  const weakLeader = /\.{1,2}\s*(\d{1,4})\s*$/u;
  const spaceLeader = /\s{3,}(\d{1,4})\s*$/u;
  const pieces: TocPiece[] = [];
  let position = 0;
  const length = text.length;

  /** Where the page number after a leader ends and what the digits are: handles "3439.5 Build". */
  const readPage = (digits: string, from: number): { page?: number; next: number } => {
    const tail = text.slice(from);
    const glued = /^(\.\d{1,2})(?=\s+\p{L})/u.exec(tail);
    if (glued && digits.length >= 2) {
      const options = digits.length >= 3 ? [1, 2] : [1];
      let chosen: number | undefined;
      for (const k of options) {
        if (plausibleNext(state.lastSection, `${digits.slice(-k)}${glued[1] as string}`)) {
          chosen = k;
          break;
        }
      }
      // Without a label that fits the sequence the shorter label wins: page numbers are longer than chapter numbers.
      const k = chosen ?? 1;
      const page = Number(digits.slice(0, -k));
      return Number.isFinite(page) && digits.length > k ? { page, next: from - k } : { next: from };
    }
    return { page: Number(digits), next: from };
  };

  while (position < length) {
    while (position < length && /\s/.test(text.charAt(position))) position += 1;
    if (position >= length) break;
    const here = text.slice(position);
    const chapter = chapterHead.exec(here);
    if (chapter) {
      const start = position + chapter[0].length;
      const remainder = text.slice(start);
      const leader = strongLeader.exec(remainder);
      const glue = gluedLabel.exec(remainder);
      const leaderAt = leader ? leader.index : Infinity;
      const glueAt = glue ? glue.index : Infinity;
      let titleEnd = Math.min(leaderAt, glueAt, remainder.length);
      let printedPage: number | undefined;
      let next = start + titleEnd;
      if (leaderAt <= glueAt && leader) {
        const read = readPage(leader[1] as string, start + leader.index + leader[0].length);
        printedPage = read.page;
        next = read.next;
      } else if (titleEnd === remainder.length) {
        const trailing = weakLeader.exec(remainder) ?? spaceLeader.exec(remainder);
        if (trailing) {
          titleEnd = trailing.index;
          printedPage = Number(trailing[1]);
        }
      }
      const title = remainder.slice(0, titleEnd).replace(/[\s.]+$/, '').trim();
      const word = (chapter[1] as string).replace(/^./, (c) => c.toUpperCase());
      const number = chapter[2] as string;
      pieces.push({ kind: 'chapter', label: `${word} ${number}`, number, title, ...(printedPage !== undefined ? { printedPage } : {}) });
      position = Math.max(next, position + 1);
      continue;
    }
    // A part of a section ("1.1.4 Exercises . . . 14"): its number has three parts, the first two are the section's.
    const part = partHead.exec(here);
    if (part) {
      const start = position + part[0].length;
      const remainder = text.slice(start);
      const leader = strongLeader.exec(remainder);
      let titleEnd: number;
      let page: number | undefined;
      let next: number;
      if (leader) {
        titleEnd = leader.index;
        const read = readPage(leader[1] as string, start + leader.index + leader[0].length);
        page = read.page;
        next = read.next;
      } else {
        const weak = weakLeader.exec(remainder) ?? spaceLeader.exec(remainder);
        if (!weak) break;
        titleEnd = weak.index;
        page = Number(weak[1]);
        next = length;
      }
      const number = part[1] as string;
      const title = remainder.slice(0, titleEnd).replace(/[\s.]+$/, '').trim();
      pieces.push({ kind: 'subsection', label: number, number, section: number.split('.').slice(0, 2).join('.'), title, ...(page !== undefined ? { printedPage: page } : {}) });
      position = Math.max(next, position + 1);
      continue;
    }
    const section = sectionHead.exec(here);
    if (section) {
      const start = position + section[0].length;
      const remainder = text.slice(start);
      const leader = strongLeader.exec(remainder);
      let titleEnd: number;
      let page: number | undefined;
      let next: number;
      if (leader) {
        titleEnd = leader.index;
        const read = readPage(leader[1] as string, start + leader.index + leader[0].length);
        page = read.page;
        next = read.next;
      } else {
        const weak = weakLeader.exec(remainder) ?? spaceLeader.exec(remainder);
        if (!weak) break;
        titleEnd = weak.index;
        page = Number(weak[1]);
        next = length;
      }
      const label = section[1] as string;
      const title = remainder.slice(0, titleEnd).replace(/[\s.]+$/, '').trim();
      state.lastSection = label;
      pieces.push({ kind: 'section', label, number: label, title, ...(page !== undefined ? { printedPage: page } : {}) });
      position = Math.max(next, position + 1);
      continue;
    }
    // A chapter that starts with its bare number ("6 More Topics . . . 129", or only white space before the page number).
    const plain = plainChapterHead.exec(here);
    if (plain) {
      const start = position + plain[0].length;
      const remainder = text.slice(start);
      const leader = strongLeader.exec(remainder);
      let titleEnd: number | undefined;
      let page: number | undefined;
      if (leader) {
        titleEnd = leader.index;
        page = readPage(leader[1] as string, start + leader.index + leader[0].length).page;
      } else {
        const spaced = spaceLeader.exec(remainder);
        if (spaced) {
          titleEnd = spaced.index;
          page = Number(spaced[1]);
        }
      }
      if (titleEnd !== undefined) {
        const title = remainder.slice(0, titleEnd).replace(/[\s.]+$/, '').trim();
        if (/\p{L}/u.test(title)) {
          pieces.push({ kind: 'chapter', label: `Chapter ${plain[1] as string}`, number: plain[1] as string, plain: true, title, ...(page !== undefined ? { printedPage: page } : {}) });
          break;
        }
      }
    }
    // An entry without a number ("Answers.......438").
    const leader = strongLeader.exec(here);
    if (leader && leader.index >= 2 && /\p{L}/u.test(here.slice(0, leader.index))) {
      const read = readPage(leader[1] as string, position + leader.index + leader[0].length);
      const title = here.slice(0, leader.index).replace(/[\s.]+$/, '').trim();
      pieces.push({ kind: 'other', title, ...(read.page !== undefined ? { printedPage: read.page } : {}) });
      position = Math.max(read.next, position + 1);
      continue;
    }
    // An entry without a number whose leader is only white space before the page number ("Appendix A: Answers   152").
    const spaced = spaceLeader.exec(here);
    if (spaced && spaced.index >= 3 && /\p{L}/u.test(here.slice(0, spaced.index))) {
      pieces.push({ kind: 'other', title: here.slice(0, spaced.index).replace(/[\s.]+$/, '').trim(), printedPage: Number(spaced[1]) });
      break;
    }
    break;
  }
  return pieces;
}

const hasLeader = (text: string): boolean => /(?:\.{3,}|(?:\.\s+){3,}\.?)\s*\d+/.test(text);

const isFooter = (line: TextLine): boolean => line.headerFooter === true && line.rect.top > 0.85 && /^\d{1,4}$/.test(line.text.trim());

export interface ParseTocOptions {
  chapterWords?: readonly string[];
  /** The number that a line of the contents lists an exercise under ("Aufgabe 1.3 (Title)" gives "1.3"), or undefined for another line. */
  itemLabel?: (title: string) => string | undefined;
}

export interface TocResult {
  entries: TocEntry[];
  /** Pages that hold the table of contents proper. */
  tocPages: number[];
  /** Pages that are chapter openers with a list of sections. */
  openerPages: number[];
  /** Entries that were left out because their line was too garbled to read. */
  skipped: { readOn: number; text: string }[];
}

/**
 * Finds the pages with lines that end in a leader and a page number and reads their entries. Pages with a chapter
 * heading in large type are chapter openers (their list is read as a second source); the others are the table of
 * contents. Entries are in reading order.
 */
export function parseToc(pages: readonly PageText[], numbering: PageNumbering, options: ParseTocOptions = {}): TocResult {
  const chapterWords = options.chapterWords ?? DEFAULT_CHAPTER_WORDS;
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const chapterHead = new RegExp(`^(${chapterWords.map(escapeWord).join('|')})\\s+(\\d+|[IVXLC]+)\\b`, 'iu');
  const entries: TocEntry[] = [];
  const tocPages: number[] = [];
  const openerPages: number[] = [];
  const skipped: TocResult['skipped'] = [];
  // The table of contents lies in the front of the book; later pages with leaders are lists on chapter openers.
  const state: ParseState = {};
  const openerState = new Map<number, ParseState>();
  for (const page of pages) {
    // A running head with its page number looks like an entry with a leader of white space: lines that the reader flagged as running are no entries.
    const plainLines = page.lines.filter((line) => !isFooter(line) && line.headerFooter !== true);
    const leaderLines = plainLines.filter((line) => hasLeader(line.text) || (/^\d{1,2}\.\d{1,2}\s/.test(line.text) && /(?:\.\s*\d{1,4}|\s{3,}\d{1,4})\s*$/.test(line.text)));
    const heading = plainLines.find((line) => body > 0 && line.fontSize >= body * 1.25 && line.rect.top < 0.4 && chapterHead.test(line.text));
    // The page after a page of the contents goes on with it, however few entries it has left (two sections and the appendices).
    const goesOn = !heading && tocPages.length > 0 && page.page === (tocPages[tocPages.length - 1] as number) + 1;
    if (leaderLines.length < (heading ? 1 : goesOn ? 1 : 3)) continue;
    const source: 'toc' | 'opener' = heading ? 'opener' : 'toc';
    // A table of contents lies in the front of a book; lines with leaders far behind are an index or a table.
    if (source === 'toc' && tocPages.length > 0 && page.page > (tocPages[tocPages.length - 1] as number) + 3) continue;
    if (source === 'toc') tocPages.push(page.page);
    else openerPages.push(page.page);
    const pageState = source === 'toc' ? state : (openerState.get(page.page) ?? {});
    // An entry whose title and page number are set apart by white space comes out of the text layer as two lines on one row.
    const lines = source === 'toc' ? joinPageNumberRows(plainLines) : plainLines;
    for (const line of lines) {
      if (line === heading || (source === 'opener' && !hasLeader(line.text) && !/\s\d{1,4}\s*$/.test(line.text))) continue;
      if (source === 'toc' && line.fontSize > body * 1.25 && !hasLeader(line.text)) continue;
      const pieces = parseTocLine(line.text, pageState, chapterWords);
      const merged = pieces.length > 1;
      for (const piece of pieces) {
        // Text boxes that overlap are sometimes interleaved by the extraction: a title that holds another label is garbage.
        if (/(?<![\d.])\d{1,2}\.\d{1,2}\s+\p{L}/u.test(piece.title)) {
          skipped.push({ readOn: page.page, text: piece.title.slice(0, 60) });
          continue;
        }
        const entry: TocEntry = {
          kind: piece.kind,
          ...(piece.label !== undefined ? { label: piece.label } : {}),
          ...(piece.number !== undefined ? { number: piece.number } : {}),
          ...(piece.section !== undefined ? { section: piece.section } : {}),
          ...(piece.plain === true ? { plain: true } : {}),
          title: piece.title,
          ...(piece.printedPage !== undefined ? { printedPage: piece.printedPage } : {}),
          source,
          readOn: page.page,
          line: line.text,
          merged,
        };
        if (piece.printedPage !== undefined) {
          const mapped = numbering.pageOf(piece.printedPage);
          if (mapped !== undefined) entry.page = mapped;
        }
        entries.push(entry);
      }
    }
    if (heading) {
      const found = chapterHead.exec(heading.text);
      if (found) {
        const rest = heading.text.slice(found[0].length).replace(/^\s*[:.\-–—]?\s*/, '').trim();
        const word = (found[1] as string).replace(/^./, (c) => c.toUpperCase());
        entries.push({
          kind: 'chapter',
          label: `${word} ${found[2] as string}`,
          number: found[2] as string,
          title: rest,
          page: page.page,
          source: 'opener',
          readOn: page.page,
          line: heading.text,
          merged: false,
        });
      }
    }
  }
  // A chapter line that starts with a bare number is believed only when a section of that chapter follows it ("6 Additional
  // Topics" above "6.1 ..."), or an exercise of it ("Aufgabe 6.1 (Title)"), and not when the contents name their chapters with a
  // word ("Chapter 6") anyway.
  const wordChapters = entries.some((entry) => entry.kind === 'chapter' && entry.plain !== true && entry.source === 'toc');
  const listed = (entry: TocEntry): string | undefined => (entry.kind === 'section' ? entry.number : entry.kind === 'other' ? options.itemLabel?.(entry.title) : undefined);
  const kept = entries.filter((entry, at) => {
    if (entry.plain !== true) return true;
    if (wordChapters) return false;
    const next = entries.slice(at + 1).find((other) => other.source === entry.source && listed(other) !== undefined);
    return next !== undefined && (listed(next) ?? '').split('.')[0] === entry.number;
  });
  return { entries: kept, tocPages, openerPages, skipped };
}

/**
 * A line of text and, to its right on the same row, a line that holds only a page number are one entry of a table of
 * contents whose leader is white space ("Appendix A: Answers   152"): the text layer cuts a line at a wide gap. They are put
 * together with three spaces between them, which the text layer itself never makes.
 */
export function joinPageNumberRows(lines: readonly TextLine[]): TextLine[] {
  const result: TextLine[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as TextLine;
    const next = lines[at + 1];
    if (next && line.chars >= 3 && !/^\d{1,4}$/.test(line.text.trim()) && /^\d{1,4}$/.test(next.text.trim()) && next.rect.left >= line.rect.right) {
      const overlap = Math.min(line.rect.bottom, next.rect.bottom) - Math.max(line.rect.top, next.rect.top);
      if (overlap >= 0.5 * Math.min(line.rect.bottom - line.rect.top, next.rect.bottom - next.rect.top)) {
        result.push({
          ...line,
          text: `${line.text.trim()}   ${next.text.trim()}`,
          chars: line.chars + next.chars,
          rect: { left: line.rect.left, right: next.rect.right, top: Math.min(line.rect.top, next.rect.top), bottom: Math.max(line.rect.bottom, next.rect.bottom) },
        });
        at += 1;
        continue;
      }
    }
    result.push(line);
  }
  return result;
}
