import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticBook } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import { bookWorkspace } from './book-helpers.js';
import { tempDir, type Cli, type Result } from './helpers.js';

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => { compile(schema: object): Validator } };
let valid: Validator;
beforeAll(() => {
  const schema = JSON.parse(readFileSync(new URL('../../../schemas/verify.schema.json', import.meta.url), 'utf8')) as object;
  valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
});

interface Finding {
  code: string;
  severity: string;
  ref: string;
  page: number | null;
  message: string;
  evidence: string;
}
interface Report {
  format: string;
  version: number;
  summary: { exercises: number; authoritative: number; sections: number; solutions: number; errors: number; warnings: number; infos: number };
  findings: Finding[];
  sections: { id: string; label: string | null; exercises: number; firstLabel: string | null; lastLabel: string | null; withSolution: number; gaps: string[]; duplicates: string[] }[];
  findingsOmitted?: number;
}
const reportOf = (done: Result): Report => done.json.result as unknown as Report;

/** The synthetic workbook audited by the real proposals (sections, exercises with their answers), in a folder of its own. */
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

describe('exercises verify', () => {
  it('finds nothing to report in a book that the proposals audited, and says so', async () => {
    const cli = await auditedBook();
    const done = await cli(['exercises', 'verify']);
    expect(done.code).toBe(0);
    const report = reportOf(done);
    expect(valid(report), JSON.stringify(valid.errors)).toBe(true);
    expect(report.summary).toMatchObject({ exercises: 112, authoritative: 112, sections: 4, solutions: 112, errors: 0, warnings: 0, infos: 0 });
    expect(report.findings).toEqual([]);
    expect(report.sections.map((section) => [section.id, section.exercises, section.firstLabel, section.lastLabel])).toEqual([['0.1', 70, '1', '70'], ['0.2', 14, '1', '14'], ['1.1', 12, '1', '12'], ['1.2', 16, '1', '16']]);
    const text = await cli(['exercises', 'verify'], { json: false });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Checked 112 exercises in 4 sections: 0 errors, 0 warnings, 0 infos. 112 of 112 book exercises have a solution (100%).');
    expect(text.stdout).toContain('Nothing to report.');
    expect(text.stdout).toMatch(/0\.1\s+0\.1\s+70\s+1\.\.70\s+70\/70/);
  });

  it('lists what is wrong in a fixed order and exits with 4 on an error, or 0 with --fail-on none', async () => {
    const cli = await auditedBook();
    // A label that is not what the page prints, and an answer that is moved to another exercise's answer.
    const relabelled = await cli(['exercises', 'label', '0.1:5', '95']);
    expect(relabelled.code, relabelled.stdout).toBe(0);
    const done = await cli(['exercises', 'verify']);
    expect(done.code).toBe(4);
    expect(done.json.ok).toBe(false);
    const report = reportOf(done);
    expect(valid(report), JSON.stringify(valid.errors)).toBe(true);
    expect(report.summary.errors).toBeGreaterThanOrEqual(2);
    const first = report.findings[0] as Finding;
    expect(first).toMatchObject({ severity: 'error', ref: '0.1:95' });
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['label-not-first', 'solution-label-missing']));
    const severities = report.findings.map((finding) => finding.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
    expect((await cli(['exercises', 'verify', '--fail-on', 'none'])).code).toBe(0);
    expect((await cli(['exercises', 'verify', '--fail-on', 'warning'])).code).toBe(4);
    const text = await cli(['exercises', 'verify'], { json: false });
    expect(text.code).toBe(4);
    expect(text.stdout).toContain('error [label-not-first] 0.1:95 (page ');
    expect(text.stdout).toContain('    found: 5)');
  });

  it('asks for the severity that fails the run: a warning fails --fail-on warning, not the default', async () => {
    const cli = await bookWorkspace({ exercises: true });
    // The synthetic workbook of the tests has no answers for two exercises once their solutions are cleared.
    for (const reference of ['1.2:1', '1.2:2', '1.2:3']) await cli(['solution', 'clear', reference]);
    // The key still prints those three answers, so the whole book has an answer left behind (an error); the section alone has only the warning.
    const whole = await cli(['exercises', 'verify']);
    expect(reportOf(whole).findings.some((finding) => finding.code === 'answer-left-behind')).toBe(true);
    expect(whole.code).toBe(4);
    const done = await cli(['exercises', 'verify', '--section', '1.2']);
    const report = reportOf(done);
    expect(report.findings.find((finding) => finding.code === 'no-solution')).toMatchObject({ severity: 'warning', ref: '1.2' });
    expect(done.code).toBe(0);
    expect((await cli(['exercises', 'verify', '--section', '1.2', '--fail-on', 'warning'])).code).toBe(4);
  });

  it('checks the sections it is named, repeated or separated by commas, and refuses one that does not exist', async () => {
    const cli = await auditedBook();
    const twice = reportOf(await cli(['exercises', 'verify', '--section', '0.2', '--section', '1.1']));
    expect(twice.sections.map((section) => section.id)).toEqual(['0.2', '1.1']);
    expect(twice.summary).toMatchObject({ exercises: 26, authoritative: 26, sections: 2 });
    const comma = reportOf(await cli(['exercises', 'verify', '--section', '0.2,1.1']));
    expect(comma).toEqual(twice);
    const wrong = await cli(['exercises', 'verify', '--section', '9.9']);
    expect(wrong.code).toBe(2);
    expect(wrong.json.error?.code).toBe('E_USAGE');
    expect(wrong.json.error?.hint).toContain('0.1');
    expect((await cli(['exercises', 'verify', '--fail-on', 'sometimes'])).code).toBe(2);
    expect((await cli(['exercises', 'verify', '--item-pattern', '^(\\d+'])).code).toBe(2);
  });

  it('writes the whole report to --details, the same as it prints', async () => {
    const cli = await auditedBook();
    await cli(['exercises', 'label', '0.1:1', '1001']);
    const done = await cli(['exercises', 'verify', '--details', 'verify.json']);
    const written = JSON.parse(await readFile(join(cli.dir, 'verify.json'), 'utf8')) as Report;
    expect(valid(written), JSON.stringify(valid.errors)).toBe(true);
    expect(written.findings.length).toBeGreaterThan(0);
    expect(written).toEqual(reportOf(done));
    expect(done.json.result).not.toHaveProperty('findingsOmitted');
    const text = await cli(['exercises', 'verify', '--details', 'again.json'], { json: false });
    expect(text.stdout).toContain('Wrote the whole report to again.json.');
  });

  it('prints the first 300 findings and says how many it left out; --details has them all', async () => {
    const cli = await auditedBook();
    // 350 exercises in a corner of the cover page, on no text: a warning each, and they overlap.
    const operations: Record<string, unknown>[] = [];
    for (let at = 0; at < 350; at += 1) {
      const left = 0.02 + (at % 20) * 0.045;
      const top = 0.02 + Math.floor(at / 20) * 0.02;
      operations.push({ op: 'add', authority: 'book', section: '1.1', label: String(200 + at), page: 0, rect: [left, top, left + 0.04, top + 0.018] });
    }
    const added = await cli(['frames', 'apply', '-', '--force'], { stdin: JSON.stringify(operations) });
    expect(added.code, added.stdout).toBe(0);
    const done = await cli(['exercises', 'verify', '--details', 'all.json']);
    const report = reportOf(done);
    expect(valid(report), JSON.stringify(valid.errors)).toBe(true);
    expect(report.findings).toHaveLength(300);
    expect(report.findingsOmitted).toBeGreaterThan(0);
    expect(report.summary.errors + report.summary.warnings + report.summary.infos).toBe(300 + (report.findingsOmitted as number));
    const all = JSON.parse(await readFile(join(cli.dir, 'all.json'), 'utf8')) as Report;
    expect(valid(all), JSON.stringify(valid.errors)).toBe(true);
    expect(all.findings).toHaveLength(300 + (report.findingsOmitted as number));
    expect(all.findings.slice(0, 300)).toEqual(report.findings);
    expect(all).not.toHaveProperty('findingsOmitted');
    const text = await cli(['exercises', 'verify'], { json: false });
    expect(text.stdout).toMatch(/\.\.\. and \d+ more \(--details FILE writes them all\)/);
  });

  it('is the same report every time, and the same through --json and --details', async () => {
    const cli = await auditedBook();
    await cli(['exercises', 'label', '0.1:7', '7x']);
    const first = reportOf(await cli(['exercises', 'verify']));
    const second = reportOf(await cli(['exercises', 'verify']));
    expect(second).toEqual(first);
    expect(first.findings.length).toBeGreaterThan(0);
  });

  it('reads the labels of a book that numbers differently with --item-pattern', async () => {
    const cli = await auditedBook();
    const done = await cli(['exercises', 'verify', '--item-pattern', '^Problem\\s+(\\d+)\\.']);
    expect(done.code).toBe(0);
  });

  it('prints its schema', async () => {
    const cli = await auditedBook();
    const done = await cli(['schema', 'verify']);
    expect(done.code).toBe(0);
    expect((done.json.result as { name: string }).name).toBe('verify');
    const listed = await cli(['schema']);
    expect((listed.json.result as { schemas: string[] }).schemas).toContain('verify');
  });
});
