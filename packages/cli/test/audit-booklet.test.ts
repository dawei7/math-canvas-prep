import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBooklet, type Booklet, type BookletOptions } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import { tempDir, type Cli, type Result } from './helpers.js';

/**
 * An exercise booklet through the command line with the default words and options: the chapters from the printed contents or from
 * the bookmarks, the exercises ("Aufgabe 1.2 (Title).", one to a page) with their regions down to the last ink of the page, and
 * `exercises verify` with nothing to report. The booklet is synthetic (`buildBooklet`).
 */

async function workspace(options: BookletOptions = {}): Promise<{ cli: Cli; book: Booklet }> {
  const dir = await tempDir();
  const book = buildBooklet(options);
  await writeFile(join(dir, 'heft.pdf'), book.pdf);
  const cli = (async (args, opts = {}) => {
    let out = '';
    let err = '';
    const withJson = opts.json === false ? args : [...args, '--json'];
    const code = await run(withJson, {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      stdin: () => Promise.resolve(opts.stdin ?? ''),
      cwd: dir,
      env: { ...opts.env },
    });
    let json: Result['json'] = { ok: false, command: '', result: {} };
    if (opts.json !== false && out.trim().startsWith('{')) json = JSON.parse(out) as Result['json'];
    return { code, stdout: out, stderr: err, json };
  }) as Cli;
  Object.defineProperty(cli, 'dir', { value: dir });
  const made = await cli(['init', 'heft.pdf', '--title', 'Ein Übungsheft']);
  if (made.code !== 0) throw new Error(`init failed: ${made.stdout}${made.stderr}`);
  return { cli, book };
}

interface Derived {
  entries: { id: string; label?: string; title: string; page: number; depth: number; kind: string }[];
  chapters: number;
  sections: number;
  notes: string[];
}

interface Proposed {
  proposals: { section: string; label: string; page: number; rect: { top: number; bottom: number }; continues?: unknown[] }[];
  counts: { sections: number; exercises: number };
  applied: boolean;
  created?: string[];
  replaced?: string[];
  counts: { sections: number; exercises: number; added: number; unchanged: number; changed: number; replaced: number };
  operations?: unknown[];
  book?: { exercises: number };
}

describe.each([
  ['printed contents', {}],
  ['bookmarks and printed contents', { bookmarks: true }],
  ['bookmarks alone', { bookmarks: true, contents: false }],
] as const)('an exercise booklet with its chapters from the %s', (_name, options) => {
  it('derives the chapters as the sections, with the numbers they print, and nothing else as an entry of the book', async () => {
    const { cli, book } = await workspace(options);
    const done = await cli(['outline', 'derive', '--book']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as Derived;
    expect(result.sections).toBe(2);
    expect(result.entries.map((entry) => [entry.kind, entry.id, entry.label, entry.title, entry.page, entry.depth])).toEqual(book.chapters.map((chapter) => ['section', chapter.number, chapter.number, chapter.title, chapter.page, 0]));
    expect(result.notes.join(' ')).toMatch(/chapters are the sections/);
    const text = await cli(['outline', 'derive', '--book'], { json: false });
    expect(text.stdout).toContain('2 sections');
  });

  it('proposes and applies the five exercises, each on its own page with its region down to the last ink, and verifies without a finding', async () => {
    const { cli, book } = await workspace(options);
    expect((await cli(['outline', 'derive', '--book', '--apply'])).code).toBe(0);
    const done = await cli(['exercises', 'propose', '--apply']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as Proposed;
    expect(result.applied).toBe(true);
    expect(result.proposals.map((entry) => `${entry.section}:${entry.label}@${entry.page}`)).toEqual(book.exercises.map((entry) => `${entry.section}:${entry.label}@${entry.page}`));
    expect(result.book?.exercises).toBe(5);
    // The region of the exercise with the figure reaches below the figure; the one of the plain text ends under its lines.
    const bottom = (label: string): number => result.proposals.find((entry) => entry.label === label)?.rect.bottom ?? 0;
    expect(bottom('1.2')).toBeGreaterThan(0.47);
    expect(bottom('1.1')).toBeLessThan(0.23);
    for (const truth of book.exercises) expect(Math.abs(bottom(truth.label) - truth.lastInk), truth.label).toBeLessThan(0.012);
    expect(result.proposals.every((entry) => entry.continues === undefined)).toBe(true);
    // With the pixel check: the border of the box that is drawn around every statement is inside each region, no edge stands on it.
    const verified = await cli(['exercises', 'verify', '--ink']);
    expect(verified.code).toBe(0);
    const report = verified.json.result as unknown as { summary: { errors: number; warnings: number; exercises: number }; findings: { code: string; severity: string }[] };
    expect(report.summary).toMatchObject({ exercises: 5, errors: 0, warnings: 0 });
    expect(report.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
  });

  it('passes the gate with the pixel check, with nothing open', async () => {
    const { cli } = await workspace(options);
    await cli(['outline', 'derive', '--book', '--apply']);
    await cli(['exercises', 'propose', '--apply']);
    const done = await cli(['audit', 'gate', '--ink']);
    expect(done.code).toBe(0);
    const gate = done.json.result as unknown as { passed: boolean; open: { code: string }[] };
    expect(gate.passed).toBe(true);
    expect(gate.open).toEqual([]);
  });

  it('changes nothing when it is applied again', async () => {
    const { cli } = await workspace(options);
    await cli(['outline', 'derive', '--book', '--apply']);
    await cli(['exercises', 'propose', '--apply']);
    const again = await cli(['exercises', 'propose', '--apply']);
    expect(again.code).toBe(0);
    const result = again.json.result as unknown as Proposed;
    expect(result.applied).toBe(false);
    expect(result.counts).toMatchObject({ added: 0, unchanged: 5, changed: 0, replaced: 0 });
    expect(result.operations).toEqual([]);
  });
});
