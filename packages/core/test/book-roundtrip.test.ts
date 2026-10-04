import { describe, expect, it } from 'vitest';
import { buildBookSummary } from '../src/book/summary.js';
import { checkBundle } from '../src/bundle/reader.js';
import { buildBundleBytes } from '../src/bundle/writer.js';
import type { Frame, OutlineEntry, Region } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { parseProject, serializeProject } from '../src/project/serialize.js';
import { validateProject } from '../src/project/validate.js';
import { buildSampleSheet } from '../src/testing/sample.js';

/**
 * Random books, written and read back: whatever the project holds must survive a save and a load of the project file, and
 * whatever the importer check accepts must be exactly what was written. A small seeded generator keeps every run the same.
 */

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const LABEL_POOL = ['1', '2', '12', '5a', '5b', 'A.3', 'II-4', '5(a)', 'Problem 3', '3/4', 'R1', '10c', 'x_2'];

function randomBook(seed: number): { project: Project; pageCount: number } {
  const random = generator(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const pageCount = 12 + Math.floor(random() * 20);
  const keyPage = pageCount - 1;
  const sections: OutlineEntry[] = [];
  let page = 0;
  const chapters = 2 + Math.floor(random() * 3);
  for (let c = 0; c < chapters; c += 1) {
    sections.push({ title: `Chapter ${c + 1}`, page, depth: 0, id: `c${c + 1}`, ...(random() < 0.7 ? { label: `Chapter ${c + 1}` } : {}), ...(random() < 0.5 ? { top: Math.round(random() * 0.3 * 1000) / 1000 } : {}) });
    const inChapter = 1 + Math.floor(random() * 3);
    for (let s = 0; s < inChapter; s += 1) {
      page += Math.floor(random() * 3);
      sections.push({ title: `${c + 1}.${s + 1} Section`, page: Math.min(page, keyPage - 1), depth: 1, id: `${c + 1}.${s + 1}`, label: `${c + 1}.${s + 1}`, ...(random() < 0.5 ? { top: 0.1 } : {}) });
    }
    page += 1;
  }
  const frames: Frame[] = [];
  const used = new Set<string>();
  const total = 5 + Math.floor(random() * 40);
  for (let i = 0; i < total; i += 1) {
    const entry = pick(sections.filter((section) => section.id !== undefined));
    const label = pick(LABEL_POOL);
    const key = `${entry.id as string}:${label}`;
    if (used.has(key)) continue;
    used.add(key);
    const framePage = Math.min(entry.page + Math.floor(random() * 2), keyPage - 1);
    const top = 0.12 + Math.floor(random() * 6) * 0.13;
    const region = (p: number, t: number): Region => ({ page: p, rect: { left: 0.1, top: Math.round(t * 1000) / 1000, right: 0.9, bottom: Math.round((t + 0.06) * 1000) / 1000 } });
    const frame: Frame = { id: `f${frames.length + 1}`, kind: 'exercise', page: framePage, rect: region(framePage, top).rect, authority: 'book', label, section: entry.id as string };
    if (random() < 0.3) frame.context = [region(framePage, Math.max(0.01, top - 0.08))];
    if (random() < 0.2) frame.continues = [region(Math.min(framePage + 1, keyPage - 1), 0.05)];
    if (random() < 0.8) frame.solution = Array.from({ length: 1 + Math.floor(random() * 2) }, (_unused, k) => region(keyPage, 0.05 + ((i * 2 + k) % 12) * 0.07));
    frames.push(frame);
  }
  const project = newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount }, title: `Random book ${seed}` });
  return { project: { ...project, frames, seq: frames.length, outline: { source: 'manual', entries: sections }, meta: { title: project.meta.title, author: 'A. Author', license: { name: 'MIT' } } }, pageCount };
}

describe('random books', () => {
  const seeds = Array.from({ length: 40 }, (_unused, i) => i + 1);

  it.each(seeds)('seed %i survives saving and loading the project, and validates', (seed) => {
    const { project } = randomBook(seed);
    expect(validateProject(project).errors).toEqual([]);
    const text = serializeProject(project);
    const back = parseProject(JSON.parse(text), 'x');
    expect(serializeProject(back)).toBe(text);
    const byId = new Map(back.frames.map((entry) => [entry.id, entry]));
    for (const original of project.frames) expect(byId.get(original.id)).toEqual(original);
    expect(back.outline?.entries).toEqual(project.outline?.entries);
    expect(back.meta).toEqual(project.meta);
  });

  it.each(seeds)('seed %i is written and read back by the importer check exactly', async (seed) => {
    const { project, pageCount } = randomBook(seed);
    const written = await buildBundleBytes({
      pdfBytes: buildSampleSheet().pdf,
      title: project.meta.title,
      pageCount,
      frames: project.frames,
      ...(project.outline ? { outline: project.outline.entries } : {}),
      info: { author: 'A. Author', license: { name: 'MIT' } },
      createdAt: new Date('2026-10-04T12:00:00Z'),
    });
    const report = await checkBundle(written.bytes, { openPdf: false });
    expect(report.errors).toEqual([]);
    expect(report.repairs).toEqual([]);
    expect(report.frames).toHaveLength(project.frames.length);
    const read = new Map((report.frames ?? []).map((entry) => [entry.id, entry]));
    for (const original of project.frames) expect(read.get(original.id)).toEqual(original);
    expect(report.outline).toEqual(project.outline?.entries);
    expect(report.numbers).toEqual([]);
    expect(report.features).toEqual(['sections', 'authority', ...(project.frames.some((entry) => entry.solution !== undefined) ? ['solution'] : [])]);
    const summary = buildBookSummary({ title: project.meta.title, pageCount, frames: report.frames ?? [], outline: report.outline });
    const direct = buildBookSummary({ title: project.meta.title, pageCount, frames: project.frames, outline: project.outline?.entries });
    expect(summary).toEqual(direct);
    expect(summary.totals.exercises).toBe(project.frames.length);
    expect(summary.totals.unfiled).toBe(0);
    expect(summary.sections.reduce((sum, section) => sum + section.exercises, 0)).toBe(project.frames.length);
  });
});
