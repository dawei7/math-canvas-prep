import { describe, expect, it } from 'vitest';
import type { Frame, OutlineEntry, PageText, TextLine } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { pagesToVerify, verifyProject, type PageSource } from '../src/verify/verify.js';

/**
 * A book of the size the owner has in mind: thousands of authoritative exercises with their answers. The check reads the text of
 * the pages that hold them (given here as lines, not read from a PDF: the extraction of the text is the PDF library's work) and
 * must finish in a second or two, and take twice as long for twice the book.
 */

const PER_PAGE = 30;
const SECTION_SIZE = 50;

interface Book {
  project: Project;
  pages: PageSource;
}

function line(text: string, left: number, top: number, right: number, bottom: number): TextLine {
  return { text, rect: { left, top, right, bottom }, fontSize: 11, column: left > 0.4 ? 1 : 0, chars: text.replace(/\s/g, '').length };
}

/** `count` exercises in two columns of fifteen on pages 0..n, their answers in three columns on the pages after them. */
function book(count: number): Book {
  const exercisePages = Math.ceil(count / PER_PAGE);
  const keyPages = Math.ceil(count / 120);
  const pageCount = exercisePages + keyPages;
  const sections = Math.ceil(count / SECTION_SIZE);
  const outline: OutlineEntry[] = Array.from({ length: sections }, (_unused, index) => ({
    title: `Section ${index + 1}`,
    page: Math.floor((index * SECTION_SIZE) / PER_PAGE),
    depth: 0,
    id: `s${index + 1}`,
    label: `s${index + 1}`,
    top: 0.01,
  }));
  const texts: PageText[] = Array.from({ length: pageCount }, (_unused, page) => ({
    page,
    size: { width: 595, height: 842, rotation: 0 },
    lines: [],
    columns: 1,
    hasText: true,
  }));
  const frames: Frame[] = [];
  for (let i = 0; i < count; i += 1) {
    const page = Math.floor(i / PER_PAGE);
    const slot = i % PER_PAGE;
    const column = slot % 2;
    const row = Math.floor(slot / 2);
    const left = column === 0 ? 0.1 : 0.55;
    const top = 0.08 + row * 0.058;
    const label = String(i + 1);
    (texts[page] as PageText).lines.push(line(`${label}. Evaluate the expression.`, left, top + 0.006, left + 0.3, top + 0.02));
    const section = `s${Math.floor(i / SECTION_SIZE) + 1}`;
    const keyPage = exercisePages + Math.floor(i / 120);
    const keySlot = i % 120;
    const keyColumn = keySlot % 3;
    const keyRow = Math.floor(keySlot / 3);
    const keyLeft = 0.1 + keyColumn * 0.3;
    const keyTop = 0.08 + keyRow * 0.02;
    (texts[keyPage] as PageText).lines.push(line(`${label}. 42`, keyLeft, keyTop + 0.003, keyLeft + 0.1, keyTop + 0.015));
    frames.push({
      id: `f${i + 1}`,
      kind: 'exercise',
      page,
      rect: { left: left - 0.01, top, right: left + 0.35, bottom: top + 0.052 },
      authority: 'book',
      label,
      section,
      solution: [{ page: keyPage, rect: { left: keyLeft - 0.01, top: keyTop, right: keyLeft + 0.2, bottom: keyTop + 0.019 } }],
    });
  }
  const project = newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount }, title: 'Big Book' });
  return { project: { ...project, frames, outline: { source: 'manual', entries: outline }, seq: count }, pages: (page) => texts[page] };
}

function best(work: () => void, runs = 3): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe('a book with 3 000 exercises and 3 000 answers', () => {
  const small = book(3000);

  it('is a clean book (so that the timings measure real work)', () => {
    const report = verifyProject(small.project, small.pages);
    expect(report.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(report.summary).toMatchObject({ exercises: 3000, authoritative: 3000, sections: 60, solutions: 3000 });
    expect(pagesToVerify(small.project).length).toBe(100 + 25);
  });

  it('is checked in a second or two', () => {
    const ms = best(() => void verifyProject(small.project, small.pages));
    expect(ms).toBeLessThan(2500);
  });

  it('takes about twice as long for twice the book, not four times', () => {
    const large = book(6000);
    const one = best(() => void verifyProject(small.project, small.pages));
    const two = best(() => void verifyProject(large.project, large.pages));
    expect(two).toBeLessThan(Math.max(one * 4, 150));
  });
});
