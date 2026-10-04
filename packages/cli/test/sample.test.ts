import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticBook } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import { isPng, tempDir, type Cli, type Result } from './helpers.js';

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => { compile(schema: object): Validator } };
let valid: Validator;
beforeAll(() => {
  const schema = JSON.parse(readFileSync(new URL('../../../schemas/sample.schema.json', import.meta.url), 'utf8')) as object;
  valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
});

interface Entry {
  ref: string;
  reason: string;
  reasons: string[];
  page: number;
  kind: string;
  region: string;
}
interface Report {
  format: string;
  version: number;
  options: { exercises: number; solutions: number; perSection: boolean };
  summary: { sections: number; exercises: number; withSolution: number; sampledExercises: number; sampledSolutions: number };
  exercises: Entry[];
  solutions: Entry[];
  notes: string[];
  crops?: { ref: string; kind: string; region: string; path: string }[];
}
const reportOf = (done: Result): Report => done.json.result as unknown as Report;

/** The synthetic workbook audited by the real proposals (sections, exercises with their answers). */
async function auditedBook(): Promise<Cli> {
  const dir = await tempDir();
  await writeFile(join(dir, 'book.pdf'), buildSyntheticBook().pdf);
  const cli = (async (args, opts = {}) => {
    let out = '';
    let err = '';
    const code = await run(opts.json === false ? args : [...args, '--json'], { stdout: (text) => void (out += text), stderr: (text) => void (err += text), stdin: () => Promise.resolve(opts.stdin ?? ''), cwd: dir, env: { ...opts.env } });
    let json: Result['json'] = { ok: false, command: '', result: {} };
    if (opts.json !== false && out.trim().startsWith('{')) json = JSON.parse(out) as Result['json'];
    return { code, stdout: out, stderr: err, json };
  }) as Cli;
  Object.defineProperty(cli, 'dir', { value: dir });
  for (const args of [['init', 'book.pdf', '--title', 'Synthetic Algebra Workbook'], ['outline', 'derive', '--book', '--apply'], ['exercises', 'propose', '--solutions', '--apply']]) {
    const made = await cli(args);
    if (made.code !== 0) throw new Error(`${args.join(' ')} failed: ${made.stdout}${made.stderr}`);
  }
  return cli;
}

describe('exercises sample', () => {
  it('has at most 40 exercises and 20 answers: the layouts of the book, the first and the last exercise of every chapter and section, a stride', async () => {
    const cli = await auditedBook();
    const done = await cli(['exercises', 'sample']);
    expect(done.code).toBe(0);
    const report = reportOf(done);
    expect(valid(report), JSON.stringify(valid.errors)).toBe(true);
    expect(report.summary).toMatchObject({ sections: 4, exercises: 112, withSolution: 112, sampledExercises: 40, sampledSolutions: 20 });
    expect(report.options).toEqual({ exercises: 40, solutions: 20, perSection: false });
    expect(report.exercises).toHaveLength(40);
    expect(report.solutions).toHaveLength(20);
    const refs = report.exercises.map((entry) => entry.ref);
    for (const ref of ['0.1:1', '0.1:70', '0.2:1', '0.2:14', '1.1:1', '1.1:12', '1.2:1', '1.2:16']) expect(refs, ref).toContain(ref);
    const reasons = new Set(report.exercises.flatMap((entry) => entry.reasons));
    for (const reason of ['first-in-section', 'last-in-section', 'has-continuation', 'context-on-another-page', 'two-in-a-row', 'three-in-a-row', 'longest', 'smallest', 'beside-a-figure', 'stride']) expect(reasons.has(reason), reason).toBe(true);
    expect(report.notes).toEqual(['No exercise goes on over two or more further pages.', 'No answer is a picture without text.', 'The answers of the other sampled exercises: 13 of 33 taken, thinned by an even stride to stay within 20 answers.']);
    expect(report.exercises.every((entry) => entry.kind === 'exercise' && entry.region === 'main')).toBe(true);
    expect(report.solutions.every((entry) => entry.kind === 'solution' && entry.region === 'solution:0')).toBe(true);
    expect(report.solutions.find((entry) => entry.ref === '0.1:1')?.reasons).toContain('first-of-chapter-key');
    expect(new Set(report.solutions.flatMap((entry) => entry.reasons)).has('most-lines')).toBe(true);
    // Bookwise order: sections as the outline has them.
    expect(refs.indexOf('0.1:70')).toBeLessThan(refs.indexOf('0.2:1'));
    const text = await cli(['exercises', 'sample'], { json: false });
    expect(text.stdout).toContain('Sample to look at: 40 exercises and 20 answers (the book has 112 exercises in 4 sections, 112 with an answer).');
    // The reasons are named in the order of the rules: the layouts come first.
    expect(text.stdout).toMatch(/0\.1:1\s+two-in-a-row, first-in-section\s+5\s+main/);
    expect(text.stdout).toMatch(/crop <ref> --region solution:0/);
  });

  it('is the same list every time, and after the frames of the file are put in another order', async () => {
    const cli = await auditedBook();
    const first = reportOf(await cli(['exercises', 'sample']));
    expect(reportOf(await cli(['exercises', 'sample']))).toEqual(first);
    const path = join(cli.dir, 'book.mcprep.json');
    const project = JSON.parse(await readFile(path, 'utf8')) as { frames: unknown[] };
    project.frames.reverse();
    const half = Math.floor(project.frames.length / 2);
    project.frames = [...project.frames.slice(half), ...project.frames.slice(0, half)];
    await writeFile(path, JSON.stringify(project));
    expect(reportOf(await cli(['exercises', 'sample']))).toEqual(first);
  });

  it('is as large as the caps say, and leaves a half out for 0', async () => {
    const cli = await auditedBook();
    const bigger = reportOf(await cli(['exercises', 'sample', '--exercises', '60', '--solutions', '30']));
    expect(bigger.summary).toMatchObject({ sampledExercises: 60, sampledSolutions: 30 });
    const small = reportOf(await cli(['exercises', 'sample', '--exercises', '8', '--solutions', '3']));
    expect(small.summary).toMatchObject({ sampledExercises: 8, sampledSolutions: 3 });
    expect(small.notes).toContain('Sections: no room is left in 8 exercises for the first and the last exercise of the 4 sections; --per-section takes every section.');
    const none = reportOf(await cli(['exercises', 'sample', '--exercises', '0']));
    expect(none.exercises).toEqual([]);
    expect(none.solutions.length).toBeGreaterThan(0);
    const without = reportOf(await cli(['exercises', 'sample', '--solutions', '0']));
    expect(without.solutions).toEqual([]);
    expect((await cli(['exercises', 'sample', '--exercises', '-1'])).code).toBe(2);
    expect((await cli(['exercises', 'sample', '--solutions', '2.5'])).code).toBe(2);
  });

  it('with --per-section takes the first and the last exercise of every section beyond the caps', async () => {
    const cli = await auditedBook();
    const done = await cli(['exercises', 'sample', '--exercises', '6', '--per-section']);
    const report = reportOf(done);
    expect(valid(report), JSON.stringify(valid.errors)).toBe(true);
    expect(report.options).toEqual({ exercises: 6, solutions: 20, perSection: true });
    const refs = report.exercises.map((entry) => entry.ref);
    for (const ref of ['0.1:1', '0.1:70', '0.2:1', '0.2:14', '1.1:1', '1.1:12', '1.2:1', '1.2:16']) expect(refs, ref).toContain(ref);
    expect(report.exercises.length).toBeGreaterThan(6);
    const answered = new Set(report.solutions.map((entry) => entry.ref));
    for (const ref of refs) expect(answered.has(ref), ref).toBe(true);
    expect(report.notes.some((note) => note.startsWith('--per-section: the first and the last exercise of every section are in the sample'))).toBe(true);
    const without = reportOf(await cli(['exercises', 'sample', '--exercises', '6']));
    expect(without.exercises).toHaveLength(6);
  });

  it('writes the sample to --out and the crops of every region, named by reference and kind', async () => {
    const cli = await auditedBook();
    const done = await cli(['exercises', 'sample', '--exercises', '6', '--solutions', '2', '--crops', 'sample', '--out', 'sample.json']);
    expect(done.code, done.stdout).toBe(0);
    const report = reportOf(done);
    expect(valid(report), JSON.stringify(valid.errors)).toBe(true);
    const written = JSON.parse(await readFile(join(cli.dir, 'sample.json'), 'utf8')) as Report;
    expect(written).toEqual(report);
    const files = (await readdir(join(cli.dir, 'sample'))).sort();
    expect(files).toEqual([...new Set(files)]);
    // The six layout exercises, two answers (the first and the last of the six).
    for (const name of ['0.1_1-exercise.png', '0.1_45-exercise.png', '0.2_11-exercise.png', '1.1_1-exercise.png', '1.2_1-exercise.png', '1.2_7-exercise.png', '0.2_11-solution.png', '1.1_1-solution.png']) expect(files, name).toContain(name);
    // The first continuation and the instruction on another page are cropped too.
    expect(files).toContain('0.2_11-continues0.png');
    expect(files).toContain('0.1_45-context0.png');
    expect(report.crops?.length).toBe(files.length);
    for (const crop of report.crops ?? []) expect(isPng(await readFile(crop.path)), crop.path).toBe(true);
    const text = await cli(['exercises', 'sample', '--crops', 'again'], { json: false });
    expect(text.stdout).toMatch(/Wrote \d+ crops, named by reference and kind/);
  });

  it('says there is nothing to sample before any exercise was audited', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'book.pdf'), buildSyntheticBook().pdf);
    let out = '';
    const cli = async (args: string[]): Promise<number> => run([...args, '--json'], { stdout: (text) => void (out += text), stderr: () => undefined, stdin: () => Promise.resolve(''), cwd: dir, env: {} });
    expect(await cli(['init', 'book.pdf'])).toBe(0);
    out = '';
    expect(await cli(['exercises', 'sample'])).toBe(0);
    const report = (JSON.parse(out) as { result: Report }).result;
    expect(report.exercises).toEqual([]);
    expect(report.notes[0]).toContain('no book exercises');
  });

  it('prints its schema', async () => {
    const cli = await auditedBook();
    const done = await cli(['schema', 'sample']);
    expect(done.code).toBe(0);
    expect((done.json.result as { name: string }).name).toBe('sample');
  });
});
