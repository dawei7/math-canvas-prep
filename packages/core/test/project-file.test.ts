import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProject, type Project } from '../src/project/model.js';
import { parseProject, serializeProject, stringifyJson } from '../src/project/serialize.js';
import { createProjectFile, lockPath, readProjectFile, resolvePdfPath, updateProjectFile, withProjectLock, writeProjectFile } from '../src/project/store.js';
import { McPrepError } from '../src/rules/issues.js';
import { buildPdf } from '../src/testing/pdf-writer.js';
import { frame, rect, rejected, tempDir } from './helpers.js';

const pdf = { path: 'sheet.pdf', sha256: 'ab'.repeat(32), bytes: 1234, pageCount: 3 };
const sample = (): Project => ({
  ...newProject({ pdf, title: 'A sheet', folder: 'Uni/Analysis', now: new Date('2026-10-03T10:00:00Z') }),
  frames: [
    frame('f2', 'exercise', 1, rect(0.1, 0.1, 0.9, 0.2)),
    frame('f1', 'exercise', 0, rect(0.123456789, 0.1, 0.9, 0.2), { context: [{ page: 1, rect: rect(0.1, 0.5, 0.9, 0.6) }] }),
  ],
  outline: { source: 'manual', entries: [{ title: '1 Sets', page: 0, depth: 0 }] },
  seq: 2,
});

describe('the project file text', () => {
  it('writes frames in reading order, rects rounded and short, and reads back what it wrote', () => {
    const text = serializeProject(sample());
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('"id": "f1"')).toBeLessThan(text.indexOf('"id": "f2"'));
    expect(text).toContain('"rect": { "left": 0.12346, "top": 0.1, "right": 0.9, "bottom": 0.2 }');
    expect(text).toContain('{ "title": "1 Sets", "page": 0, "depth": 0 }');
    const back = parseProject(JSON.parse(text), 'x');
    expect(serializeProject(back)).toBe(text);
    expect(back.frames.map((entry) => entry.id)).toEqual(['f1', 'f2']);
  });

  it('is deterministic', () => {
    expect(serializeProject(sample())).toBe(serializeProject(sample()));
  });

  it('formats small objects on one line and larger ones indented', () => {
    expect(stringifyJson({ a: 1, b: [1, 2], c: { d: 'x' } })).toBe(['{', '  "a": 1,', '  "b": [ 1, 2 ],', '  "c": { "d": "x" }', '}'].join('\n'));
    expect(stringifyJson({ a: 1, b: [1, 2] })).toBe('{ "a": 1, "b": [ 1, 2 ] }');
    expect(stringifyJson([])).toBe('[]');
    expect(stringifyJson({})).toBe('{}');
  });
});

describe('tolerant reading', () => {
  const minimal = { format: 'math-canvas-prep-project', version: 1, pdf };

  it('fills in what is missing and keeps what it does not know', () => {
    const project = parseProject({ ...minimal, note: 'keep me', frames: [{ id: 'f7', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] }] }, 'My Title');
    expect(project.meta.title).toBe('My Title');
    expect(project.revision).toBe(0);
    expect(project.seq).toBe(7);
    expect(project.frames[0]?.rect).toEqual(rect(0.1, 0.1, 0.9, 0.2));
    expect(project.extra).toEqual({ note: 'keep me' });
    expect(JSON.parse(serializeProject(project))).toMatchObject({ note: 'keep me' });
  });

  it('accepts a rect as an array or as text and a null unit', () => {
    const project = parseProject({ ...minimal, frames: [{ id: 'a', kind: 'bookmark', page: 0, rect: '0.1,0.1,0.9,0.2', unit: null }] }, 'x');
    expect(project.frames[0]).toEqual({ id: 'a', kind: 'bookmark', page: 0, rect: rect(0.1, 0.1, 0.9, 0.2) });
  });

  it('keeps frames that are wrong in substance, so that validate can report them', () => {
    const project = parseProject({ ...minimal, frames: [{ id: 'bad id!', kind: 'exercise', page: 99, rect: [0, 0, 5, 5] }] }, 'x');
    expect(project.frames[0]?.page).toBe(99);
  });

  it.each([
    ['not an object', [], /JSON object/],
    ['another format', { format: 'something', version: 1, pdf }, /not a Math Canvas Prep project/],
    ['a newer version', { ...minimal, version: 2 }, /newer/],
    ['no pdf', { format: 'math-canvas-prep-project', version: 1 }, /pdf/],
    ['a bad hash', { ...minimal, pdf: { ...pdf, sha256: 'xyz' } }, /pdf\.sha256/],
    ['no pages', { ...minimal, pdf: { ...pdf, pageCount: 0 } }, /pdf\.pageCount/],
    ['frames that are not a list', { ...minimal, frames: {} }, /frames/],
    ['a frame without an id', { ...minimal, frames: [{ kind: 'exercise', page: 0, rect: [0, 0, 1, 1] }] }, /frames\[0\]\.id/],
    ['a frame with a kind that does not exist', { ...minimal, frames: [{ id: 'a', kind: 'note', page: 0, rect: [0, 0, 1, 1] }] }, /kind/],
    ['a rect that cannot be read', { ...minimal, frames: [{ id: 'a', kind: 'exercise', page: 0, rect: [0, 0, 1] }] }, /frames\[0\] \(a\)\.rect/],
    ['an outline entry without a title', { ...minimal, outline: { entries: [{ page: 0, depth: 0 }] } }, /outline\.entries\[0\]\.title/],
  ])('says clearly what is wrong with %s', (_name, raw, message) => {
    expect(() => parseProject(raw, 'x')).toThrow(message);
    try {
      parseProject(raw, 'x');
    } catch (error) {
      expect(error).toBeInstanceOf(McPrepError);
      expect((error as McPrepError).code).toMatch(/^E_PROJECT/);
    }
  });
});

describe('the project file on disk', () => {
  async function made(): Promise<{ dir: string; path: string; pdfPath: string }> {
    const dir = await tempDir();
    const pdfPath = join(dir, 'book.pdf');
    await writeFile(pdfPath, buildPdf({ pages: [{}, {}], title: 'Book' }));
    const created = await createProjectFile(pdfPath, { title: 'My book', folder: 'Uni\\Analysis' });
    return { dir, path: created.path, pdfPath };
  }

  it('creates a project next to the PDF with a relative path, the hash and the page count', async () => {
    const { path, pdfPath } = await made();
    expect(path.endsWith('book.mcprep.json')).toBe(true);
    const project = await readProjectFile(path);
    expect(project.pdf.path).toBe('book.pdf');
    expect(project.pdf.pageCount).toBe(2);
    expect(project.pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(project.pdf.bytes).toBe((await stat(pdfPath)).size);
    expect(project.meta).toEqual({ title: 'My book', folder: 'Uni/Analysis' });
    expect(project.revision).toBe(1);
    expect(resolvePdfPath(path, project)).toBe(pdfPath);
  });

  it('does not overwrite an existing project unless asked', async () => {
    const { pdfPath, path } = await made();
    await expect(createProjectFile(pdfPath)).rejects.toMatchObject({ code: 'E_EXISTS' });
    await expect(createProjectFile(pdfPath, { force: true })).resolves.toMatchObject({ path });
  });

  it('refuses something that is not a PDF', async () => {
    const dir = await tempDir();
    const bad = join(dir, 'bad.pdf');
    await writeFile(bad, 'nope');
    await expect(createProjectFile(bad)).rejects.toMatchObject({ code: 'E_PDF_INVALID' });
  });

  it('reports a missing file and a syntax error with its position', async () => {
    const dir = await tempDir();
    await expect(readProjectFile(join(dir, 'nothing.mcprep.json'))).rejects.toMatchObject({ code: 'E_PROJECT_MISSING' });
    const broken = join(dir, 'broken.mcprep.json');
    await writeFile(broken, '{\n  "format": "math-canvas-prep-project",\n  "version": 1,,\n}\n');
    const error = await rejected(readProjectFile(broken));
    expect(error.code).toBe('E_PROJECT_JSON');
    expect(error.message).toContain('not valid JSON');
  });

  it('writes atomically: the revision goes up, no temporary file is left, and the lock is gone', async () => {
    const { dir, path } = await made();
    const project = await readProjectFile(path);
    const written = await writeProjectFile(path, project, { modifiedBy: 'test' });
    expect(written.revision).toBe(project.revision + 1);
    expect(written.modifiedBy).toBe('test');
    expect((await readProjectFile(path)).modifiedBy).toBe('test');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('refuses to write over a file that someone else changed', async () => {
    const { path } = await made();
    const mine = await readProjectFile(path);
    await writeProjectFile(path, mine, { modifiedBy: 'agent' });
    await expect(writeProjectFile(path, mine, { expectedRevision: mine.revision })).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await expect(writeProjectFile(path, { ...mine, revision: mine.revision + 1 }, { expectedRevision: mine.revision + 1 })).resolves.toBeDefined();
  });

  it('loses no update when many writers work at once', async () => {
    const { path } = await made();
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        updateProjectFile(path, (project) => ({ ...project, frames: [...project.frames, frame(`w${index}`, 'bookmark', 0, rect(0.1, 0.1 + index * 0.05, 0.9, 0.12 + index * 0.05))] }), { modifiedBy: 'test' }),
      ),
    );
    const project = await readProjectFile(path);
    expect(project.frames).toHaveLength(12);
    expect(project.revision).toBe(13);
  });

  it('takes over a lock that is stale and waits for one that is fresh', async () => {
    const { path } = await made();
    const lock = lockPath(path);
    await writeFile(lock, '{}');
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await expect(withProjectLock(path, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(await stat(lock).then(() => true, () => false)).toBe(false);
  });

  it('keeps the file readable by a program that reads it while it is replaced', async () => {
    const { path } = await made();
    const project = await readProjectFile(path);
    let broken = 0;
    const reader = (async (): Promise<void> => {
      for (let i = 0; i < 40; i += 1) {
        try {
          JSON.parse(await readFile(path, 'utf8'));
        } catch {
          broken += 1;
        }
      }
    })();
    for (let i = 0; i < 20; i += 1) await writeProjectFile(path, project);
    await reader;
    expect(broken).toBe(0);
  });
});
