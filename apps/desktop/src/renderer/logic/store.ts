import {
  applyOperations,
  contextToOperations,
  detectParts,
  isAuthoritative,
  keptDividers,
  linesInRect,
  proposalSetToOperations,
  proposalToOperations,
  validateProject,
  type BookStructure,
  type Frame,
  type FrameProposal,
  type Issue,
  type Operation,
  type OutlineEntry,
  type PageSize,
  type PageText,
  type Project,
  type ProjectValidation,
  type ProposalSet,
  type Rect,
} from '@mcprep/core/pure';
import type { Api, AuditOutcome, AuditProgress, BookRequest, BookResult, BookSummaryOutcome, DiskChange, ExportOutcome, OpenedDocument, RecentEntry } from '../../shared/api.js';
import { checkBookLabel, suggestFor, suggestLabel } from './book.js';
import { describeChange, summarizeChange } from './contents.js';
import { compareOutline, defaultSelection, describeOutcome, resolveDerive, type DeriveFilter, type DeriveOutcome, type DerivePlan } from './derive.js';
import { plainError, NO_PARTS_REASON } from './errors.js';
import { middleCut } from './geometry.js';
import { bookModel, frameIndex, type BookModel } from './model.js';
import { Progress } from './progress.js';
import { bookRows, defaultTicks, describePlan, exerciseRefs, planBook, viewRows, type BookFilter, type BookKind, type BookRow, type BookRows, type ConfidenceFilter } from './proposals.js';

export type Tool = 'select' | 'exercise' | 'book' | 'parts' | 'context' | 'continues' | 'solution' | 'question' | 'bookmark';
export type Tab = 'frames' | 'sections' | 'checks' | 'propose';
/** What the Propose panel proposes: frames from the text of the pages, or the exercises or the answers of a book. */
export type ProposeMode = 'frames' | 'exercises' | 'solutions';
export type Theme = 'system' | 'light' | 'dark';
/** Which frames the Frames list shows: everything, what a person framed for themselves, or the book exercises. */
export type FramesFilter = 'all' | 'ordinary' | 'book';
/** Which sections the Sections list shows. */
export type SectionFilter = 'all' | 'empty' | 'unsolved' | 'problems';
/** The three kinds of region an exercise can carry besides its own: what continues it, the instruction, the hidden answer. */
export type RegionKind = 'continues' | 'context' | 'solution';

/** The long jobs that read the whole book in the main process (one at a time). */
export type AuditJob = 'sections' | 'exercises' | 'solutions';

/** The sections found in the printed text of the book, looked at before any of them is taken. */
export interface DeriveReview {
  structure: BookStructure;
  /** The ids of the derived entries the person takes. */
  selected: Record<string, true>;
  /** Keep the sections of the project that the derived list does not have, also those without exercises (matters when the whole list is taken). */
  keepOthers: boolean;
  /** For a section of the project that has exercises and no counterpart in the derived list: the section its exercises move to. */
  moves: Record<string, string>;
  filter: DeriveFilter;
  /** The derived entry whose evidence is shown. */
  focus: string | null;
  /** Why the last attempt to apply failed, in plain words. */
  error: string | null;
}

/** The exercises or the answers the search found in the book, looked at before anything is applied. */
export interface BookReview {
  kind: BookKind;
  result: BookResult;
  /** Ticked rows are taken by "Apply selected": by default every row the project does not have. */
  ticked: Record<string, true>;
  /** Rows the person dismissed: never applied, not listed (unless the list shows them). */
  rejected: Record<string, true>;
  filter: BookFilter;
  confidence: ConfidenceFilter;
  /** The row whose evidence is shown. */
  focus: string | null;
  /** What the last apply did, in one line. */
  summary: string | null;
  /** Why the last apply was refused, in plain words. */
  error: string | null;
}

export interface Notice {
  id: number;
  kind: 'info' | 'agent' | 'error' | 'success';
  text: string;
}

export interface Conflict {
  onDisk: Project;
  by: string | undefined;
}

/** A book exercise that has been drawn but not yet confirmed: it asks for its printed number and its section first. */
export interface Draft {
  page: number;
  rect: Rect;
  /** What the form offers first: the section at this place and the number that probably comes next in it. */
  label: string;
  section: string | undefined;
  /** Why no section could be offered, when there is none. */
  note: string | null;
  /** Why the last attempt to confirm failed, in plain words. */
  error: string | null;
}

/** Where a list or a click asked the page view to look: a frame, a proposal, a region of a page, or a height on it. */
export interface Focus {
  tick: number;
  ghost: string | null;
  page?: number;
  region?: Rect;
  y?: number;
  /** After this time (ms since 1970) the page view stops marking the place. */
  until?: number;
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
  /** Counts the times a list asked for a frame (or a proposal) to be brought into view; the page view scrolls to it. */
  focus: Focus;
  snap: boolean;
  tab: Tab;
  texts: Record<number, PageText>;
  validation: ProjectValidation | null;
  proposals: ProposalSet | null;
  proposalsBusy: boolean;
  /** Proposals the person has already accepted or rejected. */
  decided: Record<string, 'accepted' | 'rejected'>;
  /** The long job that is running in the main process, and whether the person asked it to stop. */
  audit: { job: AuditJob | null; stopping: boolean };
  derive: DeriveReview | null;
  proposeMode: ProposeMode;
  /** The section the search for exercises is limited to ("all" or a section id). */
  bookScope: string;
  book: { exercises: BookReview | null; solutions: BookReview | null };
  /** Why the last search for exercises or answers found nothing to look at, in plain words. */
  bookMessage: { kind: BookKind; text: string } | null;
  notice: Notice | null;
  /** The time of the last change made by another program (for the quiet indicator). */
  agentAt: number;
  saving: boolean;
  saveError: string | null;
  conflict: Conflict | null;
  theme: Theme;
  autosave: boolean;
  exporting: {
    open: boolean;
    busy: boolean;
    outline: 'project' | 'pdf' | 'none';
    outcome: ExportOutcome | null;
    copiedTo: string | null;
    summary: BookSummaryOutcome | null;
    summaryBusy: boolean;
  };
  recent: RecentEntry[];
  busy: string | null;
  welcomeError: string | null;
  /** The book exercise being drawn, waiting for its number and section. */
  draft: Draft | null;
  framesFilter: FramesFilter;
  /** Groups of the Frames list that are folded away (by group key). */
  collapsed: Record<string, true>;
  /** The selected entry of the Sections list (its place in the outline). */
  sectionSelection: number | null;
  sectionFilter: SectionFilter;
  collapsedSections: Record<string, true>;
  /** The section whose heading the next click on the page sets (its place in the outline). */
  picking: number | null;
  infoOpen: boolean;
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
  focus: { tick: 0, ghost: null },
  snap: true,
  tab: 'frames',
  texts: {},
  validation: null,
  proposals: null,
  proposalsBusy: false,
  decided: {},
  audit: { job: null, stopping: false },
  derive: null,
  proposeMode: 'frames',
  bookScope: 'all',
  book: { exercises: null, solutions: null },
  bookMessage: null,
  notice: null,
  agentAt: 0,
  saving: false,
  saveError: null,
  conflict: null,
  theme: 'system',
  autosave: false,
  exporting: { open: false, busy: false, outline: 'project', outcome: null, copiedTo: null, summary: null, summaryBusy: false },
  recent: [],
  busy: null,
  welcomeError: null,
  draft: null,
  framesFilter: 'all',
  collapsed: {},
  sectionSelection: null,
  sectionFilter: 'all',
  collapsedSections: {},
  picking: null,
  infoOpen: false,
});

const content = (project: Project): string => JSON.stringify([project.frames, project.outline ?? null, project.meta]);
export const sameContent = (a: Project, b: Project): boolean => content(a) === content(b);

export interface ApplyResult {
  ok: boolean;
  created: string[];
  notes: string[];
  /** Why nothing was applied, in plain words. */
  error?: string;
}

export interface ApplyOptions {
  select?: 'created' | string | null;
  /** Do not show the refusal or the notes as a notice: the caller shows `error` where it asked (a form). */
  quiet?: boolean;
}

/** The fields of a section (an outline entry) the Sections list can change; `null` removes an optional field. */
export interface SectionPatch {
  title?: string;
  label?: string | null;
  id?: string | null;
  /** Zero-based. */
  page?: number;
  top?: number | null;
}

let noticeCounter = 0;

/** How many pages of text are read before the editor redraws. */
const TEXT_CHUNK = 6;

/** How long the page view marks the place a list jumped to. */
const MARK_MS = 1700;

const fail = (error: string): ApplyResult => ({ ok: false, created: [], notes: [], error });

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
  private revalidateTimer: ReturnType<typeof setTimeout> | undefined;
  /** The text of the version last read from or written to disk, to tell in one comparison whether there is anything to save. */
  private baseContent = '';
  /** The errors of a version of the project already checked: the checks that read text only add warnings. */
  private validated: { project: Project; errors: Issue[] } | undefined;
  /** Progress of the long job: outside the state, so that its bar redraws ten times a second and nothing else does. */
  readonly progress = new Progress();
  private auditSeq = 0;
  private planCache: { structure: BookStructure; entries: readonly OutlineEntry[]; groups: BookModel['groups']; plan: DerivePlan } | undefined;
  private outcomeCache: { review: DeriveReview; plan: DerivePlan; outcome: DeriveOutcome } | undefined;
  private listCache: Partial<Record<BookKind, { review: BookReview; model: BookRows; list: BookRow[] }>> = {};

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

  /** Makes `base` the version on disk: the patch to apply, and the text later comparisons use. */
  private asBase(base: Project): Partial<State> {
    this.baseContent = content(base);
    return { base };
  }

  private isDirty(project: Project): boolean {
    return this.state.base === null || content(project) !== this.baseContent;
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
      ...this.asBase(document.project),
      dirty: false,
      past: [],
      future: [],
      page: 0,
      selection: null,
      tool: 'select',
      texts: {},
      proposals: null,
      decided: {},
      derive: null,
      proposeMode: 'frames',
      bookScope: 'all',
      book: { exercises: null, solutions: null },
      bookMessage: null,
      conflict: null,
      saveError: null,
      welcomeError: null,
      tab: 'frames',
      notice: null,
      draft: null,
      framesFilter: 'all',
      collapsed: {},
      sectionSelection: null,
      sectionFilter: 'all',
      collapsedSections: {},
      picking: null,
      infoOpen: false,
      focus: { tick: 0, ghost: null },
    });
    this.validated = undefined;
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

  /** Reads the text of these pages (those not read yet): a list calls it for the rows it shows. */
  async ensureTexts(pages: readonly number[]): Promise<boolean> {
    return this.readPages([...new Set(pages)].filter((page) => page >= 0));
  }

  /**
   * Reads, in the background, the text of every page that holds a frame or a region of one: the frame list shows the first
   * words of each frame and the checks need the lines of the pages they look at. Pages without frames are read when they
   * are shown.
   */
  async ensureFramePages(): Promise<boolean> {
    const index = frameIndex(this.state.project?.frames ?? []);
    return this.readPages([...index.pages.keys()].sort((a, b) => a - b));
  }

  /** Reads the pages not read yet, a few at a time (one redraw per few pages), and says whether all could be read. */
  private async readPages(pages: number[]): Promise<boolean> {
    const doc = this.state.doc;
    if (doc === null) return false;
    const wanted = pages.filter((page) => this.state.texts[page] === undefined && page < doc.pageSizes.length);
    let failure: { page: number; error: unknown } | undefined;
    for (let start = 0; start < wanted.length && failure === undefined; start += TEXT_CHUNK) {
      const read: Record<number, PageText> = {};
      for (const page of wanted.slice(start, start + TEXT_CHUNK)) {
        if (this.state.texts[page] !== undefined) continue;
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
        this.scheduleRevalidate();
      }
    }
    if (failure) this.notify('error', `Cannot read the text of page ${failure.page + 1}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
    return failure === undefined;
  }

  private textMap(): Map<number, PageText> {
    return new Map(Object.entries(this.state.texts).map(([key, value]) => [Number(key), value]));
  }

  private revalidate(): void {
    clearTimeout(this.revalidateTimer);
    const { project } = this.state;
    const validation = project ? validateProject(project, this.textMap()) : null;
    if (project && validation) this.validated = { project, errors: validation.errors };
    this.set({ validation });
  }

  /** Text arrives page by page: check again once a moment has passed without more, not after every few pages. */
  private scheduleRevalidate(): void {
    clearTimeout(this.revalidateTimer);
    this.revalidateTimer = setTimeout(() => this.revalidate(), 500);
  }

  /** The sections and the book exercises of the open project (cached until the project changes). */
  book(): BookModel {
    const { project, doc } = this.state;
    return bookModel(project?.frames ?? [], project?.outline?.entries, project?.pdf.pageCount ?? doc?.pageSizes.length ?? 0);
  }

  // ------------------------------------------------------------------------------------------------------ editing

  selected(): Frame | undefined {
    const { project, selection } = this.state;
    return selection === null || !project ? undefined : frameIndex(project.frames).byId.get(selection);
  }

  /**
   * Applies operations as one undoable step. A change that would introduce validation errors is refused with a notice,
   * exactly as the command line refuses it.
   */
  apply(operations: Operation[], options: ApplyOptions = {}): ApplyResult {
    const { project, doc } = this.state;
    if (!project || !doc) return fail('No project is open.');
    const refuse = (error: string): ApplyResult => {
      if (options.quiet !== true) this.notify('error', error);
      return fail(error);
    };
    try {
      const texts = this.textMap();
      const batch = applyOperations(project, operations, { pageCount: project.pdf.pageCount, linesFor: (page) => texts.get(page)?.lines });
      const before = this.validated?.project === project ? this.validated.errors : validateProject(project, texts).errors;
      const after = validateProject(batch.project, texts);
      const introduced = after.errors.filter((error) => !before.some((old) => old.code === error.code && old.frameId === error.frameId && old.message === error.message));
      if (introduced.length > 0) {
        const first = introduced[0] as Issue;
        return refuse(`Not applied: ${plainIssueMessage(first)}`);
      }
      this.validated = { project: batch.project, errors: after.errors };
      const selection =
        options.select === 'created' ? (batch.created[0] ?? this.state.selection) : options.select === undefined ? this.state.selection : options.select;
      const stillThere = selection !== null && frameIndex(batch.project.frames).byId.has(selection) ? selection : null;
      this.set({
        project: batch.project,
        past: [...this.state.past.slice(-199), project],
        future: [],
        dirty: this.isDirty(batch.project),
        selection: stillThere,
        validation: after,
      });
      this.api.setDirty(this.state.dirty);
      this.scheduleAutosave();
      void this.ensureFramePages();
      if (options.quiet !== true) for (const note of batch.notes.slice(0, 2)) this.notify('info', note);
      return { ok: true, created: batch.created, notes: batch.notes };
    } catch (error) {
      return refuse(plainError(error));
    }
  }

  undo(): void {
    const { past, project } = this.state;
    const previous = past[past.length - 1];
    if (!previous || !project) return;
    this.set({ project: previous, past: past.slice(0, -1), future: [project, ...this.state.future], dirty: this.isDirty(previous) });
    this.afterHistory();
  }

  redo(): void {
    const { future, project } = this.state;
    const next = future[0];
    if (!next || !project) return;
    this.set({ project: next, future: future.slice(1), past: [...this.state.past, project], dirty: this.isDirty(next) });
    this.afterHistory();
  }

  private afterHistory(): void {
    const { project, selection } = this.state;
    if (selection !== null && !(project && frameIndex(project.frames).byId.has(selection))) this.set({ selection: null });
    this.set({ draft: null, picking: null });
    this.revalidate();
    this.api.setDirty(this.state.dirty);
    this.scheduleAutosave();
    void this.ensureFramePages();
  }

  // --------------------------------------------------------------------------------------------------- navigation

  setPage(page: number): void {
    const { doc } = this.state;
    if (!doc) return;
    const clamped = Math.min(Math.max(0, Math.trunc(page)), doc.pageSizes.length - 1);
    // A book exercise that was drawn and is waiting for its number belongs to the page it was drawn on.
    this.set({ page: clamped, ...(this.state.draft !== null && this.state.draft.page !== clamped ? { draft: null } : {}) });
    void this.ensureText(clamped);
  }

  setTool(tool: Tool): void {
    this.set({ tool, draft: null, picking: null });
  }

  /** Selects a frame. With `jump` (a click in a list) the page of the frame is shown and the frame is scrolled into view. */
  select(id: string | null, options: { jump?: boolean } = {}): void {
    this.set({ selection: id });
    if (options.jump && id !== null) {
      const frame = this.selected();
      if (frame) {
        this.set({ focus: { tick: this.state.focus.tick + 1, ghost: null } });
        this.setPage(frame.page);
      }
    }
  }

  /** Shows the page of a proposal and scrolls its ghost frame into view. */
  showProposal(id: string): void {
    const proposal = this.state.proposals?.proposals.find((entry) => entry.id === id);
    if (!proposal) return;
    this.set({ focus: { tick: this.state.focus.tick + 1, ghost: id } });
    this.setPage(proposal.page);
  }

  /** Shows a region of a page (a context or solution region listed on an exercise) and marks it for a moment. */
  showRegion(page: number, rect: Rect): void {
    this.set({ focus: { tick: this.state.focus.tick + 1, ghost: null, page, region: rect, until: Date.now() + MARK_MS } });
    this.setPage(page);
  }

  /** Shows a place on a page (the heading of a section) and marks it for a moment. */
  showPlace(page: number, top: number | undefined): void {
    this.set({ focus: { tick: this.state.focus.tick + 1, ghost: null, page, y: top ?? 0, until: Date.now() + MARK_MS } });
    this.setPage(page);
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

  // ---------------------------------------------------------------------------------------------------- book exercises

  /** A book exercise has been drawn: remember where, and offer the section at that place and the next number in it. */
  startDraft(page: number, rect: Rect): void {
    if (!this.state.project) return;
    const suggestion = suggestFor(this.book(), page, rect.top);
    this.set({ draft: { page, rect, label: suggestion.label, section: suggestion.section, note: suggestion.noSection ?? null, error: null } });
  }

  cancelDraft(): void {
    if (this.state.draft) this.set({ draft: null });
  }

  /** The number that probably comes next in a section (for a form whose section was changed). */
  nextLabelIn(section: string, exceptId?: string): string {
    return suggestLabel(this.book(), section, exceptId);
  }

  /** Files the drawn exercise under the section with the printed number the person typed. False (with the reason in the form) when it cannot be. */
  confirmDraft(label: string, section: string | undefined): boolean {
    const draft = this.state.draft;
    if (!draft) return false;
    const checked = checkBookLabel(this.book(), label, section);
    if (checked.problem !== undefined) {
      this.set({ draft: { ...draft, error: checked.problem } });
      return false;
    }
    const result = this.apply([{ op: 'add', authority: 'book', label: checked.label, section: section as string, page: draft.page, rect: draft.rect, snap: this.state.snap }], { select: 'created', quiet: true });
    if (!result.ok) {
      this.set({ draft: { ...draft, error: result.error ?? 'The exercise could not be added.' } });
      return false;
    }
    this.set({ draft: null });
    return true;
  }

  /** Turns an exercise a person framed into a book exercise with this printed number and section. */
  markAsBook(id: string, label: string, section: string | undefined): ApplyResult {
    const checked = checkBookLabel(this.book(), label, section, id);
    if (checked.problem !== undefined) return fail(checked.problem);
    const result = this.apply([{ op: 'authority.mark', id, label: checked.label, section: section as string }], { quiet: true });
    if (result.ok && result.notes[0] !== undefined) this.notify('info', result.notes[0]);
    return result;
  }

  /** Turns a book exercise back into an ordinary one: it gets a positional number and can be cut into parts. */
  unmark(id: string): ApplyResult {
    const result = this.apply([{ op: 'authority.unmark', id }], { quiet: true });
    if (result.ok && result.notes[0] !== undefined) this.notify('info', result.notes[0]);
    return result;
  }

  setBookLabel(id: string, label: string): ApplyResult {
    const frame = frameIndex(this.state.project?.frames ?? []).byId.get(id);
    const checked = checkBookLabel(this.book(), label, frame?.section, id);
    if (checked.problem !== undefined) return fail(checked.problem);
    if (frame?.label === checked.label) return { ok: true, created: [], notes: [] };
    return this.apply([{ op: 'label.set', id, label: checked.label }], { quiet: true });
  }

  setBookSection(id: string, section: string): ApplyResult {
    const frame = frameIndex(this.state.project?.frames ?? []).byId.get(id);
    if (frame?.section === section) return { ok: true, created: [], notes: [] };
    const checked = checkBookLabel(this.book(), frame?.label ?? '', section, id);
    if (checked.problem !== undefined) return fail(checked.problem);
    return this.apply([{ op: 'section.set', id, section }], { quiet: true });
  }

  // ------------------------------------------------------------------------------------------------------- regions

  /** Attaches a region to an exercise: where it continues, its instruction (context), or its hidden answer (solution). */
  addRegion(kind: RegionKind, id: string, page: number, rect: Rect): ApplyResult {
    const snap = this.state.snap;
    return this.apply([{ op: `${kind}.add`, id, page, rect, snap } as Operation]);
  }

  removeRegion(kind: RegionKind, id: string, index: number): ApplyResult {
    return this.apply([{ op: `${kind}.remove`, id, index } as Operation], { quiet: true });
  }

  /** Cuts an exercise into parts where the markers (a), (b), 1., ... are found, else once in the middle. */
  cutIntoParts(id: string): ApplyResult {
    const frame = frameIndex(this.state.project?.frames ?? []).byId.get(id);
    if (!frame) return fail('There is no such frame.');
    if (isAuthoritative(frame)) return fail(NO_PARTS_REASON);
    const text = this.state.texts[frame.page];
    const detection = detectParts(linesInRect(text?.lines ?? [], frame.rect).filter((line) => line.headerFooter !== true));
    const cuts = detection ? keptDividers(frame.rect, detection.dividers) : [];
    return this.apply([{ op: 'split', id, at: cuts.length > 0 ? cuts : middleCut(frame.rect, text) }], { select: id, quiet: true });
  }

  /** Joins the parts of an exercise into one frame again. */
  joinParts(unit: string): ApplyResult {
    return this.apply([{ op: 'merge', unit }], { quiet: true });
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
      this.set({ project: merged, ...this.asBase(outcome.project), dirty: this.isDirty(latest) });
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
    const keep = selection !== null && frameIndex(change.project.frames).byId.has(selection) ? selection : null;
    this.set({ project: change.project, ...this.asBase(change.project), past: [], future: [], selection: keep, agentAt: Date.now(), dirty: false, draft: null });
    this.revalidate();
    void this.ensureFramePages();
    this.notify('agent', `Updated by ${change.modifiedBy ?? 'another program'}: ${describeChange(summary)}.`);
  }

  /** Resolve a change on disk that clashes with unsaved edits: keep mine (it will be saved over theirs) or take theirs. */
  resolveConflict(choice: 'mine' | 'theirs'): void {
    const { conflict, project } = this.state;
    if (!conflict || !project) return;
    if (choice === 'theirs') {
      this.set({ project: conflict.onDisk, ...this.asBase(conflict.onDisk), past: [], future: [], dirty: false, conflict: null, selection: null, draft: null });
      this.revalidate();
      void this.ensureFramePages();
      this.api.setDirty(false);
      this.notify('info', 'Took the version from disk; your unsaved edits are gone.');
    } else {
      this.set({ ...this.asBase(conflict.onDisk), conflict: null, dirty: true });
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

  // ---------------------------------------------------------------------------------------------- the Frames list

  setFramesFilter(framesFilter: FramesFilter): void {
    this.set({ framesFilter });
  }

  toggleGroup(key: string): void {
    const collapsed = { ...this.state.collapsed };
    if (collapsed[key]) delete collapsed[key];
    else collapsed[key] = true;
    this.set({ collapsed });
  }

  // ------------------------------------------------------------------------------------------------------ sections

  /** The entries of the project's own outline: the sections of the book. */
  sections(): readonly OutlineEntry[] {
    return this.state.project?.outline?.entries ?? [];
  }

  selectSection(index: number | null): void {
    this.set({ sectionSelection: index, picking: null });
  }

  /** Selects a section and shows its heading. */
  goToSection(index: number): void {
    const entry = this.sections()[index];
    if (!entry) return;
    this.set({ sectionSelection: index });
    this.showPlace(entry.page, entry.top);
  }

  setSectionFilter(sectionFilter: SectionFilter): void {
    this.set({ sectionFilter });
  }

  toggleSection(key: string): void {
    const collapsedSections = { ...this.state.collapsedSections };
    if (collapsedSections[key]) delete collapsedSections[key];
    else collapsedSections[key] = true;
    this.set({ collapsedSections });
  }

  /** Where the next section goes: after the entry and everything below it (a sibling, or its last child), else at the end. */
  private insertionPoint(after: number | undefined, child: boolean): { at: number; depth: number } {
    const model = this.book();
    const node = after === undefined ? undefined : model.tree.nodes[after];
    if (!node) return { at: model.entries.length, depth: 0 };
    return { at: node.subtreeEnd, depth: child ? node.depth + 1 : node.depth };
  }

  /** The operation that makes the PDF's own bookmarks the project's outline, when it has none: editing starts from them. */
  private adoptFirst(): Operation[] {
    const { project, doc } = this.state;
    return !project?.outline && doc?.pdfOutline ? [{ op: 'outline.set', entries: doc.pdfOutline, source: 'pdf' }] : [];
  }

  /** Adds a section after the given one (a sibling, or with `child` a subsection at the end of it), at the page shown. */
  addSection(options: { title?: string; after?: number; child?: boolean; label?: string; id?: string } = {}): ApplyResult & { index?: number } {
    const adopt = this.adoptFirst();
    const { at, depth } = adopt.length > 0 ? { at: (this.state.doc?.pdfOutline ?? []).length, depth: 0 } : this.insertionPoint(options.after, options.child === true);
    const operation: Operation = { op: 'outline.add', title: options.title ?? 'New section', page: this.state.page, depth, at, ...(options.label !== undefined ? { label: options.label } : {}), ...(options.id !== undefined ? { id: options.id } : {}) };
    const result = this.apply([...adopt, operation], { quiet: true });
    if (!result.ok) {
      this.notify('error', result.error ?? 'The section could not be added.');
      return result;
    }
    this.set({ sectionSelection: at });
    return { ...result, index: at };
  }

  updateSection(index: number, patch: SectionPatch): ApplyResult {
    const operation: Extract<Operation, { op: 'outline.update' }> = { op: 'outline.update', index };
    if (patch.title !== undefined) operation.title = patch.title;
    if (patch.label !== undefined) operation.label = patch.label;
    if (patch.id !== undefined) operation.newId = patch.id;
    if (patch.page !== undefined) operation.page = patch.page;
    if (patch.top !== undefined) operation.top = patch.top;
    const result = this.apply([operation], { quiet: true });
    // Renaming an id takes the exercises of the section along: say how many.
    if (result.ok && result.notes[0] !== undefined) this.notify('info', result.notes[0]);
    return result;
  }

  /** Makes a section (and everything below it) one level deeper (+1) or shallower (-1), keeping the shape of its subtree. */
  shiftSectionDepth(index: number, delta: 1 | -1): ApplyResult {
    const model = this.book();
    const node = model.tree.nodes[index];
    if (!node) return fail('That section does not exist (any more).');
    const operations: Operation[] = [];
    for (let at = index; at < node.subtreeEnd; at += 1) operations.push({ op: 'outline.update', index: at, depth: (model.entries[at] as OutlineEntry).depth + delta });
    return this.apply(operations, { quiet: true });
  }

  /** Moves a section, with everything below it, past its previous (-1) or next (+1) sibling. */
  moveSection(index: number, delta: 1 | -1): ApplyResult {
    const model = this.book();
    const node = model.tree.nodes[index];
    if (!node) return fail('That section does not exist (any more).');
    const siblings = node.parent >= 0 ? (model.tree.nodes[node.parent]?.children ?? []) : model.tree.roots;
    const position = siblings.indexOf(index);
    const otherIndex = siblings[position + delta];
    if (otherIndex === undefined) return fail(delta < 0 ? 'It is the first section on its level.' : 'It is the last section on its level.');
    const other = model.tree.nodes[otherIndex];
    if (!other) return fail('That section does not exist (any more).');
    const first = delta < 0 ? other : node;
    const second = delta < 0 ? node : other;
    const entries = model.entries;
    const moved = [...entries.slice(0, first.index), ...entries.slice(second.index, second.subtreeEnd), ...entries.slice(first.index, first.subtreeEnd), ...entries.slice(second.subtreeEnd)];
    const result = this.apply([{ op: 'outline.set', entries: moved, source: this.state.project?.outline?.source ?? 'manual' }], { quiet: true });
    if (result.ok) this.set({ sectionSelection: delta < 0 ? other.index : node.index + (other.subtreeEnd - other.index) });
    return result;
  }

  /**
   * Deletes a section. The book exercises filed under it (or under anything below it, with `subtree`) must go somewhere
   * first: `moveTo` names the section that takes them, otherwise the core refuses and says how many there are.
   */
  deleteSection(index: number, options: { subtree?: boolean; moveTo?: string } = {}): ApplyResult {
    const model = this.book();
    const node = model.tree.nodes[index];
    if (!node) return fail('That section does not exist (any more).');
    const operations: Operation[] = [];
    if (options.moveTo !== undefined) {
      const end = options.subtree === true ? node.subtreeEnd : index + 1;
      for (let at = index; at < end; at += 1) {
        const id = (model.entries[at] as OutlineEntry).id;
        if (id === undefined || id === options.moveTo) continue;
        for (const frame of model.groups.get(id) ?? []) operations.push({ op: 'section.set', id: frame.id, section: options.moveTo });
      }
    }
    operations.push({ op: 'outline.delete', index, ...(options.subtree === true ? { subtree: true } : {}) });
    const result = this.apply(operations, { quiet: true });
    if (result.ok) this.set({ sectionSelection: null });
    return result;
  }

  /** Gives every section that has none an id (its printed number, else the number in its title): exercises are filed by id. */
  giveSectionIds(): ApplyResult {
    return this.apply([...this.adoptFirst(), { op: 'outline.ids' }], { quiet: true });
  }

  /** Makes the PDF's own bookmarks the sections (with ids), the usual start of an audit. */
  adoptPdfOutline(): ApplyResult {
    const outline = this.state.doc?.pdfOutline;
    if (!outline || outline.length === 0) return fail('The PDF has no bookmarks.');
    return this.apply([{ op: 'outline.set', entries: outline, source: 'pdf' }, { op: 'outline.ids' }], { quiet: true });
  }

  /** The next click on the page sets where this section's heading is (its page and its position from the top). */
  pickHeading(index: number | null): void {
    this.set({ picking: index, tool: 'select', draft: null });
  }

  /** The person clicked the page while picking a heading: the section now starts there. */
  pickHeadingAt(page: number, top: number): ApplyResult {
    const index = this.state.picking;
    if (index === null) return fail('No section is waiting for a heading.');
    const result = this.updateSection(index, { page, top: Math.round(top * 10000) / 10000 });
    if (!result.ok) this.notify('error', result.error ?? 'The heading could not be set.');
    this.set({ picking: null });
    return result;
  }

  // --------------------------------------------------------------------------------------------------- the document

  openInfo(): void {
    this.set({ infoOpen: true });
  }

  closeInfo(): void {
    this.set({ infoOpen: false });
  }

  /** Changes what the bundle says about the work: title, folder, author, series, description, licence, source, notice. */
  setMeta(patch: Extract<Operation, { op: 'meta.set' }>): ApplyResult {
    const { op: _op, ...fields } = patch;
    return this.apply([{ op: 'meta.set', ...fields }], { quiet: true });
  }

  // ------------------------------------------------------------------------------------------- long jobs and derive

  /** Starts a long job; null (with a notice) while another one is running. The token ends it again. */
  private beginAudit(job: AuditJob): number | null {
    if (this.state.audit.job !== null) {
      this.notify('info', 'A search is still running: wait for it, or stop it first.');
      return null;
    }
    this.auditSeq += 1;
    this.progress.set(null);
    this.set({ audit: { job, stopping: false } });
    return this.auditSeq;
  }

  /** The job is over (done, stopped or failed): the bar goes, with the patch to the state that goes with it. */
  private finishAudit(token: number, patch: Partial<State> = {}): void {
    if (token !== this.auditSeq) return;
    this.progress.set(null);
    this.set({ ...patch, audit: { job: null, stopping: false } });
  }

  /** The main process reports how far the long job is. */
  reportProgress(progress: AuditProgress): void {
    if (this.state.audit.job !== null) this.progress.set(progress);
  }

  /** Asks the long job to stop; it does so at the next page. Nothing is changed by a job that was stopped. */
  cancelAudit(): void {
    const { audit } = this.state;
    if (audit.job === null || audit.stopping) return;
    this.set({ audit: { ...audit, stopping: true } });
    void this.api.cancelAudit();
  }

  /** Finds the chapters and sections from what the book prints, then shows them for review: nothing is applied yet. */
  async deriveSections(): Promise<void> {
    const doc = this.state.doc;
    if (!doc) return;
    const token = this.beginAudit('sections');
    if (token === null) return;
    let outcome: AuditOutcome<BookStructure>;
    try {
      outcome = await this.api.deriveSections();
    } catch (error) {
      outcome = { ok: false, cancelled: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (this.state.doc !== doc) {
      // Another document was opened meanwhile: the answer is about the one that is gone.
      this.finishAudit(token);
      return;
    }
    if (!outcome.ok) {
      this.finishAudit(token);
      if (outcome.cancelled) this.notify('info', 'Stopped. Nothing was changed.');
      else this.notify('error', `The sections could not be derived: ${outcome.message}`);
      return;
    }
    const structure = outcome.result;
    const plan = compareOutline({ structure, entries: this.sections(), groups: this.book().groups });
    this.finishAudit(token, {
      tab: 'sections',
      derive: {
        structure,
        selected: Object.fromEntries([...defaultSelection(plan)].map((id) => [id, true as const])),
        keepOthers: false,
        moves: {},
        filter: plan.counts.new + plan.counts.changed > 0 ? 'changes' : 'all',
        focus: null,
        error: null,
      },
    });
  }

  /** The derived sections compared with the project's own (computed once while neither changes). */
  derivePlan(): DerivePlan | null {
    const review = this.state.derive;
    const project = this.state.project;
    if (!review || !project) return null;
    const entries = this.sections();
    const { groups } = this.book();
    const cached = this.planCache;
    if (cached && cached.structure === review.structure && cached.entries === entries && cached.groups === groups) return cached.plan;
    const plan = compareOutline({ structure: review.structure, entries, groups });
    this.planCache = { structure: review.structure, entries, groups, plan };
    return plan;
  }

  /** What applying the derived sections would do with the choices made so far. */
  deriveOutcome(): DeriveOutcome | null {
    const review = this.state.derive;
    const plan = this.derivePlan();
    if (!review || !plan) return null;
    const cached = this.outcomeCache;
    if (cached && cached.review === review && cached.plan === plan) return cached.outcome;
    const outcome = resolveDerive({ structure: review.structure, entries: this.sections(), groups: this.book().groups }, plan, { selected: new Set(Object.keys(review.selected)), keepOthers: review.keepOthers, moves: review.moves });
    this.outcomeCache = { review, plan, outcome };
    return outcome;
  }

  private reviewing(patch: (review: DeriveReview) => Partial<DeriveReview>): void {
    const review = this.state.derive;
    if (review) this.set({ derive: { ...review, error: null, ...patch(review) } });
  }

  setDerived(id: string, on: boolean): void {
    this.reviewing((review) => {
      const selected = { ...review.selected };
      if (on) selected[id] = true;
      else delete selected[id];
      return { selected };
    });
  }

  /** Takes all derived entries, none, the new ones, or the new and the changed ones. */
  selectDerived(which: 'all' | 'none' | 'new' | 'changes'): void {
    const plan = this.derivePlan();
    if (!plan) return;
    const rows = which === 'none' ? [] : which === 'all' ? plan.rows : plan.rows.filter((row) => (which === 'new' ? row.status === 'new' : row.status !== 'same'));
    this.reviewing(() => ({ selected: Object.fromEntries(rows.map((row) => [row.entry.id, true as const])) }));
  }

  setDeriveFilter(filter: DeriveFilter): void {
    this.reviewing(() => ({ filter }));
  }

  setKeepOthers(keepOthers: boolean): void {
    this.reviewing(() => ({ keepOthers }));
  }

  /** Shows the evidence for a derived entry and its heading on the page. */
  focusDerived(id: string | null): void {
    this.reviewing(() => ({ focus: id }));
    const row = id === null ? undefined : this.derivePlan()?.rows.find((entry) => entry.entry.id === id);
    if (row) this.showPlace(row.entry.page, row.entry.top);
  }

  /** The exercises of a section of the project move to this derived section when the sections are applied (null: they stay where they are, and so does the section). */
  moveSectionTo(id: string, target: string | null): void {
    this.reviewing((review) => {
      const moves = { ...review.moves };
      const selected = { ...review.selected };
      if (target === null) delete moves[id];
      else {
        moves[id] = target;
        selected[target] = true; // the target must be among the sections the project gets
      }
      return { moves, selected };
    });
  }

  /** For every section of the project with exercises that looks like a derived one (same printed number or title): move its exercises there. */
  moveToSuggested(): void {
    const plan = this.derivePlan();
    if (!plan) return;
    this.reviewing((review) => {
      const moves = { ...review.moves };
      const selected = { ...review.selected };
      for (const row of plan.yours) {
        if (row.exercises === 0 || row.entry.id === undefined || row.suggested === undefined) continue;
        moves[row.entry.id] = row.suggested;
        selected[row.suggested] = true;
      }
      return { moves, selected };
    });
  }

  discardDerive(): void {
    this.set({ derive: null });
  }

  /** Takes the sections: all of them, or the ones that are selected. One undoable step; the exercises keep a section that exists. */
  applyDerive(which: 'all' | 'selected'): ApplyResult {
    if (which === 'all') this.selectDerived('all');
    const review = this.state.derive;
    const outcome = this.deriveOutcome();
    if (!review || !outcome) return fail('There are no derived sections to take.');
    if (outcome.nothing) {
      this.reviewing(() => ({ error: 'Nothing would change: the sections of the book already are these.' }));
      return fail('Nothing would change.');
    }
    const result = this.setOutline(outcome.entries, 'derived', { moves: outcome.moves, quiet: true });
    if (!result.ok) {
      this.reviewing(() => ({ error: result.error ?? 'The sections could not be applied.' }));
      return result;
    }
    this.set({ derive: null, sectionSelection: null });
    this.notify('success', describeOutcome(outcome));
    return result;
  }

  // ----------------------------------------------------------------------------- exercises and answers of a book

  setProposeMode(proposeMode: ProposeMode): void {
    this.set({ proposeMode });
  }

  setBookScope(bookScope: string): void {
    this.set({ bookScope });
  }

  /**
   * Looks in the book for its numbered exercises (the sections in `scope`, "all" by default) or for the answers of the
   * exercises it has. The sections and exercises are the window's own, saved or not. The result is shown for review: nothing is applied.
   */
  async proposeBook(kind: BookKind, options: { scope?: string } = {}): Promise<void> {
    const { project, doc } = this.state;
    if (!project || !doc) return;
    const scope = options.scope ?? this.state.bookScope;
    const outline = [...(project.outline?.entries ?? [])];
    const request: BookRequest = kind === 'exercises' ? { kind, outline, ...(scope !== 'all' ? { sections: [scope] } : {}) } : { kind, outline, exercises: exerciseRefs(project.frames) };
    const token = this.beginAudit(kind);
    if (token === null) return;
    this.set({ proposeMode: kind, tab: 'propose', bookMessage: null, ...(options.scope !== undefined ? { bookScope: options.scope } : {}) });
    let outcome: AuditOutcome<BookResult>;
    try {
      outcome = await this.api.proposeBook(request);
    } catch (error) {
      outcome = { ok: false, cancelled: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (this.state.doc !== doc) {
      this.finishAudit(token);
      return;
    }
    if (!outcome.ok) {
      this.finishAudit(token, outcome.cancelled ? {} : { bookMessage: { kind, text: outcome.message } });
      if (outcome.cancelled) this.notify('info', 'Stopped. Nothing was changed.');
      return;
    }
    const model = bookRows(outcome.result, this.state.project?.frames ?? project.frames);
    const review: BookReview = {
      kind,
      result: outcome.result,
      ticked: defaultTicks(model.rows),
      rejected: {},
      filter: model.counts.new + model.counts.different > 0 ? 'todo' : 'all',
      confidence: 'any',
      focus: null,
      summary: null,
      error: null,
    };
    this.finishAudit(token, { book: { ...this.state.book, [kind]: review } });
  }

  bookReview(kind: BookKind): BookReview | null {
    return this.state.book[kind];
  }

  /** The proposals of a search against the project as it is now (built once for a result and a version of the frames). */
  bookModel(kind: BookKind): BookRows | null {
    const review = this.state.book[kind];
    const project = this.state.project;
    return review && project ? bookRows(review.result, project.frames) : null;
  }

  /** The rows the list shows for the filters (the ghosts on the page are these too); the same array until something changes. */
  bookListed(kind: BookKind): BookRow[] {
    const review = this.state.book[kind];
    const model = this.bookModel(kind);
    if (!review || !model) return [];
    const cached = this.listCache[kind];
    if (cached && cached.review.filter === review.filter && cached.review.confidence === review.confidence && cached.review.rejected === review.rejected && cached.model === model) return cached.list;
    const list = viewRows(model.rows, { filter: review.filter, confidence: review.confidence, rejected: review.rejected });
    this.listCache[kind] = { review, model, list };
    return list;
  }

  private editBook(kind: BookKind, patch: (review: BookReview) => Partial<BookReview>): void {
    const review = this.state.book[kind];
    if (review) this.set({ book: { ...this.state.book, [kind]: { ...review, error: null, ...patch(review) } } });
  }

  tickBook(kind: BookKind, key: string, on: boolean): void {
    this.editBook(kind, (review) => {
      const ticked = { ...review.ticked };
      if (on) ticked[key] = true;
      else delete ticked[key];
      return { ticked };
    });
  }

  /** Ticks (or unticks) every row that can be applied among these (the ones the list shows). */
  tickRows(kind: BookKind, rows: readonly BookRow[], on: boolean): void {
    this.editBook(kind, (review) => {
      const ticked = { ...review.ticked };
      for (const row of rows) {
        if (row.state === 'same' || row.refusal !== undefined) continue;
        if (on) ticked[row.key] = true;
        else delete ticked[row.key];
      }
      return { ticked };
    });
  }

  /** Dismisses a proposal (it is never applied and leaves the list), or takes the dismissal back. */
  rejectBook(kind: BookKind, key: string, on: boolean): void {
    this.editBook(kind, (review) => {
      const rejected = { ...review.rejected };
      if (on) rejected[key] = true;
      else delete rejected[key];
      const ticked = { ...review.ticked };
      if (on) delete ticked[key];
      return { rejected, ticked, ...(on && review.focus === key ? { focus: null } : {}) };
    });
  }

  setBookFilter(kind: BookKind, filter: BookFilter): void {
    this.editBook(kind, () => ({ filter }));
  }

  setBookConfidence(kind: BookKind, confidence: ConfidenceFilter): void {
    this.editBook(kind, () => ({ confidence }));
  }

  /** Shows the evidence for a proposal and goes to it on its page. */
  focusBook(kind: BookKind, key: string | null): void {
    this.editBook(kind, () => ({ focus: key }));
    const row = key === null ? undefined : this.bookModel(kind)?.byKey.get(key);
    if (!row) return;
    this.set({ focus: { tick: this.state.focus.tick + 1, ghost: `book:${row.key}` } });
    this.setPage(row.page);
  }

  discardBook(kind: BookKind): void {
    this.set({ book: { ...this.state.book, [kind]: null } });
  }

  /** The keys "Apply all" takes among the rows the list shows: the new ones, and the different ones the person ticked (to replace). */
  applicableKeys(kind: BookKind, listed: readonly BookRow[], which: 'selected' | 'all'): string[] {
    const review = this.state.book[kind];
    if (!review) return [];
    return listed
      .filter((row) => row.refusal === undefined && row.state !== 'same' && (which === 'selected' ? review.ticked[row.key] === true : row.state === 'new' || review.ticked[row.key] === true))
      .map((row) => row.key);
  }

  /**
   * Applies these proposals as one atomic, undoable batch (the operations the command line writes for the same
   * proposals). A new exercise is added, a different one replaces the project's, an answer is given or replaced. Refused as a whole
   * when it would introduce an error.
   */
  applyBook(kind: BookKind, keys: readonly string[]): ApplyResult {
    const review = this.state.book[kind];
    const model = this.bookModel(kind);
    if (!review || !model) return fail('There is nothing to apply.');
    const plan = planBook(kind, model.rows, new Set(keys));
    if (plan.operations.length === 0) {
      const error = plan.refused.length > 0 ? `Nothing can be applied: ${plan.refused[0]?.refusal as string}.` : keys.length === 0 ? 'Nothing is selected.' : 'Nothing to apply: the book has these already.';
      this.editBook(kind, () => ({ error }));
      return fail(error);
    }
    const result = this.apply(plan.operations, { quiet: true, select: null });
    if (!result.ok) {
      this.editBook(kind, () => ({ error: result.error ?? 'The proposals could not be applied.' }));
      return result;
    }
    const summary = describePlan(kind, plan);
    const applied = new Set(model.rows.filter((row) => keys.includes(row.key) && row.refusal === undefined && row.state !== 'same').map((row) => row.key));
    this.editBook(kind, (current) => ({ summary, ticked: Object.fromEntries(Object.keys(current.ticked).filter((key) => !applied.has(key)).map((key) => [key, true as const])) }));
    this.notify('success', summary);
    return result;
  }

  // ------------------------------------------------------------------------------------------------------ contents

  /**
   * Makes these entries the project's sections (every entry replaced). `moves` file exercises under another section in the same
   * step, before the old sections go: the exercises of a section the new list no longer has must go somewhere, or the change is refused.
   */
  setOutline(entries: OutlineEntry[], source: 'manual' | 'derived' | 'pdf' = 'manual', options: { moves?: readonly { id: string; section: string }[]; quiet?: boolean } = {}): ApplyResult {
    const moves: Operation[] = (options.moves ?? []).map(({ id, section }) => ({ op: 'section.set', id, section }));
    return this.apply([...moves, { op: 'outline.set', entries, source }], options.quiet === true ? { quiet: true, select: null } : {});
  }

  clearOutline(): void {
    this.apply([{ op: 'outline.clear' }]);
  }

  // -------------------------------------------------------------------------------------------------------- export

  openExport(): void {
    const { project, doc } = this.state;
    const book = project !== null && project.frames.some(isAuthoritative);
    this.set({
      exporting: {
        open: true,
        busy: false,
        outline: book || project?.outline ? 'project' : doc?.pdfOutline ? 'pdf' : 'none',
        outcome: null,
        copiedTo: null,
        summary: null,
        summaryBusy: false,
      },
    });
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

  /** Writes the plain JSON summary of the book (sections with their exercise counts), as `mcprep book export` does. */
  async exportBookSummary(): Promise<void> {
    this.set({ exporting: { ...this.state.exporting, summaryBusy: true, summary: null } });
    if (this.state.dirty && !(await this.save())) {
      this.set({ exporting: { ...this.state.exporting, summaryBusy: false, summary: { ok: false, message: 'The project could not be saved first, so nothing was written.' } } });
      return;
    }
    try {
      const summary = await this.api.exportBookSummary();
      this.set({ exporting: { ...this.state.exporting, summaryBusy: false, summary } });
    } catch (error) {
      this.set({ exporting: { ...this.state.exporting, summaryBusy: false, summary: { ok: false, message: error instanceof Error ? error.message : String(error) } } });
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

/** The message of a validation error that a change would introduce, in the window's words. */
function plainIssueMessage(issue: Issue): string {
  switch (issue.code) {
    case 'duplicate-exercise':
      return `Section ${String(issue.data?.['section'] ?? '?')} would have two exercises numbered ${String(issue.data?.['label'] ?? '?')}. Each printed number can be used once in a section.`;
    case 'section-unknown':
      return `The section "${String(issue.data?.['section'] ?? '?')}" does not exist.`;
    default:
      return `${issue.message}${issue.fix !== undefined && !/`|mcprep\b/.test(issue.fix) ? ` (${issue.fix})` : ''}`;
  }
}
