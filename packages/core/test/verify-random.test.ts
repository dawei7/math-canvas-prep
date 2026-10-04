import { describe, expect, it } from 'vitest';
import type { Frame, OutlineEntry, PageText, Rect, TextLine } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { sampleProject } from '../src/sample/sample.js';
import { verifyProject } from '../src/verify/verify.js';

/**
 * Random projects on random text (a small deterministic generator, so that every run and every machine sees the same ones):
 * the checks must not throw, whatever the frames and the lines are, and what they report must not depend on the order of the
 * frames in the file.
 */

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['1.', '2)', '(3)', '4', '5a)', 'x', '12', '3.5', 'A.3', 'II-4', '-', '1-7.', '1,', '3,', '5.', 'Evaluate', '10', '99)', '(a)', 'b)', '2x'];
const LABELS = ['1', '2', '3', '5a', '5b', 'A.3', '10', '300', '7', '(a)', '1-2'];

function scenario(seed: number): { project: Project; lookup: (page: number) => PageText | undefined } {
  const next = random(seed);
  const int = (n: number): number => Math.floor(next() * n);
  const pageCount = 1 + int(5);
  const rect = (): Rect => {
    const left = next() * 0.8;
    const top = next() * 0.9;
    return { left, top, right: Math.min(1, left + 0.02 + next() * 0.5), bottom: Math.min(1, top + 0.01 + next() * 0.3) };
  };
  const pages: PageText[] = Array.from({ length: pageCount }, (_unused, page) => {
    const lines: TextLine[] = Array.from({ length: int(40) }, () => {
      const area = rect();
      const text = Array.from({ length: 1 + int(6) }, () => WORDS[int(WORDS.length)] as string).join(' ');
      const middle = (area.left + area.right) / 2;
      const parts = next() < 0.2 ? [{ text: WORDS[int(WORDS.length)] as string, chars: 3, rect: { ...area, right: middle } }, { text: WORDS[int(WORDS.length)] as string, chars: 3, rect: { ...area, left: middle } }] : undefined;
      return { text, rect: area, fontSize: 11, column: 0, chars: text.length, ...(next() < 0.1 ? { headerFooter: true } : {}), ...(parts ? { parts } : {}) };
    });
    return { page, size: { width: 595, height: 842, rotation: 0 }, lines, columns: 1, hasText: next() < 0.9 };
  });
  const entries: OutlineEntry[] = Array.from({ length: int(6) }, (_unused, index) => ({ title: `S${index}`, page: int(pageCount), depth: int(3), id: `s${index}`, label: `s${index}`, ...(next() < 0.5 ? { top: next() } : {}) }));
  const frames: Frame[] = Array.from({ length: int(60) }, (_unused, index) => {
    const book = next() < 0.8;
    return {
      id: `f${index}`,
      kind: next() < 0.9 ? 'exercise' : 'question',
      page: int(pageCount),
      rect: rect(),
      ...(book ? { authority: 'book' as const, label: LABELS[int(LABELS.length)] as string, section: `s${int(7)}` } : {}),
      ...(next() < 0.3 ? { continues: [{ page: int(pageCount), rect: rect() }] } : {}),
      ...(next() < 0.3 ? { context: [{ page: int(pageCount), rect: rect() }] } : {}),
      ...(next() < 0.6 ? { solution: Array.from({ length: 1 + int(3) }, () => ({ page: int(pageCount), rect: rect() })) } : {}),
      ...(!book && next() < 0.2 ? { unit: `u${int(3)}` } : {}),
    };
  });
  const base = newProject({ pdf: { path: 'x.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount }, title: 'Random' });
  return { project: { ...base, frames, outline: { source: 'manual', entries } }, lookup: (page) => pages[page] };
}

describe('the checks on random projects', () => {
  it('never throw, and give the same report whatever the order of the frames', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const { project, lookup } = scenario(seed);
      const options = seed % 3 === 0 ? { itemPatterns: [/^Problem\s+(\d+)\./g] } : {};
      const report = verifyProject(project, lookup, options);
      const turned: Project = { ...project, frames: [...project.frames].reverse() };
      if (turned.frames.length > 0) turned.frames.push(turned.frames.shift() as Frame);
      expect(verifyProject(turned, lookup, options), `verify, seed ${seed}`).toEqual(report);
      expect(report.summary.errors + report.summary.warnings + report.summary.infos, `counts, seed ${seed}`).toBe(report.findings.length);
      const wanted = { exercises: seed % 31, solutions: seed % 17 };
      const sample = sampleProject(project, lookup, wanted);
      expect(sampleProject(turned, lookup, wanted), `sample, seed ${seed}`).toEqual(sample);
      expect(sampleProject(project, lookup, wanted), `sample twice, seed ${seed}`).toEqual(sample);
    }
  });
});
