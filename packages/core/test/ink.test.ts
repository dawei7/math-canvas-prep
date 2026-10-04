import { describe, expect, it } from 'vitest';
import { INK_CLEAN, nearestWhiteRow, rowInk } from '../src/geometry/ink.js';
import { INK_MAP_SIDE } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import { buildSampleSheet } from '../src/testing/sample.js';
import { mapWithInk } from './ink-helpers.js';

describe('the ink of a page', () => {
  const map = mapWithInk([
    { from: 0.2, to: 0.21 },
    { from: 0.4, to: 0.41, left: 0.1, right: 0.3 },
  ]);

  it('measures how much of a row between two columns is dark', () => {
    expect(rowInk(map, 0.205, 0.1, 0.9)).toBe(1);
    expect(rowInk(map, 0.3, 0.1, 0.9)).toBe(0);
    // Only a part of the width: the second band covers columns 0.1 to 0.3 of the page.
    expect(rowInk(map, 0.405, 0.1, 0.5)).toBeGreaterThan(0.4);
    expect(rowInk(map, 0.405, 0.1, 0.5)).toBeLessThan(0.6);
    expect(rowInk(map, 0.405, 0.35, 0.9)).toBe(0);
  });

  it('sees ink in the rows next to the one asked for, so that an edge on the rim of a glyph counts', () => {
    // 0.2 is the first dark row; the row above it is white, but its neighbour below is not.
    expect(rowInk(map, 0.2 - 0.0005, 0.1, 0.9)).toBe(1);
    expect(rowInk(map, 0.2 - 0.002, 0.1, 0.9)).toBe(0);
  });

  it('finds the white row nearest to a position, and nothing when there is none', () => {
    const near = nearestWhiteRow(map, 0.2075, 0.19, 0.25, 0.1, 0.9);
    expect(near).toBeCloseTo(0.2105, 4);
    const above = nearestWhiteRow(map, 0.207, 0.15, 0.21, 0.1, 0.9);
    expect(above).toBeCloseTo(0.199, 3);
    expect(nearestWhiteRow(map, 0.205, 0.2005, 0.2095, 0.1, 0.9)).toBeUndefined();
    expect(INK_CLEAN).toBeGreaterThan(0);
  });

  it('is white where the columns do not reach the ink', () => {
    expect(nearestWhiteRow(map, 0.405, 0.4, 0.41, 0.4, 0.9)).toBeDefined();
    expect(rowInk(map, 0.405, 0.5, 0.5)).toBe(0);
  });
});

describe('the ink map of a page of a PDF', () => {
  it('draws the page at the size of an ink map and keeps text dark and the margin white', async () => {
    const doc = await PdfDocument.fromBytes(buildSampleSheet().pdf);
    try {
      const map = await doc.inkMap(0);
      expect(Math.max(map.width, map.height)).toBeGreaterThanOrEqual(INK_MAP_SIDE);
      expect(Math.max(map.width, map.height)).toBeLessThanOrEqual(INK_MAP_SIDE + 1);
      expect(map.bits).toHaveLength(Math.ceil(map.width / 8) * map.height);
      const text = await doc.pageText(0);
      const line = text.lines.find((entry) => entry.chars > 10);
      expect(line).toBeDefined();
      if (!line) return;
      const middle = (line.rect.top + line.rect.bottom) / 2;
      expect(rowInk(map, middle, line.rect.left, line.rect.right)).toBeGreaterThan(0.05);
      expect(rowInk(map, 0.005, 0, 1)).toBe(0);
      // The same map is returned the next time, and a page that is asked for with its text carries it.
      expect(await doc.inkMap(0)).toBe(map);
      const page = await doc.pageText(0, { inkMap: true });
      expect(page.inkMap).toBe(map);
      expect((await doc.pageText(0)).inkMap).toBeUndefined();
    } finally {
      await doc.close();
    }
  });
});
