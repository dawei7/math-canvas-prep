import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bookExercisesInOrder } from '../book/summary.js';
import { bookReference, normalizeLabel } from '../model/authority.js';
import type { Frame } from '../model/types.js';
import { McPrepError } from '../rules/issues.js';
import type { ProjectSession } from '../session.js';
import { SHEETS_FORMAT, type SheetsManifest } from '../sheets/sheets.js';
import { foldLabel, foldText, rowStartsWithLabel } from '../verify/labels.js';
import { startsLikeItem } from '../verify/lineclass.js';
import { PageIndex } from '../verify/regions.js';
import { readPageTexts } from '../verify/session.js';
import type { GateFinding, GateReport } from './types.js';

/**
 * The visual record: proof that every exercise was looked at. Whoever looks at the contact sheets writes one entry per exercise
 * (`{ ref, startsWith, instruction, answerStartsWith, ok, defect? }`), in one file or in a folder of files (one small file for each sheet),
 * and the gate checks what each entry says against the project and the text layer: a cell that was not looked at (an instruction that the
 * exercise has not, words that are not in its region, an answer that starts with another number) shows in a mismatch. See
 * docs/AUDIT_A_BOOK.md, "The gate".
 */

export interface VisualEntry {
  /** SECTION:LABEL. */
  ref: string;
  /** The first three words of the exercise after its number, as printed. */
  startsWith: string;
  /** Whether the cell shows an instruction (a blue box). */
  instruction: boolean;
  /** The number at the start of the green box (the answer), or an empty string when there is none. */
  answerStartsWith: string;
  /** False when the cell shows a defect. */
  ok: boolean;
  /** The code of the defect when `ok` is false. */
  defect?: string;
}

const FORMAT_HINT =
  'The visual record is JSON: a list with one entry per exercise, { "ref": "1.2:5", "startsWith": "the first three words", "instruction": true, "answerStartsWith": "5", "ok": true } (add "defect": "CODE" when ok is false); it may also be { "visual": [ ... ] }. Give --visual a file, or a folder of .json files (for example one file for each sheet): they are merged in the order of their names.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entries of a record, as they were written: an entry that lacks a field keeps what it has (the gate says what is missing). */
export function parseVisual(text: string, file: string): { entries: Partial<VisualEntry>[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new McPrepError('E_FILE', `The visual record "${file}" is not JSON: ${(error as Error).message}`, { hint: FORMAT_HINT });
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['visual']) ? raw['visual'] : isRecord(raw) && Array.isArray(raw['entries']) ? raw['entries'] : undefined;
  if (list === undefined) throw new McPrepError('E_FILE', `"${file}" is not a visual record: it is neither a list nor an object with a "visual" list.`, { hint: FORMAT_HINT });
  return {
    entries: list.map((value): Partial<VisualEntry> => {
      const entry = isRecord(value) ? value : {};
      return {
        ...(typeof entry['ref'] === 'string' ? { ref: entry['ref'] } : {}),
        ...(typeof entry['startsWith'] === 'string' ? { startsWith: entry['startsWith'] } : {}),
        ...(typeof entry['instruction'] === 'boolean' ? { instruction: entry['instruction'] } : {}),
        ...(typeof entry['answerStartsWith'] === 'string' ? { answerStartsWith: entry['answerStartsWith'] } : {}),
        ...(typeof entry['ok'] === 'boolean' ? { ok: entry['ok'] } : {}),
        ...(typeof entry['defect'] === 'string' ? { defect: entry['defect'] } : {}),
      };
    }),
  };
}

/** An entry as it was read, with the file of a folder it came from and its place in that file. */
export type ReadEntry = Partial<VisualEntry> & { file?: string; at: number };

/** The names of the .json files of a folder in the order they are merged: by name, numbers as numbers (sheet-2 before sheet-10). */
export function visualFileOrder(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Reads the visual record: a file (a list of entries, or an object with a `visual` list) or a folder, in which every .json file is such a
 * list and the lists are merged in the order of the file names (the manifest `sheets.json` of the sheets is not one of them). A folder
 * lets one small file be written for each sheet. The entries keep the file they came from.
 */
export async function readVisual(path: string): Promise<{ entries: ReadEntry[]; files: string[] }> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the visual record "${path}": ${(error as Error).message}`, { hint: FORMAT_HINT });
  }
  if (!info.isDirectory()) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      throw new McPrepError('E_FILE', `Cannot read the visual record "${path}": ${(error as Error).message}`, { hint: FORMAT_HINT });
    }
    return { entries: parseVisual(text, path).entries.map((entry, at): ReadEntry => ({ ...entry, at })), files: [path] };
  }
  const names = visualFileOrder((await readdir(path, { withFileTypes: true })).filter((item) => item.isFile() && /\.json$/i.test(item.name) && item.name.toLowerCase() !== 'sheets.json').map((item) => item.name));
  if (names.length === 0) {
    throw new McPrepError('E_FILE', `The folder "${path}" holds no .json file: the visual record is a file, or a folder of .json files, each a list of entries.`, { hint: FORMAT_HINT });
  }
  const entries: ReadEntry[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(path, name), 'utf8');
    } catch (error) {
      throw new McPrepError('E_FILE', `Cannot read the visual record "${join(path, name)}": ${(error as Error).message}`, { hint: FORMAT_HINT });
    }
    parseVisual(text, join(path, name)).entries.forEach((entry, at) => entries.push({ ...entry, file: name, at }));
  }
  return { entries, files: names.map((name) => join(path, name)) };
}

/** The list of the sheets (`sheets.json`) at the first of these places that holds one; nothing when none does (it only names sheets in a message). */
export async function findSheetsManifest(candidates: readonly string[]): Promise<SheetsManifest | undefined> {
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse((await readFile(candidate, 'utf8')).replace(/^\uFEFF/, '')) as SheetsManifest;
      if (manifest.format === SHEETS_FORMAT && Array.isArray(manifest.sheets)) return manifest;
    } catch {
      // not there, or not a list of sheets: the next place
    }
  }
  return undefined;
}

const finding = (code: 'visual-missing' | 'visual-mismatch' | 'visual-defect', ref: string, page: number | null, message: string, evidence: string): GateFinding => ({
  source: 'visual',
  code,
  severity: 'error',
  ref,
  page,
  message,
  evidence,
  acknowledgeable: false,
});

/** Words as they are compared: folded, lower case, without any white space. */
const compact = (text: string): string => foldText(text).toLowerCase().replace(/\s+/g, '');

const refOf = (frame: Frame): string => bookReference(frame.section as string, normalizeLabel(frame.label as string).label);

/** Sheet numbers as a sentence: `sheet 5`, `sheet 5 and 6`, `sheets 1, 4 and 9`. */
export function sheetsSentence(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 1) return `sheet ${sorted[0] as number}`;
  const head = sorted.slice(0, -1).join(', ');
  return `${sorted.length === 2 ? 'sheet' : 'sheets'} ${head} and ${sorted[sorted.length - 1] as number}`;
}

export interface CheckVisualOptions {
  /** The list of the sheets, to say which sheets hold the exercises that have no entry. */
  sheets?: SheetsManifest;
}

/**
 * Checks the record against the project: every exercise has an entry; `startsWith` (its first three words) is a piece of the text of the
 * exercise's region; `instruction` is whether the exercise has an instruction; `answerStartsWith` is the number at the start of its
 * answer's text; an entry with `ok: false` is a defect that someone saw. `file` is the record: a file, or a folder of .json files.
 */
export async function checkVisual(session: ProjectSession, file: string, patterns: readonly RegExp[], options: CheckVisualOptions = {}): Promise<{ findings: GateFinding[]; summary: NonNullable<GateReport['checks']['visual']> }> {
  const { entries, files } = await readVisual(file);
  const inFolder = files.length > 1 || (files[0] !== undefined && files[0] !== file);
  const where = (entry: ReadEntry): string => (inFolder && entry.file !== undefined ? ` of ${entry.file}` : ' of the visual record');
  const project = session.project;
  const frames = bookExercisesInOrder(project.frames, project.outline?.entries).filter((frame) => frame.label !== undefined && frame.section !== undefined);
  const pages = new Set<number>();
  for (const frame of frames) {
    pages.add(frame.page);
    const first = frame.solution?.[0];
    if (first !== undefined) pages.add(first.page);
  }
  const index = new PageIndex(await readPageTexts(session, [...pages].filter((page) => Number.isInteger(page) && page >= 0 && page < project.pdf.pageCount)));

  const findings: GateFinding[] = [];
  const byRef = new Map<string, ReadEntry>();
  for (const entry of entries) {
    if (entry.ref === undefined || entry.ref.trim() === '') {
      findings.push(finding('visual-mismatch', 'visual', null, `Entry ${entry.at + 1}${where(entry)} has no "ref": every entry names its exercise as SECTION:LABEL (for example 1.2:5).`, `entry ${entry.at + 1}${inFolder && entry.file !== undefined ? ` of ${entry.file}` : ''}`));
      continue;
    }
    const first = byRef.get(entry.ref);
    if (first !== undefined) {
      findings.push(
        finding(
          'visual-mismatch',
          entry.ref,
          null,
          `The visual record has two entries for ${entry.ref}${inFolder ? ` (${first.file ?? 'one file'} and ${entry.file ?? 'another'})` : ''}: one entry per exercise.`,
          `entry ${entry.at + 1}${inFolder && entry.file !== undefined ? ` of ${entry.file}` : ''} repeats ${entry.ref}`,
        ),
      );
      continue;
    }
    byRef.set(entry.ref, entry);
  }

  const known = new Set(frames.map(refOf));
  for (const [ref, entry] of byRef) {
    if (!known.has(ref)) findings.push(finding('visual-mismatch', ref, null, `The visual record has an entry for ${ref}${inFolder && entry.file !== undefined ? ` (in ${entry.file})` : ''}, which is no exercise of this project: check the reference (SECTION:LABEL as \`mcprep exercises list\` prints it).`, `unknown reference ${ref}`));
  }

  let missing = 0;
  let mismatches = findings.length;
  let defects = 0;
  const missingRefs: string[] = [];
  const sectionOf = new Map<string, string>();
  for (const frame of frames) {
    const ref = refOf(frame);
    const entry = byRef.get(ref);
    if (entry === undefined) {
      missing += 1;
      missingRefs.push(ref);
      sectionOf.set(ref, frame.section as string);
      continue;
    }
    const wrong = (what: string, evidence: string): void => {
      mismatches += 1;
      findings.push(finding('visual-mismatch', ref, frame.page, `The visual record does not fit ${ref} on page ${frame.page}: ${what} The cell was not looked at, or the exercise changed after it was looked at.`, evidence));
    };
    // Every field must be there and of the right kind.
    const lacking: string[] = [];
    if (entry.startsWith === undefined) lacking.push('"startsWith" (the first three words after the number)');
    if (entry.instruction === undefined) lacking.push('"instruction" (true or false)');
    if (entry.answerStartsWith === undefined) lacking.push('"answerStartsWith" (the number at the start of the green box, or "")');
    if (entry.ok === undefined) lacking.push('"ok" (true or false)');
    if (lacking.length > 0) {
      wrong(`the entry has no ${lacking.join(', ')}.`, `missing ${lacking.length} field${lacking.length === 1 ? '' : 's'}`);
      continue;
    }

    // 1. The words: three words of the entry are a piece of the text of the exercise's region.
    const region = index.page(frame.page).read(frame.rect);
    const words = foldText(entry.startsWith as string).split(' ').filter((word) => word !== '').slice(0, 3).join('');
    if (words === '') wrong('"startsWith" is empty: write the first three words printed after the number.', 'startsWith is empty');
    else if (!compact(region.text).includes(words.toLowerCase())) wrong(`"${(entry.startsWith as string).slice(0, 40)}" is not in the text of its region.`, `startsWith "${(entry.startsWith as string).slice(0, 40)}" is not in the region`);

    // 2. The instruction: the cell shows a blue box exactly when the exercise has an instruction.
    const has = (frame.context?.length ?? 0) > 0;
    if (entry.instruction !== has) {
      wrong(entry.instruction === true ? 'the record says the cell shows an instruction (a blue box), but the exercise has none.' : `the record says the cell shows no instruction, but the exercise has ${frame.context?.length ?? 0}.`, `instruction ${String(entry.instruction)} in the record, ${String(has)} in the project`);
    }

    // 3. The answer: the number at the start of the green box is the one at the start of the text of its region.
    const solution = frame.solution?.[0];
    let expected = '';
    if (solution !== undefined) {
      const answer = index.page(solution.page).read(solution.rect);
      const head = answer.margin ?? answer.straddling[0] ?? '';
      const label = foldLabel(frame.label as string);
      expected = head !== '' && rowStartsWithLabel(head, label, patterns) ? label : foldLabel(startsLikeItem(head, patterns)?.label ?? '');
    }
    const given = foldLabel(entry.answerStartsWith as string);
    if (given !== expected) {
      wrong(
        solution === undefined ? `the record says the answer starts with "${entry.answerStartsWith as string}", but the exercise has no answer.` : expected === '' ? `the record says the answer starts with "${entry.answerStartsWith as string}", but its text holds no number at the start.` : `the record says the answer starts with "${entry.answerStartsWith as string}", but the text of its region starts with ${expected}.`,
        `answerStartsWith "${entry.answerStartsWith as string}" in the record, "${expected}" in the project`,
      );
    }

    // 4. A defect that someone saw.
    if (entry.ok === false) {
      defects += 1;
      findings.push(finding('visual-defect', ref, frame.page, `${ref} on page ${frame.page} was looked at and is not right${entry.defect !== undefined && entry.defect !== '' ? `: ${entry.defect}` : ''}. Repair it, look at its sheet again and change its entry.`, entry.defect ?? 'ok is false'));
    }
  }

  // The exercises that have no entry: with the list of the sheets, one finding for each sheet that holds some, so that an entry is written for
  // each exercise of the sheet; the rest (and everything without the list of the sheets) one finding for each section.
  const sheetOf = new Map<string, number>();
  for (const sheet of options.sheets?.sheets ?? []) for (const ref of sheet.refs) if (!sheetOf.has(ref)) sheetOf.set(ref, sheet.number);
  const bySheet = new Map<number, string[]>();
  const bySection = new Map<string, string[]>();
  for (const ref of missingRefs) {
    const sheet = sheetOf.get(ref);
    const list = sheet !== undefined ? (bySheet.get(sheet) ?? []) : (bySection.get(sectionOf.get(ref) as string) ?? []);
    list.push(ref);
    if (sheet !== undefined) bySheet.set(sheet, list);
    else bySection.set(sectionOf.get(ref) as string, list);
  }
  const sheetsWithMissing = [...bySheet.keys()].sort((a, b) => a - b);
  for (const number of sheetsWithMissing) {
    const refs = bySheet.get(number) as string[];
    const total = options.sheets?.sheets.find((sheet) => sheet.number === number)?.refs.length ?? refs.length;
    findings.push(
      finding(
        'visual-missing',
        `sheet ${number}`,
        null,
        `${refs.length === total ? `The ${total} exercise${total === 1 ? '' : 's'}` : `${refs.length} of the ${total} exercises`} of sheet ${number} ${refs.length === 1 ? 'has' : 'have'} no entry in the visual record: look at the cell of each and write one entry for it.`,
        refs.slice(0, 8).join(', '),
      ),
    );
  }
  for (const [section, refs] of bySection) {
    findings.push(
      finding(
        'visual-missing',
        section,
        null,
        `${refs.length} exercise${refs.length === 1 ? '' : 's'} of section ${section} ${refs.length === 1 ? 'has' : 'have'} no entry in the visual record: one entry for every exercise, written by whoever looked at it.${options.sheets !== undefined ? ' They are on no sheet of the list of sheets: make the sheets again.' : ''}`,
        refs.slice(0, 8).join(', '),
      ),
    );
  }
  return {
    findings,
    summary: { file, entries: entries.length, files: files.length, exercises: frames.length, missing, mismatches, defects, missingSheets: sheetsWithMissing, exhaustive: missing === 0 && frames.length > 0 },
  };
}
