import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, deriveSections, type BookStructure } from '@mcprep/core';
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
