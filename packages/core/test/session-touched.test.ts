import { describe, expect, it } from 'vitest';
import { sampleProject } from './helpers.js';

describe('a change reads the printed lines of the pages it touches', () => {
  it('reports a cut line on the page of the new frame, and leaves other pages to validate', async () => {
    const { session } = await sampleProject();
    // On page 0 the first line of exercise 1 spans 0.2257 to 0.2403: an edge at 0.23 cuts through it.
    const first = await session.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.23, 0.9, 0.34] }], { modifiedBy: 'test' });
    expect(first.applied).toBe(true);
    expect(first.validation.warnings.map((entry) => entry.code)).toContain('clips-line');

    // A clean frame on another page: the cut line of page 0 is not this change's business...
    const second = await session.apply([{ op: 'add', kind: 'bookmark', page: 2, rect: [0.1, 0.19, 0.9, 0.26] }], { modifiedBy: 'test' });
    expect(second.applied).toBe(true);
    expect(second.validation.warnings.map((entry) => entry.code)).not.toContain('clips-line');
    // ...but validate looks at every page.
    const all = await session.validate();
    expect(all.warnings.map((entry) => `${entry.code}:${entry.frameId}`)).toContain('clips-line:f1');
    await session.close();
  });

  it('still refuses a change that introduces an error, and compares errors by what they say', async () => {
    const { session } = await sampleProject();
    const forced = await session.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.4], unit: 'u1' }, { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.45, 0.9, 0.5], unit: 'u1' }], { modifiedBy: 'test', force: true });
    expect(forced.applied).toBe(true);
    expect(forced.validation.errors.map((entry) => entry.code)).toContain('unit-gap');
    // The error that is there already is not "introduced" by an unrelated change; a new one is.
    const unrelated = await session.apply([{ op: 'add', kind: 'bookmark', page: 2, rect: [0.1, 0.19, 0.9, 0.26] }], { modifiedBy: 'test' });
    expect(unrelated.rejected).toBe(false);
    expect(unrelated.introduced).toEqual([]);
    const worse = await session.apply([{ op: 'add', kind: 'exercise', page: 1, rect: [0.1, 0.3, 0.9, 0.4], unit: 'u2' }, { op: 'add', kind: 'exercise', page: 1, rect: [0.1, 0.5, 0.9, 0.6], unit: 'u2' }], { modifiedBy: 'test' });
    expect(worse.rejected).toBe(true);
    expect(worse.introduced.map((entry) => entry.code)).toEqual(['unit-gap']);
    await session.close();
  });
});
