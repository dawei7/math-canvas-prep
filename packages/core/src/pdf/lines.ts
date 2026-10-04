import { rectHeight } from '../model/rect.js';
import type { LinePart, PageSize, PageText, Rect, TextLine } from '../model/types.js';

/**
 * Text lines from text runs, as pure functions (no PDF library), so that the grouping is tested without a PDF.
 *
 * A PDF stores text as runs in drawing order. This groups runs into lines the way a reader sees them: runs whose
 * heights overlap by at least half belong to one line (so sub- and superscripts stay with their line), a line is split
 * at a column gutter or at a wide gap (a table, an equation number), the rows of a fraction are merged, and the lines
 * are put in reading order (columns left to right, each top to bottom).
 */

/** A text run in the coordinates of the displayed page: points, origin top-left, y downwards. */
export interface RawTextItem {
  text: string;
  left: number;
  right: number;
  /** y of the baseline. */
  baseline: number;
  /** Font size in points (positive). */
  fontSize: number;
  /** Font ascent and descent as fractions of the font size (ascent > 0, descent < 0); 0 when unknown. */
  ascent: number;
  descent: number;
  /** Whether the run is set in a bold face, when that is known. */
  bold?: boolean;
}

export interface GroupResult {
  lines: TextLine[];
  columns: number;
  /** x of the column gutter as a fraction of the page width, when two columns were found. */
  gutter?: number;
}

interface Box {
  item: RawTextItem;
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

interface Cluster {
  boxes: Box[];
  ref: Box;
}

interface Segment {
  boxes: Box[];
  baseline: number;
  column: number;
  spanning: boolean;
  /** The segments that were merged into this one (set by the merge of fraction rows), as they were before. */
  parts?: LinePart[];
}

/** Runs overlapping vertically by this share of the smaller one belong to one line. */
const SAME_LINE = 0.5;
/** Rows of a fraction (numerator, bar, denominator) overlap by about a quarter; ordinary lines hardly at all. */
const MERGE_OVERLAP = 0.2;

function toBox(item: RawTextItem): Box | undefined {
  if (!(item.fontSize > 0) || item.text.trim().length === 0) return undefined;
  const ascent = item.ascent > 0 ? Math.min(Math.max(item.ascent, 0.5), 1.1) : 0.8;
  const descent = item.descent < 0 ? Math.min(Math.max(-item.descent, 0.1), 0.5) : 0.2;
  const top = item.baseline - ascent * item.fontSize;
  const bottom = item.baseline + descent * item.fontSize;
  return { item, top, bottom, left: item.left, right: item.right, height: bottom - top };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function cluster(boxes: Box[]): Cluster[] {
  const sorted = [...boxes].sort((a, b) => a.item.baseline - b.item.baseline || a.left - b.left);
  const clusters: Cluster[] = [];
  for (const box of sorted) {
    let best: Cluster | undefined;
    let bestRatio = 0;
    for (let k = clusters.length - 1; k >= 0 && k >= clusters.length - 12; k -= 1) {
      const candidate = clusters[k] as Cluster;
      const overlap = Math.min(candidate.ref.bottom, box.bottom) - Math.max(candidate.ref.top, box.top);
      const ratio = overlap / Math.min(candidate.ref.height, box.height);
      if (ratio >= SAME_LINE && ratio > bestRatio) {
        best = candidate;
        bestRatio = ratio;
      }
    }
    if (best) {
      best.boxes.push(box);
      if (box.item.fontSize > best.ref.item.fontSize) best.ref = box;
    } else {
      clusters.push({ boxes: [box], ref: box });
    }
  }
  return clusters;
}

/** The x intervals a row occupies, with the gaps between words bridged. */
function occupied(boxes: Box[]): [number, number][] {
  const ordered = [...boxes].sort((a, b) => a.left - b.left);
  const bridge = 0.6 * median(boxes.map((box) => box.item.fontSize));
  const ranges: [number, number][] = [];
  for (const box of ordered) {
    const last = ranges[ranges.length - 1];
    if (last && box.left - last[1] <= bridge) last[1] = Math.max(last[1], box.right);
    else ranges.push([box.left, box.right]);
  }
  return ranges;
}

/** x of a gutter that separates two columns of text, or undefined when the page has one column. */
function findGutter(rows: [number, number][][], width: number): number | undefined {
  if (rows.length < 6) return undefined;
  const steps = 240;
  const first = Math.floor(steps * 0.3);
  const last = Math.ceil(steps * 0.7);
  const scores: { score: number; both: number; cross: number }[] = [];
  for (let step = first; step <= last; step += 1) {
    const x = (step / steps) * width;
    let both = 0;
    let cross = 0;
    for (const ranges of rows) {
      if (ranges.some(([start, end]) => start < x - 0.5 && end > x + 0.5)) {
        cross += 1;
        continue;
      }
      const hasLeft = ranges.some(([, end]) => end <= x);
      const hasRight = ranges.some(([start]) => start >= x);
      if (hasLeft && hasRight) both += 1;
    }
    scores.push({ score: both - 3 * cross, both, cross });
  }
  const valid = scores.map(
    (entry) => entry.cross <= 0.12 * rows.length && entry.both >= Math.max(4, 0.25 * rows.length),
  );
  let bestScore = -Infinity;
  scores.forEach((entry, index) => {
    if (valid[index] && entry.score > bestScore) bestScore = entry.score;
  });
  if (bestScore === -Infinity) return undefined;
  let bestRun: { from: number; to: number } | undefined;
  let from = -1;
  for (let index = 0; index <= scores.length; index += 1) {
    const hit = index < scores.length && valid[index] === true && (scores[index] as { score: number }).score === bestScore;
    if (hit && from < 0) from = index;
    if (!hit && from >= 0) {
      if (!bestRun || index - from > bestRun.to - bestRun.from + 1) bestRun = { from, to: index - 1 };
      from = -1;
    }
  }
  if (!bestRun) return undefined;
  const runWidth = ((bestRun.to - bestRun.from + 1) / steps) * width;
  if (runWidth < 0.008 * width) return undefined;
  return (((first + (bestRun.from + bestRun.to) / 2) / steps) * width) / width;
}

function splitCluster(group: Cluster, gutterX: number | undefined): Segment[] {
  const boxes = [...group.boxes].sort((a, b) => a.left - b.left);
  const baseline = group.ref.item.baseline;
  const fontMedian = median(boxes.map((box) => box.item.fontSize));
  const gap = 2.4 * fontMedian;
  const spanning = gutterX !== undefined && boxes.some((box) => box.left < gutterX - 0.5 && box.right > gutterX + 0.5);
  const pieces: Box[][] = [];
  let current: Box[] = [];
  let right = -Infinity;
  for (const box of boxes) {
    const crosses =
      gutterX !== undefined && !spanning && current.length > 0 && (current[current.length - 1] as Box).left < gutterX && (box.left + box.right) / 2 >= gutterX;
    if (current.length > 0 && (box.left - right > gap || crosses)) {
      pieces.push(current);
      current = [];
      right = -Infinity;
    }
    current.push(box);
    right = Math.max(right, box.right);
  }
  if (current.length > 0) pieces.push(current);
  return pieces.map((piece) => {
    const centre = (Math.min(...piece.map((b) => b.left)) + Math.max(...piece.map((b) => b.right))) / 2;
    return {
      boxes: piece,
      baseline,
      spanning: spanning && pieces.length === 1,
      column: gutterX !== undefined && !spanning && centre >= gutterX ? 1 : 0,
    };
  });
}

function joinText(boxes: Box[]): { text: string; chars: number } {
  const ordered = [...boxes].sort((a, b) => a.left - b.left);
  let text = '';
  let right = -Infinity;
  let previous: Box | undefined;
  for (const box of ordered) {
    const piece = box.item.text;
    if (previous) {
      const gap = box.left - right;
      const em = Math.max(previous.item.fontSize, box.item.fontSize);
      const needSpace = gap > 0.12 * em && !/\s$/.test(text) && !/^\s/.test(piece);
      if (needSpace) text += ' ';
    }
    text += piece;
    right = Math.max(right, box.right);
    previous = box;
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  return { text: clean, chars: clean.replace(/\s/g, '').length };
}

function toLine(segment: Segment, page: PageSize): TextLine {
  const boxes = segment.boxes;
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const { text, chars } = joinText(boxes);
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const known = boxes.filter((b) => b.item.bold !== undefined);
  const boldChars = known.filter((b) => b.item.bold === true).reduce((sum, b) => sum + b.item.text.replace(/\s/g, '').length, 0);
  const knownChars = known.reduce((sum, b) => sum + b.item.text.replace(/\s/g, '').length, 0);
  return {
    ...(known.length > 0 ? { bold: knownChars > 0 && boldChars >= 0.6 * knownChars } : {}),
    ...(segment.parts && segment.parts.length >= 2 ? { parts: segment.parts } : {}),
    text,
    rect: {
      left: clamp(left / page.width),
      top: clamp(top / page.height),
      right: clamp(right / page.width),
      bottom: clamp(bottom / page.height),
    },
    fontSize: Math.round(Math.max(...boxes.map((b) => b.item.fontSize)) * 10) / 10,
    column: segment.column,
    chars,
  };
}

function mergeFractionRows(segments: Segment[], lines: Map<Segment, TextLine>): Segment[] {
  const result: Segment[] = [];
  const ordered = [...segments].sort((a, b) => (lines.get(a) as TextLine).rect.top - (lines.get(b) as TextLine).rect.top);
  let box: Rect | undefined;
  for (const segment of ordered) {
    const line = lines.get(segment) as TextLine;
    const previous = result[result.length - 1];
    if (previous && box && previous.column === segment.column && !previous.spanning && !segment.spanning) {
      const overlap = Math.min(box.bottom, line.rect.bottom) - Math.max(box.top, line.rect.top);
      const smaller = Math.min(rectHeight(box), rectHeight(line.rect));
      // The rows of a fraction sit next to each other, not necessarily above one another: allow a few em of distance.
      const sideways = Math.min(box.right, line.rect.right) - Math.max(box.left, line.rect.left);
      const reach = (4 * Math.max(...segment.boxes.map((b) => b.item.fontSize))) / 600;
      if (smaller > 0 && overlap / smaller >= MERGE_OVERLAP && sideways > -reach) {
        // The line made of the segment before it was merged: what the piece looked like on its own.
        const own = lines.get(previous) as TextLine;
        previous.parts = previous.parts ?? [{ text: own.text, chars: own.chars, rect: own.rect }];
        previous.parts.push({ text: line.text, chars: line.chars, rect: line.rect });
        previous.boxes.push(...segment.boxes);
        previous.baseline = Math.max(previous.baseline, segment.baseline);
        box = {
          left: Math.min(box.left, line.rect.left),
          top: Math.min(box.top, line.rect.top),
          right: Math.max(box.right, line.rect.right),
          bottom: Math.max(box.bottom, line.rect.bottom),
        };
        continue;
      }
    }
    result.push(segment);
    box = line.rect;
  }
  return result;
}

export function groupTextLines(items: readonly RawTextItem[], page: PageSize): GroupResult {
  const boxes = items.map(toBox).filter((box): box is Box => box !== undefined);
  if (boxes.length === 0) return { lines: [], columns: 1 };
  const clusters = cluster(boxes);
  const gutterX = findGutter(
    clusters.map((group) => occupied(group.boxes)),
    page.width,
  );
  const gutterPoints = gutterX === undefined ? undefined : gutterX * page.width;

  let segments = clusters.flatMap((group) => splitCluster(group, gutterPoints));
  const lines = new Map<Segment, TextLine>();
  for (const segment of segments) lines.set(segment, toLine(segment, page));
  segments = mergeFractionRows(segments, lines);
  for (const segment of segments) lines.set(segment, toLine(segment, page));

  const sortByRow = (a: Segment, b: Segment): number => a.baseline - b.baseline || (lines.get(a) as TextLine).rect.left - (lines.get(b) as TextLine).rect.left;
  let ordered: Segment[];
  if (gutterPoints === undefined) {
    ordered = [...segments].sort(sortByRow);
  } else {
    ordered = [];
    const byTop = [...segments].sort(sortByRow);
    let band: Segment[] = [];
    const flush = (): void => {
      ordered.push(...band.filter((s) => s.column === 0), ...band.filter((s) => s.column === 1));
      band = [];
    };
    for (const segment of byTop) {
      if (segment.spanning) {
        flush();
        ordered.push(segment);
      } else band.push(segment);
    }
    flush();
  }
  const result = ordered.map((segment) => lines.get(segment) as TextLine).filter((line) => line.text.length > 0);
  return gutterX === undefined ? { lines: result, columns: 1 } : { lines: result, columns: 2, gutter: gutterX };
}

// ---------------------------------------------------------------------------------------------------------------------
// Running headers and footers

const BAND = 0.12;

/** The text of a line with its digits blurred, so "Page 3 of 9" and "Page 4 of 9" are the same running footer. */
export function headerKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function inBand(rect: Rect): boolean {
  return rect.bottom <= BAND + 0.02 || rect.top >= 1 - BAND - 0.02;
}

/** The keys of lines that repeat in the top or bottom band of several of the given pages. */
export function findHeaderFooterKeys(pages: readonly PageText[]): Set<string> {
  const counts = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (!inBand(line.rect)) continue;
      const key = headerKey(line.text);
      if (key.length === 0) continue;
      const set = counts.get(key);
      if (set) set.add(page.page);
      else counts.set(key, new Set([page.page]));
    }
  }
  const needed = Math.min(3, Math.max(2, Math.ceil(0.3 * pages.length)));
  const keys = new Set<string>();
  for (const [key, set] of counts) if (set.size >= needed) keys.add(key);
  return keys;
}

/** Sets `headerFooter` on the lines of the page whose key is in `keys` and that sit in the top or bottom band. */
export function markHeaderFooter(page: PageText, keys: ReadonlySet<string>): PageText {
  if (keys.size === 0) return page;
  const lines = page.lines.map((line) =>
    inBand(line.rect) && keys.has(headerKey(line.text)) ? { ...line, headerFooter: true } : line,
  );
  return { ...page, lines };
}
