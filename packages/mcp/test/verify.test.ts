import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticBook } from '@mcprep/core/testing';
import { createServer } from '../src/server.js';

let dir: string;
let client: Client;

interface Reply {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  return (await client.callTool({ name, arguments: args })) as unknown as Reply;
}

const data = (reply: Reply): Record<string, unknown> => reply.structuredContent ?? {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-verify-'));
  await writeFile(join(dir, 'book.pdf'), buildSyntheticBook().pdf);
  const server = createServer({ cwd: dir, env: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  for (const [name, args] of [
    ['create_project', { pdf: 'book.pdf', title: 'Synthetic Algebra Workbook' }],
    ['outline_derive_book', { apply: true }],
    ['exercises_propose', { solutions: true, apply: true }],
  ] as const) {
    const done = await call(name, args as Record<string, unknown>);
    if (done.isError) throw new Error(`${name} failed: ${JSON.stringify(done.content)}`);
  }
});

afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('exercises_verify', () => {
  it('is listed with typed arguments and says what it reads and what it reports', async () => {
    const { tools } = await client.listTools();
    const found = tools.find((tool) => tool.name === 'exercises_verify');
    expect(found).toBeDefined();
    expect(found?.annotations?.readOnlyHint).toBe(true);
    expect(found?.description).toContain('text layer');
    expect(found?.description).toContain('label-not-first');
    expect(found?.description).toContain('findingsOmitted');
    const properties = found?.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(properties['sections']?.type).toBe('array');
    expect(properties['fail_on']?.enum).toEqual(['error', 'warning', 'none']);
    expect(properties['details_file']?.type).toBe('string');
    expect(client.getInstructions()).toContain('exercises_verify');
  });

  it('reports a book that the proposals audited as clean, in the format the schema describes', async () => {
    const done = await call('exercises_verify');
    expect(done.isError).toBeUndefined();
    expect(data(done)).toMatchObject({ format: 'math-canvas-verify', version: 1, summary: { exercises: 112, errors: 0, warnings: 0, infos: 0 }, findings: [] });
    expect((data(done)['sections'] as { id: string }[]).map((section) => section.id)).toEqual(['0.1', '0.2', '1.1', '1.2']);
  });

  it('lists what is wrong, for the sections it is asked for, and writes the whole report', async () => {
    expect((await call('exercises_label', { id: '1.1:3', label: '33' })).isError).toBeUndefined();
    const done = await call('exercises_verify', { sections: ['1.1'], details_file: 'verify.json', fail_on: 'none' });
    expect(done.isError).toBeUndefined();
    const summary = data(done)['summary'] as { exercises: number; errors: number };
    expect(summary.exercises).toBe(12);
    expect(summary.errors).toBeGreaterThanOrEqual(2);
    const findings = data(done)['findings'] as { code: string; ref: string; severity: string }[];
    expect(findings[0]).toMatchObject({ severity: 'error', ref: '1.1:33' });
    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['label-not-first', 'solution-label-missing']));
    const written = JSON.parse(await readFile(join(dir, 'verify.json'), 'utf8')) as { findings: unknown[] };
    expect(written.findings).toEqual(findings);
  });

  it('is a result, not a failure, when the check fails; and it refuses a section that does not exist', async () => {
    const failing = await call('exercises_verify');
    expect(failing.isError).toBeUndefined();
    expect((data(failing)['summary'] as { errors: number }).errors).toBeGreaterThan(0);
    const wrong = await call('exercises_verify', { sections: ['9.9'] });
    expect(wrong.isError).toBe(true);
    expect((data(wrong)['error'] as { code: string }).code).toBe('E_USAGE');
  });

  it('is part of the schemas the server knows', async () => {
    const done = await call('get_schema', { name: 'verify' });
    expect(done.isError).toBeUndefined();
    expect(data(done)['name']).toBe('verify');
  });
});
