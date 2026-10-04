import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * The runbook for an audit agent (docs/AGENT_RUNBOOK.md) gives the tool of every step for an agent that works over MCP. Every name it gives
 * must be a tool the server has: a tool that is renamed or removed makes this test fail until the runbook says so.
 */
describe('the tool names in docs/AGENT_RUNBOOK.md exist', () => {
  it('names only tools the server has', async () => {
    const runbook = readFileSync(new URL('../../../docs/AGENT_RUNBOOK.md', import.meta.url), 'utf8');
    const section = runbook.slice(runbook.indexOf('## 12. MCP tool names'));
    const named = [...new Set([...section.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1] as string))];
    expect(named.length).toBeGreaterThan(20);

    const server = createServer({ env: {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'runbook', version: '1.0.0' });
    await client.connect(clientSide);
    const known = new Set((await client.listTools()).tools.map((tool) => tool.name));
    await client.close();

    expect(named.filter((name) => !known.has(name)), 'tool names of the runbook that the server does not have').toEqual([]);
  });
});
