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
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-gate-'));
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

describe('the tools that finish an audit', () => {
  it('are listed with typed arguments, the gate saying what it asks and what an acknowledgement is for', async () => {
    const { tools } = await client.listTools();
    const named = (name: string) => tools.find((tool) => tool.name === name);
    for (const name of ['book_compare', 'exercises_sheets', 'audit_gate', 'audit_ack', 'audit_confirm', 'audit_review']) expect(named(name), name).toBeDefined();
    expect(named('audit_gate')?.description).toContain('open');
    expect(named('audit_gate')?.description).toContain('NEVER for a defect of ours');
    expect(named('audit_ack')?.description).toContain('ONLY what the BOOK itself prints');
    expect(named('audit_gate')?.annotations?.readOnlyHint).toBe(true);
    expect(named('audit_ack')?.annotations?.readOnlyHint).toBe(false);
    const properties = named('audit_gate')?.inputSchema.properties as Record<string, { type?: string }>;
    expect(properties['ink']?.type).toBe('boolean');
    expect(properties['sheets_seen']?.type).toBe('string');
    expect(properties['visual']?.type).toBe('string');
    expect(properties['final']?.type).toBe('boolean');
    expect(client.getInstructions()).toContain('audit_gate');
  });

  it('book_compare compares with a reference and says what differs, as a result and not a failure', async () => {
    const sections = [
      { label: '0.1', title: 'Whole Numbers', exercise_count: 71 },
      { label: '0.2', title: 'Word Problems', exercise_count: 14 },
      { label: '1.1', title: 'Points and Lines', exercise_count: 12 },
      { label: '1.2', title: 'Triangles and Ratios', exercise_count: 16 },
    ];
    await writeFile(join(dir, 'reference.json'), JSON.stringify({ sections }));
    const done = await call('book_compare', { reference: 'reference.json', details_file: 'compare.json' });
    expect(done.isError).toBeUndefined();
    expect((data(done)['differences'] as { kind: string; label: string }[]).map((entry) => `${entry.kind} ${entry.label}`)).toEqual(['count 0.1']);
    expect(JSON.parse(await readFile(join(dir, 'compare.json'), 'utf8')).format).toBe('math-canvas-compare');
  });

  it('audit_gate passes on the audited book, then audit_ack lets it pass with a reference that differs, and the sheets are made', async () => {
    const passed = await call('audit_gate', {});
    expect(passed.isError).toBeUndefined();
    expect(data(passed)).toMatchObject({ passed: true, open: [] });
    const failing = await call('audit_gate', { reference: 'reference.json' });
    expect((data(failing)['open'] as { code: string }[]).map((finding) => finding.code)).toEqual(['reference-count']);
    expect(data(failing)['passed']).toBe(false);
    const refused = await call('audit_ack', { code: 'reference-count', ref: '0.1', reason: 'The book prints 70 exercises in 0.1, the reference says 71.', reference: 'reference.json' });
    expect(refused.isError).toBe(true);
    const forbidden = await call('audit_ack', { code: 'context-inconsistent', ref: '0.1:5', reason: 'The book prints one instruction for all of them.' });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden.content)).toContain('can never be acknowledged');
    const ack = await call('audit_ack', { code: 'reference-count', ref: '0.1', count: 1, page: 5, quote: 'Evaluate each expression', reason: 'The book prints 70 exercises in 0.1, the reference says 71.', reference: 'reference.json', by: 'tester' });
    expect(ack.isError).toBeUndefined();
    expect(data(ack)).toMatchObject({ covers: 1 });
    const again = await call('audit_gate', { reference: 'reference.json' });
    expect(data(again)).toMatchObject({ passed: true, unconfirmed: 1, perfect: false });
    expect((await call('audit_confirm', { by: 'tester', all: true })).isError).toBe(true);
    const confirmed = await call('audit_confirm', { by: 'reviewer', all: true });
    expect(confirmed.isError).toBeUndefined();
    expect(data(await call('audit_gate', { reference: 'reference.json' }))).toMatchObject({ passed: true, unconfirmed: 0 });
    const review = await call('audit_review', { out_dir: 'review', reference: 'reference.json' });
    expect(review.isError).toBeUndefined();
    expect(data(review)['entries']).toHaveLength(1);
    expect((await call('audit_gate', { status: true })).structuredContent).toMatchObject({ status: 'passed' });
    const sheets = await call('exercises_sheets', { out_dir: 'sheets', sections: ['1.2'], per_sheet: 8, solutions: true });
    expect(sheets.isError).toBeUndefined();
    expect(data(sheets)['rendered']).toEqual([1, 2]);
    expect((await call('get_schema', { name: 'gate' })).isError).toBeUndefined();
    expect((await call('get_schema', { name: 'sheets' })).isError).toBeUndefined();
  });
});
