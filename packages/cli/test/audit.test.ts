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
    expect(result.entries.map((entry) => entry.id)).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'Answers']);
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
    counts: { sections: number; exercises: number; withSolution: number; added: number; unchanged: number; solutionsAdded: number; changed: number; replaced: number };
    proposals: { id: string; section: string; label: string; page: number; rect: Record<string, number>; context: unknown[]; evidence: string[] }[];
    operations: Record<string, unknown>[];
    changed: string[];
    notProposed: string[];
    refused: string[];
    applied: boolean;
    notes: string[];
  }

  it('finds the exercises of every section, with the instruction as context, and writes nothing', async () => {
    const cli = await bookWorkspace();
    const done = await cli(['exercises', 'propose']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as ProposeResult;
    expect(result.source).toBe('derived');
    expect(result.counts).toEqual({ sections: 4, exercises: 112, withSolution: 0, added: 112, unchanged: 0, solutionsAdded: 0, changed: 0, replaced: 0 });
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
    // The frame gets its own id when it is applied and is named SECTION:LABEL afterwards.
    expect(result.operations[0]).toMatchObject({ op: 'add', authority: 'book', label: '1', section: '0.1' });
    expect(result.operations[0]).not.toHaveProperty('id');
    expect(result.operations[0]).not.toHaveProperty('ref');
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

  it('takes the project\'s own outline when it has one, and says where the sections came from', async () => {
    const cli = await bookWorkspace();
    expect(((await cli(['exercises', 'propose'])).json.result as unknown as ProposeResult).source).toBe('derived');
    await cli(['outline', 'derive', '--book', '--apply']);
    const done = await cli(['exercises', 'propose', '--section', '1.2']);
    const result = done.json.result as unknown as ProposeResult;
    expect(result.source).toBe('project');
    expect(result.counts.exercises).toBe(16);
    expect(result.notes.join(' ')).not.toContain('derived now');
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

describe('applying the proposals', () => {
  interface Report {
    applied: boolean;
    dryRun?: boolean;
    created: string[];
    replaced: string[];
    changed: string[];
    counts: { exercises: number; withSolution: number; added: number; unchanged: number; solutionsAdded: number; changed: number; replaced: number };
    book: { exercises: number; withSolution: number };
    validation: { ok: boolean; errors: unknown[] };
    operations?: { op: string; id?: string }[];
  }

  /** A project that has the sections of the book stored, as `outline derive --book --apply` leaves it. */
  async function withSections(): Promise<Cli> {
    const cli = await bookWorkspace();
    const derived = await cli(['outline', 'derive', '--book', '--apply']);
    expect(derived.code).toBe(0);
    return cli;
  }

  const frameCount = async (cli: Cli): Promise<number> => ((await cli(['frames', 'list'])).json.result as { frames: unknown[] }).frames.length;
  const stored = async (cli: Cli, reference: string): Promise<{ id: string; page: number; rect: Record<string, number>; solution: number } | undefined> =>
    ((await cli(['exercises', 'list'])).json.result as { exercises: { id: string; reference: string; page: number; rect: Record<string, number>; solution: number }[] }).exercises.find((entry) => entry.reference === reference);

  it('stores the exercises with their solutions as one batch that validates, and names them SECTION:LABEL', async () => {
    const cli = await withSections();
    const done = await cli(['exercises', 'propose', '--solutions', '--apply']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as Report;
    expect(result.applied).toBe(true);
    expect(result.created).toHaveLength(112);
    expect(result.counts).toMatchObject({ exercises: 112, withSolution: 112, added: 112, unchanged: 0 });
    expect(result.book).toEqual({ exercises: 112, withSolution: 112 });
    expect(result.validation.errors).toEqual([]);
    expect(await frameCount(cli)).toBe(112);
    const five = await stored(cli, '0.1:5');
    expect(five?.solution).toBe(1);
    const summary = await cli(['book', 'show']);
    const sections = (summary.json.result as { sections: { id: string; exercises: number; withSolution: number; firstLabel?: string; lastLabel?: string }[] }).sections;
    expect(sections.filter((entry) => entry.exercises > 0).map((entry) => [entry.id, entry.exercises, entry.withSolution, entry.firstLabel, entry.lastLabel])).toEqual([
      ['0.1', 70, 70, '1', '70'],
      ['0.2', 14, 14, '1', '14'],
      ['1.1', 12, 12, '1', '12'],
      ['1.2', 16, 16, '1', '16'],
    ]);
    const text = await cli(['validate'], { json: false });
    expect(text.code).toBe(0);
  });

  it('can be repeated: what the project has is skipped and nothing is written', async () => {
    const cli = await withSections();
    await cli(['exercises', 'propose', '--solutions', '--apply']);
    const again = await cli(['exercises', 'propose', '--solutions', '--apply']);
    expect(again.code).toBe(0);
    const result = again.json.result as unknown as Report;
    expect(result.applied).toBe(false);
    expect(result.counts).toMatchObject({ added: 0, unchanged: 112, solutionsAdded: 0, changed: 0 });
    expect(result.operations).toEqual([]);
    expect(await frameCount(cli)).toBe(112);
    const text = await cli(['exercises', 'propose', '--solutions', '--apply'], { json: false });
    expect(text.stdout).toContain('The project has 112 of them already: 112 the same');
    expect(text.stdout).toContain('Nothing to apply');
  });

  it('adds only what is missing when the proposal is applied to a part of the book first', async () => {
    const cli = await withSections();
    const part = await cli(['exercises', 'propose', '--section', '0.2', '--apply']);
    expect((part.json.result as unknown as Report).created).toHaveLength(14);
    const rest = await cli(['exercises', 'propose', '--apply']);
    const result = rest.json.result as unknown as Report;
    expect(result.counts).toMatchObject({ exercises: 112, added: 98, unchanged: 14 });
    expect(result.created).toHaveLength(98);
    expect(await frameCount(cli)).toBe(112);
  });

  it('keeps an exercise that was corrected by hand and overwrites it in place with --replace', async () => {
    const cli = await withSections();
    await cli(['exercises', 'propose', '--solutions', '--apply']);
    const before = await stored(cli, '0.1:5');
    expect(before).toBeDefined();
    const moved = await cli(['frames', 'update', '0.1:5', '--rect', '0.13,0.25,0.3,0.27']);
    expect(moved.code).toBe(0);
    const kept = await cli(['exercises', 'propose', '--solutions', '--apply']);
    const keptResult = kept.json.result as unknown as Report;
    expect(keptResult.applied).toBe(false);
    expect(keptResult.changed).toEqual(['0.1:5']);
    expect(keptResult.counts).toMatchObject({ unchanged: 111, changed: 1, replaced: 0, added: 0 });
    expect((await stored(cli, '0.1:5'))?.rect['right']).toBe(0.3);
    const text = await cli(['exercises', 'propose', '--solutions'], { json: false });
    expect(text.stdout).toContain('1 different (kept as they are; --replace overwrites them)');
    expect(text.stdout).toContain('Different from the project\'s own frames (kept): 0.1:5.');

    const replaced = await cli(['exercises', 'propose', '--solutions', '--replace', '--apply']);
    expect(replaced.code).toBe(0);
    const result = replaced.json.result as unknown as Report;
    expect(result.applied).toBe(true);
    expect(result.replaced).toEqual([before?.id]);
    expect(result.created).toEqual([]);
    expect(result.counts).toMatchObject({ changed: 1, replaced: 1 });
    const after = await stored(cli, '0.1:5');
    expect(after?.id).toBe(before?.id);
    expect(after?.rect).toEqual(before?.rect);
    expect(after?.solution).toBe(1);
    expect(await frameCount(cli)).toBe(112);
  });

  it('gives exercises that were stored without answers their solution later, with either command', async () => {
    const cli = await withSections();
    const first = await cli(['exercises', 'propose', '--apply']);
    expect((first.json.result as unknown as Report).book).toEqual({ exercises: 112, withSolution: 0 });
    const withAnswers = await cli(['exercises', 'propose', '--section', '1.1', '--solutions', '--apply']);
    const result = withAnswers.json.result as unknown as Report;
    expect(result.counts).toMatchObject({ added: 0, unchanged: 0, solutionsAdded: 12, changed: 0 });
    expect(result.book).toEqual({ exercises: 112, withSolution: 12 });
    expect(result.created).toEqual([]);

    const proposed = await cli(['solutions', 'propose']);
    const proposal = proposed.json.result as { counts: { exercises: number; answers: number; matched: number; added: number; unchanged: number; changed: number }; operations: { op: string; id: string; regions: unknown[] }[]; applied: boolean };
    expect(proposal.applied).toBe(false);
    expect(proposal.counts).toMatchObject({ exercises: 112, answers: 112, matched: 112, added: 100, unchanged: 12, changed: 0 });
    // One solution.set per exercise, named SECTION:LABEL.
    expect(proposal.operations).toHaveLength(100);
    expect(proposal.operations[0]).toMatchObject({ op: 'solution.set', id: '0.1:1' });
    expect(proposal.operations.every((op) => op.regions.length >= 1)).toBe(true);

    const applied = await cli(['solutions', 'propose', '--apply']);
    expect(applied.code).toBe(0);
    expect((applied.json.result as unknown as Report).book).toEqual({ exercises: 112, withSolution: 112 });
    expect((applied.json.result as unknown as Report).validation.errors).toEqual([]);
    const again = await cli(['solutions', 'propose', '--apply']);
    expect((again.json.result as { applied: boolean; counts: { unchanged: number; added: number } }).applied).toBe(false);
    expect((again.json.result as { counts: { unchanged: number; added: number } }).counts).toMatchObject({ unchanged: 112, added: 0 });
    expect((await cli(['solutions', 'propose', '--apply'], { json: false })).stdout).toContain('Nothing to apply');
  });

  it('keeps a solution that was changed by hand unless --replace says to overwrite it', async () => {
    const cli = await withSections();
    await cli(['exercises', 'propose', '--solutions', '--apply']);
    const before = await cli(['solution', 'list']);
    const five = (before.json.result as { solutions: { reference: string; regions: { page: number; rect: Record<string, number> }[] }[] }).solutions.find((entry) => entry.reference === '0.1:5');
    expect(five?.regions).toHaveLength(1);
    await cli(['solution', 'remove', '0.1:5', '--all']);
    await cli(['solution', 'add', '0.1:5', '--page', String(five?.regions[0]?.page), '--rect', '0.5,0.6,0.7,0.62']);
    const kept = await cli(['solutions', 'propose', '--apply']);
    const keptResult = kept.json.result as { applied: boolean; changed: string[]; counts: { changed: number; unchanged: number } };
    expect(keptResult.applied).toBe(false);
    expect(keptResult.changed).toEqual(['0.1:5']);
    expect(keptResult.counts).toMatchObject({ changed: 1, unchanged: 111 });
    const replaced = await cli(['solutions', 'propose', '--replace', '--apply']);
    expect(replaced.code).toBe(0);
    expect((replaced.json.result as { applied: boolean }).applied).toBe(true);
    const after = await cli(['solution', 'list']);
    const restored = (after.json.result as { solutions: { reference: string; regions: { page: number; rect: Record<string, number> }[] }[] }).solutions.find((entry) => entry.reference === '0.1:5');
    expect(restored?.regions).toEqual(five?.regions.map((entry) => ({ ...entry })));
  });

  it('shows what it would do with --dry-run and writes nothing', async () => {
    const cli = await withSections();
    const dry = await cli(['exercises', 'propose', '--solutions', '--apply', '--dry-run']);
    expect(dry.code).toBe(0);
    const result = dry.json.result as unknown as Report;
    expect(result.applied).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.book).toEqual({ exercises: 112, withSolution: 112 });
    expect(await frameCount(cli)).toBe(0);
  });

  it('leaves a project that is a book to export: the bundle carries the sections, the exercises and the hidden solutions', async () => {
    const cli = await withSections();
    await cli(['exercises', 'propose', '--solutions', '--apply']);
    await cli(['book', 'meta', '--author', 'A. Author', '--license-name', 'CC BY 3.0', '--license-url', 'https://creativecommons.org/licenses/by/3.0/', '--notice', 'Attribution: A. Author.']);
    const out = join(cli.dir, 'audited.mcbundle');
    const exported = await cli(['export', '--out', out]);
    expect(exported.code).toBe(0);
    expect(exported.json.result).toMatchObject({ book: { exercises: 112, withSolution: 112 }, counts: { frames: 112, outlineEntries: 7 }, importCheck: { ok: true } });
    const check = await cli(['import-check', out]);
    expect(check.json.result).toMatchObject({ wouldImport: true, features: ['sections', 'authority', 'solution'] });
  });

  it('says that deriving the sections again replaces the stored outline, and the exercises stay in their sections', async () => {
    const cli = await withSections();
    await cli(['exercises', 'propose', '--apply']);
    const again = await cli(['outline', 'derive', '--book', '--apply'], { json: false });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('The outline the project had (7 entries) is replaced');
    expect(await frameCount(cli)).toBe(112);
    const summary = await cli(['book', 'show']);
    expect((summary.json.result as { totals: { exercises: number } }).totals.exercises).toBe(112);
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
