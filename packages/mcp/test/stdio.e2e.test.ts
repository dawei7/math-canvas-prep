import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';

const bin = new URL('../bin/mcprep-mcp.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dist = new URL('../dist/index.js', import.meta.url);
const sample = new URL('../../../examples/sample.pdf', import.meta.url);
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(dist))('the built MCP server over stdio', () => {
  it('answers a real client: lists tools, marks the sample and exports a bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprep-stdio-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'sheet.pdf'), readFileSync(sample));
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], cwd: dir, stderr: 'pipe' }));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(25);
      const created = (await client.callTool({ name: 'create_project', arguments: { pdf: 'sheet.pdf' } })) as { structuredContent?: Record<string, unknown> };
      expect(created.structuredContent).toMatchObject({ pdf: { pageCount: 3 } });
      const proposed = (await client.callTool({ name: 'propose', arguments: { apply: true } })) as { structuredContent?: Record<string, unknown> };
      expect(proposed.structuredContent).toMatchObject({ applied: true });
      const image = (await client.callTool({ name: 'render_crop', arguments: { frame: 'f1', max_side: 400 } })) as { content: { type: string }[] };
      expect(image.content.some((entry) => entry.type === 'image')).toBe(true);
      const exported = (await client.callTool({ name: 'export_bundle', arguments: {} })) as { structuredContent?: Record<string, unknown> };
      expect(exported.structuredContent).toMatchObject({ importCheck: { ok: true } });
      expect(existsSync(String(exported.structuredContent?.['path']))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
