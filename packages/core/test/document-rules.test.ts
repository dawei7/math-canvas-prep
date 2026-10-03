import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLE_TARGET, VERSION } from '../src/version.js';
import { checkTitle, cleanFolder, folderFromInput, titleFromFileName } from '../src/rules/document.js';
import { checkOutline, cleanTitle, normalizeOutline } from '../src/rules/outline.js';

describe('version', () => {
  it('equals the version in package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(manifest.version);
    expect(BUNDLE_TARGET).toBe('math-canvas-bundle/1');
  });
});

describe('title and folder', () => {
  it('trims the title and checks its length', () => {
    expect(checkTitle('  Analysis  ')).toEqual({ title: 'Analysis' });
    expect(checkTitle('   ').problem).toContain('empty');
    expect(checkTitle('x'.repeat(201)).problem).toContain('200');
    expect(checkTitle('x'.repeat(200)).title).toHaveLength(200);
  });

  it('makes a title from a file name', () => {
    expect(titleFromFileName('C:\\books\\Analysis_1 sheet 3.pdf')).toBe('Analysis 1 sheet 3');
    expect(titleFromFileName('/home/me/ex.sheet.PDF')).toBe('ex.sheet');
    expect(titleFromFileName('.pdf')).toBe('Imported document');
  });

  it('cleans a folder the way a reader does', () => {
    expect(cleanFolder(undefined)).toEqual({ folder: undefined, repairs: [] });
    expect(cleanFolder('A/B/C')).toEqual({ folder: 'A/B/C', repairs: [] });
    expect(cleanFolder(' A / B ').folder).toBe('A/B');
    expect(cleanFolder('A//B').folder).toBe('A/B');
    expect(cleanFolder('/').folder).toBeUndefined();
    expect(cleanFolder('A\u0000B/C\u001f').folder).toBe('AB/C');
    expect(cleanFolder('1/2/3/4/5/6/7/8/9').folder).toBe('1/2/3/4/5/6/7');
    expect(cleanFolder(`${'x'.repeat(61)}/y`).folder).toBe(`${'x'.repeat(60)}/y`);
    expect(cleanFolder('a/b/c/d/e/f/g/h').repairs.join(' ')).toContain('7th');
  });

  it('takes a backslash as a separator in authoring input', () => {
    expect(folderFromInput('Uni\\Analysis/Sheets')).toBe('Uni/Analysis/Sheets');
  });
});

describe('outline rules', () => {
  it('cleans titles', () => {
    expect(cleanTitle('  1\u0000  Sets\n and\tmaps ')).toBe('1 Sets and maps');
  });

  it('checks entries and clamps depth jumps', () => {
    const ok = checkOutline([{ title: 'a', page: 0, depth: 0 }, { title: 'b', page: 1, depth: 1 }], 2);
    expect(ok.issues).toEqual([]);
    expect(ok.entries).toHaveLength(2);
    expect(checkOutline([{ title: 'a', page: 0, depth: 2 }], 2).entries[0]?.depth).toBe(0);
    expect(checkOutline('x', 2).issues[0]?.code).toBe('outline-not-array');
    expect(checkOutline([5], 2).issues[0]?.code).toBe('outline-bad-entry');
    expect(checkOutline([{ title: 'a', page: 2, depth: 0 }], 2).issues[0]?.code).toBe('outline-bad-page');
    expect(checkOutline([{ title: 'a'.repeat(201), page: 0, depth: 0 }], 2).issues[0]?.code).toBe('outline-bad-title');
    expect(checkOutline([{ title: 'a', page: 0, depth: 1.5 }], 2).issues[0]?.code).toBe('outline-bad-depth');
  });

  it('normalises entries before they are stored', () => {
    const result = normalizeOutline(
      [
        { title: '  Intro ', page: 0, depth: 0 },
        { title: '   ', page: 0, depth: 0 },
        { title: 'x'.repeat(300), page: 99, depth: 5 },
        { title: 'Back', page: -4, depth: -1 },
      ],
      3,
    );
    expect(result.map((entry) => [entry.page, entry.depth])).toEqual([[0, 0], [2, 1], [0, 0]]);
    expect(result[1]?.title).toHaveLength(200);
  });
});
