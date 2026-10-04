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
    expect(properties['replace']?.type).toBe('boolean');
    expect(properties['dry_run']?.type).toBe('boolean');
    expect(propose?.description).toContain('gaps');
    expect(propose?.description).toContain('identified by its section and label');
    for (const name of ['solutions_propose', 'outline_derive_book']) {
      const other = tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { type?: string }>;
      expect(other['dry_run']?.type, name).toBe('boolean');
    }
    expect(client.getInstructions()).toContain('outline_derive_book');
  });

  it('derive the sections, propose the exercises and the answers of the synthetic book', async () => {
    const made = await call('create_project', { pdf: 'book.pdf', title: 'Synthetic Algebra Workbook' });
    expect(made.isError).toBeUndefined();
    const derived = await call('outline_derive_book');
    expect(derived.isError).toBeUndefined();
    const entries = data(derived)['entries'] as { id: string; title: string }[];
    expect(entries.map((entry) => entry.id)).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'Answers']);
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

  it('apply the sections, the exercises with their solutions and the answers later, and can be repeated', async () => {
    const stored = await call('outline_derive_book', { apply: true });
    expect(stored.isError).toBeUndefined();
    expect(data(stored)['applied']).toBe(true);

    const dry = await call('exercises_propose', { solutions: true, apply: true, dry_run: true });
    expect(dry.isError).toBeUndefined();
    expect(data(dry)['applied']).toBe(false);
    expect(data(dry)['dryRun']).toBe(true);
    expect(((await call('list_frames')).structuredContent?.['frames'] as unknown[]).length).toBe(0);

    const applied = await call('exercises_propose', { solutions: true, apply: true });
    expect(applied.isError).toBeUndefined();
    expect(data(applied)['applied']).toBe(true);
    expect(data(applied)['book']).toEqual({ exercises: 112, withSolution: 112 });
    expect((data(applied)['created'] as string[]).length).toBe(112);
    expect(JSON.stringify(data(applied)['validation'])).toContain('"errors":[]');

    const again = await call('exercises_propose', { solutions: true, apply: true });
    expect(again.isError).toBeUndefined();
    expect(data(again)['applied']).toBe(false);
    expect(data(again)['counts']).toMatchObject({ added: 0, unchanged: 112, changed: 0 });

    // The answers of a book that was stored without them.
    const removed = await call('solution_remove', { id: '1.2:3', all: true });
    expect(removed.isError).toBeUndefined();
    const solutions = await call('solutions_propose');
    expect(data(solutions)['counts']).toMatchObject({ matched: 112, added: 1, unchanged: 111, changed: 0 });
    expect((data(solutions)['operations'] as { op: string; id: string }[])[0]).toMatchObject({ op: 'solution.set', id: '1.2:3' });
    const restored = await call('solutions_propose', { apply: true });
    expect(restored.isError).toBeUndefined();
    expect(data(restored)['book']).toEqual({ exercises: 112, withSolution: 112 });

    // A frame that was corrected is kept, and overwritten when the caller says so.
    const moved = await call('update_frame', { id: '0.1:5', rect: [0.13, 0.25, 0.3, 0.27] });
    expect(moved.isError).toBeUndefined();
    const kept = await call('exercises_propose', { solutions: true, apply: true });
    expect(data(kept)['changed']).toEqual(['0.1:5']);
    expect(data(kept)['applied']).toBe(false);
    const replaced = await call('exercises_propose', { solutions: true, apply: true, replace: true });
    expect(replaced.isError).toBeUndefined();
    expect(data(replaced)['applied']).toBe(true);
    expect((data(replaced)['replaced'] as string[]).length).toBe(1);
  });
});
