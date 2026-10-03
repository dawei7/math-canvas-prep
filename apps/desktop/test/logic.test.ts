import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfDocument, newProject, proposeFrames, type Frame, type PageText, type Project } from '@mcprep/core';
import type { Api, OpenedDocument, SaveOutcome } from '../src/shared/api.js';
import { describeChange, sectionCounts, summarizeChange } from '../src/renderer/logic/contents.js';
import { HANDLES, frameAtTap, fromScreen, handlePositions, middleCut, rectFromCorners, resizeRect, toScreen, unitArea } from '../src/renderer/logic/geometry.js';
import { Store, sameContent } from '../src/renderer/logic/store.js';

let sample: Uint8Array;
let texts: PageText[];

beforeAll(async () => {
  const built = await import('@mcprep/core/testing');
  sample = built.buildSampleSheet().pdf;
  const pdf = await PdfDocument.fromBytes(sample);
  texts = await pdf.allPageText({ fonts: true, ink: true });
  await pdf.close();
});

afterEach(() => {
  vi.useRealTimers();
});

const baseProject = (): Project => newProject({ pdf: { path: 'sheet.pdf', sha256: 'a'.repeat(64), bytes: 5446, pageCount: 3 }, title: 'Sheet', now: new Date('2026-10-03T12:00:00Z') });

function fakeApi(overrides: Partial<Api> = {}): Api & { saved: Project[] } {
  const saved: Project[] = [];
  const api: Api = {
    chooseAndOpenPdf: () => Promise.resolve(null),
    chooseAndOpenProject: () => Promise.resolve(null),
    openPath: () => Promise.resolve({ ok: false, message: 'no' }),
    pathForFile: () => '',
    recent: () => Promise.resolve([{ path: 'x.mcprep.json', title: 'X', openedAt: '2026-10-03T12:00:00Z' }]),
    readPdf: () => Promise.resolve(sample),
    pageText: (page) => Promise.resolve(texts[page] as PageText),
    propose: () => Promise.resolve(proposeFrames(texts)),
    deriveOutline: () => Promise.resolve([{ title: 'Calculus Sheet 1', page: 0, depth: 0, confidence: 0.9, evidence: ['large'] }]),
    saveProject: (project, expected) => {
      saved.push(project);
      const written: Project = { ...project, revision: expected + 1, updatedAt: '2026-10-03T13:00:00Z', modifiedBy: 'desktop' };
      return Promise.resolve<SaveOutcome>({ ok: true, project: written });
    },
    reloadProject: () => Promise.resolve(baseProject()),
    exportBundle: () => Promise.resolve({ ok: true, path: 'C:/out/sheet.mcbundle', bytes: 100, frames: 3, outlineEntries: 0, issues: [] }),
    copyToFolder: () => Promise.resolve('D:/tablet/sheet.mcbundle'),
    reveal: () => Promise.resolve(),
    onDiskChange: () => () => undefined,
    onMenu: () => () => undefined,
    setDirty: () => undefined,
    ready: () => undefined,
    ...overrides,
  };
  return Object.assign(api, { saved });
}

function opened(project: Project = baseProject()): OpenedDocument {
  return {
    projectPath: 'C:/work/sheet.mcprep.json',
    pdfPath: 'C:/work/sheet.pdf',
    project,
    pageSizes: [0, 1, 2].map(() => ({ width: 595, height: 842, rotation: 0 })),
    pdfOutline: [{ title: 'Differentiation', page: 0, depth: 0 }],
  };
}

async function started(api = fakeApi()): Promise<{ store: Store; api: ReturnType<typeof fakeApi> }> {
  const store = new Store(api);
  await store.openDocument(opened());
  return { store, api };
}

const exercise = (rect: [number, number, number, number], page = 0) => ({ op: 'add' as const, kind: 'exercise' as const, page, rect });

describe('geometry', () => {
  const box = { width: 800, height: 1000 };

  it('converts between page fractions and pixels', () => {
    const screen = toScreen({ left: 0.1, top: 0.2, right: 0.5, bottom: 0.3 }, box);
    expect([screen.x, screen.y, screen.w, screen.h].map(Math.round)).toEqual([80, 200, 320, 100]);
    const back = fromScreen(80, 200, box);
    expect(back.x).toBeCloseTo(0.1);
    expect(back.y).toBeCloseTo(0.2);
  });

  it('puts the resize handles outside the outline, all around', () => {
    const rect = { left: 0.2, top: 0.3, right: 0.6, bottom: 0.5 };
    const positions = handlePositions(rect, box, 9);
    expect(Object.keys(positions).sort()).toEqual([...HANDLES].sort());
    expect(positions.nw).toEqual({ x: 160 - 9, y: 300 - 9 });
    expect(positions.e.x).toBe(480 + 9);
    expect(positions.s.y).toBe(500 + 9);
    expect(positions.n.x).toBe(320);
  });

  it('resizes by a handle, keeping the minimum size and the page', () => {
    const rect = { left: 0.2, top: 0.3, right: 0.6, bottom: 0.5 };
    expect(resizeRect(rect, 'se', 0.1, 0.1)).toEqual({ left: 0.2, top: 0.3, right: 0.7, bottom: 0.6 });
    expect(resizeRect(rect, 'w', -0.1, 0.5)).toEqual({ left: 0.1, top: 0.3, right: 0.6, bottom: 0.5 });
    const squeezed = resizeRect(rect, 'n', 0, 0.5);
    expect(squeezed.bottom - squeezed.top).toBeGreaterThanOrEqual(0.01);
    expect(squeezed.bottom).toBe(0.5);
    const off = resizeRect(rect, 'ne', 5, -5);
    expect(off.right).toBe(1);
    expect(off.top).toBe(0);
    expect(rectFromCorners(0.5, 0.6, 0.2, 0.1)).toEqual({ left: 0.2, top: 0.1, right: 0.5, bottom: 0.6 });
  });

  it('makes a one-line frame from a tap on a line, as wide as the text block, and a default frame elsewhere', () => {
    const page = texts[0] as PageText;
    const line = page.lines.find((entry) => entry.text.startsWith('Exercise 1.')) as PageText['lines'][number];
    const frame = frameAtTap(page, (line.rect.left + line.rect.right) / 2, (line.rect.top + line.rect.bottom) / 2);
    expect(frame.top).toBeCloseTo(line.rect.top - 0.006, 4);
    expect(frame.bottom).toBeCloseTo(line.rect.bottom + 0.004, 4);
    expect(frame.left).toBeLessThan(line.rect.left);
    expect(frame.right).toBeGreaterThan(line.rect.right);
    // Not at the centre of the line: near its left end, and just past its end but inside the text block.
    for (const x of [line.rect.left + 0.01, line.rect.right + 0.01]) {
      const near = frameAtTap(page, x, line.rect.top + 0.003);
      expect(near.top).toBeCloseTo(line.rect.top - 0.006, 4);
    }
    const blank = frameAtTap(page, 0.5, 0.7);
    expect(blank.right - blank.left).toBeCloseTo(0.8, 2);
    expect(blank.bottom - blank.top).toBeCloseTo(0.04, 3);
    const header = frameAtTap(page, 0.2, 0.04);
    expect(header.bottom - header.top).toBeCloseTo(0.04, 3);
    expect(frameAtTap(undefined, 0.5, 0.5).bottom).toBeGreaterThan(0.5);
  });

  it('measures the area of a unit and finds a cut for new parts', () => {
    const frames: Frame[] = [
      { id: 'a', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 }, unit: 'u' },
      { id: 'b', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.5 }, unit: 'u' },
    ];
    expect(unitArea(frames, frames[1] as Frame)).toEqual({ left: 0.1, top: 0.2, right: 0.9, bottom: 0.5 });
    const cut = middleCut({ left: 0.1, top: 0.3, right: 0.9, bottom: 0.4 }, texts[0]);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toBeGreaterThan(0.3);
    expect(cut[0]).toBeLessThan(0.4);
  });
});

describe('contents', () => {
  it('counts the frames of each section, an exercise with parts once', () => {
    const frames: Frame[] = [
      { id: 'a', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } },
      { id: 'b', kind: 'exercise', page: 1, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 }, unit: 'u' },
      { id: 'c', kind: 'exercise', page: 1, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.4 }, unit: 'u' },
      { id: 'd', kind: 'bookmark', page: 2, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } },
    ];
    const sections = sectionCounts(
      [
        { title: 'One', page: 0, depth: 0 },
        { title: 'One.A', page: 1, depth: 1 },
        { title: 'Two', page: 2, depth: 0 },
      ],
      frames,
      3,
    );
    expect(sections.map((section) => [section.from, section.to, section.counts.exercise, section.counts.bookmark])).toEqual([
      [0, 1, 2, 0],
      [1, 1, 1, 0],
      [2, 2, 0, 1],
    ]);
  });

  it('summarises what another program changed', () => {
    const before = baseProject();
    const frame: Frame = { id: 'f1', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } };
    const after: Project = { ...before, frames: [frame, { ...frame, id: 'f2', page: 1 }], outline: { source: 'derived', entries: [] }, meta: { title: 'New' } };
    const summary = summarizeChange({ ...before, frames: [frame, { ...frame, id: 'f3' }] }, after);
    expect(summary).toMatchObject({ added: ['f2'], removed: ['f3'], changed: [], outline: true, meta: true });
    expect(describeChange(summary)).toBe('1 added, 1 removed, contents changed, title or folder changed');
    expect(describeChange(summarizeChange(before, before))).toBe('no visible change');
    expect(sameContent(before, { ...before, revision: 9 })).toBe(true);
  });
});

describe('the store: editing', () => {
  it('opens a document, loads the text of the first page and validates', async () => {
    const { store } = await started();
    expect(store.state.doc?.pageSizes).toHaveLength(3);
    expect(store.state.texts[0]?.hasText).toBe(true);
    expect(store.state.validation?.ok).toBe(true);
    expect(store.state.dirty).toBe(false);
    await store.loadRecent();
    expect(store.state.recent).toHaveLength(1);
  });

  it('applies operations as undoable steps, tracks what is unsaved and selects what was created', async () => {
    const { store } = await started();
    const done = store.apply([exercise([0.1, 0.22, 0.9, 0.29])], { select: 'created' });
    expect(done).toMatchObject({ ok: true, created: ['f1'] });
    expect(store.state.selection).toBe('f1');
    expect(store.state.dirty).toBe(true);
    expect(store.state.past).toHaveLength(1);
    store.apply([{ op: 'move', id: 'f1', dx: 0, dy: 0.1 }]);
    expect(store.state.project?.frames[0]?.rect.top).toBeCloseTo(0.32);
    store.undo();
    expect(store.state.project?.frames[0]?.rect.top).toBeCloseTo(0.22);
    store.undo();
    expect(store.state.project?.frames).toHaveLength(0);
    expect(store.state.dirty).toBe(false);
    expect(store.state.selection).toBeNull();
    store.redo();
    expect(store.state.project?.frames).toHaveLength(1);
    expect(store.state.dirty).toBe(true);
    store.redo();
    store.redo();
    expect(store.state.future).toHaveLength(0);
  });

  it('refuses a change that does not apply or that would introduce errors, and says why', async () => {
    const { store } = await started();
    expect(store.apply([exercise([0.1, 0.2, 0.9, 0.3], 9)]).ok).toBe(false);
    expect(store.state.notice).toMatchObject({ kind: 'error' });
    expect(store.state.notice?.text).toContain('does not exist');
    expect(store.state.project?.frames).toHaveLength(0);
    store.dismissNotice();
    expect(store.state.notice).toBeNull();
    const gap = store.apply([
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.3], unit: 'u1' },
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.4, 0.9, 0.5], unit: 'u1' },
    ]);
    expect(gap.ok).toBe(false);
    expect(store.state.notice?.text).toContain('gap');
  });

  it('snaps with the text it has loaded, and cuts parts', async () => {
    const { store } = await started();
    const line = (texts[0] as PageText).lines.find((entry) => entry.text.startsWith('Exercise 1.')) as PageText['lines'][number];
    store.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, line.rect.top + 0.004, 0.9, 0.29], snap: true }], { select: 'created' });
    expect(store.state.project?.frames[0]?.rect.top).toBeCloseTo(line.rect.top - 0.006, 3);
    store.apply([{ op: 'split', id: 'f1', at: [0.25] }], { select: 'f1' });
    expect(store.state.project?.frames.filter((frame) => frame.unit !== undefined)).toHaveLength(2);
    expect(store.state.validation?.counts.exercise).toBe(1);
  });

  it('keeps the page and the zoom inside their limits and loads text on demand', async () => {
    const { store, api } = await started();
    const spy = vi.spyOn(api, 'pageText');
    store.setPage(7);
    expect(store.state.page).toBe(2);
    store.setPage(-3);
    expect(store.state.page).toBe(0);
    store.setPage(1);
    await vi.waitFor(() => expect(store.state.texts[1]).toBeDefined());
    expect(spy).toHaveBeenCalledWith(1);
    store.setZoom(9);
    expect(store.state.zoom).toBe(4);
    store.setZoom(0);
    expect(store.state.zoom).toBe(0);
    store.setZoom(0.01);
    expect(store.state.zoom).toBe(0.25);
  });
});

describe('the store: saving, agents and conflicts', () => {
  it('saves with the revision it knows and shows the file as saved', async () => {
    const { store, api } = await started();
    store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    expect(await store.save()).toBe(true);
    expect(api.saved).toHaveLength(1);
    expect(store.state.dirty).toBe(false);
    expect(store.state.base?.revision).toBe(1);
    expect(store.state.project?.revision).toBe(1);
  });

  it('shows a visible error when saving fails and stays dirty', async () => {
    const { store } = await started(fakeApi({ saveProject: () => Promise.resolve({ ok: false, code: 'error', message: 'disk full' }) }));
    store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    expect(await store.save()).toBe(false);
    expect(store.state.saveError).toBe('disk full');
    expect(store.state.notice).toMatchObject({ kind: 'error' });
    expect(store.state.dirty).toBe(true);
  });

  it('autosaves after a pause when asked to', async () => {
    vi.useFakeTimers();
    const { store, api } = await started();
    store.setAutosave(true);
    store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    expect(api.saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1300);
    expect(api.saved).toHaveLength(1);
    expect(store.state.dirty).toBe(false);
  });

  it('takes over a change made on disk quietly when there is nothing unsaved, and says who made it', async () => {
    const { store } = await started();
    const onDisk: Project = { ...baseProject(), revision: 5, modifiedBy: 'cli', frames: [{ id: 'f1', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } }] };
    store.select('f1');
    store.onDiskChange({ project: onDisk, modifiedBy: 'cli' });
    expect(store.state.project?.frames).toHaveLength(1);
    expect(store.state.base?.revision).toBe(5);
    expect(store.state.selection).toBe('f1');
    expect(store.state.notice).toMatchObject({ kind: 'agent' });
    expect(store.state.notice?.text).toContain('Updated by cli: 1 added');
    expect(store.state.agentAt).toBeGreaterThan(0);
    expect(store.state.past).toHaveLength(0);
  });

  it('asks which version to keep when there are unsaved edits, and does as told', async () => {
    const mine = await started();
    mine.store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    const theirs: Project = { ...baseProject(), revision: 3, modifiedBy: 'mcp', frames: [{ id: 'g1', kind: 'bookmark', page: 1, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } }] };
    mine.store.onDiskChange({ project: theirs, modifiedBy: 'mcp' });
    expect(mine.store.state.conflict?.by).toBe('mcp');
    expect(mine.store.state.project?.frames[0]?.id).toBe('f1');
    expect(await mine.store.save()).toBe(false);
    mine.store.resolveConflict('mine');
    expect(mine.store.state.conflict).toBeNull();
    expect(mine.store.state.base?.revision).toBe(3);
    expect(mine.store.state.dirty).toBe(true);
    expect(await mine.store.save()).toBe(true);
    expect(mine.api.saved[0]?.frames[0]?.id).toBe('f1');

    const other = await started();
    other.store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    other.store.onDiskChange({ project: theirs, modifiedBy: 'mcp' });
    other.store.resolveConflict('theirs');
    expect(other.store.state.project?.frames[0]?.id).toBe('g1');
    expect(other.store.state.dirty).toBe(false);
    expect(other.store.state.past).toHaveLength(0);
  });

  it('turns a save conflict reported by the main process into the same question', async () => {
    const onDisk: Project = { ...baseProject(), revision: 8, modifiedBy: 'cli' };
    const { store } = await started(fakeApi({ saveProject: () => Promise.resolve({ ok: false, code: 'conflict', message: 'changed', onDisk }) }));
    store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    expect(await store.save()).toBe(false);
    expect(store.state.conflict).toMatchObject({ by: 'cli' });
  });
});

describe('the store: proposals, contents and export', () => {
  it('shows proposals as pending, accepts one with its context and statement, rejects another', async () => {
    const { store } = await started();
    await store.runPropose();
    expect(store.state.proposals?.proposals).toHaveLength(7);
    expect(store.pendingProposals()).toHaveLength(7);
    store.acceptProposal('p2');
    expect(store.state.decided['p2']).toBe('accepted');
    expect(store.state.project?.frames.filter((frame) => frame.unit !== undefined)).toHaveLength(3);
    store.acceptProposal('p3');
    expect(store.state.project?.frames.find((frame) => frame.page === 1 && (frame.context?.length ?? 0) > 0)).toBeDefined();
    store.rejectProposal('p5');
    expect(store.pendingProposals().map((proposal) => proposal.id)).toEqual(['p1', 'p4', 'p6', 'p7']);
    store.acceptAll();
    expect(store.pendingProposals()).toHaveLength(0);
    expect(store.state.validation?.counts).toMatchObject({ exercise: 5, bookmark: 1 });
    expect(store.state.validation?.errors).toEqual([]);
    store.undo();
    expect(store.state.validation?.counts.exercise).toBe(2);
  });

  it('rejects all pending proposals at once', async () => {
    const { store } = await started();
    await store.runPropose();
    store.rejectAll();
    expect(store.pendingProposals()).toHaveLength(0);
    expect(store.state.project?.frames).toHaveLength(0);
  });

  it('derives headings, stores a hand-edited outline and clears it again', async () => {
    const { store } = await started();
    await store.deriveContents();
    expect(store.state.derived?.[0]?.title).toBe('Calculus Sheet 1');
    store.setOutline([{ title: ' 1 Sets ', page: 0, depth: 0 }, { title: '1.1 Sub', page: 1, depth: 1 }], 'derived');
    expect(store.state.project?.outline).toEqual({ source: 'derived', entries: [{ title: '1 Sets', page: 0, depth: 0 }, { title: '1.1 Sub', page: 1, depth: 1 }] });
    store.clearOutline();
    expect(store.state.project?.outline).toBeUndefined();
  });

  it('saves first when exporting, shows the outcome and copies to a folder', async () => {
    const { store, api } = await started();
    store.apply([exercise([0.1, 0.22, 0.9, 0.29])]);
    store.openExport();
    expect(store.state.exporting).toMatchObject({ open: true, outline: 'pdf' });
    store.setExportOutline('none');
    await store.runExport();
    expect(api.saved).toHaveLength(1);
    expect(store.state.exporting.outcome).toMatchObject({ ok: true, path: 'C:/out/sheet.mcbundle' });
    await store.copyExport();
    expect(store.state.exporting.copiedTo).toBe('D:/tablet/sheet.mcbundle');
    store.closeExport();
    expect(store.state.exporting.open).toBe(false);
  });

  it('shows an export failure with its reasons', async () => {
    const { store } = await started(fakeApi({ exportBundle: () => Promise.resolve({ ok: false, code: 'E_VALIDATION', message: 'The project has 1 error.', issues: [{ severity: 'error', code: 'page-out-of-range', message: 'x', frameId: 'f9' }] }) }));
    await store.runExport();
    expect(store.state.exporting.outcome).toMatchObject({ ok: false, code: 'E_VALIDATION' });
  });
});
