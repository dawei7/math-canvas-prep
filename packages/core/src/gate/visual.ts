import { readFile } from 'node:fs/promises';
import { bookExercisesInOrder } from '../book/summary.js';
import { bookReference, normalizeLabel } from '../model/authority.js';
import type { Frame } from '../model/types.js';
import { McPrepError } from '../rules/issues.js';
import type { ProjectSession } from '../session.js';
import { foldLabel, foldText, rowStartsWithLabel } from '../verify/labels.js';
import { startsLikeItem } from '../verify/lineclass.js';
import { PageIndex } from '../verify/regions.js';
import { readPageTexts } from '../verify/session.js';
import type { GateFinding, GateReport } from './types.js';

/**
 * The visual record: proof that every exercise was looked at. Whoever looks at the contact sheets writes one entry per exercise
 * (`{ ref, startsWith, instruction, answerStartsWith, ok, defect? }`), and the gate checks what each entry says against the project
 * and the text layer: a cell that was not looked at (an instruction that the exercise has not, words that are not in its region, an
 * answer that starts with another number) shows in a mismatch. See docs/AUDIT_A_BOOK.md, "The gate".
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
  'The visual record is JSON: a list with one entry per exercise, { "ref": "1.2:5", "startsWith": "the first three words", "instruction": true, "answerStartsWith": "5", "ok": true } (add "defect": "CODE" when ok is false); it may also be { "visual": [ ... ] }.';

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

/**
 * Checks the record against the project: every exercise has an entry; `startsWith` (its first three words) is a piece of the text of the
 * exercise's region; `instruction` is whether the exercise has an instruction; `answerStartsWith` is the number at the start of its
 * answer's text; an entry with `ok: false` is a defect that someone saw.
 */
export async function checkVisual(session: ProjectSession, file: string, patterns: readonly RegExp[]): Promise<{ findings: GateFinding[]; summary: NonNullable<GateReport['checks']['visual']> }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the visual record "${file}": ${(error as Error).message}`, { hint: FORMAT_HINT });
  }
  const { entries } = parseVisual(text, file);
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
  const byRef = new Map<string, Partial<VisualEntry>>();
  entries.forEach((entry, at) => {
    if (entry.ref === undefined || entry.ref.trim() === '') {
      findings.push(finding('visual-mismatch', 'visual', null, `Entry ${at + 1} of the visual record has no "ref": every entry names its exercise as SECTION:LABEL (for example 1.2:5).`, `entry ${at + 1}`));
      return;
    }
    if (byRef.has(entry.ref)) {
      findings.push(finding('visual-mismatch', entry.ref, null, `The visual record has two entries for ${entry.ref}: one entry per exercise.`, `entry ${at + 1} repeats ${entry.ref}`));
      return;
    }
    byRef.set(entry.ref, entry);
  });

  const known = new Set(frames.map(refOf));
  for (const ref of byRef.keys()) {
    if (!known.has(ref)) findings.push(finding('visual-mismatch', ref, null, `The visual record has an entry for ${ref}, which is no exercise of this project: check the reference (SECTION:LABEL as \`mcprep exercises list\` prints it).`, `unknown reference ${ref}`));
  }

  let missing = 0;
  let mismatches = findings.length;
  let defects = 0;
  const missingBySection = new Map<string, string[]>();
  for (const frame of frames) {
    const ref = refOf(frame);
    const entry = byRef.get(ref);
    if (entry === undefined) {
      missing += 1;
      const list = missingBySection.get(frame.section as string) ?? [];
      list.push(ref);
      missingBySection.set(frame.section as string, list);
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
  for (const [section, refs] of missingBySection) {
    findings.push(finding('visual-missing', section, null, `${refs.length} exercise${refs.length === 1 ? '' : 's'} of section ${section} ${refs.length === 1 ? 'has' : 'have'} no entry in the visual record: one entry for every exercise, written by whoever looked at it.`, refs.slice(0, 8).join(', ')));
  }
  return {
    findings,
    summary: { file, entries: entries.length, exercises: frames.length, missing, mismatches, defects, exhaustive: missing === 0 && frames.length > 0 },
  };
}
