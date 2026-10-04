import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBundleBytes } from '../src/bundle/writer.js';
import { newProject } from '../src/project/model.js';
import { serializeProject } from '../src/project/serialize.js';
import { parseFrames } from '../src/rules/frames.js';
import { buildAuthoritySample } from '../src/testing/authority-sample.js';

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
interface AjvLike {
  addSchema(schema: object): void;
  getSchema(id: string): Validator | undefined;
  compile(schema: object): Validator;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => AjvLike };

const read = (name: string): object => JSON.parse(readFileSync(new URL(`../../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object;

let frames: Validator;
let outline: Validator;
let manifest: Validator;
let project: Validator;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  ajv.addSchema(read('frames'));
  ajv.addSchema(read('outline'));
  const base = 'https://github.com/dawei7/math-canvas-prep/schemas/';
  frames = ajv.getSchema(`${base}frames.schema.json`) as Validator;
  outline = ajv.getSchema(`${base}outline.schema.json`) as Validator;
  manifest = ajv.compile(read('bundle-manifest'));
  project = ajv.compile(read('project'));
});

const rectOf = { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 };
const good = { id: 'e1', kind: 'exercise', page: 0, rect: rectOf };
const region = { page: 1, rect: rectOf };
const framesFile = (...list: unknown[]): unknown => ({ version: 1, frames: list });
const book = { id: 'b1', kind: 'exercise', page: 0, rect: rectOf, authority: 'book', label: '5a', section: '1.1' };
const solutionRegion = { page: 3, rect: rectOf };

describe('authoritative exercises and solutions in frames.schema.json', () => {
  it('accepts an authoritative exercise with context, continuation and solution', () => {
    expect(frames(framesFile(book)), JSON.stringify(frames.errors)).toBe(true);
    expect(frames(framesFile({ ...book, context: [region], continues: [region], solution: [solutionRegion] })), JSON.stringify(frames.errors)).toBe(true);
    expect(frames(framesFile({ ...good, solution: [solutionRegion] })), JSON.stringify(frames.errors)).toBe(true);
  });

  it.each([
    ['an authority without a label', { ...book, label: undefined }],
    ['an authority without a section', { ...book, section: undefined }],
    ['a label without an authority', { ...good, label: '5a' }],
    ['a section without an authority', { ...good, section: '1.1' }],
    ['an authority other than book', { ...book, authority: 'user' }],
    ['an authority together with a unit', { ...book, unit: 'u1' }],
    ['an authority on a question', { ...book, kind: 'question' }],
    ['a solution on a bookmark', { ...good, kind: 'bookmark', solution: [solutionRegion] }],
    ['a label that starts with a space', { ...book, label: ' 5' }],
    ['a label of 25 characters', { ...book, label: 'x'.repeat(25) }],
    ['a label with a star', { ...book, label: '5*' }],
    ['an empty label', { ...book, label: '' }],
    ['a section that is not an id', { ...book, section: 'a b' }],
    ['a section of 61 characters', { ...book, section: 'x'.repeat(61) }],
    ['nine solution regions', { ...good, solution: Array.from({ length: 9 }, () => solutionRegion) }],
    ['a solution region without a page', { ...good, solution: [{ rect: rectOf }] }],
  ])('rejects %s', (_name, bad) => {
    expect(frames(framesFile(bad))).toBe(false);
  });

  it.each(['5', '12', '5a', 'A.3', 'II-4', '5(a)', 'Problem 3', 'x'.repeat(24), 'α1'])('accepts the label %j', (label) => {
    expect(frames(framesFile({ ...book, label })), JSON.stringify(frames.errors)).toBe(true);
  });

  it('agrees with the rules on the shape of the new fields', () => {
    const cases: unknown[] = [
      book,
      { ...book, label: undefined },
      { ...book, unit: 'u1' },
      { ...good, label: '5' },
      { ...book, label: '(a)' },
      { ...book, section: '.x' },
      { ...book, kind: 'question' },
      { ...good, solution: [solutionRegion] },
      { ...good, kind: 'bookmark', solution: [solutionRegion] },
      { ...book, authority: 'x' },
    ];
    for (const entry of cases) {
      const schemaOk = frames(framesFile(entry));
      const rulesOk = parseFrames([entry], { pageCount: 5, strictShapes: true }).issues.every((item) => item.severity !== 'error');
      expect(schemaOk, JSON.stringify(entry)).toBe(rulesOk);
    }
  });
});

describe('sections in outline.schema.json', () => {
  it('accepts entries that are sections and rejects what is not one', () => {
    const sections = [
      { title: 'Chapter 0', page: 5, depth: 0, id: 'c0', label: 'Chapter 0' },
      { title: 'Integers', page: 6, depth: 1, id: '0.1', label: '0.1', top: 0.0998 },
    ];
    expect(outline({ version: 1, entries: sections }), JSON.stringify(outline.errors)).toBe(true);
    for (const extra of [{ id: 'a b' }, { id: '' }, { id: 'x'.repeat(61) }, { label: 'x'.repeat(25) }, { top: -0.1 }, { top: 1.1 }, { top: '0.2' }, { id: 5 }]) {
      expect(outline({ version: 1, entries: [{ title: 'x', page: 0, depth: 0, ...extra }] }), JSON.stringify(extra)).toBe(false);
    }
    expect(outline({ version: 1, entries: [{ title: 'x', page: 0, depth: 0, top: 0 }, { title: 'y', page: 0, depth: 0, top: 1 }] })).toBe(true);
  });
});

describe('document info and features in bundle-manifest.schema.json', () => {
  const base = {
    format: 'math-canvas-bundle',
    version: 1,
    createdAt: '2026-10-04T12:00:00Z',
    generator: { name: 'math-canvas-prep', version: '0.2.0' },
    features: ['sections', 'authority', 'solution'],
    document: {
      title: 'T',
      fileName: 'a.pdf',
      pdf: 'document.pdf',
      sha256: 'a'.repeat(64),
      bytes: 1,
      pageCount: 1,
      author: 'A. Author',
      series: 'S',
      description: 'D',
      license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
      sourceUrl: 'https://example.org/the-book',
      notice: 'N',
    },
    frames: 'frames.json',
    outline: 'outline.json',
  };

  it('accepts the manifest of a book and rejects unusable document info', () => {
    expect(manifest(base), JSON.stringify(manifest.errors)).toBe(true);
    const withDocument = (patch: object): unknown => ({ ...base, document: { ...base.document, ...patch } });
    for (const patch of [
      { author: 'x'.repeat(201) },
      { description: 'x'.repeat(4001) },
      { sourceUrl: 'example.org' },
      { sourceUrl: 'ftp://example.org' },
      { license: { url: 'https://x.org' } },
      { license: { name: '' } },
      { license: { name: 'MIT', url: 'nope' } },
      { notice: 5 },
    ]) {
      expect(manifest(withDocument(patch)), JSON.stringify(patch)).toBe(false);
    }
    expect(manifest({ ...base, features: 'sections' })).toBe(false);
  });

  it('accepts the project file of a book with its document info', () => {
    const made = {
      ...newProject({ pdf: { path: 'book.pdf', sha256: 'ab'.repeat(32), bytes: 10, pageCount: 8 }, title: 'Book' }),
      meta: { title: 'Book', author: 'A. Author', series: 'S', description: 'D', license: { name: 'MIT', url: 'https://x.org/l' }, sourceUrl: 'https://x.org/b', notice: 'N' },
      frames: [{ id: 'f1', kind: 'exercise' as const, page: 0, rect: rectOf, authority: 'book' as const, label: '5a', section: '1.1', solution: [{ page: 7, rect: rectOf }] }],
      outline: { source: 'manual' as const, entries: [{ title: '1.1', page: 0, depth: 0, id: '1.1', label: '1.1', top: 0.1 }] },
    };
    const parsed: unknown = JSON.parse(serializeProject(made));
    expect(project(parsed), JSON.stringify(project.errors)).toBe(true);
    expect(project({ ...(parsed as object), meta: { title: 'T', sourceUrl: 'nowhere' } })).toBe(false);
    expect(project({ ...(parsed as object), meta: { title: 'T', license: { url: 'https://x.org' } } })).toBe(false);
  });
});

describe('what the writer makes for a book is valid against the schemas', () => {
  it('manifest, frames and outline', async () => {
    const sample = buildAuthoritySample();
    const list = sample.exercises.map((entry, index) => ({
      id: `f${index + 1}`,
      kind: 'exercise' as const,
      page: entry.page,
      rect: entry.rect,
      authority: 'book' as const,
      label: entry.label,
      section: entry.section,
      ...(entry.context ? { context: entry.context } : {}),
      ...(entry.continues ? { continues: entry.continues } : {}),
      solution: entry.solution,
    }));
    const written = await buildBundleBytes({
      pdfBytes: sample.pdf,
      title: sample.title,
      pageCount: sample.pageCount,
      frames: list,
      outline: sample.sections,
      info: { author: 'A', license: { name: 'MIT' }, sourceUrl: 'https://x.org/b' },
      createdAt: new Date('2026-10-04T12:00:00Z'),
    });
    expect(manifest(written.manifest), JSON.stringify(manifest.errors)).toBe(true);
    expect(frames({ version: 1, frames: written.frames }), JSON.stringify(frames.errors)).toBe(true);
    expect(outline({ version: 1, entries: written.outline }), JSON.stringify(outline.errors)).toBe(true);
  });
});
