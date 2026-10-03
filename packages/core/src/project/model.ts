import type { Frame, OutlineEntry } from '../model/types.js';
import { FORMAT } from '../rules/constants.js';
import { VERSION } from '../version.js';

export type OutlineSource = 'pdf' | 'derived' | 'manual';

export interface ProjectPdf {
  /** Relative to the project file, with forward slashes. */
  path: string;
  /** Lowercase hex SHA-256 of the PDF. */
  sha256: string;
  bytes: number;
  pageCount: number;
}

export interface ProjectMeta {
  title: string;
  /** Where the document is filed in the app's library: names separated by "/", at most seven levels. */
  folder?: string;
}

export interface ProjectOutline {
  /** Where the entries came from; informational. */
  source: OutlineSource;
  entries: OutlineEntry[];
}

/** The in-memory form of a `*.mcprep.json` file (documented in docs/PROJECT_FILE.md). */
export interface Project {
  format: typeof FORMAT.projectFormat;
  version: typeof FORMAT.projectVersion;
  /** Incremented on every save; lets a program notice that the file changed under it. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Which tool wrote the file last (`cli`, `mcp`, `desktop`); informational. */
  modifiedBy?: string;
  generator: { name: string; version: string };
  pdf: ProjectPdf;
  meta: ProjectMeta;
  frames: Frame[];
  /** Absent: the bundle carries no outline and the app reads the PDF's own. */
  outline?: ProjectOutline;
  /** Counter for generated ids (`f1`, `f2`, ... and `u1`, `u2`, ...). */
  seq: number;
  /** Fields this version does not know, kept so that saving does not lose them. */
  extra: Record<string, unknown>;
}

export function isoNow(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function newProject(input: { pdf: ProjectPdf; title: string; folder?: string; now?: Date }): Project {
  const now = isoNow(input.now);
  const meta: ProjectMeta = { title: input.title };
  if (input.folder !== undefined && input.folder.length > 0) meta.folder = input.folder;
  return {
    format: FORMAT.projectFormat,
    version: FORMAT.projectVersion,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    generator: { name: FORMAT.generatorName, version: VERSION },
    pdf: input.pdf,
    meta,
    frames: [],
    seq: 0,
    extra: {},
  };
}

/**
 * A new unused id of the form `f1`, `f2`, ... (or `u1`, ... for units). Ids are never reused: the counter only grows,
 * and ids that exist in the file (for example added by hand) are skipped.
 */
export function nextId(project: Project, prefix: 'f' | 'u'): { id: string; project: Project } {
  const used = new Set<string>();
  for (const frame of project.frames) {
    used.add(frame.id);
    if (frame.unit !== undefined) used.add(frame.unit);
  }
  let seq = project.seq;
  let id: string;
  do {
    seq += 1;
    id = `${prefix}${seq}`;
  } while (used.has(id));
  return { id, project: { ...project, seq } };
}
