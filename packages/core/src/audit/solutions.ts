import type { PageText, Rect, Region, TextLine } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import { DEFAULT_ITEM_PATTERNS, exerciseId } from './exercises.js';
import {
  buildBlocks,
  describeSpan,
  explodeMergedRows,
  findCandidates,
  groupByColumn,
  frameItems,
  layoutPages,
  median,
  parseRangeInstruction,
  selectSequence,
  spanNote,
  type Block,
  type Candidate,
  type ItemPattern,
  type PLine,
  type RejectedStart,
} from './layout.js';
import { proposeLabelledAnswers } from './labelled.js';
import { withHeadRows } from './runningheads.js';
import { DEFAULT_BOOK_PATTERNS, isFurnitureLine, type BookPatterns } from './scan.js';
import type { AnswerKey, AnswersPlace, BookEntry, PlaceOnPage } from './sections.js';
import { titleKey } from './titles.js';

/**
 * The answers of an answer key at the back of the same PDF, matched to the exercises by (section, label).
 *
 * An answer key prints, for every section, a small marker with the section's number ("2.3") and a header ("Answers -
 * Slope-Intercept"), then the answers in a few columns that flow down one column and into the next, across pages. The
 * markers and headers cut the key into bands (a band runs across all columns, from one marker to the next); inside a
 * band the answers are lines that start with a printed number, found and framed by the same engine that reads the
 * practice sets (continuation lines, the second line of a fraction, a graph that stands where the answer is).
 */

export interface SolutionOptions {
  itemPatterns?: ItemPattern[];
  patterns?: Partial<BookPatterns>;
  /** Where the answer key starts, when the sections' structure knows it (else it is found from the headings). */
  answerKey?: PlaceOnPage & { end?: PlaceOnPage };
}

export interface SolutionProposal {
  section: string;
  label: string;
  /** The id of the exercise this answer belongs to (`x0_1-5`), whether or not that exercise exists. */
  exercise: string;
  /** The main region and, when the answer goes on in the next column or page, the continuation regions. */
  regions: Region[];
  confidence: number;
  evidence: string[];
  /** The text of the first line. */
  text: string;
  /** The printed range this answer shares with others ("1-7": one answer printed for the exercises 1 to 7). */
  range?: string;
}

/** How many of the exercises of a section (or a book) have an answer in the key. */
export interface AnswerCoverage {
  exercises: number;
  answered: number;
}

export interface SectionSolutions {
  section: string;
  label?: string;
  title: string;
  answers: SolutionProposal[];
  /** The key prints only some of the answers of this section (a heading says "Selected", or most exercises have none). */
  selected?: boolean;
  /** Set when exercises were given and the key answers fewer than they are. */
  coverage?: AnswerCoverage;
  first?: string;
  last?: string;
  /** Labels between the first and the last that were not found. */
  gaps: string[];
  duplicates: string[];
  /** The headers of the answer key that name the section. */
  headers: string[];
  /** Labels of exercises of the section that have no answer (when exercises were given). */
  withoutAnswer: string[];
  /** Labels of answers that no exercise has (when exercises were given). */
  withoutExercise: string[];
  rejected: RejectedStart[];
  notes: string[];
}

export interface BookSolutions {
  sections: SectionSolutions[];
  /** Pages the key covers. */
  key?: { firstPage: number; lastPage: number };
  /** Over the whole book, when exercises were given: how many have an answer, and in how many sections the answers are selected. */
  coverage?: AnswerCoverage & { sections: number; selectedSections: number };
  notes: string[];
}

/** An exercise to match: the section id and the printed label. */
export interface ExerciseRef {
  section: string;
  label: string;
}


/** The most regions an answer is given: where it starts and seven more (the pages, columns or lines it goes on in). */
const MAX_ANSWER_REGIONS = 8;

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const before = (a: PlaceOnPage, b: PlaceOnPage): boolean => a.page < b.page || (a.page === b.page && a.top < b.top);

/** "1-7. Yes, all of them", "29-33.", "17 & 18: Sketches ...": one answer for a run of exercises. */
const RANGE_ANSWER = /^(\d{1,3})\s*(?:-|–|—|&|and)\s*(\d{1,3})\s*[.:]\s*(.*)$/u;

/** The words of a title, lower case, a trailing "s" taken off, for comparing a header with a section title. */
function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/&/g, ' and ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1)
      .map((word) => (word.length > 3 ? word.replace(/s$/, '') : word)),
  );
}

/** How well a header's title names a section: 1 for the same, less for a title that contains it or shares words. */
function titleScore(header: string, title: string): number {
  const a = titleKey(header);
  const b = titleKey(title);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return 0.85;
  const left = tokens(header);
  const right = tokens(title);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const total = new Set([...left, ...right]).size;
  return total === 0 ? 0 : shared / total;
}

interface Boundary {
  top: number;
  block: Block;
}

function boundariesOf(lines: readonly PLine[]): Map<number, Boundary[]> {
  const result = new Map<number, Boundary[]>();
  const pages = [...new Set(lines.map((entry) => entry.page))];
  for (const page of pages) {
    const tops = new Map<Block, number>();
    for (const entry of lines) if (entry.page === page && entry.block) tops.set(entry.block, Math.min(tops.get(entry.block) ?? Infinity, entry.line.rect.top));
    result.set(page, [...tops].map(([block, top]) => ({ block, top })).sort((a, b) => a.top - b.top));
  }
  return result;
}

/**
 * A line whose font size is wrong by a factor of ten (a stray glyph) has a box that reaches far above and below its
 * text. Its text sits on the baseline of that glyph: the box is cut down to one line of body text around it.
 */
function sane(line: TextLine, body: number, pageHeight: number): TextLine {
  const baseline = line.rect.top + 0.8 * (line.rect.bottom - line.rect.top);
  const real = body / pageHeight;
  return { ...line, fontSize: body, rect: { ...line.rect, top: baseline - 0.8 * real, bottom: baseline + 0.2 * real } };
}

export function proposeSolutions(pagesRead: readonly PageText[], sections: readonly BookEntry[], exercises?: readonly ExerciseRef[], options: SolutionOptions = {}): BookSolutions {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const markerSources = patterns.answerMarkers.map((source) => new RegExp(source, 'iu'));
  const isMarker = (text: string): boolean => markerSources.some((pattern) => pattern.test(text.trim()));
  // A line in the top margin that marks the answers of a section ("Section 2.4 (p. 58)", "2.4 Title") or starts an answer is part of the key.
  const markerLike = (text: string): boolean => isMarker(text) || /^\d{1,2}\.\d{1,2}\b/.test(text.trim()) || /^\(?\d{1,3}[.)]/.test(text.trim());
  // The title of a chapter on the row of a page number ("14   Prerequisites") is a running head, never the continuation of an answer.
  const pages = withHeadRows(pagesRead, isMarker);
  const notes: string[] = [];
  const targets = sections.filter((entry) => entry.kind === 'section');
  const result: BookSolutions = { sections: [], notes };
  // Answers that are entries of an answer chapter, each headed by its number ("Lösung 1.2.3"), need no key to be read.
  const inline = proposeLabelledAnswers(pages, targets, exercises, patterns);
  if (inline.active) {
    result.sections = inline.sections;
    notes.push(...inline.notes);
    if (exercises && exercises.length > 0) {
      const answered = inline.sections.reduce((sum, section) => sum + section.answers.filter((answer) => exercises.some((exercise) => exercise.section === section.section && exercise.label === answer.label)).length, 0);
      result.coverage = { exercises: exercises.length, answered, sections: targets.length, selectedSections: 0 };
    }
    return result;
  }
  const answerKey = options.answerKey ?? firstAnswerPage(pages, patterns);
  // The answers that the book prints right after a section ("1.2.3 Answers") are zones of their own, each for its section.
  const embedded = targets.filter((entry) => entry.answers !== undefined && (answerKey === undefined || before(entry.answers, answerKey)));
  if (!answerKey && embedded.length === 0) {
    notes.push('No answer key was found: no heading like "Answers - Chapter 1", no heading like "1.2.3 Answers" after a section, and no place was given.');
    return result;
  }
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const garbledHeader = new RegExp(`^(?:${patterns.answerWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]+\\s*\\p{L}`, 'iu');
  const byLabel = new Map(targets.filter((entry) => entry.label !== undefined).map((entry) => [entry.label as string, entry]));
  interface Zone {
    from: PlaceOnPage & { index?: number };
    to?: PlaceOnPage;
    section?: BookEntry;
  }
  const zones: Zone[] = embedded
    .map((entry): Zone => ({ from: { page: (entry.answers as AnswersPlace).page, top: (entry.answers as AnswersPlace).top, index: (entry.answers as AnswersPlace).index }, to: (entry.answers as AnswersPlace).end, section: entry }))
    .sort((a, b) => a.from.page - b.from.page || a.from.top - b.from.top);
  if (answerKey) zones.push({ from: answerKey, ...(answerKey.end ? { to: answerKey.end } : {}) });
  // Where the answers of a zone end (the heading that follows them): no region reaches below it.
  const zoneEnds = zones.flatMap((zone) => (zone.to ? [{ page: zone.to.page, top: zone.to.top }] : []));
  const lines: PLine[] = [];
  const garbled = new Set<TextLine>();
  // Lines that start a band by themselves: the heading of a section's answers, and a large line of a key that starts with a section label.
  const headingMarkers = new Map<string, string>();
  // The lines of the zones that belong to one section: nothing in them is a marker of another section.
  const ownLines = new Set<string>();
  for (const zone of zones) {
    const last = zone.to ? Math.min(zone.to.page, pages.length - 1) : pages.length - 1;
    for (let p = zone.from.page; p <= last; p += 1) {
      const page = pages[p];
      if (!page || !page.hasText) continue;
      page.lines.forEach((line, index) => {
        if (isFurnitureLine(line, markerLike, page.lines)) return;
        if (zone.to && p === zone.to.page && !(line.rect.top < zone.to.top - 0.002)) return;
        if (zone.section && p === zone.from.page && index < (zone.from.index ?? 0)) return;
        if (zone.section) ownLines.add(`${p}:${index}`);
        if (zone.section && p === zone.from.page && index === zone.from.index) {
          // The heading of the answers of one section ("0.1.4 Answers"): it names the section the lines below belong to.
          headingMarkers.set(`${p}:${index}`, zone.section.label as string);
          lines.push({ page: p, index, line, role: 'other' });
          return;
        }
        // Headings are not answers; a header whose text layer is garbled (a huge wrong font size) still marks a band.
        if (body > 0 && line.fontSize >= body * 1.25 && line.chars <= 100 && !(line.fontSize >= body * 4 && garbledHeader.test(line.text.trim()))) {
          // ... but a large line that starts with the label of a section opens the answers of that section.
          const labelled = zone.section ? undefined : /^(\d{1,2}\.\d{1,2})\s/.exec(line.text.trim());
          if (labelled && byLabel.has(labelled[1] as string)) {
            headingMarkers.set(`${p}:${index}`, labelled[1] as string);
            lines.push({ page: p, index, line, role: 'other' });
          }
          return;
        }
        if (!zone.section && p === zone.from.page && line.rect.top < zone.from.top - 0.01) return;
        if (body > 0 && line.fontSize >= body * 4) {
          const repaired = sane(line, body, page.size.height);
          garbled.add(repaired);
          lines.push({ page: p, index, line: repaired, role: 'other' });
        } else lines.push({ page: p, index, line, role: 'other' });
      });
    }
  }
  const exploded = explodeMergedRows(lines);
  if (exploded.length === 0) {
    notes.push('The answer key has no text lines (a scan?).');
    return result;
  }
  result.key = { firstPage: Math.min(...zones.map((zone) => zone.from.page)), lastPage: exploded[exploded.length - 1]?.page ?? answerKey?.page ?? 0 };

  // --- markers and headers cut the key into bands --------------------------------------------------------------------
  const headerPattern = new RegExp(`^(?:${patterns.answerWords.map(escapeWord).join('|')})\\b\\s*(?:[:.\\-–—]+|\\bto\\b|\\bfor\\b|\\bof\\b)\\s*(.+)$`, 'iu');
  const chapterPattern = new RegExp(`^(?:${patterns.chapterWords.map(escapeWord).join('|')})\\s+(?:\\d+|[IVXLC]+)\\b`, 'iu');
  const markerPatterns = patterns.answerMarkers.map((source) => new RegExp(source, 'iu'));
  const markerOf = new Map<PLine, string>();
  const headerOf = new Map<PLine, string>();
  const namedByHeading = new Set<string>();
  // The markers of a key follow the order of the sections: a number like "7.5" in a table of the band of 10.4 is no marker. A line
  // is taken for the marker of a section when that section comes after the last marker, and not far after it.
  const sectionAt = new Map(targets.map((entry, at) => [entry.label, at]));
  let lastMarked = -1;
  const inOrder = (label: string, reach: number): boolean => {
    const at = sectionAt.get(label);
    if (at === undefined || at <= lastMarked || at > lastMarked + reach) return false;
    lastMarked = at;
    return true;
  };
  const rejectedMarkers: string[] = [];
  for (const entry of exploded) {
    const text = entry.line.text.trim();
    const titled = headingMarkers.get(`${entry.page}:${entry.index}`);
    if (titled !== undefined) {
      const embeddedHeading = embedded.some((section) => section.label === titled && (section.answers as AnswersPlace).page === entry.page && (section.answers as AnswersPlace).index === entry.index);
      if (embeddedHeading || inOrder(titled, 20)) {
        entry.role = 'instruction';
        markerOf.set(entry, titled);
        const named = byLabel.get(titled);
        if (named) namedByHeading.add(named.id);
        continue;
      }
      rejectedMarkers.push(`"${text.slice(0, 40)}" on page ${entry.page}`);
      continue;
    }
    // Inside the answers of one section nothing marks another section.
    if (ownLines.has(`${entry.page}:${Math.floor(entry.index)}`)) continue;
    if (/^\d{1,2}\.\d{1,2}$/.test(text) && byLabel.has(text)) {
      if (inOrder(text, 6)) {
        entry.role = 'instruction';
        markerOf.set(entry, text);
        continue;
      }
      rejectedMarkers.push(`"${text}" on page ${entry.page}`);
      continue;
    }
    const marked = markerPatterns.map((pattern) => pattern.exec(text)?.[1]).find((label) => label !== undefined && byLabel.has(label));
    if (marked !== undefined) {
      if (inOrder(marked, 20)) {
        entry.role = 'instruction';
        markerOf.set(entry, marked);
        continue;
      }
      rejectedMarkers.push(`"${text.slice(0, 40)}" on page ${entry.page}`);
      continue;
    }
    const header = /(?:\.{3,}|(?:\.\s+){3,}\.?)/.test(text) ? null : headerPattern.exec(text);
    if (header && !chapterPattern.test((header[1] as string).trim()) && (entry.line.chars <= 80 || garbled.has(entry.line)) && /^\D/.test((header[1] as string).trim())) {
      entry.role = 'instruction';
      headerOf.set(entry, (header[1] as string).trim().replace(/\s*\d{1,3}[).].*$/, '').slice(0, 80));
    }
  }
  if (rejectedMarkers.length > 0) notes.push(`${rejectedMarkers.length} line${rejectedMarkers.length === 1 ? '' : 's'} like a section marker ${rejectedMarkers.length === 1 ? 'was' : 'were'} not taken for one because the section does not come next in the book's order: ${rejectedMarkers.slice(0, 4).join('; ')}${rejectedMarkers.length > 4 ? '; ...' : ''}`);
  const pitches: number[] = [];
  for (let i = 1; i < exploded.length; i += 1) {
    const a = exploded[i - 1] as PLine;
    const b = exploded[i] as PLine;
    if (a.page === b.page && Math.abs(a.line.rect.left - b.line.rect.left) < 0.05 && b.line.rect.top > a.line.rect.top) pitches.push(b.line.rect.top - a.line.rect.top);
  }
  const pitch = median(pitches.filter((value) => value < 0.08)) || 0.025;

  // A line that says which answers it is about ("For 1-5, any answer will do") right under a marker or a header belongs to them.
  exploded.forEach((entry, at) => {
    const above = exploded[at - 1];
    if (entry.role !== 'other' || !above || above.role !== 'instruction' || above.page !== entry.page) return;
    if (parseRangeInstruction(entry.line.text) !== undefined && entry.line.rect.top - above.line.rect.bottom < 1.5 * pitch) entry.role = 'instruction';
  });

  // The answers that start a line, section by section: a candidate belongs to the band it lies in.
  const candidatesAll = findCandidates(
    exploded.filter((entry) => entry.role === 'other'),
    options.itemPatterns ?? DEFAULT_ITEM_PATTERNS,
  );
  // One answer printed for several exercises: "1-7. Yes, all of them", "17 & 18: Sketches may differ".
  for (const entry of exploded) {
    if (entry.role !== 'other') continue;
    const text = entry.line.text.trim();
    const range = RANGE_ANSWER.exec(text);
    if (!range) continue;
    const from = Number(range[1]);
    const through = Number(range[2]);
    if (through <= from || through - from > 60 || from < 1 || /^0\d/.test(range[1] as string)) continue;
    const rest = (range[3] ?? '').trim();
    candidatesAll.push({ label: String(from), n: from, suffix: '', lead: text.slice(0, text.length - rest.length).trim(), rest, page: entry.page, index: entry.index, line: entry.line, weak: false, through });
  }
  // Blocks are closed by the answers that follow them; for that, every candidate counts as a start for the moment.
  const provisional = new Set(candidatesAll.map((candidate) => `${candidate.page}:${candidate.index}`));
  for (const entry of exploded) if (entry.role === 'other' && provisional.has(`${entry.page}:${entry.index}`)) entry.role = 'start';
  const blocks = buildBlocks(exploded, pitch);
  for (const entry of exploded) if (entry.role === 'start') entry.role = 'other';
  const boundaries = boundariesOf(exploded);
  const pageList = [...boundaries.keys()].sort((a, b) => a - b);
  const blockSection = new Map<Block, { id: string; how: 'marker' | 'header' | 'order' }>();
  const headersOf = new Map<string, string[]>();
  let previousSection: string | undefined;
  const sectionOrder = targets.map((entry) => entry.id);
  for (const block of blocks) {
    const marker = block.lines.map((entry) => markerOf.get(entry)).find((value) => value !== undefined);
    const headerLine = block.lines.find((entry) => headerOf.has(entry));
    const headerTitle = headerLine ? headerOf.get(headerLine) : undefined;
    let chosen: { id: string; how: 'marker' | 'header' | 'order' } | undefined;
    if (marker) chosen = { id: (byLabel.get(marker) as BookEntry).id, how: 'marker' };
    else if (headerTitle) {
      const scored = targets.map((entry) => ({ entry, score: titleScore(headerTitle, entry.title) })).sort((a, b) => b.score - a.score);
      const best = scored[0];
      const second = scored[1];
      if (best && best.score >= 0.5 && (second === undefined || best.score - second.score >= 0.15)) chosen = { id: best.entry.id, how: 'header' };
    }
    if (!chosen && previousSection !== undefined) {
      const next = sectionOrder[sectionOrder.indexOf(previousSection) + 1];
      if (next !== undefined) chosen = { id: next, how: 'order' };
    }
    if (chosen) {
      blockSection.set(block, chosen);
      previousSection = chosen.id;
      if (headerTitle) headersOf.set(chosen.id, [...(headersOf.get(chosen.id) ?? []), headerTitle]);
    }
  }
  const governing = (page: number, y: number): Block | undefined => {
    const here = (boundaries.get(page) ?? []).filter((boundary) => boundary.top <= y + 1e-6);
    if (here.length > 0) return (here[here.length - 1] as Boundary).block;
    for (let k = pageList.length - 1; k >= 0; k -= 1) {
      const earlier = pageList[k] as number;
      if (earlier >= page) continue;
      const list = boundaries.get(earlier) ?? [];
      if (list.length > 0) return (list[list.length - 1] as Boundary).block;
    }
    return undefined;
  };
  const sectionOf = (page: number, y: number): string | undefined => {
    const block = governing(page, y);
    return block ? blockSection.get(block)?.id : undefined;
  };

  // --- the sequence of each section -----------------------------------------------------------------------------------
  const exercisesOf = new Map<string, Set<string>>();
  for (const exercise of exercises ?? []) exercisesOf.set(exercise.section, (exercisesOf.get(exercise.section) ?? new Set()).add(exercise.label));
  const bySection = new Map<string, Candidate[]>();
  const stray: Candidate[] = [];
  for (const candidate of candidatesAll) {
    const section = sectionOf(candidate.page, candidate.line.rect.top);
    if (section === undefined) {
      stray.push(candidate);
      continue;
    }
    bySection.set(section, [...(bySection.get(section) ?? []), candidate]);
  }
  const selections = new Map<string, ReturnType<typeof selectSequence>>();
  for (const [section, list] of bySection) {
    const own = exploded.filter((entry) => entry.role === 'other' && sectionOf(entry.page, entry.line.rect.top) === section);
    // Read against the exercises of the section: a number well beyond the last exercise is a number inside an answer.
    const expectedLabels = [...(exercisesOf.get(section) ?? [])].map((label) => Number.parseInt(label, 10)).filter(Number.isFinite);
    const limit = expectedLabels.length > 0 ? { maxNumber: Math.max(...expectedLabels) + 3 } : {};
    let selection = selectSequence(list, own, limit);
    // A key that answers selected exercises only has larger steps between its numbers than a run of exercises does.
    if (expectedLabels.length > 0 && selection.chosen.length < 0.9 * expectedLabels.length) {
      const wide = selectSequence(list, own, { ...limit, maxJump: 15 });
      if (wide.chosen.length > selection.chosen.length) selection = wide;
    }
    selections.set(section, selection);
  }
  const chosenAt = new Map<string, { candidate: Candidate; section: string }>();
  for (const [section, selection] of selections) for (const candidate of selection.chosen) chosenAt.set(`${candidate.page}:${candidate.index}`, { candidate, section });
  for (const entry of exploded) {
    const found = chosenAt.get(`${entry.page}:${entry.index}`);
    if (found) {
      entry.role = 'start';
      entry.candidate = found.candidate;
    }
  }

  // --- frames ---------------------------------------------------------------------------------------------------------
  // A key whose answers run on like a paragraph (several to a line, an answer going on in the next line after the one that
  // follows it) has no columns to frame them by: each answer is the pieces of text from its number to the next number.
  const flow = looksLikeFlow(exploded);
  if (flow) notes.push('The answers of this key run on like a paragraph, several to a line: each answer was framed as the pieces of text between its number and the next one (one region per line it takes).');
  const layout = flow ? undefined : layoutPages(exploded, pages, pitch, { headingSize: body * 1.25 });
  const byColumn = layout ? groupByColumn(layout.items) : new Map<string, never[]>();
  const placed: { item: Placed; frame: FrameLike }[] = [];
  if (layout) {
    placed.push(...frameItems(layout.items, { pages, items: layout.items, byColumn, layout, headingSize: body * 1.25, ends: zoneEnds }, { conflictShare: 0.5, conflictHeight: 0.01 }));
  } else
    for (const entry of flowItems(exploded)) {
      const block = governing(entry.start.page, entry.start.line.rect.top);
      placed.push({ item: { candidate: entry.start.candidate as Candidate, page: entry.start.page, start: entry.start, block }, frame: entry.frame });
    }
  const proposalsBySection = new Map<string, SolutionProposal[]>();
  // The answers that go on after the end of their page or column, per section (a key set like a paragraph frames every line of an answer alike: no span there).
  const spansBySection = new Map<string, { n: number; text: string }[]>();
  for (const { item, frame } of placed) {
    const section = chosenAt.get(`${item.candidate.page}:${item.candidate.index}`)?.section;
    if (section === undefined) continue;
    if (layout && frame.continues.length > 0) {
      spansBySection.set(section, [...(spansBySection.get(section) ?? []), { n: item.candidate.n, text: describeSpan(item.candidate.label, item.page, frame.continues, MAX_ANSWER_REGIONS - 1) }]);
    }
    const how = item.block ? blockSection.get(item.block)?.how : undefined;
    const evidence: string[] = [];
    const selection = selections.get(section);
    evidence.push(item.candidate.weak ? `starts with "${item.candidate.label}" followed by text (the closing mark is not in the text layer)` : `starts with "${item.candidate.lead}"`);
    const header = headersOf.get(section)?.[0];
    evidence.push(
      how === 'marker'
        ? `in the band of the marker "${(sections.find((entry) => entry.id === section)?.label ?? section)}" on page ${item.page}${header ? ` (header "${header}")` : ''}`
        : how === 'header'
          ? `in the band whose header "${header ?? ''}" names the section`
          : 'in the band that follows the previous section (no marker or header named it)',
    );
    if (frame.figure) evidence.push(item.candidate.rest.length === 0 ? 'the number stands alone: the region reaches over what is drawn beside or below it' : 'mostly short lines: treated as a figure');
    if (frame.continues.length > 0) evidence.push(`goes on in ${frame.continues.length} further region${frame.continues.length === 1 ? '' : 's'} (page ${frame.continues.map((region) => region.page).join(', ')})`);
    const labels = (selection?.chosen ?? []).map((candidate) => candidate.n);
    const low = Math.min(...labels);
    const high = Math.max(...labels);
    const expected = [item.candidate.n - 1, item.candidate.n + 1].filter((n) => n >= low && n <= high);
    const present = expected.filter((n) => labels.includes(n));
    let confidence = 0.9;
    if (how === 'order') confidence -= 0.15;
    if (item.candidate.weak) confidence -= 0.25;
    if (present.length < expected.length) confidence -= 0.1;
    if (frame.rect.bottom - frame.rect.top < 0.014) confidence -= 0.15;
    // One answer printed for a run of exercises belongs to each of them: every one gets the same regions.
    const through = item.candidate.through;
    const covered = through !== undefined ? Array.from({ length: through - item.candidate.n + 1 }, (_unused, k) => String(item.candidate.n + k)) : [item.candidate.label];
    const rangeText = through !== undefined ? `${item.candidate.n}-${through}` : undefined;
    if (rangeText) evidence.push(`one answer is printed for the exercises ${rangeText}: each of them gets this region`);
    for (const label of covered) {
      proposalsBySection.set(section, [
        ...(proposalsBySection.get(section) ?? []),
        {
          section,
          label,
          exercise: exerciseId(section, label),
          regions: [{ page: item.page, rect: frame.rect }, ...frame.continues].slice(0, MAX_ANSWER_REGIONS),
          confidence: Math.max(0.1, Math.round((confidence - (rangeText ? 0.05 : 0)) * 100) / 100),
          evidence,
          text: item.start.line.text.trim().slice(0, 80),
          ...(rangeText ? { range: rangeText } : {}),
        },
      ]);
    }
  }

  // --- per section, with the match against the exercises -----------------------------------------------------------------
  const numeric = (label: string): number => Number.parseInt(label, 10) * 100 + (label.codePointAt(label.length - 1) ?? 0) / 1000;
  let coverageExercises = 0;
  let coverageAnswered = 0;
  let selectedSections = 0;
  for (const entry of targets) {
    // An answer printed for the exercise itself wins over a share of a printed range.
    const byLabelOfAnswer = new Map<string, SolutionProposal>();
    for (const proposal of proposalsBySection.get(entry.id) ?? []) {
      const known = byLabelOfAnswer.get(proposal.label);
      if (!known || (known.range !== undefined && proposal.range === undefined)) byLabelOfAnswer.set(proposal.label, proposal);
    }
    const answers = [...byLabelOfAnswer.values()].sort((a, b) => numeric(a.label) - numeric(b.label));
    const selection = selections.get(entry.id);
    const wanted = exercisesOf.get(entry.id);
    const section: SectionSolutions = {
      section: entry.id,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      title: entry.title,
      answers,
      gaps: selection?.gaps ?? [],
      duplicates: selection?.duplicates ?? [],
      headers: headersOf.get(entry.id) ?? [],
      withoutAnswer: [],
      withoutExercise: [],
      rejected: selection?.rejected ?? [],
      notes: [],
    };
    if (answers.length > 0) {
      section.first = (answers[0] as SolutionProposal).label;
      section.last = (answers[answers.length - 1] as SolutionProposal).label;
    }
    if (wanted) {
      const have = new Set(answers.map((answer) => answer.label));
      section.withoutAnswer = [...wanted].filter((label) => !have.has(label)).sort((a, b) => numeric(a) - numeric(b));
      section.withoutExercise = [...have].filter((label) => !wanted.has(label)).sort((a, b) => numeric(a) - numeric(b));
      const answered = wanted.size - section.withoutAnswer.length;
      coverageExercises += wanted.size;
      coverageAnswered += answered;
      // A key that prints the answers of some exercises only is said once for the section, not exercise by exercise.
      const partial = answered > 0 && section.withoutAnswer.length > 3 && answered < 0.9 * wanted.size;
      if (partial || entry.answers?.selected === true) {
        section.selected = true;
        selectedSections += 1;
      }
      if (wanted.size > 0 && answered < wanted.size) section.coverage = { exercises: wanted.size, answered };
      if (answers.length === 0 && wanted.size > 0) section.notes.push('no answers were found for this section');
      if (partial) section.notes.push(`answers printed for ${answered} of ${wanted.size} exercises (selected answers)`);
      else if (section.withoutAnswer.length > 0) section.notes.push(`no answer for the exercise${section.withoutAnswer.length === 1 ? '' : 's'} ${section.withoutAnswer.slice(0, 12).join(', ')}${section.withoutAnswer.length > 12 ? ', ...' : ''}`);
      if (section.withoutExercise.length > 0) section.notes.push(`answer${section.withoutExercise.length === 1 ? '' : 's'} ${section.withoutExercise.slice(0, 12).join(', ')} ${section.withoutExercise.length === 1 ? 'has' : 'have'} no exercise`);
    } else if (answers.length === 0) section.notes.push('no answers were found for this section');
    const spanned = spanNote(
      (spansBySection.get(entry.id) ?? []).sort((a, b) => a.n - b.n).map((span) => span.text),
      'answer',
    );
    if (spanned) section.notes.push(spanned);
    if (section.gaps.length > 0) section.notes.push(`no answer starts with ${section.gaps.length === 1 ? 'the number' : 'the numbers'} ${section.gaps.slice(0, 12).join(', ')} although they run from ${section.first} to ${section.last}`);
    if (section.duplicates.length > 0) section.notes.push(`${section.duplicates.length === 1 ? 'the number' : 'the numbers'} ${section.duplicates.join(', ')} ${section.duplicates.length === 1 ? 'is' : 'are'} printed more than once`);
    if (section.headers.length === 0 && answers.length > 0 && !namedByHeading.has(entry.id)) section.notes.push('the answer key has no header for this section: it was named by its marker only');
    result.sections.push(section);
  }
  if (exercises && exercises.length > 0) {
    result.coverage = { exercises: coverageExercises, answered: coverageAnswered, sections: targets.length, selectedSections };
    if (selectedSections > 0 || coverageAnswered < 0.9 * coverageExercises) {
      notes.push(`answers printed for ${coverageAnswered} of ${coverageExercises} exercises (${Math.round((100 * coverageAnswered) / Math.max(1, coverageExercises))} %): this book prints selected answers only (${selectedSections} section${selectedSections === 1 ? '' : 's'} with some exercises unanswered); an exercise without an answer is not a defect`);
    }
  }
  if (stray.length > 0) notes.push(`${stray.length} line${stray.length === 1 ? '' : 's'} that start with a number lie in no band of the key (before the first marker or header): ${stray.slice(0, 4).map((candidate) => `"${candidate.line.text.slice(0, 30)}" on page ${candidate.page}`).join('; ')}`);
  if (layout && layout.orphans.length > 0) notes.push(`${layout.orphans.length} line${layout.orphans.length === 1 ? '' : 's'} of the key belong to no answer: ${layout.orphans.slice(0, 4).join('; ')}${layout.orphans.length > 4 ? '; ...' : ''}`);
  const unknown = blocks.filter((block) => !blockSection.has(block)).length;
  if (unknown > 0) notes.push(`${unknown} marker or header block${unknown === 1 ? '' : 's'} of the key could not be assigned to a section`);
  return result;
}

/** What the frames of an answer are made from (an item of the layout, or of a key that runs on like a paragraph). */
interface Placed {
  candidate: Candidate;
  page: number;
  start: PLine;
  block: Block | undefined;
}

interface FrameLike {
  rect: Rect;
  continues: Region[];
  figure: boolean;
}

/**
 * Whether the answers of a key run on like a paragraph: several answers stand in one line, and the numbers inside the lines
 * are not at columns that other lines share (in a key set out in columns, they are).
 */
export function looksLikeFlow(lines: readonly PLine[]): boolean {
  const starts = lines.filter((entry) => entry.role === 'start');
  const middle = starts.filter((entry) =>
    starts.some(
      (other) =>
        other !== entry &&
        other.page === entry.page &&
        other.line.rect.left < entry.line.rect.left - 0.05 &&
        Math.min(other.line.rect.bottom, entry.line.rect.bottom) - Math.max(other.line.rect.top, entry.line.rect.top) > 0.5 * (entry.line.rect.bottom - entry.line.rect.top),
    ),
  );
  if (middle.length < 8) return false;
  // Columns of a set key start at one x, to the width of a letter or less; the numbers of a paragraph stand wherever the words end.
  const shared = middle.filter((entry) => middle.filter((other) => other !== entry && Math.abs(other.line.rect.left - entry.line.rect.left) <= 0.004).length >= 3).length;
  return shared < 0.4 * middle.length;
}

const FLOW_PAD = { side: 0.006, vertical: 0.003 };

/**
 * The answers of a key that runs on like a paragraph: every line after a numbered piece belongs to it until the next numbered
 * piece. Each answer is framed by the pieces, joined into one region when what lies between them is nothing but their own text.
 */
function flowItems(lines: readonly PLine[]): { start: PLine; frame: FrameLike }[] {
  type Group = { start: PLine; pieces: PLine[] };
  const groups: Group[] = [];
  const groupOf = new Map<PLine, Group>();
  let current: Group | undefined;
  for (const entry of lines) {
    if (entry.role === 'instruction') {
      current = undefined;
      continue;
    }
    if (entry.role === 'start') {
      current = { start: entry, pieces: [entry] };
      groups.push(current);
      groupOf.set(entry, current);
    } else if (current) {
      current.pieces.push(entry);
      groupOf.set(entry, current);
    }
  }
  // A small piece (the sign of a root, a degree sign) stands over the text it belongs to, which may come in the next line.
  // It is one sign or a few that are no letters and no digits; a unit ("mi") or a number ("85") goes on from the line before.
  const small = (entry: PLine): boolean => {
    const text = entry.line.text.trim();
    return entry.role === 'other' && entry.line.rect.right - entry.line.rect.left <= 0.08 && (/^[^\p{L}\p{N}\s]{1,3}$/u.test(text) || /^\p{L}$/u.test(text));
  };
  const attached = new Map<PLine, PLine[]>();
  for (const entry of lines) {
    if (!small(entry) || !groupOf.has(entry)) continue;
    const rect = entry.line.rect;
    const centre = (rect.left + rect.right) / 2;
    const hosts = lines.filter(
      (other) =>
        other !== entry &&
        other.page === entry.page &&
        groupOf.has(other) &&
        !small(other) &&
        centre >= other.line.rect.left - 0.01 &&
        centre <= other.line.rect.right + 0.01 &&
        Math.min(rect.bottom, other.line.rect.bottom) - Math.max(rect.top, other.line.rect.top) > -0.012,
    );
    const host = [...hosts].sort((a, b) => Math.min(rect.bottom, b.line.rect.bottom) - Math.max(rect.top, b.line.rect.top) - (Math.min(rect.bottom, a.line.rect.bottom) - Math.max(rect.top, a.line.rect.top)) || b.line.rect.top - a.line.rect.top)[0];
    const from = groupOf.get(entry) as Group;
    const to = host ? (groupOf.get(host) as Group) : undefined;
    if (!to || !host) continue;
    // The small piece becomes part of the line it stands over (and of no piece of its own).
    from.pieces.splice(from.pieces.indexOf(entry), 1);
    groupOf.set(entry, to);
    attached.set(host, [...(attached.get(host) ?? []), entry]);
  }
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const rounded = (value: number): number => Math.round(value * 10000) / 10000;
  return groups.map((group) => {
    const own = new Set(group.pieces);
    for (const piece of group.pieces) for (const other of attached.get(piece) ?? []) own.add(other);
    const regions: Region[] = [];
    for (const piece of group.pieces) {
      const last = regions[regions.length - 1];
      const small = attached.get(piece) ?? [];
      const rect: Rect =
        small.length === 0
          ? piece.line.rect
          : {
              left: Math.min(piece.line.rect.left, ...small.map((other) => other.line.rect.left)),
              top: Math.min(piece.line.rect.top, ...small.map((other) => other.line.rect.top)),
              right: Math.max(piece.line.rect.right, ...small.map((other) => other.line.rect.right)),
              bottom: Math.max(piece.line.rect.bottom, ...small.map((other) => other.line.rect.bottom)),
            };
      if (last && last.page === piece.page) {
        const union: Rect = { left: Math.min(last.rect.left, rect.left), top: Math.min(last.rect.top, rect.top), right: Math.max(last.rect.right, rect.right), bottom: Math.max(last.rect.bottom, rect.bottom) };
        const foreign = lines.some(
          (other) =>
            other.page === piece.page &&
            !own.has(other) &&
            (other.line.rect.left + other.line.rect.right) / 2 > union.left + 0.002 &&
            (other.line.rect.left + other.line.rect.right) / 2 < union.right - 0.002 &&
            (other.line.rect.top + other.line.rect.bottom) / 2 > union.top + 0.002 &&
            (other.line.rect.top + other.line.rect.bottom) / 2 < union.bottom - 0.002,
        );
        if (!foreign) {
          last.rect = union;
          continue;
        }
      }
      regions.push({ page: piece.page, rect: { ...rect } });
    }
    const padded = regions.map((region): Region => {
      const neighbours = lines.filter((other) => other.page === region.page && !own.has(other) && other.line.rect.right > region.rect.left && other.line.rect.left < region.rect.right);
      const above = Math.max(0, ...neighbours.filter((other) => other.line.rect.bottom <= region.rect.top + 0.002).map((other) => other.line.rect.bottom));
      const below = Math.min(1, ...neighbours.filter((other) => other.line.rect.top >= region.rect.bottom - 0.002).map((other) => other.line.rect.top));
      return {
        page: region.page,
        rect: {
          left: rounded(clamp(region.rect.left - FLOW_PAD.side)),
          right: rounded(clamp(region.rect.right + FLOW_PAD.side)),
          top: rounded(Math.max(region.rect.top - FLOW_PAD.vertical, (above + region.rect.top) / 2)),
          bottom: rounded(Math.min(region.rect.bottom + FLOW_PAD.vertical, (below + region.rect.bottom) / 2)),
        },
      };
    });
    const [first, ...rest] = padded;
    return { start: group.start, frame: { rect: (first as Region).rect, continues: rest.slice(0, 7), figure: false } };
  });
}

/** The first page of an answer key found from a heading such as "Answers - Chapter 1". */
function firstAnswerPage(pages: readonly PageText[], patterns: BookPatterns): AnswerKey | undefined {
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const answers = new RegExp(`^(?:${patterns.answerWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]*\\s*(?:${patterns.chapterWords.map(escapeWord).join('|')})\\s+(?:\\d+|[IVXLC]+)\\b`, 'iu');
  for (const page of pages) {
    for (const line of page.lines) {
      if (body > 0 && line.fontSize >= body * 1.25 && answers.test(line.text.trim())) return { page: page.page, top: line.rect.top, evidence: `the heading "${line.text.trim()}" on page ${page.page}` };
    }
  }
  return undefined;
}

