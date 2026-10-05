import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStructureBook } from '@mcprep/core/testing';
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
  dir = await mkdtemp(join(tmpdir(), 'mcprep-mcp-pages-'));
  await writeFile(join(dir, 'book.pdf'), buildStructureBook(12).pdf);
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

describe('the tool pages_sheets', () => {
  it('is listed with typed arguments, read-only, and a description that says what the sheets are for and not for', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === 'pages_sheets');
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    const properties = tool?.inputSchema.properties as Record<string, { type?: string; description?: string; minimum?: number; maximum?: number }>;
    expect(Object.keys(properties).sort()).toEqual(['columns', 'from', 'from_sheet', 'out_dir', 'pdf', 'per_sheet', 'project', 'scale', 'sheet', 'to']);
    expect(tool?.inputSchema.required).toEqual(['out_dir']);
    expect(properties['per_sheet']).toMatchObject({ type: 'integer', minimum: 1, maximum: 12 });
    expect(properties['from']?.description).toContain('zero-based');
    expect(properties['pdf']?.description).toContain('without a project');
    expect(tool?.description).toContain('body text is at the edge of what can be read');
    expect(tool?.description).toContain('never for copying a label, a count or an answer');
    expect(tool?.description).toContain('render_page');
    expect(tool?.description).toContain('overview.json');
    expect(tool?.description).toContain('Nothing is uploaded');
  });

  it('draws the sheets of a PDF given by its path, without any project, and returns the summary the command line gives', async () => {
    const done = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'by-pdf' });
    expect(done.isError).toBeUndefined();
    expect(data(done)).toMatchObject({ pageCount: 12, from: 0, to: 11, perSheet: 8, columns: 4, cellWidth: 380, sheets: 2, rendered: [1, 2] });
    expect(data(done)['out']).toBe(join(dir, 'by-pdf'));
    expect((await readdir(join(dir, 'by-pdf'))).sort()).toEqual(['overview-0001.png', 'overview-0002.png', 'overview.json']);
    const manifest = JSON.parse(await readFile(join(dir, 'by-pdf', 'overview.json'), 'utf8')) as { format: string; sheets: { pages: number[] }[] };
    expect(manifest.format).toBe('math-canvas-overview');
    expect(manifest.sheets.map((sheet) => sheet.pages)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11]]);
    expect(Buffer.from(await readFile(join(dir, 'by-pdf', 'overview-0001.png'))).subarray(1, 4).toString()).toBe('PNG');
  });

  it('takes the options of the command: a range, pages and columns on a sheet, one sheet', async () => {
    const done = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'options', from: 2, to: 9, per_sheet: 3, columns: 3, scale: 0.5, sheet: 2 });
    expect(done.isError).toBeUndefined();
    expect(data(done)).toMatchObject({ from: 2, to: 9, perSheet: 3, columns: 3, scale: 0.5, cellWidth: 308, sheets: 3, rendered: [2] });
    expect((await readdir(join(dir, 'options'))).sort()).toEqual(['overview-0002.png', 'overview.json']);
    const later = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'options', from: 2, to: 9, per_sheet: 3, columns: 3, scale: 0.5, from_sheet: 3 });
    expect(data(later)['rendered']).toEqual([3]);
  });

  it('works on the project of the session when no PDF is given, and says what is missing when there is none', async () => {
    const without = await call('pages_sheets', { out_dir: 'nothing' });
    expect(without.isError).toBe(true);
    expect(data(without)['error']).toMatchObject({ code: 'E_NO_PROJECT' });
    expect((data(without)['error'] as { hint: string }).hint).toContain('create_project');
    await expect(readdir(join(dir, 'nothing'))).rejects.toThrow();
    expect((await call('create_project', { pdf: 'book.pdf', title: 'Pages' })).isError).toBeUndefined();
    const done = await call('pages_sheets', { out_dir: 'by-project', to: 3 });
    expect(done.isError).toBeUndefined();
    expect(data(done)).toMatchObject({ pageCount: 12, from: 0, to: 3, sheets: 1 });
    // A PDF given in the call is used even though a project is open.
    const other = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'by-pdf-again', from: 11 });
    expect(data(other)).toMatchObject({ from: 11, to: 11, columns: 1 });
  });

  it('reports a range without pages and an unknown PDF as tool errors that name the cause', async () => {
    const empty = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'empty', from: 7, to: 3 });
    expect(empty.isError).toBe(true);
    expect(data(empty)['error']).toMatchObject({ code: 'E_USAGE', message: 'The range of pages is empty: --from 7 is after --to 3.' });
    const past = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'empty', from: 12 });
    expect(data(past)['error']).toMatchObject({ code: 'E_USAGE' });
    const sheet = await call('pages_sheets', { pdf: 'book.pdf', out_dir: 'empty', sheet: 5 });
    expect(data(sheet)['error']).toMatchObject({ code: 'E_USAGE', message: 'There are 2 sheets; there is no sheet 5.' });
    const missing = await call('pages_sheets', { pdf: 'absent.pdf', out_dir: 'empty' });
    expect(data(missing)['error']).toMatchObject({ code: 'E_PDF_MISSING' });
  });

  it('refuses arguments that the schema does not allow, before the command runs', async () => {
    const refused = async (args: Record<string, unknown>): Promise<boolean> =>
      client.callTool({ name: 'pages_sheets', arguments: args }).then(
        (reply) => (reply as unknown as Reply).isError === true,
        () => true,
      );
    expect(await refused({ pdf: 'book.pdf', out_dir: 'bad', per_sheet: 13 })).toBe(true);
    expect(await refused({ pdf: 'book.pdf', out_dir: 'bad', columns: 0 })).toBe(true);
    expect(await refused({ pdf: 'book.pdf', out_dir: 'bad', scale: 5 })).toBe(true);
    expect(await refused({ pdf: 'book.pdf', out_dir: 'bad', from: -1 })).toBe(true);
    expect(await refused({ pdf: 'book.pdf' })).toBe(true);
    await expect(readdir(join(dir, 'bad'))).rejects.toThrow();
  });
});
