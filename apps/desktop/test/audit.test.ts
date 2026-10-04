import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, deriveSections, toOutlineEntries, type BookStructure, type OutlineEntry } from '@mcprep/core';
import { AuditCancelled, readPages, runDerive, type AuditHooks } from '../src/main/audit.js';
import { DocumentService } from '../src/main/service.js';
import type { AuditProgress } from '../src/shared/api.js';

/**
 * The long jobs on a book, run in the main process: what the service does with them (progress, stopping, one at a time,
 * stopped by opening another document) and that they find what the core's heuristics find. No window, no Electron: the
 * service only needs Node and the core. The book is the synthetic textbook.
 */

let work: string;
let pdfPath: string;
let bytes: Uint8Array;
let truth: { sections: { id: string }[]; chapters: { id: string }[] };
const services: DocumentService[] = [];

beforeAll(async () => {
  const built = await import('@mcprep/core/testing');
  const book = built.buildSyntheticBook();
  bytes = book.pdf;
  truth = book.truth;
  work = mkdtempSync(join(tmpdir(), 'mcprep-audit-'));
  pdfPath = join(work, 'book.pdf');
  writeFileSync(pdfPath, bytes);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function opened(): Promise<DocumentService> {
  const service = new DocumentService();
  services.push(service);
  const outcome = await service.open(pdfPath);
  expect(outcome.ok).toBe(true);
  return service;
}

const idsOf = (structure: BookStructure): string[] => structure.entries.map((entry) => entry.id);

describe('deriving the sections in the main process', () => {
  it('finds what the core finds on the text of the pages, with the fonts', async () => {
    const service = await opened();
    const outcome = await service.deriveSections();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const pdf = await PdfDocument.fromBytes(bytes);
    const direct = deriveSections(await pdf.allPageText({ fonts: true }));
    await pdf.close();
    expect(outcome.result).toEqual(direct);
    expect(idsOf(outcome.result)).toEqual([...truth.chapters.map((chapter) => chapter.id), ...truth.sections.map((section) => section.id), 'Answers'].sort((a, b) => idsOf(direct).indexOf(a) - idsOf(direct).indexOf(b)));
  });

  it('reports its progress: it starts at 0, counts the pages, and ends at the last step', async () => {
    const service = await opened();
    const reports: AuditProgress[] = [];
    service.onProgress = (progress) => reports.push(progress);
    await service.deriveSections();
    expect(reports.length).toBeGreaterThanOrEqual(3);
    expect(reports[0]).toEqual({ phase: 'Reading the text of the pages', done: 0, total: 21 });
    const reading = reports.filter((report) => report.phase === 'Reading the text of the pages');
    expect(reading[reading.length - 1]).toEqual({ phase: 'Reading the text of the pages', done: 21, total: 21 });
    expect(reading.map((report) => report.done)).toEqual([...reading.map((report) => report.done)].sort((a, b) => a - b));
    expect(reports[reports.length - 1]).toEqual({ phase: 'Looking for the contents and the headings', done: 1, total: 1 });
  });

  it('does not report more than about ten times a second', async () => {
    const service = await opened();
    let count = 0;
    service.onProgress = () => {
      count += 1;
    };
    const started = Date.now();
    await service.deriveSections();
    const seconds = Math.max(0.001, (Date.now() - started) / 1000);
    // Two reports at the ends of each phase, and at most one per 90 ms in between.
    expect(count).toBeLessThanOrEqual(4 + Math.ceil(seconds / 0.09));
  });

  it('stops when it is asked to, at the next page, and can run again afterwards', async () => {
    const service = await opened();
    service.onProgress = (progress) => {
      if (progress.phase === 'Reading the text of the pages' && progress.done === 0) service.cancelAudit();
    };
    const stopped = await service.deriveSections();
    expect(stopped).toEqual({ ok: false, cancelled: true, message: 'Stopped.' });
    service.onProgress = undefined;
    const again = await service.deriveSections();
    expect(again.ok).toBe(true);
  });

  it('runs one job at a time', async () => {
    const service = await opened();
    const first = service.deriveSections();
    const second = await service.deriveSections();
    expect(second).toMatchObject({ ok: false, cancelled: false });
    expect((second as { message: string }).message).toContain('Another search is still running');
    expect((await first).ok).toBe(true);
  });

  it('is stopped by closing the document (opening another one does that)', async () => {
    const service = await opened();
    service.onProgress = (progress) => {
      if (progress.done === 0) void service.close();
    };
    const outcome = await service.deriveSections();
    expect(outcome).toMatchObject({ ok: false, cancelled: true });
  });

  it('says in plain words that no document is open', async () => {
    const service = new DocumentService();
    services.push(service);
    expect(await service.deriveSections()).toEqual({ ok: false, cancelled: false, message: 'No project is open.' });
  });

  it('can be stopped when no job runs: nothing happens', async () => {
    const service = await opened();
    service.cancelAudit();
    expect((await service.deriveSections()).ok).toBe(true);
  });
});

describe('looking for the exercises and the answers through the service', () => {
  const outlineOf = async (): Promise<OutlineEntry[]> => {
    const pdf = await PdfDocument.fromBytes(bytes);
    const outline = toOutlineEntries(deriveSections(await pdf.allPageText({ fonts: true })));
    await pdf.close();
    return outline;
  };

  it('finds the exercises of the sections the window has, reporting each step', async () => {
    const service = await opened();
    const reports: AuditProgress[] = [];
    service.onProgress = (progress) => reports.push(progress);
    const outcome = await service.proposeBook({ kind: 'exercises', outline: await outlineOf() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.kind !== 'exercises') return;
    expect(outcome.result.exercises.sections.map((section) => [section.section, section.proposals.length])).toEqual([
      ['0.1', 70],
      ['0.2', 14],
      ['1.1', 12],
      ['1.2', 16],
    ]);
    const phases = [...new Set(reports.map((report) => report.phase))];
    expect(phases).toEqual(['Reading the text of the pages', 'Looking at the white between the lines', 'Looking for the exercises']);
    expect(reports[reports.length - 1]).toEqual({ phase: 'Looking for the exercises', done: 1, total: 1 });
  });

  it('finds the answers for the exercises it is given', async () => {
    const service = await opened();
    const outcome = await service.proposeBook({ kind: 'solutions', outline: await outlineOf(), exercises: [{ section: '0.2', label: '1' }, { section: '0.2', label: '2' }] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.kind !== 'solutions') return;
    const answered = outcome.result.solutions.sections.find((section) => section.section === '0.2');
    expect(answered?.answers).toHaveLength(14);
    expect(answered?.withoutExercise.length).toBe(12);
    expect(outcome.result.answerKey?.page).toBeGreaterThan(10);
  });

  it('says what is missing as a problem to solve, not a failure: no sections with ids, no exercises for the answers', async () => {
    const service = await opened();
    const flat: OutlineEntry[] = (await outlineOf()).map(({ title, page, depth }) => ({ title, page, depth }));
    const noIds = await service.proposeBook({ kind: 'exercises', outline: flat });
    expect(noIds).toMatchObject({ ok: false, cancelled: false });
    expect((noIds as { message: string }).message).toContain('The book has no sections with ids yet');
    const noExercises = await service.proposeBook({ kind: 'solutions', outline: await outlineOf(), exercises: [] });
    expect((noExercises as { message: string }).message).toContain('The book has no book exercises yet');
    // And the job is over: the next one can run.
    expect((await service.deriveSections()).ok).toBe(true);
  });

  it('stops between two pages, also while the pages of the practice sets are looked at', async () => {
    const service = await opened();
    const outline = await outlineOf();
    service.onProgress = (progress) => {
      if (progress.phase === 'Looking at the white between the lines' && progress.done === 0) service.cancelAudit();
    };
    expect(await service.proposeBook({ kind: 'exercises', outline })).toEqual({ ok: false, cancelled: true, message: 'Stopped.' });
    service.onProgress = undefined;
    expect((await service.proposeBook({ kind: 'exercises', outline })).ok).toBe(true);
  });

  it('runs one job at a time, whatever kind', async () => {
    const service = await opened();
    const outline = await outlineOf();
    const first = service.proposeBook({ kind: 'exercises', outline });
    const second = await service.deriveSections();
    expect(second).toMatchObject({ ok: false, cancelled: false });
    expect((await first).ok).toBe(true);
  });
});

describe('the steps of a job', () => {
  const quiet: AuditHooks = { report: () => undefined, check: () => undefined };

  it('read every page with its fonts, and say how far they are', async () => {
    const pdf = await PdfDocument.fromBytes(bytes);
    const seen: number[] = [];
    const pages = await readPages(pdf, { report: (_phase, done) => seen.push(done), check: () => undefined });
    await pdf.close();
    expect(pages).toHaveLength(21);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(21);
    expect(pages.some((page) => page.lines.some((line) => line.bold === true || line.fontSize !== undefined))).toBe(true);
  });

  it('look whether they were stopped before every page', async () => {
    const pdf = await PdfDocument.fromBytes(bytes);
    let checks = 0;
    const hooks: AuditHooks = {
      report: () => undefined,
      check: () => {
        checks += 1;
        if (checks > 3) throw new AuditCancelled();
      },
    };
    await expect(runDerive(pdf, hooks)).rejects.toBeInstanceOf(AuditCancelled);
    expect(checks).toBe(4);
    await pdf.close();
  });

  it('derive the same sections as the core does', async () => {
    const pdf = await PdfDocument.fromBytes(bytes);
    const structure = await runDerive(pdf, quiet);
    await pdf.close();
    expect(structure.chapters).toBe(2);
    expect(structure.sections).toBe(4);
  });
});
