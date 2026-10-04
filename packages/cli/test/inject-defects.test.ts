import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFECT_TYPES, buildSpanBook, buildSyntheticBook, defectRates, evaluateDefects, injectDefects, seeded } from '@mcprep/core/testing';
import { PdfDocument, measureInk, newProject, type Project } from '@mcprep/core';
import { auditedBook } from './audited.js';

/**
 * The proof that the harness has teeth: a seeded set of defects of every kind is injected into the audited synthetic workbook and
 * into the three-page span, and the gate must not pass for any of them and must name the exercise; the untouched projects pass.
 */

const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'mcprep-defects-'));
  folders.push(folder);
  return folder;
}

describe('defect injection', () => {
  it('stops the gate for every injected defect of the workbook and names it; the untouched workbook passes', async () => {
    const cli = await auditedBook();
    const project = JSON.parse(await readFile(join(cli.dir, 'book.mcprep.json'), 'utf8')) as Project;
    const pdf = new Uint8Array(await readFile(join(cli.dir, 'book.pdf')));
    const cases = injectDefects(project, { on: 'workbook', seed: 20261004, perType: 4 });
    const types = new Set(cases.map((entry) => entry.type));
    for (const entry of DEFECT_TYPES.filter((type) => type.on === 'workbook')) expect(types.has(entry.type), `${entry.type} could be injected`).toBe(true);
    const { clean, results } = await evaluateDefects(cases, project, pdf, await scratch(), { ink: true });
    expect(clean.caught, 'the untouched workbook passes the gate').toBe(false);
    expect(clean.named).toBe(true);
    const missed = results.filter((result) => !result.caught || !result.named);
    expect(missed.map((result) => `${result.id}: ${result.description} (open ${result.open}, first ${result.finding?.code ?? 'none'} ${result.finding?.ref ?? ''})`)).toEqual([]);
    const rates = defectRates(results);
    // The workbook has one exercise that goes on over a page break: that defect has one place to be injected.
    for (const rate of rates) expect(rate, rate.type).toMatchObject({ injected: rate.type === 'continuation-left-out' ? 1 : 4, caught: rate.injected, named: rate.injected });
  });

  it('knows what a top edge cuts: nothing while it is still in the white above the ink (+0.004), the pixels of the glyphs from a hair on (+0.010)', async () => {
    const cli = await auditedBook();
    const project = JSON.parse(await readFile(join(cli.dir, 'book.mcprep.json'), 'utf8')) as Project;
    const doc = await PdfDocument.fromBytes(new Uint8Array(await readFile(join(cli.dir, 'book.pdf'))));
    try {
      const frames = project.frames.filter((frame) => frame.authority === 'book');
      expect(frames).toHaveLength(112);
      const crossings = async (shift: number): Promise<number[]> => {
        const regions = frames.map((frame) => ({ page: frame.page, rect: { ...frame.rect, top: frame.rect.top + shift } }));
        const ink = await measureInk(doc, regions);
        return regions.map((region) => ink.lookup(region)?.cross?.top ?? -1);
      };
      // The workbook leaves 7.1 to 7.3 points of white above the first ink of an exercise: 0.004 of the page (3.4 points) cuts nothing ...
      expect(Math.max(...(await crossings(0)))).toBe(0);
      expect(Math.max(...(await crossings(0.004)))).toBe(0);
      // ... and 0.010 (8.4 points) cuts a point and a quarter of every first line: at least 6 pixels of ink go across the edge of every exercise.
      expect(Math.min(...(await crossings(0.01)))).toBeGreaterThanOrEqual(6);
    } finally {
      await doc.close();
    }
  });

  it('stops the gate for every damage to the span of an exercise over three pages; the untouched span passes', async () => {
    const book = buildSpanBook();
    const project: Project = { ...newProject({ pdf: { path: 'book.pdf', sha256: 'x'.repeat(64), bytes: 1, pageCount: book.pageCount }, title: 'Span' }), outline: { source: 'manual', entries: book.outline }, frames: book.frames };
    const folder = await scratch();
    const cases = injectDefects(project, { on: 'span' });
    expect(cases.map((entry) => entry.type)).toEqual(['span-middle-deleted', 'span-swapped', 'span-shrunk']);
    // The project must carry the real hash of its PDF.
    const { PdfDocument } = await import('@mcprep/core');
    const doc = await PdfDocument.fromBytes(book.pdf);
    const hashed = { ...project, pdf: { ...project.pdf, sha256: doc.sha256, bytes: doc.bytes } };
    await doc.close();
    const { clean, results } = await evaluateDefects(
      cases.map((entry) => ({ ...entry, project: { ...entry.project, pdf: hashed.pdf } })),
      hashed,
      book.pdf,
      folder,
      {},
    );
    // The span has no answers, which `no-solution` only mentions as information: nothing is open.
    expect(clean.caught).toBe(false);
    expect(results.map((result) => `${result.type} ${result.caught} ${result.named}`)).toEqual(['span-middle-deleted true true', 'span-swapped true true', 'span-shrunk true true']);
  });

  it('is the same damage for the same seed, and another for another seed', async () => {
    const cli = await auditedBook();
    const project = JSON.parse(await readFile(join(cli.dir, 'book.mcprep.json'), 'utf8')) as Project;
    const descriptions = (seed: number): string[] => injectDefects(project, { on: 'workbook', seed, perType: 3 }).map((entry) => entry.description);
    expect(descriptions(7)).toEqual(descriptions(7));
    expect(descriptions(7)).not.toEqual(descriptions(8));
    const first = seeded(1);
    const second = seeded(1);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    expect(buildSyntheticBook().pageCount).toBeGreaterThan(0);
  });
});
