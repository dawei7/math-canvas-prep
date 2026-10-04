import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const bin = new URL('../bin/mcprep.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dist = new URL('../dist/index.js', import.meta.url);
const examples = new URL('../../../examples/workbook/', import.meta.url);
const exampleFile = (name: string): string => new URL(name, examples).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function mcprep(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!existsSync(dist))('the built mcprep binary audits a book as an authority', () => {
  it('files exercises under sections, keeps their labels, refuses to cut them into parts, exports and checks the bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprep-book-bin-'));
    dirs.push(dir);
    copyFileSync(exampleFile('workbook.pdf'), join(dir, 'workbook.pdf'));
    copyFileSync(exampleFile('workbook-batch.json'), join(dir, 'batch.json'));
    expect(mcprep(dir, 'init', 'workbook.pdf', '--title', 'Binary book test').status).toBe(0);
    expect(mcprep(dir, 'book', 'meta', '--author', 'A. Author', '--license-name', 'CC BY 3.0', '--notice', 'Attribution: A. Author.').status).toBe(0);
    expect(mcprep(dir, 'outline', 'pdf', '--adopt').status).toBe(0);
    expect(mcprep(dir, 'outline', 'ids').status).toBe(0);
    expect(mcprep(dir, 'exercises', 'add', '--section', '1.1', '--label', '1', '--page', '0', '--rect', '0.1,0.3314,0.9,0.3504', '--solution', '3:0.1,0.177,0.9,0.196').status).toBe(0);
    const applied = mcprep(dir, 'frames', 'apply', 'batch.json', '--json');
    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe('');
    expect(JSON.parse(applied.stdout)).toMatchObject({ ok: true, result: { applied: true, counts: { exercise: 0 }, book: { exercises: 10, withSolution: 10 } } });

    const again = mcprep(dir, 'frames', 'apply', 'batch.json', '--json');
    expect(again.status).toBe(4);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: false, error: { code: 'E_DUPLICATE_EXERCISE' } });
    const split = mcprep(dir, 'frames', 'split', '1.1:3a', '--at', '0.5', '--json');
    expect(split.status).toBe(4);
    expect(JSON.parse(split.stdout)).toMatchObject({ ok: false, error: { code: 'E_AUTHORITY' } });

    const listed = JSON.parse(mcprep(dir, 'exercises', 'list', '--section', '1.1', '--json').stdout) as { result: { exercises: { reference: string }[] } };
    expect(listed.result.exercises.map((entry) => entry.reference)).toEqual(['1.1:1', '1.1:2', '1.1:3a', '1.1:3b']);
    const shown = JSON.parse(mcprep(dir, 'book', 'show', '--json').stdout) as { result: { format: string; totals: { exercises: number; sections: number } } };
    expect(shown.result).toMatchObject({ format: 'math-canvas-book-summary', totals: { exercises: 10, sections: 6 } });
    expect(mcprep(dir, 'validate').status).toBe(0);

    const exported = mcprep(dir, 'export', '--json');
    expect(exported.status).toBe(0);
    const result = (JSON.parse(exported.stdout) as { result: { path: string; manifest: { features: string[]; generator: { version: string }; document: { author: string } } } }).result;
    expect(result.manifest.features).toEqual(['sections', 'authority', 'solution']);
    expect(result.manifest.document.author).toBe('A. Author');
    expect(result.manifest.generator.version).toMatch(/^0\.2\./);
    expect(mcprep(dir, 'import-check', result.path).status).toBe(0);
    const inspected = mcprep(dir, 'inspect-bundle', result.path);
    expect(inspected.status).toBe(0);
    expect(inspected.stdout).toContain('1.1:3a');

    const summary = mcprep(dir, 'book', 'export', '--out', 'summary.json', '--json');
    expect(summary.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))).toMatchObject({ format: 'math-canvas-book-summary', totals: { exercises: 10 } });
    const schema = mcprep(dir, 'schema', 'book-summary', '--json');
    expect(schema.status).toBe(0);
    expect(JSON.parse(schema.stdout)).toMatchObject({ ok: true, result: { name: 'book-summary' } });
  });
});
