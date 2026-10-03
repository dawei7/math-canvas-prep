import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSampleSheet } from '@mcprep/core/testing';
import { createServer } from '../src/server.js';

let dir: string;
let client: Client;

interface Reply {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  return (await client.callTool({ name, arguments: args })) as unknown as Reply;
}

const data = (reply: Reply): Record<string, unknown> => reply.structuredContent ?? {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-'));
  await writeFile(join(dir, 'sheet.pdf'), buildSampleSheet().pdf);
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

describe('the tools a client sees', () => {
  it('lists typed tools with descriptions that teach the conventions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ['create_project', 'open_project', 'project_info', 'get_page_lines', 'render_page', 'render_crop', 'propose', 'list_frames', 'add_frame', 'update_frame', 'delete_frame', 'split_frame', 'merge_frames', 'set_dividers', 'add_context', 'add_continuation', 'apply_operations', 'validate', 'export_bundle', 'inspect_bundle', 'import_check', 'get_outline', 'derive_outline', 'set_outline', 'get_guide']) {
      expect(names).toContain(expected);
    }
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
    const add = tools.find((tool) => tool.name === 'add_frame');
    expect(add?.description).toContain('up to but not including the next exercise');
    const properties = add?.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties['page']?.description).toContain('Zero-based');
    expect(properties['rect']?.description).toContain('top-left');
    expect(add?.inputSchema.required).toEqual(expect.arrayContaining(['kind', 'page', 'rect']));
    expect(tools.find((tool) => tool.name === 'validate')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'delete_frame')?.annotations?.destructiveHint).toBe(true);
  });

  it('offers the guide as a resource and a prompt, and explains the workflow in its instructions', async () => {
    expect(client.getInstructions()).toContain('ZERO-BASED');
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain('mcprep://guide');
    const guide = await client.readResource({ uri: 'mcprep://guide' });
    expect((guide.contents[0] as { text: string }).text).toContain('# Agent guide');
    const prompt = await client.getPrompt({ name: 'mark_pdf', arguments: { pdf: 'book.pdf', folder: 'Uni/Analysis' } });
    expect(JSON.stringify(prompt.messages)).toContain('book.pdf');
    const viaTool = await call('get_guide');
    expect(viaTool.content[0]?.text).toContain('Checklist');
  });
});

describe('a whole session through the tools', () => {
  it('fails clearly when no project is open', async () => {
    const reply = await call('list_frames');
    expect(reply.isError).toBe(true);
    expect(data(reply)['error']).toMatchObject({ code: 'E_NO_PROJECT' });
  });

  it('creates a project, looks at the PDF, proposes, applies, checks, validates and exports', async () => {
    const created = await call('create_project', { pdf: 'sheet.pdf', title: 'Calculus Sheet 1', folder: 'Examples/Calculus' });
    expect(created.isError).toBeUndefined();
    expect(data(created)).toMatchObject({ title: 'Calculus Sheet 1', pdf: { pageCount: 3 } });

    const info = await call('project_info');
    expect(data(info)).toMatchObject({ pdf: { pageCount: 3, textLayer: { withText: 3 } }, outline: { pdf: 4 }, frames: { total: 0 } });

    const lines = await call('get_page_lines', { page: 0 });
    expect((data(lines)['lines'] as { text: string }[])[3]?.text).toContain('Exercise 1.');
    const region = await call('get_page_lines', { page: 0, region: [0, 0.28, 1, 0.42] });
    expect((data(region)['lines'] as { text: string }[])[0]?.text).toContain('Exercise 2');

    const page = await call('render_page', { page: 0, grid: 0.1, max_side: 500 });
    const image = page.content.find((entry) => entry.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image?.data ?? '', 'base64').subarray(1, 4).toString()).toBe('PNG');

    const proposed = await call('propose');
    const result = data(proposed);
    expect((result['proposals'] as unknown[]).length).toBe(7);
    expect(result['applied']).toBe(false);

    const applied = await call('apply_operations', { operations: result['operations'] });
    expect(applied.isError).toBeUndefined();
    expect(data(applied)).toMatchObject({ applied: true, counts: { exercise: 5, bookmark: 2 } });

    const frames = await call('list_frames');
    const labels = (data(frames)['frames'] as { label: string }[]).map((frame) => frame.label);
    expect(labels).toEqual(['E1', 'E2.1', 'E2.2', 'E2.3', 'E3', 'E4', 'B1', 'E5.1', 'E5.2', 'B2']);

    const crop = await call('render_crop', { frame: 'f7', region: 'continues:0', grid: 0.05 });
    expect(crop.content.filter((entry) => entry.type === 'image')).toHaveLength(1);
    const byRect = await call('render_crop', { page: 1, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } });
    expect(byRect.content.some((entry) => entry.type === 'image')).toBe(true);
    const missing = await call('render_crop', {});
    expect(missing.isError).toBe(true);

    const validation = await call('validate');
    expect(data(validation)).toMatchObject({ ok: true, errors: [] });

    const exported = await call('export_bundle', { out: join(dir, 'sheet.mcbundle') });
    expect(data(exported)).toMatchObject({ counts: { frames: 10 }, importCheck: { ok: true } });

    const check = await call('import_check', { file: join(dir, 'sheet.mcbundle') });
    expect(data(check)).toMatchObject({ wouldImport: true });
    const inspected = await call('inspect_bundle', { file: join(dir, 'sheet.mcbundle') });
    expect((data(inspected)['numbers'] as unknown[]).length).toBe(10);
  });

  it('edits frames with typed arguments and reports refusals as tool errors with a code and a hint', async () => {
    const added = await call('add_frame', { kind: 'question', page: 0, rect: [0.1, 0.5, 0.9, 0.6], snap: false });
    expect(added.isError).toBeUndefined();
    const id = (data(added)['created'] as string[])[0] as string;
    const moved = await call('move_frame', { id, dy: 0.05 });
    expect(data(moved)['frames']).toMatchObject([{ id, rect: { top: 0.55 } }]);
    const updated = await call('update_frame', { id, kind: 'bookmark', rect: { left: 0.1, top: 0.5, right: 0.9, bottom: 0.62 } });
    expect(data(updated)['frames']).toMatchObject([{ id, kind: 'bookmark' }]);

    const far = await call('add_frame', { kind: 'exercise', page: 9, rect: [0.1, 0.2, 0.9, 0.3] });
    expect(far.isError).toBe(true);
    expect(data(far)['error']).toMatchObject({ code: 'E_PAGE' });
    const percent = await call('add_frame', { kind: 'exercise', page: 0, rect: [10, 20, 90, 30] });
    expect((data(percent)['error'] as { hint: string }).hint).toContain('fractions');
    const dry = await call('delete_frame', { id, dry_run: true });
    expect(data(dry)).toMatchObject({ applied: false, dryRun: true });
    expect((await call('delete_frame', { id })).isError).toBeUndefined();

    const badArgs = await client.callTool({ name: 'add_frame', arguments: { kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9] } }).then(
      (reply) => ({ rejected: (reply as unknown as Reply).isError === true }),
      () => ({ rejected: true }),
    );
    expect(badArgs.rejected).toBe(true);
  });

  it('cuts exercises into parts and attaches context', async () => {
    const added = await call('add_frame', { kind: 'exercise', page: 1, rect: [0.1, 0.5, 0.9, 0.7] });
    const id = (data(added)['created'] as string[])[0] as string;
    const split = await call('split_frame', { id, at: [0.6], first: 0.54, preamble: 'context' });
    expect(split.isError).toBeUndefined();
    expect(data(split)['created']).toHaveLength(1);
    const sliver = await call('split_frame', { id, at: [0.5405] });
    expect(sliver.isError).toBe(true);
    expect(data(sliver)['error']).toMatchObject({ code: 'E_SPLIT' });
    const context = await call('add_context', { id, page: 0, rect: [0.1, 0.1, 0.9, 0.15] });
    expect(data(context)['frames']).toMatchObject([{ id, context: 2 }]);
    const dividers = await call('set_dividers', { id, at: [0.58, 0.64] });
    expect(data(dividers)['created']).toHaveLength(1);
    const unit = ((data(await call('list_frames'))['frames'] as { id: string; unit?: string }[]).find((frame) => frame.id === id)?.unit) as string;
    const merged = await call('merge_frames', { unit });
    expect(merged.isError).toBeUndefined();
    const cont = await call('add_continuation', { id, page: 2, rect: [0.1, 0.1, 0.9, 0.2] });
    expect(data(cont)['frames']).toMatchObject([{ id, continues: 1 }]);
    expect((await call('remove_continuation', { id })).isError).toBeUndefined();
    expect((await call('remove_context', { id, all: true })).isError).toBeUndefined();
  });

  it('handles the outline, metadata and a second project by path', async () => {
    expect(data(await call('get_outline'))).toMatchObject({ source: 'pdf' });
    expect((await call('adopt_pdf_outline')).isError).toBeUndefined();
    expect(data(await call('get_outline'))).toMatchObject({ source: 'project', projectSource: 'pdf' });
    expect((await call('set_outline', { entries: [{ title: '1 Mine', page: 0, depth: 0 }] })).isError).toBeUndefined();
    expect(((data(await call('get_outline'))['entries']) as unknown[]).length).toBe(1);
    expect((await call('clear_outline')).isError).toBeUndefined();
    expect((await call('derive_outline'))['structuredContent']).toMatchObject({ applied: false });
    expect(data(await call('set_metadata', { title: 'Renamed' }))).toMatchObject({ applied: true });
    expect(data(await call('set_metadata'))).toMatchObject({ title: 'Renamed' });

    await writeFile(join(dir, 'other.pdf'), buildSampleSheet().pdf);
    const other = await call('create_project', { pdf: 'other.pdf', title: 'Other' });
    const otherProject = data(other)['project'] as string;
    expect(data(await call('list_frames'))['frames']).toEqual([]);
    const first = join(dir, 'sheet.mcprep.json');
    expect(((data(await call('list_frames', { project: first }))['frames']) as unknown[]).length).toBeGreaterThan(5);
    expect(data(await call('open_project', { project: first }))).toMatchObject({ project: { title: 'Renamed' } });
    expect(((data(await call('list_frames'))['frames']) as unknown[]).length).toBeGreaterThan(5);
    expect(otherProject.endsWith('other.mcprep.json')).toBe(true);
    const clash = await call('create_project', { pdf: 'other.pdf' });
    expect(data(clash)['error']).toMatchObject({ code: 'E_EXISTS' });
  });

  it('returns validation failures as results with exit information, and schemas on request', async () => {
    const reply = await call('get_schema', { name: 'frames' });
    expect((data(reply)['schema'] as { title: string }).title).toContain('frames.json');
    const check = await call('import_check', { file: join(dir, 'does-not-exist.mcbundle') });
    expect(check.isError).toBe(true);
    expect(data(check)['error']).toMatchObject({ code: 'E_FILE' });
  });
});
