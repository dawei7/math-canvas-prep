import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from '../fs/atomic.js';
import { McPrepError } from '../rules/issues.js';
import { titleFromFileName } from '../rules/document.js';
import { hashFile } from '../bundle/writer.js';
import { PdfDocument } from '../pdf/document.js';
import { isoNow, newProject, type Project } from './model.js';
import { parseProject, serializeProject } from './serialize.js';

export const PROJECT_SUFFIX = '.mcprep.json';

/** Where a JSON syntax error is, as "line 3, column 14", when the message says. */
export function describeJsonError(text: string, error: unknown): string {
  const message = (error as Error).message;
  const position = /position (\d+)/.exec(message);
  if (position) {
    const at = Number(position[1]);
    const before = text.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    return `${message} (line ${line}, column ${column})`;
  }
  return message;
}

export async function readProjectFile(path: string): Promise<Project> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new McPrepError('E_PROJECT_MISSING', code === 'ENOENT' ? `The project file "${path}" does not exist.` : `Cannot read the project file "${path}": ${(error as Error).message}`, {
      hint: 'Create a project with `mcprep init <pdf>`, or pass the right file with --project.',
      cause: error,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new McPrepError('E_PROJECT_JSON', `The project file "${path}" is not valid JSON: ${describeJsonError(text, error)}`, {
      hint: 'If the file was edited by hand, fix the syntax error; otherwise restore it from a copy.',
      cause: error,
    });
  }
  return parseProject(raw, titleFromFileName(basename(path).replace(/\.mcprep\.json$/i, '')));
}

/** The absolute path of the project's PDF. */
export function resolvePdfPath(projectPath: string, project: Project): string {
  return resolve(dirname(projectPath), project.pdf.path);
}

export interface WriteOptions {
  /** Which tool writes; stored in the file so that others can tell. */
  modifiedBy?: string;
  /** Refuse to write when the file on disk has another revision (someone else changed it). */
  expectedRevision?: number;
}

/** Writes the project atomically: the revision goes up by one and `updatedAt` is set. Returns what was written. */
export async function writeProjectFile(path: string, project: Project, options: WriteOptions = {}): Promise<Project> {
  if (options.expectedRevision !== undefined) {
    let onDisk: Project | undefined;
    try {
      onDisk = await readProjectFile(path);
    } catch (error) {
      if (!(error instanceof McPrepError && error.code === 'E_PROJECT_MISSING')) throw error;
    }
    if (onDisk && onDisk.revision !== options.expectedRevision) {
      throw new McPrepError('E_CONFLICT', `The project file changed on disk (revision ${onDisk.revision}, expected ${options.expectedRevision}).`, {
        hint: 'Reload the project and apply your change again.',
        details: { onDisk: onDisk.revision, expected: options.expectedRevision },
      });
    }
  }
  const next: Project = { ...project, revision: project.revision + 1, updatedAt: isoNow() };
  if (options.modifiedBy !== undefined) next.modifiedBy = options.modifiedBy;
  await writeFileAtomic(path, serializeProject(next));
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lock

export function lockPath(projectPath: string): string {
  return projectPath.replace(/\.json$/i, '') + '.lock';
}

const STALE_MS = 30_000;

/**
 * Runs `fn` while holding a lock file next to the project, so that two programs (an agent's command and the desktop
 * app, or two commands) do not both read, change and write the file at the same moment and lose an update.
 */
export async function withProjectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(projectPath);
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new McPrepError('E_LOCK', `Cannot create the lock file "${lock}": ${(error as Error).message}`, { cause: error });
      }
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > STALE_MS) {
          await unlink(lock).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > 8000) {
        throw new McPrepError('E_LOCKED', `The project is being written by another program (lock file "${lock}").`, {
          hint: 'Wait a moment and try again. If no other program is running, delete the lock file.',
        });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

/** Reads the project fresh, lets `mutate` change it, and writes it, all under the lock. */
export async function updateProjectFile(
  path: string,
  mutate: (project: Project) => Project | Promise<Project>,
  options: { modifiedBy?: string } = {},
): Promise<Project> {
  return withProjectLock(path, async () => {
    const current = await readProjectFile(path);
    const changed = await mutate(current);
    return writeProjectFile(path, changed, options);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Creating

export interface CreateOptions {
  /** Where to write the project; default: next to the PDF, `<name>.mcprep.json`. */
  projectPath?: string;
  title?: string;
  folder?: string;
  /** Overwrite an existing project file. */
  force?: boolean;
  modifiedBy?: string;
}

export async function createProjectFile(pdfPath: string, options: CreateOptions = {}): Promise<{ project: Project; path: string; pageCount: number }> {
  const absolutePdf = resolve(pdfPath);
  const projectPath = resolve(options.projectPath ?? join(dirname(absolutePdf), basename(absolutePdf, extname(absolutePdf)) + PROJECT_SUFFIX));
  if (!options.force) {
    const exists = await stat(projectPath).then(() => true, () => false);
    if (exists) {
      throw new McPrepError('E_EXISTS', `The project file "${projectPath}" already exists.`, {
        hint: 'Open it with --project, choose another name with --out, or overwrite it with --force.',
      });
    }
  }
  const hashed = await hashFile(absolutePdf);
  const pdf = await PdfDocument.open(absolutePdf);
  const pageCount = pdf.pageCount;
  await pdf.close();
  const rel = relative(dirname(projectPath), absolutePdf).replace(/\\/g, '/');
  const stored = isAbsolute(rel) ? absolutePdf.replace(/\\/g, '/') : rel;
  const project = newProject({
    pdf: { path: stored, sha256: hashed.sha256, bytes: hashed.size, pageCount },
    title: options.title ?? titleFromFileName(basename(absolutePdf)),
    ...(options.folder !== undefined ? { folder: options.folder.replace(/\\/g, '/') } : {}),
  });
  await mkdir(dirname(projectPath), { recursive: true });
  const written = await writeProjectFile(projectPath, project, { modifiedBy: options.modifiedBy ?? 'cli' });
  return { project: written, path: projectPath, pageCount };
}
