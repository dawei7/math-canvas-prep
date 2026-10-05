import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const bin = new URL('../bin/mcprep.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dist = new URL('../dist/index.js', import.meta.url);
const sample = new URL('../../../examples/sample.pdf', import.meta.url);
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function mcprep(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!existsSync(dist))('the built mcprep binary', () => {
  it('marks the sample end to end as a separate process, with exit codes and JSON on stdout only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprep-bin-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'sheet.pdf'), readFileSync(sample));
    expect(mcprep(dir, 'init', 'sheet.pdf', '--title', 'Binary test').status).toBe(0);
    const proposed = mcprep(dir, 'propose', '--apply', '--json');
    expect(proposed.status).toBe(0);
    expect(proposed.stderr).toBe('');
    expect(JSON.parse(proposed.stdout)).toMatchObject({ ok: true, command: 'propose', result: { applied: true, counts: { exercise: 5 } } });
    const exported = mcprep(dir, 'export', '--json');
    expect(exported.status).toBe(0);
    const bundle = (JSON.parse(exported.stdout) as { result: { path: string } }).result.path;
    expect(mcprep(dir, 'import-check', bundle).status).toBe(0);
    const failure = mcprep(dir, 'frames', 'add', '--kind', 'exercise', '--page', '9', '--rect', '0.1,0.1,0.9,0.2', '--json');
    expect(failure.status).toBe(4);
    expect(JSON.parse(failure.stdout)).toMatchObject({ ok: false, error: { code: 'E_PAGE' } });
    expect(mcprep(dir, 'nonsense').status).toBe(2);
    expect(mcprep(dir, '--version').stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('draws the overview sheets of a PDF as a separate process: the files, JSON on standard output only, and a usage error for a range without pages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprep-bin-pages-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'sheet.pdf'), readFileSync(sample));
    const done = mcprep(dir, 'pages', 'sheets', '--pdf', 'sheet.pdf', '--out', 'overview', '--per-sheet', '2', '--json');
    expect(done.status).toBe(0);
    expect(done.stderr).toBe('');
    expect(JSON.parse(done.stdout)).toMatchObject({ ok: true, command: 'pages sheets', result: { pageCount: 3, perSheet: 2, columns: 2, sheets: 2, rendered: [1, 2] } });
    expect(readdirSync(join(dir, 'overview')).sort()).toEqual(['overview-0001.png', 'overview-0002.png', 'overview.json']);
    expect(readFileSync(join(dir, 'overview', 'overview-0001.png')).subarray(1, 4).toString()).toBe('PNG');
    const manifest = JSON.parse(readFileSync(join(dir, 'overview', 'overview.json'), 'utf8')) as { format: string; sheets: { pages: number[] }[] };
    expect(manifest.format).toBe('math-canvas-overview');
    expect(manifest.sheets.map((sheet) => sheet.pages)).toEqual([[0, 1], [2]]);
    const empty = mcprep(dir, 'pages', 'sheets', '--pdf', 'sheet.pdf', '--out', 'none', '--from', '2', '--to', '1', '--json');
    expect(empty.status).toBe(2);
    expect(JSON.parse(empty.stdout)).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });
    expect(existsSync(join(dir, 'none'))).toBe(false);
  });

  it('appends each command to the file that MCPREP_CALL_LOG names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprep-bin-log-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'sheet.pdf'), readFileSync(sample));
    const run = (...args: string[]): number | null => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCPREP_CALL_LOG: 'calls.jsonl' } }).status;
    expect(run('init', 'sheet.pdf', '--title', 'Binary test')).toBe(0);
    expect(run('lines', '99')).toBe(4);
    expect(run('--version')).toBe(0);
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n')).toEqual([
      '{"arguments":{"_":["sheet.pdf"],"title":"Binary test"},"exitCode":0,"ok":true,"surface":"cli","tool":"init"}',
      '{"arguments":{"_":["99"]},"error":"E_PAGE","exitCode":4,"ok":false,"surface":"cli","tool":"lines"}',
    ]);
  });
});
