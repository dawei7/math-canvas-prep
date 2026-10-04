import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addOperations, bookWorkspace, sample } from './book-helpers.js';

const rect = '0.1,0.3,0.9,0.35';

describe('exercises add, list, mark, unmark, label and section', () => {
  it('adds a book exercise that is named by its label and section, with no positional number', async () => {
    const cli = await bookWorkspace({ sections: true });
    const added = await cli(['exercises', 'add', '--section', '1.1', '--label', '5a', '--page', '0', '--rect', rect]);
    expect(added.code).toBe(0);
    expect(added.json.result).toMatchObject({
      created: ['f1'],
      frames: [{ id: 'f1', label: '5a', kind: 'exercise', authority: 'book', section: '1.1', reference: '1.1:5a' }],
      counts: { exercise: 0, question: 0, bookmark: 0 },
      book: { exercises: 1, withSolution: 0 },
    });
    expect(added.json.result.validation).toMatchObject({ ok: true, errors: [] });
    const text = (await cli(['exercises', 'add', '--section', '1.1', '--label', '6.', '--page', '0', '--rect', '0.1,0.4,0.9,0.45'], { json: false })).stdout;
    expect(text).toContain('1.1:6');
    expect(text).toContain('book');
    expect(text).toContain('note: ');
    expect(text).toContain('2 book exercises');
    const frames = (await cli(['frames', 'list'])).json.result;
    expect(frames).toMatchObject({ counts: { exercise: 0 }, book: { exercises: 2, withSolution: 0 } });
    expect((frames.frames as { label: string }[]).map((entry) => entry.label)).toEqual(['5a', '6']);
  });

  it('is the same as frames add with an authority, and refuses what is incomplete', async () => {
    const cli = await bookWorkspace({ sections: true });
    const added = await cli(['frames', 'add', '--kind', 'exercise', '--authority', 'book', '--label', '5a', '--section', '1.1', '--page', '0', '--rect', rect, '--solution', '3:0.1,0.1,0.9,0.15']);
    expect(added.code).toBe(0);
    expect(added.json.result.frames).toMatchObject([{ label: '5a', authority: 'book', solution: 1 }]);
    const noLabel = await cli(['frames', 'add', '--kind', 'exercise', '--authority', 'book', '--section', '1.1', '--page', '0', '--rect', '0.1,0.5,0.9,0.55']);
    expect(noLabel.code).toBe(2);
    expect(noLabel.json.error?.message).toContain('--label');
    const noSection = await cli(['exercises', 'add', '--label', '5b', '--page', '0', '--rect', rect]);
    expect(noSection.code).toBe(2);
    const stray = await cli(['frames', 'add', '--kind', 'exercise', '--label', '5b', '--page', '0', '--rect', rect]);
    expect(stray.code).toBe(2);
    expect(stray.json.error?.hint).toBeUndefined();
    expect(stray.json.error?.message).toContain('--authority book');
    expect((await cli(['frames', 'add', '--kind', 'question', '--authority', 'book', '--label', '1', '--section', '1.1', '--page', '0', '--rect', rect])).code).toBe(4);
    expect((await cli(['frames', 'add', '--kind', 'exercise', '--authority', 'user', '--page', '0', '--rect', rect])).code).toBe(2);
    expect((await cli(['frames', 'add', '--kind', 'exercise', '--replace', '--page', '0', '--rect', rect])).code).toBe(2);
  });

  it('does not duplicate when the same command runs twice, unless asked to replace', async () => {
    const cli = await bookWorkspace({ sections: true });
    const args = ['exercises', 'add', '--section', '1.1', '--label', '5a', '--page', '0', '--rect', rect];
    expect((await cli(args)).code).toBe(0);
    const again = await cli(args);
    expect(again.code).toBe(4);
    expect(again.json.error).toMatchObject({ code: 'E_DUPLICATE_EXERCISE' });
    expect(again.json.error?.hint).toContain('--replace');
    expect(((await cli(['frames', 'list'])).json.result.frames as unknown[]).length).toBe(1);
    const replaced = await cli([...args.slice(0, -1), '0.1,0.32,0.9,0.4', '--replace']);
    expect(replaced.code).toBe(0);
    expect(replaced.json.result).toMatchObject({ created: [], replaced: ['f1'], frames: [{ id: 'f1', rect: { top: 0.32, bottom: 0.4 } }] });
    expect(((await cli(['frames', 'list'])).json.result.frames as unknown[]).length).toBe(1);
    expect((await cli(['exercises', 'list'], { json: false })).stdout).toContain('1.1:5a');
  });

  it('is applied twice without harm: the second batch is refused as a whole and writes nothing', async () => {
    const cli = await bookWorkspace({ sections: true });
    const batch = JSON.stringify(addOperations());
    expect((await cli(['frames', 'apply', '-'], { stdin: batch })).code).toBe(0);
    const second = await cli(['frames', 'apply', '-'], { stdin: batch });
    expect(second.code).toBe(4);
    expect(second.json.error?.code).toBe('E_DUPLICATE_EXERCISE');
    expect(second.json.error?.message).toContain('Operation 0 (add)');
    expect(((await cli(['frames', 'list'])).json.result.frames as unknown[]).length).toBe(10);
    const replaced = await cli(['frames', 'apply', '-'], { stdin: JSON.stringify(addOperations({ replace: true })) });
    expect(replaced.code).toBe(0);
    expect(replaced.json.result).toMatchObject({ created: [], replaced: expect.any(Array) });
    expect((replaced.json.result.replaced as string[]).length).toBe(10);
    expect(((await cli(['frames', 'list'])).json.result.frames as unknown[]).length).toBe(10);
  });

  it('lists the exercises by section and filters them', async () => {
    const cli = await bookWorkspace({ exercises: true });
    const all = await cli(['exercises', 'list']);
    expect(all.code).toBe(0);
    const result = all.json.result as { exercises: { reference: string; solution: number; section: string; label: string }[]; count: number; totals: { exercises: number; withSolution: number } };
    expect(result.count).toBe(10);
    expect(result.totals).toEqual({ exercises: 10, withSolution: 10 });
    expect(result.exercises.map((entry) => entry.reference)).toEqual(['1.1:1', '1.1:2', '1.1:3a', '1.1:3b', '1.2:1', '1.2:2', '1.2:3', '1.2:4', '2.1:1', '2.1:2']);
    const section = await cli(['exercises', 'list', '--section', '1.2']);
    expect((section.json.result.exercises as { label: string }[]).map((entry) => entry.label)).toEqual(['1', '2', '3', '4']);
    expect(section.json.result).toMatchObject({ count: 4, totals: { exercises: 10 } });
    const chapter = await cli(['exercises', 'list', '--section', 'c1']);
    expect(chapter.json.result.count).toBe(0);
    expect((await cli(['exercises', 'list', '--section', 'c1', '--subtree'])).json.result.count).toBe(8);
    expect((await cli(['exercises', 'list', '--section', 'nope', '--subtree'])).code).toBe(2);
    expect((await cli(['exercises', 'list', '--page', '1'])).json.result.count).toBe(4);
    expect((await cli(['exercises', 'list', '--without-solution'])).json.result.count).toBe(0);
    expect((await cli(['exercises', 'list', '--with-solution'])).json.result.count).toBe(10);
    const text = (await cli(['exercises', 'list', '--section', '1.1'], { json: false })).stdout;
    expect(text).toContain('4 book exercises of 10');
    expect(text).toContain('1.1:3a');
    expect(text).toContain('solution 1');
  });

  it('marks an exercise you framed, unmarks it, relabels it and moves it to another section', async () => {
    const cli = await bookWorkspace({ sections: true });
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', rect]);
    await cli(['frames', 'add', '--kind', 'exercise', '--page', '0', '--rect', '0.1,0.4,0.9,0.45']);
    expect((await cli(['frames', 'list'])).json.result.frames).toMatchObject([{ label: 'E1', authority: 'user' }, { label: 'E2', authority: 'user' }]);
    const marked = await cli(['exercises', 'mark', 'f1', '--label', '5a', '--section', '1.1']);
    expect(marked.code).toBe(0);
    expect(marked.json.result.frames).toMatchObject([{ id: 'f1', label: '5a', authority: 'book', reference: '1.1:5a' }]);
    expect((await cli(['frames', 'list'])).json.result.frames).toMatchObject([{ id: 'f1', label: '5a' }, { id: 'f2', label: 'E1', authority: 'user' }]);
    const relabelled = await cli(['exercises', 'label', '1.1:5a', '5b']);
    expect(relabelled.json.result.frames).toMatchObject([{ id: 'f1', label: '5b', section: '1.1' }]);
    const moved = await cli(['exercises', 'section', '1.1:5b', '1.2']);
    expect(moved.json.result.frames).toMatchObject([{ id: 'f1', section: '1.2', reference: '1.2:5b' }]);
    expect((await cli(['exercises', 'section', 'f1', 'nowhere'])).code).toBe(4);
    const unmarked = await cli(['exercises', 'unmark', '1.2:5b']);
    expect(unmarked.json.result.frames).toMatchObject([{ id: 'f1', label: 'E1', authority: 'user' }]);
    expect((await cli(['exercises', 'unmark', 'f1'])).code).toBe(4);
    expect((await cli(['exercises', 'label', 'f1', '5'])).code).toBe(4);
    expect((await cli(['exercises', 'mark', 'f9', '--label', '1', '--section', '1.1'])).json.error?.code).toBe('E_NO_FRAME');
    expect((await cli(['exercises', 'mark', 'f1', '--label', '(a)', '--section', '1.1'])).json.error?.code).toBe('E_LABEL');
  });

  it('refuses a duplicate that a relabel would make, with an error that names both exercises', async () => {
    const cli = await bookWorkspace({ exercises: true });
    const clash = await cli(['exercises', 'label', '1.1:2', '1']);
    expect(clash.code).toBe(4);
    expect(clash.json.error?.code).toBe('E_REJECTED');
    expect(clash.json.error?.issues?.[0]).toMatchObject({ code: 'duplicate-exercise' });
    expect(clash.json.error?.issues?.[0]?.message).toContain('"1"');
    expect((await cli(['exercises', 'list', '--section', '1.1'])).json.result.exercises).toMatchObject([{ label: '1' }, { label: '2' }, { label: '3a' }, { label: '3b' }]);
  });
});

describe('what an authoritative exercise cannot be', () => {
  it('is not cut into parts, resized as parts or merged, and the error explains the convention', async () => {
    const cli = await bookWorkspace({ exercises: true });
    for (const args of [
      ['frames', 'split', '1.1:3a', '--at', '0.5'],
      ['frames', 'dividers', '1.1:3a', '--at', '0.5'],
      ['frames', 'area', '1.1:3a', '--rect', '0.1,0.3,0.9,0.5'],
      ['frames', 'merge', '1.1:3a', '1.1:3b'],
    ]) {
      const refused = await cli(args);
      expect(refused.code, args.join(' ')).toBe(4);
      expect(refused.json.error?.code).toBe('E_AUTHORITY');
      expect(refused.json.error?.message).toContain('1.1:3a');
      expect(refused.json.error?.hint).toContain('separate exercises');
      expect(refused.json.error?.hint).toContain('context');
    }
    const unit = await cli(['frames', 'add', '--kind', 'exercise', '--authority', 'book', '--label', '9', '--section', '1.1', '--page', '0', '--rect', rect, '--unit', 'u1']);
    expect(unit.code).toBe(4);
    expect(unit.json.error?.code).toBe('E_AUTHORITY_UNIT');
    const text = (await cli(['frames', 'split', '1.1:3a', '--at', '0.5'], { json: false })).stderr;
    expect(text).toContain('hint:');
    expect(text).toContain('5a, 5b');
  });

  it('may still be moved and resized with frames update, and gets context and continuations', async () => {
    const cli = await bookWorkspace({ exercises: true });
    const updated = await cli(['frames', 'update', '1.1:1', '--rect', '0.1,0.29,0.9,0.37']);
    expect(updated.code).toBe(0);
    expect(updated.json.result.frames).toMatchObject([{ label: '1', authority: 'book', rect: { top: 0.29 } }]);
    expect((await cli(['context', 'add', '1.1:1', '--page', '0', '--rect', '0.1,0.2,0.9,0.26'])).code).toBe(0);
    expect((await cli(['continues', 'add', '1.1:1', '--page', '1', '--rect', '0.1,0.9,0.9,0.95'])).code).toBe(0);
    expect(((await cli(['frames', 'delete', '1.1:2'])).json.result as { removed: string[] }).removed).toHaveLength(1);
    expect((await cli(['frames', 'update', '1.1:1', '--kind', 'question'])).json.error?.code).toBe('E_AUTHORITY');
  });
});

describe('solution regions', () => {
  it('are added, listed, removed and cleared', async () => {
    const cli = await bookWorkspace({ sections: true });
    await cli(['exercises', 'add', '--section', '1.1', '--label', '1', '--page', '0', '--rect', rect]);
    await cli(['exercises', 'add', '--section', '1.1', '--label', '2', '--page', '0', '--rect', '0.1,0.4,0.9,0.45']);
    const added = await cli(['solution', 'add', '1.1:1', '--page', '3', '--rect', '0.1,0.18,0.5,0.2']);
    expect(added.code).toBe(0);
    expect(added.json.result.frames).toMatchObject([{ id: 'f1', solution: 1 }]);
    await cli(['solution', 'add', 'f1', '--page', '3', '--rect', '0.1,0.3,0.5,0.32']);
    const list = await cli(['solution', 'list']);
    expect(list.json.result).toMatchObject({ count: 2, solutions: [{ frame: 'f1', label: '1', reference: '1.1:1', authority: 'book', regions: [{ index: 0, page: 3 }, { index: 1, page: 3 }] }] });
    expect(((await cli(['solution', 'list', '1.1:1'])).json.result as { count: number }).count).toBe(2);
    expect(((await cli(['solution', 'list', '1.1:2'])).json.result as { count: number }).count).toBe(0);
    const missing = await cli(['solution', 'list', '--missing']);
    expect(missing.json.result.missing).toMatchObject([{ frame: 'f2', reference: '1.1:2' }]);
    expect((await cli(['solution', 'list', '--missing'], { json: false })).stdout).toContain('1.1:2');
    const several = await cli(['solution', 'remove', '1.1:1']);
    expect(several.code).toBe(4);
    expect(several.json.error?.message).toContain('say which');
    expect((await cli(['solution', 'remove', '1.1:1', '--index', '0'])).code).toBe(0);
    expect(((await cli(['solution', 'list', 'f1'])).json.result.solutions as { regions: unknown[] }[])[0]?.regions).toHaveLength(1);
    expect((await cli(['solution', 'clear', '1.1:1'])).code).toBe(0);
    const again = await cli(['solution', 'clear', '1.1:1']);
    expect(again.code).toBe(0);
    expect(again.json.result).toMatchObject({ cleared: 0 });
    expect((await cli(['solution', 'add', 'f9', '--page', '3', '--rect', '0.1,0.18,0.5,0.2'])).json.error?.code).toBe('E_NO_FRAME');
    expect((await cli(['solution', 'add', 'f1', '--page', '9', '--rect', '0.1,0.18,0.5,0.2'])).json.error?.code).toBe('E_PAGE');
  });

  it('are hidden from the learner: they warn when they lie on the exercise itself or on another exercise', async () => {
    const cli = await bookWorkspace({ sections: true });
    await cli(['exercises', 'add', '--section', '1.1', '--label', '1', '--page', '0', '--rect', rect, '--solution', '0:0.1,0.3,0.9,0.34']);
    await cli(['exercises', 'add', '--section', '1.1', '--label', '2', '--page', '0', '--rect', '0.1,0.4,0.9,0.45', '--solution', '0:0.1,0.3,0.9,0.35']);
    const validation = await cli(['validate', '--no-text']);
    expect(validation.code).toBe(0);
    const codes = (validation.json.result.warnings as { code: string; frameId: string }[]).map((entry) => `${entry.code}:${entry.frameId}`).sort();
    expect(codes).toEqual(['solution-is-exercise:f2', 'solution-overlaps-frame:f1', 'solution-overlaps-frame:f2'].sort().filter((entry) => codes.includes(entry)));
    expect(codes).toContain('solution-overlaps-frame:f1');
    expect(codes).toContain('solution-is-exercise:f2');
  });
});

describe('sections: the outline of a book', () => {
  it('is shown with ids, labels, tops and the number of exercises in each entry', async () => {
    const cli = await bookWorkspace({ exercises: true });
    const shown = await cli(['outline']);
    expect(shown.json.result).toMatchObject({ source: 'project', projectSource: 'manual', totals: { entries: 6, withId: 6, exercises: 10 } });
    const entries = shown.json.result.entries as { index: number; id: string; label?: string; top?: number; exercises: number; exercisesTotal: number; withSolution: number }[];
    expect(entries.map((entry) => `${entry.id}:${entry.exercises}/${entry.exercisesTotal}`)).toEqual(['c1:0/8', '1.1:4/4', '1.2:4/4', 'c2:0/2', '2.1:2/2', 'answers:0/0']);
    expect(entries[1]).toMatchObject({ index: 1, label: '1.1', withSolution: 4 });
    expect(entries[1]?.top).toBeGreaterThan(0.2);
    const text = (await cli(['outline'], { json: false })).stdout;
    expect(text).toContain('exercises (total)');
    expect(text).toContain('0 (8)');
    expect(text).toContain('1.2');
  });

  it('can be written with ids by a file, made by --auto-ids, edited entry by entry and kept consistent with the exercises', async () => {
    const cli = await bookWorkspace();
    const plain = sample.pdfOutline.map(({ title, page, depth }) => ({ title, page, depth }));
    const set = await cli(['outline', 'set', '-', '--auto-ids'], { stdin: JSON.stringify(plain) });
    expect(set.code).toBe(0);
    expect((await cli(['outline'])).json.result.entries).toMatchObject([{ id: '1' }, { id: '1.1' }, { id: '1.2' }, { id: '2' }, { id: '2.1' }, { id: 'Answers' }]);
    await cli(['exercises', 'add', '--section', '1.1', '--label', '1', '--page', '0', '--rect', rect]);
    const renamed = await cli(['outline', 'update', '1.1', '--new-id', 'adding', '--label', '1.1', '--top', '0.25']);
    expect(renamed.code).toBe(0);
    expect(renamed.json.notes?.join(' ')).toContain('now name "adding"');
    expect((await cli(['frames', 'list'])).json.result.frames).toMatchObject([{ section: 'adding', reference: 'adding:1' }]);
    const inUse = await cli(['outline', 'delete', 'adding']);
    expect(inUse.code).toBe(4);
    expect(inUse.json.error?.code).toBe('E_SECTION_IN_USE');
    expect((await cli(['outline', 'update', 'adding', '--new-id', '2.1'])).code).toBe(4);
    expect((await cli(['outline', 'update', '--title', 'x'])).code).toBe(2);
    expect((await cli(['outline', 'update', 'adding'])).code).toBe(2);
    expect((await cli(['outline', 'update', 'nope', '--title', 'x'])).json.error?.code).toBe('E_NO_SECTION');
    expect((await cli(['outline', 'update', 'adding', '--top', '2'])).json.error?.code).toBe('E_OUTLINE');
    expect((await cli(['outline', 'update', 'adding', '--top', 'none', '--label', ''])).code).toBe(0);
    expect(((await cli(['outline'])).json.result.entries as unknown[]).slice(0, 2)).toMatchObject([{}, { id: 'adding', title: '1.1 Adding integers' }]);
    expect((await cli(['outline', 'update', '--index', '5', '--new-id', 'key'])).code).toBe(0);
    await cli(['exercises', 'section', 'f1', '1.2']);
    const deleted = await cli(['outline', 'delete', 'adding']);
    expect(deleted.code).toBe(0);
    expect(((await cli(['outline'])).json.result.entries as unknown[]).length).toBe(5);
    expect((await cli(['outline', 'delete', '2', '--subtree'])).code).toBe(0);
    expect(((await cli(['outline'])).json.result.entries as { id: string }[]).map((entry) => entry.id)).toEqual(['1', '1.2', 'key']);
  });

  it('adds entries, with a made id unless told otherwise, at the end or at a position', async () => {
    const cli = await bookWorkspace();
    const first = await cli(['outline', 'add', '--title', 'Chapter 1 Integers', '--page', '0', '--label', 'Chapter 1']);
    expect(first.code).toBe(0);
    expect(first.json.notes?.join(' ')).toContain('"Chapter-1"');
    expect((await cli(['outline', 'add', '--title', '1.2 Subtracting', '--page', '1', '--depth', '1', '--id', '1.2', '--top', '0.1'])).code).toBe(0);
    expect((await cli(['outline', 'add', '--title', '1.1 Adding', '--page', '0', '--depth', '1', '--label', '1.1', '--at', '1'])).code).toBe(0);
    expect((await cli(['outline', 'add', '--title', 'Notes', '--page', '3', '--no-id'])).code).toBe(0);
    expect((await cli(['outline'])).json.result.entries).toMatchObject([{ id: 'Chapter-1', label: 'Chapter 1' }, { id: '1.1' }, { id: '1.2', top: 0.1 }, { title: 'Notes' }]);
    expect(((await cli(['outline'])).json.result.entries as { id?: string }[])[3]?.id).toBeUndefined();
    expect((await cli(['outline', 'add', '--title', 'Dup', '--page', '0', '--id', '1.2'])).json.error?.code).toBe('E_OUTLINE_ID_TAKEN');
    expect((await cli(['outline', 'add', '--title', 'Far', '--page', '9'])).json.error?.code).toBe('E_PAGE');
    expect((await cli(['outline', 'add', '--title', 'Top', '--page', '0', '--top', 'high'])).code).toBe(2);
    const ids = await cli(['outline', 'ids']);
    expect(ids.code).toBe(0);
    expect(ids.json.notes?.join(' ')).toContain('Gave 1 entry an id');
    expect((await cli(['outline', 'ids'])).json.notes?.join(' ')).toContain('already has an id');
  });

  it('rejects an outline whose id is used twice, naming both entries, and needs sections for exercises', async () => {
    const cli = await bookWorkspace();
    const twice = await cli(['outline', 'set', '-'], { stdin: JSON.stringify([{ title: 'A', page: 0, depth: 0, id: 'x' }, { title: 'B', page: 1, depth: 0, id: 'x' }]) });
    expect(twice.code).toBe(4);
    expect(twice.json.error?.message).toContain('0 and 1');
    const orphan = await cli(['exercises', 'add', '--section', 'nowhere', '--label', '1', '--page', '0', '--rect', rect]);
    expect(orphan.code).toBe(4);
    expect(orphan.json.error?.code).toBe('E_REJECTED');
    expect(orphan.json.error?.issues?.[0]).toMatchObject({ code: 'section-unknown', frameId: 'f1' });
    expect((await cli(['frames', 'list'])).json.result.frames).toEqual([]);
  });
});

describe('book show, book meta and book export', () => {
  it('shows the sections with their counts and the totals, and the same summary as JSON', async () => {
    const cli = await bookWorkspace({ exercises: true });
    await cli(['frames', 'add', '--kind', 'question', '--page', '2', '--rect', '0.1,0.6,0.9,0.65']);
    const shown = await cli(['book', 'show']);
    expect(shown.code).toBe(0);
    const summary = shown.json.result as { format: string; version: number; document: Record<string, unknown>; sections: Record<string, unknown>[]; totals: Record<string, unknown> };
    expect(summary).toMatchObject({ format: 'math-canvas-book-summary', version: 1, generator: { name: 'math-canvas-prep' }, document: { title: 'Pre-Algebra Workbook', folder: 'Books/Algebra', pageCount: 4 } });
    expect(summary.document['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.totals).toEqual({ sections: 6, sectionsWithId: 6, exercises: 10, withSolution: 10, withoutSolution: 0, unfiled: 0, ordinary: { exercises: 0, questions: 1, bookmarks: 0 } });
    expect(summary.sections.map((entry) => `${entry['id'] as string}:${entry['exercises'] as number}/${entry['exercisesTotal'] as number}`)).toEqual(['c1:0/8', '1.1:4/4', '1.2:4/4', 'c2:0/2', '2.1:2/2', 'answers:0/0']);
    expect(summary.sections[1]).toMatchObject({ index: 1, id: '1.1', label: '1.1', page: 0, depth: 1, parent: 0, firstLabel: '1', lastLabel: '3b', withSolution: 4 });
    expect(summary.sections[0]).toMatchObject({ parent: null });
    expect(summary.sections[1]).not.toHaveProperty('items');
    const withItems = (await cli(['book', 'show', '--exercises'])).json.result.sections as { items?: { label: string; solutionRegions: number }[] }[];
    expect(withItems[1]?.items?.map((item) => item.label)).toEqual(['1', '2', '3a', '3b']);
    expect(withItems[1]?.items?.[0]?.solutionRegions).toBe(1);
    const text = (await cli(['book', 'show'], { json: false })).stdout;
    expect(text).toContain('Pre-Algebra Workbook');
    expect(text).toContain('Book exercises: 10, 10 with a solution, 0 without');
    expect(text).toContain('Also framed for yourself: 0 exercises, 1 question, 0 bookmarks.');
    expect(text).toContain('Chapter 1 Integers');
    expect(text).toContain('1 .. 3b');
    const used = (await cli(['book', 'show', '--used'], { json: false })).stdout;
    expect(used).not.toContain('Answers');
    expect(used).toContain('2.1 Equivalent fractions');
  });

  it('counts exercises filed under a section the outline does not have as unfiled', async () => {
    const cli = await bookWorkspace({ sections: true });
    await cli(['exercises', 'add', '--section', '1.1', '--label', '1', '--page', '0', '--rect', rect]);
    expect((await cli(['outline', 'clear'])).code).toBe(4);
    expect((await cli(['frames', 'apply', '-', '--force'], { stdin: JSON.stringify([{ op: 'outline.clear' }]) })).code).toBe(0);
    const noOutline = await cli(['book', 'show']);
    expect(noOutline.json.result).toMatchObject({ totals: { sections: 0, exercises: 1, unfiled: 1 } });
    expect((await cli(['book', 'show'], { json: false })).stdout).toContain('no sections yet');
  });

  it('writes the summary to a file', async () => {
    const cli = await bookWorkspace({ exercises: true });
    const out = join(cli.dir, 'summary.json');
    const exported = await cli(['book', 'export', '--out', out]);
    expect(exported.code).toBe(0);
    const written = JSON.parse(await readFile(out, 'utf8')) as { format: string; sections: unknown[]; totals: { exercises: number } };
    expect(written).toMatchObject({ format: 'math-canvas-book-summary', totals: { exercises: 10 } });
    expect(written.sections).toHaveLength(6);
    expect(exported.json.result).toMatchObject({ path: out, summary: { totals: { exercises: 10 } } });
    const byDefault = await cli(['book', 'export', '--exercises']);
    expect(byDefault.json.result.path).toBe(join(cli.dir, 'book.book.json'));
    expect((JSON.parse(await readFile(join(cli.dir, 'book.book.json'), 'utf8')) as { sections: { items?: unknown[] }[] }).sections[1]?.items).toHaveLength(4);
    expect((await readdir(cli.dir)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('shows and changes the information about the book', async () => {
    const cli = await bookWorkspace({ sections: true });
    expect((await cli(['book', 'meta'])).json.result).toEqual({ title: 'Pre-Algebra Workbook', folder: 'Books/Algebra' });
    const changed = await cli(['book', 'meta', '--author', 'A. Author', '--series', 'Prerequisites', '--description', 'A synthetic workbook.', '--license-name', 'CC BY 3.0', '--license-url', 'https://creativecommons.org/licenses/by/3.0/', '--source-url', 'https://example.org/the-book']);
    expect(changed.code).toBe(0);
    await writeFile(join(cli.dir, 'notice.txt'), '﻿Attribution: A. Author, CC BY 3.0.\nChanges: marked for study.\n');
    expect((await cli(['book', 'meta', '--notice', '@notice.txt'])).code).toBe(0);
    expect((await cli(['book', 'meta'])).json.result).toEqual({
      title: 'Pre-Algebra Workbook',
      folder: 'Books/Algebra',
      author: 'A. Author',
      series: 'Prerequisites',
      description: 'A synthetic workbook.',
      license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
      sourceUrl: 'https://example.org/the-book',
      notice: 'Attribution: A. Author, CC BY 3.0.\nChanges: marked for study.',
    });
    const text = (await cli(['book', 'meta'], { json: false })).stdout;
    expect(text).toContain('author: A. Author');
    expect(text).toContain('licence: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)');
    expect((await cli(['book', 'meta', '--license-url', 'https://x.org/license'])).code).toBe(0);
    expect((await cli(['book', 'meta'])).json.result).toMatchObject({ license: { name: 'CC BY 3.0', url: 'https://x.org/license' } });
    expect((await cli(['book', 'meta', '--license-name', 'MIT'])).code).toBe(0);
    expect((await cli(['book', 'meta'])).json.result).toMatchObject({ license: { name: 'MIT' } });
    expect(((await cli(['book', 'meta'])).json.result as { license: Record<string, unknown> }).license).not.toHaveProperty('url');
    expect((await cli(['book', 'meta', '--no-license', '--author', '', '--notice', ''])).code).toBe(0);
    expect((await cli(['book', 'meta'])).json.result).toEqual({ title: 'Pre-Algebra Workbook', folder: 'Books/Algebra', series: 'Prerequisites', description: 'A synthetic workbook.', sourceUrl: 'https://example.org/the-book' });
    expect((await cli(['book', 'meta', '--notice', '@@literal'])).code).toBe(0);
    expect(((await cli(['book', 'meta'])).json.result as { notice: string }).notice).toBe('@literal');
  });

  it('refuses what a bundle could not carry, and says why', async () => {
    const cli = await bookWorkspace({ sections: true });
    const badUrl = await cli(['book', 'meta', '--source-url', 'example.org']);
    expect(badUrl.code).toBe(4);
    expect(badUrl.json.error?.code).toBe('E_META');
    expect(badUrl.json.error?.message).toContain('meta.sourceUrl');
    expect((await cli(['book', 'meta', '--author', 'x'.repeat(201)])).json.error?.code).toBe('E_META');
    expect((await cli(['book', 'meta', '--license-url', 'https://x.org'])).code).toBe(2);
    expect((await cli(['book', 'meta', '--no-license', '--license-name', 'MIT'])).code).toBe(2);
    expect((await cli(['book', 'meta', '--notice', '@missing.txt'])).json.error?.code).toBe('E_FILE');
    expect((await cli(['book', 'meta', '--title', '  '])).json.error?.code).toBe('E_TITLE');
    expect((await cli(['book', 'meta'])).json.result).toEqual({ title: 'Pre-Algebra Workbook', folder: 'Books/Algebra' });
  });
});

describe('validate, export, inspect-bundle and import-check on a book', () => {
  it('validates, exports, checks and inspects a bundle that carries the sections, exercises and solutions', async () => {
    const cli = await bookWorkspace({ exercises: true });
    await cli(['book', 'meta', '--author', 'A. Author', '--license-name', 'CC BY 3.0', '--license-url', 'https://creativecommons.org/licenses/by/3.0/', '--source-url', 'https://example.org/the-book', '--notice', 'Attribution: A. Author.']);
    const validation = await cli(['validate']);
    expect(validation.code).toBe(0);
    expect(validation.json.result).toMatchObject({ ok: true, errors: [], counts: { exercise: 0 }, book: { exercises: 10, withSolution: 10 }, numbers: [] });
    expect((await cli(['validate'], { json: false })).stdout).toContain('10 book exercises (10 with a solution)');

    const out = join(cli.dir, 'book.mcbundle');
    const exported = await cli(['export', '--out', out, '--created-at', '2026-10-04T12:00:00Z']);
    expect(exported.code).toBe(0);
    expect(exported.json.result).toMatchObject({
      book: { exercises: 10, withSolution: 10 },
      counts: { frames: 10, outlineEntries: 6 },
      manifest: { features: ['sections', 'authority', 'solution'], generator: { version: '0.2.0' }, document: { title: 'Pre-Algebra Workbook', author: 'A. Author', license: { name: 'CC BY 3.0' }, sourceUrl: 'https://example.org/the-book', notice: 'Attribution: A. Author.' } },
      importCheck: { ok: true },
    });
    const exportText = (await cli(['export', '--out', out, '--created-at', '2026-10-04T12:00:00Z'], { json: false })).stdout;
    expect(exportText).toContain('10 authoritative exercises, 10 with a hidden solution (features: sections, authority, solution)');
    expect(exportText).toContain('author: A. Author   licence: CC BY 3.0');

    const check = await cli(['import-check', out]);
    expect(check.code).toBe(0);
    expect(check.json.result).toMatchObject({ wouldImport: true, features: ['sections', 'authority', 'solution'], document: { author: 'A. Author', license: { name: 'CC BY 3.0' } }, numbers: [] });
    expect((check.json.result.steps as { detail: string }[])[5]?.detail).toContain('10 authoritative exercises in 3 sections (10 with a hidden solution)');

    const inspected = await cli(['inspect-bundle', out]);
    expect(inspected.code).toBe(0);
    expect(inspected.json.result).toMatchObject({ ok: true, summary: { totals: { exercises: 10, withSolution: 10, sections: 6 } } });
    const text = (await cli(['inspect-bundle', out], { json: false })).stdout;
    expect(text).toContain('features: sections, authority, solution');
    expect(text).toContain('1.1:3a');
    expect(text).toContain('book, continues 1, solution 1');
    expect(text).toContain('The book:');
    expect(text).toContain('Pre-Algebra Workbook');
    expect(text).toContain('author: A. Author');
    expect(text).toContain('1 .. 3b');
    expect(text).toContain('The importer would ACCEPT this bundle.');
  });

  it('does not export what the importer would reject, and says which exercise and what to do', async () => {
    const cli = await bookWorkspace({ exercises: true });
    await cli(['outline', 'delete', '--index', '5']);
    const outline = JSON.parse(JSON.stringify(sample.sections)) as { id?: string }[];
    expect(outline).toHaveLength(6);
    const forced = await cli(['frames', 'apply', '-', '--force'], { stdin: JSON.stringify([{ op: 'outline.set', entries: sample.sections.filter((entry) => entry.id !== '2.1') }]) });
    expect(forced.code).toBe(0);
    const validation = await cli(['validate']);
    expect(validation.code).toBe(4);
    expect((validation.json.result.errors as { code: string; frameId: string }[]).map((entry) => entry.code)).toEqual(['section-unknown', 'section-unknown']);
    const failed = await cli(['export', '--out', join(cli.dir, 'x.mcbundle')]);
    expect(failed.code).toBe(4);
    expect(failed.json.error?.code).toBe('E_VALIDATION');
    expect(failed.json.error?.issues?.[0]).toMatchObject({ code: 'section-unknown' });
    expect((await cli(['validate'], { json: false })).stdout).toContain('error [section-unknown]');
    const pdfOutline = await cli(['export', '--outline', 'pdf', '--out', join(cli.dir, 'x.mcbundle')]);
    expect(pdfOutline.code).toBe(4);
  });

  it('refuses to export the PDF outline or none when exercises are filed under the project outline', async () => {
    const cli = await bookWorkspace({ exercises: true });
    for (const mode of ['pdf', 'none']) {
      const refused = await cli(['export', '--outline', mode, '--out', join(cli.dir, 'x.mcbundle')]);
      expect(refused.code).toBe(4);
      expect(refused.json.error?.code).toBe('E_OUTLINE_MODE');
      expect(refused.json.error?.hint).toContain('--outline project');
    }
  });

  it('looks at the regions: crops of a solution and of a whole section, and a page with the solutions drawn', async () => {
    const cli = await bookWorkspace({ exercises: true });
    const one = await cli(['crop', '1.1:3a', '--region', 'solution:0']);
    expect(one.code).toBe(0);
    expect(one.json.result.crops).toMatchObject([{ frame: 'f3', region: 'solution:0', page: 3 }]);
    expect((await cli(['crop', '1.1:3a', '--region', 'solution:1'])).json.error?.code).toBe('E_NO_REGION');
    expect((await cli(['crop', '9.9:1'])).json.error?.code).toBe('E_NO_FRAME');
    const section = await cli(['crop', '--all', '--section', '1.2']);
    expect(section.code).toBe(0);
    const crops = section.json.result.crops as { frame: string; region: string }[];
    expect(crops.filter((entry) => entry.region === 'main')).toHaveLength(4);
    expect(crops.filter((entry) => entry.region.startsWith('solution'))).toHaveLength(4);
    expect(crops.filter((entry) => entry.region.startsWith('continues'))).toHaveLength(1);
    expect((await cli(['crop', '--all', '--section', 'nope'])).code).toBe(4);
    const page = await cli(['render', '3', '--frames', '--solutions']);
    expect(page.code).toBe(0);
    expect(page.json.result).toMatchObject({ frames: 10 });
    expect((await cli(['render', '3', '--frames'])).json.result).toMatchObject({ frames: 0 });
  });

  it('shows what is in the project: info counts the book exercises', async () => {
    const cli = await bookWorkspace({ exercises: true });
    expect((await cli(['info'])).json.result).toMatchObject({ frames: { exercises: 0, bookExercises: 10, bookExercisesWithSolution: 10, total: 10 }, outline: { project: 6, withId: 6 } });
    expect((await cli(['info'], { json: false })).stdout).toContain('10 book exercises (10 with a solution)');
  });
});

describe('the book summary schema', () => {
  it('is served by the schema command', async () => {
    const cli = await bookWorkspace({ init: false });
    const schema = await cli(['schema', 'book-summary']);
    expect(schema.code).toBe(0);
    expect(schema.json.result).toMatchObject({ name: 'book-summary', schema: { title: expect.stringContaining('summary') } });
  });
});
