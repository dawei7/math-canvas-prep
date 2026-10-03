import { stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { checkBundle, type BundleReport } from './bundle/reader.js';
import { writeBundle, type BundleWriteResult } from './bundle/writer.js';
import type { Frame, OutlineEntry, PageText, TextLine } from './model/types.js';
import { PdfDocument, type TextOptions } from './pdf/document.js';
import { applyOperations, type BatchResult, type Operation } from './project/ops.js';
import type { Project } from './project/model.js';
import { createProjectFile, readProjectFile, resolvePdfPath, withProjectLock, writeProjectFile, type CreateOptions } from './project/store.js';
import { validateProject, type ProjectValidation } from './project/validate.js';
import { McPrepError, type Issue } from './rules/issues.js';

/**
 * A project open for work: the project file, its PDF (opened lazily) and the operations that change frames, with
 * validation and export. The command line, the MCP server and the desktop app all work through it.
 */

export interface ApplyOptions {
  /** Which tool is writing (stored in the file). */
  modifiedBy: string;
  /** Compute and validate but do not write. */
  dryRun?: boolean;
  /** Write even when the operations introduce validation errors. */
  force?: boolean;
}

export interface ApplyOutcome {
  /** True when the project was written (false for a dry run or a rejected batch). */
  applied: boolean;
  /** True when the batch was rejected because it would introduce errors. */
  rejected: boolean;
  batch: BatchResult;
  validation: ProjectValidation;
  /** Errors that the batch introduced (the ones that were not there before). */
  introduced: Issue[];
  project: Project;
}

const sameIssue = (a: Issue, b: Issue): boolean => a.code === b.code && a.frameId === b.frameId && a.message === b.message;

function pagesMentioned(project: Project, operations: readonly Operation[]): number[] {
  const pages = new Set<number>();
  const refPages = new Map<string, number>();
  const frameById = new Map(project.frames.map((frame) => [frame.id, frame]));
  const regionPages = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const region of value) {
      const page = (region as { page?: unknown }).page;
      if (typeof page === 'number') pages.add(page);
    }
  };
  for (const op of operations) {
    const record = op as unknown as Record<string, unknown>;
    if (typeof record['page'] === 'number') pages.add(record['page']);
    regionPages(record['continues']);
    regionPages(record['context']);
    regionPages(record['regions']);
    const id = record['id'];
    if (typeof id === 'string') {
      const known = id.startsWith('@') ? refPages.get(id.slice(1)) : frameById.get(id)?.page;
      if (known !== undefined) pages.add(known);
    }
    if (op.op === 'add' && op.ref !== undefined) refPages.set(op.ref, op.page);
  }
  return [...pages].filter((page) => Number.isInteger(page) && page >= 0 && page < project.pdf.pageCount);
}

export class ProjectSession {
  readonly projectPath: string;
  project: Project;
  private pdf: PdfDocument | undefined;
  private readonly ignoreHash: boolean;

  private constructor(projectPath: string, project: Project, ignoreHash: boolean) {
    this.projectPath = projectPath;
    this.project = project;
    this.ignoreHash = ignoreHash;
  }

  static async open(projectPath: string, options: { ignorePdfChange?: boolean } = {}): Promise<ProjectSession> {
    const path = resolve(projectPath);
    return new ProjectSession(path, await readProjectFile(path), options.ignorePdfChange === true);
  }

  static async create(pdfPath: string, options: CreateOptions = {}): Promise<ProjectSession> {
    const created = await createProjectFile(pdfPath, options);
    return new ProjectSession(created.path, created.project, false);
  }

  get pdfPath(): string {
    return resolvePdfPath(this.projectPath, this.project);
  }

  /** The PDF, opened on first use and checked against the project (the file must be the one the frames were made on). */
  async document(): Promise<PdfDocument> {
    if (this.pdf) return this.pdf;
    const path = this.pdfPath;
    const exists = await stat(path).then(() => true, () => false);
    if (!exists) {
      throw new McPrepError('E_PDF_MISSING', `The PDF "${path}" of this project does not exist.`, {
        hint: 'Put the PDF back where the project expects it (the "pdf.path" in the project file is relative to the project file), or fix that path.',
      });
    }
    const pdf = await PdfDocument.open(path);
    if (!this.ignoreHash && pdf.sha256 !== this.project.pdf.sha256) {
      await pdf.close();
      throw new McPrepError('E_PDF_CHANGED', 'The PDF is not the one this project was made for: its SHA-256 differs.', {
        hint: 'Frames are positions on the pages of one exact file. Restore the original PDF, or start a new project with `mcprep init` for the changed one.',
      });
    }
    if (pdf.pageCount !== this.project.pdf.pageCount) {
      await pdf.close();
      throw new McPrepError('E_PDF_CHANGED', `The PDF has ${pdf.pageCount} pages; the project recorded ${this.project.pdf.pageCount}.`, {
        hint: 'Restore the original PDF, or start a new project with `mcprep init`.',
      });
    }
    this.pdf = pdf;
    return pdf;
  }

  async close(): Promise<void> {
    if (this.pdf) await this.pdf.close();
    this.pdf = undefined;
  }

  /** Re-reads the project file when another program changed it. Returns true when something changed. */
  async refresh(): Promise<boolean> {
    const fresh = await readProjectFile(this.projectPath);
    const changed = fresh.revision !== this.project.revision;
    this.project = fresh;
    return changed;
  }

  async pageText(page: number, options: TextOptions = {}): Promise<PageText> {
    return (await this.document()).pageText(page, options);
  }

  /** Text lines for snapping and validation; pages without text give an empty list. */
  private async textFor(pages: readonly number[]): Promise<Map<number, PageText>> {
    const pdf = await this.document();
    const map = new Map<number, PageText>();
    for (const page of new Set(pages)) map.set(page, await pdf.pageText(page));
    return map;
  }

  /**
   * Applies operations to the project on disk as one atomic batch: read fresh under the lock, apply in memory, validate
   * once, write only if the batch did not introduce errors (or `force`).
   */
  async apply(operations: readonly Operation[], options: ApplyOptions): Promise<ApplyOutcome> {
    const run = async (): Promise<ApplyOutcome> => {
      const current = await readProjectFile(this.projectPath);
      this.project = current;
      const snapping = operations.some((op) => (op as { snap?: unknown }).snap === true);
      const text = snapping ? await this.textFor(pagesMentioned(current, operations)) : new Map<number, PageText>();
      const batch = applyOperations(current, operations, {
        pageCount: current.pdf.pageCount,
        linesFor: (page): readonly TextLine[] | undefined => text.get(page)?.lines,
      });
      const before = validateProject(current);
      const touched = new Set<number>();
      for (const frame of batch.project.frames) {
        touched.add(frame.page);
        frame.continues?.forEach((region) => touched.add(region.page));
        frame.context?.forEach((region) => touched.add(region.page));
      }
      const validation = validateProject(batch.project, await this.textFor([...touched]));
      const introduced = validation.errors.filter((error) => !before.errors.some((old) => sameIssue(old, error)));
      const rejected = introduced.length > 0 && options.force !== true;
      if (rejected || options.dryRun === true) {
        return { applied: false, rejected, batch, validation, introduced, project: batch.project };
      }
      const written = await writeProjectFile(this.projectPath, batch.project, { modifiedBy: options.modifiedBy });
      this.project = written;
      return { applied: true, rejected: false, batch: { ...batch, project: written }, validation, introduced, project: written };
    };
    return options.dryRun === true ? run() : withProjectLock(this.projectPath, run);
  }

  async validate(options: { text?: boolean } = {}): Promise<ProjectValidation> {
    const project = this.project;
    if (options.text === false) return validateProject(project);
    const pages = new Set<number>();
    for (const frame of project.frames) {
      pages.add(frame.page);
      frame.continues?.forEach((region) => pages.add(region.page));
      frame.context?.forEach((region) => pages.add(region.page));
    }
    return validateProject(project, await this.textFor([...pages].filter((page) => page >= 0 && page < project.pdf.pageCount)));
  }

  /** Which outline the bundle would carry: the project's own, the PDF's, or none. */
  async outlineFor(mode: 'project' | 'pdf' | 'none'): Promise<OutlineEntry[] | undefined> {
    if (mode === 'none') return undefined;
    if (mode === 'pdf') return (await (await this.document()).outline()) ?? undefined;
    return this.project.outline?.entries;
  }

  /**
   * Exports the bundle: validates, writes atomically, then reads the result back with the importer's own checks and
   * removes it again if anything is wrong.
   */
  async exportBundle(
    outPath: string | undefined,
    options: { title?: string; folder?: string; outline?: 'project' | 'pdf' | 'none'; createdAt?: Date; verify?: boolean } = {},
  ): Promise<{ write: BundleWriteResult; check?: BundleReport; validation: ProjectValidation }> {
    await this.refresh();
    const validation = await this.validate({ text: false });
    if (!validation.ok) {
      throw new McPrepError('E_VALIDATION', `The project has ${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}; the importer would reject the bundle.`, {
        hint: 'Run `mcprep validate` and fix the errors it lists.',
        issues: validation.errors,
      });
    }
    const pdf = await this.document();
    const target = resolve(outPath ?? join(dirname(this.projectPath), `${basename(this.pdfPath, extname(this.pdfPath))}.mcbundle`));
    const outline = await this.outlineFor(options.outline ?? 'project');
    const frames: Frame[] = this.project.frames;
    const write = await writeBundle(target, {
      pdfPath: this.pdfPath,
      title: options.title ?? this.project.meta.title,
      ...((options.folder ?? this.project.meta.folder) !== undefined ? { folder: (options.folder ?? this.project.meta.folder) as string } : {}),
      pageCount: pdf.pageCount,
      frames,
      ...(outline ? { outline } : {}),
      expect: { sha256: this.project.pdf.sha256, bytes: this.project.pdf.bytes },
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
    if (options.verify === false) return { write, validation };
    const check = await checkBundle(target);
    if (!check.ok) {
      await unlink(target).catch(() => undefined);
      throw new McPrepError('E_BUNDLE_SELFTEST', `The bundle that was written fails the importer's checks: ${check.rejection?.message ?? 'unknown reason'}. It was removed.`, {
        hint: 'This is a bug in Math Canvas Prep; please report it with the project file.',
        issues: check.errors,
      });
    }
    return { write, check, validation };
  }
}
