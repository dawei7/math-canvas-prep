import { createHash } from 'node:crypto';
import { numberFrames, type FrameNumber } from '../model/numbering.js';
import type { BundleManifest, Frame, OutlineEntry } from '../model/types.js';
import { PdfDocument } from '../pdf/document.js';
import { FORMAT, LIMITS } from '../rules/constants.js';
import { checkTitle, cleanFolder } from '../rules/document.js';
import { parseFrames } from '../rules/frames.js';
import { issue, McPrepError, type Issue } from '../rules/issues.js';
import { checkOutline } from '../rules/outline.js';
import { ENTRY_FRAMES, ENTRY_MANIFEST, ENTRY_OUTLINE, ENTRY_PDF } from './writer.js';
import { ZipArchive, ZipError, bytesSource, fileSource, type ZipEntryInfo } from './zip.js';

export interface BundleEntryInfo {
  name: string;
  bytes: number;
  storedBytes: number;
  method: 'stored' | 'deflate';
  /** What the importer does with it. */
  role: 'manifest' | 'pdf' | 'frames' | 'outline' | 'ignored';
}

export interface ImportStep {
  step: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  status: 'ok' | 'failed' | 'skipped' | 'trusted';
  detail: string;
}

export interface BundleReport {
  /** True when the importer accepts the bundle (repairs and warnings do not matter). */
  ok: boolean;
  /** The first reason the importer rejects the bundle: the importer stops there. */
  rejection?: Issue;
  errors: Issue[];
  repairs: Issue[];
  warnings: Issue[];
  steps: ImportStep[];
  archive?: { bytes: number; entries: BundleEntryInfo[] };
  manifest?: BundleManifest;
  /** What the library would show for the document. */
  document?: { title: string; folder?: string; fileName: string; pageCount: number; bytes: number; sha256: string };
  frames?: Frame[];
  numbers?: FrameNumber[];
  outline?: OutlineEntry[];
}

export interface CheckBundleOptions {
  /** Open the PDF and compare its page count (step 4). Default true. */
  openPdf?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/**
 * Does what the Android importer does (docs/BUNDLE_FORMAT.md, section 5) and reports each step, every repair and every
 * reason for rejection. `source` is a file path or the bytes of the archive.
 */
export async function checkBundle(source: string | Uint8Array, options: CheckBundleOptions = {}): Promise<BundleReport> {
  const errors: Issue[] = [];
  const repairs: Issue[] = [];
  const warnings: Issue[] = [];
  const steps: ImportStep[] = [];
  const report = (): BundleReport => {
    const result: BundleReport = { ok: errors.length === 0, errors, repairs, warnings, steps };
    if (errors[0]) result.rejection = errors[0];
    return result;
  };
  const fail = (code: string, message: string, fix?: string): void => {
    errors.push(issue('error', code, message, fix === undefined ? {} : { fix }));
  };
  const addIssues = (items: Issue[]): void => {
    for (const item of items) (item.severity === 'error' ? errors : item.severity === 'repair' ? repairs : warnings).push(item);
  };

  // Step 1: the archive and its limits.
  let archive: ZipArchive;
  try {
    const byteSource = typeof source === 'string' ? await fileSource(source) : bytesSource(source);
    archive = await ZipArchive.open(byteSource, { maxEntries: LIMITS.bundle.maxEntries, maxArchiveBytes: LIMITS.bundle.maxArchiveBytes });
  } catch (error) {
    if (error instanceof ZipError) {
      fail(error.code, error.message, 'Export the bundle again with `mcprep export`.');
      steps.push({ step: 1, name: 'archive', status: 'failed', detail: error.message });
      return report();
    }
    throw error;
  }
  const result = report;
  try {
    const roles: Record<string, BundleEntryInfo['role']> = {
      [ENTRY_MANIFEST]: 'manifest',
      [ENTRY_PDF]: 'pdf',
      [ENTRY_FRAMES]: 'frames',
      [ENTRY_OUTLINE]: 'outline',
    };
    const infos: BundleEntryInfo[] = archive.entries.map((entry) => ({
      name: entry.name,
      bytes: entry.size,
      storedBytes: entry.storedSize,
      method: entry.method === 0 ? 'stored' : 'deflate',
      role: roles[entry.name] ?? 'ignored',
    }));
    for (const entry of infos) {
      if (entry.role === 'ignored') {
        warnings.push(
          issue('warning', 'entry-ignored', `The entry "${entry.name}" is not one of the four fixed names; the importer ignores it and never extracts it.`, {
            fix: 'Entry names are case-sensitive and fixed: bundle.json, document.pdf, frames.json, outline.json.',
          }),
        );
      }
    }
    const archiveInfo = { bytes: typeof source === 'string' ? archive.entries.reduce((sum, entry) => sum + entry.storedSize, 0) : source.length, entries: infos };
    const find = (name: string): ZipEntryInfo | undefined => {
      const matches = archive.find(name);
      if (matches.length > 1) {
        fail('zip-duplicate-entry', `The archive has ${matches.length} entries named "${name}"; the importer cannot know which one is meant.`);
        return undefined;
      }
      return matches[0];
    };
    const manifestEntry = find(ENTRY_MANIFEST);
    const pdfEntry = find(ENTRY_PDF);
    const framesEntry = find(ENTRY_FRAMES);
    const outlineEntry = find(ENTRY_OUTLINE);
    const missing = [
      [ENTRY_MANIFEST, manifestEntry],
      [ENTRY_PDF, pdfEntry],
      [ENTRY_FRAMES, framesEntry],
    ].filter(([, entry]) => entry === undefined);
    for (const [name] of missing) {
      if (!errors.some((item) => item.code === 'zip-duplicate-entry' && item.message.includes(`"${name as string}"`))) {
        fail('entry-missing', `The archive has no entry named "${name as string}".`, 'Names are case-sensitive and fixed; a bundle needs bundle.json, document.pdf and frames.json.');
      }
    }
    if (errors.length > 0) {
      steps.push({ step: 1, name: 'archive', status: 'failed', detail: errors[0]?.message ?? '' });
      return { ...result(), archive: archiveInfo };
    }
    steps.push({ step: 1, name: 'archive', status: 'ok', detail: `${infos.length} entries, ${archiveInfo.bytes} bytes; the four fixed names found.` });

    const out: BundleReport = { ...result(), archive: archiveInfo };

    // Step 2: the manifest.
    let manifestRaw: Record<string, unknown> | undefined;
    try {
      const text = decode(await archive.read(manifestEntry as ZipEntryInfo, LIMITS.bundle.maxJsonBytes));
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new SyntaxError('bundle.json is not a JSON object');
      manifestRaw = parsed;
    } catch (error) {
      fail('manifest-json', `bundle.json cannot be read: ${(error as Error).message}`, 'Export the bundle again.');
    }
    let title: string | undefined;
    let sha256 = '';
    let bytesDeclared = -1;
    let pageCount = 0;
    let fileName = '';
    let folder: string | undefined;
    if (manifestRaw) {
      if (manifestRaw['format'] !== FORMAT.bundleFormat) {
        fail('manifest-format', `bundle.json has "format": ${JSON.stringify(manifestRaw['format'])}; it must be "${FORMAT.bundleFormat}".`);
      }
      const version = manifestRaw['version'];
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        fail('manifest-version', `bundle.json has "version": ${JSON.stringify(version)}; it must be a whole number, 1 or more.`);
      } else if (version > FORMAT.bundleVersion) {
        fail('bundle-newer', `This bundle needs a newer app: its version is ${version} and this reader knows version ${FORMAT.bundleVersion}.`, 'Update the app, or export the bundle with an older version of the tools.');
      }
      const document = manifestRaw['document'];
      if (!isRecord(document)) {
        fail('manifest-document', 'bundle.json has no "document" object.');
      } else {
        const rawTitle = document['title'];
        const checkedTitle = typeof rawTitle === 'string' ? checkTitle(rawTitle) : { problem: 'The document title is missing.' };
        if (checkedTitle.problem) fail('manifest-title', `document.title: ${checkedTitle.problem}`, 'A title is 1 to 200 characters after trimming.');
        else title = checkedTitle.title;
        const rawSha = document['sha256'];
        if (typeof rawSha !== 'string' || !/^[0-9a-fA-F]{64}$/.test(rawSha)) {
          fail('manifest-sha256', 'document.sha256 must be 64 hex characters.');
        } else {
          sha256 = rawSha.toLowerCase();
          if (rawSha !== sha256) warnings.push(issue('warning', 'sha256-case', 'document.sha256 should be written in lowercase.'));
        }
        const rawBytes = document['bytes'];
        if (typeof rawBytes !== 'number' || !Number.isInteger(rawBytes) || rawBytes < 0) fail('manifest-bytes', 'document.bytes must be a whole number.');
        else bytesDeclared = rawBytes;
        const rawPages = document['pageCount'];
        if (typeof rawPages !== 'number' || !Number.isInteger(rawPages) || rawPages < 1) fail('manifest-page-count', 'document.pageCount must be a whole number of at least 1.');
        else pageCount = rawPages;
        fileName = typeof document['fileName'] === 'string' ? document['fileName'] : '';
        if (document['fileName'] !== undefined && typeof document['fileName'] !== 'string') {
          warnings.push(issue('warning', 'manifest-filename', 'document.fileName should be a string; it is only informational.'));
        }
        if (typeof document['folder'] === 'string') {
          const cleaned = cleanFolder(document['folder']);
          folder = cleaned.folder;
          for (const text of cleaned.repairs) repairs.push(issue('repair', 'folder-cleaned', text));
        } else if (document['folder'] !== undefined) {
          warnings.push(issue('warning', 'manifest-folder', 'document.folder should be a string; it is ignored.'));
        }
        if (document['pdf'] !== undefined && document['pdf'] !== ENTRY_PDF) {
          warnings.push(issue('warning', 'manifest-pdf-name', `document.pdf is ${JSON.stringify(document['pdf'])}; the importer always reads the entry "${ENTRY_PDF}".`));
        }
      }
      if (manifestRaw['frames'] !== undefined && manifestRaw['frames'] !== ENTRY_FRAMES) {
        warnings.push(issue('warning', 'manifest-frames-name', `"frames" is ${JSON.stringify(manifestRaw['frames'])}; the importer always reads the entry "${ENTRY_FRAMES}".`));
      }
      if (manifestRaw['outline'] !== undefined && !outlineEntry) {
        warnings.push(issue('warning', 'manifest-outline-missing', 'bundle.json names an outline but the archive has no outline.json; no contents are imported.'));
      }
      if (manifestRaw['outline'] === undefined && outlineEntry) {
        warnings.push(issue('warning', 'manifest-outline-unlisted', 'The archive has outline.json but bundle.json does not list it; it is used anyway.'));
      }
    }
    const step2Failed = errors.length > 0;
    steps.push({
      step: 2,
      name: 'manifest',
      status: step2Failed ? 'failed' : 'ok',
      detail: step2Failed ? (errors[0]?.message ?? '') : `format ${FORMAT.bundleFormat}, version 1, "${title ?? ''}".`,
    });
    if (manifestRaw) out.manifest = manifestRaw as unknown as BundleManifest;

    // Step 3: the PDF, streamed once for its hash.
    let pdfBytes: Uint8Array | undefined;
    const before = errors.length;
    try {
      const hash = createHash('sha256');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of archive.stream(pdfEntry as ZipEntryInfo, LIMITS.bundle.maxPdfBytes)) {
        hash.update(chunk);
        total += chunk.length;
        if (options.openPdf !== false) chunks.push(chunk);
      }
      const actual = hash.digest('hex');
      if (sha256 !== '' && actual !== sha256) {
        fail('pdf-hash-mismatch', 'document.pdf does not match the SHA-256 in bundle.json: the bundle is damaged or has been tampered with.', 'Export the bundle again from the original PDF.');
      }
      if (bytesDeclared >= 0 && total !== bytesDeclared) {
        fail('pdf-size-mismatch', `document.pdf is ${total} bytes but bundle.json says ${bytesDeclared}.`);
      }
      if (options.openPdf !== false) {
        pdfBytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          pdfBytes.set(chunk, at);
          at += chunk.length;
        }
      }
    } catch (error) {
      if (error instanceof ZipError) fail(error.code, error.message);
      else throw error;
    }
    steps.push({
      step: 3,
      name: 'pdf hash',
      status: errors.length > before ? 'failed' : 'ok',
      detail: errors.length > before ? (errors[before]?.message ?? '') : 'The SHA-256 and the size of document.pdf match the manifest.',
    });

    // Step 4: the PDF opens and has the declared number of pages.
    let framePages = pageCount;
    if (options.openPdf === false || !pdfBytes) {
      steps.push({ step: 4, name: 'pdf pages', status: 'skipped', detail: options.openPdf === false ? 'Not checked (--no-open-pdf).' : 'Skipped because the PDF could not be read.' });
    } else {
      try {
        const pdf = await PdfDocument.fromBytes(pdfBytes);
        try {
          if (pageCount > 0 && pdf.pageCount !== pageCount) {
            fail('pdf-page-count-mismatch', `document.pdf has ${pdf.pageCount} pages but bundle.json says ${pageCount}.`);
            steps.push({ step: 4, name: 'pdf pages', status: 'failed', detail: errors[errors.length - 1]?.message ?? '' });
          } else {
            steps.push({ step: 4, name: 'pdf pages', status: 'ok', detail: `The PDF opens and has ${pdf.pageCount} pages.` });
          }
          framePages = pdf.pageCount;
        } finally {
          await pdf.close();
        }
      } catch (error) {
        if (error instanceof McPrepError && error.code === 'E_PDF_PASSWORD') {
          steps.push({ step: 4, name: 'pdf pages', status: 'trusted', detail: 'The PDF is password protected and cannot be opened here; pageCount is trusted.' });
          warnings.push(issue('warning', 'pdf-password', 'The PDF is password protected; the app may not be able to open it.'));
        } else if (error instanceof McPrepError) {
          fail('pdf-unreadable', error.message, 'Check the PDF with another viewer; a bundle must carry a PDF the app can open.');
          steps.push({ step: 4, name: 'pdf pages', status: 'failed', detail: error.message });
        } else throw error;
      }
    }

    // Step 5: frames.json and outline.json.
    const stepFive = errors.length;
    let frames: Frame[] = [];
    try {
      const raw: unknown = JSON.parse(decode(await archive.read(framesEntry as ZipEntryInfo, LIMITS.bundle.maxJsonBytes)));
      if (!isRecord(raw)) {
        fail('frames-json', 'frames.json must be a JSON object with "version" and "frames".');
      } else {
        const version = raw['version'];
        if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
          fail('frames-version', `frames.json has "version": ${JSON.stringify(version)}; it must be 1.`);
        } else if (version > 1) {
          fail('bundle-newer', `This bundle needs a newer app: frames.json is version ${version}.`);
        }
        const checked = parseFrames(raw['frames'], { pageCount: framePages > 0 ? framePages : Number.MAX_SAFE_INTEGER, strictShapes: true });
        addIssues(checked.issues);
        frames = checked.frames;
      }
    } catch (error) {
      if (error instanceof ZipError) fail(error.code, error.message);
      else if (error instanceof SyntaxError) fail('frames-json', `frames.json is not valid JSON: ${error.message}`);
      else throw error;
    }
    let outline: OutlineEntry[] | undefined;
    if (outlineEntry) {
      try {
        const raw: unknown = JSON.parse(decode(await archive.read(outlineEntry, LIMITS.bundle.maxJsonBytes)));
        if (!isRecord(raw)) {
          fail('outline-json', 'outline.json must be a JSON object with "version" and "entries".');
        } else {
          const version = raw['version'];
          if (typeof version === 'number' && version > 1) fail('bundle-newer', `This bundle needs a newer app: outline.json is version ${version}.`);
          const checked = checkOutline(raw['entries'], framePages > 0 ? framePages : Number.MAX_SAFE_INTEGER);
          addIssues(checked.issues);
          outline = checked.entries;
        }
      } catch (error) {
        if (error instanceof ZipError) fail(error.code, error.message);
        else if (error instanceof SyntaxError) fail('outline-json', `outline.json is not valid JSON: ${error.message}`);
        else throw error;
      }
    }
    const frameErrors = errors.length - stepFive;
    steps.push({
      step: 5,
      name: 'frames',
      status: frameErrors > 0 ? 'failed' : 'ok',
      detail:
        frameErrors > 0
          ? (errors[stepFive]?.message ?? '')
          : `${frames.length} frame${frames.length === 1 ? '' : 's'} valid${outline ? `, ${outline.length} outline entries` : ''}${repairs.length > 0 ? `, ${repairs.length} repair${repairs.length === 1 ? '' : 's'} applied` : ''}.`,
    });

    // Step 6: what would be created in the library.
    if (errors.length === 0 && title !== undefined) {
      const numbers = numberFrames(frames);
      const exercises = new Set<string>();
      let questions = 0;
      let bookmarks = 0;
      for (const number of numbers.values()) {
        if (number.kind === 'exercise') exercises.add(String(number.number));
        else if (number.kind === 'question') questions += 1;
        else bookmarks += 1;
      }
      out.document = { title, fileName, pageCount: framePages || pageCount, bytes: bytesDeclared, sha256 };
      if (folder !== undefined) out.document.folder = folder;
      out.frames = frames;
      out.numbers = [...numbers.values()];
      if (outline) out.outline = outline;
      steps.push({
        step: 6,
        name: 'library',
        status: 'ok',
        detail: `Would add "${title}"${folder ? ` in the folder "${folder}"` : ''} with ${exercises.size} exercises, ${questions} questions and ${bookmarks} bookmarks${outline ? ` and ${outline.length} contents entries` : ''}. A PDF with the same SHA-256 already in the library is not duplicated: the app offers to add the frames to it.`,
      });
    } else {
      steps.push({ step: 6, name: 'library', status: 'skipped', detail: 'Nothing would be imported.' });
    }
    return { ...out, ...result(), steps };
  } finally {
    await archive.close();
  }
}
