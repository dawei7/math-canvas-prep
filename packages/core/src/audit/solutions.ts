import type { PageText, Region, TextLine } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import { DEFAULT_ITEM_PATTERNS, exerciseId } from './exercises.js';
import {
  buildBlocks,
  explodeMergedRows,
  findCandidates,
  groupByColumn,
  itemFrame,
  layoutPages,
  median,
  selectSequence,
  type Block,
  type Candidate,
  type ItemPattern,
  type PLine,
  type RejectedStart,
} from './layout.js';
import { DEFAULT_BOOK_PATTERNS, isRunningLine, type BookPatterns } from './scan.js';
import type { BookEntry, PlaceOnPage } from './sections.js';
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
  answerKey?: PlaceOnPage;
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
}

export interface SectionSolutions {
  section: string;
  label?: string;
  title: string;
  answers: SolutionProposal[];
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
  notes: string[];
}

/** An exercise to match: the section id and the printed label. */
export interface ExerciseRef {
  section: string;
  label: string;
}


const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

export function proposeSolutions(pages: readonly PageText[], sections: readonly BookEntry[], exercises?: readonly ExerciseRef[], options: SolutionOptions = {}): BookSolutions {
  const patterns: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...options.patterns };
  const notes: string[] = [];
  const targets = sections.filter((entry) => entry.kind === 'section');
  const result: BookSolutions = { sections: [], notes };
  const answerKey = options.answerKey ?? firstAnswerPage(pages, patterns);
  if (!answerKey) {
    notes.push('No answer key was found: no heading like "Answers - Chapter 1" and no place was given.');
    return result;
  }
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const garbledHeader = new RegExp(`^(?:${patterns.answerWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]+\\s*\\p{L}`, 'iu');
  const lines: PLine[] = [];
  const garbled = new Set<TextLine>();
  for (let p = answerKey.page; p < pages.length; p += 1) {
    const page = pages[p];
    if (!page || !page.hasText) continue;
    page.lines.forEach((line, index) => {
      if (isRunningLine(line)) return;
      // Headings are not answers; a header whose text layer is garbled (a huge wrong font size) still marks a band.
      if (body > 0 && line.fontSize >= body * 1.25 && line.chars <= 100 && !(line.fontSize >= body * 4 && garbledHeader.test(line.text.trim()))) return;
      if (p === answerKey.page && line.rect.top < answerKey.top - 0.01) return;
      if (body > 0 && line.fontSize >= body * 4) {
        const repaired = sane(line, body, page.size.height);
        garbled.add(repaired);
        lines.push({ page: p, index, line: repaired, role: 'other' });
      } else lines.push({ page: p, index, line, role: 'other' });
    });
  }
  const exploded = explodeMergedRows(lines);
  if (exploded.length === 0) {
    notes.push('The answer key has no text lines (a scan?).');
    return result;
  }
  result.key = { firstPage: answerKey.page, lastPage: exploded[exploded.length - 1]?.page ?? answerKey.page };

  // --- markers and headers cut the key into bands --------------------------------------------------------------------
  const byLabel = new Map(targets.filter((entry) => entry.label !== undefined).map((entry) => [entry.label as string, entry]));
  const headerPattern = new RegExp(`^(?:${patterns.answerWords.map(escapeWord).join('|')})\\b\\s*(?:[:.\\-–—]+|\\bto\\b|\\bfor\\b|\\bof\\b)\\s*(.+)$`, 'iu');
  const chapterPattern = new RegExp(`^(?:${patterns.chapterWords.map(escapeWord).join('|')})\\s+(?:\\d+|[IVXLC]+)\\b`, 'iu');
  const markerOf = new Map<PLine, string>();
  const headerOf = new Map<PLine, string>();
  for (const entry of exploded) {
    const text = entry.line.text.trim();
    if (/^\d{1,2}\.\d{1,2}$/.test(text) && byLabel.has(text)) {
      entry.role = 'instruction';
      markerOf.set(entry, text);
      continue;
    }
    const header = headerPattern.exec(text);
    if (header && !chapterPattern.test((header[1] as string).trim()) && (entry.line.chars <= 80 || garbled.has(entry.line)) && /^\D/.test((header[1] as string).trim())) {
      entry.role = 'instruction';
      headerOf.set(entry, (header[1] as string).trim().replace(/\s*\d{1,3}[).].*$/, '').slice(0, 80));
    }
  }
  const pitches: number[] = [];
  for (let i = 1; i < exploded.length; i += 1) {
    const a = exploded[i - 1] as PLine;
    const b = exploded[i] as PLine;
    if (a.page === b.page && Math.abs(a.line.rect.left - b.line.rect.left) < 0.05 && b.line.rect.top > a.line.rect.top) pitches.push(b.line.rect.top - a.line.rect.top);
  }
  const pitch = median(pitches.filter((value) => value < 0.08)) || 0.025;

  // The answers that start a line, section by section: a candidate belongs to the band it lies in.
  const candidatesAll = findCandidates(
    exploded.filter((entry) => entry.role === 'other'),
    options.itemPatterns ?? DEFAULT_ITEM_PATTERNS,
  );
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
    selections.set(section, selectSequence(list, own));
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
  const layout = layoutPages(exploded, pages, pitch);
  const byColumn = groupByColumn(layout.items);
  const proposalsBySection = new Map<string, SolutionProposal[]>();
  for (const item of layout.items) {
    const section = chosenAt.get(`${item.candidate.page}:${item.candidate.index}`)?.section;
    if (section === undefined) continue;
    const frame = itemFrame(item, { pages, items: layout.items, byColumn, layout, headingSize: body * 1.25 });
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
    const proposal: SolutionProposal = {
      section,
      label: item.candidate.label,
      exercise: exerciseId(section, item.candidate.label),
      regions: [{ page: item.page, rect: frame.rect }, ...frame.continues].slice(0, 8),
      confidence: Math.max(0.1, Math.round(confidence * 100) / 100),
      evidence,
      text: item.start.line.text.trim().slice(0, 80),
    };
    proposalsBySection.set(section, [...(proposalsBySection.get(section) ?? []), proposal]);
  }

  // --- per section, with the match against the exercises -----------------------------------------------------------------
  const exercisesOf = new Map<string, Set<string>>();
  for (const exercise of exercises ?? []) exercisesOf.set(exercise.section, (exercisesOf.get(exercise.section) ?? new Set()).add(exercise.label));
  const numeric = (label: string): number => Number.parseInt(label, 10) * 100 + (label.codePointAt(label.length - 1) ?? 0) / 1000;
  for (const entry of targets) {
    const answers = [...(proposalsBySection.get(entry.id) ?? [])].sort((a, b) => numeric(a.label) - numeric(b.label));
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
      if (answers.length === 0 && wanted.size > 0) section.notes.push('no answers were found for this section');
      if (section.withoutAnswer.length > 0) section.notes.push(`no answer for the exercise${section.withoutAnswer.length === 1 ? '' : 's'} ${section.withoutAnswer.slice(0, 12).join(', ')}${section.withoutAnswer.length > 12 ? ', ...' : ''}`);
      if (section.withoutExercise.length > 0) section.notes.push(`answer${section.withoutExercise.length === 1 ? '' : 's'} ${section.withoutExercise.slice(0, 12).join(', ')} ${section.withoutExercise.length === 1 ? 'has' : 'have'} no exercise`);
    } else if (answers.length === 0) section.notes.push('no answers were found for this section');
    if (section.gaps.length > 0) section.notes.push(`no answer starts with ${section.gaps.length === 1 ? 'the number' : 'the numbers'} ${section.gaps.slice(0, 12).join(', ')} although they run from ${section.first} to ${section.last}`);
    if (section.duplicates.length > 0) section.notes.push(`${section.duplicates.length === 1 ? 'the number' : 'the numbers'} ${section.duplicates.join(', ')} ${section.duplicates.length === 1 ? 'is' : 'are'} printed more than once`);
    if (section.headers.length === 0 && answers.length > 0) section.notes.push('the answer key has no header for this section: it was named by its marker only');
    result.sections.push(section);
  }
  if (stray.length > 0) notes.push(`${stray.length} line${stray.length === 1 ? '' : 's'} that start with a number lie in no band of the key (before the first marker or header): ${stray.slice(0, 4).map((candidate) => `"${candidate.line.text.slice(0, 30)}" on page ${candidate.page}`).join('; ')}`);
  if (layout.orphans.length > 0) notes.push(`${layout.orphans.length} line${layout.orphans.length === 1 ? '' : 's'} of the key belong to no answer: ${layout.orphans.slice(0, 4).join('; ')}${layout.orphans.length > 4 ? '; ...' : ''}`);
  const unknown = blocks.filter((block) => !blockSection.has(block)).length;
  if (unknown > 0) notes.push(`${unknown} marker or header block${unknown === 1 ? '' : 's'} of the key could not be assigned to a section`);
  return result;
}

/** The first page of an answer key found from a heading such as "Answers - Chapter 1". */
function firstAnswerPage(pages: readonly PageText[], patterns: BookPatterns): (PlaceOnPage & { evidence: string }) | undefined {
  const body = bodyFontSize(pages.filter((page) => page.hasText));
  const answers = new RegExp(`^(?:${patterns.answerWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]*\\s*(?:${patterns.chapterWords.map(escapeWord).join('|')})\\s+(?:\\d+|[IVXLC]+)\\b`, 'iu');
  for (const page of pages) {
    for (const line of page.lines) {
      if (body > 0 && line.fontSize >= body * 1.25 && answers.test(line.text.trim())) return { page: page.page, top: line.rect.top, evidence: `the heading "${line.text.trim()}" on page ${page.page}` };
    }
  }
  return undefined;
}

