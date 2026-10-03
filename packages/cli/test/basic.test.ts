import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf } from '@mcprep/core/testing';
import { isPng, tempDir, workspace } from './helpers.js';

describe('help, usage and the conventions of every command', () => {
  it('prints the help and the version without a project', async () => {
    const cli = await workspace({ init: false });
    const help = await cli(['help'], { json: false });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Commands:');
    expect(help.stdout).toContain('ZERO-BASED');
    expect(help.stdout).toContain('frames split');
    const one = await cli(['help', 'frames', 'add'], { json: false });
    expect(one.stdout).toContain('Usage: mcprep frames add --kind');
    expect(one.stdout).toContain('--snap');
    expect((await cli(['frames', 'add', '--help'], { json: false })).stdout).toContain('Usage: mcprep frames add');
    const version = await cli(['--version'], { json: false });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits with 2 for usage errors and suggests what was meant', async () => {
    const cli = await workspace({ init: false });
    const unknown = await cli(['propoze']);
    expect(unknown.code).toBe(2);
    expect(unknown.json.error?.code).toBe('E_USAGE');
    expect(unknown.json.error?.hint).toContain('propose');
    const option = await cli(['init', 'sheet.pdf', '--titel', 'x']);
    expect(option.code).toBe(2);
    expect(option.json.error?.hint).toContain('--title');
    const missing = await cli(['init']);
    expect(missing.code).toBe(2);
    expect(missing.json.error?.message).toContain('<pdf>');
    const extra = await cli(['init', 'a.pdf', 'b.pdf']);
    expect(extra.code).toBe(2);
    const text = await cli(['init', 'a.pdf', 'b.pdf'], { json: false });
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('mcprep: error [E_USAGE]');
  });

  it('writes nothing but one JSON document to standard output with --json, also for errors', async () => {
    const cli = await workspace({ init: false });
    const failure = await cli(['info']);
    expect(failure.code).toBe(3);
    expect(failure.stderr).toBe('');
    expect(failure.json).toMatchObject({ ok: false, command: 'info', error: { code: 'E_NO_PROJECT' } });
    expect(failure.json.error?.hint).toContain('mcprep init');
  });
});

describe('init and info', () => {
  it('creates a project next to the PDF and says what to do next', async () => {
    const cli = await workspace({ init: false });
    const made = await cli(['init', 'sheet.pdf', '--title', 'My sheet', '--folder', 'Uni\\Analysis']);
    expect(made.code).toBe(0);
    expect(made.json).toMatchObject({ ok: true, command: 'init', result: { title: 'My sheet', folder: 'Uni/Analysis', pdf: { path: 'sheet.pdf', pageCount: 3 } } });
    expect((made.json.result['next'] as string[]).length).toBe(3);
    const text = JSON.parse(await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8')) as { pdf: { sha256: string } };
    expect(text.pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await cli(['init', 'sheet.pdf']);
    expect(again.code).toBe(3);
    expect(again.json.error?.code).toBe('E_EXISTS');
    expect((await cli(['init', 'sheet.pdf', '--force'])).code).toBe(0);
    const notPdf = await writeFile(join(cli.dir, 'bad.pdf'), 'x').then(() => cli(['init', 'bad.pdf']));
    expect(notPdf.code).toBe(3);
    expect(notPdf.json.error?.code).toBe('E_PDF_INVALID');
  });

  it('shows pages, sizes, text layer, outline and the frames', async () => {
    const cli = await workspace();
    const info = await cli(['info']);
    expect(info.code).toBe(0);
    expect(info.json.result).toMatchObject({
      project: { title: 'Calculus Sheet 1', folder: 'Examples/Calculus', revision: 1, modifiedBy: 'cli' },
      pdf: { pageCount: 3, pageSizes: [{ width: 595, height: 842, rotation: 0, pages: [0, 1, 2] }], textLayer: { checked: 3, withText: 3, withoutText: [] } },
      outline: { pdf: 4, project: null },
      frames: { exercises: 0, questions: 0, bookmarks: 0, total: 0 },
    });
    const text = await cli(['info'], { json: false });
    expect(text.stdout).toContain('3 pages');
    expect(text.stdout).toContain('text layer: present on all 3 pages');
  });

  it('finds the project from --project, from a folder, from MCPREP_PROJECT and refuses two', async () => {
    const cli = await workspace();
    const elsewhere = await tempDir();
    expect((await cli(['info', '--project', join(cli.dir, 'sheet.mcprep.json')])).code).toBe(0);
    expect((await cli(['info', '--project', cli.dir])).code).toBe(0);
    expect((await cli(['info'], { env: { MCPREP_PROJECT: join(cli.dir, 'sheet.mcprep.json') } })).code).toBe(0);
    expect((await cli(['-p', join(cli.dir, 'sheet.mcprep.json'), 'info'])).code).toBe(0);
    await writeFile(join(cli.dir, 'other.mcprep.json'), await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8'));
    const two = await cli(['info']);
    expect(two.code).toBe(3);
    expect(two.json.error?.message).toContain('several projects');
    expect(elsewhere.length).toBeGreaterThan(0);
  });

  it('refuses a PDF that is not the one the project was made for (exit 3) unless told to ignore it', async () => {
    const cli = await workspace();
    await writeFile(join(cli.dir, 'sheet.pdf'), buildPdf({ pages: [{}, {}, {}] }));
    const refused = await cli(['info']);
    expect(refused.code).toBe(3);
    expect(refused.json.error?.code).toBe('E_PDF_CHANGED');
    expect((await cli(['info', '--ignore-pdf-change'])).code).toBe(0);
  });

  it('relinks a moved PDF, and refuses a different one', async () => {
    const cli = await workspace();
    await mkdir(join(cli.dir, 'books'));
    await rename(join(cli.dir, 'sheet.pdf'), join(cli.dir, 'books', 'moved.pdf'));
    expect((await cli(['info'])).code).toBe(3);
    const relinked = await cli(['relink', 'books/moved.pdf']);
    expect(relinked.code).toBe(0);
    expect(relinked.json.result).toMatchObject({ changed: false, pdf: { path: 'books/moved.pdf' } });
    expect((await cli(['info'])).code).toBe(0);
    await writeFile(join(cli.dir, 'other.pdf'), buildPdf({ pages: [{}] }));
    expect((await cli(['relink', 'other.pdf'])).json.error?.code).toBe('E_PDF_CHANGED');
    const accepted = await cli(['relink', 'other.pdf', '--accept-changed']);
    expect(accepted.json.result).toMatchObject({ changed: true });
  });

  it('sets the title and folder', async () => {
    const cli = await workspace();
    expect((await cli(['meta'])).json.result).toMatchObject({ title: 'Calculus Sheet 1', folder: 'Examples/Calculus' });
    const changed = await cli(['meta', '--title', 'New', '--folder', 'A/B']);
    expect(changed.code).toBe(0);
    expect((await cli(['meta'])).json.result).toMatchObject({ title: 'New', folder: 'A/B' });
    expect((await cli(['meta', '--title', '  '])).code).toBe(4);
  });
});

describe('looking at the PDF: lines, render, crop', () => {
  it('lists the text lines with coordinates, regions and fonts', async () => {
    const cli = await workspace();
    const page = await cli(['lines', '0']);
    expect(page.code).toBe(0);
    const result = page.json.result as { lines: { text: string; rect: Record<string, number>; headerFooter?: boolean; fontSize: number }[]; hasText: boolean; size: object; columns: number };
    expect(result.hasText).toBe(true);
    expect(result.size).toEqual({ width: 595, height: 842, rotation: 0 });
    expect(result.lines.find((line) => line.text === 'Calculus Sheet 1')?.fontSize).toBe(20);
    expect(result.lines[0]?.headerFooter).toBe(true);
    const region = await cli(['lines', '0', '--region', '0,0.28,1,0.42']);
    expect((region.json.result.lines as { text: string }[]).map((line) => line.text)[0]).toContain('Exercise 2');
    const bold = await cli(['lines', '0', '--fonts']);
    expect((bold.json.result.lines as { text: string; bold?: boolean }[]).find((line) => line.text === 'Calculus Sheet 1')?.bold).toBe(true);
    const human = await cli(['lines', '0'], { json: false });
    expect(human.stdout).toContain('top-bottom');
    expect(human.stdout).toContain('[header/footer]');
  });

  it('rejects a page that does not exist (exit 4) and a page that is not a number (exit 2)', async () => {
    const cli = await workspace();
    const far = await cli(['lines', '9']);
    expect(far.code).toBe(4);
    expect(far.json.error?.code).toBe('E_PAGE');
    expect(far.json.error?.message).toContain('zero-based');
    expect((await cli(['lines', 'two'])).code).toBe(2);
    expect((await cli(['lines', '-1'])).code).toBe(2);
  });

  it('reports a page without text as a scan, and works on a plain PDF with --pdf', async () => {
    const cli = await workspace({ init: false });
    await writeFile(join(cli.dir, 'scan.pdf'), buildPdf({ pages: [{ scan: { bars: [{ left: 0.1, top: 0.2, right: 0.8, bottom: 0.24 }] } }] }));
    const scan = await cli(['lines', '0', '--pdf', 'scan.pdf']);
    expect(scan.json.result).toMatchObject({ hasText: false, lines: [] });
    expect((await cli(['lines', '0', '--pdf', 'scan.pdf'], { json: false })).stdout).toContain('scan');
  });

  it('renders a page to a PNG with a grid, into the cache folder or where asked', async () => {
    const cli = await workspace();
    const page = await cli(['render', '0', '--grid', '0.1', '--max-side', '700']);
    expect(page.code).toBe(0);
    const result = page.json.result as { path: string; width: number; height: number; grid: number };
    expect(result.path).toContain('.mcprep-cache');
    expect(result.grid).toBe(0.1);
    expect(isPng(await readFile(result.path))).toBe(true);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(701);
    const asked = await cli(['render', '1', '--out', 'check/p1.png', '--max-side', '400']);
    expect(isPng(await readFile(join(cli.dir, 'check', 'p1.png')))).toBe(true);
    expect(asked.json.result.path).toBe(join(cli.dir, 'check', 'p1.png'));
    const folder = await cli(['render', '2', '--out', 'shots/', '--max-side', '400']);
    expect(String(folder.json.result.path)).toContain('page-2.png');
    expect((await cli(['render', '0', '--grid', '3'])).code).toBe(2);
    expect((await cli(['render', '7'])).code).toBe(4);
  });

  it('draws the frames on a page when asked, and crops frames, rectangles and everything', async () => {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.22,0.9,0.29', '--snap']);
    await cli(['frames', 'add', '--kind', 'bookmark', '--page', '1', '--rect', '0.1,0.11,0.9,0.18']);
    const plain = await cli(['render', '0', '--max-side', '500', '--out', 'plain.png']);
    const framed = await cli(['render', '0', '--frames', '--max-side', '500', '--out', 'framed.png']);
    expect(framed.json.result.frames).toBe(1);
    expect(await readFile(String(framed.json.result.path))).not.toEqual(await readFile(String(plain.json.result.path)));

    const one = await cli(['crop', 'f1', '--grid', '0.05', '--out', 'c/f1.png']);
    expect(one.code).toBe(0);
    expect(isPng(await readFile(join(cli.dir, 'c', 'f1.png')))).toBe(true);
    expect((one.json.result.crops as unknown[]).length).toBe(1);
    const rect = await cli(['crop', '--page', '2', '--rect', '0.1,0.3,0.9,0.5']);
    expect(rect.code).toBe(0);
    const all = await cli(['crop', '--all', '--out', 'all/']);
    expect((all.json.result.crops as { frame: string }[]).map((entry) => entry.frame)).toEqual(['f1', 'f2']);
    expect((await cli(['crop', 'nope'])).json.error?.code).toBe('E_NO_FRAME');
    expect((await cli(['crop'])).code).toBe(2);
    expect((await cli(['crop', 'f1', '--region', 'context:0'])).json.error?.code).toBe('E_NO_REGION');
  });
});

describe('the outline', () => {
  it('shows the PDF outline, adopts it, derives headings, sets and clears one', async () => {
    const cli = await workspace();
    const shown = await cli(['outline']);
    expect(shown.json.result).toMatchObject({ source: 'pdf' });
    expect((shown.json.result.entries as unknown[]).length).toBe(4);
    const adopted = await cli(['outline', 'pdf', '--adopt']);
    expect(adopted.json.result).toMatchObject({ adopted: true });
    expect((await cli(['outline'])).json.result).toMatchObject({ source: 'project', projectSource: 'pdf' });
    const set = await cli(['outline', 'set', '-'], { stdin: JSON.stringify([{ title: '1 Mine', page: 0, depth: 0 }, { title: '1.1 Sub', page: 1, depth: 1 }]) });
    expect(set.code).toBe(0);
    expect(((await cli(['outline'])).json.result.entries as unknown[]).length).toBe(2);
    expect((await cli(['outline', 'set', '-'], { stdin: '{nope' })).code).toBe(2);
    expect((await cli(['outline', 'set', '-'], { stdin: JSON.stringify([{ title: 'x', page: 9, depth: 0 }]) })).code).toBe(4);
    expect((await cli(['outline', 'clear'])).code).toBe(0);
    expect((await cli(['outline'])).json.result).toMatchObject({ source: 'pdf' });
    const derived = await cli(['outline', 'derive']);
    expect((derived.json.result.entries as { title: string }[]).map((entry) => entry.title)).toEqual(['Calculus Sheet 1']);
    await cli(['outline', 'derive', '--apply']);
    expect((await cli(['outline'])).json.result).toMatchObject({ source: 'project', projectSource: 'derived' });
  });
});
