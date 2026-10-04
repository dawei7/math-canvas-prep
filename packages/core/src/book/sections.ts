import type { OutlineEntry, PageText } from '../model/types.js';
import { deriveOutline } from '../propose/headings.js';
import { readPageNumbers, type PageNumbering } from './pagenumbers.js';
import { DEFAULT_BOOK_PATTERNS, scanHeadings, type BookPatterns, type HeadingHit } from './scan.js';
import { chooseTitle, normalizeTitle, stripChapterPrefix, titleKey, type TitleCandidate } from './titles.js';
import { parseToc, type TocKind } from './toc.js';

/**
 * The sections of a book (chapters and the sections inside them) found from what the book prints about them: its
 * table of contents, the lists on its chapter openers and the headings on the pages (lesson headings, practice
 * headings, chapter openers). The three sources are cross-checked; every entry says what it was read from, where the
 * sources disagree, and how sure the tool is. The result is a proposal to look at, not a fact.
 */

export interface PlaceOnPage {
  page: number;
  /** Fraction of the page height from the top. */
  top: number;
}

/** Where the practice set of a section is printed. */
export interface PracticePlace extends PlaceOnPage {
  /** Index of the heading line in the page's lines. */
  index: number;
  text: string;
  /** Where the set ends: the start of whatever the book prints next (exclusive). */
  end: PlaceOnPage & { why: string };
}

export interface BookEntry extends OutlineEntry {
  /** Always set: "c0" for a chapter, the printed label for a section ("0.1"), `s1`, `s2` ... without labels. */
  id: string;
  kind: TocKind;
  confidence: number;
  evidence: string[];
  /** Where the lesson of a section starts (its label line or heading). */
  lesson?: PlaceOnPage;
  /** Where the practice set is printed, when a practice heading was found. */
  practice?: PracticePlace;
  /** Spellings of the title that differ from the one chosen, and where they were read. */
  differences: TitleCandidate[];
}

export interface BookStructure {
  entries: BookEntry[];
  chapters: number;
  sections: number;
  /** Printed page number minus page index, when the book's footers agree on one. */
  numbering: { offset?: number; numbered: number; agreeing: number };
  toc: { pages: number[]; openers: number[]; entries: number };
  /** Where the answer key starts, when one was found. */
  answerKey?: PlaceOnPage & { evidence: string };
  /** Things to look at: gaps, sections without a practice set, disagreements. */
  notes: string[];
  bodyFontSize: number;
}

export interface DeriveSectionsOptions {
  patterns?: Partial<BookPatterns>;
  glyphRepairs?: Record<string, string>;
  /** Also list the unnumbered entries of the table of contents (Answers, Index) as entries of depth 0 (default true). */
  includeBackMatter?: boolean;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

function compareLabels(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const before = (a: PlaceOnPage, b: PlaceOnPage): boolean => a.page < b.page || (a.page === b.page && a.top < b.top);

const round = (value: number): number => Math.round(value * 10000) / 10000;

/** The first hit that lies at or after `cursor` (the previous section's start), else the first. */
function pick(hits: readonly HeadingHit[], cursor: PlaceOnPage): HeadingHit | undefined {
  return hits.find((hit) => !before(hit, cursor)) ?? hits[0];
}

function romanOrNumber(text: string): number {
  const n = Number(text);
  if (Number.isFinite(n)) return n;
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  const upper = text.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const value = values[upper.charAt(i)] ?? 0;
    const next = values[upper.charAt(i + 1)] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

export function deriveSections(pages: readonly PageText[], options: DeriveSectionsOptions = {}): BookStructure {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const notes: string[] = [];
  const numbering: PageNumbering = readPageNumbers(pages);
  const toc = parseToc(pages, numbering, { chapterWords: patterns.chapterWords });
  const scan = scanHeadings(pages, patterns);
  const titleOptions = options.glyphRepairs !== undefined ? { glyphRepairs: options.glyphRepairs } : {};
  const pageCount = pages.length;
  const entries: BookEntry[] = [];

  // --- the answer key ----------------------------------------------------------------------------------------------
  let answerKey: BookStructure['answerKey'];
  const firstAnswers = [...scan.answerChapters].sort((a, b) => a.page - b.page || a.top - b.top)[0];
  if (firstAnswers) {
    answerKey = { page: firstAnswers.page, top: firstAnswers.top, evidence: `the heading "${firstAnswers.text}" on page ${firstAnswers.page} opens the answers of a chapter` };
  } else {
    const answerWord = new RegExp(`^(?:${patterns.answerWords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
    const listed = toc.entries.find((entry) => entry.kind === 'other' && entry.page !== undefined && answerWord.test(entry.title));
    if (listed && listed.page !== undefined) answerKey = { page: listed.page, top: 0, evidence: `the table of contents lists "${listed.title}" on printed page ${listed.printedPage ?? '?'}` };
  }

  // --- labels --------------------------------------------------------------------------------------------------------
  const sectionLabels = new Set<string>();
  for (const entry of toc.entries) if (entry.kind === 'section' && entry.number !== undefined) sectionLabels.add(entry.number);
  for (const hit of [...scan.lessons, ...scan.practices]) sectionLabels.add(hit.number);
  // Hits inside the answer key are markers, not lessons.
  const lessonHits = scan.lessons.filter((hit) => answerKey === undefined || hit.page < answerKey.page);
  const practiceHits = scan.practices.filter((hit) => answerKey === undefined || hit.page < answerKey.page);
  const labels = [...sectionLabels].sort(compareLabels);
  const chapterNumbers = new Map<string, number>();
  const noteChapter = (text: string): void => {
    if (!chapterNumbers.has(text)) chapterNumbers.set(text, romanOrNumber(text));
  };
  for (const entry of toc.entries) if (entry.kind === 'chapter' && entry.number !== undefined) noteChapter(entry.number);
  for (const hit of scan.chapters) noteChapter(hit.number);
  for (const label of labels) noteChapter((label.split('.')[0] as string).replace(/^0+(?=\d)/, ''));

  // --- sections ------------------------------------------------------------------------------------------------------
  let cursor: PlaceOnPage = { page: 0, top: 0 };
  const sectionEntries = new Map<string, BookEntry>();
  const lastOfChapter = new Map<string, string>();
  for (const label of labels) {
    const tocEntries = toc.entries.filter((entry) => entry.kind === 'section' && entry.number === label);
    const mainToc = tocEntries.find((entry) => entry.source === 'toc');
    const opener = tocEntries.find((entry) => entry.source === 'opener');
    const lesson = pick(lessonHits.filter((hit) => hit.number === label), cursor);
    const practice = pick(practiceHits.filter((hit) => hit.number === label), lesson ?? cursor);
    const evidence: string[] = [];
    const candidates: TitleCandidate[] = [];
    const repairs: string[] = [];
    const addCandidate = (source: string, raw: string | undefined): void => {
      if (raw === undefined || raw.trim().length === 0) return;
      const cleaned = normalizeTitle(raw, titleOptions);
      if (cleaned.title.length === 0) return;
      candidates.push({ source, text: cleaned.title });
      for (const repair of cleaned.repairs) if (repair.startsWith('the unmapped') || repair.startsWith('unmapped')) repairs.push(`${source}: ${repair}`);
    };
    addCandidate('table of contents', mainToc?.title);
    addCandidate('chapter opener', opener?.title);
    addCandidate('practice heading', practice?.title);
    addCandidate('lesson heading', lesson ? stripChapterPrefix(lesson.title) : undefined);
    const choice = chooseTitle(candidates);
    if (!choice) continue;

    let page: number | undefined;
    let top: number | undefined;
    let confidence = 0.35;
    if (lesson) {
      page = lesson.page;
      top = round(lesson.top);
      confidence += 0.3;
      evidence.push(`lesson heading: ${lesson.evidence[0] as string} (page ${lesson.page}, ${round(lesson.top)} from the top)`);
    }
    const tocPage = mainToc?.page ?? opener?.page;
    for (const entry of [mainToc, opener]) {
      if (!entry) continue;
      const what = entry.source === 'toc' ? 'printed table of contents' : 'list on the chapter opener';
      const where = entry.printedPage !== undefined ? `printed page ${entry.printedPage}${entry.page !== undefined ? ` = page ${entry.page} of the file` : ''}` : 'no page number';
      evidence.push(`${what}: "${entry.title}", ${where}${entry.merged ? ' (read out of a merged line)' : ''}`);
      if (entry.page !== undefined && page !== undefined) {
        if (entry.page === page) confidence += 0.15;
        else {
          confidence -= 0.2;
          notes.push(`${label}: the ${what} says page ${entry.page}, the lesson heading is on page ${page}; the heading was used`);
        }
      }
    }
    if (page === undefined) {
      if (tocPage !== undefined) {
        page = tocPage;
        evidence.push(`no lesson heading was found: the page comes from the table of contents (page ${tocPage})`);
        notes.push(`${label}: no lesson heading found; the page ${tocPage} comes from the table of contents`);
      } else if (practice) {
        page = practice.page;
        top = round(practice.top);
        confidence -= 0.1;
        evidence.push('only the practice heading was found: the section starts where its practice set starts');
        notes.push(`${label}: only a practice heading was found; the section is placed at its practice set`);
      }
    }
    if (page === undefined) continue;
    if (practice) {
      confidence += 0.1;
      evidence.push(`practice heading: "${practice.text}" (page ${practice.page}, ${round(practice.top)} from the top)`);
    } else notes.push(`${label}: no practice heading found, so no exercises can be proposed for it`);
    evidence.push(...choice.evidence, ...repairs);
    if (!mainToc && !opener && toc.entries.some((entry) => entry.kind === 'section')) {
      notes.push(`${label}: found on the pages but not in the table of contents (or the line could not be read)`);
      confidence -= 0.05;
    }
    if (before({ page, top: top ?? 0 }, cursor)) {
      notes.push(`${label}: starts before the previous section (page ${page})`);
      confidence -= 0.2;
    }
    const entry: BookEntry = {
      title: choice.title.slice(0, 200),
      page,
      depth: 1,
      id: label,
      label,
      ...(top !== undefined ? { top } : {}),
      kind: 'section',
      confidence: Math.max(0.2, Math.min(0.99, Math.round(confidence * 100) / 100)),
      evidence,
      differences: choice.differences,
    };
    if (lesson) entry.lesson = { page: lesson.page, top: round(lesson.top) };
    if (practice) entry.practice = { page: practice.page, top: round(practice.top), index: practice.index, text: practice.text, end: { page: pageCount, top: 0, why: 'the end of the book' } };
    sectionEntries.set(label, entry);
    cursor = { page, top: top ?? 0 };
    lastOfChapter.set((label.split('.')[0] as string), label);
  }

  // --- chapters ------------------------------------------------------------------------------------------------------
  const chapterEntries: BookEntry[] = [];
  for (const [number] of [...chapterNumbers].sort((a, b) => a[1] - b[1])) {
    const ownSections = [...sectionEntries.values()].filter((entry) => entry.label?.split('.')[0] === number || entry.label?.split('.')[0]?.replace(/^0+(?=\d)/, '') === number);
    const first = ownSections[0];
    const openerHit = scan.chapters.find((hit) => hit.number === number);
    const tocChapter = toc.entries.find((entry) => entry.kind === 'chapter' && entry.number === number && entry.source === 'toc');
    const openerChapter = toc.entries.find((entry) => entry.kind === 'chapter' && entry.number === number && entry.source === 'opener');
    const candidates: TitleCandidate[] = [];
    const add = (source: string, raw: string | undefined): void => {
      if (raw === undefined) return;
      const cleaned = normalizeTitle(raw, titleOptions);
      if (cleaned.title.length > 0) candidates.push({ source, text: cleaned.title });
    };
    add('table of contents', tocChapter?.title);
    add('chapter opener', openerHit?.title ?? openerChapter?.title);
    const choice = chooseTitle(candidates);
    const word = openerHit?.label.split(' ')[0] ?? tocChapter?.label?.split(' ')[0] ?? 'Chapter';
    const evidence: string[] = [];
    let confidence = 0.3;
    let page: number | undefined;
    let top: number | undefined;
    if (openerHit) {
      page = openerHit.page;
      top = round(openerHit.top);
      confidence += 0.35;
      evidence.push(`chapter opener: ${openerHit.evidence[0] as string} (page ${openerHit.page})`);
    }
    if (tocChapter) {
      evidence.push(`printed table of contents: "${tocChapter.line.slice(0, 60)}"${tocChapter.merged ? ' (read out of a merged line)' : ''}`);
      confidence += 0.15;
    }
    if (page === undefined && first) {
      page = first.page;
      top = first.top;
      evidence.push('no chapter opener found: the chapter starts where its first section starts');
      notes.push(`${word} ${number}: no chapter opener found; placed at its first section`);
    }
    if (page === undefined && tocChapter?.page !== undefined) page = tocChapter.page;
    if (page === undefined) continue;
    if (first) {
      confidence += 0.1;
      evidence.push(`${ownSections.length} section${ownSections.length === 1 ? '' : 's'} follow${ownSections.length === 1 ? 's' : ''}: ${ownSections[0]?.label} to ${ownSections[ownSections.length - 1]?.label}`);
    }
    const title = choice?.title ?? `${word} ${number}`;
    chapterEntries.push({
      title: title.slice(0, 200),
      page,
      depth: 0,
      id: `c${number}`,
      label: `${word} ${number}`,
      ...(top !== undefined ? { top } : {}),
      kind: 'chapter',
      confidence: Math.max(0.2, Math.min(0.99, Math.round(confidence * 100) / 100)),
      evidence: [...evidence, ...(choice?.evidence ?? [])],
      differences: choice?.differences ?? [],
    });
  }

  // --- back matter -----------------------------------------------------------------------------------------------------
  const backMatter: BookEntry[] = [];
  if (options.includeBackMatter !== false) {
    const seen = new Set<string>();
    for (const entry of toc.entries) {
      if (entry.kind !== 'other' || entry.page === undefined || entry.source !== 'toc') continue;
      const cleaned = normalizeTitle(entry.title, titleOptions).title;
      if (cleaned.length < 2 || seen.has(titleKey(cleaned))) continue;
      seen.add(titleKey(cleaned));
      const isAnswers = answerKey !== undefined && new RegExp(`^(?:${patterns.answerWords.join('|')})\\b`, 'i').test(cleaned);
      const page = isAnswers && answerKey ? answerKey.page : entry.page;
      backMatter.push({
        title: cleaned,
        page,
        depth: 0,
        id: slug(cleaned) || 'back',
        ...(isAnswers && answerKey ? { top: round(answerKey.top) } : {}),
        kind: 'other',
        confidence: isAnswers && answerKey ? 0.9 : 0.6,
        evidence: [`printed table of contents: "${entry.line.slice(0, 60)}", printed page ${entry.printedPage ?? '?'} = page ${entry.page} of the file`, ...(isAnswers && answerKey ? [answerKey.evidence] : [])],
        differences: [],
      });
    }
  }

  // --- order, ids and the extent of practice sets --------------------------------------------------------------------
  const all = [...chapterEntries, ...sectionEntries.values(), ...backMatter];
  const rank = (entry: BookEntry): number => (entry.kind === 'chapter' ? 0 : entry.kind === 'section' ? 1 : 0);
  all.sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0) || rank(a) - rank(b) || (a.label !== undefined && b.label !== undefined ? compareLabels(a.label.replace(/^\D+/, ''), b.label.replace(/^\D+/, '')) : 0));
  for (const entry of all) entries.push(entry);
  attachUnlabeledPractice(entries, scan.unlabeledPractices.filter((hit) => answerKey === undefined || hit.page < answerKey.page), notes);
  assignPracticeEnds(entries, answerKey, pageCount);

  // Gaps in the numbering of a chapter's sections.
  const byChapter = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.kind !== 'section' || entry.label === undefined) continue;
    const [major, minor] = entry.label.split('.') as [string, string];
    const list = byChapter.get(major) ?? [];
    list.push(Number(minor));
    byChapter.set(major, list);
  }
  for (const [major, minors] of byChapter) {
    const sorted = [...minors].sort((a, b) => a - b);
    const start = sorted[0] as number;
    for (let n = start; n <= (sorted[sorted.length - 1] as number); n += 1) {
      if (!sorted.includes(n)) notes.push(`chapter ${major}: no section ${major}.${n} was found between ${major}.${start} and ${major}.${sorted[sorted.length - 1] as number}`);
    }
    if (start > 1) notes.push(`chapter ${major}: its first section is ${major}.${start}, not ${major}.1`);
  }
  if (toc.skipped.length > 0) {
    notes.push(`${toc.skipped.length} entr${toc.skipped.length === 1 ? 'y' : 'ies'} of the printed contents could not be read (garbled text on page${toc.skipped.length === 1 ? '' : 's'} ${[...new Set(toc.skipped.map((entry) => entry.readOn))].join(', ')}); the headings on the pages were used instead`);
  }
  if (numbering.offset === undefined && toc.entries.length > 0) notes.push('The printed page numbers could not be read from the footers, so entries of the table of contents were not placed on pages.');

  if (entries.length === 0) {
    // No numbered structure at all: fall back on generic headings.
    const generic = deriveOutline(pages);
    generic.entries.forEach((entry, index) => {
      entries.push({
        title: entry.title,
        page: entry.page,
        depth: entry.depth,
        id: `s${index + 1}`,
        kind: entry.depth === 0 ? 'chapter' : 'section',
        confidence: entry.confidence,
        evidence: entry.evidence,
        differences: [],
      });
    });
    notes.push(
      generic.entries.length > 0
        ? 'No numbered chapters or sections were found, so the generic heading detection was used (ids s1, s2 ...); there are no practice ranges, so no exercises can be proposed from it.'
        : 'No chapters or sections were found.',
    );
  }

  return {
    entries,
    chapters: entries.filter((entry) => entry.kind === 'chapter').length,
    sections: entries.filter((entry) => entry.kind === 'section').length,
    numbering: { ...(numbering.offset !== undefined ? { offset: numbering.offset } : {}), numbered: Math.round(numbering.numbered * 100) / 100, agreeing: numbering.agreeing },
    toc: { pages: toc.tocPages, openers: toc.openerPages, entries: toc.entries.length },
    ...(answerKey ? { answerKey } : {}),
    notes,
    bodyFontSize: scan.body,
  };
}

/** The outline entries of a structure, in the shape of `outline.json` (id, label and top included). */
export function toOutlineEntries(structure: BookStructure): OutlineEntry[] {
  return structure.entries.map((entry) => ({
    title: entry.title,
    page: entry.page,
    depth: entry.depth,
    id: entry.id,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.top !== undefined ? { top: entry.top } : {}),
  }));
}

/**
 * Sets, for every entry with a practice set, where the set ends: at the start of the next entry that begins after the
 * practice heading, at the answer key, or at the end of the book, whichever comes first. `entries` must be in reading
 * order.
 */
export function assignPracticeEnds(entries: readonly BookEntry[], answerKey: PlaceOnPage | undefined, pageCount: number): void {
  entries.forEach((entry, index) => {
    const practice = entry.practice;
    if (!practice) return;
    const start: PlaceOnPage = { page: practice.page, top: practice.top };
    const next = entries.slice(index + 1).find((other) => before(start, { page: other.page, top: other.top ?? 0 }));
    const candidates: (PlaceOnPage & { why: string })[] = [];
    if (next) {
      const what = next.kind === 'section' ? 'section' : next.kind === 'chapter' ? 'chapter' : 'the entry';
      candidates.push({ page: next.page, top: next.top ?? 0, why: `${what} "${next.label ?? next.title}" starts on page ${next.page}` });
    }
    if (answerKey && before(start, answerKey)) candidates.push({ page: answerKey.page, top: answerKey.top, why: `the answer key starts on page ${answerKey.page}` });
    candidates.push({ page: pageCount, top: 0, why: 'the end of the book' });
    candidates.sort((a, b) => a.page - b.page || a.top - b.top);
    practice.end = candidates[0] as PlaceOnPage & { why: string };
  });
}

/** Gives a section without a labelled practice heading the unlabelled one ("Exercises") that lies inside its extent. */
function attachUnlabeledPractice(entries: readonly BookEntry[], hits: readonly HeadingHit[], notes: string[]): void {
  entries.forEach((entry, index) => {
    if (entry.kind !== 'section' || entry.practice) return;
    const start: PlaceOnPage = { page: entry.page, top: entry.top ?? 0 };
    const next = entries.slice(index + 1).find((other) => before(start, { page: other.page, top: other.top ?? 0 }));
    const limit: PlaceOnPage = next ? { page: next.page, top: next.top ?? 0 } : { page: Infinity, top: 0 };
    const hit = hits.find((candidate) => !before(candidate, start) && before(candidate, limit));
    if (!hit) return;
    entry.practice = { page: hit.page, top: round(hit.top), index: hit.index, text: hit.text, end: { page: limit.page, top: limit.top, why: 'the next entry' } };
    entry.evidence.push(`practice heading without a label: "${hit.text}" (page ${hit.page}) inside the section`);
    const at = notes.indexOf(`${entry.label ?? entry.id}: no practice heading found, so no exercises can be proposed for it`);
    if (at >= 0) notes.splice(at, 1);
  });
}

export interface LocateOptions {
  patterns?: Partial<BookPatterns>;
}

/**
 * The entries of an outline that is already in the project (with ids, which frames refer to), with the place of each
 * section's practice set found on the pages. The outline is taken as it is: a person or an agent may have edited
 * titles and pages. A section is matched to its practice heading by its label (or its id when that looks like a
 * label); without one, by an unlabelled heading inside its extent.
 */
export function locateSections(pages: readonly PageText[], outline: readonly OutlineEntry[], options: LocateOptions = {}): { entries: BookEntry[]; answerKey?: PlaceOnPage & { evidence: string }; notes: string[] } {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const scan = scanHeadings(pages, patterns);
  const notes: string[] = [];
  const first = [...scan.answerChapters].sort((a, b) => a.page - b.page || a.top - b.top)[0];
  const answerKey = first ? { page: first.page, top: first.top, evidence: `the heading "${first.text}" on page ${first.page} opens the answers of a chapter` } : undefined;
  const entries: BookEntry[] = [];
  for (const raw of outline) {
    if (raw.id === undefined) continue;
    const labelled = raw.label !== undefined && /^\d{1,2}\.\d{1,2}$/.test(raw.label) ? raw.label : /^\d{1,2}\.\d{1,2}$/.test(raw.id) ? raw.id : undefined;
    entries.push({
      title: raw.title,
      page: raw.page,
      depth: raw.depth,
      id: raw.id,
      ...(raw.label !== undefined ? { label: raw.label } : {}),
      ...(raw.top !== undefined ? { top: raw.top } : {}),
      kind: raw.depth === 0 ? (/^(?:\D+\s*)?\d+$|^chapter/i.test(raw.label ?? '') ? 'chapter' : 'other') : 'section',
      confidence: 1,
      evidence: ['read from the outline of the project'],
      differences: [],
      ...(labelled !== undefined ? { lesson: { page: raw.page, top: raw.top ?? 0 } } : {}),
    });
    const entry = entries[entries.length - 1] as BookEntry;
    if (entry.kind !== 'section') continue;
    if (labelled !== undefined) {
      const hits = scan.practices.filter((hit) => hit.number === labelled && !before(hit, { page: entry.page, top: 0 }));
      const hit = hits[0];
      if (hit) {
        entry.practice = { page: hit.page, top: round(hit.top), index: hit.index, text: hit.text, end: { page: pages.length, top: 0, why: 'the end of the book' } };
        entry.evidence.push(`practice heading: "${hit.text}" (page ${hit.page})`);
      }
    }
  }
  const order = [...entries].sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0) || a.depth - b.depth);
  attachUnlabeledPractice(order, scan.unlabeledPractices.filter((hit) => answerKey === undefined || hit.page < answerKey.page), notes);
  assignPracticeEnds(order, answerKey, pages.length);
  for (const entry of entries) if (entry.kind === 'section' && !entry.practice) notes.push(`${entry.label ?? entry.id}: no practice heading found, so no exercises can be proposed for it`);
  return { entries, ...(answerKey ? { answerKey } : {}), notes };
}
