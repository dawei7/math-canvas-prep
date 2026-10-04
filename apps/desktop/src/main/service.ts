import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  McPrepError,
  ProjectSession,
  buildBookSummary,
  proposeFrames,
  readProjectFile,
  withProjectLock,
  writeFileAtomic,
  writeProjectFile,
  type BookStructure,
  type PageText,
  type PdfDocument,
  type Project,
  type ProposalSet,
} from '@mcprep/core';
import type { AuditOutcome, AuditProgress, BookRequest, BookResult, BookSummaryOutcome, DiskChange, ExportOutcome, OpenOutcome, ProposeRequest, SaveOutcome } from '../shared/api.js';
import { AuditCancelled, AuditProblem, runDerive, runExercises, runSolutions, type AuditHooks } from './audit.js';

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
  /** The long job that is running (reading a whole book), if any: only one at a time. */
  private job: { cancelled: boolean } | undefined;
  onDiskChange: ((change: DiskChange) => void) | undefined;
  onProgress: ((progress: AuditProgress) => void) | undefined;

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
    this.cancelAudit();
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

  /** The chapters and sections of the book, from its printed contents and headings. Reports its progress; can be stopped. */
  deriveSections(): Promise<AuditOutcome<BookStructure>> {
    return this.runAudit((pdf, hooks) => runDerive(pdf, hooks));
  }

  /** The numbered exercises of the practice sets, or the answers of the answer key, for the sections and exercises the window has. Nothing is written. */
  proposeBook(request: BookRequest): Promise<AuditOutcome<BookResult>> {
    return this.runAudit((pdf, hooks) => (request.kind === 'exercises' ? runExercises(pdf, request, hooks) : runSolutions(pdf, request, hooks)));
  }

  /** Stops the long job that is running, at the next page or step. */
  cancelAudit(): void {
    if (this.job) this.job.cancelled = true;
  }

  /**
   * Runs a long job on the open document with the hooks that report its progress (at most about ten times a second) and stop
   * it. One job at a time; opening another document stops it.
   */
  private async runAudit<T>(work: (pdf: PdfDocument, hooks: AuditHooks) => Promise<T>): Promise<AuditOutcome<T>> {
    if (this.job) return { ok: false, cancelled: false, message: 'Another search is still running: wait for it, or stop it first.' };
    const job = { cancelled: false };
    this.job = job;
    let last = 0;
    const hooks: AuditHooks = {
      report: (phase, done, total) => {
        const now = Date.now();
        if (done !== 0 && done !== total && now - last < 90) return;
        last = now;
        this.onProgress?.({ phase, done, total });
      },
      check: () => {
        if (job.cancelled) throw new AuditCancelled();
      },
    };
    try {
      const pdf = await this.current().document();
      const result = await work(pdf, hooks);
      hooks.check();
      return { ok: true, result };
    } catch (error) {
      if (error instanceof AuditCancelled || job.cancelled) return { ok: false, cancelled: true, message: 'Stopped.' };
      if (error instanceof AuditProblem) return { ok: false, cancelled: false, message: error.message };
      const failed = errorOutcome(error);
      return { ok: false, cancelled: false, message: failed.message };
    } finally {
      if (this.job === job) this.job = undefined;
    }
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
        check: {
          wouldImport: done.check?.ok ?? true,
          features: done.check?.features ?? done.write.manifest.features ?? [],
          frames: done.check?.frames?.length ?? done.write.counts.frames,
          outlineEntries: done.check?.outline?.length ?? done.write.counts.outlineEntries,
          warnings: done.check?.warnings.length ?? 0,
          repairs: done.check?.repairs.length ?? 0,
          steps: (done.check?.steps ?? []).map((step) => ({ step: step.step, name: step.name, status: step.status, detail: step.detail })),
        },
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

  defaultSummaryPath(): string {
    const session = this.current();
    return join(dirname(session.projectPath), `${basename(session.pdfPath, extname(session.pdfPath))}.book.json`);
  }

  /**
   * Writes the plain JSON summary of the book: what it is, its sections with the number of book exercises (and solutions)
   * in each, and the exercises of each section. The same facts, from the same code, as `mcprep book export --exercises`.
   */
  async exportBookSummary(outPath: string): Promise<BookSummaryOutcome> {
    try {
      const session = this.current();
      await session.refresh();
      const project = session.project;
      const summary = buildBookSummary({
        title: project.meta.title,
        folder: project.meta.folder,
        info: project.meta,
        pageCount: project.pdf.pageCount,
        sha256: project.pdf.sha256,
        bytes: project.pdf.bytes,
        frames: project.frames,
        outline: project.outline?.entries,
        exercises: true,
      });
      const text = `${JSON.stringify(summary, null, 2)}\n`;
      await writeFileAtomic(outPath, text);
      return { ok: true, path: outPath, bytes: Buffer.byteLength(text), sections: summary.totals.sections, exercises: summary.totals.exercises };
    } catch (error) {
      return { ok: false, message: error instanceof McPrepError ? (error.hint ? `${error.message} ${error.hint}` : error.message) : error instanceof Error ? error.message : String(error) };
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
