import type { Frame } from './types.js';

/**
 * Authoritative exercises (docs/BUNDLE_FORMAT.md, "Authoritative exercises"): exercises audited from a book once, on a
 * computer, and named by the number the book prints (`label`) inside the section of the book they belong to. Exercises a
 * person frames for themselves are ordinary: free, positional numbers.
 */

/** True for an exercise that carries the authority of a book. Such frames are left out of the positional numbering. */
export function isAuthoritative(frame: Pick<Frame, 'kind' | 'authority'>): boolean {
  return frame.kind === 'exercise' && frame.authority === 'book';
}

/** The identity of an authoritative exercise within a document: the pair (section, label). */
export function bookKey(section: string, label: string): string {
  return `${section}\u0000${label}`;
}

/** The identity of a frame, or undefined when it is not an authoritative exercise with a label and a section. */
export function bookKeyOf(frame: Frame): string | undefined {
  if (!isAuthoritative(frame) || frame.section === undefined || frame.label === undefined) return undefined;
  return bookKey(frame.section, frame.label);
}

/** `SECTION:LABEL`, the way tools name a book exercise in messages and accept it as a reference. */
export function bookReference(section: string, label: string): string {
  return `${section}:${label}`;
}

/** What a person or an agent writes for a label, made into what the book prints; `changes` says what was altered. */
export interface NormalizedLabel {
  label: string;
  changes: string[];
}

/**
 * Whitespace is trimmed and collapsed. The "." or ")" that a book prints after a number ("5." "5)") is not part of the
 * label and is dropped; a ")" that closes a "(" ("5(a)") stays.
 */
export function normalizeLabel(text: string): NormalizedLabel {
  const changes: string[] = [];
  let label = text.replace(/\s+/g, ' ').trim();
  if (label.length > 1 && label.endsWith('.')) {
    label = label.slice(0, -1).trimEnd();
    changes.push('the closing "." was dropped: a label is written without the punctuation the book prints after the number');
  } else if (label.length > 1 && label.endsWith(')') && !label.includes('(')) {
    label = label.slice(0, -1).trimEnd();
    changes.push('the closing ")" was dropped: a label is written without the punctuation the book prints after the number');
  }
  return { label, changes };
}

/** True when the label ends with the punctuation the book prints after a number, or has stray spaces. */
export function labelStyleProblem(label: string): string | undefined {
  if (label !== label.trim() || /\s{2,}/.test(label)) return 'has leading, trailing or repeated spaces';
  if (label.length > 1 && label.endsWith('.')) return 'ends with a "." (the punctuation the book prints after the number)';
  if (label.length > 1 && label.endsWith(')') && !label.includes('(')) return 'ends with a ")" (the punctuation the book prints after the number)';
  return undefined;
}
