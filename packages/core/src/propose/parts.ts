import { lineStart } from '../geometry/snap.js';
import type { Rect, TextLine } from '../model/types.js';
import { AUTHORING } from '../rules/constants.js';

/**
 * Where the parts of one exercise start: a re-implementation, in TypeScript, of the idea of the Android app's exercise
 * splitter, so that proposals here behave like the "parts" button on the tablet.
 *
 * Detection reads the text of the lines, so it works for typeset documents; for a scan the dividers are placed by eye.
 * Nothing here applies anything: it returns what it found and why.
 */

export type PartStyle = 'letter' | 'roman' | 'number' | 'letter-dot' | 'number-dot' | 'dotted';

/** The higher the priority, the likelier a tie is that style. */
const PRIORITY: Record<PartStyle, number> = { letter: 5, roman: 4, number: 3, 'letter-dot': 2, 'number-dot': 1.5, dotted: 1 };

const STYLES: readonly PartStyle[] = ['letter', 'roman', 'number', 'letter-dot', 'number-dot', 'dotted'];

/** "(a) Find", "a) Find", "(B) Find" */
const letterParen = /^\(?([A-Za-z])\)\s*\S/;
/** "(i) Show", "ii) Show" */
const romanParen = /^\(?([ivxIVX]{1,4})\)\s*\S/;
/** "(1) Show", "2) Show" */
const numberParen = /^\(?(\d{1,2})\)\s*\S/;
/** "a. Find" */
const letterDot = /^([a-z])\.\s+\S/;
/** "1. Show" */
const numberDot = /^(\d{1,2})\.\s+\S/;
/** "3.1 Differentiate", "3.2) Integrate": the part number is the last figure. */
const dotted = /^\d{1,3}\.(\d{1,2})[.)]?\s+\S/;

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Every way the text can open a part. A line such as "(i) Show" is both the letter i and the roman numeral one. */
function readings(text: string): Map<PartStyle, number> {
  const found = new Map<PartStyle, number>();
  const letter = letterParen.exec(text);
  if (letter) found.set('letter', (letter[1] as string).toLowerCase().charCodeAt(0) - 96);
  const roman = romanParen.exec(text);
  const romanValue = roman ? ROMAN[(roman[1] as string).toLowerCase()] : undefined;
  if (romanValue !== undefined) found.set('roman', romanValue);
  const number = numberParen.exec(text);
  if (number) found.set('number', Number(number[1]));
  const letterD = letterDot.exec(text);
  if (letterD) found.set('letter-dot', (letterD[1] as string).charCodeAt(0) - 96);
  const numberD = numberDot.exec(text);
  if (numberD) found.set('number-dot', Number(numberD[1]));
  const dot = dotted.exec(text);
  if (dot) found.set('dotted', Number(dot[1]));
  return found;
}

export interface PartMarker {
  text: string;
  /** Which part the marker claims to be: a = 1, b = 2, ... or i = 1, ii = 2, ... */
  ordinal: number;
  line: TextLine;
}

export interface PartsDetection {
  style: PartStyle;
  markers: PartMarker[];
  /** Where each part after the first starts (page fractions), at least two parts. */
  dividers: number[];
  /**
   * Where the first part starts when its marker is on a line of its own (the run begins at (a), (i) or 1): the text
   * above is the statement the parts share. Undefined when the first marker shares the statement's line.
   */
  firstStart?: number;
  evidence: string[];
}

interface Run {
  style: PartStyle;
  markers: PartMarker[];
}

/**
 * The runs of markers in one style that count up by one in reading order (a, b, c). A real list of parts is such a
 * run; a stray "(a)" in the middle of a sentence is not.
 */
function runsOf(lines: readonly TextLine[], style: PartStyle): Run[] {
  const runs: Run[] = [];
  for (const line of lines) {
    const ordinal = readings(line.text).get(style);
    if (ordinal === undefined) continue;
    const current = runs[runs.length - 1];
    const last = current?.markers[current.markers.length - 1];
    const marker: PartMarker = { text: line.text.slice(0, 60), ordinal, line };
    if (current && last && last.ordinal + 1 === ordinal) current.markers.push(marker);
    else runs.push({ style, markers: [marker] });
  }
  return runs;
}

/**
 * Where the parts of the exercise in `lines` (reading order) begin. Undefined unless at least two parts are found: one
 * match is more likely a stray letter.
 *
 * The first part starts at the top of the frame, so the statement the parts share stays with it, unless the first
 * marker has a line of its own, in which case `firstStart` says where it begins and the text above is the shared
 * statement; a run that begins later (b, c, ...) means part one's marker shares the statement's line, so every marker
 * starts a further part.
 */
export function detectParts(lines: readonly TextLine[]): PartsDetection | undefined {
  let best: Run | undefined;
  for (const style of STYLES) {
    for (const run of runsOf(lines, style)) {
      if (run.markers.length < 2) continue;
      if (
        !best ||
        run.markers.length > best.markers.length ||
        (run.markers.length === best.markers.length && PRIORITY[run.style] > PRIORITY[best.style])
      ) {
        best = run;
      }
    }
  }
  if (!best) return undefined;
  const starts = best.markers.map((marker) => lineStart(marker.line));
  const first = best.markers[0] as PartMarker;
  const startsAtOne = first.ordinal === 1;
  const detection: PartsDetection = {
    style: best.style,
    markers: best.markers,
    dividers: startsAtOne ? starts.slice(1) : starts,
    evidence: [
      `${best.markers.length} markers in the style "${best.style}" count up by one: ${best.markers.map((marker) => `"${marker.text.slice(0, 18)}"`).join(', ')}.`,
      startsAtOne
        ? 'The first marker has a line of its own: the text above it is the statement the parts share.'
        : 'The run does not begin at the first ordinal, so the first marker shares the line of the statement; every marker starts a further part.',
    ],
  };
  if (startsAtOne) detection.firstStart = starts[0] as number;
  return detection;
}

/**
 * The thinnest part there can be and the rule that keeps pieces from being slivers: dividers closer together than the
 * minimum piece, or to the bottom, are dropped.
 */
export function keptDividers(rect: Rect, dividers: readonly number[]): number[] {
  const cuts: number[] = [];
  let previous = rect.top;
  for (const y of dividers.map((value) => Math.min(Math.max(value, rect.top), rect.bottom)).sort((a, b) => a - b)) {
    if (y - previous >= AUTHORING.minPieceHeight) {
      cuts.push(y);
      previous = y;
    }
  }
  while (cuts.length > 0 && rect.bottom - (cuts[cuts.length - 1] as number) < AUTHORING.minPieceHeight) cuts.pop();
  return cuts;
}
