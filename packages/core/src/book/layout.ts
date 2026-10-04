import { lineStart } from '../geometry/snap.js';
import { INK_BANDS, type PageText, type Rect, type Region, type TextLine } from '../model/types.js';
import { AUTHORING } from '../rules/constants.js';
import { isRunningLine } from './scan.js';

/**
 * What the exercises of a practice set and the answers of an answer key have in common: lines that start with a
 * printed number, the sequence those numbers must form, the bands and columns of a page, the lines that belong to
 * an item (continuations, the rows of a fraction, the labels of a figure, the lines on the next page) and the frame
 * that results. See `exercises.ts` and `solutions.ts`.
 */

export interface RejectedStart {
  page: number;
  text: string;
  reason: string;
}

export interface ItemPattern {
  /** For the evidence: how the numbers look. */
  name: string;
  /** Group 1 is the printed label (without the closing mark); group 2 the text after it. */
  regex: RegExp;
}

export interface Candidate {
  label: string;
  n: number;
  suffix: string;
  /** The printed number with its marks ("5)", "(5)"). */
  lead: string;
  rest: string;
  page: number;
  index: number;
  line: TextLine;
  weak: boolean;
}

export interface PLine {
  page: number;
  index: number;
  line: TextLine;
  role: 'start' | 'instruction' | 'other';
  candidate?: Candidate;
  block?: Block;
}

export interface Block {
  lines: PLine[];
  /** Lines of the block per page. */
  pages: Map<number, PLine[]>;
  /** Whether no item follows the block on the last page it touches. */
  openAtEnd: boolean;
}

export interface ItemAcc {
  candidate: Candidate;
  start: PLine;
  own: PLine[];
  extra: Map<number, PLine[]>;
  band: number;
  column: number;
  page: number;
  figure: boolean;
  block: Block | undefined;
}

export const PAD = 0.012;
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
export const round = (value: number): number => Math.round(value * 10000) / 10000;
export const FIGURE_SHORT = 14;
const INK_THRESHOLD = 0.004;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Values grouped into clusters whose members lie within `tolerance` of the cluster's first value. */
export function cluster(values: readonly number[], tolerance: number): { center: number; count: number }[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: { sum: number; count: number; first: number }[] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last.first <= tolerance) {
      last.sum += value;
      last.count += 1;
    } else clusters.push({ sum: value, count: 1, first: value });
  }
  return clusters.map((entry) => ({ center: entry.sum / entry.count, count: entry.count }));
}

/** The y where the body text of a page ends: just above its footer, or near the bottom. */
export function contentLimit(page: PageText | undefined): number {
  const footers = (page?.lines ?? []).filter((line) => line.headerFooter === true && line.rect.top > 0.85).map((line) => line.rect.top);
  return footers.length > 0 ? Math.min(...footers) - AUTHORING.startPadding : 0.96;
}

/** The y of the lowest inked band between two positions, or undefined when the space is blank. */
export function lowestInk(ink: readonly number[], from: number, to: number): number | undefined {
  const first = Math.max(0, Math.ceil(from * INK_BANDS));
  for (let band = Math.min(INK_BANDS - 1, Math.floor(to * INK_BANDS)); band >= first; band -= 1) {
    if ((ink[band] ?? 0) >= INK_THRESHOLD) return (band + 1) / INK_BANDS;
  }
  return undefined;
}

/**
 * The text extraction sometimes joins the two items of one row of a two-column list into one line ("5) first 6)
 * second"), when the gap between the columns is not wide enough to be seen as a gutter. Such a line is cut again where
 * the next number begins; the cut sits on the left edge of the column that other items start at, else where the text
 * says. Only a line that starts with a number and holds larger numbers at the position of a column is cut.
 */
export function explodeMergedRows(lines: readonly PLine[]): PLine[] {
  const numbered = lines.filter((entry) => /^\s*\d{1,3}[).]/.test(entry.line.text));
  if (numbered.length < 4) return [...lines];
  // The columns that items start at: left edges that several lines share.
  const columns = cluster(
    numbered.map((entry) => entry.line.rect.left),
    0.02,
  ).filter((column) => column.count >= 3);
  if (columns.length < 2) return [...lines];
  const result: PLine[] = [];
  for (const entry of lines) {
    const text = entry.line.text;
    const first = /^\s*(\d{1,3})[).]/.exec(text);
    if (!first || entry.line.rect.right - entry.line.rect.left < 0.3) {
      result.push(entry);
      continue;
    }
    const { left, right } = entry.line.rect;
    const cuts: { at: number; boundary: number }[] = [];
    let expected = Number(first[1]);
    let pieceLeft = left;
    const embedded = /(?<=\s)(\d{1,3})[).](?=\s)/g;
    let found: RegExpExecArray | null;
    while ((found = embedded.exec(text)) !== null) {
      const n = Number(found[1]);
      // Along the rows the next number is 1 to 3 further; down flowing columns it is a whole column further.
      if (n <= expected || n - expected > 80 || found.index <= 3) continue;
      // The cut has to fall on a column where other items start; a number inside a sentence does not.
      const estimate = left + ((right - left) * found.index) / Math.max(1, text.length);
      const column = columns
        .filter((candidate) => candidate.center > pieceLeft + 0.1 && candidate.center < right && Math.abs(candidate.center - estimate) <= 0.12)
        .sort((a, b) => Math.abs(a.center - estimate) - Math.abs(b.center - estimate))[0];
      if (!column) continue;
      cuts.push({ at: found.index, boundary: column.center });
      expected = n;
      pieceLeft = column.center;
    }
    if (cuts.length === 0) {
      result.push(entry);
      continue;
    }
    let from = 0;
    let start = left;
    cuts.forEach((cut, k) => {
      result.push(piece(entry, text.slice(from, cut.at).trim(), start, cut.boundary - 0.01, k));
      from = cut.at;
      start = cut.boundary;
    });
    result.push(piece(entry, text.slice(from).trim(), start, right, cuts.length));
  }
  return result;
}

function piece(entry: PLine, text: string, left: number, right: number, k: number): PLine {
  const line: TextLine = { ...entry.line, text, chars: text.replace(/\s/g, '').length, rect: { ...entry.line.rect, left, right: Math.max(right, left + 0.02) } };
  return { page: entry.page, index: entry.index + k * 0.001, line, role: 'other' };
}

export function findCandidates(lines: readonly PLine[], patterns: readonly ItemPattern[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entry of lines) {
    const text = entry.line.text.trim();
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const label = match[1] as string;
      const n = Number.parseInt(label, 10);
      if (!Number.isFinite(n) || n < 1) break;
      const rest = (match[2] ?? '').trim();
      found.push({ label, n, suffix: label.replace(/^\d+/, ''), lead: text.slice(0, text.length - rest.length).trim(), rest, page: entry.page, index: entry.index, line: entry.line, weak: false });
      break;
    }
  }
  return found;
}

export interface Selection {
  chosen: Candidate[];
  rejected: RejectedStart[];
  gaps: string[];
  duplicates: string[];
  weak: Candidate[];
}


export function selectSequence(candidates: readonly Candidate[], lines: readonly PLine[]): Selection {
  const rejected: RejectedStart[] = [];
  const reject = (candidate: Candidate, reason: string): void => {
    rejected.push({ page: candidate.page, text: candidate.line.text.slice(0, 60), reason });
  };
  const clusters = cluster(candidates.map((candidate) => candidate.line.rect.left), 0.02);
  const total = candidates.length;
  const significant = clusters.filter((entry) => total <= 3 || entry.count >= Math.max(3, Math.ceil(0.08 * total)));
  const aligned = (left: number): boolean => clusters.some((entry) => Math.abs(entry.center - left) <= 0.025);
  // A number slightly to the right of the main columns is an indented line of a paragraph, not an item.
  const good = candidates.filter((candidate) => {
    const left = candidate.line.rect.left;
    const parent = significant.find((entry) => left - entry.center > 0.012 && left - entry.center <= 0.09);
    if (!parent) return true;
    reject(candidate, `indented (left ${round(left)}, the numbers start at ${round(parent.center)}): probably inside a paragraph`);
    return false;
  });
  // One candidate per label; a duplicate keeps the one on the page of its neighbours.
  const byLabel = new Map<string, Candidate[]>();
  for (const candidate of good) byLabel.set(candidate.label, [...(byLabel.get(candidate.label) ?? []), candidate]);
  const chosen = new Map<string, Candidate>();
  const duplicates: string[] = [];
  for (const [label, list] of byLabel) if (list.length === 1) chosen.set(label, list[0] as Candidate);
  for (const [label, list] of byLabel) {
    if (list.length < 2) continue;
    duplicates.push(label);
    const n = (list[0] as Candidate).n;
    const pagesNear = [...chosen.values()].filter((other) => Math.abs(other.n - n) <= 2).map((other) => other.page);
    const distance = (candidate: Candidate): number => (pagesNear.length > 0 ? Math.min(...pagesNear.map((p) => Math.abs(p - candidate.page))) : 0);
    const best = [...list].sort((a, b) => distance(a) - distance(b) || a.page - b.page || a.line.rect.top - b.line.rect.top)[0] as Candidate;
    chosen.set(label, best);
    for (const other of list) if (other !== best) reject(other, `the number ${label} is printed more than once; the one next to its neighbours was used`);
  }
  // The main run of numbers: break at jumps of more than 3 and keep the longest chain.
  const ordered = [...chosen.values()].sort((a, b) => a.n - b.n || a.suffix.localeCompare(b.suffix));
  const chains: Candidate[][] = [];
  for (const candidate of ordered) {
    const chain = chains[chains.length - 1];
    const last = chain?.[chain.length - 1];
    if (chain && last && candidate.n - last.n <= 3) chain.push(candidate);
    else chains.push([candidate]);
  }
  const main = [...chains].sort((a, b) => b.length - a.length)[0] ?? [];
  // Chains of two or more numbers are kept (a few items lost to a garbled line leave short runs); a single number far
  // from the others is put aside.
  for (const chain of chains) {
    if (chain === main || chain.length >= 2) continue;
    for (const candidate of chain) {
      chosen.delete(candidate.label);
      reject(candidate, `its number ${candidate.label} does not belong to the run ${(main[0] as Candidate | undefined)?.label ?? '?'}..${(main[main.length - 1] as Candidate | undefined)?.label ?? '?'}`);
    }
  }
  // Gaps in the run, and a second look for the missing numbers.
  const numeric = [...chosen.values()].filter((candidate) => candidate.suffix === '').sort((a, b) => a.n - b.n);
  const gaps: string[] = [];
  const weak: Candidate[] = [];
  if (numeric.length >= 2) {
    const have = new Set(numeric.map((candidate) => candidate.n));
    const low = (numeric[0] as Candidate).n;
    const high = (numeric[numeric.length - 1] as Candidate).n;
    const pageOf = (n: number): number | undefined => numeric.find((candidate) => candidate.n === n)?.page;
    const taken = new Set([...chosen.values()].map((candidate) => `${candidate.page}:${candidate.index}`));
    for (let n = low; n <= high; n += 1) {
      if (have.has(n)) continue;
      const before = pageOf(n - 1);
      const after = pageOf(n + 1);
      // A number printed without its closing mark ("33 (2)(3)") or lost in the text layer.
      const loose = new RegExp(`^(${n})(?=\\s+\\S)\\s*(.*)$`);
      const found = lines.find((entry) => {
        if (taken.has(`${entry.page}:${entry.index}`) || !aligned(entry.line.rect.left)) return false;
        if (before !== undefined && entry.page < before) return false;
        if (after !== undefined && entry.page > after) return false;
        return loose.test(entry.line.text.trim());
      });
      if (found) {
        const text = found.line.text.trim();
        const match = loose.exec(text) as RegExpExecArray;
        const rest = (match[2] ?? '').trim();
        const candidate: Candidate = { label: String(n), n, suffix: '', lead: String(n), rest, page: found.page, index: found.index, line: found.line, weak: true };
        chosen.set(candidate.label, candidate);
        weak.push(candidate);
      } else gaps.push(String(n));
    }
  }
  return { chosen: [...chosen.values()].sort((a, b) => a.n - b.n || a.suffix.localeCompare(b.suffix)), rejected, gaps, duplicates, weak };
}

/** Groups instruction lines into blocks; a block that ends a page and goes on at the top of the next page is one block. */
export function buildBlocks(lines: readonly PLine[], pitch: number): Block[] {
  const blocks: Block[] = [];
  const pageList = [...new Set(lines.map((entry) => entry.page))].sort((a, b) => a - b);
  let open: Block | undefined;
  for (const page of pageList) {
    const onPage = lines.filter((entry) => entry.page === page);
    const instruction = onPage.filter((entry) => entry.role === 'instruction').sort((a, b) => a.line.rect.top - b.line.rect.top || a.line.rect.left - b.line.rect.left);
    const firstOther = onPage.filter((entry) => entry.role !== 'instruction').reduce((top, entry) => Math.min(top, entry.line.rect.top), Infinity);
    const starts = onPage.filter((entry) => entry.role === 'start');
    let group: PLine[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      const atTop = group[0] === instruction[0] && group.every((entry) => entry.line.rect.top < firstOther);
      let block: Block;
      if (atTop && open) {
        block = open;
        block.lines.push(...group);
      } else {
        block = { lines: [...group], pages: new Map(), openAtEnd: false };
        blocks.push(block);
      }
      for (const entry of group) {
        entry.block = block;
        block.pages.set(page, [...(block.pages.get(page) ?? []), entry]);
      }
      const last = group[group.length - 1] as PLine;
      block.openAtEnd = !starts.some((entry) => entry.line.rect.top > last.line.rect.top);
      open = block.openAtEnd ? block : undefined;
      group = [];
    };
    for (const entry of instruction) {
      const last = group[group.length - 1];
      if (last && entry.line.rect.top - last.line.rect.bottom > 1.5 * pitch) flush();
      group.push(entry);
    }
    flush();
    if (instruction.length === 0 && starts.length > 0) open = undefined;
  }
  return blocks;
}

export const blockText = (block: Block): string => block.lines.map((entry) => entry.line.text.trim()).join(' ').replace(/\s+/g, ' ');

export function blockRegions(block: Block, pages: readonly PageText[]): Region[] {
  const regions: Region[] = [];
  for (const [page, entries] of [...block.pages].sort((a, b) => a[0] - b[0])) {
    const top = Math.min(...entries.map((entry) => entry.line.rect.top));
    const first = entries.find((entry) => entry.line.rect.top === top) as PLine;
    regions.push({
      page,
      rect: {
        left: round(clamp01(Math.min(...entries.map((entry) => entry.line.rect.left)) - PAD)),
        top: round(clamp01(lineStart(first.line, AUTHORING.startPadding, pages[page]?.lines))),
        right: round(clamp01(Math.max(...entries.map((entry) => entry.line.rect.right)) + PAD)),
        bottom: round(clamp01(Math.max(...entries.map((entry) => entry.line.rect.bottom)) + AUTHORING.endPadding)),
      },
    });
  }
  return regions;
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout: which lines belong to which item

export interface Layout {
  items: ItemAcc[];
  /** The right edge of the text of the whole set (a figure may reach as far as the text of other pages does). */
  bodyRight: number;
  boundaries: Map<number, { top: number; block: Block }[]>;
  orphans: string[];
}

export function layoutPages(lines: readonly PLine[], pages: readonly PageText[], pitch: number): Layout {
  const items: ItemAcc[] = [];
  const orphans: string[] = [];
  const boundariesByPage = new Map<number, { top: number; block: Block }[]>();
  const pageList = [...new Set(lines.map((entry) => entry.page))].sort((a, b) => a - b);
  const startSize = median(lines.filter((entry) => entry.role === 'start').map((entry) => entry.line.fontSize)) || 12;
  let previous: ItemAcc[] = [];
  let carried: Block | undefined;
  for (const page of pageList) {
    const onPage = lines.filter((entry) => entry.page === page);
    const tops = new Map<Block, number>();
    for (const entry of onPage) if (entry.block) tops.set(entry.block, Math.min(tops.get(entry.block) ?? Infinity, entry.line.rect.top));
    const boundaries = [...tops].map(([block, top]) => ({ block, top })).sort((a, b) => a.top - b.top);
    boundariesByPage.set(page, boundaries);
    const bandOf = (y: number): number => boundaries.filter((boundary) => boundary.top <= y + 1e-6).length;
    const starts = onPage.filter((entry) => entry.role === 'start');
    const others = onPage.filter((entry) => entry.role === 'other');
    const columnsOf = new Map<number, { center: number; count: number }[]>();
    for (let band = 0; band <= boundaries.length; band += 1) {
      columnsOf.set(
        band,
        cluster(
          starts.filter((entry) => bandOf(entry.line.rect.top) === band).map((entry) => entry.line.rect.left),
          0.02,
        ),
      );
    }
    const columnIndex = (band: number, left: number): number => {
      let index = 0;
      (columnsOf.get(band) ?? []).forEach((column, i) => {
        if (left >= column.center - 0.03) index = i;
      });
      return index;
    };
    const mine: ItemAcc[] = starts.map((entry) => {
      const band = bandOf(entry.line.rect.top);
      const candidate = entry.candidate as Candidate;
      return {
        candidate,
        start: entry,
        own: [entry],
        extra: new Map<number, PLine[]>(),
        band,
        column: columnIndex(band, entry.line.rect.left),
        page,
        figure: candidate.rest.length === 0,
        block: band > 0 ? (boundaries[band - 1] as { block: Block }).block : carried,
      };
    });
    const inColumn = (band: number, column: number): ItemAcc[] => mine.filter((item) => item.band === band && item.column === column).sort((a, b) => a.start.line.rect.top - b.start.line.rect.top);
    for (const entry of [...others].sort((a, b) => a.line.rect.top - b.line.rect.top)) {
      const band = bandOf(entry.line.rect.top);
      const height = entry.line.rect.bottom - entry.line.rect.top;
      // A text that the extraction cut at a gutter goes on right after the first line of its item, in the next column.
      const sameRow = mine
        .filter(
          (item) =>
            item.band === band &&
            Math.min(item.start.line.rect.bottom, entry.line.rect.bottom) - Math.max(item.start.line.rect.top, entry.line.rect.top) > 0.5 * Math.min(height, item.start.line.rect.bottom - item.start.line.rect.top) &&
            entry.line.rect.left - item.start.line.rect.right >= -0.01 &&
            entry.line.rect.left - item.start.line.rect.right <= 0.045,
        )
        .sort((a, b) => Math.abs(entry.line.rect.left - a.start.line.rect.right) - Math.abs(entry.line.rect.left - b.start.line.rect.right))[0];
      // ... unless it stands at the left edge of a column next to an item of that column (then it is that item's).
      const inSlot = mine.some(
        (other) =>
          other !== sameRow &&
          other.band === band &&
          Math.abs(other.start.line.rect.left - entry.line.rect.left) <= 0.03 &&
          other.start.line.rect.top - entry.line.rect.bottom <= 0.03 &&
          entry.line.rect.top - other.start.line.rect.bottom <= 0.03,
      );
      if (sameRow && !inSlot) {
        sameRow.own.push(entry);
        continue;
      }
      // The lines that go on from the previous page continue below each other: a line right under such a line goes on too.
      const continued = previous.find((item) => {
        const extra = item.extra.get(page);
        if (!extra || extra.length === 0 || band !== 0) return false;
        const gap = entry.line.rect.top - Math.max(...extra.map((own) => own.line.rect.bottom));
        return gap >= -0.004 && gap <= 0.014 && Math.abs(item.start.line.rect.left - entry.line.rect.left) <= 0.07;
      });
      if (continued) {
        continued.extra.set(page, [...(continued.extra.get(page) ?? []), entry]);
        continue;
      }
      const ownerIn = (column_: ItemAcc[], strict: boolean): ItemAcc | undefined => {
        // A line that shares its row with the first line of an item (the sign of a root, the rows of a fraction) belongs to it.
        const byOverlap = column_.find(
          (item) => Math.min(item.start.line.rect.bottom, entry.line.rect.bottom) - Math.max(item.start.line.rect.top, entry.line.rect.top) > 0.3 * Math.min(height, item.start.line.rect.bottom - item.start.line.rect.top),
        );
        if (byOverlap) return byOverlap;
        const above = [...column_].reverse().find((item) => item.start.line.rect.top <= entry.line.rect.top + 0.004);
        const below = column_.find((item) => item.start.line.rect.top > entry.line.rect.top + 0.004);
        const aboveGap = above ? entry.line.rect.top - Math.max(...above.own.map((own) => own.line.rect.bottom)) : Infinity;
        const belowGap = below ? below.start.line.rect.top - entry.line.rect.bottom : Infinity;
        // A small fragment (the sign of a root, a numerator, a denominator) close above or below the first line of an
        // item, to the right of the number, belongs to that item, unless it sits closer under the last line of the item above.
        if (entry.line.chars <= 8 || entry.line.fontSize < startSize * 0.9) {
          const gapTo = (item: ItemAcc): number => Math.max(0, item.start.line.rect.top - entry.line.rect.bottom, entry.line.rect.top - item.start.line.rect.bottom);
          const near = column_
            .filter(
              (item) =>
                gapTo(item) <= 0.02 &&
                entry.line.rect.left >= item.start.line.rect.left - 0.01 &&
                entry.line.rect.left <= item.start.line.rect.right + 0.1,
            )
            .sort((a2, b2) => gapTo(a2) - gapTo(b2))[0];
          if (near && gapTo(near) < aboveGap - 0.002) return near;
        }
        // The top of a stacked fraction lies just above the line of its item, closer to it than to the item before.
        const overlapsBelow =
          below !== undefined &&
          Math.min(below.start.line.rect.right, entry.line.rect.right) - Math.max(below.start.line.rect.left, entry.line.rect.left) > 0.5 * (entry.line.rect.right - entry.line.rect.left);
        if (below && overlapsBelow && !below.figure && belowGap >= -0.004 && belowGap <= 0.012 && belowGap + 0.004 < aboveGap) return below;
        if (strict) return undefined;
        if (above && aboveGap <= Math.max(0.15, 8 * pitch)) return above;
        if (above?.figure) return above;
        return undefined;
      };
      // First the column the line stands in; when no item of it claims the line, the nearest column to its left that has
      // an item above it (the labels of a figure may reach into columns to the right, where other items start further down).
      let column = columnIndex(band, entry.line.rect.left);
      let owner = ownerIn(inColumn(band, column), true);
      if (!owner) {
        const above_ = (item: ItemAcc): boolean => item.start.line.rect.top <= entry.line.rect.top + 0.004;
        (columnsOf.get(band) ?? []).forEach((candidate, i) => {
          if (candidate.center <= entry.line.rect.left + 0.03 && mine.some((item) => item.band === band && item.column === i && above_(item))) column = i;
        });
        owner = ownerIn(inColumn(band, column), false);
      }
      const column_ = inColumn(band, column);
      if (owner) {
        owner.own.push(entry);
        continue;
      }
      // Above the first item of its column: the figure of a number that stands alone, else the item that goes on.
      const first = column_[0];
      if (first?.figure && entry.line.rect.top < first.start.line.rect.top) {
        first.own.push(entry);
        continue;
      }
      const carry = previous
        .filter((item) => Math.abs(item.start.line.rect.left - entry.line.rect.left) <= 0.07)
        .sort((a, b) => Math.abs(a.start.line.rect.left - entry.line.rect.left) - Math.abs(b.start.line.rect.left - entry.line.rect.left))[0];
      if (carry && band === 0 && carry.own[carry.own.length - 1] !== undefined) {
        const lastBottom = Math.max(...carry.own.map((own) => own.line.rect.bottom));
        if (lastBottom >= contentLimit(pages[carry.page]) - 0.4) {
          carry.extra.set(page, [...(carry.extra.get(page) ?? []), entry]);
          continue;
        }
      }
      orphans.push(`page ${page}: "${entry.line.text.slice(0, 40)}"`);
    }
    items.push(...mine);
    // The items that may go on over the page break: the lowest of each column.
    const lowest = new Map<number, ItemAcc>();
    for (const item of mine) {
      const key = Math.round(item.start.line.rect.left * 50);
      const known = lowest.get(key);
      if (!known || item.start.line.rect.top > known.start.line.rect.top) lowest.set(key, item);
    }
    previous = [...lowest.values()];
    if (boundaries.length > 0) carried = (boundaries[boundaries.length - 1] as { block: Block }).block;
  }
  const rights = lines.map((entry) => entry.line.rect.right);
  return { items, bodyRight: rights.length > 0 ? Math.min(1, Math.max(...rights) + PAD) : 0.95, boundaries: boundariesByPage, orphans };
}


// ---------------------------------------------------------------------------------------------------------------------
// The frame of an item

export function groupByColumn(items: readonly ItemAcc[]): Map<string, ItemAcc[]> {
  const byColumn = new Map<string, ItemAcc[]>();
  for (const item of items) {
    const key = `${item.page}:${item.band}:${item.column}`;
    byColumn.set(key, [...(byColumn.get(key) ?? []), item]);
  }
  return byColumn;
}

export interface FrameContext {
  pages: readonly PageText[];
  items: readonly ItemAcc[];
  byColumn: ReadonlyMap<string, readonly ItemAcc[]>;
  layout: Layout;
}

export interface ItemFrame {
  rect: Rect;
  continues: Region[];
  /** The item is a figure with labels (its number stands alone, or most of its lines are short). */
  figure: boolean;
}

/** The frame of an item on its page, and the regions on the following pages where it goes on. */
export function itemFrame(item: ItemAcc, context: FrameContext): ItemFrame {
  const { pages, items, byColumn, layout } = context;
  const page = pages[item.page] as PageText;
  const all = page.lines;
  const extent = (page: number, band: number, column: number): { left: number; right: number } | undefined => {
    const group = byColumn.get(`${page}:${band}:${column}`);
    if (!group) return undefined;
    const groupLines = group.flatMap((other) => [...other.own]);
    return {
      left: Math.min(...groupLines.map((entryLine) => entryLine.line.rect.left)),
      right: Math.max(...groupLines.map((entryLine) => entryLine.line.rect.right)),
    };
  };
  const mine = extent(item.page, item.band, item.column) as { left: number; right: number };
  const ownLeft = Math.min(...item.own.map((entryLine) => entryLine.line.rect.left));
  const ownRight = Math.max(...item.own.map((entryLine) => entryLine.line.rect.right));
  let left = mine.left - PAD;
  let right = mine.right + PAD;
  // Next to another column of the same group the frames meet in the middle of the gap between the texts and never
  // reach into the text of the neighbour (a wide item of the group does not widen the frame of a narrow one).
  const previousColumn = extent(item.page, item.band, item.column - 1);
  const nextColumn = extent(item.page, item.band, item.column + 1);
  if (nextColumn) {
    const gap = nextColumn.left - mine.right;
    if (gap > 0) right = Math.min(right, mine.right + gap / 2 - 0.0005);
    else right = Math.min(right, Math.max(ownRight + 0.003, nextColumn.left - 0.003));
  }
  if (previousColumn) {
    const gap = mine.left - previousColumn.right;
    if (gap > 0) left = Math.max(left, mine.left - gap / 2 + 0.0005);
    else left = Math.max(left, Math.min(ownLeft - 0.003, previousColumn.right + 0.003));
  }
  const short = item.own.filter((entryLine) => entryLine.line.chars <= FIGURE_SHORT).length;
  const figure = item.figure || (item.own.length >= 3 && short >= 0.5 * item.own.length);
  if (figure) {
    const body = all.filter((entryLine) => !isRunningLine(entryLine));
    const bodyRight = Math.max(layout.bodyRight, body.length > 0 ? Math.max(...body.map((entryLine) => entryLine.rect.right)) + PAD : 0);
    const rightNeighbours = items
      .filter((other) => other.page === item.page && other.band === item.band && other.start.line.rect.left > item.start.line.rect.left + 0.1 && Math.abs(other.start.line.rect.top - item.start.line.rect.top) <= 0.03)
      .map((other) => other.start.line.rect.left - PAD);
    right = Math.max(right, Math.min(rightNeighbours.length > 0 ? Math.min(...rightNeighbours) : bodyRight, bodyRight));
  }
  left = clamp01(left);
  right = clamp01(right);
  const firstLine = [...item.own].sort((a, b) => a.line.rect.top - b.line.rect.top)[0] as PLine;
  const top = clamp01(lineStart(firstLine.line, AUTHORING.startPadding, all));
  const lastText = Math.max(...item.own.map((entryLine) => entryLine.line.rect.bottom));
  let bottom = clamp01(lastText + AUTHORING.endPadding);
  // The limit below: the next item or instruction in the same column, or the end of the page's content.
  const below = [
    ...items
      .filter((other) => other.page === item.page && other.band === item.band && other.column === item.column && other.start.line.rect.top > item.start.line.rect.top)
      .map((other) => lineStart(([...other.own].sort((x, y) => x.line.rect.top - y.line.rect.top)[0] as PLine).line, AUTHORING.startPadding, all)),
    ...(layout.boundaries.get(item.page) ?? []).filter((boundary) => boundary.top > lastText).map((boundary) => boundary.top - AUTHORING.startPadding),
  ];
  const limit = Math.min(contentLimit(page), ...below);
  if (page.ink) {
    // Ink under the last line (a figure) counts, but not ink that belongs to a neighbouring column. A figure may reach
    // down beside the labels of its neighbours, so it stops at the first item below it; any other item stops at the
    // first line beside it.
    const foreign = figure
      ? items
          .filter((other) => other !== item && other.page === item.page && other.start.line.rect.top > lastText + 0.002)
          .flatMap((other) => other.own.map((entryLine) => entryLine.line.rect.top - 0.003))
      : all
          .filter((entryLine) => !isRunningLine(entryLine) && entryLine.rect.top > lastText + 0.002 && (entryLine.rect.left >= right - 0.02 || entryLine.rect.right <= left + 0.02))
          .map((entryLine) => entryLine.rect.top - 0.003);
    const ceiling = Math.min(limit, ...foreign);
    if (ceiling > lastText) {
      const lowest = lowestInk(page.ink, lastText, ceiling);
      if (lowest !== undefined) bottom = Math.max(bottom, Math.min(ceiling, lowest + AUTHORING.endPadding));
    }
  }
  if (below.length > 0) bottom = Math.min(bottom, limit);
  bottom = Math.max(bottom, top + AUTHORING.minPieceHeight * 1.5);
  const rect: Rect = { left: round(left), top: round(top), right: round(right), bottom: round(Math.min(1, bottom)) };

  const continues: Region[] = [];
  for (const [continuePage, extraLines] of [...item.extra].sort((a, b) => a[0] - b[0])) {
    const extraTop = Math.min(...extraLines.map((entryLine) => entryLine.line.rect.top));
    const firstExtra = extraLines.find((entryLine) => entryLine.line.rect.top === extraTop) as PLine;
    continues.push({
      page: continuePage,
      rect: {
        left: round(clamp01(Math.min(left, Math.min(...extraLines.map((entryLine) => entryLine.line.rect.left)) - PAD))),
        top: round(clamp01(lineStart(firstExtra.line, AUTHORING.startPadding, pages[continuePage]?.lines))),
        right: round(clamp01(Math.max(right, Math.max(...extraLines.map((entryLine) => entryLine.line.rect.right)) + PAD))),
        bottom: round(clamp01(Math.max(...extraLines.map((entryLine) => entryLine.line.rect.bottom)) + AUTHORING.endPadding)),
      },
    });
  }
  return { rect, continues, figure };
}
