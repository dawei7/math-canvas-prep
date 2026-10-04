import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALL_LOG_ENV, appendCallLog, callLogLine, canonicalJson } from '../src/calllog.js';
import { tempDir } from './helpers.js';

describe('canonicalJson', () => {
  it('puts the keys of every object in sorted order, at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('is the same text for objects built in another order', () => {
    expect(canonicalJson({ tool: 'x', arguments: { page: 1, grid: 0.1 }, ok: true })).toBe(canonicalJson({ ok: true, arguments: { grid: 0.1, page: 1 }, tool: 'x' }));
  });

  it('leaves out what JSON leaves out and keeps the order of lists', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 2, 1], c: () => 1, d: 'x' })).toBe('{"b":[null,2,1],"d":"x"}');
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('writes strings, numbers and text the way JSON does', () => {
    expect(canonicalJson({ text: 'a "quoted" \\ line\nbreak', n: 1.5, big: 10n, bad: Number.NaN, flag: false })).toBe('{"bad":null,"big":"10","flag":false,"n":1.5,"text":"a \\"quoted\\" \\\\ line\\nbreak"}');
  });
});

describe('the call log', () => {
  it('is one line of JSON for a call, with sorted keys, and the name of the variable that switches it on', () => {
    expect(CALL_LOG_ENV).toBe('MCPREP_CALL_LOG');
    expect(callLogLine({ surface: 'mcp', tool: 'exercises_propose', arguments: { solutions: true, sections: ['0.1'] }, ok: true })).toBe(
      '{"arguments":{"sections":["0.1"],"solutions":true},"ok":true,"surface":"mcp","tool":"exercises_propose"}',
    );
    expect(callLogLine({ surface: 'cli', tool: 'frames update', arguments: { _: ['f1'], rect: '0.1,0.2,0.9,0.3' }, ok: false, error: 'E_RECT', exitCode: 4 })).toBe(
      '{"arguments":{"_":["f1"],"rect":"0.1,0.2,0.9,0.3"},"error":"E_RECT","exitCode":4,"ok":false,"surface":"cli","tool":"frames update"}',
    );
  });

  it('appends a line for each call, makes the folder, and never breaks the call when it cannot write', async () => {
    const dir = await tempDir();
    const file = join(dir, 'logs', 'run.jsonl');
    expect(await appendCallLog(file, { surface: 'mcp', tool: 'a', arguments: {}, ok: true })).toBeUndefined();
    expect(await appendCallLog(file, { surface: 'mcp', tool: 'b', arguments: { x: 1 }, ok: false, error: 'E_PAGE' })).toBeUndefined();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { tool: string }).tool)).toEqual(['a', 'b']);
    expect(JSON.parse(lines[1] as string)).toEqual({ arguments: { x: 1 }, error: 'E_PAGE', ok: false, surface: 'mcp', tool: 'b' });
    // A folder where the file should be: the reason comes back, nothing is thrown.
    await mkdir(join(dir, 'taken'));
    await writeFile(join(dir, 'file'), 'x');
    const problem = await appendCallLog(join(dir, 'taken'), { surface: 'cli', tool: 'x', arguments: {}, ok: true });
    expect(typeof problem).toBe('string');
    expect(await appendCallLog(join(dir, 'file', 'inside.jsonl'), { surface: 'cli', tool: 'x', arguments: {}, ok: true })).toEqual(expect.any(String));
  });
});
