import {
  McPrepError,
  applyOperations,
  contextToOperations,
  proposalSetToOperations,
  proposalToOperations,
  validateProject,
  type Frame,
  type Operation,
  type OutlineEntry,
  type PageSize,
  type PageText,
  type Project,
  type ProjectValidation,
  type ProposalSet,
  type FrameProposal,
} from '@mcprep/core/pure';
import type { Api, DerivedHeading, DiskChange, ExportOutcome, OpenedDocument, RecentEntry } from '../../shared/api.js';
import { describeChange, summarizeChange } from './contents.js';

export type Tool = 'select' | 'exercise' | 'parts' | 'context' | 'continues' | 'question' | 'bookmark';
export type Tab = 'frames' | 'contents' | 'checks' | 'propose';
export type Theme = 'system' | 'light' | 'dark';

export interface Notice {
  id: number;
  kind: 'info' | 'agent' | 'error' | 'success';
  text: string;
}

export interface Conflict {
  onDisk: Project;
  by: string | undefined;
}

export interface State {
  doc: { projectPath: string; pdfPath: string; pageSizes: PageSize[]; pdfOutline: OutlineEntry[] | null } | null;
  project: Project | null;
  /** The version last read from or written to disk. */
  base: Project | null;
  dirty: boolean;
  past: Project[];
  future: Project[];
  page: number;
  /** CSS pixels per PDF point; 0 means "fit the width". */
  zoom: number;
  tool: Tool;
  /** Any frame id; selecting a part selects its whole exercise. */
  selection: string | null;
  snap: boolean;
  tab: Tab;
  texts: Record<number, PageText>;
  validation: ProjectValidation | null;
  proposals: ProposalSet | null;
  proposalsBusy: boolean;
  /** Proposals the person has already accepted or rejected. */
  decided: Record<string, 'accepted' | 'rejected'>;
  derived: DerivedHeading[] | null;
  notice: Notice | null;
  /** The time of the last change made by another program (for the quiet indicator). */
  agentAt: number;
  saving: boolean;
  saveError: string | null;
  conflict: Conflict | null;
  theme: Theme;
  autosave: boolean;
  exporting: { open: boolean; busy: boolean; outline: 'project' | 'pdf' | 'none'; outcome: ExportOutcome | null; copiedTo: string | null };
  recent: RecentEntry[];
  busy: string | null;
  welcomeError: string | null;
}

const initial = (): State => ({
  doc: null,
  project: null,
  base: null,
  dirty: false,
  past: [],
  future: [],
  page: 0,
  zoom: 0,
  tool: 'select',
  selection: null,
  snap: true,
  tab: 'frames',
  texts: {},
  validation: null,
  proposals: null,
  proposalsBusy: false,
  decided: {},
  derived: null,
  notice: null,
  agentAt: 0,
  saving: false,
  saveError: null,
  conflict: null,
  theme: 'system',
  autosave: false,
  exporting: { open: false, busy: false, outline: 'project', outcome: null, copiedTo: null },
  recent: [],
  busy: null,
  welcomeError: null,
});

const content = (project: Project): string => JSON.stringify([project.frames, project.outline ?? null, project.meta]);
export const sameContent = (a: Project, b: Project): boolean => content(a) === content(b);

export interface ApplyResult {
  ok: boolean;
  created: string[];
  notes: string[];
}

let noticeCounter = 0;

/** How many pages of text are read before the editor redraws and checks again. */
const TEXT_CHUNK = 6;

/**
 * The editor's state and everything that changes it. It holds the working copy of the project and edits it with the
 * operations of the core (the same code the command line uses), keeps undo and redo, and talks to the main process only
 * through the `Api`. It does not touch the DOM, so it is tested without a window.
 */
export class Store {
  state: State;
  private readonly listeners = new Set<() => void>();
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: Api,
    overrides: Partial<State> = {},
  ) {
    this.state = { ...initial(), ...overrides };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------------------------------------------ notices

  notify(kind: Notice['kind'], text: string): void {
    clearTimeout(this.noticeTimer);
    noticeCounter += 1;
    this.set({ notice: { id: noticeCounter, kind, text } });
    if (kind !== 'error') {
      const id = noticeCounter;
      this.noticeTimer = setTimeout(() => {
        if (this.state.notice?.id === id) this.set({ notice: null });
      }, 7000);
    }
  }

  dismissNotice(): void {
    clearTimeout(this.noticeTimer);
    this.set({ notice: null });
  }

  // ------------------------------------------------------------------------------------------------------ opening

  async loadRecent(): Promise<void> {
    this.set({ recent: await this.api.recent() });
  }

  async openDocument(document: OpenedDocument): Promise<void> {
    this.set({
      doc: { projectPath: document.projectPath, pdfPath: document.pdfPath, pageSizes: document.pageSizes, pdfOutline: document.pdfOutline },
      project: document.project,
      base: document.project,
      dirty: false,
      past: [],
      future: [],
      page: 0,
      selection: null,
      tool: 'select',
      texts: {},
      proposals: null,
      decided: {},
      derived: null,
      conflict: null,
      saveError: null,
      welcomeError: null,
      tab: 'frames',
      notice: null,
    });
    this.revalidate();
    this.api.setDirty(false);
    await this.ensureText(0);
    void this.ensureFramePages();
  }

  async open(outcome: { ok: true; document: OpenedDocument } | { ok: false; message: string } | null): Promise<void> {
    if (outcome === null) return;
    if (!outcome.ok) {
      this.set({ welcomeError: outcome.message });
      this.notify('error', outcome.message);
      return;
    }
    await this.openDocument(outcome.document);
  }

  // ------------------------------------------------------------------------------------------------------- reading

  /** Reads the text of a page (once): the page view snaps to its lines and the checks look at them. */
  async ensureText(page: number): Promise<boolean> {
    return this.readPages([page]);
  }

  /**
   * Reads, in the background, the text of every page that has a frame: the frame list shows the first words of each frame
   * and the checks need the lines of the pages they look at. Pages without frames are read when they are shown.
   */
  async ensureFramePages(): Promise<boolean> {
    const pages = new Set((this.state.project?.frames ?? []).map((frame) => frame.page));
    return this.readPages([...pages].sort((a, b) => a - b));
  }

  /** Reads the pages not read yet, a few at a time (one redraw per few pages), and says whether all could be read. */
  private async readPages(pages: number[]): Promise<boolean> {
    const doc = this.state.doc;
    if (doc === null) return false;
    const wanted = pages.filter((page) => this.state.texts[page] === undefined);
    let failure: { page: number; error: unknown } | undefined;
    for (let start = 0; start < wanted.length && failure === undefined; start += TEXT_CHUNK) {
      const read: Record<number, PageText> = {};
      for (const page of wanted.slice(start, start + TEXT_CHUNK)) {
        try {
          read[page] = await this.api.pageText(page);
        } catch (error) {
          failure = { page, error };
          break;
        }
      }
      if (this.state.doc !== doc) return false; // another document was opened meanwhile: these pages are not its pages
      if (Object.keys(read).length > 0) {
        this.set({ texts: { ...this.state.texts, ...read } });
        this.revalidate();
      }
    }
    if (failure) this.notify('error', `Cannot read the text of page ${failure.page + 1}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
    return failure === undefined;
  }

  private textMap(): Map<number, PageText> {
    return new Map(Object.entries(this.state.texts).map(([key, value]) => [Number(key), value]));
  }

  private revalidate(): void {
    const { project } = this.state;
    this.set({ validation: project ? validateProject(project, this.textMap()) : null });
  }

  // ------------------------------------------------------------------------------------------------------ editing

  selected(): Frame | undefined {
    const { project, selection } = this.state;
    return project?.frames.find((frame) => frame.id === selection);
  }

  /**
   * Applies operations as one undoable step. A change that would introduce validation errors is refused with a notice,
   * exactly as the command line refuses it.
   */
  apply(operations: Operation[], options: { select?: 'created' | string | null } = {}): ApplyResult {
    const { project, doc } = this.state;
    if (!project || !doc) return { ok: false, created: [], notes: [] };
    try {
      const texts = this.textMap();
      const batch = applyOperations(project, operations, { pageCount: project.pdf.pageCount, linesFor: (page) => texts.get(page)?.lines });
      const before = validateProject(project, texts);
      const after = validateProject(batch.project, texts);
      const introduced = after.errors.filter((error) => !before.errors.some((old) => old.code === error.code && old.frameId === error.frameId && old.message === error.message));
      if (introduced.length > 0) {
        this.notify('error', `Not applied: ${introduced[0]?.message ?? 'validation error'}${introduced[0]?.fix ? ` (${introduced[0].fix})` : ''}`);
        return { ok: false, created: [], notes: [] };
      }
      const selection =
        options.select === 'created' ? (batch.created[0] ?? this.state.selection) : options.select === undefined ? this.state.selection : options.select;
      const stillThere = selection !== null && batch.project.frames.some((frame) => frame.id === selection) ? selection : null;
      this.set({
        project: batch.project,
        past: [...this.state.past.slice(-199), project],
        future: [],
        dirty: this.state.base ? !sameContent(batch.project, this.state.base) : true,
        selection: stillThere,
        validation: after,
      });
      this.api.setDirty(this.state.dirty);
      this.scheduleAutosave();
      void this.ensureFramePages();
      for (const note of batch.notes.slice(0, 2)) this.notify('info', note);
      return { ok: true, created: batch.created, notes: batch.notes };
    } catch (error) {
      this.notify('error', error instanceof McPrepError ? `${error.message}${error.hint ? ` ${error.hint}` : ''}` : error instanceof Error ? error.message : String(error));
      return { ok: false, created: [], notes: [] };
    }
  }

  undo(): void {
    const { past, project, base } = this.state;
    const previous = past[past.length - 1];
    if (!previous || !project) return;
    this.set({ project: previous, past: past.slice(0, -1), future: [project, ...this.state.future], dirty: base ? !sameContent(previous, base) : true });
    this.afterHistory();
  }

  redo(): void {
    const { future, project, base } = this.state;
    const next = future[0];
    if (!next || !project) return;
    this.set({ project: next, future: future.slice(1), past: [...this.state.past, project], dirty: base ? !sameContent(next, base) : true });
    this.afterHistory();
  }

  private afterHistory(): void {
    const { project, selection } = this.state;
    if (selection !== null && !project?.frames.some((frame) => frame.id === selection)) this.set({ selection: null });
    this.revalidate();
    this.api.setDirty(this.state.dirty);
    this.scheduleAutosave();
  }

  // --------------------------------------------------------------------------------------------------- navigation

  setPage(page: number): void {
    const { doc } = this.state;
    if (!doc) return;
    const clamped = Math.min(Math.max(0, Math.trunc(page)), doc.pageSizes.length - 1);
    this.set({ page: clamped });
    void this.ensureText(clamped);
  }

  setTool(tool: Tool): void {
    this.set({ tool });
  }

  select(id: string | null, options: { jump?: boolean } = {}): void {
    this.set({ selection: id });
    if (options.jump && id !== null) {
      const frame = this.state.project?.frames.find((entry) => entry.id === id);
      if (frame) this.setPage(frame.page);
    }
  }

  setZoom(zoom: number): void {
    this.set({ zoom: zoom === 0 ? 0 : Math.min(4, Math.max(0.25, zoom)) });
  }

  setTab(tab: Tab): void {
    this.set({ tab });
  }

  setSnap(snap: boolean): void {
    this.set({ snap });
  }

  setTheme(theme: Theme): void {
    this.set({ theme });
  }

  setAutosave(autosave: boolean): void {
    this.set({ autosave });
    this.scheduleAutosave();
  }

  // ---------------------------------------------------------------------------------------------------- saving

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    if (!this.state.autosave || !this.state.dirty) return;
    this.autosaveTimer = setTimeout(() => void this.save(), 1200);
  }

  async save(): Promise<boolean> {
    const { project, base, saving, conflict } = this.state;
    if (!project || !base || saving) return false;
    if (conflict) {
      this.notify('error', 'The project changed on disk: choose which version to keep first.');
      return false;
    }
    this.set({ saving: true, saveError: null });
    const outcome = await this.api.saveProject(project, base.revision);
    this.set({ saving: false });
    if (outcome.ok) {
      const latest = this.state.project ?? project;
      const merged: Project = { ...latest, revision: outcome.project.revision, updatedAt: outcome.project.updatedAt, modifiedBy: 'desktop' };
      this.set({ project: merged, base: outcome.project, dirty: !sameContent(latest, outcome.project) });
      this.api.setDirty(this.state.dirty);
      if (this.state.dirty) this.scheduleAutosave();
      return true;
    }
    if (outcome.code === 'conflict') {
      this.set({ conflict: { onDisk: outcome.onDisk, by: outcome.onDisk.modifiedBy } });
      return false;
    }
    this.set({ saveError: outcome.message });
    this.notify('error', `Saving failed: ${outcome.message}`);
    return false;
  }

  // ------------------------------------------------------------------------------------------- agents and conflicts

  onDiskChange(change: DiskChange): void {
    const { project, base, dirty, selection } = this.state;
    if (!project || !base) return;
    if (dirty) {
      this.set({ conflict: { onDisk: change.project, by: change.modifiedBy } });
      return;
    }
    const summary = summarizeChange(base, change.project);
    const keep = selection !== null && change.project.frames.some((frame) => frame.id === selection) ? selection : null;
    this.set({ project: change.project, base: change.project, past: [], future: [], selection: keep, agentAt: Date.now(), dirty: false });
    this.revalidate();
    void this.ensureFramePages();
    this.notify('agent', `Updated by ${change.modifiedBy ?? 'another program'}: ${describeChange(summary)}.`);
  }

  /** Resolve a change on disk that clashes with unsaved edits: keep mine (it will be saved over theirs) or take theirs. */
  resolveConflict(choice: 'mine' | 'theirs'): void {
    const { conflict, project } = this.state;
    if (!conflict || !project) return;
    if (choice === 'theirs') {
      this.set({ project: conflict.onDisk, base: conflict.onDisk, past: [], future: [], dirty: false, conflict: null, selection: null });
      this.revalidate();
      void this.ensureFramePages();
      this.api.setDirty(false);
      this.notify('info', 'Took the version from disk; your unsaved edits are gone.');
    } else {
      this.set({ base: conflict.onDisk, conflict: null, dirty: true });
      this.api.setDirty(true);
      this.notify('info', 'Keeping your edits: saving will replace the version on disk.');
    }
  }

  // ---------------------------------------------------------------------------------------------------- proposals

  async runPropose(): Promise<void> {
    if (!this.state.doc) return;
    this.set({ proposalsBusy: true, tab: 'propose' });
    try {
      const proposals = await this.api.propose({ graphics: true });
      this.set({ proposals, decided: {}, proposalsBusy: false });
      this.notify('info', proposals.proposals.length === 0 ? 'No proposals found.' : `${proposals.proposals.length} proposals found: accept or reject them.`);
    } catch (error) {
      this.set({ proposalsBusy: false });
      this.notify('error', `Proposing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pendingProposals(): FrameProposal[] {
    const { proposals, decided } = this.state;
    return proposals ? proposals.proposals.filter((proposal) => decided[proposal.id] === undefined) : [];
  }

  acceptProposal(id: string): void {
    const { proposals } = this.state;
    const proposal = proposals?.proposals.find((entry) => entry.id === id);
    if (!proposals || !proposal) return;
    const operations: Operation[] = proposalToOperations(proposal, { parts: 'context' });
    for (const context of proposals.contexts) if (context.appliesTo.includes(id)) operations.push(...contextToOperations({ ...context, appliesTo: [id] }));
    const result = this.apply(operations, { select: 'created' });
    if (result.ok) this.set({ decided: { ...this.state.decided, [id]: 'accepted' } });
  }

  rejectProposal(id: string): void {
    this.set({ decided: { ...this.state.decided, [id]: 'rejected' } });
  }

  acceptAll(): void {
    const { proposals } = this.state;
    if (!proposals) return;
    const pending = this.pendingProposals();
    if (pending.length === 0) return;
    const ids = pending.map((proposal) => proposal.id);
    const operations = proposalSetToOperations(proposals, { parts: 'context', only: ids });
    const result = this.apply(operations, { select: null });
    if (result.ok) this.set({ decided: { ...this.state.decided, ...Object.fromEntries(ids.map((id) => [id, 'accepted' as const])) } });
  }

  rejectAll(): void {
    const ids = this.pendingProposals().map((proposal) => proposal.id);
    this.set({ decided: { ...this.state.decided, ...Object.fromEntries(ids.map((id) => [id, 'rejected' as const])) } });
  }

  // ------------------------------------------------------------------------------------------------------ contents

  async deriveContents(): Promise<void> {
    this.set({ busy: 'Looking for headings...' });
    try {
      this.set({ derived: await this.api.deriveOutline(), busy: null });
    } catch (error) {
      this.set({ busy: null });
      this.notify('error', `Could not derive the contents: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setOutline(entries: OutlineEntry[], source: 'manual' | 'derived' | 'pdf' = 'manual'): void {
    this.apply([{ op: 'outline.set', entries, source }]);
  }

  clearOutline(): void {
    this.apply([{ op: 'outline.clear' }]);
  }

  // -------------------------------------------------------------------------------------------------------- export

  openExport(): void {
    const { project, doc } = this.state;
    this.set({ exporting: { open: true, busy: false, outline: project?.outline ? 'project' : doc?.pdfOutline ? 'pdf' : 'none', outcome: null, copiedTo: null } });
  }

  closeExport(): void {
    this.set({ exporting: { ...this.state.exporting, open: false } });
  }

  setExportOutline(outline: 'project' | 'pdf' | 'none'): void {
    this.set({ exporting: { ...this.state.exporting, outline } });
  }

  async runExport(): Promise<void> {
    const { exporting } = this.state;
    this.set({ exporting: { ...exporting, busy: true, outcome: null, copiedTo: null } });
    if (this.state.dirty && !(await this.save())) {
      this.set({ exporting: { ...this.state.exporting, busy: false, outcome: { ok: false, code: 'E_SAVE', message: 'The project could not be saved first, so nothing was exported.' } } });
      return;
    }
    try {
      const outcome = await this.api.exportBundle({ outline: exporting.outline });
      this.set({ exporting: { ...this.state.exporting, busy: false, outcome } });
    } catch (error) {
      this.set({ exporting: { ...this.state.exporting, busy: false, outcome: { ok: false, code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) } } });
    }
  }

  async copyExport(): Promise<void> {
    const outcome = this.state.exporting.outcome;
    if (!outcome?.ok) return;
    try {
      const copied = await this.api.copyToFolder(outcome.path);
      if (copied) this.set({ exporting: { ...this.state.exporting, copiedTo: copied } });
    } catch (error) {
      this.notify('error', `Could not copy the bundle: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
