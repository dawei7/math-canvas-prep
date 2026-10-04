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
 * The source of a pattern with every character outside ASCII written as an escape (`\u00f6` for the letter o with a diaeresis), so that
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

/** The codes an acknowledgement may name: the codes of the verify check and of the comparison with the reference. */
export const ACKNOWLEDGEABLE_CODES: readonly string[] = [...VERIFY_CODES.map((entry) => entry.code), 'reference-count', 'reference-missing', 'reference-extra', 'reference-title'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why an acknowledgement is not allowed, or undefined when it is. */
export function acknowledgementProblem(entry: Acknowledgement): string | undefined {
  if (!ACKNOWLEDGEABLE_CODES.includes(entry.code)) return `"${entry.code}" is not the code of a finding that can be acknowledged (a blanket "everything" is refused).`;
  if (entry.ref.trim() === '' || /[*?]/.test(entry.ref)) return 'It names no exercise or section: a blanket acknowledgement is refused.';
  if (entry.reason.trim().length < 10) return 'The reason is too short: say what the book prints and where (at least a sentence).';
  const section = !entry.ref.includes(':');
  if (section && entry.count === undefined && (entry.evidence.quote === undefined || entry.evidence.quote.trim() === '')) {
    return 'An acknowledgement for a whole section must say how many findings it covers (count) or quote the line (quote): otherwise it would cover findings that appear later.';
  }
  if (entry.count !== undefined && (!Number.isInteger(entry.count) || entry.count < 1)) return 'count must be a whole number from 1.';
  if (entry.evidence.quote !== undefined && entry.evidence.quote.length > 60) return 'The quote is at most 60 characters.';
  return undefined;
}

export function emptyNotes(): AuditNotes {
  return { format: NOTES_FORMAT, version: NOTES_VERSION, acknowledgements: [] };
}

/** The notes of a parsed file; refuses what is not an acknowledgement the way the gate takes them. */
export function parseNotes(raw: unknown, file: string): AuditNotes {
  if (!isRecord(raw) || raw['format'] !== NOTES_FORMAT || !Array.isArray(raw['acknowledgements'])) {
    throw new McPrepError('E_FILE', `"${file}" is not a file of audit notes (format ${NOTES_FORMAT}).`, { hint: 'Acknowledgements are added with `mcprep audit ack`; the file is written by it.' });
  }
  const acknowledgements: Acknowledgement[] = [];
  raw['acknowledgements'].forEach((value, index) => {
    const entry = isRecord(value) ? value : {};
    const evidence = isRecord(entry['evidence']) ? entry['evidence'] : {};
    const ack: Acknowledgement = {
      code: typeof entry['code'] === 'string' ? entry['code'] : '',
      ref: typeof entry['ref'] === 'string' ? entry['ref'] : typeof entry['section'] === 'string' ? entry['section'] : '',
      reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
      evidence: { ...(typeof evidence['page'] === 'number' ? { page: evidence['page'] } : {}), ...(typeof evidence['quote'] === 'string' ? { quote: evidence['quote'] } : {}) },
      by: typeof entry['by'] === 'string' ? entry['by'] : 'unknown',
      ...(typeof entry['count'] === 'number' ? { count: entry['count'] } : {}),
    };
    const problem = acknowledgementProblem(ack);
    if (problem !== undefined) throw new McPrepError('E_FILE', `Acknowledgement ${index + 1} of "${file}" (${ack.code || 'no code'} ${ack.ref || 'no ref'}) is not allowed: ${problem}`, { hint: 'Remove it, or add it again with `mcprep audit ack`.' });
    acknowledgements.push(ack);
  });
  const patterns = Array.isArray(raw['itemPatterns']) ? raw['itemPatterns'].filter((entry): entry is string => typeof entry === 'string') : [];
  return { format: NOTES_FORMAT, version: NOTES_VERSION, ...(patterns.length > 0 ? { itemPatterns: patterns } : {}), acknowledgements };
}

// ---------------------------------------------------------------------------------------------------------------------
// The findings

/** The findings of the verify check that must be repaired or acknowledged: errors and warnings (information needs nothing). */
export function verifyFindings(report: VerifyReport): GateFinding[] {
  return report.findings
    .filter((finding) => finding.severity !== 'info')
    .map((finding) => ({ source: 'verify', code: finding.code, severity: finding.severity as 'error' | 'warning', ref: finding.ref, page: finding.page, message: finding.message, evidence: finding.evidence, acknowledgeable: true }));
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

const lower = (text: string): string => text.toLowerCase();

/** Whether an acknowledgement is for this finding: the same code, the same exercise or section, the page and the quote when it gives them. */
export function matches(entry: Acknowledgement, finding: GateFinding): boolean {
  if (entry.code !== finding.code || !finding.acknowledgeable) return false;
  const section = !entry.ref.includes(':');
  if (section ? finding.ref !== entry.ref && !finding.ref.startsWith(`${entry.ref}:`) : finding.ref !== entry.ref) return false;
  if (entry.evidence.page !== undefined && finding.page !== entry.evidence.page) return false;
  if (entry.evidence.quote !== undefined && entry.evidence.quote !== '') {
    const quote = lower(entry.evidence.quote);
    if (!lower(finding.evidence).includes(quote) && !lower(finding.message).includes(quote)) return false;
  }
  return true;
}

export interface Judgement {
  open: GateFinding[];
  acknowledged: AcknowledgedFinding[];
  stale: StaleAcknowledgement[];
  unused: Acknowledgement[];
}

/**
 * Which findings are covered by the acknowledgements. An acknowledgement that says how many findings it covers (`count`) applies
 * only when exactly that many findings match it now; one that matches none is unused (the problem was repaired).
 */
export function judge(findings: readonly GateFinding[], notes: readonly Acknowledgement[]): Judgement {
  const taken = new Set<GateFinding>();
  const acknowledged: AcknowledgedFinding[] = [];
  const stale: StaleAcknowledgement[] = [];
  const unused: Acknowledgement[] = [];
  for (const entry of notes) {
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
  return { open: findings.filter((finding) => !taken.has(finding)), acknowledged, stale, unused };
}
