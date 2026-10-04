import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { run, COMMANDS } from '@mcprep/cli';
import { buildSyntheticBook } from '@mcprep/core/testing';
import { createServer, type ServerOptions } from '../src/server.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcprep-calllog-'));
  dirs.push(dir);
  await writeFile(join(dir, 'book.pdf'), buildSyntheticBook().pdf);
  return dir;
}

async function connect(options: ServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

interface Entry {
  surface: string;
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: string;
}
const read = async (file: string): Promise<string[]> => (await readFile(file, 'utf8')).trim().split('\n');
const parsed = (lines: string[]): Entry[] => lines.map((line) => JSON.parse(line) as Entry);

describe('the MCP server writes the call log', () => {
  it('appends one line for each tool call, after it returned, with sorted keys, the arguments as given and the outcome', async () => {
    const dir = await folder();
    const client = await connect({ cwd: dir, env: {}, callLog: 'calls.jsonl' });
    try {
      await client.callTool({ name: 'create_project', arguments: { pdf: 'book.pdf', title: 'Synthetic Algebra Workbook' } });
      await client.callTool({ name: 'project_info', arguments: {} });
      await client.callTool({ name: 'render_page', arguments: { page: 9999 } });
      await client.callTool({ name: 'exercises_verify', arguments: { sections: ['0.1'], fail_on: 'none' } });
      await client.listTools();
    } finally {
      await client.close();
    }
    const lines = await read(join(dir, 'calls.jsonl'));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('{"arguments":{"pdf":"book.pdf","title":"Synthetic Algebra Workbook"},"ok":true,"surface":"mcp","tool":"create_project"}');
    const entries = parsed(lines);
    expect(entries.map((entry) => entry.tool)).toEqual(['create_project', 'project_info', 'render_page', 'exercises_verify']);
    expect(entries.every((entry) => entry.surface === 'mcp')).toBe(true);
    expect(entries[1]).toEqual({ surface: 'mcp', tool: 'project_info', arguments: {}, ok: true });
    expect(entries[2]).toMatchObject({ arguments: { page: 9999 }, ok: false, error: 'E_PAGE' });
    expect(entries[3]).toMatchObject({ arguments: { fail_on: 'none', sections: ['0.1'] }, ok: false, error: 'E_USAGE' });
    // The command line that a tool runs in process does not log the call a second time, and listing the tools is no call.
    expect(lines).toHaveLength(entries.length);
  });

  it('logs a tool that failed before it ran (no project), and one that gave a result that is not ok (validate)', async () => {
    const dir = await folder();
    const client = await connect({ cwd: dir, env: {}, callLog: join(dir, 'absolute.jsonl') });
    try {
      await client.callTool({ name: 'project_info', arguments: {} });
      await client.callTool({ name: 'create_project', arguments: { pdf: 'book.pdf' } });
      await client.callTool({ name: 'validate', arguments: { text: false } });
    } finally {
      await client.close();
    }
    const entries = parsed(await read(join(dir, 'absolute.jsonl')));
    expect(entries[0]).toMatchObject({ tool: 'project_info', ok: false, error: 'E_NO_PROJECT' });
    expect(entries[2]).toMatchObject({ tool: 'validate', arguments: { text: false }, ok: true });
  });

  it('takes the file from MCPREP_CALL_LOG when no option names one, and the option wins over it', async () => {
    const dir = await folder();
    const fromEnv = await connect({ cwd: dir, env: { MCPREP_CALL_LOG: 'env.jsonl' } });
    try {
      await fromEnv.callTool({ name: 'get_schema', arguments: { name: 'frames' } });
    } finally {
      await fromEnv.close();
    }
    expect(parsed(await read(join(dir, 'env.jsonl')))).toEqual([{ surface: 'mcp', tool: 'get_schema', arguments: { name: 'frames' }, ok: true }]);
    const both = await connect({ cwd: dir, env: { MCPREP_CALL_LOG: 'env.jsonl' }, callLog: 'option.jsonl' });
    try {
      await both.callTool({ name: 'get_guide', arguments: {} });
    } finally {
      await both.close();
    }
    expect(parsed(await read(join(dir, 'option.jsonl')))).toHaveLength(1);
    expect(await read(join(dir, 'env.jsonl'))).toHaveLength(1);
  });

  it('writes nothing, and does not fail, when no log is asked for or the log cannot be written', async () => {
    const dir = await folder();
    const quiet = await connect({ cwd: dir, env: {} });
    try {
      expect((await quiet.callTool({ name: 'get_schema', arguments: { name: 'outline' } })) as { isError?: boolean }).not.toHaveProperty('isError', true);
    } finally {
      await quiet.close();
    }
    const broken = await connect({ cwd: dir, env: {}, callLog: dir });
    try {
      const reply = (await broken.callTool({ name: 'get_schema', arguments: { name: 'outline' } })) as { isError?: boolean };
      expect(reply.isError).toBeUndefined();
    } finally {
      await broken.close();
    }
  });
});

describe('a run through the tools and a run through the command line make the same calls', () => {
  it('are the same for scripts/compare-calls.mjs, though the surfaces and the folders differ', async () => {
    const script = resolve(fileURLToPath(new URL('../../../scripts/compare-calls.mjs', import.meta.url)));
    const compare = (await import(pathToFileURL(script).href)) as {
      parseLog(text: string): unknown[];
      compareCalls(a: unknown[], b: unknown[]): { identical: boolean; calls: { a: number; b: number } };
      formatComparison(result: unknown): string;
    };
    const viaTools = await folder();
    const viaCommands = await folder();
    // Absolute paths are the same for the comparison when their last two segments are.
    for (const dir of [viaTools, viaCommands]) await mkdir(join(dir, 'out'));
    const client = await connect({ cwd: viaTools, env: {}, callLog: 'calls.jsonl' });
    try {
      await client.callTool({ name: 'create_project', arguments: { pdf: 'book.pdf', title: 'Synthetic Algebra Workbook' } });
      await client.callTool({ name: 'outline_derive_book', arguments: { apply: true } });
      await client.callTool({ name: 'exercises_propose', arguments: { solutions: true, apply: true, details_file: join(viaTools, 'out', 'details.json') } });
      await client.callTool({ name: 'exercises_verify', arguments: { details_file: 'verify.json', fail_on: 'warning' } });
      await client.callTool({ name: 'exercises_sample', arguments: { exercises: 10, solutions: 5, per_section: true } });
      await client.callTool({ name: 'render_crop', arguments: { frame: '0.1:5', region: 'main', max_side: 600 } });
      await client.callTool({ name: 'validate', arguments: { text: false } });
    } finally {
      await client.close();
    }
    const env = { MCPREP_CALL_LOG: 'calls.jsonl' };
    const cli = async (...args: string[]): Promise<void> => {
      await run(args, { stdout: () => undefined, stderr: () => undefined, stdin: () => Promise.resolve(''), cwd: viaCommands, env });
    };
    await cli('init', 'book.pdf', '--title', 'Synthetic Algebra Workbook');
    await cli('outline', 'derive', '--book', '--apply');
    await cli('exercises', 'propose', '--solutions', '--apply', '--details', join(viaCommands, 'out', 'details.json'));
    await cli('exercises', 'verify', '--details', 'verify.json', '--fail-on', 'warning');
    await cli('exercises', 'sample', '--exercises', '10', '--solutions', '5', '--per-section');
    await cli('crop', '0.1:5', '--region', 'main', '--max-side', '600');
    await cli('validate', '--no-text');
    const a = compare.parseLog(await readFile(join(viaTools, 'calls.jsonl'), 'utf8'));
    const b = compare.parseLog(await readFile(join(viaCommands, 'calls.jsonl'), 'utf8'));
    expect(a).toHaveLength(7);
    expect(b).toHaveLength(7);
    const result = compare.compareCalls(a, b);
    expect(result, compare.formatComparison(result)).toMatchObject({ identical: true, calls: { a: 7, b: 7 } });
  });
});

describe('the table of the compare script', () => {
  it('names every MCP tool and a command line command that exists, and no tool that does not exist', async () => {
    const script = resolve(fileURLToPath(new URL('../../../scripts/compare-calls.mjs', import.meta.url)));
    const { TOOLS } = (await import(pathToFileURL(script).href)) as { TOOLS: Record<string, { command: string }> };
    const client = await connect({ env: {} });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(Object.keys(TOOLS).sort()).toEqual(names);
    } finally {
      await client.close();
    }
    const commands = new Set(COMMANDS.map((spec) => spec.name));
    for (const [tool, entry] of Object.entries(TOOLS)) expect(commands.has(entry.command), `${tool} -> ${entry.command}`).toBe(true);
  });
});
