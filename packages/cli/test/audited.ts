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

export interface SurveyEntry {
  from: number;
  to: number;
  kind: 'exercises' | 'answers' | 'both' | 'text' | 'blank' | 'front' | 'back';
  note?: string;
}

/**
 * The survey record of the synthetic workbook as a careful person would write it from the overview pictures: what each page holds, in ranges. It is
 * written from the truth of the builder (which page has an exercise printed on it, which an answer), never from the project, so that a project that was
 * damaged shows as a disagreement. The cover, the notice and the contents are front matter, a chapter opener and a lesson are text, the practice sets
 * hold exercises and the key at the back holds answers; the workbook has no back matter and no blank page.
 */
export async function surveyRecord(_dir?: string): Promise<SurveyEntry[]> {
  const book = buildSyntheticBook();
  const truth = book.truth;
  const exercises = new Set<number>(truth.items.flatMap((item) => item.anchors.map((anchor) => anchor.page)));
  const answers = new Set<number>(truth.answers.flatMap((answer) => answer.anchors.map((anchor) => anchor.page)));
  const firstOpener = Math.min(...truth.chapters.map((chapter) => chapter.openerPage));
  const lastAnswer = Math.max(...answers);
  const kindOf = (page: number): SurveyEntry['kind'] => {
    if (exercises.has(page)) return answers.has(page) ? 'both' : 'exercises';
    if (answers.has(page)) return 'answers';
    if (page < firstOpener) return 'front';
    return page > lastAnswer ? 'back' : 'text';
  };
  const entries: SurveyEntry[] = [];
  for (let page = 0; page < book.pageCount; page += 1) {
    const kind = kindOf(page);
    const last = entries[entries.length - 1];
    if (last !== undefined && last.kind === kind && last.to === page - 1) last.to = page;
    else entries.push({ from: page, to: page, kind });
  }
  return entries;
}

/** Writes the survey record of the workbook as `file` in `dir` (a list of ranges) and returns it. */
export async function writeSurveyRecord(dir: string, file = 'survey.json'): Promise<SurveyEntry[]> {
  const entries = await surveyRecord(dir);
  await writeFile(join(dir, file), JSON.stringify(entries));
  return entries;
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
