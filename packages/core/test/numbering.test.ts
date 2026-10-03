import { describe, expect, it } from 'vitest';
import { compareReadingOrder, countFrames, numberFrames } from '../src/model/numbering.js';
import { frame, rect } from './helpers.js';

const labels = (frames: ReturnType<typeof frame>[]): Record<string, string> =>
  Object.fromEntries([...numberFrames(frames).values()].map((entry) => [entry.id, entry.label]));

describe('positional numbering (docs/BUNDLE_FORMAT.md, "Numbering is not stored")', () => {
  it('numbers by page, then top, then left, whatever the order in the file', () => {
    const frames = [
      frame('c', 'exercise', 1, rect(0.1, 0.1, 0.9, 0.2)),
      frame('b', 'exercise', 0, rect(0.1, 0.5, 0.9, 0.6)),
      frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2)),
      frame('d', 'exercise', 1, rect(0.5, 0.1, 0.9, 0.2)),
    ];
    expect(labels(frames)).toEqual({ a: 'E1', b: 'E2', c: 'E3', d: 'E4' });
  });

  it('numbers exercises, questions and bookmarks separately', () => {
    const frames = [
      frame('q2', 'question', 1, rect(0.1, 0.1, 0.9, 0.2)),
      frame('e1', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2)),
      frame('q1', 'question', 0, rect(0.1, 0.3, 0.9, 0.4)),
      frame('b1', 'bookmark', 0, rect(0.1, 0.5, 0.9, 0.6)),
      frame('b2', 'bookmark', 2, rect(0.1, 0.5, 0.9, 0.6)),
    ];
    expect(labels(frames)).toEqual({ e1: 'E1', q1: 'Q1', q2: 'Q2', b1: 'B1', b2: 'B2' });
  });

  it('counts the parts of one unit once, at the position of the first part', () => {
    const frames = [
      frame('x1', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2)),
      frame('p1', 'exercise', 0, rect(0.1, 0.3, 0.9, 0.4), { unit: 'u' }),
      frame('p2', 'exercise', 0, rect(0.1, 0.4, 0.9, 0.5), { unit: 'u' }),
      frame('p3', 'exercise', 0, rect(0.1, 0.5, 0.9, 0.6), { unit: 'u' }),
      frame('x2', 'exercise', 0, rect(0.1, 0.7, 0.9, 0.8)),
    ];
    expect(labels(frames)).toEqual({ x1: 'E1', p1: 'E2.1', p2: 'E2.2', p3: 'E2.3', x2: 'E3' });
    expect(countFrames(frames)).toEqual({ exercise: 3, question: 0, bookmark: 0 });
  });

  it('puts a unit that begins on a later page after the earlier exercises, parts running on across pages', () => {
    const frames = [
      frame('late', 'exercise', 2, rect(0.1, 0.1, 0.9, 0.2)),
      frame('p2', 'exercise', 1, rect(0.1, 0.1, 0.9, 0.3), { unit: 'u' }),
      frame('p1', 'exercise', 0, rect(0.1, 0.8, 0.9, 0.95), { unit: 'u' }),
      frame('mid', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2)),
    ];
    expect(labels(frames)).toEqual({ mid: 'E1', p1: 'E2.1', p2: 'E2.2', late: 'E3' });
  });

  it('treats a unit of one frame as an ordinary exercise', () => {
    expect(labels([frame('only', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2), { unit: 'u' })])).toEqual({ only: 'E1' });
  });

  it('exposes number, part and part count', () => {
    const frames = [
      frame('p1', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2), { unit: 'u' }),
      frame('p2', 'exercise', 0, rect(0.1, 0.2, 0.9, 0.3), { unit: 'u' }),
    ];
    const numbers = numberFrames(frames);
    expect(numbers.get('p2')).toEqual({ id: 'p2', kind: 'exercise', number: 1, part: 2, partCount: 2, label: 'E1.2' });
  });

  it('orders frames in exactly the same place by id so the order never wobbles', () => {
    const a = frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2));
    const b = frame('b', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.2));
    expect(compareReadingOrder(a, b)).toBeLessThan(0);
    expect(compareReadingOrder(b, a)).toBeGreaterThan(0);
    expect(compareReadingOrder(a, a)).toBe(0);
  });
});
