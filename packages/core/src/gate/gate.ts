import { createHash } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import type { CompareReport } from '../book/compare.js';
import { canonicalJson } from '../calllog.js';
import type { Frame, OutlineEntry } from '../model/types.js';
import { McPrepError } from '../rules/issues.js';
import { VERIFY_CODES, type VerifyReport } from '../verify/types.js';
import {
  NOTES_FORMAT,
  NOTES_VERSION,
  type AcknowledgedFinding,
  type Acknowledgement,
  type AuditNotes,
  type GateFinding,
  type StaleAcknowledgement,
} from './types.js';

/** The pure part of the gate: what is open, what is acknowledged, from the results of the checks. */

// ---------------------------------------------------------------------------------------------------------------------
// Hashing

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The SHA-256 of the frames (in the order of their ids) and of the outline (in its order): what a gate certificate is about. */
export function hashProject(frames: readonly Frame[], outline: readonly OutlineEntry[] | undefined): { frames: string; outline: string; hash: string } {
  const sorted = [...frames].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const framesHash = sha256(canonicalJson(sorted));
  const outlineHash = sha256(canonicalJson(outline ?? []));
  return { frames: framesHash, outline: outlineHash, hash: sha256(`${framesHash}\n${outlineHash}`) };
}

/**
 * The source of a pattern with every character outside ASCII written as an escape (`ö` for the letter o with a diaeresis), so that
 * nothing that reads, shows or copies the file can mangle it. The pattern means the same.
 */
export function asciiPattern(source: string): string {
  let out = '';
  for (const char of source) {
    const code = char.codePointAt(0) as number;
    out += code < 0x80 ? char : code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the files are

/** The name of a project without `.mcprep.json`: the stem the notes and the certificate are named after. */
export function projectStem(projectPath: string): string {
  const name = basename(projectPath);
  return name.replace(/\.mcprep\.json$/i, '').replace(/\.json$/i, '');
}

export const notesPath = (projectPath: string): string => join(dirname(projectPath), `${projectStem(projectPath)}.audit-notes.json`);
export const gatePath = (projectPath: string): string => join(dirname(projectPath), `${projectStem(projectPath)}.audit-gate.json`);
export const bundlePathOf = (projectPath: string, pdfPath: string): string => join(dirname(projectPath), `${basename(pdfPath, extname(pdfPath))}.mcbundle`);

// ---------------------------------------------------------------------------------------------------------------------
// The notes

/**
 * Findings that are defects of the audit, never what the book prints: `audit ack` refuses them, the gate takes no note for them, and
 * each has the command that repairs it. (A region that cuts its label, an answer on the wrong exercise, an instruction missing from an
 * exercise are all things the book does not print: repair them.)
 */
export const NON_ACKNOWLEDGEABLE: Readonly<Record<string, string>> = {
  'label-not-first': 'Frame the exercise on its own text: look at it (`mcprep crop REF`), then `mcprep frames update REF --rect l,t,r,b --snap`, or `mcprep exercises label REF NUMBER` when its label is wrong.',
  'solution-label-missing': 'Point the exercise at its own answer: `mcprep solution remove REF`, then `mcprep solution add REF --page P --rect l,t,r,b --snap` (`mcprep render P --frames --solutions` shows the page).',
  overlap: 'Make the regions only touch: `mcprep frames update REF --rect l,t,r,b --snap` (the finding names both exercises).',
  'duplicate-region': 'Frame each printed exercise on its own text: delete the copy (`mcprep frames delete ID`) or move one of the two.',
  'section-unknown': 'File the exercise under a section of the outline: `mcprep exercises section REF SECTION-ID` (`mcprep outline` lists the ids).',
  'section-page': 'The exercise is on a page outside its section: `mcprep exercises section REF SECTION-ID`, or correct the page of the heading (`mcprep outline update ID --page N`).',
  'span-gap': 'The regions of the exercise skip text: add the missing part (`mcprep continues add REF --page P --rect l,t,r,b --snap`) or lengthen the region that ends early (`mcprep frames update REF --rect l,t,r,b --snap`).',
  'continuation-order': 'Put the regions in reading order: `mcprep continues remove REF --index N`, then `mcprep continues add REF --page P --rect l,t,r,b --snap` in the order of the text.',
  'context-range': 'The exercise has the instruction of another group: `mcprep context remove REF --all`, then `mcprep context add REF --page P --rect l,t,r,b --snap` with its own (`mcprep exercises list --section S --regions` shows the ones of its neighbours).',
  'context-missing': 'The instruction that names this exercise is not its instruction: `mcprep context add REF --page P --rect l,t,r,b --snap` with the region of that instruction (`mcprep exercises list --section S --regions`).',
  'context-inconsistent': 'Give the exercise the instruction of its group: `mcprep exercises list --section S --regions` prints the regions of its neighbours, then `mcprep context add REF --page P --rect l,t,r,b` for each region (an instruction across a page break is two).',
  'context-not-nearest': 'The nearest instruction above the exercise is its own: `mcprep context remove REF --all`, then `mcprep context add REF --page P --rect l,t,r,b --snap` with that instruction.',
  'solution-section-mismatch': 'Its answer is under the marker of another section: `mcprep solution remove REF`, then `mcprep solution add REF --page P --rect l,t,r,b --snap` with the answer printed in its own section.',
  'region-holds-item': 'The region reaches into the next exercise: `mcprep frames update REF --rect l,t,r,b --snap` so that it ends before it.',
};

/** The codes an acknowledgement may name: the codes of the verify check (but the defects of the audit) and of the comparison with the reference. */
export const ACKNOWLEDGEABLE_CODES: readonly string[] = [
  ...VERIFY_CODES.map((entry) => entry.code).filter((code) => !(code in NON_ACKNOWLEDGEABLE)),
  'reference-count',
  'reference-missing',
  'reference-extra',
  'reference-title',
];

/** A name as it is compared: two reviewers are the same one when this is the same. */
export const identityOf = (name: string): string => name.trim().toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const folded = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Why an acknowledgement is not allowed (whatever the findings are), or undefined when it is: the sentence says what is wrong and what
 * to give instead. What depends on the findings (the page, the quote, the reason against the message) is checked where they are known.
 */
export function acknowledgementProblem(entry: Acknowledgement): string | undefined {
  const code = entry.code.trim();
  if (code === '') {
    return `No --code: name the code of the finding, as \`mcprep audit gate\` prints it in square brackets. The codes that can be acknowledged are ${ACKNOWLEDGEABLE_CODES.join(', ')}.`;
  }
  const repair = NON_ACKNOWLEDGEABLE[code];
  if (repair !== undefined) return `"${code}" can never be acknowledged: it is a defect of the audit, not something the book prints. Repair it: ${repair}`;
  if (!ACKNOWLEDGEABLE_CODES.includes(code)) {
    return `"${code}" is not the code of a finding that can be acknowledged. The codes that can be are ${ACKNOWLEDGEABLE_CODES.join(', ')}; a code that is not among them (a blanket "everything" too) is refused.`;
  }
  if (entry.ref.trim() === '' || /[*?]/.test(entry.ref)) {
    return 'No --ref, or one with a wildcard: name the one exercise (SECTION:LABEL, for example 3.2:7) or the one section (3.2) the finding is about, exactly as the finding names it. A blanket acknowledgement is refused.';
  }
  if (entry.reason.trim().length < 10) {
    return `The reason has ${entry.reason.trim().length} characters; give at least 10: one sentence that says what the BOOK prints and where, for example "the book prints the number 7 twice on page 120".`;
  }
  if (!entry.ref.includes(':') && entry.count === undefined) {
    return `"${entry.ref}" is a section: say how many findings the note covers with --count N (the number of findings of that code in the section, as \`mcprep audit gate\` lists them), so that it cannot cover findings that appear later.`;
  }
  if (entry.count !== undefined && (!Number.isInteger(entry.count) || entry.count < 1)) return `--count must be a whole number from 1, not ${String(entry.count)}.`;
  if (entry.evidence.page !== undefined && (!Number.isInteger(entry.evidence.page) || entry.evidence.page < 0)) {
    return `--page must be a zero-based page number (0 is the first page), not ${String(entry.evidence.page)}.`;
  }
  const quote = entry.evidence.quote;
  if (quote !== undefined && (quote.trim().length < 4 || quote.length > 60)) {
    return `--quote has ${quote.trim().length} characters; give a piece of the text printed on the page, 4 to 60 characters, copied from \`mcprep lines PAGE\`.`;
  }
  return undefined;
}

/** Whether a reason only repeats what a finding says: it equals the message or holds all of it. */
export function reasonRepeats(reason: string, finding: Pick<GateFinding, 'message'>): boolean {
  const said = folded(reason);
  const message = folded(finding.message);
  return said === message || (message.length >= 20 && said.includes(message));
}

export function emptyNotes(): AuditNotes {
  return { format: NOTES_FORMAT, version: NOTES_VERSION, acknowledgements: [] };
}

/** The notes of a parsed file. An acknowledgement that is not allowed is kept: the gate lists it as refused and the finding stays open. */
export function parseNotes(raw: unknown, file: string): AuditNotes {
  if (!isRecord(raw) || raw['format'] !== NOTES_FORMAT || !Array.isArray(raw['acknowledgements'])) {
    throw new McPrepError('E_FILE', `"${file}" is not a file of audit notes (format ${NOTES_FORMAT}).`, { hint: 'Acknowledgements are added with `mcprep audit ack`; the file is written by it.' });
  }
  const acknowledgements: Acknowledgement[] = [];
  for (const value of raw['acknowledgements']) {
    const entry = isRecord(value) ? value : {};
    const evidence = isRecord(entry['evidence']) ? entry['evidence'] : {};
    const ack: Acknowledgement = {
      code: typeof entry['code'] === 'string' ? entry['code'] : '',
      ref: typeof entry['ref'] === 'string' ? entry['ref'] : typeof entry['section'] === 'string' ? entry['section'] : '',
      reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
      evidence: { ...(typeof evidence['page'] === 'number' ? { page: evidence['page'] } : {}), ...(typeof evidence['quote'] === 'string' ? { quote: evidence['quote'] } : {}) },
      by: typeof entry['by'] === 'string' ? entry['by'] : 'unknown',
      ...(typeof entry['count'] === 'number' ? { count: entry['count'] } : {}),
      confirmed: false,
    };
    // A confirmation counts when it names a reviewer other than the one who wrote the note.
    const confirmedBy = typeof entry['confirmedBy'] === 'string' ? entry['confirmedBy'].trim() : '';
    if (entry['confirmed'] === true && confirmedBy !== '' && identityOf(confirmedBy) !== identityOf(ack.by)) {
      ack.confirmed = true;
      ack.confirmedBy = confirmedBy;
      if (typeof entry['confirmedAt'] === 'string') ack.confirmedAt = entry['confirmedAt'];
    }
    acknowledgements.push(ack);
  }
  const patterns = Array.isArray(raw['itemPatterns']) ? raw['itemPatterns'].filter((entry): entry is string => typeof entry === 'string') : [];
  return { format: NOTES_FORMAT, version: NOTES_VERSION, ...(patterns.length > 0 ? { itemPatterns: patterns } : {}), acknowledgements };
}

// ---------------------------------------------------------------------------------------------------------------------
// The findings

/** The findings of the verify check that must be repaired or acknowledged: errors and warnings (information needs nothing). */
export function verifyFindings(report: VerifyReport): GateFinding[] {
  return report.findings
    .filter((finding) => finding.severity !== 'info')
    .map((finding) => ({
      source: 'verify',
      code: finding.code,
      severity: finding.severity as 'error' | 'warning',
      ref: finding.ref,
      page: finding.page,
      message: finding.message,
      evidence: finding.evidence,
      acknowledgeable: !(finding.code in NON_ACKNOWLEDGEABLE),
    }));
}

/** The differences with the reference as findings: a count is an error, a title a warning. */
export function referenceFindings(report: CompareReport): GateFinding[] {
  return report.differences.map((difference) => ({
    source: 'reference',
    code: `reference-${difference.kind}`,
    severity: difference.kind === 'title' ? 'warning' : 'error',
    ref: difference.label,
    page: report.sections.find((section) => section.label === difference.label)?.firstPage ?? null,
    message: difference.message,
    evidence: difference.message.slice(0, 60),
    acknowledgeable: true,
  }));
}

/**
 * Whether an acknowledgement is for this finding: the same code, the same exercise or section, and the page it names. (The quote is a piece
 * of the printed page that shows what the book prints; it does not pick the finding, so that a piece of the finding's own message cannot.)
 */
export function matches(entry: Acknowledgement, finding: GateFinding): boolean {
  if (entry.code !== finding.code || !finding.acknowledgeable) return false;
  const section = !entry.ref.includes(':');
  if (section ? finding.ref !== entry.ref && !finding.ref.startsWith(`${entry.ref}:`) : finding.ref !== entry.ref) return false;
  if (entry.evidence.page !== undefined && finding.page !== entry.evidence.page) return false;
  return true;
}

export interface Judgement {
  open: GateFinding[];
  acknowledged: AcknowledgedFinding[];
  stale: StaleAcknowledgement[];
  unused: Acknowledgement[];
  /** Notes that are not allowed (a defect of the audit, a blanket note): they apply to nothing. */
  refused: StaleAcknowledgement[];
}

/**
 * Which findings are covered by the acknowledgements. An acknowledgement that says how many findings it covers (`count`) applies
 * only when exactly that many findings match it now; one that matches none is unused (the problem was repaired); one that is not
 * allowed is refused and covers nothing.
 */
export function judge(findings: readonly GateFinding[], notes: readonly Acknowledgement[]): Judgement {
  const taken = new Set<GateFinding>();
  const acknowledged: AcknowledgedFinding[] = [];
  const stale: StaleAcknowledgement[] = [];
  const unused: Acknowledgement[] = [];
  const refused: StaleAcknowledgement[] = [];
  for (const entry of notes) {
    const problem = acknowledgementProblem(entry);
    if (problem !== undefined) {
      refused.push({ acknowledgement: entry, why: problem });
      continue;
    }
    const hits = findings.filter((finding) => !taken.has(finding) && matches(entry, finding));
    if (hits.length === 0) {
      unused.push(entry);
      continue;
    }
    if (entry.count !== undefined && hits.length !== entry.count) {
      stale.push({ acknowledgement: entry, why: `it covers ${entry.count} finding${entry.count === 1 ? '' : 's'}, and ${hits.length} match${hits.length === 1 ? 'es' : ''} now: look at them again` });
      continue;
    }
    for (const finding of hits) {
      taken.add(finding);
      acknowledged.push({ finding, acknowledgement: entry });
    }
  }
  return { open: findings.filter((finding) => !taken.has(finding)), acknowledged, stale, unused, refused };
}

/** How many of the notes that apply have not been confirmed by a second reviewer. */
export function unconfirmedNotes(acknowledged: readonly AcknowledgedFinding[]): number {
  return new Set(acknowledged.filter((entry) => !entry.acknowledgement.confirmed).map((entry) => entry.acknowledgement)).size;
}
