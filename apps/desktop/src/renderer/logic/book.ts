import { LIMITS, isAuthoritative, locateSection, normalizeLabel, type Frame } from '@mcprep/core/pure';
import type { BookModel } from './model.js';

/**
 * Everything about the printed numbers (labels) of book exercises that does not need a window: how a book counts, which
 * label comes next, and whether a label is acceptable. Pure functions, tested without the editor.
 */

// ----------------------------------------------------------------------------------------------------------- counting

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Labels in the order a book counts: 2 before 10, 5a before 5b, A.3 before A.10. */
export const compareLabels = (a: string, b: string): number => collator.compare(a, b);

const nextLetter = (letter: string): string | undefined => {
  const code = letter.charCodeAt(0);
  const last = letter === letter.toUpperCase() ? 'Z'.charCodeAt(0) : 'z'.charCodeAt(0);
  return code >= last ? undefined : String.fromCharCode(code + 1);
};

/**
 * The label that follows `label` the way a book counts: `5` gives `6`, `5a` gives `5b`, `5(a)` gives `5(b)`, `A.3` gives
 * `A.4`, `II-4` gives `II-5`, `09` gives `10`, a lone `a` gives `b`. After the last letter the number goes on (`5z`: `6`).
 * Undefined when the label does not end in a number or a letter that counts.
 */
export function successorLabel(label: string): string | undefined {
  const trimmed = label.trim();
  const closed = /^(.*\(\s*)([A-Za-z])(\s*\))$/.exec(trimmed);
  if (closed) {
    const next = nextLetter(closed[2] as string);
    if (next !== undefined) return `${closed[1] as string}${next}${closed[3] as string}`;
    return successorLabel(trimmed.replace(/\([^)]*\)$/, ''));
  }
  const lettered = /^(.*\d)([A-Za-z])$/.exec(trimmed);
  if (lettered) {
    const next = nextLetter(lettered[2] as string);
    if (next !== undefined) return `${lettered[1] as string}${next}`;
    return successorLabel(lettered[1] as string);
  }
  const numbered = /^(.*?)(\d+)$/.exec(trimmed);
  if (numbered) {
    const digits = numbered[2] as string;
    const next = String(BigInt(digits) + 1n);
    return `${numbered[1] as string}${digits.startsWith('0') && digits.length > 1 ? next.padStart(digits.length, '0') : next}`;
  }
  const single = /^([A-Za-z])$/.exec(trimmed);
  if (single) return nextLetter(single[1] as string);
  return undefined;
}

/** The first label from `previous` on (counting the way a book does) that `taken` does not hold; `1` when there is no previous. */
export function nextFreeLabel(taken: ReadonlySet<string>, previous: string | undefined): string {
  let candidate = previous === undefined ? '1' : (successorLabel(previous) ?? '1');
  for (let step = 0; step < 100_000 && taken.has(candidate); step += 1) {
    const next = successorLabel(candidate);
    if (next === undefined) break;
    candidate = next;
  }
  return candidate;
}

/**
 * The exercise a person drew last in a section: the one with the highest generated id (`f31`), because ids are never
 * reused, so the newest exercise has the highest number; without such ids the one whose label comes last.
 */
export function newestOf(frames: readonly Frame[]): Frame | undefined {
  let best: Frame | undefined;
  let bestNumber = -1;
  for (const frame of frames) {
    const match = /^f(\d+)$/.exec(frame.id);
    const n = match ? Number(match[1]) : -1;
    if (n > bestNumber) {
      best = frame;
      bestNumber = n;
    }
  }
  if (best !== undefined && bestNumber >= 0) return best;
  return [...frames].sort((a, b) => compareLabels(a.label ?? '', b.label ?? '')).pop();
}

// ------------------------------------------------------------------------------------------------------- suggestions

export interface Suggestion {
  /** The id of the section at this place, when the outline has one with an id there. */
  section: string | undefined;
  /** The next printed number in that section (previous + 1, `5b` after `5a`). */
  label: string;
  /** Why there is no section, in a sentence, when there is none. */
  noSection?: string;
}

/** The section at a position of the document, and the label that probably comes next in it. */
export function suggestFor(model: BookModel, page: number, top: number, options: { exceptId?: string } = {}): Suggestion {
  const node = locateSection(model.tree, page, top, { withId: true });
  if (node === undefined || node.id === undefined) {
    return {
      section: undefined,
      label: '1',
      noSection:
        model.entries.length === 0
          ? 'The book has no sections yet. A book exercise is filed under a section: add them in the Sections list.'
          : model.entries.some((entry) => entry.id !== undefined)
            ? 'No section with an id starts above this place. Choose one below.'
            : 'The sections have no ids yet, and a book exercise is filed under a section id. Give the sections ids in the Sections list.',
    };
  }
  return { section: node.id, label: suggestLabel(model, node.id, options.exceptId) };
}

/** The next free label in a section: after the exercise drawn last there, skipping labels that are taken. */
export function suggestLabel(model: BookModel, section: string, exceptId?: string): string {
  const frames = (model.groups.get(section) ?? []).filter((frame) => frame.id !== exceptId);
  const taken = new Set(frames.map((frame) => frame.label as string));
  return nextFreeLabel(taken, newestOf(frames)?.label);
}

// --------------------------------------------------------------------------------------------------------- checking

export interface LabelCheck {
  /** The label as the book prints it: spaces collapsed, the closing "." or ")" dropped. */
  label: string;
  /** A problem in plain words; undefined when the label and the section can be used. */
  problem?: string;
}

/**
 * Checks what a person typed for a book exercise before it is applied, so that the form can say what is wrong in plain
 * words. `selfId` is the exercise being changed (it may keep its own number).
 */
export function checkBookLabel(model: BookModel, text: string, section: string | undefined, selfId?: string): LabelCheck {
  const { label } = normalizeLabel(text);
  if (label === '') return { label, problem: 'Type the number exactly as the book prints it, for example 5, 12, 5a or A.3.' };
  if (!LIMITS.labelPattern.test(label)) {
    return {
      label,
      problem: `"${label}" cannot be a number here: use 1 to ${LIMITS.labelMax} characters, starting with a letter or digit, then letters, digits, spaces and . _ - ( ) /`,
    };
  }
  if (section === undefined || section === '') return { label, problem: 'Choose the section the exercise belongs to.' };
  if (!model.tree.byId.has(section)) return { label, problem: `The section "${section}" is not in the Sections list.` };
  const clash = (model.groups.get(section) ?? []).find((frame) => frame.label === label && frame.id !== selfId);
  if (clash) return { label, problem: `Section ${section} already has an exercise ${label} (${clash.id}). Choose another number, or select that exercise instead.` };
  return { label };
}

/** True when the frame is a book exercise (an exercise that carries the authority of a book). */
export const isBook = (frame: Frame | undefined): boolean => frame !== undefined && isAuthoritative(frame);
