import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildBookSummary } from '../book/summary.js';
import { compareBook, type ReferenceSection } from '../book/compare.js';
import { checkBundle } from '../bundle/reader.js';
import { writeFileAtomic } from '../fs/atomic.js';
import { isAuthoritative } from '../model/authority.js';
import { findFrame } from '../project/ops.js';
import { McPrepError } from '../rules/issues.js';
import type { ProjectSession } from '../session.js';
import { sheetHash, SHEETS_FORMAT, type SheetsManifest } from '../sheets/sheets.js';
import { verifySession } from '../verify/session.js';
import { bookReference, normalizeLabel } from '../model/authority.js';
import {
  asciiPattern,
  bundlePathOf,
  emptyNotes,
  gatePath,
  hashProject,
  judge,
  notesPath,
  parseNotes,
  projectStem,
  referenceFindings,
  unconfirmedNotes,
  verifyFindings,
} from './gate.js';
import { GATE_FORMAT, GATE_VERSION, type Acknowledgement, type AuditNotes, type GateFinding, type GateReport, type GateStatus } from './types.js';
import { checkVisual } from './visual.js';

/** Running the gate on a project: the checks, the notes, the certificate. */

export interface GateRunOptions {
  /**
   * The pixel check of the edges of the regions (`edge-on-ink`: the pages are drawn once). It is part of the gate and runs unless this is
   * false (a quick loop): the certificate says whether it ran, and a book is not perfect without it.
   */
  ink?: boolean;
  itemPatterns?: readonly RegExp[];
  /** The reference list of the book (read by the caller), with the name it came from. */
  reference?: { file: string; sections: readonly ReferenceSection[] };
  /** The file in which the sheets that were looked at are listed. */
  sheetsSeen?: string;
  /** The visual record: one entry per exercise, written by whoever looked at it (see `checkVisual`). */
  visual?: string;
  now?: Date;
}

export async function readNotes(session: ProjectSession): Promise<AuditNotes> {
  const path = notesPath(session.projectPath);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyNotes();
    throw new McPrepError('E_FILE', `Cannot read the audit notes "${path}": ${(error as Error).message}`);
  }
  try {
    return parseNotes(JSON.parse(text.replace(/^\uFEFF/, '')), path);
  } catch (error) {
    if (error instanceof McPrepError) throw error;
    throw new McPrepError('E_FILE', `The audit notes "${path}" are not JSON: ${(error as Error).message}`);
  }
}

/** The item patterns of the notes file (the audit's own) followed by the ones given now. */
export function patternsOf(notes: AuditNotes, given: readonly RegExp[] | undefined): RegExp[] {
  return [...(notes.itemPatterns ?? []).map((source) => new RegExp(source, 'u')), ...(given ?? [])];
}

/** The numbers a "seen" file lists: JSON `{ "seen": [1, 2] }`, a JSON list, or text such as `1-12, 14`. */
export function parseSeen(text: string): { seen: number[]; manifest?: string } {
  const body = text.replace(/^\uFEFF/, '').trim();
  const numbersOf = (value: unknown): number[] => {
    if (Array.isArray(value)) return value.flatMap((entry) => (typeof entry === 'number' ? [entry] : typeof entry === 'string' ? numbersOf(entry) : []));
    if (typeof value === 'string') {
      return value.split(/[\s,;]+/).flatMap((piece) => {
        const range = /^(\d+)-(\d+)$/.exec(piece);
        if (range) return Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_unused, k) => Number(range[1]) + k);
        return /^\d+$/.test(piece) ? [Number(piece)] : [];
      });
    }
    return [];
  };
  if (body.startsWith('{') || body.startsWith('[')) {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return { seen: numbersOf(parsed) };
    const record = parsed as Record<string, unknown>;
    return { seen: numbersOf(record['seen']), ...(typeof record['manifest'] === 'string' ? { manifest: record['manifest'] } : {}) };
  }
  return { seen: numbersOf(body) };
}

const compact = (numbers: readonly number[]): string => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    parts.push(j === i ? String(sorted[i]) : j === i + 1 ? `${sorted[i]}, ${sorted[j]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
};

const sheetsFinding = (code: string, message: string, evidence: string): GateFinding => ({ source: 'sheets', code, severity: 'error', ref: 'sheets', page: null, message, evidence, acknowledgeable: false });

/** The contact sheets that were to be looked at: every exercise on a current sheet, every sheet listed as seen. */
async function checkSheets(session: ProjectSession, seenFile: string): Promise<{ findings: GateFinding[]; summary: NonNullable<GateReport['checks']['sheets']> }> {
  const path = resolve(seenFile);
  let seen: ReturnType<typeof parseSeen>;
  try {
    seen = parseSeen(await readFile(path, 'utf8'));
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the list of sheets that were looked at, "${seenFile}": ${(error as Error).message}`, { hint: 'It is JSON ({ "seen": [1, 2, 3] }) or text such as 1-12, 14: the numbers of the sheets in sheets.json.' });
  }
  const manifestPath = seen.manifest !== undefined ? resolve(dirname(path), seen.manifest) : resolve(dirname(path), 'sheets.json');
  let manifest: SheetsManifest;
  try {
    manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '')) as SheetsManifest;
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the list of the sheets, "${manifestPath}": ${(error as Error).message}`, { hint: 'Make the sheets with `mcprep exercises sheets --out DIR` and keep sheets.json next to the file of the sheets that were looked at, or name it with "manifest".' });
  }
  if (manifest.format !== SHEETS_FORMAT) throw new McPrepError('E_FILE', `"${manifestPath}" is not a list of sheets (format ${SHEETS_FORMAT}).`);
  const findings: GateFinding[] = [];
  const project = session.project;
  const numbers = manifest.sheets.map((sheet) => sheet.number);
  const exhaustive = manifest.scope === 'all';
  if (!exhaustive) findings.push(sheetsFinding('sheets-partial', `The sheets cover ${manifest.scope === 'sample' ? 'the fixed sample' : `the sections ${(manifest.sections ?? []).join(', ')}`}, not every exercise of the book: make them with \`mcprep exercises sheets --all\`.`, `scope ${manifest.scope}`));
  // Every sheet shows the exercises as they are now; every exercise of the book is on a sheet.
  const stale: number[] = [];
  const onSheets = new Set<string>();
  for (const sheet of manifest.sheets) {
    const frames = sheet.refs.map((ref) => findFrame(project, ref));
    sheet.refs.forEach((ref) => onSheets.add(ref));
    if (frames.some((frame) => frame === undefined) || sheetHash(frames as NonNullable<(typeof frames)[number]>[], manifest.solutions) !== sheet.hash) stale.push(sheet.number);
  }
  if (stale.length > 0) findings.push(sheetsFinding('sheets-stale', `Sheets ${compact(stale)} show exercises as they were before a later change: render them again (\`mcprep exercises sheets --from-sheet ${Math.min(...stale)}\`) and look at them again.`, `stale sheets: ${compact(stale)}`));
  if (exhaustive) {
    const missingRefs = project.frames
      .filter((frame) => isAuthoritative(frame) && frame.label !== undefined && frame.section !== undefined)
      .map((frame) => bookReference(frame.section as string, normalizeLabel(frame.label as string).label))
      .filter((ref) => !onSheets.has(ref));
    if (missingRefs.length > 0) findings.push(sheetsFinding('sheets-incomplete', `${missingRefs.length} exercises are on no sheet (they were added after the sheets were made): make the sheets again.`, missingRefs.slice(0, 6).join(', ')));
  }
  const unseen = numbers.filter((number) => !seen.seen.includes(number));
  if (unseen.length > 0) findings.push(sheetsFinding('sheets-unseen', `Sheets ${compact(unseen)} are not listed as looked at.`, `not seen: ${compact(unseen)}`));
  return { findings, summary: { file: seenFile, sheets: numbers.length, seen: numbers.length - unseen.length, missing: unseen, exhaustive, current: stale.length === 0 } };
}

export interface Collected {
  findings: GateFinding[];
  checks: GateReport['checks'];
  verify: Awaited<ReturnType<typeof verifySession>>;
  validation: Awaited<ReturnType<ProjectSession['validate']>>;
}

/** Every check of the gate, as findings. */
export async function collectFindings(session: ProjectSession, options: GateRunOptions & { sheets?: boolean; bundle?: boolean }): Promise<Collected> {
  const validation = await session.validate({ text: true });
  const ink = options.ink !== false;
  const verify = await verifySession(session, { ...(options.itemPatterns !== undefined && options.itemPatterns.length > 0 ? { itemPatterns: [...options.itemPatterns] } : {}), ...(ink ? { ink: true } : {}) });
  const findings: GateFinding[] = [
    ...validation.errors.map((issue): GateFinding => ({ source: 'validate', code: issue.code, severity: 'error', ref: issue.frameId ?? 'project', page: issue.page ?? null, message: issue.message, evidence: issue.fix ?? '', acknowledgeable: false })),
    ...verifyFindings(verify),
  ];
  const checks: GateReport['checks'] = {
    validate: { errors: validation.errors.length, warnings: validation.warnings.length },
    verify: { errors: verify.summary.errors, warnings: verify.summary.warnings, infos: verify.summary.infos, ink },
    reference: null,
    bundle: null,
    sheets: null,
    visual: null,
  };
  if (options.reference !== undefined) {
    const summary = buildBookSummary({ title: session.project.meta.title, info: session.project.meta, pageCount: session.project.pdf.pageCount, frames: session.project.frames, outline: session.project.outline?.entries });
    const report = compareBook(summary, session.project.frames, options.reference.sections);
    findings.push(...referenceFindings(report));
    checks.reference = { file: options.reference.file, differences: report.differences.length };
  }
  if (options.bundle !== false) {
    const path = bundlePathOf(session.projectPath, session.pdfPath);
    if (await stat(path).then(() => true, () => false)) {
      const check = await checkBundle(path);
      const frames = check.frames?.length ?? null;
      checks.bundle = { path, ok: check.ok, frames };
      if (!check.ok) findings.push({ source: 'bundle', code: 'bundle-rejected', severity: 'error', ref: 'bundle', page: null, message: `The last exported bundle ${path} is rejected by the importer: ${check.rejection?.message ?? 'unknown reason'}`, evidence: check.rejection?.code ?? '', acknowledgeable: false });
      else if (frames !== null && frames !== session.project.frames.length) {
        findings.push({ source: 'bundle', code: 'bundle-stale', severity: 'error', ref: 'bundle', page: null, message: `The last exported bundle ${path} has ${frames} frames and the project has ${session.project.frames.length}: export it again.`, evidence: `${frames} frames in the bundle, ${session.project.frames.length} in the project`, acknowledgeable: false });
      }
    }
  }
  if (options.sheetsSeen !== undefined && options.sheets !== false) {
    const sheets = await checkSheets(session, options.sheetsSeen);
    findings.push(...sheets.findings);
    checks.sheets = sheets.summary;
  }
  if (options.visual !== undefined && options.sheets !== false) {
    const visual = await checkVisual(session, options.visual, options.itemPatterns ?? []);
    findings.push(...visual.findings);
    checks.visual = visual.summary;
  }
  // The sheets are the exhaustive pass only when the record of what was seen covers every exercise, one entry for each.
  if (checks.sheets !== null) checks.sheets.exhaustive = checks.sheets.exhaustive && checks.visual?.exhaustive === true;
  return { findings, checks, verify, validation };
}

/** Runs the gate: every check, the acknowledgements applied, the certificate made (not written). */
export async function runGate(session: ProjectSession, options: GateRunOptions = {}): Promise<{ report: GateReport; notes: AuditNotes }> {
  const notes = await readNotes(session);
  const patterns = patternsOf(notes, options.itemPatterns);
  const collected = await collectFindings(session, { ...options, itemPatterns: patterns });
  const judged = judge(collected.findings, notes.acknowledgements);
  const hashes = hashProject(session.project.frames, session.project.outline?.entries);
  const book = collected.verify.summary;
  const unconfirmed = unconfirmedNotes(judged.acknowledged);
  const report: GateReport = {
    format: GATE_FORMAT,
    version: GATE_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
    passed: judged.open.length === 0,
    project: { name: projectStem(session.projectPath), ...hashes },
    counts: { sections: book.sections, exercises: book.authoritative, solutions: book.solutions, errors: book.errors, warnings: book.warnings, infos: book.infos, open: judged.open.length, acknowledged: judged.acknowledged.length },
    unconfirmed,
    ink: collected.checks.verify.ink,
    perfect: judged.open.length === 0 && unconfirmed === 0 && collected.checks.visual?.exhaustive === true && collected.checks.verify.ink,
    checks: collected.checks,
    itemPatterns: patterns.map((pattern) => asciiPattern(pattern.source)),
    open: judged.open,
    acknowledged: judged.acknowledged,
    staleAcknowledgements: judged.stale,
    unusedAcknowledgements: judged.unused,
    refusedAcknowledgements: judged.refused,
  };
  return { report, notes };
}

export async function writeGateReport(session: ProjectSession, report: GateReport): Promise<string> {
  const path = gatePath(session.projectPath);
  await writeFileAtomic(path, `${JSON.stringify(report, null, 1)}\n`);
  return path;
}

/** Whether the certificate on disk is for the project as it is now, and whether it passed. */
export async function gateStatus(session: ProjectSession): Promise<GateStatus> {
  const path = gatePath(session.projectPath);
  let certificate: GateReport;
  try {
    certificate = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as GateReport;
  } catch {
    return { status: 'none' };
  }
  const current = hashProject(session.project.frames, session.project.outline?.entries).hash;
  // The notes as they are now: a note that the certificate lists is confirmed when the file says so.
  const notes = await readNotes(session).catch(() => emptyNotes());
  const confirmedNow = (entry: Acknowledgement): boolean => notes.acknowledgements.some((note) => note.code === entry.code && note.ref === entry.ref && note.evidence.page === entry.evidence.page && note.confirmed);
  const listed = new Map<string, Acknowledgement>();
  for (const item of certificate.acknowledged ?? []) listed.set(`${item.acknowledgement.code}|${item.acknowledgement.ref}|${item.acknowledgement.evidence.page ?? ''}`, item.acknowledgement);
  const unconfirmed = [...listed.values()].filter((entry) => !confirmedNow(entry)).length;
  // A certificate of an older gate has no `ink`: the check ran when its verify part says so.
  const ink = certificate.ink ?? certificate.checks?.verify?.ink === true;
  const base = { certificate: certificate.project.hash, current, createdAt: certificate.createdAt, open: certificate.open.length, unconfirmed, exhaustive: certificate.checks?.visual?.exhaustive === true, ink, perfect: certificate.perfect === true && unconfirmed === 0 && ink };
  if (certificate.project.hash !== current) return { status: 'stale', ...base };
  return { status: certificate.passed ? 'passed' : 'failed', ...base };
}

