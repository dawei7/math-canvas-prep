import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bookReference, isAuthoritative, normalizeLabel } from '../model/authority.js';
import type { Rect } from '../model/types.js';
import type { Project } from '../project/model.js';
import { McPrepError } from '../rules/issues.js';
import type { ProjectSession } from '../session.js';
import type { GateFinding, GateReport } from './types.js';
import { visualFileOrder } from './visual.js';

/**
 * The survey record: proof that every page of the book was looked at, and what it holds. Whoever looks at the overview pictures of the pages
 * writes ranges of pages (zero-based, inclusive), each with what its pages hold: `exercises`, `answers`, `both`, `text`, `blank`, `front` or
 * `back`. The gate checks the record against the project and nothing else (it needs no layout knowledge and no heading word): every page has
 * exactly one entry, and the record and the project agree about which pages hold exercises and which hold answers. See docs/AUDIT_A_BOOK.md,
 * "The survey record".
 */

/** What a page can hold, as the record says it. */
export const SURVEY_KINDS = ['exercises', 'answers', 'both', 'text', 'blank', 'front', 'back'] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];

/** A note is at most this many characters. */
export const SURVEY_NOTE_LENGTH = 120;

/** What a kind says about a page: whether it holds exercises (or a part of one), whether it holds answers. */
export const SURVEY_HOLDS: Readonly<Record<SurveyKind, { exercises: boolean; answers: boolean }>> = {
  exercises: { exercises: true, answers: false },
  answers: { exercises: false, answers: true },
  both: { exercises: true, answers: true },
  text: { exercises: false, answers: false },
  blank: { exercises: false, answers: false },
  front: { exercises: false, answers: false },
  back: { exercises: false, answers: false },
};

/** One entry of the record: a range of pages and what they hold. */
export interface SurveyEntry {
  /** The first page of the range (zero-based). */
  from: number;
  /** The last page of the range (inclusive). */
  to: number;
  kind: SurveyKind;
  /** Optional, at most {@link SURVEY_NOTE_LENGTH} characters. */
  note?: string;
}

/** An entry as it was written: whatever the file holds; the check says what is wrong with it. */
export interface RawSurveyEntry {
  from?: unknown;
  to?: unknown;
  kind?: unknown;
  note?: unknown;
}

/** An entry as it was read, with the file of a folder it came from and its place in that file. */
export type ReadSurveyEntry = RawSurveyEntry & { file?: string; at: number };

const FORMAT_HINT =
  'The survey record is JSON: a list of ranges of pages, one entry for each range, { "from": 0, "to": 17, "kind": "front", "note": "optional, at most 120 characters" } (pages are zero-based and inclusive; kind is one of exercises, answers, both, text, blank, front, back); it may also be { "survey": [ ... ] }. Give --survey a file, or a folder of .json files (for example one file for each overview picture): they are merged in the order of their names. `mcprep schema survey` prints the format.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entries of a record, as they were written (a field that is not there is not made up: the gate says what is missing). */
export function parseSurvey(text: string, file: string): { entries: RawSurveyEntry[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new McPrepError('E_FILE', `The survey record "${file}" is not JSON: ${(error as Error).message}`, { hint: FORMAT_HINT });
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['survey']) ? raw['survey'] : isRecord(raw) && Array.isArray(raw['entries']) ? raw['entries'] : undefined;
  if (list === undefined) throw new McPrepError('E_FILE', `"${file}" is not a survey record: it is neither a list nor an object with a "survey" list.`, { hint: FORMAT_HINT });
  return {
    entries: list.map((value): RawSurveyEntry => {
      const entry = isRecord(value) ? value : {};
      return {
        ...(entry['from'] !== undefined ? { from: entry['from'] } : {}),
        ...(entry['to'] !== undefined ? { to: entry['to'] } : {}),
        ...(entry['kind'] !== undefined ? { kind: entry['kind'] } : {}),
        ...(entry['note'] !== undefined ? { note: entry['note'] } : {}),
      };
    }),
  };
}

/**
 * Reads the survey record: a file (a list of entries, or an object with a `survey` list) or a folder, in which every .json file is such a
 * list and the lists are merged in the order of the file names (numbers compared as numbers; a `sheets.json` that lies in the folder is not one
 * of them). A folder lets one small file be written for each overview picture. The entries keep the file they came from.
 */
export async function readSurvey(path: string): Promise<{ entries: ReadSurveyEntry[]; files: string[] }> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the survey record "${path}": ${(error as Error).message}`, { hint: FORMAT_HINT });
  }
  const read = async (file: string): Promise<string> => {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      throw new McPrepError('E_FILE', `Cannot read the survey record "${file}": ${(error as Error).message}`, { hint: FORMAT_HINT });
    }
  };
  if (!info.isDirectory()) return { entries: parseSurvey(await read(path), path).entries.map((entry, at): ReadSurveyEntry => ({ ...entry, at })), files: [path] };
  const names = visualFileOrder((await readdir(path, { withFileTypes: true })).filter((item) => item.isFile() && /\.json$/i.test(item.name) && item.name.toLowerCase() !== 'sheets.json').map((item) => item.name));
  if (names.length === 0) throw new McPrepError('E_FILE', `The folder "${path}" holds no .json file: the survey record is a file, or a folder of .json files, each a list of entries.`, { hint: FORMAT_HINT });
  const entries: ReadSurveyEntry[] = [];
  for (const name of names) parseSurvey(await read(join(path, name)), join(path, name)).entries.forEach((entry, at) => entries.push({ ...entry, file: name, at }));
  return { entries, files: names.map((name) => join(path, name)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The check

const finding = (code: 'survey-missing' | 'survey-overlap' | 'survey-range' | 'survey-uncovered' | 'survey-unmarked', ref: string, page: number | null, message: string, evidence: string): GateFinding => ({
  source: 'survey',
  code,
  severity: 'error',
  ref,
  page,
  message,
  evidence,
  acknowledgeable: false,
});

/** Page numbers as ranges: `[0, 1, 2, 9, 20, 21]` is `0-2`, `9`, `20-21`. */
function rangesOf(pages: readonly number[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (const page of [...pages].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && page === last.to + 1) last.to = page;
    else if (last === undefined || page > last.to) ranges.push({ from: page, to: page });
  }
  return ranges;
}

const spanText = (range: { from: number; to: number }): string => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`);

/** The first ranges of a list, as a sentence part: `0-4, 9, 20-33, ... (3 more ranges)`. */
function rangesText(ranges: readonly { from: number; to: number }[], most = 8): string {
  const shown = ranges.slice(0, most).map(spanText).join(', ');
  const more = ranges.length - most;
  return more > 0 ? `${shown}, ... (${more} more range${more === 1 ? '' : 's'})` : shown;
}

/** Pages that follow each other and share a key, as ranges. */
function groupsOf<T extends string>(pages: readonly number[], keyOf: (page: number) => T): { from: number; to: number; key: T }[] {
  const groups: { from: number; to: number; key: T }[] = [];
  for (const page of [...pages].sort((a, b) => a - b)) {
    const key = keyOf(page);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key && page === last.to + 1) last.to = page;
    else groups.push({ from: page, to: page, key });
  }
  return groups;
}

const pagesWord = (from: number, to: number): string => (from === to ? `Page ${from}` : `Pages ${from}-${to}`);
const plural = (from: number, to: number, one: string, many: string): string => (from === to ? one : many);

/** A region of an exercise on a page: the topmost one names the page. */
function touch(map: Map<number, { ref: string; top: number }>, page: number, rect: Rect, ref: string): void {
  const held = map.get(page);
  if (held === undefined || rect.top < held.top) map.set(page, { ref, top: rect.top });
}

interface Valid {
  index: number;
  from: number;
  to: number;
  kind: SurveyKind;
  /** `entry 3`, or `entry 3 of sheet-2.json`. */
  where: string;
}

/**
 * Checks the entries of a record against the project: every entry is in the format (`survey-range`), every page has an entry (`survey-missing`)
 * and no more than one (`survey-overlap`), a page the record marks as exercises (or answers) has an exercise region (or a solution region) on it
 * (`survey-uncovered`) and a page that has one is marked as holding them (`survey-unmarked`). An exercise region is the region of an exercise or
 * one of its continuations (an instruction does not count); a solution region is the region of an answer.
 */
export function surveyFindings(project: Project, entries: readonly ReadSurveyEntry[], options: { file: string; inFolder?: boolean }): { findings: GateFinding[]; summary: NonNullable<GateReport['checks']['survey']> } {
  const pageCount = project.pdf.pageCount;
  const findings: GateFinding[] = [];
  const whereOf = (entry: ReadSurveyEntry): string => (options.inFolder === true && entry.file !== undefined ? `entry ${entry.at + 1} of ${entry.file}` : `entry ${entry.at + 1}`);
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

  // 1. Every entry is in the format.
  const valid: Valid[] = [];
  entries.forEach((entry, index) => {
    const problems: string[] = [];
    if (!whole(entry.from)) problems.push(`"from" is ${entry.from === undefined ? 'missing' : `not a whole number (${JSON.stringify(entry.from)})`}`);
    if (!whole(entry.to)) problems.push(`"to" is ${entry.to === undefined ? 'missing' : `not a whole number (${JSON.stringify(entry.to)})`}`);
    const kind = typeof entry.kind === 'string' && (SURVEY_KINDS as readonly string[]).includes(entry.kind) ? (entry.kind as SurveyKind) : undefined;
    if (kind === undefined) problems.push(`"kind" is ${entry.kind === undefined ? 'missing' : `${JSON.stringify(entry.kind)}, which is none of ${SURVEY_KINDS.join(', ')}`}`);
    if (whole(entry.from) && whole(entry.to)) {
      if (entry.from > entry.to) problems.push(`"from" (${entry.from}) is after "to" (${entry.to})`);
      else if (entry.from < 0 || entry.to > pageCount - 1) problems.push(`the range ${entry.from}-${entry.to} is outside the pages of this book (0-${pageCount - 1})`);
    }
    if (entry.note !== undefined) {
      if (typeof entry.note !== 'string') problems.push('"note" is not text');
      else if (entry.note.length > SURVEY_NOTE_LENGTH) problems.push(`"note" has ${entry.note.length} characters, at most ${SURVEY_NOTE_LENGTH} are allowed`);
    }
    if (problems.length > 0) {
      const page = whole(entry.from) && entry.from >= 0 && entry.from < pageCount ? entry.from : null;
      findings.push(
        finding(
          'survey-range',
          whereOf(entry),
          page,
          `The ${whereOf(entry)} of the survey record is not in the format: ${problems.join('; ')}. Correct it: every entry is { "from": FIRST PAGE, "to": LAST PAGE, "kind": ... } with whole, zero-based page numbers from 0 to ${pageCount - 1}, from not after to, and kind one of ${SURVEY_KINDS.join(', ')} (\`mcprep schema survey\`).`,
          JSON.stringify({ from: entry.from, to: entry.to, kind: entry.kind }).slice(0, 80),
        ),
      );
      return;
    }
    valid.push({ index, from: entry.from as number, to: entry.to as number, kind: kind as SurveyKind, where: whereOf(entry) });
  });

  // 2. Every page has exactly one entry.
  const owners: number[][] = Array.from({ length: pageCount }, () => []);
  valid.forEach((entry, at) => {
    for (let page = entry.from; page <= entry.to; page += 1) (owners[page] as number[]).push(at);
  });
  const missing = owners.flatMap((list, page) => (list.length === 0 ? [page] : []));
  if (missing.length > 0) {
    const ranges = rangesOf(missing);
    findings.push(
      finding(
        'survey-missing',
        'survey',
        missing[0] as number,
        `${missing.length} page${missing.length === 1 ? ' has' : 's have'} no entry in the survey record: ${rangesText(ranges)}. Every page needs exactly one entry: look at ${missing.length === 1 ? 'it' : 'them'}, then write { "from", "to", "kind" } for each range of pages that holds the same kind of thing.`,
        `${ranges.length} range${ranges.length === 1 ? '' : 's'} without an entry: ${rangesText(ranges, 6)}`,
      ),
    );
  }
  const shared = owners.flatMap((list, page) => (list.length >= 2 ? [page] : []));
  const describe = (at: number): string => {
    const entry = valid[at] as Valid;
    return `the ${entry.where} (${spanText(entry)}, ${entry.kind})`;
  };
  for (const group of groupsOf(shared, (page) => (owners[page] as number[]).join(','))) {
    const list = group.key.split(',').map(Number);
    findings.push(
      finding(
        'survey-overlap',
        `pages ${spanText(group)}`,
        group.from,
        `${pagesWord(group.from, group.to)} ${group.from === group.to ? 'is' : 'are'} in more than one entry of the survey record: ${list.map(describe).join(' and ')}. Every page has exactly one entry: shorten one of them so that they no longer share ${group.from === group.to ? 'the page' : 'a page'}.`,
        `pages ${spanText(group)} in ${list.length} entries`,
      ),
    );
  }

  // 3. The record and the project agree about which pages hold exercises and which hold answers.
  const exerciseAt = new Map<number, { ref: string; top: number }>();
  const solutionAt = new Map<number, { ref: string; top: number }>();
  for (const frame of project.frames) {
    if (frame.kind !== 'exercise' || !isAuthoritative(frame)) continue;
    const ref = frame.label !== undefined && frame.section !== undefined ? bookReference(frame.section, normalizeLabel(frame.label).label) : frame.id;
    touch(exerciseAt, frame.page, frame.rect, ref);
    for (const region of frame.continues ?? []) touch(exerciseAt, region.page, region.rect, ref);
    for (const region of frame.solution ?? []) touch(solutionAt, region.page, region.rect, ref);
  }
  type Aspect = 'exercises' | 'answers';
  const problems: { page: number; code: 'survey-uncovered' | 'survey-unmarked'; aspect: Aspect; owner: number }[] = [];
  owners.forEach((list, page) => {
    if (list.length !== 1) return;
    const owner = list[0] as number;
    const holds = SURVEY_HOLDS[(valid[owner] as Valid).kind];
    const has: Record<Aspect, boolean> = { exercises: exerciseAt.has(page), answers: solutionAt.has(page) };
    for (const aspect of ['exercises', 'answers'] as const) {
      if (holds[aspect] && !has[aspect]) problems.push({ page, code: 'survey-uncovered', aspect, owner });
      if (!holds[aspect] && has[aspect]) problems.push({ page, code: 'survey-unmarked', aspect, owner });
    }
  });
  const flagged = { uncovered: new Set<number>(), unmarked: new Set<number>() };
  const grouped: { from: number; to: number; code: 'survey-uncovered' | 'survey-unmarked'; aspect: Aspect; owner: number }[] = [];
  for (const code of ['survey-uncovered', 'survey-unmarked'] as const) {
    for (const aspect of ['exercises', 'answers'] as const) {
      for (const owner of new Set(problems.filter((problem) => problem.code === code && problem.aspect === aspect).map((problem) => problem.owner))) {
        const pages = problems.filter((problem) => problem.code === code && problem.aspect === aspect && problem.owner === owner).map((problem) => problem.page);
        for (const page of pages) flagged[code === 'survey-uncovered' ? 'uncovered' : 'unmarked'].add(page);
        for (const range of rangesOf(pages)) grouped.push({ ...range, code, aspect, owner });
      }
    }
  }
  grouped.sort((a, b) => a.from - b.from || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.aspect < b.aspect ? -1 : 1));
  for (const group of grouped) {
    const owner = valid[group.owner] as Valid;
    const span = spanText(group);
    const these = plural(group.from, group.to, 'it', 'them');
    const marked = `${pagesWord(group.from, group.to)} ${group.from === group.to ? 'is' : 'are'} marked ${owner.kind} (the ${owner.where}, ${spanText(owner)})`;
    if (group.code === 'survey-uncovered') {
      findings.push(
        finding(
          'survey-uncovered',
          `pages ${span}`,
          group.from,
          group.aspect === 'exercises'
            ? `${marked}, and no exercise region touches ${these} (an exercise's own region or one of its continuations; an instruction does not count): frame ${plural(group.from, group.to, 'its', 'their')} exercises (\`mcprep exercises add\`), or correct the record if the page${plural(group.from, group.to, ' holds', 's hold')} none.`
            : `${marked}, and no solution region touches ${these}: frame ${plural(group.from, group.to, 'its', 'their')} answers (\`mcprep solution add\`), or correct the record if the page${plural(group.from, group.to, ' holds', 's hold')} none.`,
          `pages ${span} marked ${owner.kind}: no ${group.aspect === 'exercises' ? 'exercise' : 'solution'} region`,
        ),
      );
      continue;
    }
    const first = (group.aspect === 'exercises' ? exerciseAt : solutionAt).get(group.from) as { ref: string };
    findings.push(
      finding(
        'survey-unmarked',
        `pages ${span}`,
        group.from,
        group.aspect === 'exercises'
          ? `${marked}, but ${first.ref} has an exercise region on page ${group.from}${group.from === group.to ? '' : ` (and the pages up to ${group.to} have one)`}: the page holds exercises. Mark ${these} exercises (both, when answers are printed there too), or, if no exercise is printed there, delete the frame that does not belong (\`mcprep frames delete\`).`
          : `${marked}, but the solution region of ${first.ref} lies on page ${group.from}${group.from === group.to ? '' : ` (and the pages up to ${group.to} have one)`}: the page holds answers. Mark ${these} answers (both, when exercises are printed there too), or, if no answer is printed there, remove the solution region (\`mcprep solution remove\`).`,
        `pages ${span} marked ${owner.kind}: ${group.aspect === 'exercises' ? 'an exercise' : 'a solution'} region of ${first.ref}`,
      ),
    );
  }

  return {
    findings,
    summary: { file: options.file, pages: pageCount, entries: entries.length, missing: missing.length, uncovered: flagged.uncovered.size, unmarked: flagged.unmarked.size, exhaustive: findings.length === 0 && pageCount > 0 },
  };
}

/** Checks the record in `file` (a file, or a folder of .json files) against the project of the session. */
export async function checkSurvey(session: ProjectSession, file: string): Promise<{ findings: GateFinding[]; summary: NonNullable<GateReport['checks']['survey']> }> {
  const { entries, files } = await readSurvey(file);
  return surveyFindings(session.project, entries, { file, inFolder: files.length > 1 || (files[0] !== undefined && files[0] !== file) });
}
