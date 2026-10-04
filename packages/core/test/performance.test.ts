import { describe, expect, it } from 'vitest';
import { buildBookSummary } from '../src/book/summary.js';
import { checkBundle } from '../src/bundle/reader.js';
import { buildBundleBytes } from '../src/bundle/writer.js';
import type { Frame, OutlineEntry } from '../src/model/types.js';
import { applyOperations, type Operation } from '../src/project/ops.js';
import { newProject, type Project } from '../src/project/model.js';
import { parseProject, serializeProject } from '../src/project/serialize.js';
import { validateProject } from '../src/project/validate.js';
import { buildSampleSheet } from '../src/testing/sample.js';

/**
 * A book of the size the owner has in mind: thousands of authoritative exercises, as many hidden solution regions in an
 * answer key, and hundreds of sections. Every step of the pipeline must take seconds, not minutes, and must grow in step
 * with the book (an accidental quadratic loop shows up in the second test).
 */

const PAGES = 1000;
const KEY_FIRST_PAGE = 800;

function section(index: number): OutlineEntry {
  const chapter = Math.floor(index / 10);
  const inChapter = index % 10;
  const page = Math.floor((chapter * 10 + inChapter) * (KEY_FIRST_PAGE / 300));
  return inChapter === 0
    ? { title: `Chapter ${chapter + 1}`, page, depth: 0, id: `c${chapter + 1}`, label: `Chapter ${chapter + 1}`, top: 0.05 }
    : { title: `${chapter + 1}.${inChapter} Section`, page, depth: 1, id: `${chapter + 1}.${inChapter}`, label: `${chapter + 1}.${inChapter}`, top: 0.1 };
}

/** `exercises` authoritative exercises on pages 0..799, one solution region each on the key pages 800..999. */
function book(exercises: number, sections = 300): Project {
  const outline: OutlineEntry[] = Array.from({ length: sections }, (_unused, index) => section(index));
  const perPage = Math.ceil(exercises / KEY_FIRST_PAGE);
  const frames: Frame[] = [];
  for (let i = 0; i < exercises; i += 1) {
    const page = Math.min(KEY_FIRST_PAGE - 1, Math.floor(i / perPage));
    const slot = i % perPage;
    const height = 0.8 / perPage;
    const top = 0.15 + slot * height;
    // The section a position falls into: the last entry that starts at or before this page.
    let owner = 0;
    for (let s = outline.length - 1; s >= 0; s -= 1) {
      if ((outline[s] as OutlineEntry).page <= page) {
        owner = s;
        break;
      }
    }
    const keyPage = KEY_FIRST_PAGE + (i % 200);
    const keySlot = Math.floor(i / 200) % 50;
    frames.push({
      id: `f${i + 1}`,
      kind: 'exercise',
      page,
      rect: { left: 0.1, top: Math.round(top * 10000) / 10000, right: 0.9, bottom: Math.round((top + height * 0.9) * 10000) / 10000 },
      authority: 'book',
      label: String(i + 1),
      section: (outline[owner] as OutlineEntry).id as string,
      solution: [{ page: keyPage, rect: { left: 0.1, top: Math.round((0.05 + keySlot * 0.018) * 10000) / 10000, right: 0.5, bottom: Math.round((0.05 + keySlot * 0.018 + 0.015) * 10000) / 10000 } }],
    });
  }
  const project = newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: PAGES }, title: 'Big Book' });
  return { ...project, frames, outline: { source: 'manual', entries: outline }, seq: exercises };
}

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

async function timedAsync<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

describe('a book with 10 000 exercises, 10 000 solution regions and 300 sections', () => {
  const project = book(10000);

  it('is a valid project (so that the timings below measure real work)', () => {
    const validation = validateProject(project);
    expect(validation.errors).toEqual([]);
    expect(validation.book).toEqual({ exercises: 10000, withSolution: 10000 });
    expect(validation.warnings.map((entry) => entry.code).filter((code) => code === 'section-mismatch')).toEqual([]);
  });

  it('validates in a few seconds', () => {
    const { ms } = timed(() => validateProject(project));
    expect(ms).toBeLessThan(4000);
  });

  it('serializes, parses back and validates again in a few seconds', () => {
    const written = timed(() => serializeProject(project));
    expect(written.ms).toBeLessThan(3000);
    const read = timed(() => parseProject(JSON.parse(written.value), 'x'));
    expect(read.ms).toBeLessThan(3000);
    expect(read.value.frames).toHaveLength(10000);
    expect(serializeProject(read.value)).toBe(written.value);
  });

  it('summarizes the sections in a blink', () => {
    const { value, ms } = timed(() => buildBookSummary({ title: 'Big Book', pageCount: PAGES, frames: project.frames, outline: project.outline?.entries, exercises: true }));
    expect(value.totals).toMatchObject({ sections: 300, exercises: 10000, withSolution: 10000, unfiled: 0 });
    expect(ms).toBeLessThan(2000);
  });

  it('exports and is read back by the importer check in a few seconds', async () => {
    const sample = buildSampleSheet();
    const written = await timedAsync(() => buildBundleBytes({ pdfBytes: sample.pdf, title: 'Big Book', pageCount: PAGES, frames: project.frames, outline: project.outline?.entries, createdAt: new Date('2026-10-04T12:00:00Z') }));
    expect(written.ms).toBeLessThan(6000);
    expect(written.value.manifest.features).toEqual(['sections', 'authority', 'solution']);
    const checked = await timedAsync(() => checkBundle(written.value.bytes, { openPdf: false }));
    expect(checked.value.errors).toEqual([]);
    expect(checked.value.frames).toHaveLength(10000);
    expect(checked.ms).toBeLessThan(6000);
  });
});

describe('the pipeline grows in step with the book', () => {
  /** The median of three runs, after one to warm up. */
  function median(work: () => unknown): number {
    work();
    const runs = [timed(work).ms, timed(work).ms, timed(work).ms].sort((a, b) => a - b);
    return runs[1] as number;
  }

  it('validates ten times the exercises in far less than a hundred times the time', () => {
    const small = book(1500, 150);
    const large = book(15000, 300);
    const ratio = median(() => validateProject(large)) / Math.max(1, median(() => validateProject(small)));
    // Ten times the work: linear is about 10, n log n a little more, quadratic a hundred.
    expect(ratio).toBeLessThan(40);
  });

  it('adds thousands of exercises in one batch: every operation sees the whole project, so the cost is small per step', () => {
    const operations = (count: number): Operation[] =>
      Array.from({ length: count }, (_unused, i) => ({ op: 'add', authority: 'book', label: String(i + 1), section: 'c1', page: i % 800, rect: [0.1, 0.1 + (i % 50) * 0.016, 0.9, 0.1 + (i % 50) * 0.016 + 0.014] }));
    const empty = book(0);
    const five = timed(() => applyOperations(empty, operations(5000), { pageCount: PAGES }));
    expect(five.value.created).toHaveLength(5000);
    expect(new Set(five.value.project.frames.map((entry) => entry.id)).size).toBe(5000);
    // About 0.3 s here; the bound only catches an accident such as a search through the project for every generated id.
    expect(five.ms).toBeLessThan(6000);
    const pairs: Operation[] = [];
    for (let i = 0; i < 2000; i += 1) {
      pairs.push({ op: 'add', ref: `e${i}`, authority: 'book', label: String(i + 1), section: 'c1', page: i % 800, rect: [0.1, 0.1 + (i % 50) * 0.016, 0.9, 0.1 + (i % 50) * 0.016 + 0.014] });
      pairs.push({ op: 'solution.add', id: `@e${i}`, page: 900, rect: [0.1, 0.1 + (i % 50) * 0.016, 0.5, 0.1 + (i % 50) * 0.016 + 0.014] });
    }
    const mixed = timed(() => applyOperations(empty, pairs, { pageCount: PAGES }));
    expect(mixed.value.project.frames.every((entry) => entry.solution?.length === 1)).toBe(true);
    expect(mixed.ms).toBeLessThan(6000);
  });

  it('sets the solution of thousands of exercises, and moves them to another section, by their numbers in one batch: no search through the project for each', () => {
    // Each operation names its exercise as SECTION:LABEL. A search through all the frames for each (and a copy of the list of frames by
    // a loop over all of them) made 5 000 of them take five seconds on Node 20; with an index of the batch it takes a tenth of that.
    const batch = (project: Project): Operation[] =>
      project.frames.flatMap((frame): Operation[] => [
        { op: 'solution.set', id: `${frame.section}:${frame.label}`, regions: [{ page: 900, rect: [0.1, 0.1, 0.5, 0.2] }] },
        { op: 'section.set', id: `${frame.section}:${frame.label}`, section: 'c1' },
      ]);
    const run = (count: number): number => {
      const project = book(count, Math.max(10, Math.ceil(count / 40)));
      const operations = batch(project);
      const done = applyOperations(project, operations, { pageCount: PAGES });
      expect(done.project.frames.every((entry) => entry.section === 'c1' && entry.solution?.length === 1 && entry.solution[0]?.page === 900)).toBe(true);
      return median(() => applyOperations(project, operations, { pageCount: PAGES }));
    };
    const ratio = run(5000) / Math.max(1, run(500));
    // Ten times the exercises: linear is about 10, a search for each operation a hundred.
    expect(ratio).toBeLessThan(40);
  });
});
