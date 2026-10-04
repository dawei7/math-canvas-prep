import type { BookStructure, OutlineEntry, PageSize, PageText, Project, ProposalSet } from '@mcprep/core/pure';

/**
 * The whole surface between the renderer (the editor's user interface, which has no Node access) and the main process
 * (which reads PDFs and files). Everything crosses as plain data; the renderer never sees a file path it did not get from
 * the main process.
 */

export interface OpenedDocument {
  projectPath: string;
  pdfPath: string;
  project: Project;
  pageSizes: PageSize[];
  /** The PDF's own outline (bookmarks), or null. */
  pdfOutline: OutlineEntry[] | null;
}

export interface RecentEntry {
  /** The project file. */
  path: string;
  title: string;
  openedAt: string;
}

export type OpenOutcome = { ok: true; document: OpenedDocument } | { ok: false; message: string; code?: string };

export type SaveOutcome =
  | { ok: true; project: Project }
  | { ok: false; code: 'conflict'; message: string; onDisk: Project }
  | { ok: false; code: 'error'; message: string };

export interface ProposeRequest {
  pages?: number[];
  minConfidence?: number;
  graphics?: boolean;
}

/** What the importer check (the same steps the Android app takes) found in the bundle that was just written. */
export interface ImporterCheck {
  wouldImport: boolean;
  /** The optional parts of the format the bundle says it uses (`sections`, `authority`, `solution`). */
  features: string[];
  frames: number;
  outlineEntries: number;
  warnings: number;
  repairs: number;
  steps: { step: number; name: string; status: string; detail: string }[];
}

export type ExportOutcome =
  | { ok: true; path: string; bytes: number; frames: number; outlineEntries: number; issues: { severity: string; code: string; message: string; frameId?: string }[]; check: ImporterCheck }
  | { ok: false; code: string; message: string; hint?: string; issues?: { severity: string; code: string; message: string; frameId?: string; fix?: string }[] };

/** The result of writing the plain JSON summary of the book (sections with their exercise counts). */
export type BookSummaryOutcome = { ok: true; path: string; bytes: number; sections: number; exercises: number } | { ok: false; message: string };

/** One step of a long job (reading the pages, looking for the sections), for the progress bar. */
export interface AuditProgress {
  /** What is being done, in a few words ("Reading the text of the pages"). */
  phase: string;
  done: number;
  total: number;
}

/** The result of a long job: what it found, or why it did not (`cancelled`: the person stopped it). */
export type AuditOutcome<T> = { ok: true; result: T } | { ok: false; cancelled: boolean; message: string };

export interface DiskChange {
  /** The project as it is on disk now. */
  project: Project;
  /** Which tool wrote it, if it says. */
  modifiedBy?: string;
}

export interface Api {
  /** Native dialogs. Resolve to null when the person cancels. */
  chooseAndOpenPdf(): Promise<OpenOutcome | null>;
  chooseAndOpenProject(): Promise<OpenOutcome | null>;
  /** Open a PDF or a project by path (drag and drop, the recent list, the command line). */
  openPath(path: string): Promise<OpenOutcome>;
  /** The path of a file dropped onto the window. */
  pathForFile(file: File): string;
  recent(): Promise<RecentEntry[]>;

  readPdf(): Promise<Uint8Array>;
  pageText(page: number): Promise<PageText>;
  propose(request: ProposeRequest): Promise<ProposalSet>;
  /**
   * Finds the chapters and sections of the open book from its printed contents and headings (offline). It reads the text
   * of every page, so it takes seconds on a big book; `onProgress` reports it and `cancelAudit` stops it.
   */
  deriveSections(): Promise<AuditOutcome<BookStructure>>;
  /** Stops the long job that is running (reading the pages, deriving the sections, proposing exercises). */
  cancelAudit(): Promise<void>;
  /** Progress of the long job that is running. */
  onProgress(listener: (progress: AuditProgress) => void): () => void;

  saveProject(project: Project, expectedRevision: number): Promise<SaveOutcome>;
  /** Reads the project from disk again (to take the other side's version). */
  reloadProject(): Promise<Project>;
  /** Exports the saved project; asks where to write unless `outPath` is given. Null when cancelled. */
  exportBundle(options: { outline: 'project' | 'pdf' | 'none' }): Promise<ExportOutcome | null>;
  /** Writes the book summary (JSON) of the saved project; asks where to write it. Null when cancelled. */
  exportBookSummary(): Promise<BookSummaryOutcome | null>;
  /** Copies a file into a folder the person chooses; returns the new path or null. */
  copyToFolder(path: string): Promise<string | null>;
  reveal(path: string): Promise<void>;

  /** The project file changed on disk (an agent ran the command line, or someone edited it). */
  onDiskChange(listener: (change: DiskChange) => void): () => void;
  /** A command of the application menu (open, save, export, ...). */
  onMenu(listener: (command: string) => void): () => void;
  setDirty(dirty: boolean): void;
  /** The editor has registered its listeners: messages that were waiting (a file given on the command line) can come now. */
  ready(): void;
}

declare global {
  interface Window {
    mcprep: Api;
  }
}
