import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { buildAuthoritySample, type AuthoritySample } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import type { Cli, Result } from './helpers.js';

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

export const sample: AuthoritySample = buildAuthoritySample();

/** The `add` operations that mark every exercise of the synthetic workbook, as `frames apply` takes them. */
export function addOperations(options: { replace?: boolean } = {}): Record<string, unknown>[] {
  return sample.exercises.map((entry) => ({
    op: 'add',
    authority: 'book',
    label: entry.label,
    section: entry.section,
    page: entry.page,
    rect: entry.rect,
    ...(entry.context ? { context: entry.context } : {}),
    ...(entry.continues ? { continues: entry.continues } : {}),
    solution: entry.solution,
    ...(options.replace === true ? { replace: true } : {}),
  }));
}

/** A folder holding the synthetic workbook as book.pdf, and a runner for the command line in it. */
export async function bookWorkspace(options: { init?: boolean; sections?: boolean; exercises?: boolean } = {}): Promise<Cli> {
  const dir = await mkdtemp(join(tmpdir(), 'mcprep-book-'));
  created.push(dir);
  await writeFile(join(dir, 'book.pdf'), sample.pdf);
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
  const must = async (args: string[], opts: Parameters<Cli>[1] = {}): Promise<void> => {
    const made = await cli(args, opts);
    if (made.code !== 0) throw new Error(`${args.join(' ')} failed: ${made.stdout}${made.stderr}`);
  };
  if (options.init !== false) {
    await must(['init', 'book.pdf', '--title', sample.title, '--folder', 'Books/Algebra']);
    if (options.sections === true || options.exercises === true) await must(['outline', 'set', '-'], { stdin: JSON.stringify(sample.sections) });
    if (options.exercises === true) await must(['frames', 'apply', '-'], { stdin: JSON.stringify(addOperations()) });
  }
  return cli;
}
