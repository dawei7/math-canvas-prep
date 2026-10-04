import type { DocumentInfo } from '../model/types.js';
import { LIMITS } from './constants.js';
import { issue, type Issue } from './issues.js';

/**
 * What a bundle may say about the work itself (docs/BUNDLE_FORMAT.md, section 2): author, series, description, licence,
 * source address and notice. All optional.
 *
 * A reader is lenient: a text that is too long is cut (a repair) and a value of the wrong kind or a web address that is
 * not http or https is ignored (a warning). A writer is strict: the same problems are errors, so that nothing is written
 * that a reader would silently change.
 */

export interface InfoCheck {
  info: DocumentInfo;
  issues: Issue[];
}

export interface InfoOptions {
  /** True when authoring (the project, the writer): problems are errors. False when reading a bundle. */
  strict: boolean;
  /** How messages name the object: `document` in a bundle, `meta` in a project. */
  where: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TEXTS = [
  ['author', LIMITS.authorMax],
  ['series', LIMITS.seriesMax],
  ['description', LIMITS.descriptionMax],
  ['notice', LIMITS.noticeMax],
] as const;

/** True for an absolute http or https address of at most 500 characters. */
export function isWebAddress(text: string): boolean {
  if (text.length > LIMITS.urlMax) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function checkDocumentInfo(raw: unknown, options: InfoOptions): InfoCheck {
  const issues: Issue[] = [];
  const info: DocumentInfo = {};
  if (!isRecord(raw)) return { info, issues };
  const { strict, where } = options;

  const problem = (code: string, field: string, message: string, fix: string, lenientCode = 'info-ignored'): void => {
    issues.push(issue(strict ? 'error' : 'warning', strict ? code : lenientCode, `${where}.${field}: ${message}`, { fix }));
  };

  const text = (field: string, value: unknown, max: number): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      problem('info-bad-type', field, 'must be a text.', `Write ${field} as a text, or leave it out.`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (Array.from(trimmed).length > max) {
      if (strict) {
        issues.push(issue('error', 'info-too-long', `${where}.${field} has ${Array.from(trimmed).length} characters; at most ${max} are allowed.`, { fix: `Shorten ${field} to ${max} characters.` }));
        return undefined;
      }
      issues.push(issue('repair', 'info-cut', `${where}.${field} has ${Array.from(trimmed).length} characters; it is cut to ${max}.`));
      return Array.from(trimmed).slice(0, max).join('').trim();
    }
    return trimmed;
  };

  for (const [field, max] of TEXTS) {
    const value = text(field, raw[field], max);
    if (value !== undefined) info[field] = value;
  }

  const url = (field: string, value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      problem('info-bad-type', field, 'must be a web address (text).', `Write ${field} as a web address starting with http:// or https://, or leave it out.`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!isWebAddress(trimmed)) {
      problem('info-bad-url', field, `"${trimmed.slice(0, 60)}" is not a web address: it must start with http:// or https:// and have at most ${LIMITS.urlMax} characters.`, `Write ${field} as a full address such as https://example.org/the-book, or leave it out.`);
      return undefined;
    }
    return trimmed;
  };

  const sourceUrl = url('sourceUrl', raw['sourceUrl']);
  if (sourceUrl !== undefined) info.sourceUrl = sourceUrl;

  const license = raw['license'];
  if (license !== undefined && license !== null) {
    if (!isRecord(license)) {
      problem('info-bad-license', 'license', 'must be an object with a name and an optional url.', 'Write "license": { "name": "CC BY 3.0", "url": "https://creativecommons.org/licenses/by/3.0/" }.');
    } else {
      const name = text('license.name', license['name'], LIMITS.licenseNameMax);
      if (name === undefined) {
        if (license['name'] === undefined || license['name'] === null || (typeof license['name'] === 'string' && license['name'].trim() === '')) {
          problem('info-bad-license', 'license', 'needs a name.', 'Write "license": { "name": "CC BY 3.0" } (and a url if there is one), or leave the licence out.');
        }
      } else {
        const entry: { name: string; url?: string } = { name };
        const licenseUrl = url('license.url', license['url']);
        if (licenseUrl !== undefined) entry.url = licenseUrl;
        info.license = entry;
      }
    }
  }
  return { info: pickDocumentInfo(info), issues };
}

/** The document info out of anything that carries it (a project's `meta`, a manifest's `document`). */
export function pickDocumentInfo(source: DocumentInfo): DocumentInfo {
  const info: DocumentInfo = {};
  if (source.author !== undefined) info.author = source.author;
  if (source.series !== undefined) info.series = source.series;
  if (source.description !== undefined) info.description = source.description;
  if (source.license !== undefined) info.license = source.license.url !== undefined ? { name: source.license.name, url: source.license.url } : { name: source.license.name };
  if (source.sourceUrl !== undefined) info.sourceUrl = source.sourceUrl;
  if (source.notice !== undefined) info.notice = source.notice;
  return info;
}

/** The fields of a document info in the order the files write them. */
export function infoForFile(info: DocumentInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (info.author !== undefined) out['author'] = info.author;
  if (info.series !== undefined) out['series'] = info.series;
  if (info.description !== undefined) out['description'] = info.description;
  if (info.license !== undefined) out['license'] = info.license.url !== undefined ? { name: info.license.name, url: info.license.url } : { name: info.license.name };
  if (info.sourceUrl !== undefined) out['sourceUrl'] = info.sourceUrl;
  if (info.notice !== undefined) out['notice'] = info.notice;
  return out;
}
