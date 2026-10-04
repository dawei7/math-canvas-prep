import type { InkMap } from '../src/model/types.js';

/** A map of 1000 x 2000 pixels in which the given rows (page fractions) are dark between the given columns. */
export function mapWithInk(rows: readonly { from: number; to: number; left?: number; right?: number }[], width = 1000, height = 2000): InkMap {
  const stride = Math.ceil(width / 8);
  const bits = new Uint8Array(stride * height);
  for (const row of rows) {
    for (let y = Math.round(row.from * height); y < Math.round(row.to * height); y += 1) {
      for (let x = Math.round((row.left ?? 0) * width); x < Math.round((row.right ?? 1) * width); x += 1) bits[y * stride + (x >> 3)] = (bits[y * stride + (x >> 3)] as number) | (0x80 >> (x & 7));
    }
  }
  return { width, height, bits };
}
