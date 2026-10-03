import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspace, type Cli } from './helpers.js';

const labels = async (cli: Cli): Promise<Record<string, string>> => {
  const list = await cli(['frames', 'list']);
  return Object.fromEntries((list.json.result.frames as { id: string; label: string }[]).map((frame) => [frame.id, frame.label]));
};

describe('frames add, list, update, move, delete', () => {
  it('adds frames with generated ids and lists them with computed labels in reading order', async () => {
    const cli = await workspace();
    const first = await cli(['frames', 'add', '--kind', 'exercise', '--page', '1', '--rect', '0.1,0.2,0.9,0.3']);
    expect(first.code).toBe(0);
    expect(first.json.result).toMatchObject({ applied: true, created: ['f1'], counts: { exercise: 1 } });
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.2,0.9,0.3']);
    await cli(['frames', 'add', '--kind', 'question', '--page', '0', '--rect', '0.1,0.4,0.9,0.5']);
    await cli(['frames', 'add', '--kind', 'bookmark', '--page', '2', '--rect', '0.1,0.4,0.9,0.5']);
    expect(await labels(cli)).toEqual({ f2: 'E1', f3: 'Q1', f1: 'E2', f4: 'B1' });
    const page = await cli(['frames', 'list', '--page', '0']);
    expect((page.json.result.frames as unknown[]).length).toBe(2);
    expect(((await cli(['frames', 'list', '--kind', 'bookmark'])).json.result.frames as unknown[]).length).toBe(1);
    const text = await cli(['frames', 'list'], { json: false });
    expect(text.stdout).toContain('E2');
    expect(text.stdout).toContain('rect (left,top,right,bottom)');
  });

  it('takes context and continuation regions, a custom id, and enlarges a tiny rect with a note', async () => {
    const cli = await workspace();
    const added = await cli(['frames', 'add', '--kind', 'exercise', '--page', '1', '--rect', '0.1,0.7,0.9,0.8', '--id', 'ex-a', '--context', '0:0.1,0.1,0.9,0.15', '--continues', '2:0.1,0.1,0.9,0.15']);
    expect(added.code).toBe(0);
    expect(added.json.result.frames).toMatchObject([{ id: 'ex-a', context: 1, continues: 1 }]);
    const tiny = await cli(['frames', 'add', '--kind', 'bookmark', '--page', '0', '--rect', '0.5,0.5,0.505,0.502']);
    expect(tiny.json.notes?.join(' ')).toContain('enlarged');
    expect((await cli(['frames', 'add', '--kind', 'bookmark', '--page', '0', '--rect', '0.5,0.5,0.505,0.502', '--no-enlarge'])).code).toBe(4);
  });

  it('refuses what is not a valid frame, with exit code 4 and a hint', async () => {
    const cli = await workspace();
    const far = await cli(['frames', 'add', '--kind', 'exercise', '--page', '9', '--rect', '0.1,0.2,0.9,0.3']);
    expect(far.code).toBe(4);
    expect(far.json.error).toMatchObject({ code: 'E_PAGE' });
    const percent = await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '10,20,90,30']);
    expect(percent.json.error).toMatchObject({ code: 'E_RECT_RANGE' });
    expect(percent.json.error?.hint).toContain('fractions');
    const inverted = await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.9,0.2,0.1,0.3']);
    expect(inverted.json.error?.code).toBe('E_RECT_ORDER');
    expect((await cli(['frames', 'add', '--kind', 'note', '--page', '0', '--rect', '0.1,0.2,0.9,0.3'])).code).toBe(2);
    expect((await cli(['frames', 'add', '--page', '0', '--rect', '0.1,0.2,0.9,0.3'])).code).toBe(2);
    expect((await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', 'garbage'])).json.error?.code).toBe('E_RECT');
    expect((await cli(['frames', 'list'])).json.result.frames).toEqual([]);
  });

  it('updates, moves (also by a negative distance) and deletes', async () => {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.2,0.9,0.3']);
    const moved = await cli(['frames', 'move', 'f1', '--dy', '-0.05']);
    expect(moved.json.result.frames).toMatchObject([{ id: 'f1', rect: { top: 0.15, bottom: 0.25 } }]);
    const updated = await cli(['frames', 'update', 'f1', '--rect', '0.2,0.1,0.8,0.3', '--kind', 'question']);
    expect(updated.json.result.frames).toMatchObject([{ id: 'f1', kind: 'question', rect: { left: 0.2 } }]);
    expect((await cli(['frames', 'update', 'f1'])).code).toBe(2);
    expect((await cli(['frames', 'update', 'nope', '--page', '1'])).json.error?.code).toBe('E_NO_FRAME');
    expect((await cli(['frames', 'move', 'f1'])).code).toBe(2);
    const deleted = await cli(['frames', 'delete', 'f1']);
    expect(deleted.json.result).toMatchObject({ removed: ['f1'] });
    expect((await cli(['frames', 'delete', 'f1'])).code).toBe(4);
  });

  it('snaps to the printed lines with --snap and says what it did', async () => {
    const cli = await workspace();
    const lines = (await cli(['lines', '0'])).json.result.lines as { text: string; rect: { top: number; bottom: number } }[];
    const first = lines.find((line) => line.text.startsWith('Exercise 1.'));
    const second = lines.find((line) => line.text.startsWith('it at x = 2.'));
    const top = (first?.rect.top ?? 0) + 0.004;
    const bottom = (second?.rect.top ?? 0) + 0.01;
    const added = await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', `0.1,${top},0.9,${bottom}`, '--snap']);
    expect(added.code).toBe(0);
    expect(added.json.notes?.length).toBeGreaterThanOrEqual(2);
    const rect = (added.json.result.frames as { rect: { top: number; bottom: number } }[])[0]?.rect;
    expect(rect?.top).toBeCloseTo((first?.rect.top ?? 0) - 0.006, 3);
    expect(rect?.bottom).toBeCloseTo((second?.rect.bottom ?? 0) + 0.004, 3);
    expect((added.json.warnings ?? []).length).toBe(0);
  });

  it('does not write on --dry-run and refuses changes that introduce errors unless --force', async () => {
    const cli = await workspace();
    const before = await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8');
    const dry = await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.2,0.9,0.3', '--dry-run']);
    expect(dry.json.result).toMatchObject({ applied: false, dryRun: true, created: ['f1'] });
    expect(await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8')).toBe(before);

    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.2,0.9,0.3', '--unit', 'u1']);
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.3,0.9,0.4', '--unit', 'u1']);
    const afterGood = await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8');
    const gap = await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.45,0.9,0.5', '--unit', 'u1']);
    expect(gap.code).toBe(4);
    expect(gap.json.error?.code).toBe('E_REJECTED');
    expect(gap.json.error?.issues?.[0]).toMatchObject({ code: 'unit-gap' });
    expect(await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8')).toBe(afterGood);
    const forced = await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.45,0.9,0.5', '--unit', 'u1', '--force']);
    expect(forced.code).toBe(0);
    expect((forced.json.result.validation as { ok: boolean }).ok).toBe(false);
    const invalid = await cli(['validate']);
    expect(invalid.code).toBe(4);
    expect(invalid.json.ok).toBe(false);
  });
});

describe('parts: split, merge, dividers, area', () => {
  async function exercise(): Promise<Cli> {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.2,0.9,0.6']);
    return cli;
  }

  it('cuts an exercise into parts that tile and are numbered E1.1, E1.2, E1.3', async () => {
    const cli = await exercise();
    const split = await cli(['frames', 'split', 'f1', '--at', '0.3,0.45']);
    expect(split.code).toBe(0);
    expect(split.json.result.created).toEqual(['f3', 'f4']);
    expect(await labels(cli)).toEqual({ f1: 'E1.1', f3: 'E1.2', f4: 'E1.3' });
    expect((await cli(['validate', '--no-text'])).json.result.ok).toBe(true);
  });

  it('makes the statement above the first part context when --first is given', async () => {
    const cli = await exercise();
    const split = await cli(['frames', 'split', 'f1', '--first', '0.3', '--at', '0.45', '--preamble', 'context']);
    expect(split.code).toBe(0);
    expect(split.json.result.frames).toMatchObject([{ id: 'f1', context: 1, rect: { top: 0.3 } }, { id: 'f3' }]);
    expect((await cli(['frames', 'split', 'f1', '--at', '0.4', '--first', '0.25'])).code).toBe(4);
  });

  it('refuses a divider that leaves a sliver and a missing --at', async () => {
    const cli = await exercise();
    const sliver = await cli(['frames', 'split', 'f1', '--at', '0.205']);
    expect(sliver.code).toBe(4);
    expect(sliver.json.error?.code).toBe('E_SPLIT');
    expect(sliver.json.error?.hint).toContain('Choose a divider');
    expect((await cli(['frames', 'split', 'f1'])).code).toBe(2);
  });

  it('moves the cuts, adds and removes parts, merges them back and resizes the area', async () => {
    const cli = await exercise();
    await cli(['frames', 'split', 'f1', '--at', '0.3,0.45']);
    const moved = await cli(['frames', 'dividers', 'f1', '--at', '0.35,0.5']);
    expect(moved.code).toBe(0);
    const more = await cli(['frames', 'dividers', 'f1', '--at', '0.3,0.4,0.5']);
    expect(more.json.result.created).toHaveLength(1);
    const area = await cli(['frames', 'area', 'f1', '--rect', '0.05,0.15,0.95,0.7']);
    expect(area.code).toBe(0);
    expect(((area.json.result.frames as { rect: { left: number } }[])[0] as { rect: { left: number } }).rect.left).toBe(0.05);
    expect((await cli(['frames', 'update', 'f3', '--rect', '0.1,0.3,0.9,0.4'])).json.error?.code).toBe('E_UNIT_PART');
    const merged = await cli(['frames', 'merge', 'f1', 'f3']);
    expect(merged.code).toBe(0);
    const unit = ((await cli(['frames', 'list'])).json.result.frames as { unit?: string }[]).find((frame) => frame.unit)?.unit as string;
    expect((await cli(['frames', 'merge', '--unit', unit])).code).toBe(0);
    expect(((await cli(['frames', 'list'])).json.result.frames as unknown[]).length).toBe(1);
    expect((await cli(['frames', 'merge', 'f1'])).code).toBe(2);
  });

  it('deletes a unit with --unit', async () => {
    const cli = await exercise();
    await cli(['frames', 'split', 'f1', '--at', '0.3,0.45']);
    const listed = (await cli(['frames', 'list'])).json.result.frames as { unit?: string }[];
    const unit = listed.find((frame) => frame.unit)?.unit as string;
    const deleted = await cli(['frames', 'delete', unit, '--unit']);
    expect(deleted.json.result.removed).toHaveLength(3);
  });
});

describe('context and continues', () => {
  it('attaches and removes context, and continuation regions', async () => {
    const cli = await workspace();
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '1', '--rect', '0.1,0.3,0.9,0.4']);
    const added = await cli(['context', 'add', 'f1', '--page', '1', '--rect', '0.1,0.11,0.9,0.18', '--snap']);
    expect(added.code).toBe(0);
    expect(added.json.result.frames).toMatchObject([{ id: 'f1', context: 1 }]);
    const removed = await cli(['context', 'remove', 'f1']);
    expect(removed.code).toBe(0);
    expect((await cli(['context', 'remove', 'f1'])).code).toBe(4);
    const cont = await cli(['continues', 'add', 'f1', '--page', '2', '--rect', '0.1,0.09,0.9,0.12']);
    expect(cont.json.result.frames).toMatchObject([{ id: 'f1', continues: 1 }]);
    expect((await cli(['continues', 'remove', 'f1'])).code).toBe(0);
    await cli(['frames', 'add', '--kind', 'question', '--page', '0', '--rect', '0.1,0.5,0.9,0.6']);
    expect((await cli(['context', 'add', 'f2', '--page', '1', '--rect', '0.1,0.11,0.9,0.18'])).json.error?.code).toBe('E_CONTEXT');
    expect((await cli(['context', 'add', 'f1', '--rect', '0.1,0.11,0.9,0.18'])).code).toBe(2);
  });
});

describe('frames apply: a whole sheet in one call', () => {
  const batch = {
    operations: [
      { op: 'add', ref: 'a', kind: 'exercise', page: 0, rect: [0.1, 0.22, 0.9, 0.29] },
      { op: 'add', ref: 'b', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.5] },
      { op: 'split', id: '@b', at: [0.4], first: 0.34, preamble: 'context' },
      { op: 'add', kind: 'bookmark', page: 2, rect: [0.1, 0.2, 0.9, 0.26] },
      { op: 'meta.set', title: 'Batch title' },
    ],
  };

  it('applies the operations from a file or from standard input, with references', async () => {
    const cli = await workspace();
    await writeFile(join(cli.dir, 'batch.json'), JSON.stringify(batch));
    const applied = await cli(['frames', 'apply', 'batch.json']);
    expect(applied.code).toBe(0);
    expect(applied.json.result.created).toEqual(['f1', 'f2', 'f4', 'f5']);
    expect((applied.json.result.steps as unknown[]).length).toBe(5);
    expect((await cli(['meta'])).json.result.title).toBe('Batch title');
    const fresh = await workspace();
    const piped = await fresh(['frames', 'apply', '-'], { stdin: JSON.stringify(batch.operations) });
    expect(piped.code).toBe(0);
  });

  it('is atomic: one bad operation, or one new error, and nothing is written', async () => {
    const cli = await workspace();
    const before = await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8');
    const bad = await cli(['frames', 'apply', '-'], { stdin: JSON.stringify([...batch.operations.slice(0, 2), { op: 'add', kind: 'exercise', page: 7, rect: [0.1, 0.2, 0.9, 0.3] }]) });
    expect(bad.code).toBe(4);
    expect(bad.json.error?.message).toContain('Operation 2');
    expect(await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8')).toBe(before);
    const gap = await cli(['frames', 'apply', '-'], { stdin: JSON.stringify([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.3], unit: 'u1' }, { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.4, 0.9, 0.5], unit: 'u1' }]) });
    expect(gap.json.error?.code).toBe('E_REJECTED');
    expect(await readFile(join(cli.dir, 'sheet.mcprep.json'), 'utf8')).toBe(before);
    expect((await cli(['frames', 'apply', '-'], { stdin: '{oops' })).code).toBe(2);
    expect((await cli(['frames', 'apply', '-'], { stdin: '{"nothing": 1}' })).code).toBe(2);
    expect((await cli(['frames', 'apply', 'missing.json'])).code).toBe(3);
    expect((await cli(['frames', 'apply', '-'], { stdin: JSON.stringify([{ op: 'delete', id: '@nope' }]) })).json.error?.code).toBe('E_REF');
  });
});
