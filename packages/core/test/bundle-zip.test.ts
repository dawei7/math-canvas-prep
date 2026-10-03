import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipArchive, ZipError, bytesSource, crc32, entryFromBytes, zipToBytes, type ByteSource } from '../src/bundle/zip.js';

const limits = { maxEntries: 16, maxArchiveBytes: 600 * 1024 * 1024 };
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Offsets of the central directory records of an archive written by the writer (no extra fields, no comments). */
function records(bytes: Uint8Array): { start: number; local: number; nameLength: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const total = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const result = [];
  for (let i = 0; i < total; i += 1) {
    const nameLength = view.getUint16(at + 28, true);
    result.push({ start: at, local: view.getUint32(at + 42, true), nameLength });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return result;
}

async function archive(entries: [string, string][], deflate = false): Promise<Uint8Array> {
  return zipToBytes(entries.map(([name, body]) => entryFromBytes(name, text(body), { deflate })));
}

async function openError(bytes: Uint8Array): Promise<ZipError> {
  try {
    await ZipArchive.open(bytesSource(bytes), limits);
  } catch (error) {
    expect(error).toBeInstanceOf(ZipError);
    return error as ZipError;
  }
  throw new Error('the archive was accepted');
}

describe('the writer', () => {
  it('is deterministic and produces what a reader reads back', async () => {
    const entries: [string, string][] = [['bundle.json', '{"a":1}'], ['frames.json', '{"frames":[]}']];
    const first = await archive(entries);
    const second = await archive(entries);
    expect(first).toEqual(second);
    const zip = await ZipArchive.open(bytesSource(first), limits);
    expect(zip.entries.map((entry) => entry.name)).toEqual(['bundle.json', 'frames.json']);
    expect(new TextDecoder().decode(await zip.read(zip.entries[0] as never, 1000))).toBe('{"a":1}');
  });

  it('stores by default and deflates when asked and when that helps', async () => {
    const big = 'abc'.repeat(2000);
    const stored = await ZipArchive.open(bytesSource(await archive([['a.json', big]])), limits);
    expect(stored.entries[0]?.method).toBe(0);
    const packed = await ZipArchive.open(bytesSource(await archive([['a.json', big]], true)), limits);
    expect(packed.entries[0]?.method).toBe(8);
    expect(packed.entries[0]?.storedSize).toBeLessThan(big.length);
    expect(new TextDecoder().decode(await packed.read(packed.entries[0] as never, 100000))).toBe(big);
  });

  it('writes UTF-8 names and fixed timestamps', async () => {
    const bytes = await archive([['dökument.json', '{}']]);
    const zip = await ZipArchive.open(bytesSource(bytes), limits);
    expect(zip.entries[0]?.name).toBe('dökument.json');
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe(0x21);
  });

  it('has the CRC-32 of the standard check value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });
});

describe('the reader rejects damaged and hostile archives', () => {
  const good = (): Promise<Uint8Array> => archive([['bundle.json', '{"a":1}'], ['document.pdf', 'PDF'], ['frames.json', '{}']]);

  it('rejects things that are not ZIP archives', async () => {
    expect((await openError(new Uint8Array(0))).code).toBe('zip-invalid');
    expect((await openError(text('definitely not a zip file, just text'))).code).toBe('zip-invalid');
    const bytes = await good();
    expect((await openError(bytes.subarray(0, bytes.length - 10))).code).toBe('zip-invalid');
    const trailing = new Uint8Array(bytes.length + 5);
    trailing.set(bytes);
    expect((await openError(trailing)).code).toBe('zip-invalid');
  });

  it('accepts an archive comment', async () => {
    const bytes = await good();
    const withComment = new Uint8Array(bytes.length + 5);
    withComment.set(bytes);
    new DataView(withComment.buffer).setUint16(bytes.length - 2, 5, true);
    withComment.set(text('hello'), bytes.length);
    const zip = await ZipArchive.open(bytesSource(withComment), limits);
    expect(zip.entries).toHaveLength(3);
  });

  it('rejects encryption, unknown compression methods, ZIP64 and multi-disk archives', async () => {
    const encrypted = await good();
    const record = (records(encrypted)[0] as { start: number }).start;
    new DataView(encrypted.buffer).setUint16(record + 8, 0x0001, true);
    expect((await openError(encrypted)).code).toBe('zip-encrypted');

    const method = await good();
    new DataView(method.buffer).setUint16((records(method)[0] as { start: number }).start + 10, 99, true);
    expect((await openError(method)).code).toBe('zip-method');

    const zip64 = await good();
    new DataView(zip64.buffer).setUint16(zip64.length - 22 + 8, 0xffff, true);
    new DataView(zip64.buffer).setUint16(zip64.length - 22 + 10, 0xffff, true);
    expect((await openError(zip64)).message).toContain('ZIP64');

    const multi = await good();
    new DataView(multi.buffer).setUint16(multi.length - 22 + 4, 1, true);
    expect((await openError(multi)).message).toContain('Multi-disk');
  });

  it('rejects more entries than the limit', async () => {
    const many = await archive(Array.from({ length: 17 }, (_unused, i): [string, string] => [`e${i}`, 'x']));
    expect((await openError(many)).code).toBe('zip-limits');
    const sixteen = await archive(Array.from({ length: 16 }, (_unused, i): [string, string] => [`e${i}`, 'x']));
    await expect(ZipArchive.open(bytesSource(sixteen), limits)).resolves.toBeDefined();
  });

  it('rejects an archive larger than the limit without reading it', async () => {
    const huge: ByteSource = { size: 601 * 1024 * 1024, read: () => Promise.reject(new Error('must not be read')), close: () => Promise.resolve() };
    await expect(ZipArchive.open(huge, limits)).rejects.toMatchObject({ code: 'zip-too-large' });
  });

  it('rejects entries that overlap each other or run into the central directory', async () => {
    const overlap = await good();
    const rs = records(overlap);
    new DataView(overlap.buffer).setUint32((rs[1] as { start: number }).start + 42, (rs[0] as { local: number }).local, true);
    expect((await openError(overlap)).message).toContain('overlaps');

    const long = await good();
    new DataView(long.buffer).setUint32((records(long)[2] as { start: number }).start + 20, 1_000_000, true);
    expect((await openError(long)).code).toBe('zip-invalid');
  });

  it('rejects a local header that names another entry than the central directory', async () => {
    const bytes = await good();
    const first = records(bytes)[0] as { local: number };
    bytes[first.local + 30] = 'X'.charCodeAt(0);
    const zip = await ZipArchive.open(bytesSource(bytes), limits);
    await expect(zip.read(zip.entries[0] as never, 1000)).rejects.toMatchObject({ code: 'zip-invalid' });
  });

  it('detects damaged data by its CRC, also when streaming', async () => {
    const bytes = await good();
    const second = records(bytes)[1] as { local: number; nameLength: number };
    bytes[second.local + 30 + second.nameLength] = 0x58;
    const zip = await ZipArchive.open(bytesSource(bytes), limits);
    await expect(zip.read(zip.entries[1] as never, 1000)).rejects.toMatchObject({ code: 'zip-crc' });
    await expect(
      (async (): Promise<void> => {
        for await (const chunk of zip.stream(zip.entries[1] as never, 1000)) void chunk;
      })(),
    ).rejects.toMatchObject({ code: 'zip-crc' });
  });

  it('enforces the size limit on declared sizes', async () => {
    const zip = await ZipArchive.open(bytesSource(await good()), limits);
    await expect(zip.read(zip.entries[0] as never, 3)).rejects.toMatchObject({ code: 'zip-limits' });
  });

  it('does not inflate a bomb: a deflate entry that is far larger than it declares', async () => {
    const payload = deflateRawSync(new Uint8Array(20 * 1024 * 1024), { level: 9 });
    const bomb = await zipToBytes([{ name: 'bomb', size: 100, crc32: 0, method: 8, storedSize: payload.length, chunks: async function* () { yield new Uint8Array(payload); } }]);
    const zip = await ZipArchive.open(bytesSource(bomb), limits);
    await expect(zip.read(zip.entries[0] as never, 1000)).rejects.toMatchObject({ code: 'zip-invalid' });
  });

  it('refuses stored entries whose sizes disagree', async () => {
    const bytes = await good();
    new DataView(bytes.buffer).setUint32((records(bytes)[0] as { start: number }).start + 24, 99, true);
    const zip = await ZipArchive.open(bytesSource(bytes), limits);
    await expect(zip.read(zip.entries[0] as never, 1000)).rejects.toMatchObject({ code: 'zip-invalid' });
  });
});
