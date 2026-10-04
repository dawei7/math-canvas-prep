import { writeFileAtomic } from '../fs/atomic.js';
import { McPrepError } from '../rules/issues.js';
import type { ProjectSession } from '../session.js';
import { foldText } from '../verify/labels.js';
import { acknowledgementProblem, identityOf, notesPath, reasonRepeats } from './gate.js';
import { collectFindings, patternsOf, readNotes, type GateRunOptions } from './run.js';
import { NOTES_FORMAT, NOTES_VERSION, type Acknowledgement, type AuditNotes, type GateFinding } from './types.js';

/** Adding acknowledgements to the notes, and confirming them by a second reviewer. */

const compact = (text: string): string => foldText(text).toLowerCase().replace(/\s+/g, '');

/** The notes as they are written: every acknowledgement with its `confirmed` flag. */
export async function writeNotes(session: ProjectSession, notes: AuditNotes): Promise<string> {
  const path = notesPath(session.projectPath);
  const body: AuditNotes = {
    format: NOTES_FORMAT,
    version: NOTES_VERSION,
    ...(notes.itemPatterns !== undefined ? { itemPatterns: notes.itemPatterns } : {}),
    acknowledgements: notes.acknowledgements.map((entry) => ({ ...entry, confirmed: entry.confirmed })),
  };
  await writeFileAtomic(path, `${JSON.stringify(body, null, 1)}\n`);
  return path;
}

const usage = (message: string, hint?: string): McPrepError => new McPrepError('E_USAGE', message, hint !== undefined ? { hint } : {});

const GENERAL_HINT = 'Acknowledge only what the BOOK itself prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists); repair everything else.';

/** The text of a page as it is compared: folded, lower case, without white space. */
async function pageText(session: ProjectSession, page: number): Promise<{ compact: string; start: string }> {
  const pdf = await session.document();
  const text = await pdf.pageText(page);
  const joined = text.lines.map((line) => line.text).join(' ');
  return { compact: compact(joined), start: foldText(joined).slice(0, 70) };
}

const refMatches = (ref: string, finding: GateFinding): boolean => (ref.includes(':') ? finding.ref === ref : finding.ref === ref || finding.ref.startsWith(`${ref}:`));

const listed = (findings: readonly GateFinding[], most = 6): string => findings.slice(0, most).map((entry) => `${entry.ref}${entry.page !== null ? ` (page ${entry.page})` : ''}`).join('; ') + (findings.length > most ? `; ... (${findings.length})` : '');

export interface AcknowledgeOptions extends GateRunOptions {
  entry: Acknowledgement;
}

/**
 * Adds one acknowledgement to the notes after checking everything that can be checked, so that it cannot be had by trying: the code can
 * be acknowledged at all (a defect of the audit never can), the finding exists now, the page is the finding's, the quote is a piece
 * of the text printed on that page (not of the finding's own message), the reason does not repeat the finding, and a count says how many
 * findings it covers. A new note is not confirmed: a second reviewer confirms it (`audit confirm`). A note for the same code, exercise and
 * page is replaced (and is not confirmed again).
 */
export async function addAcknowledgement(session: ProjectSession, options: AcknowledgeOptions): Promise<{ path: string; covers: GateFinding[]; replaced: boolean }> {
  const entry: Acknowledgement = { ...options.entry, confirmed: false };
  delete entry.confirmedBy;
  delete entry.confirmedAt;
  if (entry.by.trim() === '') throw usage('No --by: say who you are (a name; the one who confirms the note must be another).', GENERAL_HINT);
  const problem = acknowledgementProblem(entry);
  if (problem !== undefined) throw usage(problem, GENERAL_HINT);

  const notes = await readNotes(session);
  const collected = await collectFindings(session, { ...options, itemPatterns: patternsOf(notes, options.itemPatterns), sheets: false, bundle: false });
  const sameCode = collected.findings.filter((finding) => finding.code === entry.code);
  const candidates = sameCode.filter((finding) => refMatches(entry.ref, finding));
  if (candidates.length === 0) {
    throw usage(
      `There is no finding ${entry.code} for ${entry.ref} now, and an acknowledgement is only for a finding that exists.`,
      sameCode.length > 0
        ? `The findings ${entry.code} are for: ${listed(sameCode)}. Give --ref exactly as one of them is named (an exercise as SECTION:LABEL, a section as its id).`
        : `There is no finding ${entry.code} at all. Run \`mcprep audit gate\` and give the code and the ref of one of the open findings that can be acknowledged.`,
    );
  }

  // The page: the findings of one code for one exercise can be on several pages, and a note is for the ones on one page.
  const pages = [...new Set(candidates.map((finding) => finding.page).filter((page): page is number => page !== null))].sort((a, b) => a - b);
  let covers = candidates;
  if (pages.length > 0) {
    if (entry.evidence.page === undefined) {
      throw usage(`--page is missing: the finding ${entry.code} for ${entry.ref} is on page ${pages.join(', ')}.`, `Give --page ${pages[0] as number} (zero-based, as the finding prints it)${pages.length > 1 ? `; the findings are on pages ${pages.join(', ')}: one note for each page` : ''}.`);
    }
    covers = candidates.filter((finding) => finding.page === entry.evidence.page);
    if (covers.length === 0) {
      throw usage(`The finding ${entry.code} for ${entry.ref} is not on page ${entry.evidence.page}.`, `It is on page ${pages.join(', ')}: give --page ${pages[0] as number}.`);
    }
  } else if (entry.evidence.page !== undefined) {
    throw usage(`The finding ${entry.code} for ${entry.ref} has no page: leave out --page.`, 'A finding about a section that the outline does not have, for example, is not on a page.');
  }

  // The quote: a piece of the text printed on the page, which the finding's own words are not.
  if (entry.evidence.page !== undefined) {
    const quote = entry.evidence.quote;
    if (quote === undefined) {
      throw usage(
        `--quote is missing: give a piece of the text printed on page ${entry.evidence.page} that shows what the book prints, 4 to 60 characters.`,
        `Copy it from \`mcprep lines ${entry.evidence.page}\`, which lists the text of the page; it must be on the page, whatever the finding says.`,
      );
    }
    const text = await pageText(session, entry.evidence.page);
    if (!text.compact.includes(compact(quote))) {
      throw usage(
        `The quote "${quote}" is not in the text of page ${entry.evidence.page}.`,
        `Copy a piece of the text of that page exactly (case and spaces do not matter), from \`mcprep lines ${entry.evidence.page}\`; the page begins "${text.start}".`,
      );
    }
  }

  // The count says how many findings the note covers.
  if (entry.count !== undefined && covers.length !== entry.count) {
    throw usage(
      `${covers.length} finding${covers.length === 1 ? '' : 's'} ${covers.length === 1 ? 'matches' : 'match'} (${listed(covers, 4)}), not ${entry.count}.`,
      `Give --count ${covers.length}, which says how many findings the note covers${pages.length > 1 && entry.evidence.page === undefined ? ', or narrow it with --page' : ''}.`,
    );
  }

  // The reason is what the book prints, not what the checker says.
  const repeated = covers.find((finding) => reasonRepeats(entry.reason, finding));
  if (repeated !== undefined) {
    throw usage(
      'The reason repeats the text of the finding.',
      'Say, in your own words, what the BOOK prints that makes the finding correct, and where, for example "the book prints the number 7 twice on page 120".',
    );
  }

  const same = (other: Acknowledgement): boolean => other.code === entry.code && other.ref === entry.ref && other.evidence.page === entry.evidence.page;
  const replaced = notes.acknowledgements.some(same);
  const path = await writeNotes(session, { ...notes, acknowledgements: [...notes.acknowledgements.filter((other) => !same(other)), entry] });
  return { path, covers, replaced };
}

export interface ConfirmOptions {
  /** Who confirms: another identity than the one who wrote the note. */
  by: string;
  ref?: string;
  code?: string;
  page?: number;
  all?: boolean;
  now?: Date;
}

export interface ConfirmResult {
  path: string;
  confirmed: Acknowledgement[];
  /** Notes that were not confirmed, with the reason (written by the same identity, already confirmed, not allowed). */
  skipped: { acknowledgement: Acknowledgement; why: string }[];
}

/**
 * A second reviewer confirms acknowledgements: it looked at what each note says (`audit review` shows the page and the reason) and agrees
 * that the book prints it. The name must differ from the one who wrote the note; `all` confirms every note of the others, otherwise `ref`
 * (with `code` and `page` to narrow it) names them.
 */
export async function confirmAcknowledgements(session: ProjectSession, options: ConfirmOptions): Promise<ConfirmResult> {
  const by = options.by.trim();
  if (by === '') throw usage('No --by: say who you are (a name that is not the name of the one who wrote the acknowledgement).', 'For example --by reviewer2.');
  if (options.all === true && options.ref !== undefined) throw usage('--all confirms every acknowledgement; do not combine it with --ref.', 'Use --all, or name one with --ref REF (and --code CODE, --page N).');
  if (options.all !== true && options.ref === undefined) throw usage('Name the acknowledgement to confirm: --ref REF (with --code CODE and --page N when there are several), or --all for every one.', '`mcprep audit review --out DIR` writes the page and the reason of each one for you to look at first.');
  const notes = await readNotes(session);
  if (notes.acknowledgements.length === 0) throw usage('There are no acknowledgements to confirm.', 'Acknowledgements are added with `mcprep audit ack`.');
  const selected = options.all === true ? notes.acknowledgements : notes.acknowledgements.filter((entry) => entry.ref === options.ref && (options.code === undefined || entry.code === options.code) && (options.page === undefined || entry.evidence.page === options.page));
  if (selected.length === 0) {
    throw usage(
      `No acknowledgement for ${options.ref as string}${options.code !== undefined ? ` with code ${options.code}` : ''}${options.page !== undefined ? ` on page ${options.page}` : ''}.`,
      `The acknowledgements are: ${notes.acknowledgements.slice(0, 8).map((entry) => `${entry.code} ${entry.ref}${entry.evidence.page !== undefined ? ` (page ${entry.evidence.page})` : ''}`).join('; ')}.`,
    );
  }
  const confirmed: Acknowledgement[] = [];
  const skipped: ConfirmResult['skipped'] = [];
  const at = (options.now ?? new Date()).toISOString();
  const updated = notes.acknowledgements.map((entry): Acknowledgement => {
    if (!selected.includes(entry)) return entry;
    const problem = acknowledgementProblem(entry);
    if (problem !== undefined) {
      skipped.push({ acknowledgement: entry, why: `it is not allowed, so there is nothing to confirm: ${problem}` });
      return entry;
    }
    if (identityOf(entry.by) === identityOf(by)) {
      skipped.push({ acknowledgement: entry, why: `it was written by ${entry.by}: a second reviewer must be someone else (give another --by)` });
      return entry;
    }
    if (entry.confirmed) {
      skipped.push({ acknowledgement: entry, why: `it is confirmed already (by ${entry.confirmedBy ?? 'someone'})` });
      return entry;
    }
    const done: Acknowledgement = { ...entry, confirmed: true, confirmedBy: by, confirmedAt: at };
    confirmed.push(done);
    return done;
  });
  if (confirmed.length === 0) {
    throw usage(`Nothing was confirmed: ${skipped.slice(0, 4).map((entry) => `${entry.acknowledgement.code} ${entry.acknowledgement.ref}: ${entry.why}`).join('; ')}.`, 'A note is confirmed by a reviewer other than its author, once.');
  }
  const path = await writeNotes(session, { ...notes, acknowledgements: updated });
  return { path, confirmed, skipped };
}
