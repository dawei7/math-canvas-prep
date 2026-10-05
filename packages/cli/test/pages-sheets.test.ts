import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStructureBook } from '@mcprep/core/testing';
import { isPng, workspace, type Cli } from './helpers.js';

/**
 * `mcprep pages sheets`: overview sheets of every page of a book. The drawing itself is tested in the core (the cells, the captions, the
 * borders, the same bytes twice); here are the command, its options, what it prints, and how it refuses.
 */

interface Manifest {
  format: string;
  version: number;
  pageCount: number;
  from: number;
  to: number;
  perSheet: number;
  columns: number;
  scale: number;
  pageSize: { width: number; height: number };
  cellWidth: number;
  cellHeight: number;
  gap: number;
  captionHeight: number;
  sheets: { number: number; file: string; pages: number[]; width: number; height: number }[];
}

const size = (bytes: Uint8Array): [number, number] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

/** A workspace with a book of `pages` pages in it as book.pdf, and no project. */
async function bookWorkspace(pages = 20): Promise<Cli> {
  const cli = await workspace({ init: false });
  await writeFile(join(cli.dir, 'book.pdf'), buildStructureBook(pages).pdf);
  return cli;
}

const manifestOf = async (cli: Cli, folder: string): Promise<Manifest> => JSON.parse(await readFile(join(cli.dir, folder, 'overview.json'), 'utf8')) as Manifest;
const filesOf = async (cli: Cli, folder: string): Promise<string[]> => (await readdir(join(cli.dir, folder))).sort();

describe('mcprep pages sheets', () => {
  it('draws the sheets of a PDF given directly, needs no project, and lists them in overview.json', async () => {
    const cli = await bookWorkspace(20);
    const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'overview']);
    expect(done.code, done.stdout).toBe(0);
    expect(done.json.ok).toBe(true);
    expect(done.json.command).toBe('pages sheets');
    expect(await filesOf(cli, 'overview')).toEqual(['overview-0001.png', 'overview-0002.png', 'overview-0003.png', 'overview.json']);
    const manifest = await manifestOf(cli, 'overview');
    expect(manifest).toMatchObject({ format: 'math-canvas-overview', version: 1, pageCount: 20, from: 0, to: 19, perSheet: 8, columns: 4, cellWidth: 380, gap: 8, captionHeight: 22, pageSize: { width: 612, height: 792 } });
    expect(manifest.sheets.map((sheet) => sheet.pages)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14, 15], [16, 17, 18, 19]]);
    for (const sheet of manifest.sheets) {
      const bytes = new Uint8Array(await readFile(join(cli.dir, 'overview', sheet.file)));
      expect(isPng(bytes), sheet.file).toBe(true);
      expect(size(bytes), sheet.file).toEqual([sheet.width, sheet.height]);
    }
    expect(done.json.result).toMatchObject({
      out: join(cli.dir, 'overview'),
      manifest: join(cli.dir, 'overview', 'overview.json'),
      pageCount: 20,
      from: 0,
      to: 19,
      perSheet: 8,
      columns: 4,
      scale: manifest.scale,
      cellWidth: 380,
      cellHeight: manifest.cellHeight,
      sheetWidth: 1560,
      sheetHeight: manifest.sheets[0]?.height,
      sheets: 3,
      rendered: [1, 2, 3],
    });
    expect(done.json.result['failed']).toBeUndefined();
    expect(done.json.result['unlisted']).toBeUndefined();
    expect(done.json.notes).toBeUndefined();
  });

  it('works on the PDF of the project when no PDF is given', async () => {
    const cli = await workspace();
    const done = await cli(['pages', 'sheets', '--out', 'overview']);
    expect(done.code, done.stdout).toBe(0);
    expect(done.json.result).toMatchObject({ pageCount: 3, sheets: 1, rendered: [1], columns: 3 });
    expect(await filesOf(cli, 'overview')).toEqual(['overview-0001.png', 'overview.json']);
    // The same through a project file given by name, from another folder.
    const named = await cli(['pages', 'sheets', '--out', 'again', '--project', join(cli.dir, 'sheet.mcprep.json')]);
    expect(named.code, named.stdout).toBe(0);
  });

  it('draws a range of pages with --from and --to, both included, and the pages that --per-sheet and --columns say', async () => {
    const cli = await bookWorkspace(20);
    const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'range', '--from', '4', '--to', '11', '--per-sheet', '3', '--columns', '2']);
    expect(done.code, done.stdout).toBe(0);
    const manifest = await manifestOf(cli, 'range');
    expect(manifest).toMatchObject({ pageCount: 20, from: 4, to: 11, perSheet: 3, columns: 2 });
    expect(manifest.sheets.map((sheet) => sheet.pages)).toEqual([[4, 5, 6], [7, 8, 9], [10, 11]]);
    expect(await filesOf(cli, 'range')).toEqual(['overview-0001.png', 'overview-0002.png', 'overview-0003.png', 'overview.json']);
    // The scale, in pixels per point of a page of the usual size.
    const scaled = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'scaled', '--to', '3', '--scale', '0.5']);
    expect(scaled.code, scaled.stdout).toBe(0);
    expect(await manifestOf(cli, 'scaled')).toMatchObject({ scale: 0.5, cellWidth: 308, cellHeight: 420 });
  });

  it('draws only the sheet --sheet names, or the sheets from --from-sheet on, and always lists them all', async () => {
    const cli = await bookWorkspace(20);
    const one = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'one', '--sheet', '2']);
    expect(one.code, one.stdout).toBe(0);
    expect(one.json.result).toMatchObject({ sheets: 3, rendered: [2] });
    expect(await filesOf(cli, 'one')).toEqual(['overview-0002.png', 'overview.json']);
    expect((await manifestOf(cli, 'one')).sheets).toHaveLength(3);
    const from = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'from', '--from-sheet', '2']);
    expect(from.json.result).toMatchObject({ sheets: 3, rendered: [2, 3] });
    expect(await filesOf(cli, 'from')).toEqual(['overview-0002.png', 'overview-0003.png', 'overview.json']);
    // Drawing a sheet again later leaves the others as they are.
    const first = await readFile(join(cli.dir, 'one', 'overview.json'), 'utf8');
    expect((await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'one', '--sheet', '3'])).code).toBe(0);
    expect(await filesOf(cli, 'one')).toEqual(['overview-0002.png', 'overview-0003.png', 'overview.json']);
    expect(await readFile(join(cli.dir, 'one', 'overview.json'), 'utf8')).toBe(first);
  });

  it('fills the last sheet only as far as there are pages: it is shorter than the others', async () => {
    const cli = await bookWorkspace(20);
    const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'last']);
    expect(done.code).toBe(0);
    const manifest = await manifestOf(cli, 'last');
    const heights = await Promise.all(manifest.sheets.map(async (sheet) => size(new Uint8Array(await readFile(join(cli.dir, 'last', sheet.file))))[1]));
    expect(heights[0]).toBe(heights[1]);
    expect(heights[2]).toBeLessThan(heights[0] as number);
    expect(manifest.sheets[2]?.pages).toEqual([16, 17, 18, 19]);
  });

  it('refuses a range without pages with a usage error that says what is wrong, and draws nothing', async () => {
    const cli = await bookWorkspace(20);
    const backwards = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'none', '--from', '9', '--to', '4']);
    expect(backwards.code).toBe(2);
    expect(backwards.json.error).toMatchObject({ code: 'E_USAGE' });
    expect(backwards.json.error?.message).toBe('The range of pages is empty: --from 9 is after --to 4.');
    expect(backwards.json.error?.hint).toContain('both ends');
    const past = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'none', '--from', '20']);
    expect(past.code).toBe(2);
    expect(past.json.error?.message).toBe('--from 20 is past the last page: this PDF has 20 pages (zero-based 0..19), so there is nothing to draw.');
    const text = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'none', '--from', '20'], { json: false });
    expect(text.code).toBe(2);
    expect(text.stderr).toContain('mcprep: error [E_USAGE] --from 20 is past the last page');
    await expect(readdir(join(cli.dir, 'none'))).rejects.toThrow();
  });

  it('refuses options out of range and a sheet that does not exist', async () => {
    const cli = await bookWorkspace(20);
    const refused = async (...args: string[]): Promise<string> => {
      const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'no', ...args]);
      expect(done.code, args.join(' ')).toBe(2);
      expect(done.json.error?.code).toBe('E_USAGE');
      return done.json.error?.message ?? '';
    };
    expect(await refused('--per-sheet', '13')).toBe('--per-sheet must be a whole number from 1 to 12, not 13.');
    expect(await refused('--per-sheet', '0')).toContain('--per-sheet must be a whole number from 1 to 12');
    expect(await refused('--per-sheet', '2.5')).toContain('not 2.5');
    expect(await refused('--columns', '0')).toContain('--columns must be a whole number from 1 to 12');
    expect(await refused('--scale', '3')).toBe('--scale must be a number of pixels per point from 0.2 to 2, not 3.');
    expect(await refused('--from', '-1')).toContain('--from must be a whole number from 0');
    expect(await refused('--to', '1.5')).toContain('--to must be a whole number from 0');
    expect(await refused('--sheet', '4')).toBe('There are 3 sheets; there is no sheet 4.');
    expect(await refused('--from-sheet', '9')).toBe('There are 3 sheets; there is no sheet 9.');
    expect(await refused('--sheet', '0')).toBe('--sheet must be a whole number from 1, not 0.');
    expect(await refused('--sheet', '1', '--from-sheet', '2')).toBe('Use --sheet or --from-sheet, not both.');
    expect(await refused('--per-sheet', 'many')).toContain('needs a number');
    const alone = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'no', '--to', '3', '--sheet', '2']);
    expect(alone.json.error?.message).toBe('There is 1 sheet; there is no sheet 2.');
    const missing = await cli(['pages', 'sheets', '--pdf', 'book.pdf']);
    expect(missing.code).toBe(2);
    expect(missing.json.error?.message).toContain('needs --out');
  });

  it('cuts a --to past the last page back and says so, in the notes and in the text', async () => {
    const cli = await bookWorkspace(10);
    const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'cut', '--from', '6', '--to', '99']);
    expect(done.code, done.stdout).toBe(0);
    expect(done.json.result).toMatchObject({ from: 6, to: 9, sheets: 1 });
    expect(done.json.notes).toEqual(['--to 99 is past the last page; the range ends at page 9 (this PDF has 10 pages).']);
    const text = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'cut', '--from', '6', '--to', '99'], { json: false });
    expect(text.stdout).toContain('--to 99 is past the last page');
  });

  it('says in plain words what was drawn and what to do with it', async () => {
    const cli = await bookWorkspace(20);
    const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'overview'], { json: false });
    expect(done.code).toBe(0);
    const lines = done.stdout.trim().split('\n');
    expect(lines[0]).toContain('Pages 0-19 of 20: 3 sheets of at most 8 pages (4 columns, cells 380 x 514 px at 0.6176 px/pt, sheets up to 1560 x 1052 px); drew all of them into ');
    expect(lines[0]).toContain('overview.json lists the pages of each sheet.');
    expect(lines[1]).toContain('Look at every sheet');
    expect(lines[1]).toContain('not the small print');
    expect(lines[1]).toContain('`mcprep render PAGE`');
    const one = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'overview', '--sheet', '2'], { json: false });
    expect(one.stdout).toContain('drew 1 sheet into ');
  });

  it('warns when a sheet is larger than a model takes in whole, and names the files of an earlier run that overview.json does not list', async () => {
    const cli = await bookWorkspace(24);
    await mkdir(join(cli.dir, 'big'));
    await writeFile(join(cli.dir, 'big', 'overview-0042.png'), 'left over');
    const done = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'big', '--per-sheet', '12']);
    expect(done.code, done.stdout).toBe(0);
    expect(done.json.notes).toHaveLength(2);
    expect(done.json.notes?.[0]).toContain('reduced before a model sees it');
    expect(done.json.notes?.[1]).toContain('1 file in the folder look like sheets of an earlier run');
    expect(done.json.notes?.[1]).toContain('overview-0042.png');
    expect(done.json.result['unlisted']).toEqual(['overview-0042.png']);
  });

  it('writes the same overview.json and the same sheets for the same book and options', async () => {
    const cli = await bookWorkspace(12);
    expect((await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'a', '--per-sheet', '5'])).code).toBe(0);
    expect((await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'b', '--per-sheet', '5'])).code).toBe(0);
    expect(await filesOf(cli, 'a')).toEqual(await filesOf(cli, 'b'));
    for (const name of await filesOf(cli, 'a')) expect(Buffer.compare(await readFile(join(cli.dir, 'a', name)), await readFile(join(cli.dir, 'b', name))), name).toBe(0);
  });

  it('fails like the other commands when there is no PDF or no project, and when the folder cannot be made', async () => {
    const cli = await bookWorkspace(4);
    const noProject = await cli(['pages', 'sheets', '--out', 'x']);
    expect(noProject.code).toBe(3);
    expect(noProject.json.error?.code).toBe('E_NO_PROJECT');
    const noPdf = await cli(['pages', 'sheets', '--pdf', 'missing.pdf', '--out', 'x']);
    expect(noPdf.code).toBe(3);
    expect(noPdf.json.error?.code).toBe('E_PDF_MISSING');
    await writeFile(join(cli.dir, 'taken'), 'a file');
    const blocked = await cli(['pages', 'sheets', '--pdf', 'book.pdf', '--out', 'taken']);
    expect(blocked.code).toBe(3);
    expect(blocked.json.error?.code).toBe('E_WRITE');
    await writeFile(join(cli.dir, 'not.pdf'), 'this is not a PDF');
    const broken = await cli(['pages', 'sheets', '--pdf', 'not.pdf', '--out', 'x']);
    expect(broken.code).toBe(3);
    expect(broken.json.error?.code).toBe('E_PDF_INVALID');
  });

  it('is described by its help, with the options of the page commands and a note on what it is for', async () => {
    const cli = await bookWorkspace(2);
    const help = await cli(['help', 'pages', 'sheets'], { json: false });
    expect(help.code).toBe(0);
    for (const option of ['--out <folder>', '--from <page>', '--to <page>', '--per-sheet <n>', '--columns <n>', '--scale <px/pt>', '--sheet <n>', '--from-sheet <n>', '--pdf <file>', '--project <file>']) expect(help.stdout, option).toContain(option);
    expect(help.stdout).toContain('Usage: mcprep pages sheets --out <folder> [options]');
    expect(help.stdout).toContain('body text is at the edge of what can be read');
    expect(help.stdout).toContain('never for copying a label, a count or an answer');
    expect(help.stdout).toContain('mcprep render PAGE');
    expect((await cli(['pages', 'sheets', '--help'], { json: false })).stdout).toContain('Overview sheets of every page');
  });
});
