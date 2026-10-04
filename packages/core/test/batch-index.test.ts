import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/model/types.js';
import { applyOperation, applyOperations, findFrame, frameFinder, type Operation } from '../src/project/ops.js';
import type { Project } from '../src/project/model.js';
import { McPrepError } from '../src/rules/issues.js';
import { bookFrame, bookProject, ordinary } from './book-helpers.js';

/**
 * A batch finds the frame each operation names through an index that the operations which change one frame (or add one)
 * keep up to date; a single operation, and every lookup outside a batch, scans the frames. The two must agree on everything:
 * the project that comes out, what was created, what was noted, and which operation fails and why. Random batches of every
 * operation that touches a single frame (with numbers that collide and references that miss) are applied both ways.
 */

const ctx = { pageCount: 6 };
const SECTIONS = ['1.1', '1.2', '2.1', 'nowhere'];

/** A small deterministic generator (the same sequences on every run and every machine). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Eighteen book exercises in three sections, six ordinary exercises, some with a solution, a context or a continuation. */
function build(): Project {
  const frames: Frame[] = [];
  let at = 0;
  for (const section of ['1.1', '1.2', '2.1']) {
    for (let label = 1; label <= 6; label += 1) {
      at += 1;
      const top = 0.05 + label * 0.1;
      const extra: Partial<Frame> = label % 3 === 0 ? { solution: [{ page: 5, rect: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.15 } }] } : label % 3 === 1 ? { context: [{ page: 0, rect: { left: 0.1, top: 0.02, right: 0.9, bottom: 0.04 } }] } : {};
      frames.push(bookFrame(`f${at}`, section, String(label), label % 5, top, top + 0.06, extra));
    }
  }
  for (let i = 0; i < 6; i += 1) {
    at += 1;
    frames.push(ordinary(`f${at}`, i % 5, 0.1 + i * 0.12, 0.18 + i * 0.12, i % 2 === 0 ? { continues: [{ page: 5, rect: { left: 0.1, top: 0.5, right: 0.9, bottom: 0.6 } }] } : {}));
  }
  return { ...bookProject(frames), seq: at };
}

/** One project, made once (it carries the time it was made): each use starts from its own copy, so that two copies are equal. */
const BASE = build();
const start = (): Project => structuredClone(BASE);

function operation(next: () => number): Operation {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const label = (): string => String(1 + Math.floor(next() * 9));
  const reference = (): string => (next() < 0.6 ? `${pick(SECTIONS)}:${label()}` : `f${1 + Math.floor(next() * 30)}`);
  const area = (): [number, number, number, number] => {
    const top = Math.round((0.05 + next() * 0.8) * 100) / 100;
    return [0.1, top, 0.9, Math.round((top + 0.05) * 100) / 100];
  };
  const region = (): { page: number; rect: [number, number, number, number] } => ({ page: Math.floor(next() * 6), rect: area() });
  switch (Math.floor(next() * 17)) {
    case 0:
    case 1:
      return { op: 'add', authority: 'book', label: label(), section: pick(SECTIONS), page: Math.floor(next() * 6), rect: area(), ...(next() < 0.3 ? { replace: true } : {}), ...(next() < 0.3 ? { solution: [region()] } : {}) };
    case 2:
      return { op: 'add', kind: 'exercise', page: Math.floor(next() * 6), rect: area() };
    case 3:
    case 4:
      return { op: 'solution.set', id: reference(), regions: next() < 0.2 ? [] : [region(), ...(next() < 0.3 ? [region()] : [])] };
    case 5:
      return { op: 'solution.add', id: reference(), ...region() };
    case 6:
      return { op: 'solution.remove', id: reference(), ...(next() < 0.5 ? { all: true } : {}) };
    case 7:
      return { op: 'context.add', id: reference(), ...region() };
    case 8:
      return { op: 'context.set', id: reference(), regions: next() < 0.3 ? [] : [region()] };
    case 9:
      return { op: 'context.remove', id: reference(), all: true };
    case 10:
      return { op: 'continues.add', id: reference(), ...region() };
    case 11:
      return { op: 'continues.remove', id: reference(), all: true };
    case 12:
    case 13:
      return { op: 'label.set', id: reference(), label: label() };
    case 14:
      return { op: 'section.set', id: reference(), section: pick(SECTIONS) };
    case 15:
      return next() < 0.5 ? { op: 'authority.mark', id: reference(), label: label(), section: pick(SECTIONS) } : { op: 'authority.unmark', id: reference() };
    default:
      return next() < 0.5 ? { op: 'delete', id: reference() } : { op: 'update', id: reference(), rect: area() };
  }
}

/** `wanted` random operations that each succeed on the project the ones before them made (found by trying them one at a time). */
function succeeding(next: () => number, wanted: number): Operation[] {
  const operations: Operation[] = [];
  let current = start();
  for (let tries = 0; operations.length < wanted && tries < wanted * 15; tries += 1) {
    const candidate = operation(next);
    try {
      current = applyOperation(current, candidate, ctx).project;
      operations.push(candidate);
    } catch (error) {
      if (!(error instanceof McPrepError)) throw error;
    }
  }
  return operations;
}

interface Outcome {
  failed?: { index: number; code: string };
  project?: Project;
  created: string[];
  notes: string[];
}

/** The batch in one call: the index of the batch keeps up with every operation. */
function inOneBatch(project: Project, operations: readonly Operation[]): Outcome {
  try {
    const result = applyOperations(project, operations, ctx);
    return { project: result.project, created: result.created, notes: result.notes };
  } catch (error) {
    if (!(error instanceof McPrepError)) throw error;
    return { failed: { index: (error.details?.['operation'] as number | undefined) ?? -1, code: error.code }, created: [], notes: [] };
  }
}

/** The same operations one at a time, each on the project the one before made, with no batch and so no index: every lookup scans. */
function oneByOne(project: Project, operations: readonly Operation[]): Outcome {
  let current: Project = project;
  const created: string[] = [];
  const notes: string[] = [];
  for (const [index, op] of operations.entries()) {
    try {
      const result = applyOperation(current, op, ctx);
      current = result.project;
      created.push(...result.created);
      notes.push(...result.notes);
    } catch (error) {
      if (!(error instanceof McPrepError)) throw error;
      return { failed: { index, code: error.code }, created: [], notes: [] };
    }
  }
  return { project: current, created, notes };
}

describe('the index of a batch', () => {
  it('gives every random batch of operations that succeed the project, the ids and the notes the scanning way gives', () => {
    let total = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      // The operations are drawn at random and kept when they succeed on the project the ones before made (a miss, a refused
      // label or a number that is taken is thrown away), so that the batches are long and exercise every operation.
      const wanted = 8 + Math.floor(next() * 40);
      const operations = succeeding(next, wanted);
      for (const op of operations) kinds.add(op.op);
      total += operations.length;
      const batch = inOneBatch(start(), operations);
      const scanned = oneByOne(start(), operations);
      expect(batch.failed, `seed ${seed}`).toBeUndefined();
      expect(batch.project, `seed ${seed}`).toEqual(scanned.project);
      expect(batch.created, `seed ${seed}`).toEqual(scanned.created);
      expect(batch.notes, `seed ${seed}`).toEqual(scanned.notes);
    }
    expect(total).toBeGreaterThan(2000);
    expect([...kinds].sort()).toEqual(['add', 'authority.mark', 'authority.unmark', 'context.add', 'context.remove', 'context.set', 'continues.add', 'continues.remove', 'delete', 'label.set', 'section.set', 'solution.add', 'solution.remove', 'solution.set', 'update']);
  });

  it('fails at the same operation and for the same reason as the scanning way when one of them cannot be applied', () => {
    const failures = new Set<string>();
    for (let seed = 500; seed < 700; seed += 1) {
      const next = random(seed);
      const operations = succeeding(next, 12);
      // One more, drawn without looking: it may fail, and then both ways must say the same.
      const last = operation(next);
      const batch = inOneBatch(start(), [...operations, last]);
      const scanned = oneByOne(start(), [...operations, last]);
      expect(batch.failed, `seed ${seed}`).toEqual(scanned.failed);
      if (batch.failed) failures.add(batch.failed.code);
      else expect(batch.project, `seed ${seed}`).toEqual(scanned.project);
    }
    expect(failures.size).toBeGreaterThanOrEqual(3);
  });

  it('applies long runs of operations that move numbers and make them collide, with a lookup by number after each', () => {
    let steps = 0;
    for (let seed = 1000; seed < 1100; seed += 1) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      // The numbers are given to frames that already have them elsewhere on purpose (two exercises of a section with one label is for
      // the checks to say, not for the batch), and after each change a lookup by number says which frame the number belongs to now.
      const operations: Operation[] = [];
      let current = start();
      for (let tries = 0; operations.length < 120 && tries < 600; tries += 1) {
        const id = `f${1 + Math.floor(next() * 18)}`;
        const change = pick<Operation>([
          { op: 'label.set', id, label: String(1 + Math.floor(next() * 3)) },
          { op: 'section.set', id, section: pick(['1.1', '1.2']) },
          { op: 'solution.set', id, regions: [{ page: 5, rect: [0.1, 0.1, 0.4, 0.15] }] },
          { op: 'context.set', id, regions: [] },
        ]);
        const probe: Operation = { op: 'solution.set', id: `${pick(['1.1', '1.2'])}:${1 + Math.floor(next() * 3)}`, regions: next() < 0.5 ? [] : [{ page: 4, rect: [0.1, 0.2, 0.4, 0.25] }] };
        try {
          current = applyOperation(applyOperation(current, change, ctx).project, probe, ctx).project;
          operations.push(change, probe);
        } catch (error) {
          if (!(error instanceof McPrepError)) throw error;
        }
      }
      steps += operations.length;
      const batch = inOneBatch(start(), operations);
      expect(batch.failed, `seed ${seed}`).toBeUndefined();
      expect(batch.project, `seed ${seed}`).toEqual(current);
    }
    expect(steps).toBeGreaterThan(10000);
  });

  it('finds the first of two frames that have one number, as a scan does', () => {
    const twice: Project = bookProject([bookFrame('f1', '1.1', '4', 0, 0.1, 0.2), bookFrame('f2', '1.1', '4', 0, 0.3, 0.4), bookFrame('f3', '1.1', '5', 0, 0.5, 0.6)]);
    const result = applyOperations(twice, [{ op: 'solution.set', id: '1.1:4', regions: [{ page: 5, rect: [0.1, 0.1, 0.4, 0.15] }] }], ctx);
    expect(result.project.frames.map((frame) => frame.solution?.length ?? 0)).toEqual([1, 0, 0]);
    // After the first one changes its number, the second is the one that has it.
    const moved = applyOperations(
      twice,
      [
        { op: 'label.set', id: 'f1', label: '9' },
        { op: 'solution.set', id: '1.1:4', regions: [{ page: 5, rect: [0.1, 0.1, 0.4, 0.15] }] },
        { op: 'solution.set', id: '1.1:9', regions: [{ page: 5, rect: [0.1, 0.2, 0.4, 0.25] }] },
      ],
      ctx,
    );
    expect(moved.project.frames.map((frame) => frame.solution?.length ?? 0)).toEqual([1, 1, 0]);
    expect(moved.project.frames.map((frame) => frame.solution?.[0]?.rect.top)).toEqual([0.2, 0.1, undefined]);
  });

  it('is only there during a batch: a lookup outside one scans the frames it is given, whatever happened before', () => {
    const project = start();
    const before = findFrame(project, '1.2:3');
    applyOperations(project, [{ op: 'section.set', id: '1.2:3', section: '2.1' }], ctx);
    expect(findFrame(project, '1.2:3')).toBe(before);
    expect(findFrame(project, '2.1:3')?.id).toBe('f15');
    expect(findFrame(project, 'f1')?.label).toBe('1');
    expect(findFrame(project, 'nope')).toBeUndefined();
    expect(findFrame(project, 'nowhere:1')).toBeUndefined();
  });

  it('is built once for a project that does not change, for a caller with thousands of references', () => {
    const project = start();
    const find = frameFinder(project);
    for (const frame of project.frames) {
      expect(find(frame.id)).toBe(frame);
      if (frame.authority === 'book') expect(find(`${frame.section}:${frame.label}`)).toBe(frame);
    }
    expect(find('f99')).toBeUndefined();
    expect(find('1.1:99')).toBeUndefined();
  });

  it('leaves the project it was given as it was', () => {
    const project = start();
    const snapshot = JSON.stringify(project);
    applyOperations(project, [{ op: 'solution.set', id: '1.1:1', regions: [] }, { op: 'label.set', id: '1.1:2', label: '7' }, { op: 'add', authority: 'book', label: '8', section: '1.1', page: 0, rect: [0.1, 0.1, 0.9, 0.2] }], ctx);
    expect(JSON.stringify(project)).toBe(snapshot);
  });
});
