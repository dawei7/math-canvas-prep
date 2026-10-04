import type { BookEntry, BookStructure, Frame, OutlineEntry } from '@mcprep/core/pure';

/**
 * Deriving the sections of a book, as the window shows it: the entries the heuristics found, compared with the outline the
 * project already has, and what taking some of them would do to that outline and to the book exercises filed under it.
 * Pure functions, tested without a window; the store keeps the choices and applies the result as one undoable step.
 *
 * The rule that shapes all of it: an exercise names its section by id, so applying a derived list must never leave an
 * exercise whose section is gone. A section of the project that holds exercises and that the derived list does not have
 * (another id, or not taken) stays, unless the person moves its exercises to a section that will be there.
 */

/** Below this the heuristics are not sure of an entry (two sources disagreed, a heading was not found). */
export const UNSURE_BELOW = 0.6;

/** An entry the project has no section with that id for, one that is the same, and one that says something else. */
export type DeriveStatus = 'new' | 'same' | 'changed';
export type DeriveFilter = 'all' | 'changes' | 'new' | 'changed' | 'same' | 'unsure';

export interface DerivedRow {
  /** The place in the derived list. */
  at: number;
  entry: BookEntry;
  status: DeriveStatus;
  /** What the project's own entry with this id says differently, in the window's words. */
  changes: string[];
  /** The project's entry with this id. */
  current: OutlineEntry | undefined;
  /** Book exercises the project files under this id. */
  exercises: number;
  unsure: boolean;
}

/** A section of the project that has no counterpart (by id) in the derived list. */
export interface YoursRow {
  /** The place in the project's outline. */
  index: number;
  entry: OutlineEntry;
  /** Book exercises filed under it. */
  exercises: number;
  /** The derived entry that looks like the same section (same printed number, else same title): the offer when its exercises move. */
  suggested: string | undefined;
}

export interface DerivePlan {
  rows: DerivedRow[];
  yours: YoursRow[];
  counts: { total: number; new: number; changed: number; same: number; unsure: number; chapters: number; sections: number };
}

export interface DeriveInput {
  structure: BookStructure;
  /** The entries of the project's own outline. */
  entries: readonly OutlineEntry[];
  /** The book exercises of the project by the section id they name. */
  groups: ReadonlyMap<string, readonly Frame[]>;
}

export interface DeriveChoices {
  /** The ids of the derived entries the person takes. */
  selected: ReadonlySet<string>;
  /** Keep every section of the project that the derived list does not have, also those without exercises. */
  keepOthers: boolean;
  /** For a section of the project that has exercises: the id of the section its exercises move to (the section itself then goes). */
  moves: Readonly<Record<string, string>>;
}

export interface DeriveOutcome {
  /** The outline the project gets. */
  entries: OutlineEntry[];
  /** The exercises that change section: frame id and the section it is filed under from now on. */
  moves: { id: string; section: string }[];
  taken: { new: number; changed: number; same: number };
  /** Sections of the project that stay although the derived list does not have them, and how many of those hold exercises. */
  kept: number;
  keptWithExercises: number;
  /** Sections of the project that are gone from the outline for good: not kept, or moved away (not those a derived entry replaces). */
  removed: number;
  /** Every derived entry is taken, so the derived list takes the place of the project's own. */
  replacing: boolean;
  /** Nothing would change: neither the outline nor any exercise. */
  nothing: boolean;
  /** Sections whose exercises were to move to a section that will not be there: they stay instead. */
  blocked: string[];
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, length = 36): string => (collapse(text).length > length ? `${collapse(text).slice(0, length - 1)}…` : collapse(text));
const fixed = (value: number | undefined): string => (value === undefined ? '-' : (Math.round(value * 100) / 100).toFixed(2));
const sameTop = (a: number | undefined, b: number | undefined): boolean => (a === undefined || b === undefined ? a === b : Math.abs(a - b) < 0.00005);

/** What the project's entry says differently from the derived one, one short phrase for each field. Pages and levels as the window shows them (from 1). */
export function differences(current: OutlineEntry, next: OutlineEntry): string[] {
  const out: string[] = [];
  if (collapse(current.title) !== collapse(next.title)) out.push(`title "${clip(current.title)}" → "${clip(next.title)}"`);
  if (current.page !== next.page) out.push(`page ${current.page + 1} → ${next.page + 1}`);
  if (!sameTop(current.top, next.top)) {
    out.push(current.top === undefined ? `heading position ${fixed(next.top)} added` : next.top === undefined ? 'heading position removed' : `heading position ${fixed(current.top)} → ${fixed(next.top)}`);
  }
  if (current.depth !== next.depth) out.push(`level ${current.depth + 1} → ${next.depth + 1}`);
  const before = collapse(current.label ?? '');
  const after = collapse(next.label ?? '');
  if (before !== after) out.push(before === '' ? `printed number "${after}" added` : after === '' ? 'printed number removed' : `printed number "${before}" → "${after}"`);
  return out;
}

/** A title without the number the entry prints in front of it, in lower case and without punctuation, to tell the same section by its words. */
function titleKey(entry: OutlineEntry): string {
  let title = collapse(entry.title).toLowerCase();
  const label = collapse(entry.label ?? '').toLowerCase();
  if (label !== '' && title.startsWith(label)) title = title.slice(label.length);
  return title.replace(/^[\s.:)-]+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const labelKey = (entry: OutlineEntry): string => collapse(entry.label ?? '').toLowerCase();

/** The derived entry that looks like the same section as the project's entry: the same printed number, else the same words. */
function suggestion(entry: OutlineEntry, rows: readonly DerivedRow[]): string | undefined {
  const label = labelKey(entry);
  if (label !== '') {
    const byLabel = rows.find((row) => labelKey(row.entry) === label);
    if (byLabel) return byLabel.entry.id;
  }
  const words = titleKey(entry);
  if (words.length >= 3) {
    const byTitle = rows.find((row) => titleKey(row.entry) === words);
    if (byTitle) return byTitle.entry.id;
  }
  return undefined;
}

/**
 * Compares the derived entries with the project's outline, by id: which are new, which the project already has exactly, which
 * differ (and how); and which sections of the project the derived list does not have. Independent of any choice.
 */
export function compareOutline(input: DeriveInput): DerivePlan {
  const byId = new Map<string, OutlineEntry>();
  for (const entry of input.entries) if (entry.id !== undefined && !byId.has(entry.id)) byId.set(entry.id, entry);
  const rows: DerivedRow[] = input.structure.entries.map((entry, at) => {
    const current = byId.get(entry.id);
    const changes = current ? differences(current, entry) : [];
    return {
      at,
      entry,
      status: current === undefined ? 'new' : changes.length === 0 ? 'same' : 'changed',
      changes,
      current,
      exercises: input.groups.get(entry.id)?.length ?? 0,
      unsure: entry.confidence < UNSURE_BELOW,
    };
  });
  const derivedIds = new Set(rows.map((row) => row.entry.id));
  const yours: YoursRow[] = [];
  input.entries.forEach((entry, index) => {
    if (entry.id !== undefined && derivedIds.has(entry.id)) return;
    yours.push({ index, entry, exercises: entry.id !== undefined ? (input.groups.get(entry.id)?.length ?? 0) : 0, suggested: suggestion(entry, rows) });
  });
  const count = (status: DeriveStatus): number => rows.filter((row) => row.status === status).length;
  return {
    rows,
    yours,
    counts: {
      total: rows.length,
      new: count('new'),
      changed: count('changed'),
      same: count('same'),
      unsure: rows.filter((row) => row.unsure).length,
      chapters: input.structure.chapters,
      sections: input.structure.sections,
    },
  };
}

/** The rows a filter shows. */
export function filterRows(rows: readonly DerivedRow[], filter: DeriveFilter): DerivedRow[] {
  switch (filter) {
    case 'new':
      return rows.filter((row) => row.status === 'new');
    case 'changed':
      return rows.filter((row) => row.status === 'changed');
    case 'same':
      return rows.filter((row) => row.status === 'same');
    case 'changes':
      return rows.filter((row) => row.status !== 'same');
    case 'unsure':
      return rows.filter((row) => row.unsure);
    default:
      return rows.slice();
  }
}

/** What is taken when nothing was chosen yet: the entries the project does not have. What it has, it keeps as it is until the person says otherwise. */
export function defaultSelection(plan: DerivePlan): Set<string> {
  return new Set(plan.rows.filter((row) => row.status === 'new').map((row) => row.entry.id));
}

/** The shape of an entry in `outline.json` (what `toOutlineEntries` gives for a derived entry). */
export function outlineEntryOf(entry: BookEntry): OutlineEntry {
  return {
    title: entry.title,
    page: entry.page,
    depth: entry.depth,
    id: entry.id,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.top !== undefined ? { top: entry.top } : {}),
  };
}

const position = (entry: OutlineEntry): [number, number] => [entry.page, entry.top ?? 0];
const after = (a: [number, number], b: [number, number]): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** The same outline? Compared by what an outline file keeps of an entry (the title's spacing and the position's last digits do not count). */
export function sameOutline(a: readonly OutlineEntry[], b: readonly OutlineEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, at) => {
    const other = b[at] as OutlineEntry;
    return differences(entry, other).length === 0 && (entry.id ?? null) === (other.id ?? null);
  });
}

/**
 * What applying would do, with these choices. The outline is the taken derived entries in their order. A section of the
 * project that stays (it holds exercises, or the derived list is not taken as a whole, or the person keeps the others) is put
 * among them by its place in the book. The derived list replaces the project's own sections only when every entry of it is
 * taken: with a part of it, nothing of the project's list is removed. The exercises of a section that was moved change their
 * section id.
 */
export function resolveDerive(input: DeriveInput, plan: DerivePlan, choices: DeriveChoices): DeriveOutcome {
  const taken = plan.rows.filter((row) => choices.selected.has(row.entry.id));
  const takenIds = new Set(taken.map((row) => row.entry.id));
  const derivedIds = new Set(plan.rows.map((row) => row.entry.id));
  const replacing = plan.rows.length > 0 && taken.length === plan.rows.length;
  const stays: OutlineEntry[] = [];
  const leaving: { entry: OutlineEntry; target: string }[] = [];
  let removed = 0;
  let kept = 0;
  let keptWithExercises = 0;
  for (const entry of input.entries) {
    if (entry.id !== undefined && takenIds.has(entry.id)) continue; // replaced by the derived entry with its id
    if (entry.id !== undefined && derivedIds.has(entry.id)) {
      stays.push(entry); // the derived version was not taken: the person's own stays as it is
      continue;
    }
    const exercises = entry.id !== undefined ? (input.groups.get(entry.id)?.length ?? 0) : 0;
    const target = entry.id !== undefined ? choices.moves[entry.id] : undefined;
    if (target !== undefined && exercises > 0) {
      leaving.push({ entry, target });
    } else if (exercises > 0 || !replacing || choices.keepOthers) {
      stays.push(entry);
      kept += 1;
      if (exercises > 0) keptWithExercises += 1;
    } else {
      removed += 1;
    }
  }
  const entries = taken.map((row) => outlineEntryOf(row.entry));
  const place = (entry: OutlineEntry): void => {
    const at = entries.findIndex((other) => after(position(other), position(entry)));
    if (at < 0) entries.push(entry);
    else entries.splice(at, 0, entry);
  };
  for (const entry of stays) place(entry);
  // A move only happens when its target will be in the outline; otherwise the section stays (never an exercise without its section).
  const present = new Set(entries.flatMap((entry) => (entry.id !== undefined ? [entry.id] : [])));
  const moves: DeriveOutcome['moves'] = [];
  const blocked: string[] = [];
  for (const { entry, target } of leaving) {
    if (present.has(target)) {
      for (const frame of input.groups.get(entry.id as string) ?? []) moves.push({ id: frame.id, section: target });
      removed += 1;
    } else {
      blocked.push(entry.id as string);
      place(entry);
      kept += 1;
      keptWithExercises += 1;
    }
  }
  const count = (status: DeriveStatus): number => taken.filter((row) => row.status === status).length;
  return {
    entries,
    moves,
    taken: { new: count('new'), changed: count('changed'), same: count('same') },
    kept,
    keptWithExercises,
    removed,
    replacing,
    nothing: moves.length === 0 && sameOutline(input.entries, entries),
    blocked,
  };
}

/** One sentence that says what was done, for the notice after applying. */
export function describeOutcome(outcome: DeriveOutcome): string {
  const parts: string[] = [];
  if (outcome.taken.new > 0) parts.push(`${outcome.taken.new} new`);
  if (outcome.taken.changed > 0) parts.push(`${outcome.taken.changed} changed`);
  const entries = outcome.entries.length;
  let text = `The book now has ${entries} section${entries === 1 ? '' : 's'}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
  if (outcome.moves.length > 0) text += `; ${outcome.moves.length} exercise${outcome.moves.length === 1 ? ' moved' : 's moved'} to another section`;
  if (outcome.keptWithExercises > 0) text += `; ${outcome.keptWithExercises} of your sections stay because exercises are filed under them`;
  return `${text}. Undo takes it back.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text of the heuristics, in the window's page numbers

/**
 * The heuristics write the pages of the file counted from 0, like the command line does ("page 9"); the window numbers them
 * from 1 ("p10"), so a person comparing the evidence with the page in front of them would be one off. The numbers after "page"
 * and "pages" are raised by one, except the page numbers the book prints itself ("printed page 12").
 */
export function inWindowPages(text: string): string {
  return text.replace(/(?<!printed )\b(pages?) (\d+(?:, \d+)*)(?![\d.])/g, (_whole, word: string, numbers: string) => `${word} ${numbers.split(', ').map((value) => String(Number(value) + 1)).join(', ')}`);
}

/** How sure the heuristics are, as a word the row can show next to the percentage. */
export function confidenceLevel(confidence: number): 'high' | 'middle' | 'low' {
  return confidence >= 0.8 ? 'high' : confidence >= UNSURE_BELOW ? 'middle' : 'low';
}
