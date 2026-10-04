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

/**
 * The identity of a frame, or undefined when it is not an authoritative exercise with a label and a section. The label is
 * taken as the frame holds it: frames come from `parseFrames`, which has dropped the closing punctuation once, as the importer does.
 */
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
 * The "." or ")" that a book prints after a number ("5." "5)") is not part of the label: one closing "." is dropped, and so
 * is one closing ")" that closes nothing (a label without any "("); "5(a)" stays. The spaces that were before the dropped
 * character go with it, and nothing else is touched. This is what the importer does to every label before it checks it
 * and keeps it (so `5` and `5.` are one exercise there); every tool that reads or takes a label does it with this function.
 */
export function dropClosingPunctuation(label: string): string {
  if (label.length < 2 || !(label.endsWith('.') || (label.endsWith(')') && !label.includes('(')))) return label;
  // A loop, not a pattern: a label comes from a file that anyone may have written.
  let end = label.length - 1;
  while (end > 0 && label.charCodeAt(end - 1) === 0x20) end -= 1;
  return label.slice(0, end);
}

/**
 * What a person or an agent writes for a label: whitespace is trimmed and collapsed, and the closing punctuation of the
 * book is dropped ({@link dropClosingPunctuation}).
 */
export function normalizeLabel(text: string): NormalizedLabel {
  const changes: string[] = [];
  const spaced = text.replace(/\s+/g, ' ').trim();
  const label = dropClosingPunctuation(spaced);
  if (label !== spaced) {
    changes.push(`the closing "${spaced.endsWith('.') ? '.' : ')'}" was dropped: a label is written without the punctuation the book prints after the number`);
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
