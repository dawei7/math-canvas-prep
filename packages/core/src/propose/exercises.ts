import { lineStart, linesInRect } from '../geometry/snap.js';
import { INK_BANDS, type PageText, type Rect, type Region, type TextLine } from '../model/types.js';
import { AUTHORING } from '../rules/constants.js';
import { detectParts, keptDividers, type PartStyle } from './parts.js';

/**
 * Offline heuristics (no AI) that find where exercises start and where they end. Everything returns its evidence and
 * is conservative: a proposal is a starting point for a person or an agent to check, never applied silently.
 */

export type StartStyle = 'keyword' | 'number-dot' | 'number-paren' | 'paren-number' | 'section' | 'heading-number';

export interface StartCandidate {
  page: number;
  /** Index of the line in `PageText.lines`. */
  index: number;
  line: TextLine;
  style: StartStyle;
  keyword?: string;
  /** The printed number: "3", "3.2", "4a", "B". */
  number?: string;
  confidence: number;
  evidence: string[];
}

interface BlockCandidate {
  page: number;
  index: number;
  line: TextLine;
  keyword: string;
  number?: string;
  confidence: number;
  evidence: string[];
}

interface ContextCandidate {
  page: number;
  index: number;
  line: TextLine;
  numbers: string[];
  evidence: string[];
}

/** Words that open an exercise, in several languages (singular: a plural is an instruction for several exercises). */
const START_WORDS = [
  'exercise',
  'problem',
  'task',
  'question',
  'assignment',
  'aufgabe',
  'übung',
  'uebung',
  'frage',
  'exercice',
  'problème',
  'probleme',
  'ejercicio',
  'problema',
  'pregunta',
  'esercizio',
  'opgave',
  'oefening',
  'zadanie',
  'задача',
  'упражнение',
  'задание',
];
const PLURAL_WORDS = ['exercises', 'problems', 'tasks', 'questions', 'assignments', 'aufgaben', 'übungen', 'uebungen', 'exercices', 'ejercicios', 'problemas', 'esercizi'];

/** Words that open an instruction printed once for several exercises. */
const CONTEXT_WORDS = ['instructions', 'instruction', 'directions', 'hinweise', 'hinweis', 'anleitung', 'vorbemerkung', 'angaben', 'consignes', 'consigne', 'instrucciones', 'istruzioni', 'general instructions'];

/** Words that open a definition, theorem or remark: proposed as bookmarks, and they end an exercise. */
const BLOCK_WORDS = [
  'definition',
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'remark',
  'example',
  'satz',
  'bemerkung',
  'beispiel',
  'folgerung',
  'korollar',
  'définition',
  'théorème',
  'ejemplo',
  'teorema',
  'definizione',
];

/** Words that open a chapter or section: they end an exercise and are never an exercise themselves. */
const HEADING_WORDS = ['chapter', 'section', 'part', 'appendix', 'kapitel', 'abschnitt', 'teil', 'anhang', 'chapitre', 'capítulo', 'capitolo'];

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_START = new RegExp(`^(${[...START_WORDS, ...PLURAL_WORDS].map(escape).join('|')})\\b[\\s.]*(?:no\\.?|nr\\.?|number|#)?\\s*(\\S+)?`, 'iu');
const BLOCK_START = new RegExp(`^(${BLOCK_WORDS.map(escape).join('|')})\\b\\s*(\\d+(?:\\.\\d+)*)?`, 'iu');
const HEADING_START = new RegExp(`^(${HEADING_WORDS.map(escape).join('|')})\\s+(\\d+|[IVXL]+|[A-Z])\\b`, 'iu');
const CONTEXT_START = new RegExp(`^(${CONTEXT_WORDS.map(escape).join('|')})\\b`, 'iu');
const PLURAL_LIST = new RegExp(`(?:${PLURAL_WORDS.map(escape).join('|')})\\s+(\\d{1,3}[a-z]?(?:\\s*(?:,|;|and|und|et|y|e|&|to|bis|à|a|-|–|—)\\s*\\d{1,3}[a-z]?)*)`, 'iu');

interface Classified {
  style: StartStyle;
  keyword?: string;
  number?: string;
  base: number;
  reason: string;
  plural?: boolean;
}

function classify(text: string): Classified | undefined {
  if (/\.{4,}\s*\d+\s*$/.test(text) || /(?:\s\.){4,}/.test(text)) return undefined;
  const word = WORD_START.exec(text);
  if (word) {
    const keyword = (word[1] as string).toLowerCase();
    const token = (word[2] ?? '').replace(/[.:)\],;]+$/, '');
    const numeric = /^\d{1,3}(?:\.\d{1,3})*[a-z]?$/.exec(token);
    const roman = /^(?:[IVXL]{1,5}|[A-Z])$/.exec(token);
    if (numeric || roman) {
      const plural = PLURAL_WORDS.includes(keyword);
      return {
        style: 'keyword',
        keyword,
        number: token,
        base: plural ? 0.3 : 0.9,
        plural,
        reason: plural
          ? `starts with the plural word "${keyword}" and ${token}: probably an instruction for several exercises (context), not the start of one`
          : `starts with the word "${keyword}" followed by the number ${token}`,
      };
    }
  }
  let match = /^§\s*(\d+(?:\.\d+)*)/.exec(text);
  if (match) return { style: 'section', number: match[1] as string, base: 0.3, reason: `starts with § ${match[1] as string}: usually a section heading` };
  match = /^\((\d{1,3})\)\s+\S/.exec(text);
  if (match) return { style: 'paren-number', number: match[1] as string, base: 0.4, reason: `starts with "(${match[1] as string})"` };
  match = /^(\d{1,3})\)\s+\S/.exec(text);
  if (match) return { style: 'number-paren', number: match[1] as string, base: 0.5, reason: `starts with "${match[1] as string})"` };
  match = /^(\d{1,3})\.\s+(\S)/.exec(text);
  if (match) {
    const lower = /\p{Ll}/u.test(match[2] as string) && !/[\d(\\[]/.test(match[2] as string);
    return { style: 'number-dot', number: match[1] as string, base: lower ? 0.5 : 0.55, reason: `starts with the number "${match[1] as string}."` };
  }
  match = /^(\d{1,2}(?:\.\d{1,2}){1,3})\.?\s+\S/.exec(text);
  if (match) return { style: 'heading-number', number: match[1] as string, base: 0.25, reason: `starts with the section number ${match[1] as string}: usually a heading` };
  return undefined;
}

/** The exercise numbers an instruction names: "Exercises 3 and 4" gives 3, 4; "Aufgaben 2-5" gives 2, 3, 4, 5. */
export function numbersNamedIn(text: string): string[] {
  const match = PLURAL_LIST.exec(text);
  if (!match) return [];
  const list = match[1] as string;
  const tokens = list.split(/\s*(?:,|;|\band\b|\bund\b|\bet\b|\by\b|\be\b|&)\s*/i).filter((token) => token.length > 0);
  const numbers: string[] = [];
  for (const token of tokens) {
    const range = /^(\d{1,3})\s*(?:to|bis|à|a|-|–|—)\s*(\d{1,3})$/i.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 40) for (let n = from; n <= to; n += 1) numbers.push(String(n));
      continue;
    }
    const single = /^(\d{1,3}[a-z]?)$/.exec(token);
    if (single) numbers.push(single[1] as string);
  }
  return [...new Set(numbers)];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** The font size most text is set in (weighted by characters), ignoring running headers and footers. */
export function bodyFontSize(pages: readonly PageText[]): number {
  const weights = new Map<number, number>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.headerFooter === true) continue;
      const size = Math.round(line.fontSize * 2) / 2;
      weights.set(size, (weights.get(size) ?? 0) + line.chars);
    }
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

interface FlowLine {
  page: number;
  index: number;
  line: TextLine;
}

function isHeadingLine(line: TextLine, body: number, classified: Classified | undefined): boolean {
  if (body > 0 && line.fontSize >= body * 1.2 && line.chars <= 100) return true;
  if (HEADING_START.test(line.text) && line.chars <= 100) return true;
  if (classified?.style === 'heading-number' && body > 0 && line.fontSize >= body * 1.05 && line.chars <= 100) return true;
  return false;
}

/**
 * Candidate exercise starts: lines that begin with "Exercise 3", "Aufgabe 3", "3.", "3)" and similar, each with a
 * confidence and the reasons. Sequences that count up, aligned starts and keyword starts raise the confidence;
 * isolated, indented or heading-like lines lower it.
 */
export function findStartCandidates(pages: readonly PageText[]): {
  starts: StartCandidate[];
  blocks: BlockCandidate[];
  contexts: ContextCandidate[];
} {
  const body = bodyFontSize(pages);
  const starts: StartCandidate[] = [];
  const blocks: BlockCandidate[] = [];
  const contexts: ContextCandidate[] = [];
  const leftByPage = new Map<number, number>();
  for (const page of pages) {
    const lefts = page.lines.filter((line) => line.headerFooter !== true && line.chars >= 20).map((line) => line.rect.left);
    const middle = median(lefts);
    leftByPage.set(page.page, lefts.length > 0 ? median(lefts.filter((value) => value <= middle + 0.02)) : 0);
  }
  for (const page of pages) {
    page.lines.forEach((line, index) => {
      if (line.headerFooter === true) return;
      const classified = classify(line.text);
      const block = BLOCK_START.exec(line.text);
      if (block) {
        const keyword = (block[1] as string).toLowerCase();
        const number = block[2];
        const after = line.text.slice(block[0].length).trim();
        // "Note that ..." is a sentence; "Definition 5.1 (Derivative)" and "Remark." are blocks.
        if (number !== undefined || /^[.:(]/.test(after) || after.length === 0) {
          blocks.push({
            page: page.page,
            index,
            line,
            keyword,
            ...(number !== undefined ? { number } : {}),
            confidence: number !== undefined ? 0.6 : 0.5,
            evidence: [`starts with the word "${keyword}"${number !== undefined ? ` and the number ${number}` : ''}`],
          });
        }
      }
      if (CONTEXT_START.test(line.text) || classified?.plural === true) {
        contexts.push({
          page: page.page,
          index,
          line,
          numbers: numbersNamedIn(line.text),
          evidence: [classified?.plural ? 'starts with a plural exercise word and numbers: an instruction for several exercises' : 'starts with an instruction word'],
        });
        return;
      }
      if (!classified) return;
      const candidate: StartCandidate = {
        page: page.page,
        index,
        line,
        style: classified.style,
        ...(classified.keyword !== undefined ? { keyword: classified.keyword } : {}),
        ...(classified.number !== undefined ? { number: classified.number } : {}),
        confidence: classified.base,
        evidence: [classified.reason],
      };
      const bodyLeft = leftByPage.get(page.page) ?? 0;
      if (line.rect.left > bodyLeft + 0.06) {
        candidate.confidence -= 0.2;
        candidate.evidence.push(`indented (left ${line.rect.left.toFixed(3)} vs ${bodyLeft.toFixed(3)} for the body): probably inside a paragraph or a list`);
      }
      if (body > 0 && line.fontSize >= body * 1.2 && classified.style !== 'keyword') {
        candidate.confidence -= 0.15;
        candidate.evidence.push('set larger than the body text: probably a heading');
      }
      starts.push(candidate);
    });
  }

  // Sequences: numbers that count up by one in reading order, per style (and keyword).
  const groups = new Map<string, StartCandidate[]>();
  for (const candidate of starts) {
    const key = `${candidate.style}:${candidate.keyword ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(candidate);
    else groups.set(key, [candidate]);
  }
  for (const list of groups.values()) {
    const runs: StartCandidate[][] = [];
    for (const candidate of list) {
      const current = runs[runs.length - 1];
      const last = current?.[current.length - 1];
      const n = Number.parseFloat(candidate.number ?? '');
      const lastN = Number.parseFloat(last?.number ?? '');
      const counts = Number.isFinite(n) && Number.isFinite(lastN) && (n === lastN + 1 || (/\./.test(candidate.number ?? '') && Math.floor(n) === Math.floor(lastN)));
      if (current && counts) current.push(candidate);
      else runs.push([candidate]);
    }
    for (const run of runs) {
      const strong = run[0]?.style === 'keyword' ? 0.06 : 0.25;
      if (run.length >= 3) {
        for (const candidate of run) {
          candidate.confidence += strong;
          candidate.evidence.push(`part of a run of ${run.length} numbers that count up (${run[0]?.number}..${run[run.length - 1]?.number})`);
        }
      } else if (run.length === 2) {
        for (const candidate of run) {
          candidate.confidence += strong / 2;
          candidate.evidence.push('next to a consecutive number');
        }
      } else if (list.length >= 4 && run[0]?.style !== 'keyword') {
        const only = run[0] as StartCandidate;
        only.confidence -= 0.15;
        only.evidence.push('its number does not follow the numbers around it');
      }
    }
  }
  for (const candidate of starts) candidate.confidence = Math.min(0.99, Math.max(0, Math.round(candidate.confidence * 100) / 100));
  return { starts, blocks, contexts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Extents

export interface PartsProposal {
  style: PartStyle;
  markers: { text: string; ordinal: number; y: number }[];
  /** Where each part after the first starts. */
  dividers: number[];
  /** Where the first part starts when its marker has a line of its own. */
  first?: number;
  /** The statement above the first part, as a rectangle (a candidate for context). */
  preamble?: Rect;
  evidence: string[];
}

export interface FrameProposal {
  /** `p1`, `p2`, ... in reading order. */
  id: string;
  kind: 'exercise' | 'bookmark';
  page: number;
  rect: Rect;
  continues?: Region[];
  /** The text of the first line. */
  title: string;
  /** The printed number of an exercise ("3", "4a"), when it has one. */
  number?: string;
  confidence: number;
  evidence: string[];
  parts?: PartsProposal;
}

/** An instruction printed once for several exercises (context), with the exercises it names. */
export interface ContextProposal {
  /** `c1`, `c2`, ... */
  id: string;
  page: number;
  rect: Rect;
  text: string;
  /** Printed exercise numbers named in the text. */
  numbers: string[];
  /** Ids of the exercise proposals (`p3`) that carry one of those numbers and follow the instruction. */
  appliesTo: string[];
  confidence: number;
  evidence: string[];
}

export interface ProposeOptions {
  /** Proposals below this confidence are listed as `rejected` only (default 0.5). */
  minConfidence?: number;
  /** Which pages to look at (zero-based); default all. */
  pages?: readonly number[];
  /** Propose definitions, theorems and remarks as bookmarks (default true). */
  bookmarks?: boolean;
}

export interface ProposalSet {
  proposals: FrameProposal[];
  contexts: ContextProposal[];
  /** Candidates below the confidence threshold, for a second look. */
  rejected: { page: number; text: string; confidence: number; evidence: string[] }[];
  bodyFontSize: number;
  notes: string[];
}

const PAD = 0.012;

/** A band counts as inked when at least this share of the page width is dark there. */
const INK_THRESHOLD = 0.004;

/** The y of the lowest inked band between two positions (a figure, a table), or undefined when the space is blank. */
function lowestInk(ink: readonly number[], from: number, to: number): number | undefined {
  const first = Math.max(0, Math.ceil(from * INK_BANDS));
  for (let band = Math.min(INK_BANDS - 1, Math.floor(to * INK_BANDS)); band >= first; band -= 1) {
    if ((ink[band] ?? 0) >= INK_THRESHOLD) return (band + 1) / INK_BANDS;
  }
  return undefined;
}

/** Where the body text of a page ends: just above its footer, or near the bottom. */
function contentLimit(page: PageText | undefined): number {
  const footers = (page?.lines ?? []).filter((line) => line.headerFooter === true && line.rect.top > 0.5).map((line) => line.rect.top);
  return footers.length > 0 ? Math.min(...footers) - AUTHORING.startPadding : 0.96;
}

function bodyBox(lines: readonly FlowLine[]): Map<string, { left: number; right: number }> {
  const boxes = new Map<string, { left: number; right: number }>();
  for (const { page, line } of lines) {
    const key = `${page}:${line.column}`;
    const box = boxes.get(key);
    if (box) {
      box.left = Math.min(box.left, line.rect.left);
      box.right = Math.max(box.right, line.rect.right);
    } else boxes.set(key, { left: line.rect.left, right: line.rect.right });
  }
  for (const box of boxes.values()) {
    box.left = Math.max(0, box.left - PAD);
    box.right = Math.min(1, box.right + PAD);
  }
  return boxes;
}

type BuildKind = 'exercise' | 'bookmark' | 'context';

interface Built {
  page: number;
  rect: Rect;
  continues: Region[];
  title: string;
  evidence: string[];
}

/**
 * Exercises (and, optionally, definitions, theorems and remarks as bookmarks) with their extents: an exercise runs from
 * its start line to just above the next start, heading, definition or instruction, without running headers and
 * footers; a task that continues on the next page (or in the next column) gets a continuation region. Inside every
 * exercise the part markers (a), (b), (c) are looked for. Instructions printed for several exercises are proposed as
 * context with the exercises they name.
 */
export function proposeFrames(allPages: readonly PageText[], options: ProposeOptions = {}): ProposalSet {
  const minConfidence = options.minConfidence ?? 0.5;
  const notes: string[] = [];
  const wanted = options.pages ? new Set(options.pages) : undefined;
  const pages = allPages.filter((page) => (wanted ? wanted.has(page.page) : true));
  const withText = pages.filter((page) => page.hasText);
  if (withText.length === 0) {
    return {
      proposals: [],
      contexts: [],
      rejected: [],
      bodyFontSize: 0,
      notes: ['None of these pages has a text layer (a scan?), so nothing can be proposed. Render the pages with a grid and mark them by eye.'],
    };
  }
  const found = findStartCandidates(withText);
  const body = bodyFontSize(withText);
  const accepted = found.starts.filter((candidate) => candidate.confidence >= minConfidence);
  const rejected = found.starts
    .filter((candidate) => candidate.confidence < minConfidence && candidate.confidence >= 0.2)
    .map((candidate) => ({ page: candidate.page, text: candidate.line.text.slice(0, 80), confidence: candidate.confidence, evidence: candidate.evidence }));

  // One flow of body lines in reading order across the pages.
  const flow: FlowLine[] = [];
  for (const page of withText) page.lines.forEach((line, index) => { if (line.headerFooter !== true) flow.push({ page: page.page, index, line }); });
  const position = new Map<FlowLine, number>(flow.map((entry, index) => [entry, index]));
  const boxes = bodyBox(flow);
  const pageOf = new Map<number, PageText>(withText.map((page) => [page.page, page]));
  const key = (entry: FlowLine): string => `${entry.page}:${entry.index}`;
  const startAt = new Map<string, StartCandidate>(accepted.map((candidate) => [`${candidate.page}:${candidate.index}`, candidate]));
  const blockAt = new Map<string, BlockCandidate>(found.blocks.map((block) => [`${block.page}:${block.index}`, block]));
  const contextAt = new Map<string, ContextCandidate>(found.contexts.map((entry) => [`${entry.page}:${entry.index}`, entry]));

  // Typical distance between consecutive lines, to recognise a paragraph gap.
  const pitches: number[] = [];
  for (let i = 1; i < flow.length; i += 1) {
    const a = flow[i - 1] as FlowLine;
    const b = flow[i] as FlowLine;
    if (a.page === b.page && a.line.column === b.line.column) pitches.push(b.line.rect.top - a.line.rect.top);
  }
  const pitch = median(pitches.filter((value) => value > 0));

  const isStop = (entry: FlowLine): boolean => {
    const k = key(entry);
    if (startAt.has(k) || blockAt.has(k) || contextAt.has(k)) return true;
    return isHeadingLine(entry.line, body, classify(entry.line.text));
  };

  const build = (kind: BuildKind, from: number): Built => {
    const first = flow[from] as FlowLine;
    const included: FlowLine[] = [first];
    let ended = '';
    const loose = kind === 'exercise';
    for (let i = from + 1; i < flow.length; i += 1) {
      const entry = flow[i] as FlowLine;
      const previous = flow[i - 1] as FlowLine;
      if (isStop(entry)) {
        ended = `stops before the line "${entry.line.text.slice(0, 40)}"`;
        break;
      }
      const sameFlow = entry.page === previous.page && entry.line.column === previous.line.column;
      if (!loose && sameFlow && pitch > 0 && entry.line.rect.top - previous.line.rect.top > 1.7 * pitch) {
        ended = 'stops at a paragraph gap';
        break;
      }
      if (!sameFlow) {
        if (!loose) {
          ended = 'stops at the end of the page';
          break;
        }
        const regions = new Set(included.map((item) => `${item.page}:${item.line.column}`));
        if (regions.size >= 4) {
          ended = 'stops after three continuation regions';
          break;
        }
      }
      included.push(entry);
    }
    if (ended === '' && from + included.length >= flow.length) ended = 'runs to the last line of the document';
    // Regions: one per page and column.
    const regions: { page: number; column: number; lines: FlowLine[] }[] = [];
    for (const entry of included) {
      const last = regions[regions.length - 1];
      if (last && last.page === entry.page && last.column === entry.line.column) last.lines.push(entry);
      else regions.push({ page: entry.page, column: entry.line.column, lines: [entry] });
    }
    const rects: Region[] = regions.map((region) => {
      const box = boxes.get(`${region.page}:${region.column}`) ?? { left: 0, right: 1 };
      const firstLine = (region.lines[0] as FlowLine).line;
      const lastEntry = region.lines[region.lines.length - 1] as FlowLine;
      const top = lineStart(firstLine, AUTHORING.startPadding, pageOf.get(region.page)?.lines);
      const lastText = lastEntry.line.rect.bottom;
      let bottom = Math.min(1, lastText + AUTHORING.endPadding);
      const next = flow[(position.get(lastEntry) as number) + 1];
      const nextInRegion = next !== undefined && next.page === region.page && next.line.column === region.column;
      const limit = nextInRegion ? lineStart((next as FlowLine).line, AUTHORING.startPadding, pageOf.get(region.page)?.lines) : contentLimit(pageOf.get(region.page));
      if (loose) {
        // An exercise reaches down over a figure or a table below its last line of text, but not over blank answer space.
        const ink = pageOf.get(region.page)?.ink;
        const lowest = ink ? lowestInk(ink, lastText, limit) : undefined;
        if (lowest !== undefined) bottom = Math.max(bottom, Math.min(limit, lowest + AUTHORING.endPadding));
      } else if (nextInRegion) {
        bottom = Math.min(bottom, limit);
      }
      bottom = Math.max(bottom, top + AUTHORING.minPieceHeight);
      return { page: region.page, rect: { left: box.left, top, right: box.right, bottom } };
    });
    const main = rects[0] as Region;
    const evidence = [ended === '' ? 'ends at the last line of its page' : `ends where it ${ended}`];
    if (rects.length > 1) {
      evidence.push(
        `continues in ${rects.length - 1} further region${rects.length === 2 ? '' : 's'} (${rects.slice(1).map((r) => `page ${r.page}`).join(', ')}), because the text goes on without a new marker`,
      );
    }
    return { page: main.page, rect: main.rect, continues: rects.slice(1, 9), title: first.line.text.slice(0, 80), evidence };
  };

  const proposals: FrameProposal[] = [];
  const numberOf: { proposal: FrameProposal; flowIndex: number }[] = [];
  flow.forEach((entry, index) => {
    const k = key(entry);
    const start = startAt.get(k);
    const block = blockAt.get(k);
    if (start) {
      const built = build('exercise', index);
      const proposal: FrameProposal = {
        id: '',
        kind: 'exercise',
        page: built.page,
        rect: built.rect,
        title: built.title,
        ...(start.number !== undefined ? { number: start.number } : {}),
        confidence: start.confidence,
        evidence: [...start.evidence, ...built.evidence],
      };
      if (built.continues.length > 0) {
        proposal.continues = built.continues;
        proposal.confidence = Math.max(0, Math.round((start.confidence - 0.1) * 100) / 100);
      } else {
        const inside = linesInRect(withText.find((p) => p.page === built.page)?.lines ?? [], built.rect).filter((line) => line.headerFooter !== true);
        const detection = detectParts(inside);
        if (detection) {
          const kept = keptDividers(built.rect, detection.dividers);
          if (kept.length >= 1) {
            const parts: PartsProposal = {
              style: detection.style,
              markers: detection.markers.map((marker) => ({ text: marker.text, ordinal: marker.ordinal, y: marker.line.rect.top })),
              dividers: kept,
              evidence: detection.evidence,
            };
            if (detection.firstStart !== undefined && detection.firstStart - built.rect.top >= AUTHORING.minPieceHeight) {
              parts.first = detection.firstStart;
              parts.preamble = { left: built.rect.left, top: built.rect.top, right: built.rect.right, bottom: detection.firstStart };
            }
            proposal.parts = parts;
          }
        }
      }
      proposals.push(proposal);
      numberOf.push({ proposal, flowIndex: index });
    } else if (block && block.keyword !== 'proof' && options.bookmarks !== false) {
      const built = build('bookmark', index);
      proposals.push({
        id: '',
        kind: 'bookmark',
        page: built.page,
        rect: built.rect,
        title: built.title,
        confidence: block.confidence,
        evidence: [...block.evidence, ...built.evidence],
      });
    }
  });
  proposals.forEach((proposal, index) => {
    proposal.id = `p${index + 1}`;
  });

  const contexts: ContextProposal[] = [];
  flow.forEach((entry, index) => {
    const candidate = contextAt.get(key(entry));
    if (!candidate) return;
    const built = build('context', index);
    const text = flow
      .slice(index, index + 4)
      .filter((line) => line.page === built.page)
      .map((line) => line.line.text)
      .join(' ')
      .slice(0, 160);
    const numbers = candidate.numbers.length > 0 ? candidate.numbers : numbersNamedIn(text);
    const appliesTo = numberOf
      .filter((item) => item.flowIndex > index && item.proposal.number !== undefined && numbers.includes(item.proposal.number))
      .map((item) => item.proposal.id);
    contexts.push({
      id: `c${contexts.length + 1}`,
      page: built.page,
      rect: built.rect,
      text,
      numbers,
      appliesTo,
      confidence: appliesTo.length > 0 ? 0.8 : 0.4,
      evidence: [
        ...candidate.evidence,
        numbers.length > 0 ? `names the exercise${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}` : 'names no exercise number: attach it by hand to the exercises it belongs to',
        ...built.evidence,
      ],
    });
  });
  if (proposals.length === 0) notes.push('No line looks like the start of an exercise. Try a lower --min-confidence, or mark the pages by eye with `render --grid`.');
  return { proposals, contexts, rejected, bodyFontSize: body, notes };
}
