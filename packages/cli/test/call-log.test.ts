import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir, workspace } from './helpers.js';

const script = resolve(fileURLToPath(new URL('../../../scripts/compare-calls.mjs', import.meta.url)));

interface Entry {
  surface: 'mcp' | 'cli';
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: string;
  exitCode?: number;
}

const lines = async (file: string): Promise<string[]> => (await readFile(file, 'utf8')).trim().split('\n');
const entries = async (file: string): Promise<Entry[]> => (await lines(file)).map((line) => JSON.parse(line) as Entry);

describe('the command line writes the call log when MCPREP_CALL_LOG is set', () => {
  it('writes nothing without it', async () => {
    const cli = await workspace();
    await cli(['info']);
    await expect(readFile(join(cli.dir, 'calls.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('appends one line for each command: its name, the options as parsed, the positional arguments under _, the outcome', async () => {
    const cli = await workspace();
    const env = { MCPREP_CALL_LOG: 'calls.jsonl' };
    expect((await cli(['info'], { env })).code).toBe(0);
    expect((await cli(['lines', '0', '--fonts'], { env })).code).toBe(0);
    expect((await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.2,0.9,0.3', '--snap'], { env })).code).toBe(0);
    expect((await cli(['crop', '--all', '--max-side', '300', '--section', '1.3'], { env })).code).toBe(4);
    expect((await cli(['lines', '99'], { env })).code).toBe(4);
    expect((await cli(['lines'], { env })).code).toBe(2);
    expect((await cli(['validate', '--strict'], { env })).code).toBe(0);
    const file = join(cli.dir, 'calls.jsonl');
    const logged = await entries(file);
    expect(logged.map((entry) => entry.tool)).toEqual(['info', 'lines', 'frames add', 'crop', 'lines', 'lines', 'validate']);
    expect(logged.every((entry) => entry.surface === 'cli')).toBe(true);
    expect(logged[0]).toEqual({ surface: 'cli', tool: 'info', arguments: {}, ok: true, exitCode: 0 });
    expect(logged[1]?.arguments).toEqual({ _: ['0'], fonts: true });
    expect(logged[2]?.arguments).toEqual({ kind: 'exercise', page: '0', rect: '0.1,0.2,0.9,0.3', snap: true });
    expect(logged[3]).toMatchObject({ arguments: { all: true, 'max-side': 300, section: '1.3' }, ok: false, error: 'E_NO_FRAME', exitCode: 4 });
    expect(logged[4]).toMatchObject({ arguments: { _: ['99'] }, ok: false, error: 'E_PAGE', exitCode: 4 });
    expect(logged[5]).toMatchObject({ arguments: {}, ok: false, error: 'E_USAGE', exitCode: 2 });
    expect(logged[6]).toMatchObject({ arguments: { strict: true }, ok: true });
    // --json only chooses the output: it is not an argument of the call. The keys of every line are in sorted order.
    expect(JSON.stringify(logged[1])).not.toContain('json');
    expect((await lines(file))[1]).toBe('{"arguments":{"_":["0"],"fonts":true},"exitCode":0,"ok":true,"surface":"cli","tool":"lines"}');
  });

  it('does not log a request for help, the version or an unknown command', async () => {
    const cli = await workspace();
    const env = { MCPREP_CALL_LOG: 'calls.jsonl' };
    await cli(['help'], { env, json: false });
    await cli(['lines', '--help'], { env, json: false });
    await cli(['--version'], { env, json: false });
    await cli(['nonsense'], { env });
    await expect(readFile(join(cli.dir, 'calls.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('reports a log that cannot be written on standard error and leaves the result alone', async () => {
    const cli = await workspace();
    const done = await cli(['info'], { env: { MCPREP_CALL_LOG: cli.dir } });
    expect(done.code).toBe(0);
    expect(done.stderr).toContain('the call log');
    expect(done.stderr).toContain('cannot be written');
    expect(done.json.ok).toBe(true);
  });
});

describe('scripts/compare-calls.mjs', () => {
  interface Script {
    TOOLS: Record<string, { command: string }>;
    normalizePath(text: string): string;
    parseLog(text: string, name?: string): Entry[];
    compareCalls(a: Entry[], b: Entry[], options?: { strict?: boolean }): { identical: boolean; calls: { a: number; b: number }; divergence?: { index: number; a: string | null; b: string | null }; onlyInA: { tool: string; count: number }[]; onlyInB: { tool: string; count: number }[]; outcomes: unknown[] };
    formatComparison(result: unknown, names?: string[]): string;
  }
  const load = async (): Promise<Script> => (await import(pathToFileURL(script).href)) as Script;
  const call = (tool: string, args: Record<string, unknown>, extra: Partial<Entry> = {}): Entry => ({ surface: 'mcp', tool, arguments: args, ok: true, ...extra });
  const cli = (tool: string, args: Record<string, unknown>, extra: Partial<Entry> = {}): Entry => ({ surface: 'cli', tool, arguments: args, ok: true, ...extra });

  it('says how many calls two runs have in common when they are the same', async () => {
    const { compareCalls, formatComparison } = await load();
    const run = [call('create_project', { pdf: 'book.pdf' }), call('exercises_propose', { solutions: true }), call('exercises_verify', {})];
    const result = compareCalls(run, structuredClone(run));
    expect(result).toMatchObject({ identical: true, calls: { a: 3, b: 3 }, onlyInA: [], onlyInB: [] });
    expect(formatComparison(result)).toBe('identical: 3 calls');
  });

  it('names the first divergence and counts the calls that only one run made', async () => {
    const { compareCalls, formatComparison } = await load();
    const a = [call('create_project', { pdf: 'book.pdf' }), call('exercises_propose', { solutions: true, details_file: '/tmp/a/audit.json' }), call('render_crop', { frame: '1.2:5' }), call('render_crop', { frame: '1.2:6' })];
    const b = [call('create_project', { pdf: 'book.pdf' }), call('exercises_propose', { solutions: true }), call('render_crop', { frame: '1.2:5' })];
    const result = compareCalls(a, b);
    expect(result.identical).toBe(false);
    expect(result.divergence).toEqual({ index: 2, a: 'exercises_propose {"details":"<path>/a/audit.json","solutions":true}', b: 'exercises_propose {"solutions":true}' });
    expect(result.onlyInA).toEqual([{ tool: 'crop', count: 1 }, { tool: 'exercises propose', count: 1 }]);
    expect(result.onlyInB).toEqual([{ tool: 'exercises propose', count: 1 }]);
    const text = formatComparison(result);
    expect(text).toContain('different: A made 4 calls, B made 3.');
    expect(text).toContain('first divergence at call 2:');
    expect(text).toContain('only in A: 2 calls (crop, exercises propose)');
    // One run is a prefix of the other.
    const longer = compareCalls(b, [...b, call('validate', {})]);
    expect(longer.divergence).toEqual({ index: 4, a: null, b: 'validate {}' });
    expect(formatComparison(longer)).toContain('  A: (no more calls)');
  });

  it('takes absolute paths for the same wherever they are, with their last two segments', async () => {
    const { normalizePath, compareCalls } = await load();
    expect(normalizePath('C:\\work\\runs\\one\\books\\algebra.mcprep.json')).toBe('<path>/books/algebra.mcprep.json');
    expect(normalizePath('/home/someone/runs/two/books/algebra.mcprep.json')).toBe('<path>/books/algebra.mcprep.json');
    expect(normalizePath('C:/a.pdf')).toBe('<path>/a.pdf');
    expect(normalizePath('books/algebra.pdf')).toBe('books/algebra.pdf');
    expect(normalizePath('1.2:5')).toBe('1.2:5');
    const a = [call('create_project', { pdf: 'C:\\runs\\one\\books\\algebra.pdf', title: 'Algebra' })];
    const b = [call('create_project', { pdf: '/tmp/two/books/algebra.pdf', title: 'Algebra' })];
    expect(compareCalls(a, b).identical).toBe(true);
    expect(compareCalls(a, [call('create_project', { pdf: '/tmp/two/other/algebra.pdf', title: 'Algebra' })]).identical).toBe(false);
  });

  it('takes an MCP tool and the command that does the same for the same call', async () => {
    const { compareCalls } = await load();
    const pairs: [Entry, Entry][] = [
      [call('exercises_propose', { sections: ['0.2', '0.1'], solutions: true, details_file: '/a/x/audit.json', item_patterns: ['^Problem (\\d+)'], max_items: 50 }), cli('exercises propose', { section: '0.1,0.2', solutions: true, details: 'C:\\q\\x\\audit.json', 'item-pattern': ['^Problem (\\d+)'], 'max-items': 50 })],
      [call('render_page', { page: 3, grid: 0.1, frames: true, max_side: 800 }), cli('render', { _: ['3'], grid: 0.1, frames: true, 'max-side': 800 })],
      [call('render_crop', { frame: '1.2:5', region: 'context:0' }), cli('crop', { _: ['1.2:5'], region: 'context:0' })],
      [call('render_crop', { page: 2, rect: [0.1, 0.2, 0.9, 0.3] }), cli('crop', { page: '2', rect: '0.10,0.2,0.9,0.3' })],
      [call('validate', { text: false }), cli('validate', { 'no-text': true })],
      [call('outline_derive_book', { apply: true }), cli('outline derive', { book: true, apply: true })],
      [call('add_frame', { kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.3], snap: true, context: [{ page: 1, rect: [0.1, 0.1, 0.9, 0.2] }] }), cli('frames add', { kind: 'exercise', page: '0', rect: '0.1,0.2,0.9,0.3', snap: true, context: ['1:0.1,0.1,0.9,0.2'] })],
      [call('exercises_label', { id: '1.2:5', label: '5a' }), cli('exercises label', { _: ['1.2:5', '5a'] })],
      [call('merge_frames', { ids: ['f1', 'f2'] }), cli('frames merge', { _: ['f1', 'f2'] })],
      [call('split_frame', { id: 'f1', at: [0.4, 0.52], snap: true }), cli('frames split', { _: ['f1'], at: '0.4,0.52', snap: true })],
      [call('exercises_sample', { exercises: 40, crops_dir: 'sample' }), cli('exercises sample', { exercises: 40, crops: 'sample' })],
      [call('exercises_sample', { exercises: 10, solutions: 5, per_section: true }), cli('exercises sample', { exercises: 10, solutions: 5, 'per-section': true })],
      [call('create_project', { pdf: 'book.pdf', title: 'T' }), cli('init', { _: ['book.pdf'], title: 'T' })],
    ];
    for (const [mcp, line] of pairs) expect(compareCalls([mcp], [line]).identical, mcp.tool).toBe(true);
    // A real difference is still one.
    expect(compareCalls([call('exercises_propose', { solutions: true })], [cli('exercises propose', {})]).identical).toBe(false);
    expect(compareCalls([call('render_page', { page: 3 })], [cli('render', { _: ['4'] })]).identical).toBe(false);
  });

  it('compares the contents of a batch when both runs come from one surface, and only its name across surfaces', async () => {
    const { compareCalls } = await load();
    const one = call('apply_operations', { operations: [{ op: 'add', page: 1 }], dry_run: true });
    const other = call('apply_operations', { operations: [{ op: 'add', page: 2 }], dry_run: true });
    expect(compareCalls([one], [other]).identical).toBe(false);
    expect(compareCalls([one], [structuredClone(one)]).identical).toBe(true);
    expect(compareCalls([one], [cli('frames apply', { _: ['-'], 'dry-run': true })]).identical).toBe(true);
    expect(compareCalls([one], [cli('frames apply', { _: ['-'] })]).identical).toBe(false);
  });

  it('compares the outcomes only with --strict', async () => {
    const { compareCalls } = await load();
    const good = [call('render_page', { page: 3 })];
    const bad = [call('render_page', { page: 3 }, { ok: false, error: 'E_PAGE' })];
    expect(compareCalls(good, bad).identical).toBe(true);
    expect(compareCalls(good, bad).outcomes).toHaveLength(1);
    expect(compareCalls(good, bad, { strict: true }).identical).toBe(false);
  });

  it('reads a log, line by line, and says which line is not a call', async () => {
    const { parseLog } = await load();
    expect(parseLog('{"tool":"a","arguments":{}}\n\n{"surface":"cli","tool":"b","arguments":{"x":1},"ok":false}\n')).toEqual([
      { surface: 'mcp', tool: 'a', arguments: {}, ok: true, error: undefined },
      { surface: 'cli', tool: 'b', arguments: { x: 1 }, ok: false, error: undefined },
    ]);
    expect(() => parseLog('{"tool":"a"}\nnot json', 'run.jsonl')).toThrow('run.jsonl, line 2: not JSON');
    expect(() => parseLog('[1]', 'run.jsonl')).toThrow('run.jsonl, line 1: not a call');
  });

  it('runs as a program: exit code 0 for the same calls, 1 for different ones, 2 for a log it cannot read', async () => {
    const dir = await tempDir();
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    const c = join(dir, 'c.jsonl');
    const first = '{"arguments":{"pdf":"C:\\\\one\\\\books\\\\x.pdf"},"ok":true,"surface":"mcp","tool":"create_project"}\n{"arguments":{"solutions":true},"ok":true,"surface":"mcp","tool":"exercises_propose"}\n';
    await writeFile(a, first);
    await writeFile(b, first.replace('C:\\\\one', '/tmp/two').replace(/\\\\/g, '/'));
    await writeFile(c, '{"arguments":{"pdf":"/elsewhere/books/x.pdf"},"ok":true,"surface":"mcp","tool":"create_project"}\n');
    expect(execFileSync(process.execPath, [script, a, b], { encoding: 'utf8' })).toBe('identical: 2 calls\n');
    const different = spawnSync(process.execPath, [script, a, c], { encoding: 'utf8' });
    expect(different.status).toBe(1);
    expect(different.stdout).toContain('different: A made 2 calls, B made 1.');
    expect(different.stdout).toContain('only in A: 1 calls (exercises propose)');
    const json = spawnSync(process.execPath, [script, a, c, '--json'], { encoding: 'utf8' });
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ identical: false, calls: { a: 2, b: 1 } });
    const missing = spawnSync(process.execPath, [script, a, join(dir, 'nope.jsonl')], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(spawnSync(process.execPath, [script, a], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [script, a, b, '--nope'], { encoding: 'utf8' }).status).toBe(2);
  });
});
