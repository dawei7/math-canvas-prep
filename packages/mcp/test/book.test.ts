import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuthoritySample } from '@mcprep/core/testing';
import { createServer } from '../src/server.js';

const sample = buildAuthoritySample();
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
const errorOf = (reply: Reply): { code: string; message: string; hint?: string; issues?: { code: string }[] } => data(reply)['error'] as never;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-book-'));
  await writeFile(join(dir, 'book.pdf'), sample.pdf);
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

describe('the tools for auditing a book', () => {
  it('are listed, typed and described so that the convention is clear', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      'exercises_list',
      'exercises_add',
      'exercises_mark',
      'exercises_unmark',
      'exercises_label',
      'exercises_section',
      'solution_add',
      'solution_list',
      'solution_remove',
      'book_show',
      'book_meta',
      'book_export',
      'outline_add',
      'outline_update',
      'outline_delete',
      'outline_ids',
    ]) {
      expect(names, expected).toContain(expected);
    }
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
    const add = tools.find((tool) => tool.name === 'exercises_add');
    expect(add?.description).toContain('ONE printed exercise');
    expect(add?.description).toContain('no parts');
    expect(add?.description).toContain('context');
    expect(add?.inputSchema.required).toEqual(expect.arrayContaining(['section', 'label', 'page', 'rect']));
    expect((add?.inputSchema.properties as Record<string, { description?: string }>)['label']?.description).toContain('exactly as the book prints');
    expect(tools.find((tool) => tool.name === 'solution_add')?.description).toContain('hidden');
    expect(tools.find((tool) => tool.name === 'solution_add')?.description).toContain('SAME PDF');
    expect(tools.find((tool) => tool.name === 'exercises_list')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'book_show')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'solution_remove')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'outline_delete')?.annotations?.destructiveHint).toBe(true);
    const frames = tools.find((tool) => tool.name === 'list_frames');
    expect(Object.keys(frames?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['authority', 'section']));
    const outline = tools.find((tool) => tool.name === 'set_outline');
    expect(Object.keys(outline?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['entries', 'auto_ids']));
    expect(JSON.stringify(tools.find((tool) => tool.name === 'get_schema')?.inputSchema)).toContain('book-summary');
    expect(tools.find((tool) => tool.name === 'apply_operations')?.description).toContain('authority.mark');
    expect(tools.find((tool) => tool.name === 'render_crop')?.description).toContain('solution:0');
  });

  it('are explained in the instructions the server hands out', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('Auditing a book as an authority');
    expect(instructions).toContain('two kinds of exercise');
    expect(instructions).toContain('SECTION:LABEL');
    expect(instructions).toContain('ZERO-BASED');
  });
});

describe('a whole audit through the tools', () => {
  it('creates the project and the sections, adds the exercises and solutions, checks, exports and reads the bundle back', async () => {
    const created = await call('create_project', { pdf: join(dir, 'book.pdf'), title: sample.title, folder: 'Books/Algebra' });
    expect(created.isError).toBeUndefined();

    // Sections first: the outline with ids.
    const set = await call('set_outline', { entries: sample.sections.map(({ title, page, depth, id, label, top }) => ({ title, page, depth, id, label, top })) });
    expect(set.isError).toBeUndefined();
    const outline = data(await call('get_outline'));
    expect(outline).toMatchObject({ source: 'project', totals: { entries: 6, withId: 6, exercises: 0 } });

    // One exercise by hand, the rest in one atomic batch.
    const [first, ...rest] = sample.exercises;
    const one = await call('exercises_add', { section: first?.section, label: first?.label, page: first?.page, rect: first?.rect, solution: first?.solution });
    expect(one.isError).toBeUndefined();
    expect(data(one)).toMatchObject({ created: ['f1'], frames: [{ id: 'f1', label: '1', authority: 'book', reference: '1.1:1', solution: 1 }], book: { exercises: 1, withSolution: 1 }, counts: { exercise: 0 } });
    const again = await call('exercises_add', { section: first?.section, label: first?.label, page: first?.page, rect: first?.rect });
    expect(again.isError).toBe(true);
    expect(errorOf(again)).toMatchObject({ code: 'E_DUPLICATE_EXERCISE' });
    expect(errorOf(again).hint).toContain('replace');

    const operations = rest.map((entry) => ({ op: 'add', authority: 'book', label: entry.label, section: entry.section, page: entry.page, rect: entry.rect, ...(entry.context ? { context: entry.context } : {}), ...(entry.continues ? { continues: entry.continues } : {}), solution: entry.solution }));
    const batch = await call('apply_operations', { operations });
    expect(batch.isError).toBeUndefined();
    expect(data(batch)).toMatchObject({ applied: true, book: { exercises: 10, withSolution: 10 } });
    const twice = await call('apply_operations', { operations });
    expect(twice.isError).toBe(true);
    expect(errorOf(twice).code).toBe('E_DUPLICATE_EXERCISE');
    const replaced = await call('apply_operations', { operations: operations.map((entry) => ({ ...entry, replace: true })) });
    expect(replaced.isError).toBeUndefined();
    expect((data(replaced)['replaced'] as string[]).length).toBe(9);

    // Looking at them.
    const list = data(await call('exercises_list', { section: '1.1' }));
    expect((list['exercises'] as { reference: string }[]).map((entry) => entry.reference)).toEqual(['1.1:1', '1.1:2', '1.1:3a', '1.1:3b']);
    expect(list).toMatchObject({ count: 4, totals: { exercises: 10, withSolution: 10 } });
    expect(data(await call('exercises_list', { without_solution: true }))).toMatchObject({ count: 0 });
    expect(data(await call('list_frames', { authority: 'book', section: '1.2' }))).toMatchObject({ frames: [{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }], book: { exercises: 10 } });
    expect(((data(await call('list_frames', { authority: 'user' })) as { frames: unknown[] }).frames).length).toBe(0);
    const image = await call('render_crop', { frame: '1.1:3a', region: 'solution:0' });
    expect(image.isError).toBeUndefined();
    expect(image.content.some((entry) => entry.type === 'image')).toBe(true);
    const page = await call('render_page', { page: 3, frames: true, solutions: true });
    expect(page.content.some((entry) => entry.type === 'image')).toBe(true);

    // Solutions: add, list, remove.
    const solution = await call('solution_add', { id: '1.1:2', page: 3, rect: [0.1, 0.5, 0.5, 0.52] });
    expect(solution.isError).toBeUndefined();
    const solutions = data(await call('solution_list', { id: '1.1:2' }));
    expect(solutions).toMatchObject({ count: 2, solutions: [{ reference: '1.1:2' }] });
    expect(errorOf(await call('solution_remove', { id: '1.1:2' })).message).toContain('say which');
    expect((await call('solution_remove', { id: '1.1:2', index: 1 })).isError).toBeUndefined();
    expect(data(await call('solution_list', { missing: true }))).toMatchObject({ missing: [] });

    // Mark, relabel, move, unmark an exercise the person framed.
    const added = await call('add_frame', { kind: 'exercise', page: 2, rect: [0.1, 0.6, 0.9, 0.7] });
    const id = (data(added)['created'] as string[])[0] as string;
    expect(data(await call('exercises_mark', { id, label: '9', section: '2.1' }))).toMatchObject({ frames: [{ id, authority: 'book', reference: '2.1:9' }] });
    expect(data(await call('exercises_label', { id: '2.1:9', label: '3' }))).toMatchObject({ frames: [{ id, label: '3' }] });
    expect(data(await call('exercises_section', { id: '2.1:3', section: 'c2' }))).toMatchObject({ frames: [{ id, section: 'c2' }] });
    expect(data(await call('exercises_unmark', { id: 'c2:3' }))).toMatchObject({ frames: [{ id, authority: 'user', label: 'E1' }] });
    expect(errorOf(await call('exercises_unmark', { id }))).toMatchObject({ code: 'E_AUTHORITY' });
    await call('delete_frame', { id });

    // Parts are for exercises you frame yourself.
    const split = await call('split_frame', { id: '1.1:3a', at: [0.5] });
    expect(split.isError).toBe(true);
    expect(errorOf(split)).toMatchObject({ code: 'E_AUTHORITY' });
    expect(errorOf(split).hint).toContain('separate exercises');

    // Sections: edit and keep consistent.
    expect(errorOf(await call('outline_delete', { id: '1.1' })).code).toBe('E_SECTION_IN_USE');
    const renamed = await call('outline_update', { id: '2.1', new_id: 'fractions', label: '2.1', top: 0.25 });
    expect(renamed.isError).toBeUndefined();
    expect(data(await call('list_frames', { section: 'fractions' }))).toMatchObject({ frames: [{ reference: 'fractions:1' }, { reference: 'fractions:2' }] });
    expect((await call('outline_update', { id: 'fractions', top: null })).isError).toBeUndefined();
    const added2 = await call('outline_add', { title: 'Appendix', page: 3, depth: 0, label: 'A' });
    expect(added2.isError).toBeUndefined();
    expect((data(added2)['notes'] as string[]).join(' ')).toContain('"A"');
    expect((await call('outline_add', { title: 'Extra', page: 3, no_id: true })).isError).toBeUndefined();
    expect((data(await call('outline_ids'))['notes'] as string[]).join(' ')).toContain('Gave 1 entry an id');
    expect((await call('outline_delete', { id: 'A' })).isError).toBeUndefined();

    // The book.
    expect(data(await call('book_meta', { author: '@A. Author', license_name: 'CC BY 3.0', license_url: 'https://creativecommons.org/licenses/by/3.0/', source_url: 'https://example.org/the-book', notice: 'Attribution: A. Author.' })).isError).toBeUndefined();
    expect(data(await call('book_meta'))).toMatchObject({ author: '@A. Author', license: { name: 'CC BY 3.0' }, notice: 'Attribution: A. Author.' });
    expect(errorOf(await call('book_meta', { source_url: 'nowhere' })).code).toBe('E_META');
    const shown = data(await call('book_show'));
    expect(shown).toMatchObject({ format: 'math-canvas-book-summary', totals: { exercises: 10, withSolution: 10, unfiled: 0 } });
    expect((shown['sections'] as { id?: string; exercises: number }[]).filter((section) => section.id === 'c1')).toMatchObject([{ exercises: 0 }]);
    const out = join(dir, 'summary.json');
    expect((await call('book_export', { out })).isError).toBeUndefined();
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ format: 'math-canvas-book-summary', totals: { exercises: 10 } });
    const schema = data(await call('get_schema', { name: 'book-summary' }));
    expect(schema).toMatchObject({ name: 'book-summary' });

    // Validate, export, check the bundle.
    const validation = data(await call('validate', { text: false }));
    expect(validation).toMatchObject({ ok: true, book: { exercises: 10, withSolution: 10 } });
    const bundlePath = join(dir, 'book.mcbundle');
    const exported = await call('export_bundle', { out: bundlePath });
    expect(exported.isError).toBeUndefined();
    expect(data(exported)).toMatchObject({ book: { exercises: 10 }, manifest: { features: ['sections', 'authority', 'solution'], document: { author: '@A. Author' } }, importCheck: { ok: true } });
    const check = data(await call('import_check', { file: bundlePath }));
    expect(check).toMatchObject({ wouldImport: true, features: ['sections', 'authority', 'solution'] });
    const inspected = data(await call('inspect_bundle', { file: bundlePath }));
    expect(inspected).toMatchObject({ ok: true, summary: { totals: { exercises: 10, sections: 7 } } });
  });
});
