import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { buildSampleSheet } from '@mcprep/core/testing';
import { run } from '../src/run.js';

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

export async function tempDir(prefix = 'mcprep-cli-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
  /** The JSON document on standard output (--json), parsed. */
  json: { ok: boolean; command: string; result: Record<string, unknown>; warnings?: Record<string, unknown>[]; notes?: string[]; error?: { code: string; message: string; hint?: string; issues?: Record<string, unknown>[] } };
}

export interface Cli {
  dir: string;
  /** Runs `mcprep <args>` in `dir`; adds --json when `json` is true (the default). */
  (args: string[], options?: { json?: boolean; stdin?: string; env?: Record<string, string> }): Promise<Result>;
}

/** A folder holding the synthetic sample as sheet.pdf, and a runner for the command line in it. */
export async function workspace(options: { init?: boolean } = {}): Promise<Cli> {
  const dir = await tempDir();
  await writeFile(join(dir, 'sheet.pdf'), buildSampleSheet().pdf);
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
  if (options.init !== false) {
    const made = await cli(['init', 'sheet.pdf', '--title', 'Calculus Sheet 1', '--folder', 'Examples/Calculus']);
    if (made.code !== 0) throw new Error(`init failed: ${made.stdout}${made.stderr}`);
  }
  return cli;
}

export const isPng = (bytes: Uint8Array): boolean => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
