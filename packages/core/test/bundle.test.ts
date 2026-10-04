import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBundle, type BundleReport } from '../src/bundle/reader.js';
import { buildBundleBytes, canonicalizeFrames, writeBundle } from '../src/bundle/writer.js';
import { ZipArchive, bytesSource, entryFromBytes, zipToBytes } from '../src/bundle/zip.js';
import type { Frame } from '../src/model/types.js';
import { buildPdf } from '../src/testing/pdf-writer.js';
import { buildSampleSheet } from '../src/testing/sample.js';
import { VERSION } from '../src/version.js';
import { frame, rect, rejected, tempDir } from './helpers.js';

const sample = buildSampleSheet();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The bytes of a JSON entry: text as it is, anything else as JSON, and bytes as they are (to write what is not UTF-8). */
const json = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));

const goodFrames = { version: 1, frames: [{ id: 'e1', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } }] };

function manifest(pdf: Uint8Array = sample.pdf, overrides: Record<string, unknown> = {}, documentOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'math-canvas-bundle',
    version: 1,
    createdAt: '2026-10-03T17:00:00Z',
    generator: { name: 'test', version: '0' },
    document: { title: 'Test', fileName: 'sheet.pdf', pdf: 'document.pdf', sha256: sha(pdf), bytes: pdf.length, pageCount: 3, ...documentOverrides },
    frames: 'frames.json',
    ...overrides,
  };
}

interface Parts {
  manifest?: unknown;
  pdf?: Uint8Array;
  frames?: unknown;
  outline?: unknown;
  extra?: [string, Uint8Array][];
  omit?: string[];
  deflate?: boolean;
}

/** Builds an archive with exactly these entries (every part can be replaced, left out or damaged). */
async function bundle(parts: Parts = {}): Promise<Uint8Array> {
  const pdf = parts.pdf ?? sample.pdf;
  const entries: [string, Uint8Array][] = [
    ['bundle.json', json(parts.manifest ?? manifest(pdf))],
    ['document.pdf', pdf],
    ['frames.json', json(parts.frames ?? goodFrames)],
  ];
  if (parts.outline !== undefined) entries.push(['outline.json', json(parts.outline)]);
  entries.push(...(parts.extra ?? []));
  const kept = entries.filter(([name]) => !(parts.omit ?? []).includes(name));
  return zipToBytes(kept.map(([name, bytes]) => entryFromBytes(name, bytes, { deflate: parts.deflate === true })));
}

async function check(parts: Parts): Promise<BundleReport> {
  return checkBundle(await bundle(parts));
}

const codes = (report: BundleReport): string[] => report.errors.map((entry) => entry.code);

describe('a valid bundle', () => {
  it('is accepted, step by step, and says what it would import', async () => {
    const report = await check({ outline: { version: 1, entries: [{ title: '1 Sets', page: 0, depth: 0 }] }, manifest: manifest(sample.pdf, { outline: 'outline.json' }, { folder: 'Uni/Analysis' }) });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['1:ok', '2:ok', '3:ok', '4:ok', '5:ok', '6:ok']);
    expect(report.document).toMatchObject({ title: 'Test', folder: 'Uni/Analysis', pageCount: 3, sha256: sha(sample.pdf) });
    expect(report.numbers?.map((entry) => entry.label)).toEqual(['E1']);
    expect(report.outline).toHaveLength(1);
    expect(report.steps[5]?.detail).toContain('1 exercise, 0 questions and 0 bookmarks');
  });

  it('reads deflated entries too', async () => {
    expect((await check({ deflate: true })).ok).toBe(true);
  });

  it('may hold an empty list of frames', async () => {
    const report = await check({ frames: { version: 1, frames: [] } });
    expect(report.ok).toBe(true);
    expect(report.frames).toEqual([]);
  });

  it('ignores unknown fields in version 1 files', async () => {
    const report = await check({ manifest: manifest(sample.pdf, { future: { x: 1 } }, { extra: true }), frames: { version: 1, frames: goodFrames.frames, notes: 'x' } });
    expect(report.ok).toBe(true);
  });
});

describe('step 1: the archive', () => {
  it('ignores every entry that is not one of the four, never extracting it', async () => {
    const report = await check({
      extra: [
        ['../../evil.txt', json('x')],
        ['sub/dir/', new Uint8Array(0)],
        ['C:\\windows\\system32\\x.dll', json('x')],
        ['notes.txt', json('x')],
        ['BUNDLE.JSON', json('{}')],
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.filter((entry) => entry.code === 'entry-ignored')).toHaveLength(5);
    expect(report.archive?.entries.filter((entry) => entry.role === 'ignored')).toHaveLength(5);
  });

  it('needs bundle.json, document.pdf and frames.json by their exact names', async () => {
    for (const name of ['bundle.json', 'document.pdf', 'frames.json']) {
      const report = await check({ omit: [name] });
      expect(report.ok).toBe(false);
      expect(report.rejection).toMatchObject({ code: 'entry-missing' });
      expect(report.rejection?.message).toContain(name);
    }
    const wrongCase = await bundle({ omit: ['frames.json'], extra: [['Frames.json', json(goodFrames)]] });
    expect(codes(await checkBundle(wrongCase))).toEqual(['entry-missing']);
    const outlineOnlyIfPresent = await check({});
    expect(outlineOnlyIfPresent.ok).toBe(true);
  });

  it('rejects two entries with the same name', async () => {
    const report = await check({ extra: [['frames.json', json({ version: 1, frames: [] })]] });
    expect(report.rejection?.code).toBe('zip-duplicate-entry');
  });

  it('rejects more than 16 entries', async () => {
    const extra = Array.from({ length: 13 }, (_unused, i): [string, Uint8Array] => [`extra${i}.txt`, json('x')]);
    expect((await check({ extra })).ok).toBe(true);
    const report = await check({ extra: [...extra, ['one-more.txt', json('x')]] });
    expect(report.rejection?.code).toBe('zip-limits');
  });

  it('rejects a JSON entry above 16 MiB', async () => {
    const padded = `${JSON.stringify(goodFrames)}${' '.repeat(16 * 1024 * 1024 + 10)}`;
    const report = await check({ frames: padded });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('zip-limits');
  });

  it('rejects a PDF entry that declares more than 512 MiB', async () => {
    const pdf = sample.pdf;
    const bytes = await bundle({});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Declare an uncompressed size of 600 MiB for document.pdf in its central directory record.
    let at = view.getUint32(bytes.length - 22 + 16, true);
    for (let i = 0; i < 3; i += 1) {
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + view.getUint16(at + 28, true)));
      if (name === 'document.pdf') {
        view.setUint32(at + 24, 600 * 1024 * 1024, true);
        view.setUint32(at + 20, 600 * 1024 * 1024, true);
      }
      at += 46 + view.getUint16(at + 28, true);
    }
    const report = await checkBundle(bytes);
    expect(report.ok).toBe(false);
    expect(pdf.length).toBeLessThan(10000);
  });

  it('rejects an archive larger than 600 MiB', async () => {
    await expect(ZipArchive.open({ size: 601 * 1024 * 1024, read: () => Promise.reject(new Error('no')), close: () => Promise.resolve() }, { maxEntries: 16, maxArchiveBytes: 600 * 1024 * 1024 })).rejects.toMatchObject({ code: 'zip-too-large' });
  });

  it('rejects a stored entry that has its size after its data, which the app cannot read as a stream', async () => {
    // Flag bit 3 in the central directory of every entry, as a writer that streams makes it; the sizes stay where they are.
    const withDescriptors = (bytes: Uint8Array, only?: string): Uint8Array => {
      const copy = new Uint8Array(bytes);
      const view = new DataView(copy.buffer);
      let at = view.getUint32(copy.length - 22 + 16, true);
      const total = view.getUint16(copy.length - 22 + 10, true);
      for (let i = 0; i < total; i += 1) {
        const nameLength = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(copy.subarray(at + 46, at + 46 + nameLength));
        if (only === undefined || name === only) view.setUint16(at + 8, view.getUint16(at + 8, true) | 0x8, true);
        at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      }
      return copy;
    };
    const all = await checkBundle(withDescriptors(await bundle({})));
    expect(all.ok).toBe(false);
    expect(all.rejection).toMatchObject({ code: 'zip-stored-descriptor' });
    expect(all.rejection?.message).toContain('"bundle.json", "document.pdf", "frames.json"');
    expect(all.rejection?.fix).toContain('Deflate');
    expect(all.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['1:failed']);
    // One entry is enough, and so is one the app would only read past.
    const one = await checkBundle(withDescriptors(await bundle({ extra: [['notes.txt', json('x')]] }), 'notes.txt'));
    expect(codes(one)).toEqual(['zip-stored-descriptor']);
    expect(one.rejection?.message).toContain('The entry "notes.txt" is stored');
    // A deflated entry can be inflated without knowing its size first, so the flag alone is not a reason.
    expect(codes(await checkBundle(withDescriptors(await bundle({ deflate: true })))), 'deflated').not.toContain('zip-stored-descriptor');
  });

  it('rejects files that are not archives', async () => {
    const report = await checkBundle(new TextEncoder().encode('not a zip'));
    expect(report.ok).toBe(false);
    expect(report.rejection?.code).toBe('zip-invalid');
    expect(report.steps).toHaveLength(1);
  });
});

describe('step 2: the manifest', () => {
  it('rejects text that is not JSON and the wrong format', async () => {
    expect(codes(await check({ manifest: '{not json' }))).toContain('manifest-json');
    expect(codes(await check({ manifest: [] }))).toContain('manifest-json');
    expect(codes(await check({ manifest: manifest(sample.pdf, { format: 'something-else' }) }))).toContain('manifest-format');
  });

  it('rejects version 2 with a message that says the bundle needs a newer app', async () => {
    const report = await check({ manifest: manifest(sample.pdf, { version: 2 }) });
    expect(report.ok).toBe(false);
    const newer = report.errors.find((entry) => entry.code === 'bundle-newer');
    expect(newer?.message).toContain('needs a newer app');
    expect(newer?.message).toContain('2');
  });

  it('rejects versions that are not whole numbers from 1', async () => {
    for (const version of ['1', 0, -1, 1.5, null]) {
      expect(codes(await check({ manifest: manifest(sample.pdf, { version }) }))).toContain('manifest-version');
    }
  });

  it('checks the document block: title, hash, size and page count', async () => {
    expect(codes(await check({ manifest: manifest(sample.pdf, {}, { title: '   ' }) }))).toContain('manifest-title');
    expect(codes(await check({ manifest: manifest(sample.pdf, {}, { title: 'x'.repeat(201) }) }))).toContain('manifest-title');
    expect((await check({ manifest: manifest(sample.pdf, {}, { title: ` ${'x'.repeat(200)} ` }) })).ok).toBe(true);
    expect(codes(await check({ manifest: manifest(sample.pdf, {}, { sha256: 'abc' }) }))).toContain('manifest-sha256');
    expect(codes(await check({ manifest: manifest(sample.pdf, {}, { bytes: -1 }) }))).toContain('manifest-bytes');
    expect(codes(await check({ manifest: manifest(sample.pdf, {}, { pageCount: 0 }) }))).toContain('manifest-page-count');
    expect(codes(await check({ manifest: manifest(sample.pdf, { document: 5 }) }))).toContain('manifest-document');
  });

  it('cleans the folder: control characters, empty names, long names, more than seven levels', async () => {
    const long = 'x'.repeat(70);
    const report = await check({ manifest: manifest(sample.pdf, {}, { folder: ` A\u0007B / /${long}/C/D/E/F/G/H/I ` }) });
    expect(report.ok).toBe(true);
    expect(report.document?.folder).toBe(`AB/${'x'.repeat(60)}/C/D/E/F/G`);
    expect(report.repairs.length).toBeGreaterThanOrEqual(3);
    expect(report.document?.folder?.split('/')).toHaveLength(7);
  });
});

// Where the Android importer is stricter than the contract text alone says. A bundle that `import-check` accepts must be
// accepted by the app, so each of these is an error here, with the message that tells how to write it.
describe('step 2: the manifest as the app reads it', () => {
  const outlineFile = { version: 1, entries: [{ title: '1 Sets', page: 0, depth: 0 }] };
  const encode = (text: string): number[] => [...new TextEncoder().encode(text)];

  it('refuses a document.sha256 that is not lowercase hex, and says how to write it', async () => {
    const lower = sha(sample.pdf);
    const mixed = `${lower.slice(0, 32).toUpperCase()}${lower.slice(32)}`;
    for (const [name, value] of [['upper case', lower.toUpperCase()], ['mixed case', mixed]] as const) {
      const report = await check({ manifest: manifest(sample.pdf, {}, { sha256: value }) });
      expect(report.ok, name).toBe(false);
      expect(report.rejection, name).toMatchObject({ code: 'manifest-sha256' });
      expect(report.rejection?.message, name).toContain('lowercase');
      expect(report.rejection?.fix, name).toContain(lower);
      // The hash itself is right, so this is the only thing wrong with the bundle.
      expect(codes(report), name).toEqual(['manifest-sha256']);
    }
    for (const value of ['g'.repeat(64), lower.slice(1), `${lower}0`, ` ${lower}`, '', 5, null, [lower]]) {
      const report = await check({ manifest: manifest(sample.pdf, {}, { sha256: value }) });
      expect(report.rejection, JSON.stringify(value)).toMatchObject({ code: 'manifest-sha256' });
      expect(report.rejection?.message, JSON.stringify(value)).toContain('64 lowercase hex');
    }
    expect((await check({ manifest: manifest(sample.pdf, {}, { sha256: lower }) })).ok).toBe(true);
  });

  it('refuses a manifest that names an entry other than document.pdf, frames.json or outline.json', async () => {
    const withOutline = (extra: Record<string, unknown>, documentExtra: Record<string, unknown> = {}): Parts => ({
      outline: outlineFile,
      manifest: manifest(sample.pdf, { outline: 'outline.json', ...extra }, documentExtra),
    });
    const cases: [string, Parts, string][] = [
      ['another name for the pdf', withOutline({}, { pdf: 'other.pdf' }), 'manifest-pdf-name'],
      ['the pdf in another case', withOutline({}, { pdf: 'Document.pdf' }), 'manifest-pdf-name'],
      ['a pdf that is not text', withOutline({}, { pdf: 5 }), 'manifest-pdf-name'],
      ['another name for the frames', withOutline({ frames: 'my-frames.json' }), 'manifest-frames-name'],
      ['frames that are not text', withOutline({ frames: ['frames.json'] }), 'manifest-frames-name'],
      ['another name for the outline, though outline.json is there', withOutline({ outline: 'toc.json' }), 'manifest-outline-name'],
      ['an outline that is not text', withOutline({ outline: true }), 'manifest-outline-name'],
    ];
    for (const [name, parts, code] of cases) {
      const report = await check(parts);
      expect(report.ok, name).toBe(false);
      expect(report.rejection, name).toMatchObject({ code });
      expect(report.rejection?.message, name).toContain('entry names are fixed');
      expect(report.rejection?.fix, name).toContain('(or leave');
      expect(codes(report), name).toEqual([code]);
    }
    // The right names, a JSON null and a field left out all say the same thing: the app reads no other entry.
    expect((await check(withOutline({}, { pdf: 'document.pdf' }))).errors).toEqual([]);
    expect((await check(withOutline({ frames: null }, { pdf: null }))).errors).toEqual([]);
    expect((await check({ manifest: manifest(sample.pdf, { frames: undefined }, { pdf: undefined }) })).errors).toEqual([]);
  });

  it('refuses an outline that the manifest names but the archive does not hold', async () => {
    const report = await check({ manifest: manifest(sample.pdf, { outline: 'outline.json' }) });
    expect(report.ok).toBe(false);
    expect(report.rejection).toMatchObject({ code: 'manifest-outline-missing' });
    expect(report.rejection?.message).toContain('outline.json');
    expect(report.rejection?.fix).toContain('leave "outline" out');
    expect(codes(report)).toEqual(['manifest-outline-missing']);
    // Not named and not there is a bundle without a table of contents, and a null names nothing.
    expect((await check({ manifest: manifest(sample.pdf, { outline: undefined }) })).errors).toEqual([]);
    expect((await check({ manifest: manifest(sample.pdf, { outline: null }) })).errors).toEqual([]);
    // An outline.json the manifest does not name is read all the same (the app does), with a warning.
    const unlisted = await check({ outline: outlineFile, manifest: manifest(sample.pdf, { outline: null }) });
    expect(unlisted.ok).toBe(true);
    expect(unlisted.outline).toHaveLength(1);
    expect(unlisted.warnings.map((entry) => entry.code)).toContain('manifest-outline-unlisted');
  });

  it('refuses a document.folder that is not text', async () => {
    for (const folder of [5, true, ['Uni'], { name: 'Uni' }]) {
      const report = await check({ manifest: manifest(sample.pdf, {}, { folder }) });
      expect(report.ok, JSON.stringify(folder)).toBe(false);
      expect(report.rejection, JSON.stringify(folder)).toMatchObject({ code: 'manifest-folder' });
      expect(report.rejection?.message, JSON.stringify(folder)).toContain('not text');
      expect(codes(report), JSON.stringify(folder)).toEqual(['manifest-folder']);
    }
    // Text is cleaned, not refused; a null is no folder.
    const none = await check({ manifest: manifest(sample.pdf, {}, { folder: null }) });
    expect(none.ok).toBe(true);
    expect(none.document).not.toHaveProperty('folder');
    expect((await check({ manifest: manifest(sample.pdf, {}, { folder: '' }) })).ok).toBe(true);
  });

  it('refuses a size below 1 byte, and a page count the app cannot hold even when the PDF is not opened', async () => {
    for (const bytes of [0, -1, 1.5, '1']) {
      expect(codes(await check({ manifest: manifest(sample.pdf, {}, { bytes }) })), JSON.stringify(bytes)).toContain('manifest-bytes');
    }
    for (const pageCount of [0, 2147483648, 1e12, 2.5, '3']) {
      const report = await checkBundle(await bundle({ manifest: manifest(sample.pdf, {}, { pageCount }) }), { openPdf: false });
      expect(report.rejection, JSON.stringify(pageCount)).toMatchObject({ code: 'manifest-page-count' });
    }
    const biggest = await checkBundle(await bundle({ manifest: manifest(sample.pdf, {}, { pageCount: 2147483647 }) }), { openPdf: false });
    expect(biggest.ok).toBe(true);
  });

  it('refuses a JSON entry that is not UTF-8, and ignores a leading byte order mark', async () => {
    const manifestText = JSON.stringify(manifest());
    const inTitle = (bad: number[]): Uint8Array => {
      const at = manifestText.indexOf('Test') + 2;
      return Uint8Array.from([...encode(manifestText.slice(0, at)), ...bad, ...encode(manifestText.slice(at))]);
    };
    const inNote = (head: string, bad: number[]): Uint8Array => Uint8Array.from([...encode(`${head},"note":"`), ...bad, ...encode('"}')]);
    const outlineNamed = manifest(sample.pdf, { outline: 'outline.json' });
    // A stray byte, an overlong form, a surrogate written out, and a character cut short.
    for (const bad of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
      const name = bad.map((byte) => byte.toString(16)).join(' ');
      const inManifest = await check({ manifest: inTitle(bad) });
      expect(inManifest.rejection, name).toMatchObject({ code: 'manifest-json' });
      expect(inManifest.rejection?.message, name).toContain('UTF-8');
      const inFrames = await check({ frames: inNote('{"version":1,"frames":[]', bad) });
      expect(inFrames.rejection, name).toMatchObject({ code: 'frames-json' });
      expect(inFrames.rejection?.message, name).toContain('UTF-8');
      const inOutline = await check({ manifest: outlineNamed, outline: inNote('{"version":1,"entries":[]', bad) });
      expect(inOutline.rejection, name).toMatchObject({ code: 'outline-json' });
      expect(inOutline.rejection?.message, name).toContain('UTF-8');
    }
    const bom = [0xef, 0xbb, 0xbf];
    const withBom = await check({
      manifest: Uint8Array.from([...bom, ...encode(manifestText)]),
      frames: Uint8Array.from([...bom, ...encode(JSON.stringify(goodFrames))]),
    });
    expect(withBom.errors).toEqual([]);
    const accented = await check({ manifest: manifest(sample.pdf, {}, { title: 'Übungsblätter ∑ 数学' }) });
    expect(accented.ok).toBe(true);
    expect(accented.document?.title).toBe('Übungsblätter ∑ 数学');
  });

  it('refuses JSON nested more than 32 levels deep, and does not count brackets inside text', async () => {
    const nested = (levels: number): string => `${'['.repeat(levels)}${']'.repeat(levels)}`;
    const framesNoted = (note: string): string => `{"version":1,"frames":[],"note":${note}}`;
    // The object itself is the first level.
    expect((await check({ frames: framesNoted(nested(31)) })).ok).toBe(true);
    const deep = await check({ frames: framesNoted(nested(32)) });
    expect(deep.rejection).toMatchObject({ code: 'frames-json' });
    expect(deep.rejection?.message).toContain('33 levels');
    expect((await check({ frames: framesNoted(JSON.stringify('[{'.repeat(100))) })).ok).toBe(true);
    expect((await check({ frames: framesNoted(JSON.stringify('"]]'.repeat(100))) })).ok).toBe(true);
    const manifestDeep = JSON.stringify(manifest()).replace(/}$/, `,"note":${nested(32)}}`);
    const inManifest = await check({ manifest: manifestDeep });
    expect(inManifest.rejection).toMatchObject({ code: 'manifest-json' });
    expect(inManifest.rejection?.message).toContain('nested');
    const inOutline = await check({ manifest: manifest(sample.pdf, { outline: 'outline.json' }), outline: `{"version":1,"entries":[],"note":${nested(32)}}` });
    expect(inOutline.rejection).toMatchObject({ code: 'outline-json' });
  });
});

describe('step 3 and 4: the PDF', () => {
  it('rejects a PDF that does not match its hash (damaged or tampered)', async () => {
    const tampered = new Uint8Array(sample.pdf);
    tampered[100] = (tampered[100] as number) ^ 0xff;
    const report = await check({ pdf: tampered, manifest: manifest(sample.pdf) });
    expect(report.ok).toBe(false);
    expect(report.rejection?.code).toBe('pdf-hash-mismatch');
    expect(report.rejection?.message).toContain('tampered');
    expect(report.steps[2]?.status).toBe('failed');
  });

  it('rejects a size that does not match', async () => {
    expect(codes(await check({ manifest: manifest(sample.pdf, {}, { bytes: sample.pdf.length + 1 }) }))).toContain('pdf-size-mismatch');
  });

  it('rejects a page count that does not match the PDF', async () => {
    const report = await check({ manifest: manifest(sample.pdf, {}, { pageCount: 5 }) });
    expect(report.rejection?.code).toBe('pdf-page-count-mismatch');
    expect(report.rejection?.message).toContain('3 pages');
  });

  it('rejects a PDF that cannot be opened', async () => {
    const junk = new TextEncoder().encode('%PDF-1.4 this is not really a pdf');
    const report = await check({ pdf: junk, manifest: manifest(junk) });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('pdf-unreadable');
  });

  it('can skip opening the PDF', async () => {
    const junk = new TextEncoder().encode('%PDF-1.4 this is not really a pdf');
    const report = await checkBundle(await bundle({ pdf: junk, manifest: manifest(junk, {}, { pageCount: 3 }) }), { openPdf: false });
    expect(report.ok).toBe(true);
    expect(report.steps[3]?.status).toBe('skipped');
  });
});

describe('step 5: the frames', () => {
  const withFrames = (frames: unknown[]): Parts => ({ frames: { version: 1, frames } });
  const ex = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 }, ...extra });

  it('rejects a bad id and names the frame', async () => {
    const report = await check(withFrames([ex('bad id!')]));
    expect(report.ok).toBe(false);
    expect(report.rejection?.code).toBe('bad-id');
  });

  it('rejects duplicate ids, naming the id', async () => {
    const report = await check(withFrames([ex('a'), ex('a', { rect: { left: 0.1, top: 0.5, right: 0.9, bottom: 0.6 } })]));
    expect(report.rejection).toMatchObject({ code: 'duplicate-id', frameId: 'a' });
  });

  it('rejects a page that is out of range, zero-based', async () => {
    const report = await check(withFrames([ex('far', { page: 3 })]));
    expect(report.rejection).toMatchObject({ code: 'page-out-of-range', frameId: 'far' });
    expect(report.rejection?.message).toContain('3 pages');
    expect(codes(await check(withFrames([ex('neg', { page: -1 })])))).toContain('page-out-of-range');
  });

  it('rejects rectangles off the page, and repairs a little overshoot', async () => {
    const off = await check(withFrames([ex('off', { rect: { left: 0.1, top: 0.2, right: 1.2, bottom: 0.3 } })]));
    expect(off.rejection).toMatchObject({ code: 'rect-off-page', frameId: 'off' });
    const near = await check(withFrames([ex('near', { rect: { left: -0.004, top: 0.2, right: 1.004, bottom: 0.3 } })]));
    expect(near.ok).toBe(true);
    expect(near.repairs.map((entry) => entry.code)).toEqual(['rect-clamped', 'rect-clamped']);
    expect(near.frames?.[0]?.rect).toMatchObject({ left: 0, right: 1 });
  });

  it('rejects rectangles that are too small', async () => {
    const report = await check(withFrames([ex('thin', { rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.205 } })]));
    expect(report.rejection).toMatchObject({ code: 'rect-too-small', frameId: 'thin' });
  });

  it('rejects parts that overlap or leave a gap, and parts that are not in one column', async () => {
    const part = (id: string, top: number, bottom: number, left = 0.1): Record<string, unknown> => ex(id, { unit: 'u1', rect: { left, top, right: 0.9, bottom } });
    const gap = await check(withFrames([part('a', 0.2, 0.3), part('b', 0.32, 0.4)]));
    expect(gap.rejection).toMatchObject({ code: 'unit-gap', frameId: 'b' });
    const overlap = await check(withFrames([part('a', 0.2, 0.32), part('b', 0.3, 0.4)]));
    expect(overlap.rejection).toMatchObject({ code: 'unit-overlap', frameId: 'b' });
    const columns = await check(withFrames([part('a', 0.2, 0.3), part('b', 0.3, 0.4, 0.5)]));
    expect(columns.rejection).toMatchObject({ code: 'unit-edges', frameId: 'b' });
    const snapped = await check(withFrames([part('a', 0.2, 0.3), part('b', 0.3015, 0.4)]));
    expect(snapped.ok).toBe(true);
    expect(snapped.repairs.map((entry) => entry.code)).toEqual(['unit-snapped']);
  });

  it('rejects continues on a part, context on a question, a unit on a bookmark and more than 8 regions', async () => {
    const region = { page: 1, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } };
    expect((await check(withFrames([ex('a', { unit: 'u', continues: [region] }), ex('b', { unit: 'u', rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.4 } })]))).rejection?.code).toBe('unit-continues');
    expect((await check(withFrames([ex('q', { kind: 'question', context: [region] })]))).rejection?.code).toBe('context-not-exercise');
    expect((await check(withFrames([ex('b', { kind: 'bookmark', unit: 'u' })]))).rejection?.code).toBe('unit-not-exercise');
    expect((await check(withFrames([ex('c', { context: Array.from({ length: 9 }, () => region) })]))).rejection?.code).toBe('too-many-regions');
    expect((await check(withFrames([ex('c', { continues: Array.from({ length: 8 }, () => region) })]))).ok).toBe(true);
  });

  it('rejects a frames.json that is damaged or from a newer version', async () => {
    expect(codes(await check({ frames: '{oops' }))).toContain('frames-json');
    expect(codes(await check({ frames: { version: 2, frames: [] } }))).toContain('bundle-newer');
    expect(codes(await check({ frames: { frames: [] } }))).toContain('frames-version');
    expect(codes(await check({ frames: { version: 1 } }))).toContain('frames-not-array');
  });

  it('is strict about shapes: a rect as an array is not a rect in a bundle', async () => {
    expect(codes(await check(withFrames([ex('a', { rect: [0.1, 0.2, 0.9, 0.3] })])))).toContain('bad-rect');
  });
});

describe('the outline', () => {
  it('rejects a bad title, page or depth and repairs a depth that jumps', async () => {
    const outline = (entries: unknown[]): Parts => ({ outline: { version: 1, entries }, manifest: manifest(sample.pdf, { outline: 'outline.json' }) });
    expect(codes(await check(outline([{ title: '', page: 0, depth: 0 }])))).toContain('outline-bad-title');
    expect(codes(await check(outline([{ title: 'x', page: 3, depth: 0 }])))).toContain('outline-bad-page');
    expect(codes(await check(outline([{ title: 'x', page: 0, depth: 9 }])))).toContain('outline-bad-depth');
    const jump = await check(outline([{ title: 'a', page: 0, depth: 0 }, { title: 'c', page: 1, depth: 3 }]));
    expect(jump.ok).toBe(true);
    expect(jump.repairs.map((entry) => entry.code)).toEqual(['outline-depth-clamped']);
    expect(jump.outline?.map((entry) => entry.depth)).toEqual([0, 1]);
  });

  it('is used when outline.json is present even if the manifest does not list it', async () => {
    const report = await check({ outline: { version: 1, entries: [{ title: 'a', page: 0, depth: 0 }] } });
    expect(report.ok).toBe(true);
    expect(report.outline).toHaveLength(1);
    expect(report.warnings.map((entry) => entry.code)).toContain('manifest-outline-unlisted');
  });
});

describe('the writer', () => {
  const frames: Frame[] = [
    frame('e1', 'exercise', 0, rect(0.1, 0.2, 0.9, 0.3)),
    frame('p1', 'exercise', 0, rect(0.1, 0.4, 0.9, 0.5), { unit: 'u1', context: [{ page: 0, rect: rect(0.1, 0.35, 0.9, 0.4) }] }),
    frame('p2', 'exercise', 0, rect(0.1, 0.5, 0.9, 0.6), { unit: 'u1', context: [{ page: 0, rect: rect(0.1, 0.35, 0.9, 0.4) }] }),
    frame('q1', 'question', 1, rect(0.1, 0.2, 0.9, 0.3), { continues: [{ page: 2, rect: rect(0.1, 0.1, 0.9, 0.2) }] }),
    frame('b1', 'bookmark', 2, rect(0.1, 0.5, 0.9, 0.6)),
  ];
  const input = { pdfBytes: sample.pdf, title: ' Sheet ', pageCount: 3, frames, createdAt: new Date('2026-10-03T12:00:00.789Z') };

  it('writes the manifest of the format and nothing else', async () => {
    const { bytes, manifest: written } = await buildBundleBytes({ ...input, folder: 'Uni\\Analysis', fileName: 'sheet.pdf', outline: sample.outline });
    expect(written).toEqual({
      format: 'math-canvas-bundle',
      version: 1,
      createdAt: '2026-10-03T12:00:00Z',
      generator: { name: 'math-canvas-prep', version: VERSION, targets: 'math-canvas-bundle/1' },
      document: { title: 'Sheet', fileName: 'sheet.pdf', pdf: 'document.pdf', sha256: sha(sample.pdf), bytes: sample.pdf.length, pageCount: 3, folder: 'Uni/Analysis' },
      frames: 'frames.json',
      outline: 'outline.json',
    });
    const zip = await ZipArchive.open(bytesSource(bytes), { maxEntries: 16, maxArchiveBytes: 1e9 });
    expect(zip.entries.map((entry) => entry.name)).toEqual(['bundle.json', 'document.pdf', 'frames.json', 'outline.json']);
    expect(zip.entries.every((entry) => entry.method === 0)).toBe(true);
    const plain = await buildBundleBytes(input);
    expect(plain.manifest.document).not.toHaveProperty('folder');
    expect(plain.manifest).not.toHaveProperty('outline');
    expect((await ZipArchive.open(bytesSource(plain.bytes), { maxEntries: 16, maxArchiveBytes: 1e9 })).entries.map((entry) => entry.name)).toEqual(['bundle.json', 'document.pdf', 'frames.json']);
  });

  it('is deterministic for the same input', async () => {
    const one = await buildBundleBytes(input);
    const two = await buildBundleBytes(input);
    expect(one.bytes).toEqual(two.bytes);
  });

  it('is accepted by the importer check without repairs, and its frames survive a round trip', async () => {
    const { bytes } = await buildBundleBytes({ ...input, outline: sample.outline });
    const report = await checkBundle(bytes);
    expect(report.errors).toEqual([]);
    expect(report.repairs).toEqual([]);
    expect(report.frames).toEqual(canonicalizeFrames(frames).frames);
    expect(report.numbers?.map((entry) => entry.label).sort()).toEqual(['B1', 'E1', 'E2.1', 'E2.2', 'Q1']);
  });

  it('writes the context of a unit once, on its first part, and drops a unit of one frame', () => {
    const { frames: canonical, notes } = canonicalizeFrames([...frames, frame('lonely', 'exercise', 2, rect(0.1, 0.1, 0.9, 0.2), { unit: 'solo' })]);
    expect(canonical.find((entry) => entry.id === 'p1')?.context).toHaveLength(1);
    expect(canonical.find((entry) => entry.id === 'p2')?.context).toBeUndefined();
    expect(canonical.find((entry) => entry.id === 'lonely')?.unit).toBeUndefined();
    expect(notes.map((entry) => entry.code).sort()).toEqual(['unit-context-moved', 'unit-dropped']);
  });

  it('refuses to write what the importer would reject, with the issues', async () => {
    const broken = [frame('a', 'exercise', 9, rect(0.1, 0.2, 0.9, 0.3))];
    const error = await rejected(buildBundleBytes({ ...input, frames: broken }));
    expect(error.code).toBe('E_BUNDLE_INVALID');
    expect(error.issues[0]).toMatchObject({ code: 'page-out-of-range', frameId: 'a' });
    const noTitle = await rejected(buildBundleBytes({ ...input, title: '  ' }));
    expect(noTitle.issues[0]?.code).toBe('title');
  });

  it('refuses a PDF that is not the one the frames were made on', async () => {
    const error = await rejected(buildBundleBytes({ ...input, expect: { sha256: 'f'.repeat(64) } }));
    expect(error.issues[0]?.code).toBe('pdf-changed');
  });

  it('repairs what a reader may repair and reports it, and passes warnings on', async () => {
    const odd: Frame[] = [frame('a', 'exercise', 0, rect(0.1, 0.2, 0.9, 0.3)), frame('b', 'exercise', 0, rect(0.1, 0.25, 0.9, 0.35))];
    const written = await buildBundleBytes({ ...input, frames: odd, folder: 'A/B/\u0001C' });
    expect(written.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(['folder-cleaned', 'overlap']));
  });

  it('does not leave a rejected file open', async () => {
    const dir = await tempDir();
    const path = join(dir, 'junk.mcbundle');
    await writeFile(path, 'not a zip at all');
    const report = await checkBundle(path);
    expect(report.ok).toBe(false);
    expect(report.rejection?.code).toBe('zip-invalid');
    // On Windows a file that is still open cannot be deleted (EPERM or EBUSY); elsewhere this only checks the report.
    await rm(path);
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes a file atomically from a PDF on disk and verifies as it goes', async () => {
    const dir = await tempDir();
    const pdfPath = join(dir, 'sheet.pdf');
    await writeFile(pdfPath, sample.pdf);
    const out = join(dir, 'out', 'sheet.mcbundle');
    const result = await writeBundle(out, { pdfPath, title: 'Sheet', pageCount: 3, frames, createdAt: new Date('2026-10-03T12:00:00Z') });
    expect(result.path).toBe(out);
    expect(result.bytes).toBe((await readFile(out)).length);
    expect(result.counts).toEqual({ frames: 5, outlineEntries: 0 });
    expect((await readdir(join(dir, 'out'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const report = await checkBundle(out);
    expect(report.ok).toBe(true);
    expect(report.manifest?.document).toMatchObject({ fileName: 'sheet.pdf' });
    const again = await buildBundleBytes({ pdfBytes: sample.pdf, fileName: 'sheet.pdf', title: 'Sheet', pageCount: 3, frames, createdAt: new Date('2026-10-03T12:00:00Z') });
    expect(await readFile(out)).toEqual(Buffer.from(again.bytes));
  });

  it('accepts a PDF that is not the sample (any valid PDF), including one with no text', async () => {
    const scan = buildPdf({ pages: [{ scan: { bars: [{ left: 0.1, top: 0.1, right: 0.9, bottom: 0.15 }] } }] });
    const { bytes } = await buildBundleBytes({ pdfBytes: scan, title: 'Scan', pageCount: 1, frames: [frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2))] });
    expect((await checkBundle(bytes)).ok).toBe(true);
  });
});
