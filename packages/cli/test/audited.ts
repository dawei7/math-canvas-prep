import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame, Project } from '@mcprep/core';
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

export interface VisualEntry {
  ref: string;
  startsWith: string;
  instruction: boolean;
  answerStartsWith: string;
  ok: boolean;
  defect?: string;
}

/**
 * The visual record of the synthetic workbook as a careful person would write it: for every exercise the first three words printed after
 * its number (the book's own truth says what is printed, not the text layer), whether it has an instruction, the number its answer starts
 * with. Written from the project in `dir` as it is NOW, so a defect that was injected shows in the instruction column only when the
 * person writing it looked at the cell.
 */
export async function visualRecord(dir: string): Promise<VisualEntry[]> {
  const truth = buildSyntheticBook().truth;
  const project = JSON.parse(await readFile(join(dir, 'book.mcprep.json'), 'utf8')) as Project;
  const frames = new Map<string, Frame>(project.frames.filter((frame) => frame.authority === 'book').map((frame) => [`${frame.section as string}:${frame.label as string}`, frame]));
  const entries: VisualEntry[] = [];
  for (const item of truth.items) {
    const ref = `${item.section}:${item.label}`;
    const frame = frames.get(ref);
    const words = item.text.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    entries.push({ ref, startsWith: words === '' ? `${item.label})` : words, instruction: (frame?.context?.length ?? 0) > 0, answerStartsWith: (frame?.solution?.length ?? 0) > 0 ? item.label : '', ok: true });
  }
  return entries;
}
