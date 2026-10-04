import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkBundle, type BundleReport } from '../src/bundle/reader.js';
import { buildBundleBytes } from '../src/bundle/writer.js';
import { ZipArchive, bytesSource, entryFromBytes, zipToBytes } from '../src/bundle/zip.js';
import type { Frame, OutlineEntry } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { parseProject, serializeProject } from '../src/project/serialize.js';
import { validateProject } from '../src/project/validate.js';
import type { McPrepError } from '../src/rules/issues.js';
import { buildAuthoritySample, type AuthoritySample } from '../src/testing/authority-sample.js';
import { rejected } from './helpers.js';

const sample: AuthoritySample = buildAuthoritySample();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

/** Every exercise of the sample as an authoritative frame. */
function bookFrames(): Frame[] {
  return sample.exercises.map(
    (entry, index): Frame => ({
      id: `f${index + 1}`,
      kind: 'exercise',
      page: entry.page,
      rect: entry.rect,
      authority: 'book',
      label: entry.label,
      section: entry.section,
      ...(entry.context ? { context: entry.context } : {}),
      ...(entry.continues ? { continues: entry.continues } : {}),
      solution: entry.solution,
    }),
  );
}

const info = {
  author: 'A. Author',
  series: 'Prerequisites',
  description: 'A synthetic workbook.',
  license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  sourceUrl: 'https://example.org/the-book',
  notice: 'Attribution: A. Author. Changes: marked for study.',
};

const input = (): Parameters<typeof buildBundleBytes>[0] => ({
  pdfBytes: sample.pdf,
  title: sample.title,
  pageCount: sample.pageCount,
  frames: bookFrames(),
  outline: sample.sections,
  info,
  createdAt: new Date('2026-10-04T12:00:00Z'),
});

function project(): Project {
  return { ...newProject({ pdf: { path: 'book.pdf', sha256: sha(sample.pdf), bytes: sample.pdf.length, pageCount: sample.pageCount }, title: sample.title, folder: 'Books/Algebra' }), seq: 10, frames: bookFrames(), outline: { source: 'manual', entries: sample.sections }, meta: { title: sample.title, folder: 'Books/Algebra', ...info } };
}

describe('the project file of a book', () => {
  it('keeps authority, label, section, solution, the sections of the outline and the document info through a save and a load', () => {
    const text = serializeProject(project());
    const back = parseProject(JSON.parse(text), 'x');
    expect(back.meta).toEqual(project().meta);
    expect(back.outline).toEqual({ source: 'manual', entries: sample.sections });
    const byId = new Map(back.frames.map((entry) => [entry.id, entry]));
    for (const original of bookFrames()) expect(byId.get(original.id)).toEqual(original);
    expect(serializeProject(back)).toBe(text);
    expect(validateProject(back).errors).toEqual([]);
  });

  it('writes the identity of an exercise first and the document info in a fixed order', () => {
    const text = serializeProject(project());
    const raw = JSON.parse(text) as { meta: Record<string, unknown>; frames: Record<string, unknown>[]; outline: { entries: Record<string, unknown>[] } };
    expect(Object.keys(raw.meta)).toEqual(['title', 'folder', 'author', 'series', 'description', 'license', 'sourceUrl', 'notice']);
    expect(Object.keys(raw.frames[0] as object)).toEqual(['id', 'kind', 'page', 'rect', 'authority', 'label', 'section', 'solution']);
    const withContext = raw.frames.find((entry) => 'context' in entry) as Record<string, unknown>;
    expect(Object.keys(withContext)).toEqual(['id', 'kind', 'page', 'rect', 'authority', 'label', 'section', 'context', 'solution']);
    expect(Object.keys(raw.outline.entries[1] as object)).toEqual(['title', 'page', 'depth', 'id', 'label', 'top']);
    expect(text).toContain('"solution": [');
  });

  it('keeps fields it does not know and ordinary files exactly as before', () => {
    const plain = { ...newProject({ pdf: { path: 'a.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: 3 }, title: 'T' }), frames: [{ id: 'f1', kind: 'exercise' as const, page: 0, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } }] };
    const text = serializeProject(plain);
    expect(text).not.toContain('authority');
    expect(text).not.toContain('solution');
    expect(text).not.toContain('label');
    const raw = JSON.parse(text) as Record<string, unknown>;
    raw['future'] = { x: 1 };
    expect(serializeProject(parseProject(raw, 'T'))).toContain('"future"');
  });

  it('says where a value cannot be read, naming the frame', () => {
    const raw = (JSON.parse(serializeProject(project())) as { frames: Record<string, unknown>[] });
    const broken = (patch: Record<string, unknown>, where: string): void => {
      const copy = JSON.parse(JSON.stringify(raw)) as typeof raw;
      Object.assign(copy.frames[0] as object, patch);
      const base = JSON.parse(serializeProject(project())) as Record<string, unknown>;
      expect(() => parseProject({ ...base, frames: copy.frames }, 'x')).toThrow(where);
    };
    broken({ authority: 5 }, '.authority');
    broken({ label: 5 }, '.label');
    broken({ section: [] }, '.section');
    broken({ solution: 'x' }, '.solution');
  });

  it('refuses a meta that cannot be read', () => {
    const base = JSON.parse(serializeProject(project())) as Record<string, unknown>;
    const withMeta = (meta: unknown): unknown => ({ ...base, meta });
    expect(() => parseProject(withMeta({ title: 'T', author: 5 }), 'x')).toThrow('meta.author');
    expect(() => parseProject(withMeta({ title: 'T', license: 'MIT' }), 'x')).toThrow('meta.license');
    expect(() => parseProject(withMeta({ title: 'T', license: { url: 'https://x.org' } }), 'x')).toThrow('meta.license.name');
    expect(() => parseProject({ ...base, outline: { entries: [{ title: 'A', page: 0, depth: 0, id: 5 }] } }, 'x')).toThrow('outline.entries[0].id');
    expect(() => parseProject({ ...base, outline: { entries: [{ title: 'A', page: 0, depth: 0, top: 'x' }] } }, 'x')).toThrow('outline.entries[0].top');
    expect(parseProject(withMeta({ title: 'T', author: '  ', series: null }), 'x').meta).toEqual({ title: 'T' });
  });

  it('is validated as a whole: duplicates, unknown sections and bad document info are errors that name their cause', () => {
    const frames = bookFrames();
    const dup = { ...project(), frames: [...frames, { ...(frames[0] as Frame), id: 'copy', page: 2, rect: { left: 0.1, top: 0.6, right: 0.9, bottom: 0.65 } }] };
    expect(validateProject(dup).errors.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['duplicate-exercise:copy']);
    const lost = { ...project(), outline: undefined };
    expect(new Set(validateProject(lost).errors.map((entry) => entry.code))).toEqual(new Set(['section-unknown']));
    expect(validateProject(lost).errors).toHaveLength(frames.length);
    const bad = { ...project(), meta: { ...project().meta, sourceUrl: 'nowhere', author: 'x'.repeat(300) } };
    expect(validateProject(bad).errors.map((entry) => entry.code).sort()).toEqual(['info-bad-url', 'info-too-long']);
    const outlineBad = { ...project(), outline: { source: 'manual' as const, entries: [...sample.sections, { title: 'Again', page: 0, depth: 0, id: 'c1' }] } };
    expect(validateProject(outlineBad).errors.map((entry) => entry.code)).toEqual(['outline-duplicate-id']);
    const result = validateProject(project());
    expect(result.ok).toBe(true);
    expect(result.book).toEqual({ exercises: 10, withSolution: 10 });
    expect(result.counts).toEqual({ exercise: 0, question: 0, bookmark: 0 });
    expect(result.numbers).toEqual([]);
  });

  it('counts the warnings of a book: a label copied with its dot, an exercise in the wrong section', () => {
    const frames = bookFrames().map((entry) => (entry.id === 'f1' ? { ...entry, label: '1.' } : entry.id === 'f2' ? { ...entry, section: 'c2' } : entry));
    const result = validateProject({ ...project(), frames });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((entry) => `${entry.code}:${entry.frameId}`).sort()).toEqual(['label-style:f1', 'section-mismatch:f2']);
  });

  it('tells a label copied with its dot from one with stray spaces: the importer drops the dot, and keeps the spaces', () => {
    const frames = bookFrames().map((entry) => (entry.id === 'f1' ? { ...entry, label: '1.' } : entry.id === 'f3' ? { ...entry, label: '3a ' } : entry));
    const result = validateProject({ ...project(), frames });
    expect(result.ok).toBe(true);
    expect(result.repairs).toEqual([]);
    const byFrame = new Map(result.warnings.map((entry) => [entry.frameId, entry]));
    expect([...byFrame.keys()]).toEqual(['f1', 'f3']);
    expect(byFrame.get('f1')?.message).toContain('the importer drops it and keeps "1"');
    expect(byFrame.get('f3')?.message).toContain('spaces');
  });

  it('compares labels the way the importer keeps them: 5 and 5. are one exercise', () => {
    const frames = bookFrames().map((entry) => (entry.id === 'f2' ? { ...entry, label: '1.' } : entry));
    const result = validateProject({ ...project(), frames });
    expect(result.errors.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['duplicate-exercise:f2']);
    expect(result.errors[0]?.message).toContain('exercise "1"');
  });
});

describe('writing the bundle of a book', () => {
  it('writes the features it used, the document info, the sections and the exercises', async () => {
    const written = await buildBundleBytes(input());
    expect(written.manifest.features).toEqual(['sections', 'authority', 'solution']);
    expect(written.manifest.generator).toMatchObject({ name: 'math-canvas-prep', version: '0.2.0' });
    expect(written.manifest.document).toMatchObject({ title: 'Pre-Algebra Workbook', pageCount: 4, ...info });
    expect(Object.keys(written.manifest)).toEqual(['format', 'version', 'createdAt', 'generator', 'features', 'document', 'frames', 'outline']);
    expect(Object.keys(written.manifest.document)).toEqual(['title', 'fileName', 'pdf', 'sha256', 'bytes', 'pageCount', 'author', 'series', 'description', 'license', 'sourceUrl', 'notice']);
    const zip = await ZipArchive.open(bytesSource(written.bytes), { maxEntries: 16, maxArchiveBytes: 1e9 });
    const read = async (name: string): Promise<{ version: number; frames?: Record<string, unknown>[]; entries?: Record<string, unknown>[] }> =>
      JSON.parse(new TextDecoder().decode(await zip.read(zip.find(name)[0] as never, 1e7))) as never;
    const frames = (await read('frames.json')).frames as Record<string, unknown>[];
    expect(frames).toHaveLength(10);
    expect(Object.keys(frames[0] as object)).toEqual(['id', 'kind', 'page', 'rect', 'authority', 'label', 'section', 'solution']);
    expect(frames.find((entry) => entry['label'] === '4')).toMatchObject({ section: '1.2', continues: [{ page: 2 }], solution: [{ page: 3 }] });
    expect(frames.map((entry) => entry['label'])).toEqual(['1', '2', '3a', '3b', '1', '2', '3', '4', '1', '2']);
    const entries = (await read('outline.json')).entries as Record<string, unknown>[];
    expect(entries[1]).toEqual({ title: '1.1 Adding integers', page: 0, depth: 1, id: '1.1', label: '1.1', top: sample.sections[1]?.top });
    expect(written.issues.filter((entry) => entry.severity === 'warning')).toEqual([]);
  });

  it('is accepted by the importer check, which finds everything again', async () => {
    const { bytes } = await buildBundleBytes(input());
    const report = await checkBundle(bytes);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.repairs).toEqual([]);
    expect(report.features).toEqual(['sections', 'authority', 'solution']);
    expect(report.document).toMatchObject({ title: 'Pre-Algebra Workbook', author: 'A. Author', series: 'Prerequisites', license: info.license, sourceUrl: info.sourceUrl, notice: info.notice });
    expect(report.frames).toHaveLength(10);
    expect(report.outline?.map((entry) => entry.id)).toEqual(['c1', '1.1', '1.2', 'c2', '2.1', 'answers']);
    expect(report.numbers).toEqual([]);
    const step = report.steps[5];
    expect(step?.detail).toContain('0 exercises, 0 questions and 0 bookmarks');
    expect(step?.detail).toContain('10 authoritative exercises in 3 sections (10 with a hidden solution)');
    expect(step?.detail).toContain('skipped');
    const frames = new Map((report.frames ?? []).map((entry) => [entry.id, entry]));
    for (const original of bookFrames()) expect(frames.get(original.id)).toEqual(original);
  });

  it('leaves the features and document info out when nothing uses them: a file as before', async () => {
    const plain = await buildBundleBytes({ pdfBytes: sample.pdf, title: 'T', pageCount: 4, frames: [{ id: 'f1', kind: 'exercise', page: 0, rect: sample.exercises[0]?.rect as never }], outline: sample.pdfOutline, createdAt: new Date('2026-10-04T12:00:00Z') });
    expect(plain.manifest).not.toHaveProperty('features');
    expect(Object.keys(plain.manifest.document)).toEqual(['title', 'fileName', 'pdf', 'sha256', 'bytes', 'pageCount']);
    const sectionsOnly = await buildBundleBytes({ pdfBytes: sample.pdf, title: 'T', pageCount: 4, frames: [], outline: sample.sections });
    expect(sectionsOnly.manifest.features).toEqual(['sections']);
    const solutionOnly = await buildBundleBytes({ pdfBytes: sample.pdf, title: 'T', pageCount: 4, frames: [{ id: 'f1', kind: 'exercise', page: 0, rect: sample.exercises[0]?.rect as never, solution: sample.exercises[0]?.solution as never }] });
    expect(solutionOnly.manifest.features).toEqual(['solution']);
  });

  it('is deterministic, byte for byte', async () => {
    expect((await buildBundleBytes(input())).bytes).toEqual((await buildBundleBytes(input())).bytes);
  });

  it('refuses what the importer would reject, naming each cause', async () => {
    const frames = bookFrames();
    const failure = async (overrides: Partial<Parameters<typeof buildBundleBytes>[0]>): Promise<McPrepError> => rejected(buildBundleBytes({ ...input(), ...overrides }));
    const unknownSection = await failure({ frames: frames.map((entry) => (entry.id === 'f1' ? { ...entry, section: 'nowhere' } : entry)) });
    expect(unknownSection.code).toBe('E_BUNDLE_INVALID');
    expect(unknownSection.issues.map((entry) => entry.code)).toEqual(['section-unknown']);
    expect(unknownSection.issues[0]?.frameId).toBe('f1');
    const noOutline = (await failure({ outline: undefined })).issues;
    expect(noOutline).toHaveLength(10);
    expect(noOutline.every((entry) => entry.code === 'section-unknown')).toBe(true);
    expect((await failure({ frames: [...frames, { ...(frames[0] as Frame), id: 'copy', page: 2, rect: { left: 0.1, top: 0.6, right: 0.9, bottom: 0.65 } }] })).issues.map((entry) => entry.code)).toEqual(['duplicate-exercise']);
    expect((await failure({ frames: frames.map((entry) => (entry.id === 'f1' ? { ...entry, unit: 'u1' } : entry)) })).issues.map((entry) => entry.code)).toContain('authority-unit');
    expect((await failure({ frames: frames.map((entry) => (entry.id === 'f1' ? { ...entry, label: undefined } : entry)) })).issues.map((entry) => entry.code)).toEqual(['label-missing']);
    expect((await failure({ frames: frames.map((entry) => (entry.id === 'f1' ? { ...entry, solution: [{ page: 9, rect: entry.rect }] } : entry)) })).issues.map((entry) => entry.code)).toEqual(['page-out-of-range']);
    expect((await failure({ outline: [...sample.sections, { title: 'Dup', page: 0, depth: 0, id: 'c1' }] })).issues.map((entry) => entry.code)).toEqual(['outline-duplicate-id']);
    expect((await failure({ info: { ...info, sourceUrl: 'example.org' } })).issues.map((entry) => entry.code)).toEqual(['info-bad-url']);
    expect((await failure({ info: { ...info, author: 'x'.repeat(201) } })).issues[0]).toMatchObject({ code: 'info-too-long' });
  });

  it('carries the warnings about a book into the result', async () => {
    const frames = bookFrames().map((entry) => (entry.id === 'f1' ? { ...entry, label: '1)' } : entry));
    const written = await buildBundleBytes({ ...input(), frames });
    expect(written.issues.filter((entry) => entry.severity === 'warning').map((entry) => entry.code)).toEqual(['label-style']);
  });

  it('writes a label as the importer keeps it, so the bundle says the same on its own', async () => {
    const frames = bookFrames().map((entry) => (entry.id === 'f1' ? { ...entry, label: '1)' } : entry.id === 'f3' ? { ...entry, label: '3a ' } : entry));
    const written = await buildBundleBytes({ ...input(), frames });
    expect(written.issues.filter((entry) => entry.severity === 'warning').map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['label-style:f1', 'label-style:f3']);
    expect(written.frames.map((entry) => entry.label).slice(0, 3)).toEqual(['1', '2', '3a ']);
    // Read back, the bundle has nothing left to say about the dot (spaces are for the tools to warn about, not the importer).
    const report = await checkBundle(written.bytes);
    expect(report.errors).toEqual([]);
    expect(report.repairs).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('writes ordinary exercises and authoritative ones side by side', async () => {
    const mixed: Frame[] = [...bookFrames(), { id: 'mine', kind: 'exercise', page: 2, rect: { left: 0.1, top: 0.6, right: 0.9, bottom: 0.7 } }, { id: 'q', kind: 'question', page: 2, rect: { left: 0.1, top: 0.75, right: 0.9, bottom: 0.8 } }];
    const { bytes } = await buildBundleBytes({ ...input(), frames: mixed });
    const report = await checkBundle(bytes);
    expect(report.ok).toBe(true);
    expect(report.numbers?.map((entry) => `${entry.id}:${entry.label}`)).toEqual(['mine:E1', 'q:Q1']);
    expect(report.steps[5]?.detail).toContain('1 exercise, 1 question and 0 bookmarks, 10 authoritative exercises');
  });
});

describe('reading a bundle of a book', () => {
  function manifest(overrides: Record<string, unknown> = {}, documentOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'math-canvas-bundle',
      version: 1,
      createdAt: '2026-10-04T12:00:00Z',
      generator: { name: 'test', version: '0' },
      document: { title: 'Book', fileName: 'book.pdf', pdf: 'document.pdf', sha256: sha(sample.pdf), bytes: sample.pdf.length, pageCount: 4, ...documentOverrides },
      frames: 'frames.json',
      outline: 'outline.json',
      ...overrides,
    };
  }
  const good = (id: string, section: string, label: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 }, authority: 'book', label, section, ...extra });
  const outline = { version: 1, entries: [{ title: 'Chapter 1', page: 0, depth: 0, id: 'c1' }, { title: '1.1 Sets', page: 0, depth: 1, id: '1.1', label: '1.1', top: 0.2 }] };

  async function check(parts: { manifest?: unknown; frames?: unknown[]; outline?: unknown; omitOutline?: boolean }): Promise<BundleReport> {
    const entries: [string, Uint8Array][] = [
      ['bundle.json', encode(parts.manifest ?? manifest())],
      ['document.pdf', sample.pdf],
      ['frames.json', encode({ version: 1, frames: parts.frames ?? [good('f1', '1.1', '5a')] })],
    ];
    if (parts.omitOutline !== true) entries.push(['outline.json', encode(parts.outline ?? outline)]);
    return checkBundle(await zipToBytes(entries.map(([name, bytes]) => entryFromBytes(name, bytes))));
  }
  const codes = (report: BundleReport): string[] => report.errors.map((entry) => entry.code);

  it('accepts exercises that name sections of its outline', async () => {
    const report = await check({ frames: [good('f1', '1.1', '5a'), good('f2', '1.1', '5b'), good('f3', 'c1', '5a')] });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.frames?.map((entry) => `${entry.section}:${entry.label}`)).toEqual(['1.1:5a', '1.1:5b', 'c1:5a']);
  });

  it.each([
    ['a section that is not in the outline', [good('f1', 'zz', '5a')], ['section-unknown']],
    ['the same exercise twice', [good('f1', '1.1', '5a'), good('f2', '1.1', '5a')], ['duplicate-exercise']],
    ['an authority on a question', [good('f1', '1.1', '5a', { kind: 'question' })], ['authority-not-exercise']],
    ['an authority together with a unit', [good('f1', '1.1', '5a', { unit: 'u1' })], ['authority-unit']],
    ['an authority without a label', [good('f1', '1.1', '5a', { label: undefined })], ['label-missing']],
    ['an authority without a section', [good('f1', '1.1', '5a', { section: undefined })], ['section-missing']],
    ['a label that is not allowed', [good('f1', '1.1', '(a)')], ['bad-label']],
    ['a label that is too long', [good('f1', '1.1', 'x'.repeat(25))], ['bad-label']],
    ['a label without authority', [good('f1', '1.1', '5a', { authority: undefined, section: undefined })], ['label-without-authority']],
    ['a solution on a bookmark', [{ id: 'b', kind: 'bookmark', page: 0, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 }, solution: [{ page: 1, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 } }] }], ['solution-not-exercise']],
    ['a solution on a page that does not exist', [good('f1', '1.1', '5a', { solution: [{ page: 4, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 } }] })], ['page-out-of-range']],
    ['nine solution regions', [good('f1', '1.1', '5a', { solution: Array.from({ length: 9 }, () => ({ page: 1, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 } })) })], ['too-many-regions']],
  ])('rejects %s', async (_name, frames, expected) => {
    const report = await check({ frames });
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(expected);
    expect(report.rejection?.frameId).toBeDefined();
  });

  it('rejects exercises of sections when there is no outline at all', async () => {
    const report = await check({ omitOutline: true, manifest: manifest({ outline: undefined }) });
    expect(codes(report)).toEqual(['section-unknown']);
    expect(report.errors[0]?.frameId).toBe('f1');
  });

  it('drops one closing "." or ")" that closes nothing from a label before it checks the label, and keeps the label so', async () => {
    const report = await check({ frames: [good('f1', '1.1', '5.'), good('f2', '1.1', '6)'), good('f3', '1.1', '7 (a)'), good('f4', '1.1', 'A.3'), good('f5', '1.1', '8..'), good('f6', '1.1', '9 .')] });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.frames?.map((entry) => entry.label)).toEqual(['5', '6', '7 (a)', 'A.3', '8.', '9']);
    // The bundle is accepted, and the tool says once per label what the importer does with it.
    expect(report.warnings.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['label-style:f1', 'label-style:f2', 'label-style:f5', 'label-style:f6']);
    expect(report.warnings[0]?.message).toContain('"5."');
    expect(report.warnings[0]?.message).toContain('the importer drops it and keeps "5"');
    expect(report.warnings[1]?.message).toContain('"6)"');
    expect(report.warnings[2]?.message).toContain('keeps "8."');
    expect(report.repairs).toEqual([]);
  });

  it('compares the labels as the importer keeps them: 5 and 5. are one exercise, in one section', async () => {
    const report = await check({ frames: [good('f1', '1.1', '5'), good('f2', '1.1', '5.'), good('f3', 'c1', '5.'), good('f4', '1.1', '5)')] });
    expect(codes(report)).toEqual(['duplicate-exercise', 'duplicate-exercise']);
    expect(report.errors.map((entry) => entry.frameId)).toEqual(['f2', 'f4']);
    expect(report.errors[0]?.message).toContain('exercise "5" of section "1.1"');
  });

  it('judges the length and the characters of a label after the drop, and changes nothing else in it', async () => {
    const fine = await check({ frames: [good('f1', '1.1', `${'1'.repeat(24)}.`), good('f2', '1.1', '6. '), good('f3', '1.1', '7  a'), good('f4', '1.1', '8.)')] });
    expect(fine.errors).toEqual([]);
    // One character is dropped, not every closing one: "8.)" is "8." (a label may hold dots).
    expect(fine.frames?.map((entry) => entry.label)).toEqual(['1'.repeat(24), '6. ', '7  a', '8.']);
    for (const label of [`${'1'.repeat(25)}.`, '1'.repeat(25), ' 5.', '.', ')', '(a)', '..', '5*.']) {
      const report = await check({ frames: [good('f1', '1.1', label)] });
      expect(codes(report), JSON.stringify(label)).toEqual(['bad-label']);
      // The label is named as it was written.
      expect(report.rejection?.message, JSON.stringify(label)).toContain(JSON.stringify(label));
    }
  });

  it('rejects a bad outline and judges the sections only when the outline could be read', async () => {
    for (const [entries, expected] of [
      [[{ title: 'A', page: 0, depth: 0, id: 'x' }, { title: 'B', page: 1, depth: 0, id: 'x' }], 'outline-duplicate-id'],
      [[{ title: 'A', page: 0, depth: 0, id: 'a b' }], 'outline-bad-id'],
      [[{ title: 'A', page: 0, depth: 0, id: 'a', label: 'x'.repeat(25) }], 'outline-bad-label'],
      [[{ title: 'A', page: 0, depth: 0, id: 'a', top: 1.5 }], 'outline-bad-top'],
    ] as [unknown[], string][]) {
      const report = await check({ outline: { version: 1, entries }, frames: [] });
      expect(codes(report)).toEqual([expected]);
    }
    const broken = await check({ outline: '{not json', frames: [good('f1', '1.1', '5a')] });
    expect(codes(broken)).toEqual(['outline-json']);
  });

  it('reads the document info leniently: texts are cut, what cannot be used is ignored, nothing is rejected', async () => {
    const report = await check({
      manifest: manifest({ features: ['sections', 'future', 5] }, { author: 'x'.repeat(250), series: 5, sourceUrl: 'javascript:alert(1)', license: { name: 'MIT', url: 'nope' }, notice: 'n' }),
    });
    expect(report.ok).toBe(true);
    expect(report.document?.author).toHaveLength(200);
    expect(report.document?.license).toEqual({ name: 'MIT' });
    expect(report.document).not.toHaveProperty('sourceUrl');
    expect(report.document).not.toHaveProperty('series');
    expect(report.document?.notice).toBe('n');
    expect(report.repairs.map((entry) => entry.code)).toEqual(['info-cut']);
    expect(report.warnings.map((entry) => entry.code).sort()).toEqual(['info-ignored', 'info-ignored', 'info-ignored', 'manifest-features']);
  });

  it('reads the features as information: unknown ones are noted, a bundle without them is fine', async () => {
    const listed = await check({ manifest: manifest({ features: ['sections', 'authority', 'telepathy'] }) });
    expect(listed.ok).toBe(true);
    expect(listed.features).toEqual(['sections', 'authority', 'telepathy']);
    expect(listed.warnings.map((entry) => entry.code)).toEqual(['manifest-features-unknown']);
    const none = await check({});
    expect(none.features).toBeUndefined();
    expect(none.warnings).toEqual([]);
  });

  it('may be handed the frames of ordinary exercises with a solution', async () => {
    const report = await check({ frames: [{ id: 'e1', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 }, solution: [{ page: 3, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 } }] }] });
    expect(report.errors).toEqual([]);
    expect(report.numbers?.map((entry) => entry.label)).toEqual(['E1']);
  });
});

describe('what an older reader would make of it, as the format promises', () => {
  it('reads the bundle of a book as ordinary exercises when it ignores the new fields', async () => {
    const { bytes } = await buildBundleBytes(input());
    const zip = await ZipArchive.open(bytesSource(bytes), { maxEntries: 16, maxArchiveBytes: 1e9 });
    const frames = (JSON.parse(new TextDecoder().decode(await zip.read(zip.find('frames.json')[0] as never, 1e7))) as { frames: Record<string, unknown>[] }).frames;
    const old = frames.map(({ authority: _authority, label: _label, section: _section, solution: _solution, ...rest }) => rest);
    expect(old).toHaveLength(10);
    const entries: OutlineEntry[] = sample.sections.map(({ title, page, depth }) => ({ title, page, depth }));
    const rebuilt = await zipToBytes([
      entryFromBytes('bundle.json', encode({ format: 'math-canvas-bundle', version: 1, createdAt: '2026-10-04T12:00:00Z', generator: { name: 'old', version: '0' }, document: { title: 'T', fileName: 'a.pdf', pdf: 'document.pdf', sha256: sha(sample.pdf), bytes: sample.pdf.length, pageCount: 4 }, frames: 'frames.json', outline: 'outline.json' })),
      entryFromBytes('document.pdf', sample.pdf),
      entryFromBytes('frames.json', encode({ version: 1, frames: old })),
      entryFromBytes('outline.json', encode({ version: 1, entries })),
    ]);
    const report = await checkBundle(rebuilt);
    expect(report.errors).toEqual([]);
    expect(report.numbers).toHaveLength(10);
  });
});
