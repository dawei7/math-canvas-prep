import { normalizeLabel } from '../model/authority.js';

/**
 * Reading the number of an exercise or of an answer in the text a page carries. The rules are deliberately small and
 * written down (docs/AUDIT_A_BOOK.md) so that a person can apply them by hand and get the same answer as the tool.
 */

const DASHES = /[‐-―−]/g;

/** Text as the checks compare it: compatibility forms folded (NFKC), every dash a hyphen, white space a single space. */
export function foldText(text: string): string {
  return text.normalize('NFKC').replace(DASHES, '-').replace(/\s+/g, ' ').trim();
}

/** A label as the checks compare it: without the closing punctuation a book prints after it, folded like the text. */
export function foldLabel(label: string): string {
  return foldText(normalizeLabel(label).label);
}

/**
 * Whether an item with this label starts at position `at` of `text`: the label itself, optionally inside parentheses,
 * then the closing `.` or `)` a book prints (a `.` that is followed by a digit is a decimal point, not a closing mark).
 * Where the text layer lacks the closing mark the label may also stand alone or be followed by a space; that is only
 * accepted where `bareOk` says so (at the start of a row, not in the middle of one, where a bare number is a value).
 */
export function labelStartsAt(text: string, at: number, label: string, bareOk: boolean): boolean {
  return labelEndAt(text, at, label, bareOk) !== undefined;
}

/** Like {@link labelStartsAt}, and says where the label ends in the text (after its closing mark, when there is one). */
function labelEndAt(text: string, at: number, label: string, bareOk: boolean): number | undefined {
  let start = at;
  if (text[start] === '(' && !label.startsWith('(')) start += 1;
  if (!text.startsWith(label, start)) return undefined;
  const end = start + label.length;
  const next = text[end];
  if (next === undefined || next === ' ') return bareOk ? end : undefined;
  if (next === ')') return end + 1;
  if (next === '.') return /\d/.test(text[end + 1] ?? '') ? undefined : end + 1;
  return undefined;
}

/**
 * How many characters at the start of a row the number takes (`9)` is 2, `(a)` is 3, `5a.` is 3), or undefined when the row
 * does not start with the label or with its part marker. Used to tell whether the left edge of a region cuts the number.
 */
export function labelSpan(row: string, label: string): number | undefined {
  const whole = labelEndAt(row, 0, label, true);
  if (whole !== undefined) return whole;
  const part = partOf(label);
  return part === undefined ? undefined : labelEndAt(row, 0, part.part, false);
}

/** The positions in a row where an item may start: the start of the row and every word. */
function itemStarts(text: string): number[] {
  const starts = [0];
  for (let i = 1; i < text.length; i += 1) if (text[i - 1] === ' ' && text[i] !== ' ') starts.push(i);
  return starts;
}

const MARKER_LIST = /\(?\s*(\d{1,4}[a-z]?(?:\s*(?:-|,|&|\band\b)\s*\d{1,4}[a-z]?)+)\s*[.)]/y;

/**
 * A range or a list of numbers in front of an answer that covers the label: `1-7.` covers 3, `1, 3, 5.` covers 5 but not 4.
 * Only plain numbers (with at most a letter after them) are read this way.
 */
function markerCovers(text: string, at: number, label: string): boolean {
  const wanted = /^(\d{1,4})([a-z]?)$/.exec(label);
  if (!wanted) return false;
  MARKER_LIST.lastIndex = at;
  const match = MARKER_LIST.exec(text);
  if (!match) return false;
  const pieces = (match[1] as string).split(/\s*(-|,|&|\band\b)\s*/);
  const n = Number(wanted[1]);
  let previous = pieces[0] as string;
  if (previous === label) return true;
  for (let i = 1; i + 1 < pieces.length; i += 2) {
    const separator = pieces[i];
    const next = pieces[i + 1] as string;
    if (next === label) return true;
    if (separator === '-' && wanted[2] === '') {
      const from = /^(\d+)([a-z]?)$/.exec(previous);
      const to = /^(\d+)([a-z]?)$/.exec(next);
      if (from && to && from[2] === '' && to[2] === '' && Number(from[1]) <= n && n <= Number(to[1])) return true;
    }
    previous = next;
  }
  return false;
}

/**
 * A label that is a number and a part of it (`5a`, `3(b)`): the number and the part's letters. A book prints such a part as
 * `(a)` or `a)` on the line where the part starts, and the number only once above its parts; an answer key may print `5a.`,
 * `5. (a)` or `(a)`.
 */
export function partOf(label: string): { number: string; part: string } | undefined {
  const match = /^(\d+)\(?([a-z]{1,3})\)?$/.exec(label);
  return match ? { number: match[1] as string, part: match[2] as string } : undefined;
}

/** Whether one of the patterns reads `label` from the start of `text` (group 1 is the label as printed). */
function patternGives(patterns: readonly RegExp[], text: string, label: string): boolean {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found && found[1] !== undefined && foldLabel(found[1]) === label) return true;
  }
  return false;
}

/**
 * The exercise's own region begins with its number: the first row of text starts with the label (an opening parenthesis and
 * a closing `.` or `)` are ignored, a label glued to the text counts, a label with no closing mark counts). The exercise
 * `5a` is a part of the printed exercise 5, so its region may also start with its part marker, `(a)` or `a)`.
 */
export function rowStartsWithLabel(row: string, label: string, patterns?: readonly RegExp[]): boolean {
  if (labelStartsAt(row, 0, label, true)) return true;
  // The exercise 5a is printed from its part marker: `(a)` or `a)`.
  const part = partOf(label);
  if (part !== undefined && labelStartsAt(row, 0, part.part, false)) return true;
  return patterns !== undefined && patternGives(patterns, row, label);
}

/**
 * A row of an answer key holds an item for the label: the label starts the row, or starts an item later in the row (answer
 * keys flow in columns and the text layer may join the rows of two columns: `1. 115 3. A = 52 5. 45`), or a range or a list
 * in front of an answer contains it (`1-7.`, `1, 3, 5.`).
 */
export function rowHasItem(row: string, label: string, patterns?: readonly RegExp[]): boolean {
  const part = partOf(label);
  for (const at of itemStarts(row)) {
    if (labelStartsAt(row, at, label, at === 0) || markerCovers(row, at, label)) return true;
    // The answer of a part may stand under the number of its exercise (`5. (a) 4 (b) 7`) or start from the part marker.
    if (part !== undefined && at === 0 && (labelStartsAt(row, 0, part.part, false) || labelStartsAt(row, 0, part.number, true) || markerCovers(row, 0, part.number))) return true;
    if (patterns !== undefined && patternGives(patterns, at === 0 ? row : row.slice(at), label)) return true;
  }
  return false;
}

/** The part of a label that is an integer and what follows it (`5a` is 5 and `a`); undefined when it does not start with one. */
export function parseNumeric(label: string): { n: number; suffix: string } | undefined {
  const match = /^(\d+)(.*)$/s.exec(label);
  return match ? { n: Number(match[1]), suffix: match[2] as string } : undefined;
}

/** The first characters of a text, for the evidence of a finding. */
export function excerpt(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= length ? flat : flat.slice(0, length);
}

/** Numbers as a short list: `7, 12-14, 20`. */
export function compactNumbers(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    parts.push(j === i ? String(sorted[i]) : j === i + 1 ? `${sorted[i]}, ${sorted[j]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}
