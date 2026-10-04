import { beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, validateProject, type Frame, type Project } from '@mcprep/core';
import { FRAME_ROW_HEIGHT, buildFrameRows, visibleRange } from '../src/renderer/logic/list.js';
import { placeChips } from '../src/renderer/logic/labels.js';
import { bookModel, frameIndex, pageContent } from '../src/renderer/logic/model.js';
import { bookRows, defaultTicks, ghostsOn, planBook, viewRows } from '../src/renderer/logic/proposals.js';
import { buildSectionRows, sectionWarnings } from '../src/renderer/logic/sections.js';
import { Store } from '../src/renderer/logic/store.js';
import { bookResultsOf, buildBigBook, type BigBook } from './helpers/big-book.js';
import { fakeApi, openedDocument } from './helpers/fake-api.js';

/**
 * A book of the size the owner has in mind: 5 000 book exercises, 100 sections, 44 small frames on a two-column page, an
 * answer key with 5 000 solution regions. Everything the editor computes for the lists and the page must take a few
 * milliseconds, and must grow in step with the book (an accidental quadratic loop shows in the last tests). The numbers
 * below are generous (a slow machine, a busy build) and still far below what a person notices.
 */

let big: BigBook;
let small: BigBook;

const timed = <T>(work: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
};

/**
 * A fixed piece of work of the kind the editor does (objects, a map, a sort, JSON), the best of five runs: how slow this machine is
 * right now, with this version of Node. In the test runner, on the machine the limits were written on, it takes about 42 ms (Node 20 and Node 26 alike).
 */
function calibration(): number {
  const work = (): number => {
    let total = 0;
    for (let round = 0; round < 4; round += 1) {
      const items = Array.from({ length: 12000 }, (_unused, at) => ({ id: `f${at}`, label: String((at * 7919) % 12011), page: at % 400, rect: { left: 0.1, top: (at % 50) / 60, right: 0.9, bottom: (at % 50) / 60 + 0.01 } }));
      const byLabel = new Map(items.map((item) => [item.label, item]));
      const sorted = [...items].sort((a, b) => Number(a.label) - Number(b.label) || a.id.localeCompare(b.id));
      total += byLabel.size + sorted.length + (JSON.parse(JSON.stringify(sorted.slice(0, 3000))) as unknown[]).length;
    }
    return total;
  };
  work();
  return Math.min(...Array.from({ length: 5 }, () => timed(work).ms));
}

const CALIBRATION_ON_THE_REFERENCE_MACHINE_MS = 42;
let SLOWNESS = 1;

/**
 * How much slower than the reference machine this one is (at least 1: a slow shared runner, an older Node), measured once when
 * the tests start (before any of them has run and left garbage behind), and doubled on a continuous-integration runner, where the
 * neighbours come and go while the tests run.
 */
beforeAll(() => {
  const measured = calibration();
  SLOWNESS = Math.max(1, measured / CALIBRATION_ON_THE_REFERENCE_MACHINE_MS) * (process.env['CI'] ? 2 : 1);
  console.info(`The time limits of the performance tests are multiplied by ${SLOWNESS.toFixed(1)} (calibration ${measured.toFixed(0)} ms, Node ${process.version}).`);
});

/**
 * A time limit in milliseconds, written for a fast machine, made to fit the machine the test runs on. The limits stay far below
 * what a regression costs: an accidental quadratic loop is ten to thirty times slower on every machine, not twice.
 */
const limit = (ms: number): number => ms * SLOWNESS;

/**
 * The best of seven runs, after one to warm up: on a busy machine (a build, a virus scan, other tests) single runs are noisy, the
 * best run is not. A function that is quadratic is slow in every run.
 */
const best = (work: () => unknown, runs = 7): number => {
  work();
  return Math.min(...Array.from({ length: runs }, () => timed(work).ms));
};

beforeAll(() => {
  big = buildBigBook();
  small = buildBigBook({ exercises: 500, sections: 11 });
}, 60_000);

const freshApi = (book: BigBook, overrides: Parameters<typeof fakeApi>[1] = {}): ReturnType<typeof fakeApi> => fakeApi({ pdf: () => book.pdf, texts: () => book.pageTexts, fresh: () => book.project }, overrides);

async function opened(book: BigBook = big): Promise<{ store: Store; api: ReturnType<typeof fakeApi> }> {
  const api = freshApi(book);
  const store = new Store(api);
  await store.openDocument({ ...openedDocument(book.project, book.pageCount, null), pageSizes: book.pageSizes });
  return { store, api };
}

describe('the synthetic big book', () => {
  it('is what it says: 5 000 book exercises in 100 sections, and a valid project', () => {
    expect(big.project.frames).toHaveLength(5000);
    expect(big.project.outline?.entries).toHaveLength(100);
    expect(big.practicePages).toBe(114);
    expect(big.pageCount).toBe(135);
    const validation = validateProject(big.project, new Map(big.pageTexts.map((text) => [text.page, text])));
    expect(validation.errors).toEqual([]);
    expect(validation.book).toEqual({ exercises: 5000, withSolution: 5000 });
    expect(validation.warnings.map((issue) => issue.code).filter((code) => code === 'section-mismatch' || code === 'clips-line')).toEqual([]);
  });

  it('has no warnings with the text read from its own PDF (so that what a test shows is what the editor adds)', async () => {
    const pdf = await PdfDocument.fromBytes(big.pdf);
    const texts = await pdf.allPageText({ fonts: false });
    await pdf.close();
    expect(texts).toHaveLength(135);
    const validation = validateProject(big.project, new Map(texts.map((text) => [text.page, text])));
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it('puts 44 small frames on a page, in two columns', () => {
    const index = frameIndex(big.project.frames);
    expect(pageContent(index, 10).frames).toHaveLength(44);
    const heights = pageContent(index, 10).frames.map((frame) => frame.rect.bottom - frame.rect.top);
    expect(Math.max(...heights)).toBeLessThan(0.04);
  });
});

describe('what the lists and the page compute for 5 000 frames', () => {
  it('builds the index of the frames, the sections and their counts once, and quickly', () => {
    expect(best(() => frameIndex([...big.project.frames]))).toBeLessThan(limit(400));
    expect(best(() => bookModel([...big.project.frames], big.project.outline?.entries, big.pageCount))).toBeLessThan(limit(400));
    const frames = [...big.project.frames];
    const index = frameIndex(frames);
    const model = bookModel(frames, big.project.outline?.entries, big.pageCount);
    expect(model.counts.totals).toEqual({ exercises: 5000, withSolution: 5000 });
    expect(model.groups.size).toBe(90);
    // The second time is a lookup: the very same objects, nothing computed again.
    expect(frameIndex(frames)).toBe(index);
    expect(bookModel(frames, big.project.outline?.entries, big.pageCount)).toBe(model);
  });

  it('lists the frames by section: a row for each frame and each section, in a few milliseconds', () => {
    const index = frameIndex(big.project.frames);
    const model = bookModel(big.project.frames, big.project.outline?.entries, big.pageCount);
    const all = buildFrameRows({ index, model, filter: 'all', query: '', collapsed: {} });
    expect(best(() => buildFrameRows({ index, model, filter: 'all', query: '', collapsed: {} }))).toBeLessThan(limit(250));
    expect(all.rows).toHaveLength(5000 + 90);
    expect(all.shown).toBe(5000);
    expect(all.rows[0]).toMatchObject({ type: 'group', title: '1.1 Practice set 1', count: 44 });
    expect(all.rows[1]).toMatchObject({ type: 'frame', label: '1', book: true });
    expect(buildFrameRows({ index, model, filter: 'ordinary', query: '', collapsed: {} }).rows).toHaveLength(0);
    // Folded groups keep their heading only; a query looks into folded groups too.
    const folded = Object.fromEntries([...model.groups.keys()].map((id) => [`sec:${id}`, true as const]));
    expect(buildFrameRows({ index, model, filter: 'all', query: '', collapsed: folded }).rows).toHaveLength(90);
    const found = buildFrameRows({ index, model, filter: 'all', query: '3.4:17', collapsed: folded });
    expect(found.rows.filter((row) => row.type === 'frame').map((row) => (row.type === 'frame' ? `${row.frame.section}:${row.label}` : ''))).toEqual(['3.4:17']);
    expect(best(() => buildFrameRows({ index, model, filter: 'book', query: '1', collapsed: {} }))).toBeLessThan(limit(250));
  });

  it('draws at most a screenful of rows, whatever the length of the list', () => {
    const range = visibleRange(0, 700, FRAME_ROW_HEIGHT, 5090);
    expect(range.end - range.first).toBeLessThan(30);
    const far = visibleRange(FRAME_ROW_HEIGHT * 3000, 700, FRAME_ROW_HEIGHT, 5090);
    expect(far.end - far.first).toBeLessThan(40);
    expect(far.first).toBeGreaterThan(2900);
  });

  it('lists the sections with their counts, and the warnings, in a few milliseconds', () => {
    const model = bookModel(big.project.frames, big.project.outline?.entries, big.pageCount);
    const rows = buildSectionRows(model, { collapsed: {}, filter: 'all' });
    expect(best(() => buildSectionRows(model, { collapsed: {}, filter: 'all' }))).toBeLessThan(limit(100));
    expect(rows).toHaveLength(100);
    // A section holds one or two pages of exercises (44 or 88); a chapter holds the nine sections below it.
    expect(rows[1]?.own).toBeGreaterThanOrEqual(44);
    expect(rows[1]?.total).toBe(rows[1]?.own);
    expect(rows[0]).toMatchObject({ own: 0, hasChildren: true });
    expect(rows[0]?.total).toBeGreaterThan(400);
    expect(buildSectionRows(model, { collapsed: { c1: true }, filter: 'all' }).length).toBeLessThan(100);
    expect(best(() => sectionWarnings(model))).toBeLessThan(limit(100));
    expect(sectionWarnings(model)).toMatchObject({ duplicateIds: [], withoutId: [], unplaced: [], unsolved: 0 });
  });

  it('places the labels of the 44 frames of a page beside them, readable and without piling up', () => {
    const index = frameIndex(big.project.frames);
    const frames = pageContent(index, 10).frames;
    const box = { width: 892, height: 1263 };
    const items = frames.map((frame) => ({ id: frame.id, label: frame.label as string, rect: frame.rect }));
    expect(best(() => placeChips(items, box))).toBeLessThan(limit(50));
    const chips = [...placeChips(items, box).values()];
    expect(chips).toHaveLength(44);
    expect(chips.every((chip) => chip.side === 'left')).toBe(true);
    expect(Math.min(...chips.map((chip) => chip.h))).toBeGreaterThanOrEqual(11);
    // The key page: 240 answers in four columns of 60 lines, labels of eleven pixels, each beside its answer.
    const key = pageContent(index, big.practicePages).solution;
    expect(key).toHaveLength(240);
    const keyBox = { width: 892, height: 1263 };
    const keyItems = key.map((region, at) => ({ id: String(at), label: `S ${region.frame.label}`, rect: region.rect }));
    expect(best(() => placeChips(keyItems, keyBox))).toBeLessThan(limit(400));
    expect(placeChips(keyItems, keyBox).size).toBe(240);
  });
});

describe('the store with 5 000 frames', () => {
  it('opens the project, with its checks, in well under a second (the text of the pages follows in the background)', async () => {
    const api = freshApi(big);
    const store = new Store(api);
    const started = performance.now();
    await store.openDocument({ ...openedDocument(big.project, big.pageCount, null), pageSizes: big.pageSizes });
    expect(performance.now() - started).toBeLessThan(limit(4000));
    expect(store.state.validation?.ok).toBe(true);
    expect(store.state.texts[0]).toBeDefined();
    // The background reading ends with every page that has a frame or a region, and one check of the whole project.
    await vi_waitFor(() => Object.keys(store.state.texts).length === big.pageCount);
  });

  it('changes one exercise in a blink: the operation, the checks, the new version', async () => {
    const { store } = await opened();
    const target = big.project.frames[2500] as Frame;
    const label = timed(() => store.setBookLabel(target.id, '99x'));
    expect(label.value.ok).toBe(true);
    expect(label.ms).toBeLessThan(limit(1000));
    expect(store.state.dirty).toBe(true);
    expect(timed(() => store.undo()).ms).toBeLessThan(limit(1000));
    expect(store.state.dirty).toBe(false);
    expect(timed(() => store.redo()).ms).toBeLessThan(limit(1000));
    const moved = timed(() => store.apply([{ op: 'move', id: target.id, dx: 0, dy: 0.001 }], { quiet: true }));
    expect(moved.value.ok).toBe(true);
    expect(moved.ms).toBeLessThan(limit(1000));
  });

  it('adds a book exercise from the form quickly, and offers the next number in a section of fifty', async () => {
    const { store } = await opened();
    const page = 10;
    const started = performance.now();
    store.startDraft(page, { left: 0.07, top: 0.012, right: 0.93, bottom: 0.02 });
    expect(performance.now() - started).toBeLessThan(limit(300));
    const draft = store.state.draft;
    expect(draft?.section).toBeDefined();
    expect(draft?.label).not.toBe('1');
    const confirmed = timed(() => store.confirmDraft('900', draft?.section));
    expect(confirmed.value).toBe(true);
    expect(confirmed.ms).toBeLessThan(limit(1000));
    expect(store.state.project?.frames).toHaveLength(5001);
  });

  it('selects frames and shows them in a few milliseconds, and saves and takes over a change from disk', async () => {
    const { store, api } = await opened();
    const picking = timed(() => {
      for (let at = 0; at < 200; at += 1) store.select((big.project.frames[at * 25] as Frame).id);
    });
    expect(picking.ms).toBeLessThan(limit(2000));
    const jumped = timed(() => store.select((big.project.frames[4000] as Frame).id, { jump: true }));
    expect(jumped.ms).toBeLessThan(limit(500));
    expect(store.state.page).toBe(Math.floor(4000 / 44));
    store.apply([{ op: 'meta.set', author: 'A. Author' }], { quiet: true });
    const saved = await (async () => {
      const started = performance.now();
      const ok = await store.save();
      return { ok, ms: performance.now() - started };
    })();
    expect(saved.ok).toBe(true);
    expect(saved.ms).toBeLessThan(limit(1500));
    expect(api.saved).toHaveLength(1);
    // An agent changes one label: the window takes the new version over.
    const edited: Project = { ...(store.state.project as Project), revision: 9, modifiedBy: 'cli', frames: (store.state.project as Project).frames.map((frame, at) => (at === 10 ? { ...frame, label: '77z' } : frame)) };
    const live = timed(() => store.onDiskChange({ project: edited, modifiedBy: 'cli' }));
    expect(live.ms).toBeLessThan(limit(1500));
    expect(store.state.notice?.text).toContain('Updated by cli: 1 changed');
    expect(store.state.project?.frames[10]?.label).toBe('77z');
  });
});

describe('what the Propose panel computes for 5 000 proposals', () => {
  let results: ReturnType<typeof bookResultsOf>;
  let empty: Project;

  beforeAll(() => {
    results = bookResultsOf(big);
    empty = { ...big.project, frames: [], seq: 0 };
  });

  it('builds the 5 000 rows in a few milliseconds, and the same rows again for the same frames', () => {
    // A new array of frames each time: the cache is keyed by it, so this is the cost of building.
    expect(best(() => bookRows(results.exercises, [...empty.frames]), 5)).toBeLessThan(limit(250));
    const model = bookRows(results.exercises, empty.frames);
    expect(model.counts).toMatchObject({ total: 5000, new: 5000, different: 0, same: 0 });
    expect(bookRows(results.exercises, empty.frames)).toBe(model);
    expect(Object.keys(defaultTicks(model.rows))).toHaveLength(5000);
  });

  it('knows that a book that has all of them has them: 5 000 the same, nothing to apply', () => {
    const frames = [...big.project.frames];
    expect(best(() => bookRows(results.exercises, [...frames]), 5)).toBeLessThan(limit(400));
    const model = bookRows(results.exercises, frames);
    expect(model.counts).toMatchObject({ total: 5000, new: 0, different: 0, same: 5000 });
    expect(planBook('exercises', model.rows, new Set(model.rows.map((row) => row.key))).operations).toEqual([]);
    const answers = bookRows(results.solutions, frames);
    expect(answers.counts).toMatchObject({ total: 5000, same: 5000 });
  });

  it('filters, searches and finds the ghosts of a page in a few milliseconds', () => {
    const model = bookRows(results.exercises, empty.frames);
    expect(best(() => viewRows(model.rows, { filter: 'todo', confidence: 'unsure', rejected: {}, query: '1.5:' }), 15)).toBeLessThan(limit(60));
    expect(viewRows(model.rows, { filter: 'all', confidence: 'any', rejected: {}, query: '1.5:12' }).map((row) => row.key)).toEqual(['1.5:12']);
    const listed = viewRows(model.rows, { filter: 'todo', confidence: 'any', rejected: {} });
    const first = timed(() => ghostsOn(listed, 9));
    expect(first.ms).toBeLessThan(limit(150));
    expect(first.value.filter(({ row, piece }) => row.pieces[0] === piece)).toHaveLength(44);
    expect(timed(() => ghostsOn(listed, 10)).ms).toBeLessThan(limit(20)); // built once for the list: other pages are lookups
  });

  it('makes the batch of 5 000 and applies it as one step in seconds, quickly again for the answers', async () => {
    const api = fakeApi(
      { pdf: () => big.pdf, texts: () => big.pageTexts, fresh: () => empty },
      { proposeBook: (request) => Promise.resolve({ ok: true, result: request.kind === 'exercises' ? results.exercises : results.solutions }) },
    );
    const store = new Store(api);
    await store.openDocument({ ...openedDocument(empty, big.pageCount, null), pageSizes: big.pageSizes });
    await store.proposeBook('exercises');
    const keys = store.applicableKeys('exercises', store.bookListed('exercises'), 'all');
    expect(keys).toHaveLength(5000);
    const applied = timed(() => store.applyBook('exercises', keys));
    expect(applied.value.ok).toBe(true);
    expect(applied.ms).toBeLessThan(limit(1000));
    expect(store.state.project?.frames).toHaveLength(5000);
    expect(store.state.past).toHaveLength(1);
    expect(store.bookModel('exercises')?.counts).toMatchObject({ same: 5000, new: 0 });
    await store.proposeBook('solutions');
    const answers = store.applicableKeys('solutions', store.bookListed('solutions'), 'all');
    expect(answers).toHaveLength(5000);
    const solved = timed(() => store.applyBook('solutions', answers));
    expect(solved.value.ok).toBe(true);
    expect(solved.ms).toBeLessThan(limit(1000));
    expect((store.state.project?.frames ?? []).every((frame) => (frame.solution?.length ?? 0) > 0)).toBe(true);
    // The book is what the synthetic big book is: the same exercises, the same places.
    expect(store.state.project?.frames.map((frame) => `${frame.section}:${frame.label}:${frame.page}`)).toEqual(big.project.frames.map((frame) => `${frame.section}:${frame.label}:${frame.page}`));
  });
});

describe('the work grows in step with the book', () => {
  it('lists ten times the frames in far less than a hundred times the time', () => {
    const run = (book: BigBook): number => {
      const index = frameIndex([...book.project.frames]);
      const model = bookModel(book.project.frames, book.project.outline?.entries, book.pageCount);
      return best(() => buildFrameRows({ index, model, filter: 'all', query: '1', collapsed: {} }), 15);
    };
    const ratio = run(big) / Math.max(0.1, run(small));
    // Ten times the frames: linear is about 10, quadratic a hundred.
    expect(ratio).toBeLessThan(40);
  });

  it('builds the rows of ten times the proposals in far less than a hundred times the time', () => {
    const run = (book: BigBook): number => {
      const result = bookResultsOf(book).exercises;
      return best(() => bookRows(result, []), 15);
    };
    const ratio = run(big) / Math.max(0.1, run(small));
    expect(ratio).toBeLessThan(40);
  });

  it('builds the index and the section model of ten times the frames in far less than a hundred times the time', () => {
    const run = (book: BigBook): number =>
      best(() => {
        const frames = [...book.project.frames];
        frameIndex(frames);
        bookModel(frames, book.project.outline?.entries, book.pageCount);
      }, 15);
    const ratio = run(big) / Math.max(0.1, run(small));
    expect(ratio).toBeLessThan(40);
  });
});

/** Waits (polling) until a condition holds; the store's background work is asynchronous. */
async function vi_waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
