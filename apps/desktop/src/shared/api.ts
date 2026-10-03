import type { OutlineEntry, PageSize, PageText, Project, ProposalSet } from '@mcprep/core/pure';

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

export type ExportOutcome =
  | { ok: true; path: string; bytes: number; frames: number; outlineEntries: number; issues: { severity: string; code: string; message: string; frameId?: string }[] }
  | { ok: false; code: string; message: string; hint?: string; issues?: { severity: string; code: string; message: string; frameId?: string; fix?: string }[] };

export interface DerivedHeading extends OutlineEntry {
  confidence: number;
  evidence: string[];
}

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
  deriveOutline(): Promise<DerivedHeading[]>;

  saveProject(project: Project, expectedRevision: number): Promise<SaveOutcome>;
  /** Reads the project from disk again (to take the other side's version). */
  reloadProject(): Promise<Project>;
  /** Exports the saved project; asks where to write unless `outPath` is given. Null when cancelled. */
  exportBundle(options: { outline: 'project' | 'pdf' | 'none' }): Promise<ExportOutcome | null>;
  /** Copies a file into a folder the person chooses; returns the new path or null. */
  copyToFolder(path: string): Promise<string | null>;
  reveal(path: string): Promise<void>;

  /** The project file changed on disk (an agent ran the command line, or someone edited it). */
  onDiskChange(listener: (change: DiskChange) => void): () => void;
  /** A command of the application menu (open, save, export, ...). */
  onMenu(listener: (command: string) => void): () => void;
  setDirty(dirty: boolean): void;
}

declare global {
  interface Window {
    mcprep: Api;
  }
}
