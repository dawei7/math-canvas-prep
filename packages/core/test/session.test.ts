import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBundle } from '../src/bundle/reader.js';
import { readProjectFile, writeProjectFile } from '../src/project/store.js';
import { ProjectSession } from '../src/session.js';
import { buildPdf } from '../src/testing/pdf-writer.js';
import { VERSION } from '../src/version.js';
import type { Operation } from '../src/project/ops.js';
import { rejected, sampleProject, tempDir } from './helpers.js';

describe('a project session on the synthetic sample', () => {
  it('opens the PDF, applies operations atomically and keeps the file in step', async () => {
    const { session } = await sampleProject();
    const outcome = await session.apply(
      [
        { op: 'add', ref: 'one', kind: 'exercise', page: 0, rect: [0.1, 0.22, 0.9, 0.29] },
        { op: 'add', ref: 'two', kind: 'exercise', page: 0, rect: [0.1, 0.29, 0.9, 0.4] },
        { op: 'split', id: '@two', at: [0.34, 0.36] },
      ],
      { modifiedBy: 'test' },
    );
    expect(outcome.applied).toBe(true);
    expect(outcome.validation.errors).toEqual([]);
    expect(outcome.batch.created).toEqual(['f1', 'f2', 'f4', 'f5']);
    const onDisk = await readProjectFile(session.projectPath);
    expect(onDisk.frames).toHaveLength(4);
    expect(onDisk.modifiedBy).toBe('test');
    expect(onDisk.revision).toBe(2);
    await session.close();
  });

  it('rejects a batch that introduces errors and leaves the file as it was, unless forced', async () => {
    const { session } = await sampleProject();
    const before = await readFile(session.projectPath, 'utf8');
    const bad: Operation[] = [
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.3], unit: 'u1' },
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.35, 0.9, 0.4], unit: 'u1' },
    ];
    const outcome = await session.apply(bad, { modifiedBy: 'test' });
    expect(outcome.applied).toBe(false);
    expect(outcome.rejected).toBe(true);
    expect(outcome.introduced.map((entry) => entry.code)).toEqual(['unit-gap']);
    expect(await readFile(session.projectPath, 'utf8')).toBe(before);
    const forced = await session.apply(bad, { modifiedBy: 'test', force: true });
    expect(forced.applied).toBe(true);
    expect((await readProjectFile(session.projectPath)).frames).toHaveLength(2);
    await session.close();
  });

  it('does not write on a dry run', async () => {
    const { session } = await sampleProject();
    const before = await readFile(session.projectPath, 'utf8');
    const outcome = await session.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.3] }], { modifiedBy: 'test', dryRun: true });
    expect(outcome.applied).toBe(false);
    expect(outcome.rejected).toBe(false);
    expect(outcome.project.frames).toHaveLength(1);
    expect(await readFile(session.projectPath, 'utf8')).toBe(before);
    await session.close();
  });

  it('snaps to the printed lines of the PDF', async () => {
    const { session } = await sampleProject();
    const text = await session.pageText(0);
    const line = text.lines.find((entry) => entry.text.startsWith('Exercise 1.'));
    const next = text.lines.find((entry) => entry.text.startsWith('it at x = 2.'));
    // The top edge is a little way into the first line, the bottom edge well into the second: both lines are taken whole.
    const top = (line?.rect.top ?? 0) + 0.004;
    const bottom = (next?.rect.top ?? 0) + 0.01;
    const outcome = await session.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, top, 0.9, bottom], snap: true }], { modifiedBy: 'test' });
    const added = outcome.project.frames[0];
    expect(added?.rect.top).toBeCloseTo((line?.rect.top ?? 0) - 0.006, 3);
    expect(added?.rect.bottom).toBeCloseTo((next?.rect.bottom ?? 0) + 0.004, 3);
    expect(outcome.batch.notes.length).toBeGreaterThanOrEqual(2);
    await session.close();
  });

  it('warns about an edge that cuts a line and about a header inside a frame', async () => {
    const { session } = await sampleProject();
    const text = await session.pageText(0);
    const line = text.lines.find((entry) => entry.text.startsWith('Exercise 1.'));
    await session.apply(
      [
        { op: 'add', kind: 'exercise', page: 0, rect: [0.1, (line?.rect.top ?? 0) + 0.006, 0.9, 0.3] },
        { op: 'add', kind: 'bookmark', page: 0, rect: [0.1, 0.02, 0.9, 0.2] },
      ],
      { modifiedBy: 'test' },
    );
    const validation = await session.validate();
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((entry) => entry.code)).toEqual(expect.arrayContaining(['clips-line', 'includes-header-footer']));
    await session.close();
  });

  it('exports a bundle that the importer check accepts, with the outline mode of choice', async () => {
    const { session, dir } = await sampleProject();
    await session.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.22, 0.9, 0.29] }], { modifiedBy: 'test' });
    const out = join(dir, 'sheet.mcbundle');
    const none = await session.exportBundle(out, { createdAt: new Date('2026-10-03T12:00:00Z') });
    expect(none.check?.ok).toBe(true);
    expect(none.write.manifest.outline).toBeUndefined();
    expect(none.write.manifest.document).toMatchObject({ title: 'Calculus Sheet 1', folder: 'Examples/Calculus' });
    expect(none.write.manifest.generator.version).toBe(VERSION);

    const fromPdf = await session.exportBundle(out, { outline: 'pdf' });
    expect(fromPdf.write.counts.outlineEntries).toBe(4);
    expect((await checkBundle(out)).outline).toHaveLength(4);

    await session.apply([{ op: 'outline.set', entries: [{ title: 'Mine', page: 0, depth: 0 }] }], { modifiedBy: 'test' });
    const own = await session.exportBundle(out, { outline: 'project', title: 'Another title', folder: 'X/Y' });
    expect(own.write.counts.outlineEntries).toBe(1);
    const report = await checkBundle(out);
    expect(report.document).toMatchObject({ title: 'Another title', folder: 'X/Y' });
    await session.close();
  });

  it('refuses to export a project that the importer would reject', async () => {
    const { session } = await sampleProject();
    const project = await readProjectFile(session.projectPath);
    await writeProjectFile(session.projectPath, { ...project, frames: [{ id: 'bad', kind: 'exercise', page: 99, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } }] });
    const error = await rejected(session.exportBundle(undefined));
    expect(error.code).toBe('E_VALIDATION');
    expect(error.issues[0]?.code).toBe('page-out-of-range');
    await session.close();
  });

  it('sees changes that another program made to the file', async () => {
    const { session } = await sampleProject();
    const other = await ProjectSession.open(session.projectPath);
    await other.apply([{ op: 'add', kind: 'bookmark', page: 1, rect: [0.1, 0.1, 0.9, 0.2] }], { modifiedBy: 'agent' });
    expect(session.project.frames).toHaveLength(0);
    expect(await session.refresh()).toBe(true);
    expect(session.project.frames).toHaveLength(1);
    expect(await session.refresh()).toBe(false);
    await other.close();
    await session.close();
  });

  it('knows when the PDF is not the one the project was made for, or is gone', async () => {
    const { session, pdfPath } = await sampleProject();
    await session.close();
    await writeFile(pdfPath, buildPdf({ pages: [{}, {}, {}] }));
    const reopened = await ProjectSession.open(session.projectPath);
    await expect(reopened.document()).rejects.toMatchObject({ code: 'E_PDF_CHANGED' });
    const tolerant = await ProjectSession.open(session.projectPath, { ignorePdfChange: true });
    await expect(tolerant.document()).resolves.toBeDefined();
    await tolerant.close();

    const dir = await tempDir();
    const lonely = await sampleProject();
    const missing = await ProjectSession.open(lonely.session.projectPath);
    await writeFile(join(dir, 'unused.txt'), 'x');
    await lonely.session.close();
    const { rm } = await import('node:fs/promises');
    await rm(lonely.pdfPath);
    await expect(missing.document()).rejects.toMatchObject({ code: 'E_PDF_MISSING' });
  });

  it('detects a changed page count even when the hash is ignored', async () => {
    const { session, pdfPath } = await sampleProject();
    await session.close();
    await writeFile(pdfPath, buildPdf({ pages: [{}] }));
    const tolerant = await ProjectSession.open(session.projectPath, { ignorePdfChange: true });
    await expect(tolerant.document()).rejects.toMatchObject({ code: 'E_PDF_CHANGED' });
  });
});
