import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspace } from './helpers.js';

describe('propose', () => {
  it('suggests frames with evidence and does not change the project', async () => {
    const cli = await workspace();
    const before = await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8');
    const proposed = await cli(['propose']);
    expect(proposed.code).toBe(0);
    const result = proposed.json.result as {
      proposals: { id: string; kind: string; page: number; confidence: number; evidence: string[]; continues?: unknown[]; parts?: { dividers: number[] } }[];
      contexts: { appliesTo: string[] }[];
      operations: { op: string }[];
      applied: boolean;
    };
    expect(result.applied).toBe(false);
    expect(result.proposals.map((proposal) => proposal.kind)).toEqual(['exercise', 'exercise', 'exercise', 'exercise', 'bookmark', 'exercise', 'bookmark']);
    expect(result.proposals[1]?.parts?.dividers).toHaveLength(2);
    expect(result.proposals[3]?.continues).toHaveLength(1);
    expect(result.contexts[0]?.appliesTo).toEqual(['p3', 'p4']);
    expect(result.proposals.every((proposal) => proposal.evidence.length > 0)).toBe(true);
    expect(result.operations.length).toBeGreaterThan(7);
    expect(await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8')).toBe(before);
    const human = await cli(['propose'], { json: false });
    expect(human.stdout).toContain('Nothing is applied unless you say --apply');
    expect(human.stdout).toContain('Evidence:');
  });

  it('limits to pages, to a threshold, to chosen proposals and to the statement convention', async () => {
    const cli = await workspace();
    const page0 = await cli(['propose', '--pages', '0']);
    expect((page0.json.result.proposals as unknown[]).length).toBe(2);
    expect(((await cli(['propose', '--no-bookmarks'])).json.result.proposals as { kind: string }[]).every((proposal) => proposal.kind === 'exercise')).toBe(true);
    const keep = await cli(['propose', '--parts', 'keep']);
    expect((keep.json.result.operations as { op: string; first?: number }[]).some((op) => op.op === 'split' && op.first !== undefined)).toBe(false);
    const none = await cli(['propose', '--parts', 'none']);
    expect((none.json.result.operations as { op: string }[]).some((op) => op.op === 'split')).toBe(false);
    expect((await cli(['propose', '--parts', 'sideways'])).code).toBe(2);
    expect((await cli(['propose', '--ids', 'p99'])).code).toBe(2);
    expect((await cli(['propose', '--pages', '9'])).code).toBe(2);
    const noGraphics = await cli(['propose', '--no-graphics']);
    const withGraphics = await cli(['propose']);
    const bottom = (result: { json: { result: Record<string, unknown> } }): number => ((result.json.result.proposals as { rect: { bottom: number } }[])[5] as { rect: { bottom: number } }).rect.bottom;
    expect(bottom(noGraphics)).toBeLessThan(bottom(withGraphics));
  });

  it('writes the operations to a file that frames apply takes, and applies them with --apply', async () => {
    const cli = await workspace();
    const written = await cli(['propose', '--ops', 'batch.json']);
    expect(written.code).toBe(0);
    const batch = JSON.parse(await readFile(join(cli.dir, 'batch.json'), 'utf8')) as { operations: unknown[] };
    expect(batch.operations.length).toBeGreaterThan(7);
    const applied = await cli(['frames', 'apply', 'batch.json']);
    expect(applied.code).toBe(0);
    expect(applied.json.result.validation).toMatchObject({ ok: true });
    expect((applied.json.warnings ?? []).length).toBe(0);

    const other = await workspace();
    const direct = await other(['propose', '--apply', '--ids', 'p1,p2']);
    expect(direct.code).toBe(0);
    expect(direct.json.result).toMatchObject({ applied: true, counts: { exercise: 2 } });
  });
});

describe('from proposals to a bundle the importer accepts', () => {
  it('validates, exports deterministically and passes the importer check', async () => {
    const cli = await workspace();
    expect((await cli(['propose', '--apply'])).code).toBe(0);
    const valid = await cli(['validate']);
    expect(valid.code).toBe(0);
    expect(valid.json.result).toMatchObject({ ok: true, errors: [], counts: { exercise: 5, bookmark: 2 } });
    const labels = (valid.json.result.numbers as { label: string }[]).map((entry) => entry.label).sort();
    expect(labels).toEqual(['B1', 'B2', 'E1', 'E2.1', 'E2.2', 'E2.3', 'E3', 'E4', 'E5.1', 'E5.2']);

    await cli(['outline', 'derive', '--apply']);
    const exported = await cli(['export', '--out', 'out/sheet.mcbundle', '--created-at', '2026-10-03T12:00:00Z']);
    expect(exported.code).toBe(0);
    const result = exported.json.result as { path: string; bytes: number; sha256: string; manifest: { document: { title: string; folder: string; pageCount: number }; outline: string }; importCheck: { ok: boolean }; counts: { frames: number } };
    expect(result.importCheck.ok).toBe(true);
    expect(result.manifest.document).toMatchObject({ title: 'Calculus Sheet 1', folder: 'Examples/Calculus', pageCount: 3 });
    expect(result.manifest.outline).toBe('outline.json');
    expect(result.counts.frames).toBe(10);
    const first = await readFile(result.path);

    const again = await cli(['export', '--out', 'out/again.mcbundle', '--created-at', '2026-10-03T12:00:00Z']);
    expect(await readFile(String(again.json.result.path))).toEqual(first);
    const epoch = await cli(['export', '--out', 'out/epoch.mcbundle'], { env: { SOURCE_DATE_EPOCH: '1790000000' } });
    expect((epoch.json.result.manifest as { createdAt: string }).createdAt).toBe(new Date(1790000000 * 1000).toISOString().replace('.000Z', 'Z'));

    const check = await cli(['import-check', 'out/sheet.mcbundle']);
    expect(check.code).toBe(0);
    expect(check.json.result).toMatchObject({ wouldImport: true, errors: [], repairs: [] });
    expect((check.json.result.steps as { status: string }[]).map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const text = await cli(['import-check', 'out/sheet.mcbundle'], { json: false });
    expect(text.stdout).toContain('would ACCEPT');

    const inspect = await cli(['inspect-bundle', 'out/sheet.mcbundle']);
    expect(inspect.code).toBe(0);
    expect(inspect.json.result).toMatchObject({ ok: true, document: { title: 'Calculus Sheet 1' } });
    expect((inspect.json.result.numbers as unknown[]).length).toBe(10);
    expect((await cli(['inspect-bundle', 'out/sheet.mcbundle'], { json: false })).stdout).toContain('E2.1');
  });

  it('exports with another title, folder and outline source', async () => {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.22,0.9,0.29']);
    const exported = await cli(['export', '--out', 'x.mcbundle', '--title', 'Other', '--folder', 'A/B/C', '--outline', 'pdf']);
    expect(exported.json.result).toMatchObject({ manifest: { document: { title: 'Other', folder: 'A/B/C' }, outline: 'outline.json' }, counts: { outlineEntries: 4 } });
    expect((await cli(['export', '--outline', 'sideways'])).code).toBe(2);
    expect((await cli(['export', '--created-at', 'yesterday'])).code).toBe(2);
    const defaultName = await cli(['export']);
    expect(String(defaultName.json.result.path)).toBe(join(cli.dir, 'sheet.mcbundle'));
  });

  it('refuses to export a project with errors (exit 4) and names them', async () => {
    const cli = await workspace();
    const path = join(cli.dir, 'sheet.mcprep.json');
    const project = JSON.parse(await readFile(path, 'utf8')) as { frames: unknown[] };
    project.frames.push({ id: 'bad', kind: 'exercise', page: 42, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } });
    await writeFile(path, JSON.stringify(project));
    const failed = await cli(['export']);
    expect(failed.code).toBe(4);
    expect(failed.json.error?.code).toBe('E_VALIDATION');
    expect(failed.json.error?.issues?.[0]).toMatchObject({ code: 'page-out-of-range', frameId: 'bad' });
    const validate = await cli(['validate']);
    expect(validate.code).toBe(4);
    expect(validate.json.result.errors).toMatchObject([{ code: 'page-out-of-range', frameId: 'bad' }]);
    expect((await cli(['validate'], { json: false })).stderr).toBe('');
    expect((await cli(['validate'], { json: false })).stdout).toContain('NOT valid');
    // The bad frame can still be removed with the commands.
    expect((await cli(['frames', 'delete', 'bad'])).code).toBe(0);
    expect((await cli(['validate'])).code).toBe(0);
  });

  it('validate --strict also fails on warnings, and warnings never block an export', async () => {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'bookmark', '--page', '0', '--rect', '0.1,0.02,0.9,0.2']);
    const plain = await cli(['validate']);
    expect(plain.code).toBe(0);
    expect((plain.json.result.warnings as { code: string }[]).map((entry) => entry.code)).toContain('includes-header-footer');
    expect((await cli(['validate', '--strict'])).code).toBe(4);
    expect((await cli(['export'])).code).toBe(0);
  });

  it('import-check rejects damaged bundles with exit code 4 and the reason', async () => {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.22,0.9,0.29']);
    await cli(['export', '--out', 'good.mcbundle']);
    const bytes = await readFile(join(cli.dir, 'good.mcbundle'));
    // Damage the PDF inside: the hash no longer matches.
    const tampered = Buffer.from(bytes);
    const at = tampered.indexOf(Buffer.from('%PDF-1.4'));
    tampered[at + 200] = (tampered[at + 200] as number) ^ 0xff;
    await writeFile(join(cli.dir, 'tampered.mcbundle'), tampered);
    const failed = await cli(['import-check', 'tampered.mcbundle']);
    expect(failed.code).toBe(4);
    expect(failed.json.result).toMatchObject({ wouldImport: false, rejection: { code: expect.stringMatching(/pdf-hash-mismatch|zip-crc/) } });
    await writeFile(join(cli.dir, 'junk.mcbundle'), 'not a zip at all');
    const junk = await cli(['import-check', 'junk.mcbundle']);
    expect(junk.code).toBe(4);
    expect(junk.json.result).toMatchObject({ wouldImport: false });
    expect((await cli(['import-check', 'nothing.mcbundle'])).code).toBe(3);
    expect((await cli(['import-check'])).code).toBe(2);
  });
});

describe('the documents the tool carries', () => {
  it('prints the JSON schemas', async () => {
    const cli = await workspace({ init: false });
    expect((await cli(['schema'])).json.result.schemas).toEqual(['bundle-manifest', 'frames', 'outline', 'project', 'book-summary', 'verify', 'sample', 'gate', 'notes', 'compare', 'sheets', 'visual']);
    const frames = await cli(['schema', 'frames']);
    expect(frames.code).toBe(0);
    expect((frames.json.result.schema as { title: string }).title).toContain('frames.json');
    expect((await cli(['schema', 'nope'])).code).toBe(2);
  });
});
