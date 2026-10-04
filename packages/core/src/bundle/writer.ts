import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { writeStreamAtomic } from '../fs/atomic.js';
import { countBook, compareReadingOrder } from '../model/numbering.js';
import { isAuthoritative } from '../model/authority.js';
import { rectsEqual, roundRect } from '../model/rect.js';
import type { BundleFeature, BundleManifest, DocumentInfo, Frame, FramesFile, OutlineEntry, Region } from '../model/types.js';
import { outlineEntryForFile, stringifyJson } from '../project/serialize.js';
import { FORMAT, LIMITS } from '../rules/constants.js';
import { checkBook, lintBook } from '../rules/book.js';
import { cleanFolder, checkTitle, folderFromInput } from '../rules/document.js';
import { checkFrames } from '../rules/frames.js';
import { checkDocumentInfo, infoForFile } from '../rules/info.js';
import { issue, McPrepError, type Issue } from '../rules/issues.js';
import { lintFrames } from '../rules/lint.js';
import { checkOutline } from '../rules/outline.js';
import { groupUnits } from '../rules/units.js';
import { BUNDLE_TARGET, VERSION } from '../version.js';
import { crc32Update, entryFromBytes, entryFromFile, zipChunks, zipToBytes, type ZipEntry } from './zip.js';

export const ENTRY_MANIFEST = 'bundle.json';
export const ENTRY_PDF = 'document.pdf';
export const ENTRY_FRAMES = 'frames.json';
export const ENTRY_OUTLINE = 'outline.json';

export interface BundleInput {
  /** Path of the PDF; it is read, never modified. */
  pdfPath?: string;
  /** Or the PDF itself (small files, tests). */
  pdfBytes?: Uint8Array;
  title: string;
  /** Names separated by "/" (a backslash is accepted too). */
  folder?: string;
  /** What the bundle says about the work: author, series, description, licence, source address, notice. */
  info?: DocumentInfo;
  /** Informational; defaults to the file name of `pdfPath`. */
  fileName?: string;
  pageCount: number;
  frames: readonly Frame[];
  outline?: readonly OutlineEntry[];
  /** The project knows these; when given they must match the PDF, otherwise the PDF changed after the frames were made. */
  expect?: { sha256?: string; bytes?: number };
  createdAt?: Date;
}

export interface PreparedBundle {
  manifest: BundleManifest;
  frames: Frame[];
  outline?: OutlineEntry[];
  /** Repairs and warnings (errors are thrown). */
  issues: Issue[];
  entries: ZipEntry[];
}

export interface BundleWriteResult {
  path: string;
  bytes: number;
  manifest: BundleManifest;
  issues: Issue[];
  counts: { frames: number; outlineEntries: number };
  /** The authoritative exercises written, and how many of them carry a hidden solution. */
  book: { exercises: number; withSolution: number };
}

/**
 * The unit's context moves to its first part, a unit with one frame becomes an ordinary exercise, rects are rounded.
 * Authoritative exercises keep their authority, label and section, and every frame its solution regions.
 */
export function canonicalizeFrames(frames: readonly Frame[]): { frames: Frame[]; notes: Issue[] } {
  const notes: Issue[] = [];
  const copy: Frame[] = frames.map((frame) => {
    const out: Frame = { id: frame.id, kind: frame.kind, page: frame.page, rect: roundRect(frame.rect) };
    if (frame.authority !== undefined) out.authority = frame.authority;
    if (frame.label !== undefined) out.label = frame.label;
    if (frame.section !== undefined) out.section = frame.section;
    if (frame.continues && frame.continues.length > 0) {
      out.continues = frame.continues.map((region) => ({ page: region.page, rect: roundRect(region.rect) }));
    }
    if (frame.unit !== undefined) out.unit = frame.unit;
    if (frame.context && frame.context.length > 0) {
      out.context = frame.context.map((region) => ({ page: region.page, rect: roundRect(region.rect) }));
    }
    if (frame.solution && frame.solution.length > 0) {
      out.solution = frame.solution.map((region) => ({ page: region.page, rect: roundRect(region.rect) }));
    }
    return out;
  });
  const byId = new Map(copy.map((frame) => [frame.id, frame]));
  for (const [unit, members] of groupUnits(copy)) {
    if (members.length === 1) {
      const only = members[0] as Frame;
      delete only.unit;
      notes.push(
        issue('repair', 'unit-dropped', `Unit "${unit}" had one frame (${only.id}); it is written as an ordinary exercise.`, { frameId: only.id, unit }),
      );
      continue;
    }
    const ordered = [...members].sort(compareReadingOrder);
    const first = byId.get((ordered[0] as Frame).id) as Frame;
    const union: Region[] = [];
    for (const member of ordered) {
      for (const region of member.context ?? []) {
        if (!union.some((known) => known.page === region.page && rectsEqual(known.rect, region.rect, 1e-6))) union.push(region);
      }
    }
    for (const member of ordered) {
      const target = byId.get(member.id) as Frame;
      if (target === first) continue;
      if (target.context) {
        delete target.context;
        notes.push(
          issue('repair', 'unit-context-moved', `The context of ${member.id} belongs to the whole unit "${unit}"; it is written on the first part (${first.id}).`, {
            frameId: member.id,
            unit,
          }),
        );
      }
    }
    if (union.length > 0) first.context = union;
    else delete first.context;
  }
  return { frames: copy.sort(compareReadingOrder), notes };
}

export async function hashFile(path: string): Promise<{ size: number; sha256: string; crc32: number }> {
  const hash = createHash('sha256');
  let size = 0;
  let checksum = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
      const bytes = chunk as Uint8Array;
      hash.update(bytes);
      size += bytes.length;
      checksum = crc32Update(checksum, bytes);
    }
  } catch (error) {
    throw new McPrepError('E_PDF_MISSING', `Cannot read the PDF "${path}": ${(error as Error).message}`, { cause: error });
  }
  return { size, sha256: hash.digest('hex'), crc32: checksum };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function jsonEntry(name: string, text: string): ZipEntry {
  const bytes = encode(text);
  if (bytes.length > LIMITS.bundle.maxJsonBytes) {
    throw new McPrepError('E_BUNDLE_LIMIT', `${name} would be ${bytes.length} bytes; the limit is ${LIMITS.bundle.maxJsonBytes}.`);
  }
  // Stored, not deflated: the entries are tiny, and stored bytes are the same on every platform and Node version.
  return entryFromBytes(name, bytes);
}

/**
 * Validates everything, repairs what the format lets a reader repair, and prepares the archive entries. Throws
 * `E_BUNDLE_INVALID` (with the issues) when the importer would reject the result.
 */
export async function prepareBundle(input: BundleInput): Promise<PreparedBundle> {
  const issues: Issue[] = [];
  const blocking: Issue[] = [];

  const title = checkTitle(input.title);
  if (title.problem) blocking.push(issue('error', 'title', title.problem, { fix: 'Set a title of 1 to 200 characters (--title).' }));

  const folder = cleanFolder(input.folder === undefined ? undefined : folderFromInput(input.folder));
  for (const text of folder.repairs) issues.push(issue('repair', 'folder-cleaned', text));

  let pdfSize: number;
  let sha256: string;
  let checksum: number;
  if (input.pdfBytes) {
    pdfSize = input.pdfBytes.length;
    sha256 = createHash('sha256').update(input.pdfBytes).digest('hex');
    checksum = crc32Update(0, input.pdfBytes);
  } else if (input.pdfPath) {
    const hashed = await hashFile(input.pdfPath);
    pdfSize = hashed.size;
    sha256 = hashed.sha256;
    checksum = hashed.crc32;
  } else {
    throw new McPrepError('E_BUNDLE_INVALID', 'A bundle needs a PDF (pdfPath or pdfBytes).');
  }
  if (pdfSize > LIMITS.bundle.maxPdfBytes) {
    blocking.push(issue('error', 'pdf-too-large', `The PDF is ${pdfSize} bytes; a bundle holds at most ${LIMITS.bundle.maxPdfBytes}.`));
  }
  if (input.expect?.sha256 !== undefined && input.expect.sha256 !== sha256) {
    blocking.push(
      issue('error', 'pdf-changed', 'The PDF is not the one the frames were made on (its SHA-256 differs from the project).', {
        fix: 'Restore the original PDF, or make a new project for the changed one: the frames refer to positions on its pages.',
      }),
    );
  }
  if (input.expect?.bytes !== undefined && input.expect.bytes !== pdfSize) {
    blocking.push(issue('error', 'pdf-changed', `The PDF has ${pdfSize} bytes; the project recorded ${input.expect.bytes}.`));
  }

  const checked = checkFrames(input.frames, { pageCount: input.pageCount, strictShapes: true });
  for (const item of checked.issues) (item.severity === 'error' ? blocking : issues).push(item);
  const canonical = canonicalizeFrames(checked.frames);
  issues.push(...canonical.notes);

  let outline: OutlineEntry[] | undefined;
  if (input.outline) {
    const outlineCheck = checkOutline(input.outline, input.pageCount);
    for (const item of outlineCheck.issues) (item.severity === 'error' ? blocking : issues).push(item);
    outline = outlineCheck.entries;
  }
  // The rules that need more than one frame, or the frames and the outline together.
  blocking.push(...checkBook(canonical.frames, outline));
  const documentInfo = checkDocumentInfo(input.info ?? {}, { strict: true, where: 'document' });
  for (const item of documentInfo.issues) (item.severity === 'error' ? blocking : issues).push(item);

  if (blocking.length > 0) {
    throw new McPrepError('E_BUNDLE_INVALID', `The bundle cannot be written: ${blocking.length} problem${blocking.length === 1 ? '' : 's'} (${blocking[0]?.message ?? ''}).`, {
      hint: 'Run `mcprep validate` and fix the errors it lists.',
      issues: blocking,
    });
  }
  issues.push(...lintFrames(canonical.frames), ...lintBook(canonical.frames, outline, input.pageCount));

  const features: BundleFeature[] = [];
  if (outline?.some((entry) => entry.id !== undefined)) features.push('sections');
  if (canonical.frames.some(isAuthoritative)) features.push('authority');
  if (canonical.frames.some((frame) => frame.solution !== undefined && frame.solution.length > 0)) features.push('solution');

  const fileName = input.fileName ?? (input.pdfPath ? basename(input.pdfPath) : 'document.pdf');
  const manifest: BundleManifest = {
    format: FORMAT.bundleFormat,
    version: FORMAT.bundleVersion,
    createdAt: (input.createdAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    generator: { name: FORMAT.generatorName, version: VERSION, targets: BUNDLE_TARGET },
    ...(features.length > 0 ? { features } : {}),
    document: {
      title: title.title as string,
      fileName,
      pdf: ENTRY_PDF,
      sha256,
      bytes: pdfSize,
      pageCount: input.pageCount,
    },
    frames: ENTRY_FRAMES,
  };
  if (folder.folder !== undefined) manifest.document.folder = folder.folder;
  Object.assign(manifest.document, infoForFile(documentInfo.info));
  if (outline) manifest.outline = ENTRY_OUTLINE;

  const framesFile: FramesFile = { version: 1, frames: canonical.frames };
  const entries: ZipEntry[] = [jsonEntry(ENTRY_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)];
  entries.push(
    input.pdfBytes
      ? entryFromBytes(ENTRY_PDF, input.pdfBytes)
      : await entryFromFile(ENTRY_PDF, input.pdfPath as string, { size: pdfSize, crc32: checksum }),
  );
  entries.push(jsonEntry(ENTRY_FRAMES, `${stringifyJson(framesFile)}\n`));
  if (outline) {
    entries.push(jsonEntry(ENTRY_OUTLINE, `${stringifyJson({ version: 1, entries: outline.map(outlineEntryForFile) })}\n`));
  }
  const total = entries.reduce((sum, entry) => sum + entry.storedSize, 0);
  if (total > LIMITS.bundle.maxArchiveBytes) {
    throw new McPrepError('E_BUNDLE_LIMIT', `The archive would be about ${total} bytes; the limit is ${LIMITS.bundle.maxArchiveBytes}.`);
  }
  const prepared: PreparedBundle = { manifest, frames: canonical.frames, issues, entries };
  if (outline) prepared.outline = outline;
  return prepared;
}

/** The bundle as bytes (for small PDFs and tests). */
export async function buildBundleBytes(input: BundleInput): Promise<{ bytes: Uint8Array } & Omit<PreparedBundle, 'entries'>> {
  const { entries, ...rest } = await prepareBundle(input);
  return { bytes: await zipToBytes(entries), ...rest };
}

/** Writes the bundle to `outPath` atomically (a temporary file in the same folder, then a rename). */
export async function writeBundle(outPath: string, input: BundleInput): Promise<BundleWriteResult> {
  const prepared = await prepareBundle(input);
  const bytes = await writeStreamAtomic(outPath, zipChunks(prepared.entries));
  return {
    path: outPath,
    bytes,
    manifest: prepared.manifest,
    issues: prepared.issues,
    counts: { frames: prepared.frames.length, outlineEntries: prepared.outline?.length ?? 0 },
    book: countBook(prepared.frames),
  };
}
