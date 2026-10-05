import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { complete, copyDelivery, laidOut, type Delivered } from './delivered.js';
import { tempDir } from './helpers.js';

const script = new URL('../../../scripts/check-delivery.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dist = new URL('../dist/index.js', import.meta.url);

function check(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!existsSync(dist))('scripts/check-delivery.mjs checks what was delivered for a queue of books', () => {
  let d: Delivered;
  beforeAll(async () => {
    d = await laidOut('algebra');
    await complete(d);
  }, 120_000);

  it('exits 0 when every book that was checked is PERFECT, 1 when one is not, and 2 for a usage error', async () => {
    const root = d.root;
    const queue = join(root, 'queue.json');
    await writeFile(queue, JSON.stringify({ books: [{ pdf: 'inbox/algebra.pdf', name: 'algebra' }, { pdf: 'inbox/algebra.pdf', name: 'geometry' }] }));
    const out = await tempDir('mcprep-check-delivery-');
    const copies = await tempDir('mcprep-check-delivery-');

    // Two books in the queue, one of them not started: not every book is perfect.
    const mixed = check(root, queue, '--work', d.work, '--out', out, '--copy-bundles', copies);
    expect(mixed.status, mixed.stderr).toBe(1);
    expect(mixed.stdout).toMatch(/\[1\/2\] algebra: PERFECT \(\d+(\.\d)? s\)/);
    expect(mixed.stdout).toContain('[2/2] geometry: NOT STARTED');
    expect(mixed.stdout).toMatch(/1\s+algebra\s+PERFECT\s+4\s+112\s+112\/112\s+0\/0\s+ok\s+-/);
    expect(mixed.stdout).toContain('PERFECT 1, NOT STARTED 1');
    expect(mixed.stdout).toContain('Copied 1 bundle to');
    expect(readdirSync(out).sort()).toEqual(['DELIVERY.json', 'DELIVERY.md']);
    expect(readFileSync(join(out, 'DELIVERY.md'), 'utf8')).toContain('## geometry: NOT STARTED');
    expect((JSON.parse(readFileSync(join(out, 'DELIVERY.json'), 'utf8')) as { perfect: boolean }).perfect).toBe(false);
    expect(readdirSync(join(copies, 'perfect'))).toEqual(['algebra.mcbundle']);

    // Only the books named are checked, and they are perfect.
    const only = check(root, queue, '--work', d.work, '--out', out, '--only', 'algebra');
    expect(only.status, only.stderr).toBe(0);
    expect((JSON.parse(readFileSync(join(out, 'DELIVERY.json'), 'utf8')) as { perfect: boolean }).perfect).toBe(true);

    // A folder of PDFs is a queue as well; the work folder of a book that does not exist is NOT STARTED.
    const folder = check(root, join(root, 'inbox'), '--work', d.work, '--out', out);
    expect(folder.status, folder.stderr).toBe(0);

    // A book may fail without the others stopping, and the exit code says it.
    const broken = await copyDelivery(d, { name: 'broken' });
    await writeFile(join(broken.folder, 'book.mcprep.json'), '{ not json');
    await writeFile(join(root, 'queue2.json'), JSON.stringify({ books: [{ pdf: 'inbox/algebra.pdf', name: 'algebra' }, { pdf: broken.pdf, name: 'broken' }] }));
    const failed = check(root, join(root, 'queue2.json'), '--work', join(broken.root, 'work'), '--out', out);
    expect(failed.status).toBe(1);

    // Usage errors: exit 2, the usage line on standard error, nothing written.
    const fresh = await tempDir('mcprep-check-delivery-');
    for (const args of [[], [queue], [queue, '--work'], [queue, '--work', d.work, '--bogus', 'x'], [queue, '--work', d.work, '--only', 'nothing'], [join(root, 'nothing.json'), '--work', d.work, '--out', fresh]]) {
      const bad = check(root, ...args);
      expect(bad.status, args.join(' ')).toBe(2);
      expect(bad.stderr, args.join(' ')).toContain('usage: node scripts/check-delivery.mjs');
    }
    expect(readdirSync(fresh)).toEqual([]);
    const help = check(root, '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage: node scripts/check-delivery.mjs');
  });
});
