import { compareReadingOrder } from '../model/numbering.js';
import { parseRect, roundNumber, roundRect } from '../model/rect.js';
import { FRAME_KINDS, type Authority, type Frame, type OutlineEntry, type Region } from '../model/types.js';
import { FORMAT } from '../rules/constants.js';
import { infoForFile } from '../rules/info.js';
import { McPrepError } from '../rules/issues.js';
import { VERSION } from '../version.js';
import { highestSequence, type OutlineSource, type Project, type ProjectMeta, type ProjectOutline, type ProjectPdf } from './model.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function bad(path: string, message: string, hint?: string): McPrepError {
  return new McPrepError('E_PROJECT', `Project file: ${path} ${message}`, hint === undefined ? {} : { hint });
}

function readRegions(raw: unknown, path: string): Region[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw bad(path, 'must be a list of {page, rect} regions.');
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw bad(`${path}[${index}]`, 'must be an object with page and rect.');
    const page = entry['page'];
    if (typeof page !== 'number' || !Number.isFinite(page)) throw bad(`${path}[${index}].page`, 'must be a number (zero-based).');
    return { page, rect: readRect(entry['rect'], `${path}[${index}].rect`) };
  });
}

function readRect(raw: unknown, path: string): Region['rect'] {
  try {
    return parseRect(raw);
  } catch (error) {
    if (error instanceof McPrepError) throw bad(path, `cannot be read: ${error.message}`, error.hint);
    throw error;
  }
}

/**
 * Reads one frame without judging it: only what cannot be represented is an error. Whether it is valid (inside the
 * page, large enough, tiling) is what `validate` says, so that a project with a bad frame can still be opened and fixed.
 */
export function coerceFrame(raw: unknown, index: number): Frame {
  const path = `frames[${index}]`;
  if (!isRecord(raw)) throw bad(path, 'must be an object with id, kind, page and rect.');
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) throw bad(`${path}.id`, 'must be a non-empty string.');
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(FRAME_KINDS as readonly string[]).includes(kind)) {
    throw bad(`${path} (${id}).kind`, `must be one of ${FRAME_KINDS.join(', ')}.`);
  }
  const page = raw['page'];
  if (typeof page !== 'number' || !Number.isFinite(page)) throw bad(`${path} (${id}).page`, 'must be a number (zero-based).');
  const frame: Frame = {
    id,
    kind: kind as Frame['kind'],
    page,
    rect: readRect(raw['rect'], `${path} (${id}).rect`),
  };
  const continues = readRegions(raw['continues'], `${path} (${id}).continues`);
  if (continues && continues.length > 0) frame.continues = continues;
  const unit = raw['unit'];
  if (unit !== undefined && unit !== null) {
    if (typeof unit !== 'string') throw bad(`${path} (${id}).unit`, 'must be a string.');
    frame.unit = unit;
  }
  const context = readRegions(raw['context'], `${path} (${id}).context`);
  if (context && context.length > 0) frame.context = context;
  // An authority this version does not know is kept as it is, so that `validate` can name it; the other fields likewise.
  const authority = raw['authority'];
  if (authority !== undefined && authority !== null) {
    if (typeof authority !== 'string') throw bad(`${path} (${id}).authority`, 'must be a string ("book").');
    frame.authority = authority as Authority;
  }
  for (const field of ['label', 'section'] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw bad(`${path} (${id}).${field}`, 'must be a string.');
    frame[field] = value;
  }
  const solution = readRegions(raw['solution'], `${path} (${id}).solution`);
  if (solution && solution.length > 0) frame.solution = solution;
  return frame;
}

function readOptionalText(raw: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad(`${path}.${key}`, 'must be a string.');
  return value.trim().length > 0 ? value : undefined;
}

/** Reads the optional document info of `meta`: author, series, description, license, sourceUrl, notice. */
function readMetaInfo(raw: Record<string, unknown>, meta: ProjectMeta): void {
  for (const key of ['author', 'series', 'description', 'sourceUrl', 'notice'] as const) {
    const value = readOptionalText(raw, key, 'meta');
    if (value !== undefined) meta[key] = value;
  }
  const license = raw['license'];
  if (license === undefined || license === null) return;
  if (!isRecord(license)) throw bad('meta.license', 'must be an object with a name and an optional url.');
  const name = readOptionalText(license, 'name', 'meta.license');
  if (name === undefined) throw bad('meta.license.name', 'must be a non-empty string.');
  const url = readOptionalText(license, 'url', 'meta.license');
  meta.license = url !== undefined ? { name, url } : { name };
}

function readOutline(raw: unknown): ProjectOutline | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw bad('outline', 'must be an object with "entries".');
  const entries = raw['entries'];
  if (!Array.isArray(entries)) throw bad('outline.entries', 'must be a list.');
  const list: OutlineEntry[] = entries.map((entry, index) => {
    if (!isRecord(entry)) throw bad(`outline.entries[${index}]`, 'must be an object with title, page and depth.');
    const { title, page, depth } = entry as Record<string, unknown>;
    if (typeof title !== 'string') throw bad(`outline.entries[${index}].title`, 'must be a string.');
    if (typeof page !== 'number') throw bad(`outline.entries[${index}].page`, 'must be a number (zero-based).');
    if (typeof depth !== 'number') throw bad(`outline.entries[${index}].depth`, 'must be a number.');
    const result: OutlineEntry = { title, page, depth };
    const { id, label, top } = entry as Record<string, unknown>;
    if (id !== undefined && id !== null) {
      if (typeof id !== 'string') throw bad(`outline.entries[${index}].id`, 'must be a string.');
      result.id = id;
    }
    if (label !== undefined && label !== null) {
      if (typeof label !== 'string') throw bad(`outline.entries[${index}].label`, 'must be a string.');
      result.label = label;
    }
    if (top !== undefined && top !== null) {
      if (typeof top !== 'number' || !Number.isFinite(top)) throw bad(`outline.entries[${index}].top`, 'must be a number from 0 to 1.');
      result.top = top;
    }
    return result;
  });
  const source = raw['source'];
  const known: OutlineSource[] = ['pdf', 'derived', 'manual'];
  return { source: known.includes(source as OutlineSource) ? (source as OutlineSource) : 'manual', entries: list };
}

const KNOWN_KEYS = new Set([
  'format',
  'version',
  'revision',
  'createdAt',
  'updatedAt',
  'modifiedBy',
  'generator',
  'pdf',
  'meta',
  'frames',
  'outline',
  'seq',
]);

/**
 * Reads a project from parsed JSON, tolerantly (missing optional fields get defaults, unknown fields are kept) and with
 * clear errors that name the field.
 */
export function parseProject(raw: unknown, fallbackTitle: string): Project {
  if (!isRecord(raw)) throw bad('the file', 'must contain a JSON object.');
  if (raw['format'] !== FORMAT.projectFormat) {
    throw new McPrepError('E_PROJECT', `Project file: this is not a Math Canvas Prep project (format is ${JSON.stringify(raw['format'])}).`, {
      hint: `A project file has "format": "${FORMAT.projectFormat}". Create one with \`mcprep init <pdf>\`.`,
    });
  }
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) throw bad('version', 'must be a whole number.');
  if (version > FORMAT.projectVersion) {
    throw new McPrepError('E_PROJECT_NEWER', `Project file: version ${version} was written by a newer Math Canvas Prep; this one reads version ${FORMAT.projectVersion}.`, {
      hint: 'Update Math Canvas Prep.',
    });
  }
  const pdfRaw = raw['pdf'];
  if (!isRecord(pdfRaw)) throw bad('pdf', 'must be an object with path, sha256, bytes and pageCount.');
  const pdfPath = pdfRaw['path'];
  const sha256 = pdfRaw['sha256'];
  const bytes = pdfRaw['bytes'];
  const pageCount = pdfRaw['pageCount'];
  if (typeof pdfPath !== 'string' || pdfPath.length === 0) throw bad('pdf.path', 'must be a non-empty string (relative to the project file).');
  if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) throw bad('pdf.sha256', 'must be 64 hex characters.');
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) throw bad('pdf.bytes', 'must be a whole number.');
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1) throw bad('pdf.pageCount', 'must be a whole number of at least 1.');
  const pdf: ProjectPdf = { path: pdfPath.replace(/\\/g, '/'), sha256: sha256.toLowerCase(), bytes, pageCount };

  const metaRaw = raw['meta'];
  const meta: ProjectMeta = { title: fallbackTitle };
  if (metaRaw !== undefined) {
    if (!isRecord(metaRaw)) throw bad('meta', 'must be an object with title and optional folder, author, series, description, license, sourceUrl and notice.');
    if (metaRaw['title'] !== undefined) {
      if (typeof metaRaw['title'] !== 'string') throw bad('meta.title', 'must be a string.');
      meta.title = metaRaw['title'];
    }
    if (metaRaw['folder'] !== undefined && metaRaw['folder'] !== null) {
      if (typeof metaRaw['folder'] !== 'string') throw bad('meta.folder', 'must be a string.');
      if (metaRaw['folder'].trim().length > 0) meta.folder = metaRaw['folder'];
    }
    readMetaInfo(metaRaw, meta);
  }

  const framesRaw = raw['frames'] ?? [];
  if (!Array.isArray(framesRaw)) throw bad('frames', 'must be a list.');
  const frames = framesRaw.map((entry, index) => coerceFrame(entry, index));

  const generatorRaw = raw['generator'];
  const generator = isRecord(generatorRaw)
    ? {
        name: typeof generatorRaw['name'] === 'string' ? generatorRaw['name'] : FORMAT.generatorName,
        version: typeof generatorRaw['version'] === 'string' ? generatorRaw['version'] : VERSION,
      }
    : { name: FORMAT.generatorName, version: VERSION };

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_KEYS.has(key)) extra[key] = value;

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const seq = typeof raw['seq'] === 'number' && Number.isInteger(raw['seq']) ? raw['seq'] : 0;
  const project: Project = {
    format: FORMAT.projectFormat,
    version: FORMAT.projectVersion,
    revision: typeof raw['revision'] === 'number' && Number.isInteger(raw['revision']) ? raw['revision'] : 0,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : now,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : now,
    generator,
    pdf,
    meta,
    frames,
    seq: Math.max(seq, highestSequence(frames)),
    extra,
  };
  if (typeof raw['modifiedBy'] === 'string') project.modifiedBy = raw['modifiedBy'];
  const outline = readOutline(raw['outline']);
  if (outline) project.outline = outline;
  return project;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing

/** `{ "a": 1, "b": [ 1, 2 ] }` on one line. */
function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[ ${value.map(inlineJson).join(', ')} ]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${inlineJson(entry)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Pretty JSON where small objects (a rect, a region, an outline entry) stay on one line, so that the file is short to
 * read and a diff shows one frame per few lines. Deterministic: keys keep their insertion order.
 */
export function stringifyJson(value: unknown, width = 100, level = 0): string {
  const indent = '  '.repeat(level);
  const inner = '  '.repeat(level + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const flat = inlineJson(value);
    if (flat.length + indent.length <= width && !value.some((item) => isRecord(item) && Object.values(item).some((v) => isRecord(v) || Array.isArray(v)))) {
      return flat;
    }
    return `[\n${value.map((item) => inner + stringifyJson(item, width, level + 1)).join(',\n')}\n${indent}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return '{}';
    const flat = inlineJson(value);
    const nested = entries.some(([, entry]) => isRecord(entry) || (Array.isArray(entry) && entry.some((item) => isRecord(item))));
    if (flat.length + indent.length <= width && !nested) return flat;
    return `{\n${entries.map(([key, entry]) => `${inner}${JSON.stringify(key)}: ${stringifyJson(entry, width, level + 1)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function frameForFile(frame: Frame): Record<string, unknown> {
  const out: Record<string, unknown> = { id: frame.id, kind: frame.kind, page: frame.page, rect: roundRect(frame.rect) };
  if (frame.authority !== undefined) out['authority'] = frame.authority;
  if (frame.label !== undefined) out['label'] = frame.label;
  if (frame.section !== undefined) out['section'] = frame.section;
  if (frame.unit !== undefined) out['unit'] = frame.unit;
  if (frame.continues && frame.continues.length > 0) {
    out['continues'] = frame.continues.map((region) => ({ page: region.page, rect: roundRect(region.rect) }));
  }
  if (frame.context && frame.context.length > 0) {
    out['context'] = frame.context.map((region) => ({ page: region.page, rect: roundRect(region.rect) }));
  }
  if (frame.solution && frame.solution.length > 0) {
    out['solution'] = frame.solution.map((region) => ({ page: region.page, rect: roundRect(region.rect) }));
  }
  return out;
}

/** An outline entry as the files write it: title, page, depth, then id, label and top when there are any. */
export function outlineEntryForFile(entry: OutlineEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { title: entry.title, page: entry.page, depth: entry.depth };
  if (entry.id !== undefined) out['id'] = entry.id;
  if (entry.label !== undefined) out['label'] = entry.label;
  if (entry.top !== undefined) out['top'] = roundNumber(entry.top);
  return out;
}

/** `meta` as the project file writes it: title and folder, then the document info in a fixed order. */
function metaForFile(meta: ProjectMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { title: meta.title };
  if (meta.folder !== undefined) out['folder'] = meta.folder;
  return { ...out, ...infoForFile(meta) };
}

/** The text of the project file: stable key order, frames in reading order, rects rounded to 5 decimals. */
export function serializeProject(project: Project): string {
  const ordered = [...project.frames].sort(compareReadingOrder);
  const document: Record<string, unknown> = {
    format: project.format,
    version: project.version,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  if (project.modifiedBy !== undefined) document['modifiedBy'] = project.modifiedBy;
  document['generator'] = project.generator;
  document['pdf'] = project.pdf;
  document['meta'] = metaForFile(project.meta);
  document['seq'] = project.seq;
  document['frames'] = ordered.map(frameForFile);
  if (project.outline) {
    document['outline'] = { source: project.outline.source, entries: project.outline.entries.map(outlineEntryForFile) };
  }
  for (const [key, value] of Object.entries(project.extra)) document[key] = value;
  return `${stringifyJson(document)}\n`;
}
