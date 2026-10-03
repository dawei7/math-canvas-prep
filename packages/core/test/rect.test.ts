import { describe, expect, it } from 'vitest';
import {
  clampRect,
  containsRect,
  enlargeToMinimum,
  formatRect,
  intersection,
  isBelowMinimum,
  overlapOfSmaller,
  parseRect,
  rectArea,
  rectsEqual,
  roundNumber,
  roundRect,
  unionRect,
} from '../src/model/rect.js';
import { McPrepError } from '../src/rules/issues.js';
import { rect } from './helpers.js';

describe('parseRect', () => {
  const expected = rect(0.1, 0.2, 0.9, 0.5);

  it('reads an object, an array and a comma separated text', () => {
    expect(parseRect({ left: 0.1, top: 0.2, right: 0.9, bottom: 0.5 })).toEqual(expected);
    expect(parseRect([0.1, 0.2, 0.9, 0.5])).toEqual(expected);
    expect(parseRect('0.1,0.2,0.9,0.5')).toEqual(expected);
    expect(parseRect(' 0.1 , 0.2 ; 0.9 0.5 ')).toEqual(expected);
  });

  it('reads JSON text and numeric strings', () => {
    expect(parseRect('{"left":0.1,"top":0.2,"right":0.9,"bottom":0.5}')).toEqual(expected);
    expect(parseRect('[0.1,0.2,0.9,0.5]')).toEqual(expected);
    expect(parseRect(['0.1', '0.2', '0.9', '0.5'])).toEqual(expected);
  });

  it('rejects everything else with the accepted forms in the hint', () => {
    for (const bad of ['', '1,2,3', [1, 2, 3], { left: 1 }, null, 7, '0.1,a,0.9,0.5', [0.1, 0.2, 0.9, Number.NaN]]) {
      expect(() => parseRect(bad)).toThrow(McPrepError);
    }
    try {
      parseRect('nope');
    } catch (error) {
      expect((error as McPrepError).code).toBe('E_RECT');
      expect((error as McPrepError).hint).toContain('left,top,right,bottom');
    }
  });
});

describe('geometry helpers', () => {
  it('computes intersection, overlap and containment', () => {
    const a = rect(0, 0, 0.5, 0.5);
    const b = rect(0.25, 0.25, 0.75, 0.75);
    expect(intersection(a, b)).toEqual(rect(0.25, 0.25, 0.5, 0.5));
    expect(intersection(a, rect(0.6, 0.6, 0.9, 0.9))).toBeNull();
    expect(intersection(a, rect(0.5, 0, 0.9, 0.5))).toBeNull();
    expect(overlapOfSmaller(a, b)).toBeCloseTo(0.25);
    expect(containsRect(a, rect(0.1, 0.1, 0.4, 0.4))).toBe(true);
    expect(containsRect(a, b)).toBe(false);
    expect(containsRect(a, rect(0, 0, 0.501, 0.5), 0.002)).toBe(true);
  });

  it('rounds, clamps and compares', () => {
    expect(roundNumber(0.123456789)).toBe(0.12346);
    expect(roundNumber(-0.000001)).toBe(0);
    expect(Object.is(roundNumber(-0.000001), -0)).toBe(false);
    expect(roundRect(rect(0.1234567, 0.2, 0.3, 0.4)).left).toBe(0.12346);
    expect(clampRect(rect(-0.1, -0.2, 1.1, 1.2))).toEqual(rect(0, 0, 1, 1));
    expect(rectsEqual(rect(0, 0, 1, 1), rect(0, 0, 1.0000001, 1))).toBe(true);
    expect(rectsEqual(rect(0, 0, 1, 1), rect(0, 0, 1.01, 1))).toBe(false);
    expect(unionRect([rect(0.2, 0.2, 0.4, 0.4), rect(0.1, 0.3, 0.3, 0.9)])).toEqual(rect(0.1, 0.2, 0.4, 0.9));
    expect(unionRect([])).toBeNull();
    expect(rectArea(rect(0.1, 0.1, 0.3, 0.2))).toBeCloseTo(0.02);
    expect(formatRect(rect(0.08, 0.12, 0.92, 0.31))).toBe('0.08,0.12,0.92,0.31');
  });

  it('knows the minimum size of the format and enlarges around the centre', () => {
    expect(isBelowMinimum(rect(0.1, 0.1, 0.12, 0.11))).toBe(false);
    expect(isBelowMinimum(rect(0.1, 0.1, 0.1199, 0.11))).toBe(true);
    expect(isBelowMinimum(rect(0.1, 0.1, 0.5, 0.1099))).toBe(true);
    const grown = enlargeToMinimum(rect(0.5, 0.5, 0.505, 0.502));
    expect(isBelowMinimum(grown)).toBe(false);
    expect((grown.left + grown.right) / 2).toBeCloseTo(0.5025);
    const corner = enlargeToMinimum(rect(0.999, 0.999, 1, 1));
    expect(corner.right).toBeLessThanOrEqual(1);
    expect(corner.bottom).toBeLessThanOrEqual(1);
    expect(isBelowMinimum(corner)).toBe(false);
  });
});
