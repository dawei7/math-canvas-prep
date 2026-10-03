import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { McPrepError } from '../rules/issues.js';

/**
 * Atomic writes: the data goes to a temporary file in the same folder, is flushed to disk and renamed over the target,
 * so a reader (or a crash) never sees a half-written file. On Windows the rename can fail for a moment while another
 * program (an antivirus scanner, a file watcher) holds the target open; it is retried briefly.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function writeStreamAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const temp = join(folder, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let written = 0;
  try {
    const handle = await open(temp, 'wx');
    try {
      for await (const chunk of chunks) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          offset += bytesWritten;
        }
        written += chunk.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, path);
    return written;
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (error instanceof McPrepError) throw error;
    throw new McPrepError('E_WRITE', `Cannot write "${path}": ${(error as Error).message}`, {
      hint: 'Check that the folder exists, is writable and has free space.',
      cause: error,
    });
  }
}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  await writeStreamAtomic(
    path,
    (async function* () {
      yield bytes;
    })(),
  );
}
