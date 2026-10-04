import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-book-'));
  await writeFile(join(dir, 'book.pdf'), buildSyntheticBook().pdf);
  const server = createServer({ cwd: dir, env: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('the book tools', () => {
  it('are listed with typed schemas and descriptions that say what they read and what they report', async () => {
    const { tools } = await client.listTools();
    for (const name of ['outline_derive_book', 'exercises_propose', 'solutions_propose']) {
      const found = tools.find((tool) => tool.name === name);
      expect(found, name).toBeDefined();
      expect(found?.description?.length ?? 0).toBeGreaterThan(300);
      expect(found?.inputSchema.type).toBe('object');
    }
    const propose = tools.find((tool) => tool.name === 'exercises_propose');
    const properties = propose?.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(properties['sections']?.type).toBe('array');
    expect(properties['solutions']?.description).toContain('answer key');
    expect(propose?.description).toContain('gaps');
    expect(client.getInstructions()).toContain('outline_derive_book');
  });

  it('derive the sections, propose the exercises and the answers of the synthetic book', async () => {
    const made = await call('create_project', { pdf: 'book.pdf', title: 'Synthetic Algebra Workbook' });
    expect(made.isError).toBeUndefined();
    const derived = await call('outline_derive_book');
    expect(derived.isError).toBeUndefined();
    const entries = data(derived)['entries'] as { id: string; title: string }[];
    expect(entries.map((entry) => entry.id)).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'answers']);
    expect(data(derived)['applied']).toBe(false);

    const exercises = await call('exercises_propose', { sections: ['0.2'] });
    expect(exercises.isError).toBeUndefined();
    const counts = data(exercises)['counts'] as { sections: number; exercises: number };
    expect(counts).toMatchObject({ sections: 1, exercises: 14 });
    const section = (data(exercises)['sections'] as { section: string; first: string; last: string; instructions: { governs: string[] }[] }[])[0];
    expect([section?.section, section?.first, section?.last]).toEqual(['0.2', '1', '14']);
    expect(section?.instructions.map((entry) => entry.governs.length)).toEqual([6, 8]);

    const solutions = await call('solutions_propose');
    expect(solutions.isError).toBeUndefined();
    expect((data(solutions)['counts'] as { answers: number }).answers).toBe(112);
  });

  it('report a mistake of the caller as a tool error with the hint', async () => {
    const unknown = await call('exercises_propose', { sections: ['9.9'] });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.structuredContent)).toContain('There is no section');
    const early = await call('exercises_propose', { apply: true });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early.structuredContent)).toContain('outline derive --book --apply');
  });
});
