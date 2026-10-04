import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSyntheticBook } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import { tempDir, type Cli, type Result } from './helpers.js';

/** The synthetic workbook audited by the real proposals (sections, exercises with their answers): a folder with book.pdf and its project. */
export async function auditedBook(): Promise<Cli> {
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
