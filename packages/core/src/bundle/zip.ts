import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { McPrepError } from '../rules/issues.js';

/**
 * A small, strict ZIP codec for `.mcbundle` files (docs/BUNDLE_FORMAT.md, section 1): UTF-8 names, no encryption, no
 * ZIP64, no multi-disk, deflate or stored. The writer is deterministic (fixed timestamps, fixed order). The reader
 * checks the central directory against the archive (offsets, overlaps, local header names, CRC) and bounds every read.
 */

// ---------------------------------------------------------------------------------------------------------------------
// CRC-32

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < chunk.length; i += 1) c = (TABLE[(c ^ (chunk[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

export const crc32 = (bytes: Uint8Array): number => crc32Update(0, bytes);

// ---------------------------------------------------------------------------------------------------------------------
// Writing

export interface ZipEntry {
  name: string;
  /** Uncompressed size. */
  size: number;
  crc32: number;
  method: 0 | 8;
  /** Size as stored (equal to `size` for method 0). */
  storedSize: number;
  /** The stored bytes (compressed when method is 8). */
  chunks(): AsyncIterable<Uint8Array>;
}

export function entryFromBytes(name: string, bytes: Uint8Array, options: { deflate?: boolean } = {}): ZipEntry {
  const checksum = crc32(bytes);
  if (options.deflate === true) {
    const packed = deflateRawSync(bytes, { level: 9 });
    if (packed.length < bytes.length) {
      return {
        name,
        size: bytes.length,
        crc32: checksum,
        method: 8,
        storedSize: packed.length,
        chunks: async function* () {
          yield new Uint8Array(packed);
        },
      };
    }
  }
  return {
    name,
    size: bytes.length,
    crc32: checksum,
    method: 0,
    storedSize: bytes.length,
    chunks: async function* () {
      yield bytes;
    },
  };
}

/** A stored entry read from a file in chunks; the file is read once here for the checksum and once when written. */
export async function entryFromFile(name: string, path: string, known?: { size: number; crc32: number }): Promise<ZipEntry> {
  let size = known?.size;
  let checksum = known?.crc32;
  if (size === undefined || checksum === undefined) {
    size = 0;
    checksum = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
      const bytes = chunk as Uint8Array;
      size += bytes.length;
      checksum = crc32Update(checksum, bytes);
    }
  }
  const total = size;
  return {
    name,
    size: total,
    crc32: checksum,
    method: 0,
    storedSize: total,
    chunks: async function* () {
      let seen = 0;
      for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
        seen += (chunk as Uint8Array).length;
        yield chunk as Uint8Array;
      }
      if (seen !== total) throw new McPrepError('E_FILE_CHANGED', `The file ${path} changed while it was being read.`);
    },
  };
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const FLAG_UTF8 = 0x0800;

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}
function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}
function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The archive as a stream of chunks, in the order of `entries`. Deterministic for the same entries. */
export async function* zipChunks(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const central: { entry: ZipEntry; name: Uint8Array; offset: number }[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.storedSize >= 0xffffffff || entry.size >= 0xffffffff || offset >= 0xffffffff) {
      throw new McPrepError('E_ZIP64', 'The archive would need ZIP64, which bundles do not use.');
    }
    const name = encoder.encode(entry.name);
    const header = join([
      u32(0x04034b50),
      u16(20),
      u16(FLAG_UTF8),
      u16(entry.method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(entry.crc32),
      u32(entry.storedSize),
      u32(entry.size),
      u16(name.length),
      u16(0),
      name,
    ]);
    central.push({ entry, name, offset });
    yield header;
    offset += header.length;
    let written = 0;
    for await (const chunk of entry.chunks()) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== entry.storedSize) {
      throw new McPrepError('E_ZIP', `The entry ${entry.name} produced ${written} bytes instead of ${entry.storedSize}.`);
    }
    offset += written;
  }
  const directoryStart = offset;
  let directorySize = 0;
  for (const item of central) {
    const record = join([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(FLAG_UTF8),
      u16(item.entry.method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(item.entry.crc32),
      u32(item.entry.storedSize),
      u32(item.entry.size),
      u16(item.name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(item.offset),
      item.name,
    ]);
    directorySize += record.length;
    yield record;
  }
  yield join([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(directorySize), u32(directoryStart), u16(0)]);
}

export async function zipToBytes(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of zipChunks(entries)) parts.push(chunk);
  return join(parts);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

/** Where the archive's bytes come from: a file or memory. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
    close: () => Promise.resolve(),
  };
}

export async function fileSource(path: string): Promise<ByteSource> {
  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(path, 'r');
    size = (await stat(path)).size;
  } catch (error) {
    throw new McPrepError('E_FILE', `Cannot read "${path}": ${(error as Error).message}`, { cause: error });
  }
  return {
    size,
    read: async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
}

export interface ZipLimits {
  maxEntries: number;
  maxArchiveBytes: number;
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  storedSize: number;
  method: 0 | 8;
  crc32: number;
  offset: number;
  flags: number;
}

export class ZipError extends McPrepError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ZipError';
  }
}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export class ZipArchive {
  readonly entries: ZipEntryInfo[];
  private readonly source: ByteSource;
  private readonly directoryOffset: number;

  private constructor(source: ByteSource, entries: ZipEntryInfo[], directoryOffset: number) {
    this.source = source;
    this.entries = entries;
    this.directoryOffset = directoryOffset;
  }

  static async open(source: ByteSource, limits: ZipLimits): Promise<ZipArchive> {
    if (source.size > limits.maxArchiveBytes) {
      throw new ZipError('zip-too-large', `The archive is ${source.size} bytes; the limit is ${limits.maxArchiveBytes}.`);
    }
    if (source.size < 22) throw new ZipError('zip-invalid', 'The file is too small to be a ZIP archive.');
    const tailLength = Math.min(source.size, 22 + 0xffff);
    const tail = await source.read(source.size - tailLength, tailLength);
    const tailView = view(tail);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (tailView.getUint32(at, true) !== 0x06054b50) continue;
      if (at + 22 + tailView.getUint16(at + 20, true) === tail.length) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('zip-invalid', 'This is not a ZIP archive (no end-of-central-directory record).');
    const disk = tailView.getUint16(eocd + 4, true);
    const directoryDisk = tailView.getUint16(eocd + 6, true);
    const onDisk = tailView.getUint16(eocd + 8, true);
    const total = tailView.getUint16(eocd + 10, true);
    const directorySize = tailView.getUint32(eocd + 12, true);
    const directoryOffset = tailView.getUint32(eocd + 16, true);
    if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) {
      throw new ZipError('zip-invalid', 'Multi-disk archives are not supported.');
    }
    if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new ZipError('zip-invalid', 'ZIP64 archives are not supported.');
    }
    if (total > limits.maxEntries) {
      throw new ZipError('zip-limits', `The archive has ${total} entries; at most ${limits.maxEntries} are allowed.`);
    }
    if (directoryOffset + directorySize > source.size - tailLength + eocd || directorySize > 1 << 20) {
      throw new ZipError('zip-invalid', 'The central directory is outside the archive.');
    }
    const directory = await source.read(directoryOffset, directorySize);
    if (directory.length !== directorySize) throw new ZipError('zip-invalid', 'The archive is truncated.');
    const dv = view(directory);
    const decoder = new TextDecoder('utf-8');
    const entries: ZipEntryInfo[] = [];
    let at = 0;
    for (let index = 0; index < total; index += 1) {
      if (at + 46 > directory.length || dv.getUint32(at, true) !== 0x02014b50) {
        throw new ZipError('zip-invalid', `The central directory is damaged (entry ${index}).`);
      }
      const flags = dv.getUint16(at + 8, true);
      const method = dv.getUint16(at + 10, true);
      const checksum = dv.getUint32(at + 16, true);
      const storedSize = dv.getUint32(at + 20, true);
      const size = dv.getUint32(at + 24, true);
      const nameLength = dv.getUint16(at + 28, true);
      const extraLength = dv.getUint16(at + 30, true);
      const commentLength = dv.getUint16(at + 32, true);
      const diskStart = dv.getUint16(at + 34, true);
      const offset = dv.getUint32(at + 42, true);
      const end = at + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length) throw new ZipError('zip-invalid', `The central directory is damaged (entry ${index}).`);
      const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
      if (diskStart !== 0) throw new ZipError('zip-invalid', `Entry "${name}" is on another disk.`);
      if (storedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
        throw new ZipError('zip-invalid', 'ZIP64 archives are not supported.');
      }
      if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
        throw new ZipError('zip-encrypted', `Entry "${name}" is encrypted; bundles are never encrypted.`);
      }
      if (method !== 0 && method !== 8) {
        throw new ZipError('zip-method', `Entry "${name}" uses compression method ${method}; only stored and deflate are allowed.`);
      }
      entries.push({ name, size, storedSize, method, crc32: checksum, offset, flags });
      at = end;
    }
    if (at !== directory.length) throw new ZipError('zip-invalid', 'The central directory has trailing bytes.');

    // Every entry lies before the central directory and no two entries overlap (a classic zip-bomb trick).
    const spans = entries
      .map((entry) => ({ entry, start: entry.offset, end: entry.offset + 30 + new TextEncoder().encode(entry.name).length + entry.storedSize }))
      .sort((a, b) => a.start - b.start);
    spans.forEach((span, index) => {
      const next = spans[index + 1];
      if (span.end > directoryOffset || (next && span.end > next.start)) {
        throw new ZipError('zip-invalid', `Entry "${span.entry.name}" overlaps another part of the archive.`);
      }
    });
    return new ZipArchive(source, entries, directoryOffset);
  }

  find(name: string): ZipEntryInfo[] {
    return this.entries.filter((entry) => entry.name === name);
  }

  /** Where the data of an entry starts, after checking its local header against the central directory. */
  private async dataStart(entry: ZipEntryInfo): Promise<number> {
    const header = await this.source.read(entry.offset, 30);
    if (header.length < 30 || view(header).getUint32(0, true) !== 0x04034b50) {
      throw new ZipError('zip-invalid', `The local header of "${entry.name}" is damaged.`);
    }
    const dv = view(header);
    const nameLength = dv.getUint16(26, true);
    const extraLength = dv.getUint16(28, true);
    const nameBytes = await this.source.read(entry.offset + 30, nameLength);
    if (new TextDecoder().decode(nameBytes) !== entry.name) {
      throw new ZipError('zip-invalid', `The local header of "${entry.name}" names a different entry.`);
    }
    const start = entry.offset + 30 + nameLength + extraLength;
    if (start + entry.storedSize > this.directoryOffset) {
      throw new ZipError('zip-invalid', `The data of "${entry.name}" runs into the central directory.`);
    }
    return start;
  }

  /** The bytes of an entry, at most `limit` of them; checks the declared size and the CRC. */
  async read(entry: ZipEntryInfo, limit: number): Promise<Uint8Array> {
    if (entry.size > limit) {
      throw new ZipError('zip-limits', `Entry "${entry.name}" is ${entry.size} bytes; the limit is ${limit}.`);
    }
    const start = await this.dataStart(entry);
    const stored = await this.source.read(start, entry.storedSize);
    if (stored.length !== entry.storedSize) throw new ZipError('zip-invalid', `Entry "${entry.name}" is truncated.`);
    let bytes: Uint8Array;
    if (entry.method === 0) {
      if (entry.storedSize !== entry.size) throw new ZipError('zip-invalid', `Entry "${entry.name}" has inconsistent sizes.`);
      bytes = stored;
    } else {
      try {
        bytes = inflateRawSync(stored, { maxOutputLength: Math.max(1, limit) });
      } catch (error) {
        throw new ZipError('zip-invalid', `Entry "${entry.name}" cannot be decompressed within the limit: ${(error as Error).message}`);
      }
      if (bytes.length !== entry.size) throw new ZipError('zip-invalid', `Entry "${entry.name}" decompresses to ${bytes.length} bytes, not the declared ${entry.size}.`);
    }
    if (crc32(bytes) !== entry.crc32) throw new ZipError('zip-crc', `Entry "${entry.name}" fails its CRC check; the archive is damaged.`);
    return bytes;
  }

  /**
   * The bytes of an entry in chunks, for large ones. Throws at the end when the size or the CRC does not match, so the
   * caller must treat the stream as unfinished until the iterator completes.
   */
  async *stream(entry: ZipEntryInfo, limit: number): AsyncGenerator<Uint8Array> {
    if (entry.size > limit) {
      throw new ZipError('zip-limits', `Entry "${entry.name}" is ${entry.size} bytes; the limit is ${limit}.`);
    }
    if (entry.method !== 0) {
      yield await this.read(entry, limit);
      return;
    }
    if (entry.storedSize !== entry.size) throw new ZipError('zip-invalid', `Entry "${entry.name}" has inconsistent sizes.`);
    const start = await this.dataStart(entry);
    let checksum = 0;
    let done = 0;
    const step = 1 << 20;
    while (done < entry.size) {
      const chunk = await this.source.read(start + done, Math.min(step, entry.size - done));
      if (chunk.length === 0) throw new ZipError('zip-invalid', `Entry "${entry.name}" is truncated.`);
      checksum = crc32Update(checksum, chunk);
      done += chunk.length;
      yield chunk;
    }
    if (checksum !== entry.crc32) throw new ZipError('zip-crc', `Entry "${entry.name}" fails its CRC check; the archive is damaged.`);
  }

  close(): Promise<void> {
    return this.source.close();
  }
}
