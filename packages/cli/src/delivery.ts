import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ENTRY_FRAMES,
  ENTRY_OUTLINE,
  GATE_FORMAT,
  LIMITS,
  McPrepError,
  ProjectSession,
  VERSION,
  ZipArchive,
  canonicalJson,
  checkBundle,
  fileSource,
  gatePath,
  gateStatus,
  hashFile,
  notesPath,
  parseReference,
  pickDocumentInfo,
  prepareBundle,
  runGate,
  writeFileAtomic,
  writeStreamAtomic,
  type AcknowledgedFinding,
  type BundleReport,
  type GateFinding,
  type GateRunOptions,
  type GateStatus,
  type ReferenceSection,
  type ZipEntry,
} from '@mcprep/core';
import { loadQueue, type QueuedBook } from './audit-queue.js';
import { plural, table } from './format.js';

/**
 * Checking what an agent delivered (`scripts/check-delivery.mjs`). A person lets an agent audit a queue of books with the runbook: one work
 * folder for each book, ending in a project, a gate certificate, a visual record, acknowledgements and an exported bundle. This check does
 * not trust any of it: for every book it opens the delivered files, runs the gate again from scratch (in memory), asks the importer's check
 * about the bundle, makes the bundle that the project would give now and compares it with the one that was delivered. A certificate is a
 * JSON file that an agent could edit, and a bundle can be left behind by a repair after which nobody exported again; neither is believed.
 *
 * It never writes into a work folder: no certificate, no export, no lock file. (For the one question that only the gate can answer, whether
 * the project would be perfect once the acknowledgements are confirmed, it makes a copy of the project and of its notes in a temporary folder
 * of its own and removes it again.) What it cannot see is whether anybody looked at the pictures of the visual pass: a person samples a few
 * books by importing their bundle and looking.
 *
 * What perfect needs is the gate's to say: the verdict is built on `GateReport.perfect` and holds no copy of the rule.
 */

/** What the check says about one book. */
export type DeliveryStatus = 'PERFECT' | 'AWAITING CONFIRMATION' | 'NOT FINISHED' | 'MISMATCH' | 'ZERO EXERCISES' | 'UNREADABLE' | 'NOT STARTED';

/** The statuses in the order the totals are listed. */
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['PERFECT', 'AWAITING CONFIRMATION', 'NOT FINISHED', 'MISMATCH', 'ZERO EXERCISES', 'UNREADABLE', 'NOT STARTED'];

/**
 * `ok`: the importer accepts the bundle and it is what the project gives now; `stale`: it differs from the project; `rejected`: the importer's
 * check refuses it; `missing`: no bundle; `ambiguous`: several; `unverified`: the importer accepts it, but it was not compared with the project.
 */
export type BundleState = 'ok' | 'stale' | 'rejected' | 'missing' | 'ambiguous' | 'unverified';

export interface DeliveryOptions {
  /** The folder that holds one work folder for each book: `<work>/<book name>/`. */
  work: string;
  /** Names of books that may have no exercise (compared without regard to case). */
  allowZero?: readonly string[];
}

export interface DeliveryResult {
  name: string;
  status: DeliveryStatus;
  /** Why, in plain words; the main reason first. Empty for PERFECT. */
  reasons: string[];
  /** The work folder of the book. */
  folder: string;
  /** The names of the files found in the work folder (null: none). */
  files: { project: string | null; certificate: string | null; notes: string | null; bundle: string | null };
  pdf: { path: string; sha256: string | null };
  /** What the independent re-run counted (null when it did not run). */
  sections: number | null;
  exercises: number | null;
  withAnswer: number | null;
  /** The visual record the re-run read: its path, how many entries, for how many exercises, for how many of them there is one. */
  visual: { file: string; entries: number; exercises: number; covered: number; mismatches: number; defects: number; exhaustive: boolean } | null;
  /** The survey record the re-run read: its path, the pages of the book, the ranges it holds, and what is wrong with it (null: none was read). */
  survey: { file: string; pages: number; entries: number; missing: number; uncovered: number; unmarked: number; exhaustive: boolean } | null;
  /** The acknowledgements that apply: how many, how many no second reviewer confirmed, how many were confirmed by their own author. */
  acknowledgements: { total: number; unconfirmed: number; selfConfirmed: number } | null;
  /** The open findings of the re-run (the bundle is judged by a check of its own). */
  open: { total: number; byCode: Record<string, number> } | null;
  /** The comparison with the reference of the queue: how many differences; null without a reference. */
  reference: { file: string; differences: number } | null;
  /** What the certificate on disk says (null: there is none that counts). */
  certificate: { state: GateStatus['status']; passed: boolean; perfect: boolean; ink: boolean; createdAt: string | null } | null;
  /** What the re-run says (null when it did not run). */
  rerun: { passed: boolean; perfect: boolean } | null;
  bundle: { state: BundleState; sha256: string | null; accepted: boolean; differences: string[] };
  /** Seconds the check took. */
  seconds: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers

const short = (hex: string): string => `${hex.slice(0, 12)}...`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const elapsed = (since: number): number => Math.round((Date.now() - since) / 100) / 10;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const identity = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const listed = (list: readonly string[], most = 4): string => `${list.slice(0, most).join(', ')}${list.length > most ? ', ...' : ''}`;
const commaList = (text: string): string[] => text.split(',').map((name) => name.trim()).filter(Boolean);

/** The message of an error, with its code when the tools gave one (E_PDF_MISSING, E_PDF_CHANGED, ...). */
function describeError(error: unknown): string {
  if (error instanceof McPrepError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${what} ${basename(path)} cannot be read: ${(error as Error).message}`, { cause: error });
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw new Error(`${what} ${basename(path)} is not JSON: ${(error as Error).message}`, { cause: error });
  }
}

/** The path that a certificate names, and whether it is there (a relative one is taken from the work folder). */
async function namedPath(value: unknown, folder: string): Promise<{ named: string | null; path: string | null }> {
  if (typeof value !== 'string' || value.trim() === '') return { named: null, path: null };
  const path = resolve(folder, value);
  return { named: value, path: (await exists(path)) ? path : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The certificate

interface Certificate {
  passed: boolean;
  perfect: boolean;
  ink: boolean;
  hash: string;
  createdAt: string | null;
  open: number;
  unconfirmed: number;
  visualExhaustive: boolean;
  surveyExhaustive: boolean;
  itemPatterns: string[];
  sheetsFile: unknown;
  visualFile: unknown;
  surveyFile: unknown;
}

/** What the certificate says, read the way `audit gate --status` reads it; a file that is no certificate is an error that names it. */
function parseCertificate(raw: unknown, file: string): Certificate {
  if (!isRecord(raw) || raw['format'] !== GATE_FORMAT) throw new Error(`The certificate ${file} is not a gate certificate (format ${GATE_FORMAT}).`);
  const project = raw['project'];
  const hash = isRecord(project) ? project['hash'] : undefined;
  if (typeof hash !== 'string' || typeof raw['passed'] !== 'boolean' || !Array.isArray(raw['open'])) {
    throw new Error(`The certificate ${file} lacks what a gate certificate holds (project.hash, passed, open).`);
  }
  const checks = isRecord(raw['checks']) ? raw['checks'] : {};
  const verify = isRecord(checks['verify']) ? checks['verify'] : {};
  const visual = isRecord(checks['visual']) ? checks['visual'] : undefined;
  const sheets = isRecord(checks['sheets']) ? checks['sheets'] : undefined;
  const survey = isRecord(checks['survey']) ? checks['survey'] : undefined;
  return {
    passed: raw['passed'],
    perfect: raw['perfect'] === true,
    // A certificate of an older gate has no `ink`: the check ran when its verify part says so (as `gateStatus` reads it).
    ink: typeof raw['ink'] === 'boolean' ? raw['ink'] : verify['ink'] === true,
    hash,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : null,
    open: raw['open'].length,
    unconfirmed: typeof raw['unconfirmed'] === 'number' ? raw['unconfirmed'] : 0,
    visualExhaustive: visual?.['exhaustive'] === true,
    surveyExhaustive: survey?.['exhaustive'] === true,
    itemPatterns: Array.isArray(raw['itemPatterns']) ? raw['itemPatterns'].filter((entry): entry is string => typeof entry === 'string') : [],
    sheetsFile: sheets?.['file'],
    visualFile: visual?.['file'],
    surveyFile: survey?.['file'],
  };
}

/** Why a certificate that says passed does not say perfect, from what it says itself. */
function whyNotPerfect(certificate: Certificate): string {
  const parts = [
    certificate.ink ? '' : 'the pixel check of the edges did not run',
    certificate.visualExhaustive ? '' : 'the visual record did not cover every exercise',
    certificate.surveyExhaustive ? '' : 'the survey record did not cover every page',
    certificate.unconfirmed > 0 ? `${plural(certificate.unconfirmed, 'acknowledgement')} had no second reviewer` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'it says perfect: false';
}

// ---------------------------------------------------------------------------------------------------------------------
// The acknowledgements: who confirmed what

/** What identifies an acknowledgement: its code, its exercise or section and its page (the same three the gate tells its notes apart by). */
const noteKey = (code: unknown, ref: unknown, page: unknown): string => `${typeof code === 'string' ? code : ''}\u0000${typeof ref === 'string' ? ref : ''}\u0000${typeof page === 'number' ? page : ''}`;

/**
 * The acknowledgements of the re-run that their own author confirmed: `confirmed: true` with a `confirmedBy` that is the name in `by`, ignoring
 * case and spaces. `audit confirm` never writes such a confirmation and the tools count most of them as none, so it is a hand edit: it is looked
 * up in the notes file as it is on disk. (The tools compare the names without the white space at their ends only: `W r i t e r` is another
 * reviewer to them and the same one here.) Their keys, and a line for each to say what they are.
 */
async function selfConfirmedNotes(notesFile: string | null, applied: readonly AcknowledgedFinding[]): Promise<{ keys: Set<string>; labels: string[] }> {
  const found = { keys: new Set<string>(), labels: [] as string[] };
  if (notesFile === null) return found;
  const raw = await readJson(notesFile, 'The notes');
  const entries = isRecord(raw) && Array.isArray(raw['acknowledgements']) ? raw['acknowledgements'] : [];
  const live = new Set(applied.map(({ acknowledgement }) => noteKey(acknowledgement.code, acknowledgement.ref, acknowledgement.evidence.page)));
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const evidence = isRecord(entry['evidence']) ? entry['evidence'] : {};
    const ref = typeof entry['ref'] === 'string' ? entry['ref'] : entry['section'];
    const by = typeof entry['by'] === 'string' ? entry['by'] : 'unknown';
    const confirmedBy = typeof entry['confirmedBy'] === 'string' ? entry['confirmedBy'] : '';
    const key = noteKey(entry['code'], ref, evidence['page']);
    if (entry['confirmed'] !== true || identity(confirmedBy) === '' || identity(confirmedBy) !== identity(by) || !live.has(key)) continue;
    found.keys.add(key);
    found.labels.push(`${String(entry['code'])} ${String(ref)}, written and confirmed by ${by.trim()}`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// The bundle

interface ImporterCheck {
  path: string;
  sha256: string | null;
  accepted: boolean;
  rejection: string | null;
  report: BundleReport | null;
}

/** The SHA-256 of the bundle and what the importer's own check says about it. */
async function importerCheck(path: string): Promise<ImporterCheck> {
  const sha256 = await hashFile(path).then(
    (hashed) => hashed.sha256,
    () => null,
  );
  try {
    const report = await checkBundle(path);
    return { path, sha256, accepted: report.ok, rejection: report.ok ? null : (report.rejection?.message ?? 'the importer refuses it'), report };
  } catch (error) {
    return { path, sha256, accepted: false, rejection: describeError(error), report: null };
  }
}

async function entryBytes(entry: ZipEntry): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const chunk of entry.chunks()) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** `frames.json` and `outline.json` of a bundle on disk (an entry that is not there is undefined). */
async function deliveredEntries(path: string): Promise<{ frames?: Uint8Array; outline?: Uint8Array }> {
  const source = await fileSource(path);
  let archive: ZipArchive;
  try {
    archive = await ZipArchive.open(source, { maxEntries: LIMITS.bundle.maxEntries, maxArchiveBytes: LIMITS.bundle.maxArchiveBytes });
  } catch (error) {
    await source.close().catch(() => undefined);
    throw error;
  }
  try {
    const out: { frames?: Uint8Array; outline?: Uint8Array } = {};
    const frames = archive.find(ENTRY_FRAMES)[0];
    if (frames !== undefined) out.frames = await archive.read(frames, LIMITS.bundle.maxJsonBytes);
    const outline = archive.find(ENTRY_OUTLINE)[0];
    if (outline !== undefined) out.outline = await archive.read(outline, LIMITS.bundle.maxJsonBytes);
    return out;
  } finally {
    await archive.close();
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

function parsed(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** What differs between the frames of the bundle and the frames that the project writes now, by frame id. */
function framesDifference(delivered: Uint8Array, project: readonly { id: string }[]): string {
  const raw = parsed(delivered);
  const list = isRecord(raw) && Array.isArray(raw['frames']) ? raw['frames'] : [];
  const inBundle = new Map<string, string>();
  for (const frame of list) if (isRecord(frame) && typeof frame['id'] === 'string') inBundle.set(frame['id'], canonicalJson(frame));
  const inProject = new Map(project.map((frame) => [frame.id, canonicalJson(frame)]));
  const changed = [...inProject.keys()].filter((id) => inBundle.has(id) && inBundle.get(id) !== inProject.get(id));
  const onlyProject = [...inProject.keys()].filter((id) => !inBundle.has(id));
  const onlyBundle = [...inBundle.keys()].filter((id) => !inProject.has(id));
  const parts = [
    changed.length > 0 ? `${plural(changed.length, 'frame')} ${changed.length === 1 ? 'differs' : 'differ'} (${listed(changed)})` : '',
    onlyProject.length > 0 ? `${plural(onlyProject.length, 'frame')} only in the project (${listed(onlyProject)})` : '',
    onlyBundle.length > 0 ? `${plural(onlyBundle.length, 'frame')} only in the bundle (${listed(onlyBundle)})` : '',
  ].filter(Boolean);
  const counts = `${inBundle.size} frames in the bundle, ${inProject.size} in the project`;
  return parts.length > 0 ? `frames.json is not the project's frames: ${parts.join('; ')} (${counts})` : `frames.json is not what the project writes now, though it holds the same frames (${counts}): they are in another order or form`;
}

/** The value of a field of the manifest, for a message (a long text is cut). */
function shown(value: unknown): string {
  if (value === undefined) return 'none';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.length > 40 ? `${text.slice(0, 37)}...` : text}"`;
}

/**
 * What the bundle on disk has that the project would not write now. The bundle the project gives now is made exactly as `export` makes it
 * (the document information of the project, its title and folder, the page count of the PDF, its frames, its own outline); its `frames.json` and
 * `outline.json` must be byte for byte the delivered ones, and the document of the manifest (title, folder, SHA-256 and size of the PDF, page
 * count, author, series, description, licence, source address, notice) the same. The time of the export and the name of the PDF are not compared.
 */
async function compareBundle(delivered: ImporterCheck, session: ProjectSession): Promise<string[]> {
  const project = session.project;
  const pdf = await session.document();
  const prepared = await prepareBundle({
    pdfPath: session.pdfPath,
    info: pickDocumentInfo(project.meta),
    title: project.meta.title,
    ...(project.meta.folder !== undefined ? { folder: project.meta.folder } : {}),
    pageCount: pdf.pageCount,
    frames: project.frames,
    ...(project.outline !== undefined ? { outline: project.outline.entries } : {}),
    expect: { sha256: project.pdf.sha256, bytes: project.pdf.bytes },
  }).catch((error: unknown) => `the project cannot be exported as it is now: ${describeError(error)}`);
  if (typeof prepared === 'string') return [prepared];
  const differences: string[] = [];

  const document = delivered.report?.manifest?.document as unknown as Record<string, unknown> | undefined;
  const expected = prepared.manifest.document as unknown as Record<string, unknown>;
  for (const key of ['title', 'folder', 'sha256', 'bytes', 'pageCount', 'author', 'series', 'description', 'license', 'sourceUrl', 'notice']) {
    const have = document?.[key];
    const want = expected[key];
    if (canonicalJson(have) === canonicalJson(want)) continue;
    differences.push(key === 'sha256' ? `the SHA-256 of its PDF is ${typeof have === 'string' ? short(have) : 'missing'}, the project's PDF has ${short(project.pdf.sha256)}` : `its ${key} is ${shown(have)}, the project's is ${shown(want)}`);
  }

  const bytes = await deliveredEntries(delivered.path);
  const framesEntry = prepared.entries.find((entry) => entry.name === ENTRY_FRAMES);
  if (framesEntry !== undefined && (bytes.frames === undefined || !sameBytes(bytes.frames, await entryBytes(framesEntry)))) {
    differences.push(bytes.frames === undefined ? 'it has no frames.json' : framesDifference(bytes.frames, prepared.frames));
  }
  const outlineEntry = prepared.entries.find((entry) => entry.name === ENTRY_OUTLINE);
  const outlineSize = prepared.outline?.length ?? 0;
  if (outlineEntry === undefined && bytes.outline !== undefined) differences.push('it has an outline.json, the project has no outline');
  else if (outlineEntry !== undefined && bytes.outline === undefined) differences.push(`it has no outline.json, the project has an outline of ${plural(outlineSize, 'entry', 'entries')}`);
  else if (outlineEntry !== undefined && bytes.outline !== undefined && !sameBytes(bytes.outline, await entryBytes(outlineEntry))) {
    const raw = parsed(bytes.outline);
    const have = isRecord(raw) && Array.isArray(raw['entries']) ? raw['entries'].length : '?';
    differences.push(`outline.json is not the project's outline (${have} entries in the bundle, ${outlineSize} in the project)`);
  }
  return differences;
}

/** The differences of the bundle; a comparison that cannot be made is a difference of its own and does not stop the check of the book. */
async function bundleDifferences(delivered: ImporterCheck, session: ProjectSession): Promise<string[]> {
  try {
    return await compareBundle(delivered, session);
  } catch (error) {
    return [`it could not be compared with the project: ${describeError(error)}`];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The verdict

/** The open findings by code (the most frequent first) and how they read in a sentence. */
function summarizeOpen(open: readonly GateFinding[]): { total: number; byCode: Record<string, number>; text: string } {
  const counts = new Map<string, number>();
  for (const finding of open) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
  const most = ordered.slice(0, 3).map(([code, n]) => `${code} ${n}`);
  const more = ordered.length - 3;
  return { total: open.length, byCode: Object.fromEntries(ordered), text: `${plural(open.length, 'open finding')} (${most.join(', ')}${more > 0 ? `, and ${plural(more, 'more code')}` : ''})` };
}

interface Facts {
  allowZero: boolean;
  exercises: number;
  /** The exercises that the reference of the queue lists, when it has one. */
  referenceExercises: number | null;
  /** The certificate that counts (current or not); undefined when there is none, and `certificateProblem` says why. */
  certificate: Certificate | undefined;
  certificateProblem: string | undefined;
  certificateState: GateStatus['status'];
  notesProblem: string | undefined;
  /** The open findings of the re-run, the bundle's left out. */
  open: GateFinding[];
  rerunHash: string;
  ink: boolean;
  /** The gate's own verdict of the new run (`GateReport.perfect`): the check holds no copy of what the gate asks for. */
  gatePerfect: boolean;
  /** What the gate's own verdict would be with every acknowledgement confirmed; undefined when that was not asked (nothing waits for confirmation, or something is open). */
  perfectIfConfirmed: boolean | undefined;
  visual: { covered: number; exercises: number; exhaustive: boolean } | null;
  /** Why no visual record stands behind the certificate (it names none, or what it names is gone). */
  visualProblem: string | undefined;
  /** The survey record of the new run (null: none was read). */
  survey: { pages: number; entries: number; missing: number; uncovered: number; unmarked: number; exhaustive: boolean } | null;
  /** Why no survey record stands behind the certificate (it names none, or what it names is gone). */
  surveyProblem: string | undefined;
  unconfirmed: number;
  unconfirmedNotes: string[];
  selfConfirmed: string[];
  bundleState: BundleState;
  bundleReason: string | undefined;
  bundleDifferences: string[];
}

/**
 * What the re-run says by itself: whether it passed (nothing open) and whether it is perfect. Perfect is the gate's own verdict, whatever
 * the gate asks for, and not an acknowledgement that its author confirmed. A book without exercises has no exercise to look at, so the gate
 * cannot say it for it (it needs an entry of the visual record for every exercise): there the re-run is perfect when nothing is open, the
 * pixel check ran, every page was surveyed (that is how a person knows that the book prints no exercise) and nothing is unconfirmed.
 */
function rerunSays(f: Facts): { passed: boolean; perfect: boolean; visualMissing: boolean; surveyMissing: boolean } {
  const passed = f.open.length === 0;
  const visualMissing = f.exercises > 0 && f.visual?.exhaustive !== true;
  // No survey record was read: whatever it would say, the pages were not shown to have been looked at. (One that was read and is not whole has
  // its findings open.)
  const surveyMissing = f.survey === null;
  const perfect = (f.exercises === 0 ? passed && f.ink && f.unconfirmed === 0 && f.survey?.exhaustive === true : f.gatePerfect) && f.selfConfirmed.length === 0;
  return { passed, visualMissing, surveyMissing, perfect };
}

interface Reason {
  /** What the reason is about, so that a reason that another one already says is not said twice. */
  key: string;
  text: string;
}

/**
 * The verdict. MISMATCH is where something that the delivery claims is not what the files show: a certificate that says passed or perfect for
 * a state that the re-run finds open, an acknowledgement confirmed by its own author, a current certificate beside a bundle that is not the
 * project's. Then a book without exercises; then PERFECT, AWAITING CONFIRMATION, or what is still to do (NOT FINISHED). What counts as perfect
 * is the gate's: this decides nothing about it that the gate does not say.
 */
function judge(f: Facts): { status: DeliveryStatus; reasons: string[] } {
  const certificate = f.certificate;
  const current = certificate !== undefined && (f.certificateState === 'passed' || f.certificateState === 'failed');
  const empty = f.exercises === 0;
  const says = rerunSays(f);
  const open = summarizeOpen(f.open);
  const visualFact = f.visual === null ? (f.visualProblem ?? 'there is no visual record behind it') : `the visual record covers ${f.visual.covered} of ${plural(f.visual.exercises, 'exercise')}`;
  const surveyFact = f.survey === null ? (f.surveyProblem ?? 'there is no survey record behind it') : '';
  const surveyText = `${surveyFact.charAt(0).toUpperCase()}${surveyFact.slice(1)}: nothing proves that every page of the book was looked at.`;
  const visualText = f.visual === null ? `${visualFact.charAt(0).toUpperCase()}${visualFact.slice(1)}: nothing proves that every exercise was looked at.` : `The visual record covers ${f.visual.covered} of ${plural(f.visual.exercises, 'exercise')}.`;
  const bundleText = ((): string => {
    if (f.bundleState === 'missing') return 'There is no bundle (*.mcbundle) in the work folder: export it (mcprep export).';
    if (f.bundleState === 'ambiguous') return f.bundleReason ?? 'There is more than one bundle in the work folder: exactly one is expected.';
    if (f.bundleState === 'rejected') return `The importer's check rejects the bundle: ${f.bundleReason ?? 'no reason given'}. Export again.`;
    return `The bundle is stale: ${f.bundleDifferences.join('; ')}. Export again.`;
  })();

  // What the delivery claims and the files do not show; `covers` are the reasons of the list below that such a claim says already.
  const mismatches: { text: string; covers: string[] }[] = [];
  if (f.selfConfirmed.length > 0) {
    mismatches.push({
      text: `${plural(f.selfConfirmed.length, 'acknowledgement')} confirmed by the one who wrote ${f.selfConfirmed.length === 1 ? 'it' : 'them'} (${listed(f.selfConfirmed)}): the tools write no such confirmation, so the notes file was edited by hand. A second reviewer must confirm (mcprep audit confirm --by NAME).`,
      covers: ['unconfirmed'],
    });
  }
  if (certificate !== undefined && current) {
    if (certificate.passed && !says.passed) {
      mismatches.push({ text: `The certificate says the gate passed, but the re-run has ${open.text}. The certificate does not describe this project.`, covers: ['open'] });
    } else if (certificate.perfect && !says.perfect) {
      // The gate's own verdict is not perfect; what is known of why is said, and the rest is the gate's to say. (A claim of perfect that fails
      // only because of an acknowledgement confirmed by its own author is said by that reason.)
      const why = [
        says.passed ? '' : `it has ${open.text}`,
        says.visualMissing ? visualFact : '',
        says.surveyMissing ? surveyFact : '',
        f.unconfirmed > 0 && f.selfConfirmed.length === 0 ? `${plural(f.unconfirmed, 'acknowledgement')} ${f.unconfirmed === 1 ? 'is' : 'are'} not confirmed by a second reviewer` : '',
      ].filter(Boolean);
      if (why.length > 0 || f.selfConfirmed.length === 0) {
        mismatches.push({
          text: `The certificate says perfect, but the re-run is not${why.length > 0 ? `: ${why.join('; ')}` : ' (the gate does not call this project perfect now: mcprep audit gate --final says why)'}.`,
          covers: ['open', 'visual', 'survey', 'unconfirmed', 'gate'],
        });
      }
    }
    if (certificate.passed && f.bundleState === 'stale') {
      mismatches.push({ text: `The certificate is current and says the gate passed, but the bundle differs from the project: ${f.bundleDifferences.join('; ')}. Export again.`, covers: ['bundle'] });
    }
  }

  const zero =
    empty && !f.allowZero
      ? f.referenceExercises !== null && f.referenceExercises > 0
        ? `The audit has 0 exercises, but the reference lists ${plural(f.referenceExercises, 'exercise')}: the audit probably missed them. Look at the text of the PDF first (mcprep lines PAGE) before anything is decided.`
        : 'The audit has 0 exercises. A person decides whether the book prints none (then list it with --allow-zero NAME) or the audit missed them: look at the text of the PDF first (mcprep lines PAGE).'
      : undefined;

  // What is still to do, in the order a person would do it.
  const todo: Reason[] = [];
  if (f.certificateProblem !== undefined) todo.push({ key: 'certificate', text: f.certificateProblem });
  if (certificate !== undefined && f.certificateState === 'stale') todo.push({ key: 'stale', text: 'The certificate is stale: the frames or the outline changed after the gate ran. Run audit gate again, and export again.' });
  if (certificate !== undefined && !certificate.ink) todo.push({ key: 'ink', text: 'The pixel check of the edges did not run when the gate ran (the certificate says ink: false). Run audit gate without --no-ink.' });
  if (!says.passed) todo.push({ key: 'open', text: `The re-run has ${open.text}.` });
  if (says.visualMissing && certificate !== undefined) todo.push({ key: 'visual', text: visualText });
  if (says.surveyMissing && certificate !== undefined) todo.push({ key: 'survey', text: surveyText });
  if (certificate !== undefined && current && !certificate.passed && says.passed) {
    todo.push({ key: 'certificate', text: `The certificate says the gate did not pass (${plural(certificate.open, 'open finding')} when it ran), although the re-run finds none now. Run audit gate again.` });
  }
  if (certificate !== undefined && current && certificate.passed && !certificate.perfect && !empty && says.perfect) {
    todo.push({ key: 'certificate', text: `The certificate says passed but not perfect (${whyNotPerfect(certificate)}), although the re-run is perfect now. Run audit gate --final again.` });
  }
  if (f.unconfirmed > 0) {
    todo.push({ key: 'unconfirmed', text: `${plural(f.unconfirmed, 'acknowledgement')} ${f.unconfirmed === 1 ? 'waits' : 'wait'} for a second reviewer (${listed(f.unconfirmedNotes)}): mcprep audit review, then mcprep audit confirm --by NAME, then mcprep audit gate --final.` });
  }
  // What the gate asks for that nothing above names: its own verdict counts, and this holds no copy of it.
  const named = !says.passed || says.visualMissing || says.surveyMissing;
  if (!empty && f.selfConfirmed.length === 0 && !named) {
    if (f.unconfirmed === 0 && !says.perfect) {
      todo.push({ key: 'gate', text: 'The gate does not call this project perfect, and no check above says why: run mcprep audit gate --final to see what it asks for.' });
    } else if (f.unconfirmed > 0 && f.perfectIfConfirmed === false) {
      todo.push({ key: 'gate', text: 'Even with every acknowledgement confirmed the gate would not call this project perfect: run mcprep audit gate --final to see what else it asks for.' });
    }
  }
  if (f.notesProblem !== undefined) todo.push({ key: 'notes', text: f.notesProblem });
  if (f.bundleState !== 'ok' && f.bundleState !== 'unverified') todo.push({ key: 'bundle', text: bundleText });
  const remaining = (covered: readonly string[]): string[] => todo.filter((reason) => !covered.includes(reason.key)).map((reason) => reason.text);

  if (mismatches.length > 0) return { status: 'MISMATCH', reasons: [...mismatches.map((entry) => entry.text), ...(zero !== undefined ? [zero] : []), ...remaining(mismatches.flatMap((entry) => entry.covers))] };
  if (zero !== undefined) return { status: 'ZERO EXERCISES', reasons: [zero, ...remaining([])] };

  // A delivery is complete when its certificate is current and passed for the project the new run saw, its bundle is the project's, and the
  // files are the ones the tools read. Then the gate's own verdict decides: perfect is PERFECT; perfect with the acknowledgements confirmed
  // is AWAITING CONFIRMATION. (A book without exercises has nothing to say in its certificate beyond passed.)
  const complete = certificate !== undefined && current && certificate.passed && certificate.hash === f.rerunHash && f.bundleState === 'ok' && f.notesProblem === undefined && f.certificateProblem === undefined;
  if (certificate !== undefined && complete) {
    if (says.perfect && (empty || certificate.perfect)) return { status: 'PERFECT', reasons: [] };
    const waits = f.unconfirmed > 0 && f.selfConfirmed.length === 0 && says.passed && (empty ? f.ink : f.perfectIfConfirmed === true);
    if (waits) return { status: 'AWAITING CONFIRMATION', reasons: todo.filter((reason) => reason.key === 'unconfirmed').map((reason) => reason.text) };
  }
  const reasons = remaining([]);
  return { status: 'NOT FINISHED', reasons: reasons.length > 0 ? reasons : ['The delivery is not complete and no single check says why: run audit gate --final, and export again.'] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The check of one book

const blank = (name: string, pdf: string, folder: string): DeliveryResult => ({
  name,
  status: 'NOT STARTED',
  reasons: [],
  folder,
  files: { project: null, certificate: null, notes: null, bundle: null },
  pdf: { path: pdf, sha256: null },
  sections: null,
  exercises: null,
  withAnswer: null,
  visual: null,
  survey: null,
  acknowledgements: null,
  open: null,
  reference: null,
  certificate: null,
  rerun: null,
  bundle: { state: 'missing', sha256: null, accepted: false, differences: [] },
  seconds: 0,
});

/** The expressions of the certificate, which must compile. */
const compilePatterns = (sources: readonly string[]): RegExp[] =>
  sources.map((source) => {
    try {
      return new RegExp(source, 'u');
    } catch (error) {
      throw new Error(`The certificate lists the item pattern ${JSON.stringify(source)}, which is no regular expression: ${(error as Error).message}`, { cause: error });
    }
  });

/** The reference of the queue, read the way `audit gate --reference` reads it. */
async function readReferenceFile(path: string, chapterOffset: number): Promise<ReferenceSection[]> {
  let raw: unknown;
  try {
    raw = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read the reference "${path}": ${(error as Error).message}`, { cause: error });
  }
  return parseReference(raw, chapterOffset);
}

/**
 * What `runGate` is given for a book. `bundle: false` (the bundle is judged by a check of its own below, which is stronger than the gate's, that
 * counts the frames only) is an option of the checks inside the gate that `runGate` passes on without naming it; a gate that does not know it
 * ignores it.
 */
type RerunOptions = GateRunOptions & { bundle?: boolean };

/**
 * The options of the new run, made in one place: the item patterns of the certificate, the pixel check always, the reference of the queue, and
 * what the certificate names when it is there (the list of contact sheets, the visual record, the survey). The notes file brings its own patterns.
 */
function rerunOptions(input: { patterns: RegExp[]; reference?: { file: string; sections: ReferenceSection[] }; sheetsSeen: string | null; visual: string | null; survey: string | null }): RerunOptions {
  return {
    ink: true,
    bundle: false,
    ...(input.patterns.length > 0 ? { itemPatterns: input.patterns } : {}),
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    ...(input.sheetsSeen !== null ? { sheetsSeen: input.sheetsSeen } : {}),
    ...(input.visual !== null ? { visual: input.visual } : {}),
    ...(input.survey !== null ? { survey: input.survey } : {}),
  };
}

/**
 * Whether the gate's own verdict is perfect once every acknowledgement is confirmed: the gate is run once more, on a copy of the project and of
 * its notes in a folder of its own (outside the work folder, removed again) in which a reviewer has confirmed every note. What the gate asks
 * for besides confirmed notes is then the gate's to say, and this holds no copy of it.
 */
async function perfectWithNotesConfirmed(session: ProjectSession, notesFile: string, options: RerunOptions): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), `mcprep-check-${process.pid}-`));
  let shadow: ProjectSession | undefined;
  try {
    const project = (await readJson(session.projectPath, 'The project')) as Record<string, unknown>;
    const projectPath = join(dir, basename(session.projectPath));
    await writeFile(projectPath, JSON.stringify({ ...project, pdf: { ...(isRecord(project['pdf']) ? project['pdf'] : {}), path: session.pdfPath } }));
    const notes = (await readJson(notesFile, 'The notes')) as Record<string, unknown>;
    const confirm = (entry: unknown): unknown => (isRecord(entry) ? { ...entry, confirmed: true, confirmedBy: `${typeof entry['by'] === 'string' ? entry['by'] : 'unknown'}-reviewer`, confirmedAt: new Date().toISOString() } : entry);
    await writeFile(notesPath(projectPath), JSON.stringify({ ...notes, acknowledgements: Array.isArray(notes['acknowledgements']) ? notes['acknowledgements'].map(confirm) : [] }));
    shadow = await ProjectSession.open(projectPath);
    return (await runGate(shadow, options)).report.perfect;
  } finally {
    await shadow?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/**
 * Checks what was delivered for one book, from scratch: the project, the certificate, the notes and the bundle in `<work>/<name>/` are opened,
 * the gate is run again in memory (with the item patterns of the certificate, the pixel check, the reference of the queue, and the sheets and
 * the visual record that the certificate names when they are there), and the bundle is compared with the one the project gives now. Nothing is
 * written into the work folder.
 */
export async function checkDelivery(book: QueuedBook, options: DeliveryOptions): Promise<DeliveryResult> {
  const started = Date.now();
  const folder = join(resolve(options.work), book.name);
  const result = blank(book.name, book.pdf, folder);
  const finish = (status: DeliveryStatus, reasons: string[]): DeliveryResult => ({ ...result, status, reasons, seconds: elapsed(started) });

  const info = await stat(folder).catch(() => undefined);
  if (info === undefined) return finish('NOT STARTED', [`There is no work folder ${folder}.`]);
  if (!info.isDirectory()) return finish('NOT STARTED', [`${folder} is not a folder.`]);
  let files: string[];
  try {
    files = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name).sort(byName);
  } catch (error) {
    return finish('UNREADABLE', [`The work folder ${folder} cannot be read: ${describeError(error)}`]);
  }
  const ending = (suffix: string): string[] => files.filter((name) => name.toLowerCase().endsWith(suffix));
  // What there is of a bundle is known whatever else is wrong (the importer's check comes later).
  const bundleFiles = ending('.mcbundle');
  const [onlyBundle] = bundleFiles;
  if (onlyBundle !== undefined && bundleFiles.length === 1) {
    result.files.bundle = onlyBundle;
    result.bundle.state = 'unverified';
  } else result.bundle.state = bundleFiles.length === 0 ? 'missing' : 'ambiguous';
  const projects = ending('.mcprep.json');
  if (projects.length === 0) return finish('NOT STARTED', [`There is no project file (*.mcprep.json) in ${folder}.`]);
  if (projects.length > 1) return finish('UNREADABLE', [`The work folder holds ${projects.length} project files (${projects.join(', ')}): exactly one is expected.`]);
  const projectName = projects[0] as string;
  result.files.project = projectName;
  const projectPath = join(folder, projectName);

  let session: ProjectSession | undefined;
  try {
    // The importer's check of the bundle needs nothing of the project: it stands even when the project cannot be read or the re-run cannot be made.
    let delivered: ImporterCheck | undefined;
    if (onlyBundle !== undefined && bundleFiles.length === 1) {
      delivered = await importerCheck(join(folder, onlyBundle));
      result.bundle = { state: delivered.accepted ? 'unverified' : 'rejected', sha256: delivered.sha256, accepted: delivered.accepted, differences: [] };
    }
    const queuePdf = await hashFile(book.pdf);
    result.pdf.sha256 = queuePdf.sha256;
    session = await ProjectSession.open(projectPath);
    const project = session.project;
    if (project.pdf.sha256 !== queuePdf.sha256) {
      // The bundle of a project that is for another file is not this book's: it is not offered for copying.
      result.bundle.accepted = false;
      return finish('MISMATCH', [`The project was made on another PDF than the queue's: it records SHA-256 ${short(project.pdf.sha256)}, the PDF ${basename(book.pdf)} of the queue has ${short(queuePdf.sha256)}. The work in this folder is for another file.`]);
    }

    // The files the tools know: the certificate and the notes are named after the project, the bundle after whatever it was exported to.
    const certificateFiles = ending('.audit-gate.json');
    const notesFiles = ending('.audit-notes.json');
    const expectedCertificate = basename(gatePath(projectPath));
    const expectedNotes = basename(notesPath(projectPath));
    // Exactly one of each is expected; the one the tools read is the one named after the project, and only that one is used.
    const ownCertificate = certificateFiles.find((name) => sameName(name, expectedCertificate));
    let certificate: Certificate | undefined;
    let certificateProblem: string | undefined;
    if (certificateFiles.length === 0) certificateProblem = `There is no certificate (${expectedCertificate}): run audit gate --final.`;
    else if (certificateFiles.length > 1) certificateProblem = `The work folder holds ${certificateFiles.length} certificates (${certificateFiles.join(', ')}): exactly one is expected, ${expectedCertificate}.`;
    else if (ownCertificate === undefined) certificateProblem = `The certificate ${certificateFiles.join('')} is not named after the project: the tools read ${expectedCertificate}, so there is none that counts.`;
    if (ownCertificate !== undefined) {
      result.files.certificate = ownCertificate;
      certificate = parseCertificate(await readJson(join(folder, ownCertificate), 'The certificate'), ownCertificate);
    }
    const ownNotes = notesFiles.find((name) => sameName(name, expectedNotes));
    let notesFile: string | null = null;
    let notesProblem: string | undefined;
    if (notesFiles.length > 1) notesProblem = `The work folder holds ${notesFiles.length} notes files (${notesFiles.join(', ')}): exactly one is expected, ${expectedNotes}, the only one the tools read.`;
    else if (notesFiles.length === 1 && ownNotes === undefined) notesProblem = `The notes file ${notesFiles.join('')} is not named after the project: the tools read ${expectedNotes}, so no acknowledgement of it applies.`;
    if (ownNotes !== undefined) {
      notesFile = join(folder, ownNotes);
      result.files.notes = ownNotes;
    }

    // The gate again, in memory.
    const visual = await namedPath(certificate?.visualFile, folder);
    const sheets = await namedPath(certificate?.sheetsFile, folder);
    const survey = await namedPath(certificate?.surveyFile, folder);
    const reference = book.reference !== undefined ? await readReferenceFile(book.reference, book.referenceChapterOffset ?? 0) : undefined;
    const gateOptions = rerunOptions({
      patterns: compilePatterns(certificate?.itemPatterns ?? []),
      ...(reference !== undefined && book.reference !== undefined ? { reference: { file: book.reference, sections: reference } } : {}),
      sheetsSeen: sheets.path,
      visual: visual.path,
      survey: survey.path,
    });
    const { report } = await runGate(session, gateOptions);

    const open = report.open.filter((finding) => finding.source !== 'bundle');
    const summary = summarizeOpen(open);
    const notes = new Set(report.acknowledged.map((entry) => entry.acknowledgement));
    const selfConfirmed = await selfConfirmedNotes(notesFile, report.acknowledged);
    // A note that its own author confirmed is unconfirmed whatever the tools made of its spelling.
    const unconfirmedList = [...notes].filter((note) => !note.confirmed || selfConfirmed.keys.has(noteKey(note.code, note.ref, note.evidence.page)));
    const unconfirmedNotes = [...new Set(unconfirmedList.map((note) => `${note.code} ${note.ref}`))];
    const state = certificate !== undefined ? (await gateStatus(session)).status : 'none';
    const record = report.checks.visual;
    const exhaustive = record?.exhaustive === true;
    // Whether the gate would call the project perfect with every note confirmed: asked only when that decides AWAITING CONFIRMATION (the
    // new run is clean apart from the notes that wait).
    const asked = open.length === 0 && report.counts.exercises > 0 && report.unconfirmed > 0 && selfConfirmed.labels.length === 0;
    const perfectIfConfirmed = asked && notesFile !== null ? await perfectWithNotesConfirmed(session, notesFile, gateOptions).catch(() => false) : undefined;

    let differences: string[] = [];
    if (delivered?.accepted === true) {
      differences = await bundleDifferences(delivered, session);
      result.bundle.state = differences.length === 0 ? 'ok' : 'stale';
      result.bundle.differences = differences;
    }

    const facts: Facts = {
      allowZero: (options.allowZero ?? []).some((name) => sameName(name, book.name)),
      exercises: report.counts.exercises,
      referenceExercises: reference === undefined ? null : reference.reduce((sum, section) => sum + section.count, 0),
      certificate,
      certificateProblem,
      certificateState: state,
      notesProblem,
      open,
      rerunHash: report.project.hash,
      ink: report.ink,
      gatePerfect: report.perfect,
      perfectIfConfirmed,
      visual: record === null ? null : { covered: record.exercises - record.missing, exercises: record.exercises, exhaustive },
      visualProblem:
        record !== null || certificate === undefined
          ? undefined
          : visual.named === null
            ? 'the certificate names no visual record (the gate ran without --visual)'
            : `the visual record that the certificate names (${visual.named}) does not exist`,
      survey: report.checks.survey === null ? null : { pages: report.checks.survey.pages, entries: report.checks.survey.entries, missing: report.checks.survey.missing, uncovered: report.checks.survey.uncovered, unmarked: report.checks.survey.unmarked, exhaustive: report.checks.survey.exhaustive },
      surveyProblem:
        report.checks.survey !== null || certificate === undefined
          ? undefined
          : survey.named === null
            ? 'the certificate names no survey record (the gate ran without --survey)'
            : `the survey record that the certificate names (${survey.named}) does not exist`,
      unconfirmed: unconfirmedList.length,
      unconfirmedNotes,
      selfConfirmed: selfConfirmed.labels,
      bundleState: result.bundle.state,
      bundleReason: delivered === undefined ? (bundleFiles.length > 1 ? `The work folder holds ${bundleFiles.length} bundles (${bundleFiles.join(', ')}): exactly one is expected.` : undefined) : (delivered.rejection ?? undefined),
      bundleDifferences: differences,
    };
    const says = rerunSays(facts);
    result.sections = report.counts.sections;
    result.exercises = report.counts.exercises;
    result.withAnswer = report.counts.solutions;
    result.visual = record === null ? null : { file: record.file, entries: record.entries, exercises: record.exercises, covered: record.exercises - record.missing, mismatches: record.mismatches, defects: record.defects, exhaustive };
    result.survey = report.checks.survey;
    result.acknowledgements = { total: notes.size, unconfirmed: unconfirmedList.length, selfConfirmed: selfConfirmed.labels.length };
    result.open = { total: summary.total, byCode: summary.byCode };
    result.reference = report.checks.reference;
    result.certificate = certificate === undefined ? null : { state, passed: certificate.passed, perfect: certificate.perfect, ink: certificate.ink, createdAt: certificate.createdAt };
    result.rerun = { passed: says.passed, perfect: says.perfect };
    const verdict = judge(facts);
    return finish(verdict.status, verdict.reasons);
  } catch (error) {
    return finish('UNREADABLE', [describeError(error)]);
  } finally {
    await session?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The report of all the books

export interface DeliveryReport {
  format: 'math-canvas-delivery-check';
  version: 1;
  tool: { name: 'math-canvas-prep'; version: string };
  checkedAt: string;
  /** The queue file or folder of PDFs, and the folder of the work folders. */
  queue: string;
  work: string;
  allowZero: string[];
  /** True when every book is PERFECT. */
  perfect: boolean;
  totals: Record<DeliveryStatus, number>;
  books: DeliveryResult[];
}

export interface DeliveryInput {
  checkedAt: Date;
  queue: string;
  work: string;
  allowZero?: readonly string[];
  results: readonly DeliveryResult[];
}

export function deliveryTotals(results: readonly DeliveryResult[]): Record<DeliveryStatus, number> {
  const totals = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0])) as Record<DeliveryStatus, number>;
  for (const result of results) totals[result.status] += 1;
  return totals;
}

/** The report as data (DELIVERY.json). */
export function deliveryReport(input: DeliveryInput): DeliveryReport {
  return {
    format: 'math-canvas-delivery-check',
    version: 1,
    tool: { name: 'math-canvas-prep', version: VERSION },
    checkedAt: input.checkedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    queue: input.queue,
    work: input.work,
    allowZero: [...(input.allowZero ?? [])],
    perfect: input.results.length > 0 && input.results.every((result) => result.status === 'PERFECT'),
    totals: deliveryTotals(input.results),
    books: [...input.results],
  };
}

const cell = (text: string, most = 400): string => {
  const flat = text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return flat.length > most ? `${flat.slice(0, most - 3)}...` : flat;
};
const visualCell = (result: DeliveryResult): string => (result.visual === null ? '-' : `${result.visual.entries}/${result.visual.exercises}`);
const ackCell = (result: DeliveryResult): string => (result.acknowledgements === null ? '-' : `${result.acknowledgements.total}/${result.acknowledgements.unconfirmed}`);
const numberCell = (value: number | null): string => (value === null ? '-' : String(value));
const mainReason = (result: DeliveryResult): string => result.reasons[0] ?? '-';

/** What the re-run found, in one line (for the block of a book that is not PERFECT). */
function factsLine(result: DeliveryResult): string {
  const found =
    result.exercises === null
      ? 'the re-run did not run'
      : `${plural(result.exercises, 'exercise')} (${result.withAnswer ?? 0} with an answer) in ${plural(result.sections ?? 0, 'section')}; reference differences ${result.reference === null ? '-' : result.reference.differences}; survey record ${result.survey === null ? 'none' : `${plural(result.survey.entries, 'range')} for ${plural(result.survey.pages, 'page')}`}; open ${result.open === null || result.open.total === 0 ? 'none' : Object.entries(result.open.byCode).map(([code, n]) => `${code} ${n}`).join(', ')}`;
  return `Found: ${found}. SHA-256 of the PDF ${result.pdf.sha256 === null ? '-' : short(result.pdf.sha256)}, of the bundle ${result.bundle.sha256 === null ? '-' : short(result.bundle.sha256)}. Checked in ${result.seconds} s.`;
}

/** DELIVERY.md: the date and the queue, one line of totals for each status, a row for each book, and what is wrong with each book that is not PERFECT. */
export function deliveryMarkdown(input: DeliveryInput): string {
  const report = deliveryReport(input);
  const lines: string[] = [`# Delivery check ${report.checkedAt.slice(0, 10)}: \`${report.queue}\``, ''];
  lines.push(`Checked ${report.checkedAt.slice(0, 16).replace('T', ' ')} UTC with Math Canvas Prep ${report.tool.version}. Queue: \`${report.queue}\`. Work folders: \`${report.work}\`. ${plural(input.results.length, 'book')}.`, '');
  lines.push("Every verdict comes from the delivered files, opened and checked again by this program: the project, a new run of the gate in memory, the importer's check of the bundle, and the bundle that the project gives now. What the agent wrote about itself (its report, its progress file, its certificate) is not believed.", '');
  for (const status of DELIVERY_STATUSES) lines.push(`- ${status}: ${report.totals[status]}`);
  lines.push('');
  lines.push('| # | book | status | sections | exercises | visual | acknowledged/unconfirmed | bundle | main reason |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  input.results.forEach((result, index) => {
    lines.push(`| ${index + 1} | ${cell(result.name)} | ${result.status} | ${numberCell(result.sections)} | ${numberCell(result.exercises)} | ${visualCell(result)} | ${ackCell(result)} | ${result.bundle.state} | ${cell(mainReason(result), 160)} |`);
  });
  lines.push('');
  for (const result of input.results) {
    if (result.status === 'PERFECT') continue;
    lines.push(`## ${result.name}: ${result.status}`, '');
    for (const reason of result.reasons) lines.push(`- ${reason}`);
    lines.push('', factsLine(result), '');
  }
  lines.push('What this check cannot see: whether anybody looked at the pictures of the visual pass. The visual record is checked against the project and the text layer, entry by entry, but a record can be written without looking. A person samples a few books of every batch: import the bundle and look at the exercises.', '');
  return lines.join('\n');
}

/** The table that the program prints. */
export function deliveryTable(results: readonly DeliveryResult[]): string {
  return table(
    results.map((result, index) => [String(index + 1), result.name, result.status, numberCell(result.sections), numberCell(result.exercises), visualCell(result), ackCell(result), result.bundle.state, cell(mainReason(result), 110)]),
    ['#', 'book', 'status', 'sections', 'exercises', 'visual', 'ack/unconfirmed', 'bundle', 'main reason'],
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Copying the bundles

const SORTED: readonly { folder: string; takes: (status: DeliveryStatus) => boolean }[] = [
  { folder: 'perfect', takes: (status) => status === 'PERFECT' },
  { folder: 'awaiting-confirmation', takes: (status) => status === 'AWAITING CONFIRMATION' },
  { folder: 'draft', takes: () => true },
];

export interface CopyResult {
  name: string;
  /** The folder of the target that the bundle went to. */
  folder: string;
  path: string;
}

/**
 * Copies the bundle of every book that has one that the importer's check accepts into `dir/perfect/` (PERFECT), `dir/awaiting-confirmation/`
 * (AWAITING CONFIRMATION) or `dir/draft/` (every other status), named `<book name>.mcbundle`, and removes a copy of the same book that an earlier
 * run left in another of the three folders. A copy is written to a temporary file and renamed. Nothing is written into a work folder.
 */
export async function copyBundles(results: readonly DeliveryResult[], dir: string): Promise<CopyResult[]> {
  const root = resolve(dir);
  const copied: CopyResult[] = [];
  for (const result of results) {
    if (result.files.bundle === null || !result.bundle.accepted) continue;
    const target = SORTED.find((entry) => entry.takes(result.status)) as (typeof SORTED)[number];
    const path = join(root, target.folder, `${result.name}.mcbundle`);
    await writeStreamAtomic(path, createReadStream(join(result.folder, result.files.bundle)));
    for (const other of SORTED) if (other !== target) await rm(join(root, other.folder, `${result.name}.mcbundle`), { force: true });
    copied.push({ name: result.name, folder: target.folder, path });
  }
  return copied;
}

// ---------------------------------------------------------------------------------------------------------------------
// The program (scripts/check-delivery.mjs)

export const DELIVERY_USAGE = 'usage: node scripts/check-delivery.mjs <queue.json | folder of PDFs> --work <root of the work folders> [--out DIR] [--only NAME[,NAME]] [--allow-zero NAME[,NAME]] [--copy-bundles DIR]';

export interface DeliveryArguments {
  source: string;
  work: string;
  out?: string;
  only?: string[];
  allowZero: string[];
  copyBundles?: string;
}

const OPTIONS = ['work', 'out', 'only', 'allow-zero', 'copy-bundles'];

/** The arguments of the program: what was asked for, or why it cannot be done (a usage error), or that help was asked for. */
export function parseDeliveryArguments(argv: readonly string[]): { args?: DeliveryArguments; problem?: string; help?: boolean } {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!OPTIONS.includes(name)) return { problem: `unknown option ${arg}` };
    const value = argv[(i += 1)];
    if (value === undefined) return { problem: `${arg} needs a value` };
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  const [source] = positional;
  if (source === undefined) return { problem: 'name the queue file or the folder of PDFs' };
  if (positional.length > 1) return { problem: 'name one queue file or one folder of PDFs' };
  const work = options.get('work')?.[0];
  if (work === undefined) return { problem: '--work is needed: the folder that holds one work folder for each book' };
  const only = options.get('only');
  const out = options.get('out')?.[0];
  const copy = options.get('copy-bundles')?.[0];
  return {
    args: {
      source,
      work,
      ...(out !== undefined ? { out } : {}),
      ...(only !== undefined ? { only: only.flatMap(commaList) } : {}),
      allowZero: (options.get('allow-zero') ?? []).flatMap(commaList),
      ...(copy !== undefined ? { copyBundles: copy } : {}),
    },
  };
}

export interface DeliveryIO {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
}

/** Whether `path` is `folder` or lies in it. */
const inside = (path: string, folder: string): boolean => {
  const way = relative(folder, path);
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way));
};

/**
 * The program: reads the queue, checks every selected book, writes DELIVERY.md and DELIVERY.json, prints the table and returns the exit code:
 * 0 only when every selected book is PERFECT, 1 when any is not, 2 for a usage error.
 */
export async function runDeliveryCheck(argv: readonly string[], io: DeliveryIO): Promise<number> {
  const asked = parseDeliveryArguments(argv);
  if (asked.help === true) {
    io.stdout(`${DELIVERY_USAGE}\n`);
    return 0;
  }
  const fail = (message: string): number => {
    io.stderr(`${message}\n${DELIVERY_USAGE}\n`);
    return 2;
  };
  if (asked.args === undefined) return fail(asked.problem ?? 'wrong arguments');
  const args = asked.args;
  const work = resolve(io.cwd, args.work);
  if (!(await stat(work).then((entry) => entry.isDirectory(), () => false))) return fail(`--work ${work} is not a folder.`);
  const source = resolve(io.cwd, args.source);
  if (!(await exists(source))) return fail(`The queue ${source} does not exist.`);
  const queue = await loadQueue(source);
  // A queue file that is no queue (not JSON, no list of books) is no book that failed: the person gave the wrong file.
  const unusable = queue.mode === 'queue' ? queue.problems.find((problem) => problem.name === basename(queue.source)) : undefined;
  if (unusable !== undefined) return fail(unusable.message);
  const everyName = [...queue.books.map((book) => book.name), ...queue.problems.map((problem) => problem.name)];
  const known = new Set(everyName.map((name) => name.toLowerCase()));
  for (const [option, list] of [['--only', args.only ?? []], ['--allow-zero', args.allowZero]] as const) {
    const unknown = list.filter((name) => !known.has(name.toLowerCase()));
    if (unknown.length > 0) return fail(`${option}: no such book: ${unknown.join(', ')}. The books are ${everyName.join(', ') || '(none)'}.`);
  }
  const only = args.only === undefined ? undefined : new Set(args.only.map((name) => name.toLowerCase()));
  const selected = (name: string): boolean => only === undefined || only.has(name.toLowerCase());
  const books = queue.books.filter((book) => selected(book.name));
  const problems = queue.problems.filter((problem) => selected(problem.name));
  const total = books.length + problems.length;
  if (total === 0) return fail(`There is no book to check in ${queue.source}.`);
  const out = resolve(io.cwd, args.out ?? args.work);
  const copy = args.copyBundles === undefined ? undefined : resolve(io.cwd, args.copyBundles);
  // Nothing of this program is written into the work folder of a book.
  for (const [option, path] of [['--out', out], ['--copy-bundles', copy]] as const) {
    if (path === undefined) continue;
    const folder = everyName.map((name) => join(work, name)).find((candidate) => inside(path, candidate));
    if (folder !== undefined) return fail(`${option} ${path} lies in the work folder ${folder}: nothing is written into a work folder.`);
  }

  io.stdout(`${plural(total, 'book')} in ${queue.source}; work folders in ${work}\n`);
  for (const warning of queue.warnings) io.stdout(`note: ${warning}\n`);
  const results: DeliveryResult[] = [];
  for (const book of books) {
    const result = await checkDelivery(book, { work, allowZero: args.allowZero });
    results.push(result);
    io.stdout(`[${results.length}/${total}] ${book.name}: ${result.status} (${result.seconds} s)\n`);
  }
  for (const problem of problems) {
    results.push({ ...blank(problem.name, '', ''), status: 'UNREADABLE', reasons: [problem.message] });
    io.stdout(`[${results.length}/${total}] ${problem.name}: UNREADABLE (the queue cannot use it as it is written)\n`);
  }

  const input: DeliveryInput = { checkedAt: new Date(), queue: queue.source, work, allowZero: args.allowZero, results };
  io.stdout(`\n${deliveryTable(results)}\n\n`);
  const totals = deliveryTotals(results);
  io.stdout(`${DELIVERY_STATUSES.filter((status) => totals[status] > 0).map((status) => `${status} ${totals[status]}`).join(', ')}\n`);
  try {
    await mkdir(out, { recursive: true });
    await writeFileAtomic(join(out, 'DELIVERY.md'), deliveryMarkdown(input));
    await writeFileAtomic(join(out, 'DELIVERY.json'), `${JSON.stringify(deliveryReport(input), null, 1)}\n`);
    io.stdout(`DELIVERY.md and DELIVERY.json are in ${out}\n`);
    if (copy !== undefined) {
      const copied = await copyBundles(results, copy);
      const count = (folder: string): number => copied.filter((entry) => entry.folder === folder).length;
      io.stdout(`Copied ${plural(copied.length, 'bundle')} to ${copy} (perfect ${count('perfect')}, awaiting-confirmation ${count('awaiting-confirmation')}, draft ${count('draft')}).\n`);
    }
  } catch (error) {
    io.stderr(`The report or the copies could not be written: ${describeError(error)}\n`);
    return 1;
  }
  return results.every((result) => result.status === 'PERFECT') ? 0 : 1;
}
