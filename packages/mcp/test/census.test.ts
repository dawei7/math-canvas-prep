import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNumberedBook } from '@mcprep/core/testing';
import { createServer } from '../src/server.js';

/** exercises_census on the synthetic statistics workbook, a project without any exercise: what the finder does not read, the census lists. */

let dir: string;
let client: Client;
const book = buildNumberedBook();

interface Reply {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  return (await client.callTool({ name, arguments: args })) as unknown as Reply;
}
const data = (reply: Reply): Record<string, unknown> => reply.structuredContent ?? {};
const ids = (reply: Reply): string[] => (data(reply)['runs'] as { id: string }[]).map((run) => run.id);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-census-'));
  await writeFile(join(dir, 'book.pdf'), book.pdf);
  const server = createServer({ cwd: dir, env: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  const made = await call('create_project', { pdf: 'book.pdf', title: book.title });
  if (made.isError) throw new Error(`create_project failed: ${JSON.stringify(made.content)}`);
});

afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('exercises_census', () => {
  it('is listed read-only with typed arguments, says what it reads and what a run is, and the server instructions name it', async () => {
    const { tools } = await client.listTools();
    const found = tools.find((tool) => tool.name === 'exercises_census');
    expect(found).toBeDefined();
    expect(found?.annotations?.readOnlyHint).toBe(true);
    expect(found?.description).toContain('text layer of EVERY page');
    expect(found?.description).toContain('numbered-run-uncovered');
    expect(found?.description).toContain('math-canvas-census');
    const properties = found?.inputSchema.properties as Record<string, { type?: string }>;
    expect(properties['min_run']?.type).toBe('integer');
    expect(properties['uncovered']?.type).toBe('boolean');
    expect(properties['keywords']?.type).toBe('array');
    expect(properties['details_file']?.type).toBe('string');
    expect(client.getInstructions()).toContain('exercises_census');
  });

  it('lists the runs of the book with their ids, labels, headings and coverage, and what it left out', async () => {
    const done = await call('exercises_census');
    expect(done.isError).toBeUndefined();
    expect(data(done)).toMatchObject({ format: 'math-canvas-census', version: 1, pages: book.pageCount, minRun: 5, listed: 5, summary: { runs: 5, items: 48, covered: 0, uncovered: 5, leftOut: 3 } });
    expect(ids(done)).toEqual(book.runs.map((run) => run.id));
    expect((data(done)['runs'] as { heading?: string }[])[0]?.heading).toBe('1.6 Exercises');
    expect((data(done)['leftOut'] as { reason: string }[]).map((left) => left.reason)).toEqual(['contents', 'contents', 'contents']);
  });

  it('takes min_run, uncovered, keywords and details_file like the command does, and refuses a minimum below two', async () => {
    expect(ids(await call('exercises_census', { min_run: 10 }))).toEqual(['p3:1', 'p6:1']);
    expect(ids(await call('exercises_census', { uncovered: true }))).toEqual(book.runs.map((run) => run.id));
    expect((await call('exercises_census', { keywords: ['Satz', 'Beispiel'] })).isError).toBeUndefined();
    const written = await call('exercises_census', { details_file: 'census.json' });
    expect(written.isError).toBeUndefined();
    const file = JSON.parse(await readFile(join(dir, 'census.json'), 'utf8')) as { format: string; runs: { items: unknown[] }[] };
    expect(file.format).toBe('math-canvas-census');
    expect(file.runs.map((run) => run.items.length)).toEqual([14, 14, 9, 5, 6]);
    const refused = await call('exercises_census', { min_run: 1 });
    expect(refused.isError).toBe(true);
  });

  it('is what the gate and exercises_verify show for a project without any exercise: each run no region covers is a warning, ref = the id of the run', async () => {
    const verify = await call('exercises_verify', { fail_on: 'none' });
    expect(verify.isError).toBeUndefined();
    const findings = data(verify)['findings'] as { code: string; ref: string; severity: string }[];
    expect(findings.map((finding) => `${finding.code} ${finding.ref} ${finding.severity}`).sort()).toEqual(book.runs.map((run) => `numbered-run-uncovered ${run.id} warning`).sort());
    const gate = await call('audit_gate');
    const open = data(gate)['open'] as { code: string; ref: string; acknowledgeable: boolean }[];
    expect(open.filter((finding) => finding.code === 'numbered-run-uncovered').map((finding) => finding.ref).sort()).toEqual(book.runs.map((run) => run.id).sort());
    expect(open.every((finding) => finding.acknowledgeable)).toBe(true);
    expect(data(gate)['passed']).toBe(false);
  });

  it('has a schema that get_schema serves: the format of the report and of the --details file', async () => {
    const done = await call('get_schema', { name: 'census' });
    expect(done.isError).toBeUndefined();
    expect(JSON.stringify(data(done))).toContain('math-canvas-census');
  });
});
