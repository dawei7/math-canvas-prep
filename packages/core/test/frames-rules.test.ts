import { describe, expect, it } from 'vitest';
import { checkFrames, parseFrames, type CheckOptions } from '../src/rules/frames.js';
import { checkUnits } from '../src/rules/units.js';
import { frame, rect } from './helpers.js';

const strict: CheckOptions = { pageCount: 5, strictShapes: true };
const good = { id: 'f1', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } };

const codes = (raw: unknown, options = strict): string[] => parseFrames(raw, options).issues.map((entry) => `${entry.severity}:${entry.code}`);

describe('structure', () => {
  it('accepts a valid frame and an empty list', () => {
    expect(parseFrames([good], strict).issues).toEqual([]);
    expect(parseFrames([], strict)).toEqual({ frames: [], issues: [] });
  });

  it('rejects frames that are not a list or not objects', () => {
    expect(codes({})).toEqual(['error:frames-not-array']);
    expect(codes([5])).toEqual(['error:frame-not-object']);
    expect(codes([null])).toEqual(['error:frame-not-object']);
  });

  it('rejects bad and duplicate ids, naming the frame', () => {
    for (const id of [undefined, '', 'has space', 'a'.repeat(41), 'ü', 'a/b']) {
      const result = parseFrames([{ ...good, id }], strict);
      expect(result.issues.map((entry) => entry.code)).toContain('bad-id');
      expect(result.frames).toHaveLength(0);
    }
    expect(parseFrames([{ ...good, id: 'a'.repeat(40) }], strict).issues).toEqual([]);
    expect(parseFrames([{ ...good, id: 'A_z-9' }], strict).issues).toEqual([]);
    const duplicate = parseFrames([good, { ...good, rect: { left: 0.1, top: 0.5, right: 0.9, bottom: 0.6 } }], strict);
    expect(duplicate.issues[0]).toMatchObject({ severity: 'error', code: 'duplicate-id', frameId: 'f1' });
  });

  it('rejects an unknown kind', () => {
    expect(codes([{ ...good, kind: 'note' }])).toEqual(['error:bad-kind']);
    expect(codes([{ ...good, kind: undefined }])).toEqual(['error:bad-kind']);
  });

  it('checks the page: whole, zero-based and inside the document', () => {
    expect(codes([{ ...good, page: 4 }])).toEqual([]);
    expect(codes([{ ...good, page: 5 }])).toEqual(['error:page-out-of-range']);
    expect(codes([{ ...good, page: -1 }])).toEqual(['error:page-out-of-range']);
    expect(codes([{ ...good, page: 1.5 }])).toEqual(['error:bad-page']);
    expect(codes([{ ...good, page: '1' }])).toEqual(['error:bad-page']);
    const issue = parseFrames([{ ...good, page: 9 }], strict).issues[0];
    expect(issue?.message).toContain('5 pages');
    expect(issue?.fix).toContain('zero-based');
  });
});

describe('rectangles', () => {
  const withRect = (r: Record<string, unknown>): unknown[] => [{ ...good, rect: r }];

  it('requires the four numbers as an object in a bundle but is tolerant in a project', () => {
    expect(codes([{ ...good, rect: [0.1, 0.1, 0.9, 0.2] }])).toEqual(['error:bad-rect']);
    expect(codes([{ ...good, rect: '0.1,0.1,0.9,0.2' }])).toEqual(['error:bad-rect']);
    expect(codes([{ ...good, rect: [0.1, 0.1, 0.9, 0.2] }], { pageCount: 5 })).toEqual([]);
    expect(codes([{ ...good, rect: '0.1,0.1,0.9,0.2' }], { pageCount: 5 })).toEqual([]);
    expect(codes([{ ...good, rect: { left: 0.1 } }])).toEqual(['error:bad-rect']);
    expect(codes([{ ...good, rect: { left: '0.1', top: 0.1, right: 0.9, bottom: 0.2 } }])).toEqual(['error:bad-rect']);
    expect(codes([{ ...good, rect: undefined }])).toEqual(['error:bad-rect']);
  });

  it('clamps values slightly outside the page (up to 0.005) as a repair', () => {
    const result = parseFrames(withRect({ left: -0.005, top: 0.1, right: 1.005, bottom: 0.2 }), strict);
    expect(result.issues.map((entry) => entry.code)).toEqual(['rect-clamped', 'rect-clamped']);
    expect(result.issues.every((entry) => entry.severity === 'repair')).toBe(true);
    expect(result.frames[0]?.rect).toEqual({ left: 0, top: 0.1, right: 1, bottom: 0.2 });
  });

  it('rejects values further outside than 0.005', () => {
    expect(codes(withRect({ left: -0.0051, top: 0.1, right: 0.9, bottom: 0.2 }))).toEqual(['error:rect-off-page']);
    expect(codes(withRect({ left: 0.1, top: 0.1, right: 0.9, bottom: 1.0051 }))).toEqual(['error:rect-off-page']);
    expect(codes(withRect({ left: 0.1, top: 0.1, right: 90, bottom: 0.2 }))).toEqual(['error:rect-off-page']);
  });

  it('rejects an empty or inverted rect', () => {
    expect(codes(withRect({ left: 0.9, top: 0.1, right: 0.1, bottom: 0.2 }))).toEqual(['error:rect-inverted']);
    expect(codes(withRect({ left: 0.1, top: 0.2, right: 0.9, bottom: 0.2 }))).toEqual(['error:rect-inverted']);
  });

  it('enforces the minimum size of 0.02 x 0.01', () => {
    expect(codes(withRect({ left: 0.1, top: 0.1, right: 0.12, bottom: 0.11 }))).toEqual([]);
    expect(codes(withRect({ left: 0.1, top: 0.1, right: 0.1199, bottom: 0.2 }))).toEqual(['error:rect-too-small']);
    expect(codes(withRect({ left: 0.1, top: 0.1, right: 0.9, bottom: 0.1099 }))).toEqual(['error:rect-too-small']);
    const issue = parseFrames(withRect({ left: 0.1, top: 0.1, right: 0.9, bottom: 0.105 }), strict).issues[0];
    expect(issue?.frameId).toBe('f1');
    expect(issue?.fix).toContain('0.01');
  });
});

describe('continues and context', () => {
  const region = { page: 1, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } };

  it('allows up to 8 regions of each and rejects more', () => {
    const eight = Array.from({ length: 8 }, () => region);
    expect(codes([{ ...good, continues: eight }])).toEqual([]);
    expect(codes([{ ...good, context: eight }])).toEqual([]);
    const nine = Array.from({ length: 9 }, () => region);
    expect(codes([{ ...good, continues: nine }])).toEqual(['error:too-many-regions']);
    expect(codes([{ ...good, context: nine }])).toEqual(['error:too-many-regions']);
  });

  it('checks every region like a frame (page range, rect)', () => {
    expect(codes([{ ...good, continues: [{ page: 9, rect: region.rect }] }])).toEqual(['error:page-out-of-range']);
    expect(codes([{ ...good, context: [{ page: 1, rect: { left: 0.1, top: 0.1, right: 0.11, bottom: 0.2 } }] }])).toEqual(['error:rect-too-small']);
    expect(codes([{ ...good, context: [5] }])).toEqual(['error:bad-region']);
    expect(codes([{ ...good, context: 'x' }])).toEqual(['error:bad-regions']);
  });

  it('allows context only on exercises, and continues on any kind but not on parts', () => {
    expect(codes([{ ...good, kind: 'question', context: [region] }])).toEqual(['error:context-not-exercise']);
    expect(codes([{ ...good, kind: 'bookmark', context: [region] }])).toEqual(['error:context-not-exercise']);
    expect(codes([{ ...good, kind: 'question', continues: [region] }])).toEqual([]);
  });
});

describe('units (parts)', () => {
  const part = (id: string, top: number, bottom: number, extra: Record<string, unknown> = {}): unknown => ({
    id,
    kind: 'exercise',
    page: 0,
    rect: { left: 0.1, top, right: 0.9, bottom },
    unit: 'u1',
    ...extra,
  });

  it('accepts parts that tile exactly', () => {
    const result = parseFrames([part('a', 0.1, 0.3), part('b', 0.3, 0.5), part('c', 0.5, 0.7)], strict);
    expect(result.issues).toEqual([]);
  });

  it('accepts parts given in any order in the file', () => {
    expect(parseFrames([part('c', 0.5, 0.7), part('a', 0.1, 0.3), part('b', 0.3, 0.5)], strict).issues).toEqual([]);
  });

  it('only exercises can be parts, and parts cannot continue', () => {
    expect(codes([part('a', 0.1, 0.3, { kind: 'question' })])).toContain('error:unit-not-exercise');
    expect(codes([part('a', 0.1, 0.3, { continues: [{ page: 1, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } }] }), part('b', 0.3, 0.5)])).toContain('error:unit-continues');
    expect(codes([part('a', 0.1, 0.3, { unit: 'bad unit' })])).toContain('error:bad-unit');
  });

  it('rejects a gap between parts, naming the frame and the fix', () => {
    const result = parseFrames([part('a', 0.1, 0.3), part('b', 0.35, 0.5)], strict);
    const gap = result.issues.find((entry) => entry.code === 'unit-gap');
    expect(gap).toMatchObject({ severity: 'error', frameId: 'b', unit: 'u1', page: 0 });
    expect(gap?.fix).toContain('0.3');
  });

  it('rejects overlapping parts', () => {
    const result = parseFrames([part('a', 0.1, 0.35), part('b', 0.3, 0.5)], strict);
    expect(result.issues.find((entry) => entry.code === 'unit-overlap')).toMatchObject({ severity: 'error', frameId: 'b' });
  });

  it('rejects parts that do not share left and right (columns)', () => {
    const result = parseFrames([part('a', 0.1, 0.3), { ...(part('b', 0.3, 0.5) as object), rect: { left: 0.5, top: 0.3, right: 0.9, bottom: 0.5 } }], strict);
    expect(result.issues.find((entry) => entry.code === 'unit-edges')).toMatchObject({ severity: 'error', frameId: 'b' });
  });

  it('snaps deviations up to 0.002 and reports them as repairs', () => {
    const gap = parseFrames([part('a', 0.1, 0.3), part('b', 0.3015, 0.5)], strict);
    expect(gap.issues.map((entry) => `${entry.severity}:${entry.code}`)).toEqual(['repair:unit-snapped']);
    expect(gap.frames.find((entry) => entry.id === 'a')?.rect.bottom).toBe(0.3015);

    const overlap = parseFrames([part('a', 0.1, 0.3), part('b', 0.299, 0.5)], strict);
    expect(overlap.issues.map((entry) => entry.severity)).toEqual(['repair']);
    const a = overlap.frames.find((entry) => entry.id === 'a')?.rect.bottom as number;
    const b = overlap.frames.find((entry) => entry.id === 'b')?.rect.top as number;
    expect(a).toBe(b);
    expect(a).toBeCloseTo(0.2995);

    const edges = parseFrames([part('a', 0.1, 0.3), { ...(part('b', 0.3, 0.5) as object), rect: { left: 0.1015, top: 0.3, right: 0.8985, bottom: 0.5 } }], strict);
    expect(edges.issues.map((entry) => entry.severity)).toEqual(['repair']);
    expect(edges.frames.find((entry) => entry.id === 'b')?.rect.left).toBe(0.1);
  });

  it('accepts exactly 0.002 and rejects just above it', () => {
    expect(codes([part('a', 0.1, 0.3), part('b', 0.302, 0.5)])).toEqual(['repair:unit-snapped']);
    expect(codes([part('a', 0.1, 0.3), part('b', 0.3021, 0.5)])).toEqual(['error:unit-gap']);
    expect(codes([part('a', 0.1, 0.3), part('b', 0.298, 0.5)])).toEqual(['repair:unit-snapped']);
    expect(codes([part('a', 0.1, 0.3), part('b', 0.2979, 0.5)])).toEqual(['error:unit-overlap']);
  });

  it('judges every page separately: a unit may continue on another page', () => {
    const second = { ...(part('c', 0.1, 0.3) as object), page: 1 };
    expect(parseFrames([part('a', 0.1, 0.3), part('b', 0.3, 0.5), second], strict).issues).toEqual([]);
  });

  it('warns about a unit with a single frame', () => {
    const result = parseFrames([part('a', 0.1, 0.3)], strict);
    expect(result.issues).toMatchObject([{ severity: 'warning', code: 'unit-single', frameId: 'a' }]);
  });

  it('does not judge the tiling of a unit that has an unreadable member', () => {
    const result = parseFrames([part('a', 0.1, 0.3), part('b', 0.5, 0.6, { page: 99 })], strict);
    expect(result.issues.map((entry) => entry.code)).toEqual(['page-out-of-range']);
  });

  it('is available on typed frames too', () => {
    const typed = [frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.3), { unit: 'u' }), frame('b', 'exercise', 0, rect(0.1, 0.3, 0.9, 0.5), { unit: 'u' })];
    expect(checkFrames(typed, strict).issues).toEqual([]);
    expect(checkUnits(typed).issues).toEqual([]);
  });
});
