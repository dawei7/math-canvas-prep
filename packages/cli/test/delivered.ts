import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { QueuedBook } from '../src/index.js';
import { run } from '../src/run.js';
import { auditedBook, visualRecord } from './audited.js';
import { tempDir, type Cli, type Result } from './helpers.js';

/**
 * A delivery as the runbook ends it, built from the synthetic workbook: `inbox/<name>.pdf` (the PDF of the queue), `work/<name>/` with the
 * project, the visual record, the certificate and the bundle, and the queue book that names them. The project of the workbook is
 * `book.mcprep.json` and its PDF `book.pdf` inside the work folder.
 */
export interface Delivered {
  /** The folder that holds `inbox/` and `work/`. */
  root: string;
  /** The root of the work folders. */
  work: string;
  /** The work folder of the book. */
  folder: string;
  name: string;
  /** The PDF of the queue. */
  pdf: string;
  book: QueuedBook;
  /** The command line in the work folder. */
  cli: Cli;
}

/** A runner for the command line in `dir`. */
export function cliIn(dir: string): Cli {
  const cli = (async (args, opts = {}) => {
    let out = '';
    let err = '';
    const code = await run(opts.json === false ? args : [...args, '--json'], { stdout: (text) => void (out += text), stderr: (text) => void (err += text), stdin: () => Promise.resolve(opts.stdin ?? ''), cwd: dir, env: { ...opts.env } });
    let json: Result['json'] = { ok: false, command: '', result: {} };
    if (opts.json !== false && out.trim().startsWith('{')) json = JSON.parse(out) as Result['json'];
    return { code, stdout: out, stderr: err, json };
  }) as Cli;
  Object.defineProperty(cli, 'dir', { value: dir });
  return cli;
}

export const queueBook = (name: string, pdf: string, extra: Partial<QueuedBook> = {}): QueuedBook => ({ name, pdf, title: name, folder: 'Books', info: {}, options: {}, ...extra });

/** The audited synthetic workbook laid out as a delivery: the audit is done, nothing is gated or exported yet. */
export async function laidOut(name = 'algebra'): Promise<Delivered> {
  const source = await auditedBook();
  const root = await tempDir('mcprep-delivery-');
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'inbox'));
  const folder = join(root, 'work', name);
  await rename(source.dir, folder);
  const pdf = join(root, 'inbox', `${name}.pdf`);
  await copyFile(join(folder, 'book.pdf'), pdf);
  return { root, work: join(root, 'work'), folder, name, pdf, book: queueBook(name, pdf), cli: cliIn(folder) };
}

/** The visual record of the project as it is now, one file for each half of the book (the folder form of the runbook). */
export async function writeVisualRecord(folder: string, directory = 'visual'): Promise<void> {
  const entries = await visualRecord(folder);
  await mkdir(join(folder, directory), { recursive: true });
  const half = Math.ceil(entries.length / 2);
  await writeFile(join(folder, directory, 'sheet-001.json'), JSON.stringify(entries.slice(0, half)));
  await writeFile(join(folder, directory, 'sheet-002.json'), JSON.stringify(entries.slice(half)));
}

/** What an agent does at the end of the runbook: the visual record, `audit gate --final`, `export`. */
export async function complete(d: Delivered): Promise<void> {
  await writeVisualRecord(d.folder);
  const gate = await d.cli(['audit', 'gate', '--visual', 'visual', '--final']);
  if (gate.code !== 0) throw new Error(`the gate is not perfect: ${gate.stdout}${gate.stderr}`);
  const exported = await d.cli(['export', '--out', 'book.mcbundle']);
  if (exported.code !== 0) throw new Error(`export failed: ${exported.stdout}${exported.stderr}`);
}

const REASON = 'The book prints 70 exercises in 0.1 and the reference lists 68, on the pages of that practice set.';
const QUOTE = 'Evaluate each expression';

/** The reference of the queue for the workbook with 68 exercises in section 0.1, where the book prints 70: the audit differs from it by one count. */
export async function writeReference(d: Delivered): Promise<string> {
  const reference = join(d.root, 'inbox', `${d.name}.reference.json`);
  const sections = [
    { label: '0.1', title: 'Whole Numbers', exercise_count: 68 },
    { label: '0.2', title: 'Word Problems', exercise_count: 14 },
    { label: '1.1', title: 'Points and Lines', exercise_count: 12 },
    { label: '1.2', title: 'Triangles and Ratios', exercise_count: 16 },
  ];
  await writeFile(reference, JSON.stringify({ sections }));
  return reference;
}

/** The note that says the book prints 70 where the reference lists 68 (written by `by`, not confirmed); nothing is gated. */
export async function acknowledge(d: Delivered, reference: string, by = 'writer'): Promise<void> {
  const ack = await d.cli(['audit', 'ack', '--code', 'reference-count', '--ref', '0.1', '--count', '1', '--page', '5', '--quote', QUOTE, '--reason', REASON, '--reference', reference, '--by', by]);
  if (ack.code !== 0) throw new Error(`ack failed: ${ack.stdout}${ack.stderr}`);
}

/**
 * A delivery with one acknowledgement (the reference lists 68 exercises in section 0.1, the book prints 70) that nobody confirmed: the gate
 * passes and says unconfirmed 1. The queue book names the reference.
 */
export async function withAcknowledgement(d: Delivered, by = 'writer'): Promise<Delivered> {
  const reference = await writeReference(d);
  await acknowledge(d, reference, by);
  await writeVisualRecord(d.folder);
  const gate = await d.cli(['audit', 'gate', '--reference', reference, '--visual', 'visual']);
  if (gate.code !== 0) throw new Error(`the gate failed: ${gate.stdout}${gate.stderr}`);
  const exported = await d.cli(['export', '--out', 'book.mcbundle']);
  if (exported.code !== 0) throw new Error(`export failed: ${exported.stdout}${exported.stderr}`);
  return { ...d, book: { ...d.book, reference } };
}

/** The second reviewer confirms every note, then the final gate (the visual record and the reference as before). */
export async function confirmed(d: Delivered, by = 'reviewer'): Promise<void> {
  const done = await d.cli(['audit', 'confirm', '--by', by, '--all']);
  if (done.code !== 0) throw new Error(`confirm failed: ${done.stdout}${done.stderr}`);
  const gate = await d.cli(['audit', 'gate', ...(d.book.reference !== undefined ? ['--reference', d.book.reference] : []), '--visual', 'visual', '--final']);
  if (gate.code !== 0) throw new Error(`the gate is not perfect: ${gate.stdout}${gate.stderr}`);
}

/** A copy of a folder with everything in it (`fs.cp` is experimental in the oldest Node that is supported). */
async function copyFolder(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyFolder(join(from, entry.name), join(to, entry.name));
    else await copyFile(join(from, entry.name), join(to, entry.name));
  }
}

/**
 * A copy of a delivery, in a root of its own or (`into`) next to the books of another delivery, under another name when `name` is given.
 * The certificate names its visual record and its sheets by absolute path, so the copy's certificate is made to name the copies of them (as
 * it would have if the audit had been done there).
 */
export async function copyDelivery(from: Delivered, options: { name?: string; into?: Delivered } = {}): Promise<Delivered> {
  const root = options.into?.root ?? (await tempDir('mcprep-delivery-'));
  const name = options.name ?? from.name;
  await mkdir(join(root, 'work'), { recursive: true });
  await mkdir(join(root, 'inbox'), { recursive: true });
  const folder = join(root, 'work', name);
  await copyFolder(from.folder, folder);
  const pdf = join(root, 'inbox', `${name}.pdf`);
  await copyFile(from.pdf, pdf);
  const certificatePath = join(folder, 'book.audit-gate.json');
  const text = await readFile(certificatePath, 'utf8').catch(() => undefined);
  if (text !== undefined) {
    const certificate = JSON.parse(text) as { checks?: Record<string, { file?: string } | null> };
    for (const key of ['visual', 'sheets']) {
      const check = certificate.checks?.[key];
      if (check && typeof check.file === 'string') check.file = join(folder, relative(from.folder, check.file));
    }
    await writeFile(certificatePath, `${JSON.stringify(certificate, null, 1)}\n`);
  }
  let reference: { reference: string } | undefined;
  if (from.book.reference !== undefined) {
    reference = { reference: join(root, 'inbox', `${name}.reference.json`) };
    await copyFile(from.book.reference, reference.reference);
  }
  return { root, work: join(root, 'work'), folder, name, pdf, book: { ...from.book, name, pdf, ...reference }, cli: cliIn(folder) };
}

/** The project of a delivery, parsed (its frames can be read; to change it use the command line). */
export async function projectOf(d: Delivered): Promise<{ frames: { id: string; section?: string; label?: string; rect: { left: number; top: number; right: number; bottom: number } }[] }> {
  return JSON.parse(await readFile(join(d.folder, 'book.mcprep.json'), 'utf8')) as { frames: { id: string; section?: string; label?: string; rect: { left: number; top: number; right: number; bottom: number } }[] };
}

/**
 * A repair of the kind a late touch is: the right edge of one exercise moves into the white margin by three thousandths of the page. The
 * number of frames stays the same and the gate still passes, but the frames of the project are no longer those of the bundle.
 */
export async function touchOneFrame(d: Delivered, ref = '0.1:5'): Promise<string> {
  const [section, label] = ref.split(':');
  const frame = (await projectOf(d)).frames.find((entry) => entry.section === section && entry.label === label);
  if (frame === undefined) throw new Error(`no frame ${ref}`);
  const { left, top, right, bottom } = frame.rect;
  const done = await d.cli(['frames', 'update', ref, '--rect', `${left},${top},${right + 0.003},${bottom}`]);
  if (done.code !== 0) throw new Error(`frames update failed: ${done.stdout}${done.stderr}`);
  return frame.id;
}

/** The gate as an agent runs it at the end for the delivery: with the visual record, `--final`, and the reference when there is one. */
export const finalGate = (d: Delivered): Promise<Result> => d.cli(['audit', 'gate', ...(d.book.reference !== undefined ? ['--reference', d.book.reference] : []), '--visual', 'visual', '--final']);
