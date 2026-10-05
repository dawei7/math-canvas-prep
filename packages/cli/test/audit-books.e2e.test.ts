import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSyntheticBook } from '@mcprep/core/testing';

const script = new URL('../../../scripts/audit-books.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dist = new URL('../dist/index.js', import.meta.url);
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function audit(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!existsSync(dist))('scripts/audit-books.mjs audits every book of a folder', () => {
  it('writes a folder per book and an index, treats a book without a licence like any other, goes on after a broken one and exits 1', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcprep-audit-books-'));
    dirs.push(root);
    const inbox = join(root, 'inbox');
    mkdirSync(inbox);
    const pdf = buildSyntheticBook().pdf;
    writeFileSync(join(inbox, 'algebra.pdf'), pdf);
    writeFileSync(
      join(inbox, 'algebra.meta.json'),
      JSON.stringify({ title: 'Synthetic Algebra', folder: 'Books/Algebra', author: 'A. Author', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, notice: 'Synthetic Algebra by A. Author.', maxItems: 30 }),
    );
    writeFileSync(join(inbox, 'unlicensed.pdf'), pdf);
    writeFileSync(join(inbox, 'broken.pdf'), 'this is not a PDF');
    const results = join(root, 'results');

    const first = audit(root, inbox, '--out', results, '--sample', '4');
    expect(first.status).toBe(1);
    expect(first.stdout).toContain('[1/3] algebra');
    expect(first.stdout).not.toMatch(/check before you share/i);
    expect(first.stdout).toContain('FAILED after');

    const index = readFileSync(join(results, 'INDEX.md'), 'utf8');
    expect(index).toContain('# Books audited');
    // The columns validation and text check (exercises verify): the algebra book has a cap of 30 exercises per section, and the answers in the
    // key of the exercises that the cap left out are no finding of the text check.
    expect(index).toMatch(/\| algebra \| 21 \| 2 \| 4 \| 72 \| 72 \(100 %\) \| ok: 0 errors, 0 warnings \| ok: 0 errors, 0 warnings \| accepts \| CC BY 3\.0 \|/);
    expect(index).toMatch(/\| unlicensed \| 21 \| 2 \| 4 \| 112 \| 112 \(100 %\) \| ok: 0 errors, \d+ warnings? \| ok: 0 errors, 0 warnings \| accepts \| {2}\|/);
    const summary = JSON.parse(readFileSync(join(results, 'algebra', 'acceptance-summary.json'), 'utf8')) as { verify?: { errors: number; answersBeyondTheCap?: number } | null };
    expect(summary.verify?.errors).toBe(0);
    expect(summary.verify?.answersBeyondTheCap).toBe(40);
    expect(readFileSync(join(results, 'algebra', 'acceptance-report.md'), 'utf8')).toContain('40 answers of the exercises that the cap left out are in the key and are not counted');
    expect(index).toContain('none stated for unlicensed)');
    expect(index).not.toMatch(/check before you share/i);
    expect(index).toMatch(/\| broken \|[^\n]*\*\*FAILED\*\*: the script stopped \(exit 1\)/);
    expect(index).toContain('## Next');
    for (const name of ['algebra', 'unlicensed']) {
      expect(existsSync(join(results, name, `${name}-audited.mcbundle`))).toBe(true);
      expect(existsSync(join(results, name, `${name}-audited.mcprep.json`))).toBe(true);
      expect(existsSync(join(results, name, 'acceptance-report.md'))).toBe(true);
      expect(existsSync(join(results, name, 'run.log'))).toBe(true);
    }
    expect(readFileSync(join(results, 'broken', 'run.log'), 'utf8')).toContain('not a readable PDF');

    // The bundle of the licensed book carries what the sidecar says; the other carries no licence and none is made up.
    const manifest = (name: string): { document?: { license?: unknown; author?: string; folder?: string } } => {
      const result = spawnSync(process.execPath, [new URL('../bin/mcprep.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'inspect-bundle', join(results, name, `${name}-audited.mcbundle`), '--json'], { encoding: 'utf8' });
      return (JSON.parse(result.stdout) as { result: { manifest: { document?: { license?: unknown; author?: string; folder?: string } } } }).result.manifest;
    };
    expect(manifest('algebra').document).toMatchObject({ license: { name: 'CC BY 3.0' }, author: 'A. Author', folder: 'Books/Algebra' });
    expect(manifest('unlicensed').document?.license).toBeUndefined();
    expect(manifest('unlicensed').document?.author).toBeUndefined();

    // One book again: the others keep their rows.
    const again = audit(root, inbox, '--out', results, '--only', 'algebra', '--sample', '4');
    // Only the books asked for count: the broken one was not run now.
    expect(again.status).toBe(0);
    const second = readFileSync(join(results, 'INDEX.md'), 'utf8');
    expect(second).toMatch(/\| unlicensed \| 21 \|/);
    expect(second).toMatch(/\| algebra \| 21 \|/);
    const unknown = audit(root, inbox, '--out', results, '--only', 'nothing');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('no such book: nothing');
  });

  it('exits 0 when every book is audited, reads a queue file, and refuses a sidecar with a field it does not know', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcprep-audit-queue-'));
    dirs.push(root);
    writeFileSync(join(root, 'one.pdf'), buildSyntheticBook().pdf);
    const queue = join(root, 'queue.json');
    writeFileSync(queue, JSON.stringify({ books: [{ pdf: 'one.pdf', name: 'first', license: { name: 'CC BY-SA 4.0' }, maxItems: 20 }] }));
    const ok = audit(root, queue, '--out', join(root, 'out'), '--sample', '4');
    expect(ok.status).toBe(0);
    expect(readFileSync(join(root, 'out', 'INDEX.md'), 'utf8')).toMatch(/\| first \| 21 \| 2 \| 4 \| 62 \|[^\n]*\| CC BY-SA 4\.0 \|/);

    const folder = join(root, 'inbox');
    mkdirSync(folder);
    writeFileSync(join(folder, 'typo.pdf'), buildSyntheticBook().pdf);
    writeFileSync(join(folder, 'typo.meta.json'), JSON.stringify({ licence: { name: 'CC BY 3.0' } }));
    const bad = audit(root, folder, '--out', join(root, 'out2'));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('unknown field "licence" (did you mean "license"?)');
    expect(readFileSync(join(root, 'out2', 'INDEX.md'), 'utf8')).toContain('**NOT RUN**');
    expect(existsSync(join(root, 'out2', 'typo', 'typo-audited.mcbundle'))).toBe(false);

    expect(audit(root).status).toBe(2);
    expect(audit(root, folder).status).toBe(2);
  });
});
