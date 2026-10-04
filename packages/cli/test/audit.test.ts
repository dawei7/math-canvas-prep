import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSyntheticBook } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import { tempDir, type Cli, type Result } from './helpers.js';

/** A folder holding the synthetic book as book.pdf and a runner for the command line in it. */
async function bookWorkspace(): Promise<Cli> {
  const dir = await tempDir();
  await writeFile(join(dir, 'book.pdf'), buildSyntheticBook().pdf);
  const cli = (async (args, opts = {}) => {
    let out = '';
    let err = '';
    const withJson = opts.json === false ? args : [...args, '--json'];
    const code = await run(withJson, {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      stdin: () => Promise.resolve(opts.stdin ?? ''),
      cwd: dir,
      env: { ...opts.env },
    });
    let json: Result['json'] = { ok: false, command: '', result: {} };
    if (opts.json !== false && out.trim().startsWith('{')) json = JSON.parse(out) as Result['json'];
    return { code, stdout: out, stderr: err, json };
  }) as Cli;
  Object.defineProperty(cli, 'dir', { value: dir });
  const made = await cli(['init', 'book.pdf', '--title', 'Synthetic Algebra Workbook']);
  if (made.code !== 0) throw new Error(`init failed: ${made.stdout}${made.stderr}`);
  return cli;
}

interface DerivedEntry {
  id: string;
  label?: string;
  title: string;
  page: number;
  depth: number;
  kind: string;
  confidence: number;
  evidence: string[];
  practice?: { page: number; end: { page: number; why: string } };
}

describe('outline derive --book', () => {
  it('proposes the chapters and sections with ids, labels, tops and the practice sets, and stores nothing', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['outline', 'derive', '--book']);
    expect(done.code).toBe(0);
    const result = done.json.result as { entries: DerivedEntry[]; chapters: number; sections: number; applied: boolean; numbering: { offset: number }; answerKey: { page: number } };
    expect(result.applied).toBe(false);
    expect(result.chapters).toBe(2);
    expect(result.sections).toBe(4);
    expect(result.entries.map((entry) => entry.id)).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'answers']);
    expect(result.entries.find((entry) => entry.id === '1.2')?.title).toBe('Triangles and Ratios');
    expect(result.entries.find((entry) => entry.id === '0.1')?.practice?.end.why).toContain('0.2');
    expect(result.numbering.offset).toBe(1);
    expect(result.answerKey.page).toBeGreaterThan(10);
    expect(done.stdout).not.toBe('');
    const text = await cli(['outline', 'derive', '--book'], { json: false });
    expect(text.stdout).toContain('2 chapters and 4 sections');
    expect(text.stdout).toContain('Triangles and Ratios');
    expect(text.stdout).toContain('Nothing is stored unless you say --apply');
    const outline = await cli(['outline']);
    expect((outline.json.result as { source: string }).source).toBe('none');
  });

  it('stores the proposal as the outline of the project with --apply', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['outline', 'derive', '--book', '--apply']);
    expect(done.code).toBe(0);
    expect((done.json.result as { applied: boolean }).applied).toBe(true);
    const outline = await cli(['outline']);
    const stored = outline.json.result as { source: string; projectSource: string; entries: { title: string; page: number; depth: number }[] };
    expect(stored.source).toBe('project');
    expect(stored.projectSource).toBe('derived');
    expect(stored.entries.map((entry) => entry.title)).toContain('Whole Numbers');
  });

  it('keeps the old behaviour without --book', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['outline', 'derive']);
    expect(done.code).toBe(0);
    expect((done.json.result as { bodyFontSize: number }).bodyFontSize).toBeGreaterThan(0);
    expect(done.json.result).not.toHaveProperty('sections');
  });
});

describe('exercises propose', () => {
  interface SectionSummary {
    section: string;
    count: number;
    first: string | null;
    last: string | null;
    gaps: string[];
    instructions: { text: string; governs: string[] }[];
    notes: string[];
  }
  interface ProposeResult {
    source: string;
    sections: SectionSummary[];
    counts: { sections: number; exercises: number; withSolution: number };
    proposals: { id: string; section: string; label: string; page: number; rect: Record<string, number>; context: unknown[]; evidence: string[] }[];
    operations: Record<string, unknown>[];
    skipped: string[];
    applied: boolean;
    notes: string[];
  }

  it('finds the exercises of every section, with the instruction as context, and writes nothing', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['exercises', 'propose']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as ProposeResult;
    expect(result.source).toBe('derived');
    expect(result.counts).toEqual({ sections: 4, exercises: 112, withSolution: 0 });
    expect(result.sections.map((section) => [section.section, section.count, section.first, section.last])).toEqual([
      ['0.1', 70, '1', '70'],
      ['0.2', 14, '1', '14'],
      ['1.1', 12, '1', '12'],
      ['1.2', 16, '1', '16'],
    ]);
    expect(result.sections.flatMap((section) => section.gaps)).toEqual([]);
    expect(result.sections[1]?.instructions.map((instruction) => instruction.governs.length)).toEqual([6, 8]);
    expect(result.applied).toBe(false);
    expect(result.proposals.length).toBe(112);
    expect(result.proposals[0]?.id).toBe('x0_1-1');
    expect(result.proposals[0]?.context.length).toBe(1);
    expect(result.operations.length).toBe(112);
    expect(result.operations[0]).toMatchObject({ op: 'add', kind: 'exercise', authority: 'book', label: '1', section: '0.1', id: 'x0_1-1' });
    expect(result.notes.join(' ')).toContain('outline derive --book --apply');
    const frames = await cli(['frames', 'list']);
    expect((frames.json.result as { frames: unknown[] }).frames).toEqual([]);
  });

  it('can be limited to sections and writes the operations and the details to files', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['exercises', 'propose', '--section', '0.2,1.1', '--ops', 'ops.json', '--details', 'details.json']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as ProposeResult;
    expect(result.sections.map((section) => section.section)).toEqual(['0.2', '1.1']);
    const ops = JSON.parse(await readFile(join(cli.dir, 'ops.json'), 'utf8')) as { operations: { section: string }[] };
    expect(ops.operations.length).toBe(26);
    expect(new Set(ops.operations.map((op) => op.section))).toEqual(new Set(['0.2', '1.1']));
    const details = JSON.parse(await readFile(join(cli.dir, 'details.json'), 'utf8')) as { proposals: { evidence: string[] }[]; sectionsDetail: { rejected: unknown[] }[] };
    expect(details.proposals.length).toBe(26);
    expect(details.proposals[0]?.evidence.length).toBeGreaterThan(2);
    expect(details.sectionsDetail.length).toBe(2);
    const text = await cli(['exercises', 'propose', '--section', '1.2'], { json: false });
    expect(text.stdout).toContain('16 exercises proposed in 1 section');
  });

  it('takes the answer key along with --solutions and puts the regions into the operations', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['exercises', 'propose', '--solutions']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as ProposeResult;
    expect(result.counts.withSolution).toBe(112);
    expect(result.operations.every((op) => Array.isArray(op['solution']) && (op['solution'] as unknown[]).length >= 1)).toBe(true);
  });

  it('refuses an unknown section, and refuses --apply while the project has no sections of its own', async () => {
    const cli = await bookWorkspace();
    const unknown = await cli(['exercises', 'propose', '--section', '9.9']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.json.error?.message).toContain('There is no section "9.9"');
    const early = await cli(['exercises', 'propose', '--apply']);
    expect(early.code).not.toBe(0);
    expect(early.json.error?.code).toBe('E_NO_SECTIONS');
    expect(early.json.error?.hint).toContain('outline derive --book --apply');
    const frames = await cli(['frames', 'list']);
    expect((frames.json.result as { frames: unknown[] }).frames).toEqual([]);
  });

  it('limits the exercises per section with --max-items', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['exercises', 'propose', '--max-items', '5']);
    const result = done.json.result as unknown as ProposeResult;
    expect(result.counts.exercises).toBe(20);
    expect(result.sections[0]?.notes.join(' ')).toContain('cap of 5');
  });
});

describe('solutions propose', () => {
  it('says that the project has no authoritative exercises to match yet, and still reports what the key holds', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['solutions', 'propose']);
    expect(done.code).toBe(0);
    const result = done.json.result as { counts: { exercises: number; answers: number; matched: number }; operations: unknown[]; notes: string[] };
    expect(result.counts).toMatchObject({ exercises: 0, matched: 0 });
    expect(result.counts.answers).toBe(112);
    expect(result.operations).toEqual([]);
    expect(result.notes.join(' ')).toContain('no authoritative exercises');
    const text = await cli(['solutions', 'propose'], { json: false });
    expect(text.stdout).toContain('112 answers found in the answer key');
    const applied = await cli(['solutions', 'propose', '--apply']);
    expect(applied.code).toBe(0);
    expect((applied.json.result as { applied: boolean }).applied).toBe(false);
  });
});

describe('patterns and words as options', () => {
  it('reads other heading words, and finds no practice set when the words do not occur', async () => {
    const cli = await bookWorkspace();
    const none = await cli(['outline', 'derive', '--book', '--practice-words', 'problems,review']);
    const entries = (none.json.result as { entries: { id: string; practice?: unknown }[] }).entries;
    expect(entries.filter((entry) => entry.id.includes('.')).every((entry) => entry.practice === undefined)).toBe(true);
    const some = await cli(['outline', 'derive', '--book', '--practice-words', 'practice']);
    expect((some.json.result as { entries: { id: string; practice?: unknown }[] }).entries.find((entry) => entry.id === '0.1')?.practice).toBeDefined();
    const empty = await cli(['exercises', 'propose', '--practice-words', 'problems']);
    expect((empty.json.result as { counts: { exercises: number } }).counts.exercises).toBe(0);
  });

  it('reads the numbers of exercises with a pattern of its own', async () => {
    const cli = await bookWorkspace();
    const same = await cli(['exercises', 'propose', '--section', '0.2', '--item-pattern', '^(\\d{1,3})[).]\\s*(.*)$']);
    expect((same.json.result as { counts: { exercises: number } }).counts.exercises).toBe(14);
    const none = await cli(['exercises', 'propose', '--section', '0.2', '--item-pattern', '^Task (\\d+):\\s*(.*)$']);
    expect((none.json.result as { counts: { exercises: number } }).counts.exercises).toBe(0);
    const bad = await cli(['exercises', 'propose', '--item-pattern', '^(unclosed']);
    expect(bad.code).not.toBe(0);
    expect(bad.json.error?.message).toContain('--item-pattern');
    const nogroup = await cli(['exercises', 'propose', '--item-pattern', '^\\d+\\)']);
    expect(nogroup.code).not.toBe(0);
    expect(nogroup.json.error?.message).toContain('no group for the label');
  });

  it('takes the instruction mode as an option and refuses an unknown one', async () => {
    const cli = await bookWorkspace();
    const none = await cli(['exercises', 'propose', '--section', '0.1', '--instructions', 'none']);
    const result = none.json.result as { proposals: { context: unknown[] }[]; sections: { instructions: unknown[] }[] };
    expect(result.proposals.every((proposal) => proposal.context.length === 0)).toBe(true);
    expect(result.sections[0]?.instructions).toEqual([]);
    const bad = await cli(['exercises', 'propose', '--instructions', 'sometimes']);
    expect(bad.code).not.toBe(0);
    expect(bad.json.error?.message).toContain('--instructions must be');
  });
});
