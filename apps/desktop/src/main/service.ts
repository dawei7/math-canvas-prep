import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  McPrepError,
  ProjectSession,
  deriveOutline,
  proposeFrames,
  readProjectFile,
  withProjectLock,
  writeProjectFile,
  type PageText,
  type Project,
  type ProposalSet,
} from '@mcprep/core';
import type { DerivedHeading, DiskChange, ExportOutcome, OpenOutcome, ProposeRequest, SaveOutcome } from '../shared/api.js';

const PROJECT_SUFFIX = '.mcprep.json';

/** What counts as the content of a project when deciding whether somebody else changed it (as in the editor's store). */
const signature = (project: Project): string => JSON.stringify([project.frames, project.outline ?? null, project.meta]);

function errorOutcome(error: unknown): { ok: false; message: string; code?: string } {
  if (error instanceof McPrepError) return { ok: false, message: error.hint ? `${error.message} ${error.hint}` : error.message, code: error.code };
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

/**
 * Everything the editor needs from the disk and from the PDF, in the main process: opening a PDF or a project, text lines,
 * proposals, atomic saving with conflict detection, export, and watching the project file for changes made by an agent.
 */
export class DocumentService {
  private session: ProjectSession | undefined;
  private watcher: FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  /** The revision and the content this process last wrote or last reported, to recognise its own saves. */
  private knownRevision = -1;
  private knownSignature = '';
  private knownStamp = '';
  onDiskChange: ((change: DiskChange) => void) | undefined;

  get projectPath(): string | undefined {
    return this.session?.projectPath;
  }

  async open(path: string): Promise<OpenOutcome> {
    try {
      let projectPath = path;
      const extension = extname(path).toLowerCase();
      if (extension === '.pdf') {
        const candidate = join(dirname(path), `${basename(path, extname(path))}${PROJECT_SUFFIX}`);
        const exists = await stat(candidate).then(() => true, () => false);
        const opened = exists ? await ProjectSession.open(candidate) : await ProjectSession.create(path, { modifiedBy: 'desktop' });
        await opened.close();
        projectPath = opened.projectPath;
      } else if (!path.toLowerCase().endsWith(PROJECT_SUFFIX) && extension !== '.json') {
        return { ok: false, message: `"${basename(path)}" is neither a PDF nor a project (${PROJECT_SUFFIX}).` };
      }
      const session = await ProjectSession.open(projectPath);
      const pdf = await session.document();
      const pageSizes = await pdf.pageSizes();
      const pdfOutline = await pdf.outline();
      await this.close();
      this.session = session;
      this.knownRevision = session.project.revision;
      this.knownSignature = signature(session.project);
      this.knownStamp = await this.stamp(session.projectPath);
      this.watch(session.projectPath);
      return { ok: true, document: { projectPath: session.projectPath, pdfPath: session.pdfPath, project: session.project, pageSizes, pdfOutline } };
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async close(): Promise<void> {
    this.unwatch();
    await this.session?.close();
    this.session = undefined;
  }

  private current(): ProjectSession {
    if (!this.session) throw new McPrepError('E_NO_PROJECT', 'No project is open.');
    return this.session;
  }

  async readPdf(): Promise<Uint8Array> {
    return readFile(this.current().pdfPath);
  }

  async pageText(page: number): Promise<PageText> {
    return this.current().pageText(page);
  }

  async propose(request: ProposeRequest): Promise<ProposalSet> {
    const pdf = await this.current().document();
    const pages = request.pages ?? Array.from({ length: pdf.pageCount }, (_unused, index) => index);
    const texts: PageText[] = [];
    for (const page of pages) texts.push(await pdf.pageText(page, { fonts: true, ...(request.graphics === false ? {} : { ink: true }) }));
    return proposeFrames(texts, request.minConfidence !== undefined ? { minConfidence: request.minConfidence } : {});
  }

  async deriveOutline(): Promise<DerivedHeading[]> {
    const pdf = await this.current().document();
    return deriveOutline(await pdf.allPageText({ fonts: true })).entries;
  }

  async save(project: Project, expectedRevision: number): Promise<SaveOutcome> {
    const session = this.current();
    try {
      const written = await withProjectLock(session.projectPath, () => writeProjectFile(session.projectPath, project, { modifiedBy: 'desktop', expectedRevision }));
      this.knownRevision = written.revision;
      this.knownSignature = signature(written);
      this.knownStamp = await this.stamp(session.projectPath);
      session.project = written;
      return { ok: true, project: written };
    } catch (error) {
      if (error instanceof McPrepError && error.code === 'E_CONFLICT') {
        return { ok: false, code: 'conflict', message: error.message, onDisk: await readProjectFile(session.projectPath) };
      }
      return { ok: false, code: 'error', message: error instanceof McPrepError ? (error.hint ? `${error.message} ${error.hint}` : error.message) : error instanceof Error ? error.message : String(error) };
    }
  }

  async reload(): Promise<Project> {
    const session = this.current();
    const project = await readProjectFile(session.projectPath);
    session.project = project;
    this.knownRevision = project.revision;
    this.knownSignature = signature(project);
    this.knownStamp = await this.stamp(session.projectPath);
    return project;
  }

  defaultBundlePath(): string {
    const session = this.current();
    return join(dirname(session.projectPath), `${basename(session.pdfPath, extname(session.pdfPath))}.mcbundle`);
  }

  async exportBundle(outPath: string, outline: 'project' | 'pdf' | 'none'): Promise<ExportOutcome> {
    const session = this.current();
    try {
      const done = await session.exportBundle(outPath, { outline });
      return {
        ok: true,
        path: done.write.path,
        bytes: done.write.bytes,
        frames: done.write.counts.frames,
        outlineEntries: done.write.counts.outlineEntries,
        issues: done.write.issues.filter((issue) => issue.severity !== 'error').map((issue) => ({ severity: issue.severity, code: issue.code, message: issue.message, ...(issue.frameId !== undefined ? { frameId: issue.frameId } : {}) })),
      };
    } catch (error) {
      if (error instanceof McPrepError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
          issues: error.issues.map((issue) => ({ severity: issue.severity, code: issue.code, message: issue.message, ...(issue.frameId !== undefined ? { frameId: issue.frameId } : {}), ...(issue.fix !== undefined ? { fix: issue.fix } : {}) })),
        };
      }
      return { ok: false, code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) };
    }
  }

  // -------------------------------------------------------------------------------------------------- watching

  private async stamp(path: string): Promise<string> {
    try {
      const info = await stat(path);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'missing';
    }
  }

  private watch(path: string): void {
    const check = async (): Promise<void> => {
      const stamp = await this.stamp(path);
      if (stamp === this.knownStamp || stamp === 'missing') return;
      let project: Project;
      try {
        project = await readProjectFile(path);
      } catch {
        return; // half-written by someone else or hand-edited with a syntax error: look again at the next change
      }
      this.knownStamp = stamp;
      // A program that follows the rules raises the revision; a hand edit does not, so the content is compared as well.
      if (project.revision === this.knownRevision && signature(project) === this.knownSignature) return;
      this.knownRevision = project.revision;
      this.knownSignature = signature(project);
      this.onDiskChange?.({ project, ...(project.modifiedBy !== undefined ? { modifiedBy: project.modifiedBy } : {}) });
    };
    const schedule = (): void => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void check(), 150);
    };
    try {
      this.watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name === null || name === basename(path)) schedule();
      });
    } catch {
      // Some file systems cannot be watched; the poll below still notices changes.
    }
    this.poll = setInterval(() => void check(), 1500);
    this.poll.unref();
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.poll);
    clearTimeout(this.debounce);
  }
}
