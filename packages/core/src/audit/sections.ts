import { deriveSectionId } from '../book/sections.js';
import type { OutlineEntry, PageText } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import { deriveOutline } from '../propose/headings.js';
import { numberBookmarks } from './bookmarks.js';
import { MIN_LABELLED, anchorExample, chaptersHoldingItems, findLabelledItems, labelledItemPatterns, sectionOfLabel, type LabelledHit } from './labelled.js';
import { readPageNumbers, type PageNumbering } from './pagenumbers.js';
import { DEFAULT_BOOK_PATTERNS, scanHeadings, type BookPatterns, type HeadingHit, type HeadingScan, type PracticeForm } from './scan.js';
import { chooseTitle, normalizeTitle, stripChapterPrefix, titleKey, type TitleCandidate } from './titles.js';
import { parseToc, type TocKind, type TocResult } from './toc.js';

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
  /** How the heading was recognised: labelled ("3.2 Practice"), a part of the section ("3.2.4 Exercises") or alone on its line. */
  form?: PracticeForm;
}

/** Where the answers of one section are printed, right after its exercises ("3.2.5 Answers"). */
export interface AnswersPlace extends PlaceOnPage {
  index: number;
  text: string;
  /** Where the answers end: the start of whatever the book prints next (exclusive). */
  end: PlaceOnPage & { why: string };
  /** The heading says that only some answers are printed ("Selected Answers"). */
  selected: boolean;
}

export interface BookEntry extends OutlineEntry {
  /** Always set: "c0" for a chapter, the printed label for a section ("0.1"), for the other entries what the data model derives from the title ("Answers"). */
  id: string;
  kind: TocKind;
  confidence: number;
  evidence: string[];
  /** Where the lesson of a section starts (its label line or heading). */
  lesson?: PlaceOnPage;
  /** Where the practice set is printed, when a practice heading was found. */
  practice?: PracticePlace;
  /** Where the answers of the section are printed when the book prints them right after the section. */
  answers?: AnswersPlace;
  /** Spellings of the title that differ from the one chosen, and where they were read. */
  differences: TitleCandidate[];
}

/** Where the answer key of a book starts and, when the book goes on with something else after it (an appendix), where it ends. */
export type AnswerKey = PlaceOnPage & { evidence: string; end?: PlaceOnPage & { why: string } };

export interface BookStructure {
  entries: BookEntry[];
  chapters: number;
  sections: number;
  /** Printed page number minus page index, when the book's footers or running heads agree on one. */
  numbering: { offset?: number; numbered: number; agreeing: number };
  toc: { pages: number[]; openers: number[]; entries: number };
  /** Where the answer key starts, when one was found. */
  answerKey?: AnswerKey;
  /** How many practice sets were found from each kind of heading, in the order the tool tries them. */
  practiceAnchors: Record<PracticeForm, number>;
  /** Things to look at: gaps, sections without a practice set, disagreements. */
  notes: string[];
  bodyFontSize: number;
  /** The headings carry no numbers: the entries come from the generic heading detection and their ids from their titles. */
  generic?: boolean;
}

export interface DeriveSectionsOptions {
  patterns?: Partial<BookPatterns>;
  glyphRepairs?: Record<string, string>;
  /** Also list the unnumbered entries of the table of contents (Answers, Index) as entries of depth 0 (default true). */
  includeBackMatter?: boolean;
}

/** Numbered entries of the contents that hold no exercises and end the section before them ("1.8 References"). */
const NON_PRACTICE_TITLE = /^(?:references?|bibliography|credits)$/i;

const FORM_ORDER: readonly PracticeForm[] = ['labelled', 'subsection', 'alone'];

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

/** The practice heading of a section: the labelled kind if the book has one, else a part of the section; the first at or after the cursor. */
function pickPractice(hits: readonly HeadingHit[], cursor: PlaceOnPage): HeadingHit | undefined {
  for (const form of FORM_ORDER) {
    const own = hits.filter((hit) => (hit.form ?? 'labelled') === form);
    if (own.length > 0) return pick(own, cursor);
  }
  return undefined;
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

/** The place where the answer key starts: the answers of the chapters, the contents, or the title of a key printed in the same file. */
export function findAnswerKey(pageCount: number, scan: HeadingScan, toc: Pick<TocResult, 'entries'>, patterns: BookPatterns): AnswerKey | undefined {
  const firstAnswers = [...scan.answerChapters].sort((a, b) => a.page - b.page || a.top - b.top)[0];
  if (firstAnswers) return { page: firstAnswers.page, top: firstAnswers.top, evidence: `the heading "${firstAnswers.text}" on page ${firstAnswers.page} opens the answers of a chapter` };
  const answerWord = new RegExp(`\\b(?:${patterns.answerWords.map((word) => word.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).join('|')})\\b`, 'iu');
  const listed = toc.entries.find((entry) => entry.kind === 'other' && entry.page !== undefined && answerWord.test(entry.title));
  if (listed && listed.page !== undefined) return { page: listed.page, top: 0, evidence: `the table of contents lists "${listed.title}" on printed page ${listed.printedPage ?? '?'}` };
  // A key that is a book of its own inside the file has a title page: a large line that ends in "Answer Key".
  const titled = [...scan.answerTitles].filter((hit) => hit.page >= 0.4 * pageCount).sort((a, b) => a.page - b.page || a.top - b.top)[0];
  if (titled) return { page: titled.page, top: round(Math.max(0, titled.top - 0.01)), evidence: `the title page "${titled.text}" on page ${titled.page} opens an answer key` };
  return undefined;
}

export function deriveSections(pages: readonly PageText[], options: DeriveSectionsOptions = {}): BookStructure {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const notes: string[] = [];
  const numbering: PageNumbering = readPageNumbers(pages);
  const itemLabel = itemLabelOf(patterns);
  const toc = parseToc(pages, numbering, { chapterWords: patterns.chapterWords, itemLabel });
  const scan = scanHeadings(pages, patterns);
  const titleOptions = options.glyphRepairs !== undefined ? { glyphRepairs: options.glyphRepairs } : {};
  const pageCount = pages.length;
  const entries: BookEntry[] = [];

  // --- the answer key ----------------------------------------------------------------------------------------------
  const answerKey = findAnswerKey(pageCount, scan, toc, patterns);
  const inBody = (hit: HeadingHit): boolean => answerKey === undefined || hit.page < answerKey.page;

  // --- labels --------------------------------------------------------------------------------------------------------
  // Hits inside the answer key are markers, not lessons.
  const lessonHits = scan.lessons.filter(inBody);
  const practiceHits = scan.practices.filter(inBody);
  const sectionLabels = new Set<string>();
  for (const entry of toc.entries) if (entry.kind === 'section' && entry.number !== undefined) sectionLabels.add(entry.number);
  for (const hit of [...lessonHits, ...practiceHits]) sectionLabels.add(hit.number);
  const labels = [...sectionLabels].sort(compareLabels);
  // A number and a title in large type is a chapter opener only when another source says there is such a chapter.
  const chapterHits = scan.chapters.filter(inBody).filter((hit) => {
    if (hit.weak !== true) return true;
    if (toc.entries.some((entry) => entry.kind === 'chapter' && entry.number === hit.number)) return true;
    return lessonHits.some((lesson) => lesson.number === `${hit.number}.1` && (lesson.page === hit.page || lesson.page === hit.page + 1));
  });
  const chapterNumbers = new Map<string, number>();
  const noteChapter = (text: string): void => {
    if (!chapterNumbers.has(text)) chapterNumbers.set(text, romanOrNumber(text));
  };
  for (const entry of toc.entries) if (entry.kind === 'chapter' && entry.number !== undefined) noteChapter(entry.number);
  for (const hit of chapterHits) noteChapter(hit.number);
  for (const label of labels) noteChapter((label.split('.')[0] as string).replace(/^0+(?=\d)/, ''));

  // --- sections ------------------------------------------------------------------------------------------------------
  let cursor: PlaceOnPage = { page: 0, top: 0 };
  const sectionEntries = new Map<string, BookEntry>();
  const lastOfChapter = new Map<string, string>();
  const notInContents: string[] = [];
  for (const label of labels) {
    const tocEntries = toc.entries.filter((entry) => entry.kind === 'section' && entry.number === label);
    const mainToc = tocEntries.find((entry) => entry.source === 'toc');
    const opener = tocEntries.find((entry) => entry.source === 'opener');
    const lesson = pick(lessonHits.filter((hit) => hit.number === label), cursor);
    const practice = pickPractice(practiceHits.filter((hit) => hit.number === label), lesson ?? cursor);
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
    const nonPractice = NON_PRACTICE_TITLE.test(choice.title);

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
    } else if (!nonPractice) notes.push(`${label}: no practice heading found, so no exercises can be proposed for it`);
    evidence.push(...choice.evidence, ...repairs);
    if (!mainToc && !opener && toc.entries.some((entry) => entry.kind === 'section')) {
      notInContents.push(label);
      confidence -= 0.05;
    }
    if (nonPractice) evidence.push(`the title "${choice.title}" names no exercises: it is listed, but no exercises are looked for in it`);
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
      kind: nonPractice ? 'other' : 'section',
      confidence: Math.max(0.2, Math.min(0.99, Math.round(confidence * 100) / 100)),
      evidence,
      differences: choice.differences,
    };
    if (lesson) entry.lesson = { page: lesson.page, top: round(lesson.top) };
    if (practice) entry.practice = { page: practice.page, top: round(practice.top), index: practice.index, text: practice.text, end: { page: pageCount, top: 0, why: 'the end of the book' }, ...(practice.form !== undefined ? { form: practice.form } : {}) };
    sectionEntries.set(label, entry);
    cursor = { page, top: top ?? 0 };
    lastOfChapter.set(label.split('.')[0] as string, label);
  }
  reportMissingFromContents(notInContents, sectionEntries, toc, notes);

  // --- chapters ------------------------------------------------------------------------------------------------------
  const chapterEntries: BookEntry[] = [];
  for (const [number] of [...chapterNumbers].sort((a, b) => a[1] - b[1])) {
    const ownSections = [...sectionEntries.values()].filter((entry) => entry.label?.split('.')[0] === number || entry.label?.split('.')[0]?.replace(/^0+(?=\d)/, '') === number);
    const first = ownSections[0];
    const openerHit = chapterHits.find((hit) => hit.number === number && hit.weak !== true) ?? chapterHits.find((hit) => hit.number === number);
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
    const usedIds = new Set<string>([...chapterEntries, ...sectionEntries.values()].map((entry) => entry.id));
    for (const entry of toc.entries) {
      if (entry.kind !== 'other' || entry.page === undefined || entry.source !== 'toc') continue;
      // A line of the contents that lists an exercise ("Aufgabe 1.3 (Title)") is no part of the book.
      if (itemLabel(entry.title) !== undefined) continue;
      const cleaned = normalizeTitle(entry.title, titleOptions).title;
      if (cleaned.length < 2 || seen.has(titleKey(cleaned))) continue;
      seen.add(titleKey(cleaned));
      const isAnswers = answerKey !== undefined && new RegExp(`^(?:${patterns.answerWords.join('|')})\\b`, 'i').test(cleaned);
      const listedKey = answerKey !== undefined && entry.page === answerKey.page && answerKey.evidence.includes(`"${entry.title}"`);
      const page = (isAnswers || listedKey) && answerKey ? answerKey.page : entry.page;
      backMatter.push({
        title: cleaned,
        page,
        depth: 0,
        id: deriveSectionId({ title: cleaned }, chapterEntries.length + sectionEntries.size + backMatter.length, usedIds),
        ...((isAnswers || listedKey) && answerKey ? { top: round(answerKey.top) } : {}),
        kind: 'other',
        confidence: (isAnswers || listedKey) && answerKey ? 0.9 : 0.6,
        evidence: [`printed table of contents: "${entry.line.slice(0, 60)}", printed page ${entry.printedPage ?? '?'} = page ${entry.page} of the file`, ...((isAnswers || listedKey) && answerKey ? [answerKey.evidence] : [])],
        differences: [],
      });
    }
  }

  // --- order, ids and the extent of practice sets --------------------------------------------------------------------
  const all = [...chapterEntries, ...sectionEntries.values(), ...backMatter];
  const rank = (entry: BookEntry): number => (entry.kind === 'chapter' ? 0 : entry.kind === 'other' && entry.depth === 1 ? 1 : entry.kind === 'section' ? 1 : 0);
  all.sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0) || rank(a) - rank(b) || (a.label !== undefined && b.label !== undefined ? compareLabels(a.label.replace(/^\D+/, ''), b.label.replace(/^\D+/, '')) : 0));
  for (const entry of all) entries.push(entry);
  placeSetsOfSections(entries, scan, answerKey, pageCount, notes);
  const keyOfBook = answerKey ? withKeyEnd(answerKey, entries) : undefined;

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
      if (!sorted.includes(n) && !entries.some((entry) => entry.label === `${major}.${n}`)) notes.push(`chapter ${major}: no section ${major}.${n} was found between ${major}.${start} and ${major}.${sorted[sorted.length - 1] as number}`);
    }
    if (start > 1) notes.push(`chapter ${major}: its first section is ${major}.${start}, not ${major}.1`);
  }
  if (toc.skipped.length > 0) {
    notes.push(`${toc.skipped.length} entr${toc.skipped.length === 1 ? 'y' : 'ies'} of the printed contents could not be read (garbled text on page${toc.skipped.length === 1 ? '' : 's'} ${[...new Set(toc.skipped.map((entry) => entry.readOn))].join(', ')}); the headings on the pages were used instead`);
  }
  if (numbering.offset === undefined && toc.entries.length > 0) notes.push('The printed page numbers could not be read from the footers or the running heads, so entries of the table of contents were not placed on pages.');
  const skippedTitles = entries.filter((entry) => entry.kind === 'other' && entry.depth === 1);
  if (skippedTitles.length > 0) {
    notes.push(`${skippedTitles.length} numbered entr${skippedTitles.length === 1 ? 'y' : 'ies'} of the contents hold no exercises and are listed without being looked at: "${skippedTitles[0]?.title}" ${skippedTitles.slice(0, 4).map((entry) => `${entry.label} (page ${entry.page})`).join(', ')}${skippedTitles.length > 4 ? ', ...' : ''}`);
  }

  let generic = false;
  if (entries.length === 0) {
    // No numbered structure at all: fall back on generic headings.
    generic = true;
    const generic_ = deriveOutline(pages);
    const usedIds = new Set<string>();
    generic_.entries.forEach((entry, index) => {
      entries.push({
        title: entry.title,
        page: entry.page,
        depth: entry.depth,
        id: deriveSectionId({ title: entry.title }, index, usedIds),
        kind: entry.depth === 0 ? 'chapter' : 'section',
        confidence: entry.confidence,
        evidence: entry.evidence,
        differences: [],
      });
    });
    notes.push(
      generic_.entries.length > 0
        ? 'No numbered chapters or sections were found, so the generic heading detection was used (the ids are made from the titles); there are no practice ranges, so no exercises can be proposed from it.'
        : 'No chapters or sections were found.',
    );
  }

  chaptersAsSections(entries, pages, patterns, notes);
  const anchors = practiceAnchorCounts(entries);
  reportPracticeAnchors(anchors, notes);
  noteInlineExercises(entries, pages, patterns, notes);
  return {
    entries,
    chapters: entries.filter((entry) => entry.kind === 'chapter').length,
    sections: entries.filter((entry) => entry.kind === 'section').length,
    numbering: { ...(numbering.offset !== undefined ? { offset: numbering.offset } : {}), numbered: Math.round(numbering.numbered * 100) / 100, agreeing: numbering.agreeing },
    toc: { pages: toc.tocPages, openers: toc.openerPages, entries: toc.entries.length },
    ...(keyOfBook ? { answerKey: keyOfBook } : {}),
    practiceAnchors: anchors,
    notes,
    bodyFontSize: scan.body,
    ...(generic ? { generic: true } : {}),
  };
}

/** The number that a line of the printed contents lists an exercise under: "Aufgabe 1.3 (Title)" gives "1.3". */
function itemLabelOf(patterns: BookPatterns): (title: string) => string | undefined {
  const rule = labelledItemPatterns(patterns)[1] as RegExp;
  return (title) => rule.exec(title.trim())?.[1];
}

/**
 * Numbered chapters that hold no numbered sections, in a book whose exercises print their number under the chapter's ("Aufgabe
 * 1.3 (Title)."): the chapters are the sections. Their ids and labels are the numbers the book prints.
 */
function chaptersAsSections(entries: BookEntry[], pages: readonly PageText[], patterns: BookPatterns, notes: string[]): void {
  if (entries.some((entry) => entry.kind === 'section')) return;
  const chapters = entries.filter((entry) => entry.kind === 'chapter' && entry.depth === 0 && /^c\d{1,3}$/.test(entry.id));
  if (chapters.length < 2) return;
  const numbers = chapters.map((entry) => entry.id.slice(1));
  if (!chaptersHoldingItems(numbers, pages, patterns)) return;
  chapters.forEach((entry, at) => {
    entry.kind = 'section';
    entry.id = numbers[at] as string;
    entry.label = numbers[at] as string;
    entry.evidence.push('a chapter that holds exercises numbered under it: it is a section');
  });
  notes.push(`The chapters hold no numbered sections, and the exercises print their number under the chapter's (lines like "${anchorExample(findLabelledItems(pages, patterns)[0] as LabelledHit)}"): the ${chapters.length} chapters are the sections.`);
}

/** The answer key with the end that the next entry of the book gives it (an appendix after the key). */
function withKeyEnd(key: AnswerKey, entries: readonly BookEntry[]): AnswerKey {
  const next = entries.find((entry) => before(key, { page: entry.page, top: entry.top ?? 0 }));
  return next ? { ...key, end: { page: next.page, top: next.top ?? 0, why: `"${next.label ?? next.title}" starts on page ${next.page}` } } : key;
}

/**
 * A book that prints its exercises inside the text ("1.2.3 Aufgabe: ...") has no practice heading to find: the sections that hold
 * such exercises are not reported as sections without exercises, and the note says where the exercises will be read from.
 */
function noteInlineExercises(entries: readonly BookEntry[], pages: readonly PageText[], patterns: BookPatterns, notes: string[]): void {
  const hits = findLabelledItems(pages, patterns);
  if (hits.length < MIN_LABELLED) return;
  const sections = entries.filter((entry) => entry.kind === 'section');
  const held = new Map<string, number>();
  for (const hit of hits) {
    const entry = sectionOfLabel(hit.label, hit.page, sections);
    if (entry) held.set(entry.id, (held.get(entry.id) ?? 0) + 1);
  }
  for (const entry of sections) {
    if (entry.practice) continue;
    const at = notes.indexOf(`${entry.label ?? entry.id}: no practice heading found, so no exercises can be proposed for it`);
    if (at >= 0) notes.splice(at, 1);
    const count = held.get(entry.id);
    if (count) entry.evidence.push(`${count} exercise${count === 1 ? ' is' : 's are'} printed inside its text (lines like "${anchorExample(hits[0] as LabelledHit)}")`);
  }
  notes.push(`${hits.length} exercises are printed inside the text of ${held.size} sections (lines like "${anchorExample(hits[0] as LabelledHit)}"): they are read from there, not from a practice set`);
}

/** Says which kinds of heading the practice sets were found from, when it was not the labelled kind alone (the kinds are tried in this order for every section). */
function reportPracticeAnchors(anchors: Record<PracticeForm, number>, notes: string[]): void {
  if (anchors.subsection + anchors.alone === 0) return;
  notes.push(
    `practice sets found from: ${anchors.labelled} labelled headings ("3.2 Practice - Title"), ${anchors.subsection} numbered parts of a section ("3.2.4 Exercises"), ${anchors.alone} headings alone on their line ("Exercises"); the kinds are tried in this order for every section`,
  );
}

/** How many sections have their practice set from each kind of heading. */
function practiceAnchorCounts(entries: readonly BookEntry[]): Record<PracticeForm, number> {
  const counts: Record<PracticeForm, number> = { labelled: 0, subsection: 0, alone: 0 };
  for (const entry of entries) if (entry.kind === 'section' && entry.practice) counts[entry.practice.form ?? 'labelled'] += 1;
  return counts;
}

/**
 * Sections that the pages show but the contents do not list: one note per chapter whose sections are all missing (its
 * contents were left out of the printed list), else one note per section.
 */
function reportMissingFromContents(missing: readonly string[], sectionEntries: ReadonlyMap<string, BookEntry>, toc: Pick<TocResult, 'entries' | 'tocPages'>, notes: string[]): void {
  const byChapter = new Map<string, string[]>();
  for (const label of missing) byChapter.set(label.split('.')[0] as string, [...(byChapter.get(label.split('.')[0] as string) ?? []), label]);
  for (const [chapter, labels] of byChapter) {
    const all = [...sectionEntries.keys()].filter((label) => label.split('.')[0] === chapter);
    if (labels.length === all.length && labels.length > 1) {
      const listed = [...new Set(toc.entries.filter((entry) => entry.kind === 'chapter' && entry.source === 'toc' && entry.number !== undefined).map((entry) => entry.number as string))];
      notes.push(
        `chapter ${chapter} (${labels[0]} to ${labels[labels.length - 1]}, ${labels.length} sections) is not in the table of contents${toc.tocPages.length > 0 ? ` (pages ${toc.tocPages[0]} to ${toc.tocPages[toc.tocPages.length - 1]}${listed.length > 0 ? `, chapters ${listed[0]} to ${listed[listed.length - 1]}` : ''})` : ''}: its sections were read from their headings`,
      );
    } else for (const label of labels) notes.push(`${label}: found on the pages but not in the table of contents (or the line could not be read)`);
  }
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
 * practice heading, at a heading that ends it ("Warm-up Answers", the answers of the section), at the answer key, or
 * at the end of the book, whichever comes first. `entries` must be in reading order.
 */
export function assignPracticeEnds(entries: readonly BookEntry[], answerKey: PlaceOnPage | undefined, pageCount: number, stops: readonly HeadingHit[] = []): void {
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
    const stop = stops.find((hit) => before({ page: practice.page, top: practice.top + 0.0005 }, hit));
    if (stop) candidates.push({ page: stop.page, top: round(Math.max(0, stop.top - 0.0005)), why: `the heading "${stop.text}" on page ${stop.page}` });
    if (answerKey && before(start, answerKey)) candidates.push({ page: answerKey.page, top: answerKey.top, why: `the answer key starts on page ${answerKey.page}` });
    candidates.push({ page: pageCount, top: 0, why: 'the end of the book' });
    candidates.sort((a, b) => a.page - b.page || a.top - b.top);
    practice.end = candidates[0] as PlaceOnPage & { why: string };
  });
}

/**
 * Gives each section the places of its sets: the practice set when the sections have none yet (the unlabelled heading
 * inside the extent of the section: the strongest word first, then the first one printed), where the answers of the section
 * are printed right after it, and where each ends.
 */
export function placeSetsOfSections(entries: readonly BookEntry[], scan: HeadingScan, answerKey: PlaceOnPage | undefined, pageCount: number, notes: string[]): void {
  const inBody = (hit: HeadingHit): boolean => answerKey === undefined || before(hit, answerKey);
  attachUnlabeledPractice(entries, scan.unlabeledPractices.filter(inBody), notes);
  const stops = scan.stops.filter(inBody).sort((a, b) => a.page - b.page || a.top - b.top);
  assignPracticeEnds(entries, answerKey, pageCount, stops);
  attachAnswers(entries, scan.answerSections.filter(inBody), answerKey, pageCount);
}

/** Gives a section without a labelled practice heading the unlabelled one ("Exercises") that lies inside its extent. */
function attachUnlabeledPractice(entries: readonly BookEntry[], hits: readonly HeadingHit[], notes: string[]): void {
  entries.forEach((entry, index) => {
    if (entry.kind !== 'section' || entry.practice) return;
    const start: PlaceOnPage = { page: entry.page, top: entry.top ?? 0 };
    const next = entries.slice(index + 1).find((other) => before(start, { page: other.page, top: other.top ?? 0 }));
    const limit: PlaceOnPage = next ? { page: next.page, top: next.top ?? 0 } : { page: Infinity, top: 0 };
    const inside = hits.filter((candidate) => !before(candidate, start) && before(candidate, limit));
    // The strongest word wins ("Review Questions" over "Review"); among equals the first one printed.
    const hit = [...inside].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.page - b.page || a.top - b.top)[0];
    if (!hit) return;
    entry.practice = { page: hit.page, top: round(hit.top), index: hit.index, text: hit.text, end: { page: limit.page, top: limit.top, why: 'the next entry' }, form: 'alone' };
    entry.evidence.push(`practice heading without a label: "${hit.text}" (page ${hit.page}) inside the section`);
    const at = notes.indexOf(`${entry.label ?? entry.id}: no practice heading found, so no exercises can be proposed for it`);
    if (at >= 0) notes.splice(at, 1);
  });
}

/** Gives a section the heading of its answers ("3.2.5 Answers") and the place where they end. */
function attachAnswers(entries: readonly BookEntry[], hits: readonly HeadingHit[], answerKey: PlaceOnPage | undefined, pageCount: number): void {
  entries.forEach((entry, index) => {
    if (entry.kind !== 'section' || entry.label === undefined) return;
    const label = entry.label;
    const own = hits.filter((hit) => hit.number === label && !before(hit, { page: entry.page, top: 0 }));
    const hit = own[0];
    if (!hit) return;
    const start: PlaceOnPage = { page: hit.page, top: hit.top };
    const next = entries.slice(index + 1).find((other) => before(start, { page: other.page, top: other.top ?? 0 }));
    const candidates: (PlaceOnPage & { why: string })[] = [];
    if (next) candidates.push({ page: next.page, top: next.top ?? 0, why: `${next.kind === 'chapter' ? 'chapter' : next.kind === 'section' ? 'section' : 'the entry'} "${next.label ?? next.title}" starts on page ${next.page}` });
    if (answerKey && before(start, answerKey)) candidates.push({ page: answerKey.page, top: answerKey.top, why: `the answer key starts on page ${answerKey.page}` });
    candidates.push({ page: pageCount, top: 0, why: 'the end of the book' });
    candidates.sort((a, b) => a.page - b.page || a.top - b.top);
    entry.answers = { page: hit.page, top: round(hit.top), index: hit.index, text: hit.text, end: candidates[0] as PlaceOnPage & { why: string }, selected: hit.selected === true };
    entry.evidence.push(`${hit.selected === true ? 'selected answers' : 'answers'}: "${hit.text}" (page ${hit.page}) right after the section`);
  });
}

export interface LocateSectionsOptions {
  patterns?: Partial<BookPatterns>;
}

/**
 * The entries of an outline that is already in the project (with ids, which frames refer to), with the place of each
 * section's practice set found on the pages. The outline is taken as it is: a person or an agent may have edited
 * titles and pages. A section is matched to its practice heading by its label (or its id when that looks like a
 * label); without one, by an unlabelled heading inside its extent.
 */
export function locateSections(pages: readonly PageText[], outline: readonly OutlineEntry[], options: LocateSectionsOptions = {}): { entries: BookEntry[]; answerKey?: AnswerKey; notes: string[] } {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const numbering = readPageNumbers(pages);
  const toc = parseToc(pages, numbering, { chapterWords: patterns.chapterWords, itemLabel: itemLabelOf(patterns) });
  const scan = scanHeadings(pages, patterns);
  const notes: string[] = [];
  const answerKey = findAnswerKey(pages.length, scan, toc, patterns);
  const entries: BookEntry[] = [];
  // One level of numbered entries ("1", "2", ...) whose number the printed exercises start with ("Aufgabe 1.3 (Title).") has no
  // sections below its chapters: the chapters hold the exercises.
  const flat = outline.length >= 2 && outline.every((raw) => raw.depth === 0 && /^\d{1,3}$/.test(raw.label ?? '')) && chaptersHoldingItems(outline.map((raw) => raw.label as string), pages, patterns);
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
      // (A number of three levels names a part of a section, not a section.)
      kind: flat ? 'section' : raw.depth === 0 ? (/^(?:\D+\s*)?\d+$|^chapter/i.test(raw.label ?? '') ? 'chapter' : 'other') : NON_PRACTICE_TITLE.test(raw.title.trim()) || /^\d+\.\d+\.\d+/.test(raw.label ?? '') ? 'other' : 'section',
      confidence: 1,
      evidence: ['read from the outline of the project'],
      differences: [],
      ...(labelled !== undefined ? { lesson: { page: raw.page, top: raw.top ?? 0 } } : {}),
    });
    const entry = entries[entries.length - 1] as BookEntry;
    if (entry.kind !== 'section') continue;
    if (labelled !== undefined) {
      const hits = scan.practices.filter((hit) => hit.number === labelled && !before(hit, { page: entry.page, top: 0 }));
      const hit = pickPractice(hits, { page: entry.page, top: 0 });
      if (hit) {
        entry.practice = { page: hit.page, top: round(hit.top), index: hit.index, text: hit.text, end: { page: pages.length, top: 0, why: 'the end of the book' }, ...(hit.form !== undefined ? { form: hit.form } : {}) };
        entry.evidence.push(`practice heading: "${hit.text}" (page ${hit.page})`);
      }
    }
  }
  const order = [...entries].sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0) || a.depth - b.depth);
  placeSetsOfSections(order, scan, answerKey, pages.length, notes);
  const keyOfBook = answerKey ? withKeyEnd(answerKey, order) : undefined;
  reportPracticeAnchors(practiceAnchorCounts(entries), notes);
  for (const entry of entries) if (entry.kind === 'section' && !entry.practice) notes.push(`${entry.label ?? entry.id}: no practice heading found, so no exercises can be proposed for it`);
  noteInlineExercises(entries, pages, { ...DEFAULT_BOOK_PATTERNS, ...options.patterns }, notes);
  return { entries, ...(keyOfBook ? { answerKey: keyOfBook } : {}), notes };
}

/**
 * The sections of a book whose headings carry no numbers, from the bookmarks of its PDF: the numbers are counted (see
 * `numberBookmarks`) and the numbered outline is placed on the pages like an outline that the project already has. Undefined
 * when the bookmarks give no chapters with sections.
 */
export function deriveSectionsFromBookmarks(pages: readonly PageText[], bookmarks: readonly OutlineEntry[], options: DeriveSectionsOptions = {}): BookStructure | undefined {
  const numbered = numberBookmarks(bookmarks, pages, options.patterns ?? {});
  if (!numbered) return undefined;
  const located = locateSections(pages, numbered.entries, options.patterns ? { patterns: options.patterns } : {});
  const entries = located.entries;
  const sections = entries.filter((entry) => entry.kind === 'section').length;
  if (sections === 0) return undefined;
  const check =
    numbered.fit.of > 0
      ? `${numbered.fit.found} of the ${numbered.fit.of} ${numbered.flat === true ? 'chapter' : 'section'} numbers that the printed exercises show ${numbered.flat === true ? 'are bookmarks' : 'fit a counted section'}`
      : 'no printed exercise numbers were there to check them by';
  const notes = [
    numbered.flat === true
      ? `The bookmarks of the PDF are one level of numbered chapters, and the exercises print their number under the chapter's (lines like "${anchorExample(findLabelledItems(pages, { ...DEFAULT_BOOK_PATTERNS, ...options.patterns })[0] as LabelledHit)}"): the chapters are the sections, with the numbers they print; ${check}.`
      : `The sections were numbered by counting the bookmarks of the PDF (chapters at depth ${numbered.chapterDepth}, sections at the depth below, the count starting again in each chapter); ${check}.`,
    ...located.notes,
  ];
  return {
    entries,
    chapters: entries.filter((entry) => entry.kind === 'chapter').length,
    sections,
    numbering: { numbered: 0, agreeing: 0 },
    toc: { pages: [], openers: [], entries: 0 },
    ...(located.answerKey ? { answerKey: located.answerKey } : {}),
    practiceAnchors: practiceAnchorCounts(entries),
    notes,
    bodyFontSize: bodyFontSize(pages.filter((page) => page.hasText)),
  };
}
