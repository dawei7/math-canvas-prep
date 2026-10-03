import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBundleBytes } from '../src/bundle/writer.js';
import { parseFrames } from '../src/rules/frames.js';
import { newProject } from '../src/project/model.js';
import { serializeProject } from '../src/project/serialize.js';
import { buildSampleSheet } from '../src/testing/sample.js';
import { frame, rect } from './helpers.js';

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

describe('frames.schema.json', () => {
  it('accepts the example of the format document', () => {
    const example = {
      version: 1,
      frames: [
        { id: 'e1', kind: 'exercise', page: 2, rect: { left: 0.08, top: 0.12, right: 0.92, bottom: 0.31 } },
        { id: 'e2a', kind: 'exercise', page: 2, rect: { left: 0.08, top: 0.35, right: 0.92, bottom: 0.5 }, unit: 'u2', context: [{ page: 2, rect: { left: 0.08, top: 0.32, right: 0.92, bottom: 0.35 } }] },
        { id: 'e2b', kind: 'exercise', page: 2, rect: { left: 0.08, top: 0.5, right: 0.92, bottom: 0.66 }, unit: 'u2' },
        { id: 'q1', kind: 'question', page: 3, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.27 }, continues: [{ page: 4, rect: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.14 } }] },
      ],
    };
    expect(frames(example), JSON.stringify(frames.errors)).toBe(true);
  });

  it.each([
    ['a bad id', { ...good, id: 'bad id' }],
    ['an id that is too long', { ...good, id: 'a'.repeat(41) }],
    ['an unknown kind', { ...good, kind: 'note' }],
    ['a negative page', { ...good, page: -1 }],
    ['a fractional page', { ...good, page: 0.5 }],
    ['a value above 1', { ...good, rect: { ...rectOf, right: 1.2 } }],
    ['a missing edge', { ...good, rect: { left: 0.1, top: 0.2, right: 0.9 } }],
    ['an array rect', { ...good, rect: [0.1, 0.2, 0.9, 0.3] }],
    ['an unknown field (a typo)', { ...good, cotext: [] }],
    ['nine continuation regions', { ...good, continues: Array.from({ length: 9 }, () => region) }],
    ['nine context regions', { ...good, context: Array.from({ length: 9 }, () => region) }],
    ['a unit on a question', { ...good, kind: 'question', unit: 'u1' }],
    ['context on a bookmark', { ...good, kind: 'bookmark', context: [region] }],
    ['a unit together with continues', { ...good, unit: 'u1', continues: [region] }],
    ['a region without a page', { ...good, context: [{ rect: rectOf }] }],
  ])('rejects %s', (_name, bad) => {
    expect(frames(framesFile(bad))).toBe(false);
  });

  it('requires version 1 and a list', () => {
    expect(frames({ version: 2, frames: [] })).toBe(false);
    expect(frames({ frames: [] })).toBe(false);
    expect(frames({ version: 1 })).toBe(false);
    expect(frames({ version: 1, frames: {} })).toBe(false);
    expect(frames({ version: 1, frames: [] })).toBe(true);
  });

  it('agrees with the rules on the shape of a frame', () => {
    const cases: unknown[] = [good, { ...good, page: 'x' }, { ...good, kind: 'x' }, { ...good, rect: { ...rectOf, left: 'x' } }, { ...good, id: 5 }];
    for (const entry of cases) {
      const schemaOk = frames(framesFile(entry));
      const rulesOk = parseFrames([entry], { pageCount: 5, strictShapes: true }).issues.every((item) => item.severity !== 'error');
      expect(schemaOk).toBe(rulesOk);
    }
  });
});

describe('outline.schema.json', () => {
  it('accepts the outline of the sample and rejects a bad entry', () => {
    expect(outline({ version: 1, entries: buildSampleSheet().outline })).toBe(true);
    expect(outline({ version: 1, entries: [{ title: '', page: 0, depth: 0 }] })).toBe(false);
    expect(outline({ version: 1, entries: [{ title: 'x', page: 0, depth: 9 }] })).toBe(false);
    expect(outline({ version: 1, entries: [{ title: 'x', page: -1, depth: 0 }] })).toBe(false);
    expect(outline({ version: 1, entries: [{ title: 'x'.repeat(201), page: 0, depth: 0 }] })).toBe(false);
    expect(outline({ version: 2, entries: [] })).toBe(false);
  });
});

describe('what the tools write is valid against the schemas', () => {
  const sample = buildSampleSheet();
  const list = [
    frame('e1', 'exercise', 0, rect(0.1, 0.2, 0.9, 0.3)),
    frame('p1', 'exercise', 0, rect(0.1, 0.4, 0.9, 0.5), { unit: 'u1', context: [{ page: 0, rect: rect(0.1, 0.35, 0.9, 0.4) }] }),
    frame('p2', 'exercise', 0, rect(0.1, 0.5, 0.9, 0.6), { unit: 'u1' }),
    frame('q1', 'question', 1, rect(0.1, 0.2, 0.9, 0.3), { continues: [{ page: 2, rect: rect(0.1, 0.1, 0.9, 0.2) }] }),
  ];

  it('the manifest, frames.json and outline.json of a bundle', async () => {
    const written = await buildBundleBytes({ pdfBytes: sample.pdf, title: 'Sheet', folder: 'A/B', pageCount: 3, frames: list, outline: sample.outline, createdAt: new Date('2026-10-03T12:00:00Z') });
    expect(manifest(written.manifest), JSON.stringify(manifest.errors)).toBe(true);
    expect(frames({ version: 1, frames: written.frames }), JSON.stringify(frames.errors)).toBe(true);
    expect(outline({ version: 1, entries: written.outline }), JSON.stringify(outline.errors)).toBe(true);
    expect(written.manifest.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('a project file', () => {
    const made = { ...newProject({ pdf: { path: 'sheet.pdf', sha256: 'ab'.repeat(32), bytes: 10, pageCount: 3 }, title: 'Sheet', folder: 'A/B' }), frames: list, outline: { source: 'derived' as const, entries: sample.outline } };
    const parsed: unknown = JSON.parse(serializeProject(made));
    expect(project(parsed), JSON.stringify(project.errors)).toBe(true);
    expect(project({ ...(parsed as object), pdf: undefined })).toBe(false);
    expect(project({ ...(parsed as object), format: 'x' })).toBe(false);
  });

  it('rejects a manifest of another version or with a bad hash', () => {
    const base = { format: 'math-canvas-bundle', version: 1, createdAt: '2026-10-03T12:00:00Z', generator: { name: 'x', version: '1' }, document: { title: 'T', fileName: 'a.pdf', pdf: 'document.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: 1 }, frames: 'frames.json' };
    expect(manifest(base)).toBe(true);
    expect(manifest({ ...base, version: 2 })).toBe(false);
    expect(manifest({ ...base, document: { ...base.document, sha256: 'A'.repeat(64) } })).toBe(false);
    expect(manifest({ ...base, document: { ...base.document, pageCount: 0 } })).toBe(false);
    expect(manifest({ ...base, document: { ...base.document, title: '' } })).toBe(false);
  });
});
