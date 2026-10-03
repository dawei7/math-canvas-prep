import { describe, expect, it } from 'vitest';
import type { PageText } from '../src/model/types.js';
import { lintAgainstText, lintFrames } from '../src/rules/lint.js';
import { frame, rect } from './helpers.js';

const codes = (list: ReturnType<typeof lintFrames>): string[] => list.map((entry) => entry.code);

describe('warnings about frames', () => {
  it('warns when there are no frames', () => {
    expect(codes(lintFrames([]))).toEqual(['no-frames']);
  });

  it('accepts frames that only touch', () => {
    const list = [frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.3)), frame('b', 'exercise', 0, rect(0.1, 0.3, 0.9, 0.5))];
    expect(lintFrames(list)).toEqual([]);
  });

  it('warns about independent frames that overlap and about one inside another', () => {
    const overlap = lintFrames([frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.35)), frame('b', 'exercise', 0, rect(0.1, 0.25, 0.9, 0.5))]);
    expect(overlap).toMatchObject([{ severity: 'warning', code: 'overlap', frameId: 'a', data: { other: 'b' } }]);
    const inside = lintFrames([frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.5)), frame('b', 'question', 0, rect(0.2, 0.2, 0.8, 0.3))]);
    expect(inside).toMatchObject([{ code: 'contained', frameId: 'b', data: { other: 'a' } }]);
    expect(lintFrames([frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.5)), frame('b', 'exercise', 1, rect(0.2, 0.2, 0.8, 0.3))])).toEqual([]);
  });

  it('does not count parts of one unit, and notices a continuation that overlaps another frame', () => {
    const parts = [frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.3), { unit: 'u' }), frame('b', 'exercise', 0, rect(0.1, 0.3, 0.9, 0.5), { unit: 'u' })];
    expect(lintFrames(parts)).toEqual([]);
    const continues = lintFrames([
      frame('a', 'exercise', 0, rect(0.1, 0.8, 0.9, 0.95), { continues: [{ page: 1, rect: rect(0.1, 0.1, 0.9, 0.3) }] }),
      frame('b', 'question', 1, rect(0.1, 0.2, 0.9, 0.4)),
    ]);
    expect(codes(continues)).toEqual(['overlap']);
  });

  it('warns about a frame thinner than one line', () => {
    expect(codes(lintFrames([frame('a', 'bookmark', 0, rect(0.1, 0.1, 0.9, 0.112))]))).toEqual(['thin-frame']);
  });

  it('warns when the context lies on its own exercise', () => {
    const list = [frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.3), { context: [{ page: 0, rect: rect(0.1, 0.1, 0.9, 0.2) }] })];
    expect(codes(lintFrames(list))).toEqual(['context-overlaps-frame']);
    const away = [frame('a', 'exercise', 0, rect(0.1, 0.1, 0.9, 0.3), { context: [{ page: 1, rect: rect(0.1, 0.1, 0.9, 0.2) }] })];
    expect(lintFrames(away)).toEqual([]);
  });

  it('warns when the parts of one unit carry different context', () => {
    const list = [
      frame('a', 'exercise', 0, rect(0.1, 0.4, 0.9, 0.5), { unit: 'u', context: [{ page: 0, rect: rect(0.1, 0.1, 0.9, 0.2) }] }),
      frame('b', 'exercise', 0, rect(0.1, 0.5, 0.9, 0.6), { unit: 'u', context: [{ page: 0, rect: rect(0.1, 0.2, 0.9, 0.3) }] }),
    ];
    expect(codes(lintFrames(list))).toEqual(['unit-context-differs']);
    const same = list.map((entry) => ({ ...entry, context: [{ page: 0, rect: rect(0.1, 0.1, 0.9, 0.2) }] }));
    expect(lintFrames(same)).toEqual([]);
  });
});

describe('warnings that read the printed lines', () => {
  const page: PageText = {
    page: 0,
    size: { width: 595, height: 842, rotation: 0 },
    columns: 1,
    hasText: true,
    lines: [
      { text: 'Running header', rect: rect(0.1, 0.03, 0.5, 0.045), fontSize: 9, column: 0, chars: 12, headerFooter: true },
      { text: 'first line of text', rect: rect(0.1, 0.2, 0.9, 0.212), fontSize: 11, column: 0, chars: 15 },
      { text: 'second line of text', rect: rect(0.1, 0.22, 0.9, 0.232), fontSize: 11, column: 0, chars: 16 },
      { text: 'third line of text', rect: rect(0.1, 0.24, 0.9, 0.252), fontSize: 11, column: 0, chars: 15 },
    ],
  };
  const pages = new Map([[0, page]]);

  it('says where an edge cuts a line and what to do', () => {
    const issues = lintAgainstText([frame('a', 'exercise', 0, rect(0.1, 0.226, 0.9, 0.4))], pages);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'clips-line', frameId: 'a' });
    expect(issues[0]?.fix).toContain('--snap');
    expect(issues[0]?.message).toContain('second line of text');
    const bottom = lintAgainstText([frame('a', 'exercise', 0, rect(0.1, 0.19, 0.9, 0.2255))], pages);
    expect(bottom[0]?.data).toMatchObject({ edge: 'bottom' });
  });

  it('is quiet when the edges sit between lines', () => {
    expect(lintAgainstText([frame('a', 'exercise', 0, rect(0.1, 0.216, 0.9, 0.236))], pages)).toEqual([]);
  });

  it('warns when a frame includes a running header or footer', () => {
    const issues = lintAgainstText([frame('a', 'exercise', 0, rect(0.1, 0.02, 0.9, 0.215))], pages);
    expect(issues.map((entry) => entry.code)).toContain('includes-header-footer');
  });

  it('skips pages without a text layer and pages it was not given', () => {
    const scan = new Map([[0, { ...page, hasText: false, lines: [] }]]);
    expect(lintAgainstText([frame('a', 'exercise', 0, rect(0.1, 0.226, 0.9, 0.4))], scan)).toEqual([]);
    expect(lintAgainstText([frame('a', 'exercise', 1, rect(0.1, 0.226, 0.9, 0.4))], pages)).toEqual([]);
  });
});
