import type { DocumentInfo, Frame, OutlineEntry } from '../model/types.js';
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

/** What the bundle says about the work: the library's title and folder, and the optional document info (author, licence, ...). */
export interface ProjectMeta extends DocumentInfo {
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

/** Highest N among the ids `f<N>` and `u<N>` of frames and units; the counter of generated ids must not go below it. */
export function highestSequence(frames: readonly Frame[]): number {
  let highest = 0;
  for (const frame of frames) {
    for (const id of [frame.id, frame.unit]) {
      const match = id === undefined ? null : /^[fu](\d+)$/.exec(id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest;
}

/** The project with its counter raised above every generated-looking id it already holds (one pass over the frames). */
export function withSequenceBeyondIds(project: Project): Project {
  const highest = highestSequence(project.frames);
  return highest > project.seq ? { ...project, seq: highest } : project;
}

/**
 * A new unused id of the form `f1`, `f2`, ... (or `u1`, ... for units). Ids are never reused: the counter only grows.
 * It stays above every id of that form in the project (loading a project and the operations that take an id of their own
 * see to that), so the next number is unused and no search is needed: adding thousands of frames stays linear.
 */
export function nextId(project: Project, prefix: 'f' | 'u'): { id: string; project: Project } {
  const seq = project.seq + 1;
  return { id: `${prefix}${seq}`, project: { ...project, seq } };
}
