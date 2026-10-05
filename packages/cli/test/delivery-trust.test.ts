import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Core from '@mcprep/core';
import type { GateReport } from '@mcprep/core';
import { checkDelivery } from '../src/index.js';
import { complete, copyDelivery, laidOut, touchOneFrame, withAcknowledgement, type Delivered } from './delivered.js';

/**
 * What the check leaves to the gate. The gate is the one that says what perfect needs (it is changed by others: a survey, for one), so the
 * verdict of the check is built on `GateReport.perfect` and holds no copy of the rule; the options of the new run are made in one place. The
 * gate is wrapped here so that what it is given can be seen and what it says can be changed.
 */
const gate = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], change: undefined as ((report: GateReport, call: number) => GateReport) | undefined }));

vi.mock('@mcprep/core', async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  return {
    ...actual,
    runGate: async (...args: Parameters<typeof actual.runGate>) => {
      const done = await actual.runGate(...args);
      gate.calls.push({ ...(args[1] ?? {}) });
      return gate.change === undefined ? done : { ...done, report: gate.change(done.report, gate.calls.length) };
    },
  };
});

let perfect: Delivered;
let waiting: Delivered;

beforeAll(async () => {
  perfect = await laidOut('algebra');
  await complete(perfect);
  waiting = await withAcknowledgement(await laidOut('geometry'));
}, 120_000);

/** Runs the check with the gate as it is and a way to change what it says; what the gate was given and the calls it had are reset first. */
async function checked(d: Delivered, change?: (report: GateReport, call: number) => GateReport): ReturnType<typeof checkDelivery> {
  gate.calls.length = 0;
  gate.change = change;
  try {
    return await checkDelivery(d.book, { work: d.work });
  } finally {
    gate.change = undefined;
  }
}

/** The folders that this process made for the second run and has not removed (another test file runs in a process of its own). */
const leftovers = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith(`mcprep-check-${process.pid}-`));

describe('the options of the new run', () => {
  it('are made in one place: the pixel check, no bundle, the visual record and the survey that the certificate names when they are there', async () => {
    const d = await copyDelivery(perfect);
    const survey = join(d.folder, 'survey.json');
    await writeFile(survey, '[]');
    const path = join(d.folder, 'book.audit-gate.json');
    const certificate = JSON.parse(await readFile(path, 'utf8')) as { checks: Record<string, unknown> };
    certificate.checks['survey'] = { file: survey };
    await writeFile(path, JSON.stringify(certificate));
    const result = await checked(d);
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]).toEqual({ ink: true, bundle: false, visual: join(d.folder, 'visual'), survey });
    // The gate of this branch does not read a survey; one that does decides what it means for `perfect`.
    expect(result.status).toBe('PERFECT');

    // A survey that is not there is not given; the check says it is gone when the gate does not call the project perfect because of it.
    certificate.checks['survey'] = { file: join(d.folder, 'gone.json') };
    await writeFile(path, JSON.stringify(certificate));
    const gone = await checked(d, (report) => ({ ...report, perfect: false }));
    expect(gate.calls[0]).not.toHaveProperty('survey');
    expect(gone.status).toBe('MISMATCH');
    expect(gone.reasons[0]).toBe(`The certificate says perfect, but the re-run is not: the survey that the certificate names (${join(d.folder, 'gone.json')}) does not exist.`);

    // The reference of the queue, the sheets and the patterns of the certificate are given the same way.
    const reference = join(d.root, 'inbox', 'algebra.reference.json');
    await writeFile(reference, JSON.stringify({ sections: [{ label: '0.1', exercise_count: 70 }, { label: '0.2', exercise_count: 14 }, { label: '1.1', exercise_count: 12 }, { label: '1.2', exercise_count: 16 }] }));
    certificate.checks['survey'] = undefined;
    await writeFile(path, JSON.stringify({ ...certificate, itemPatterns: ['^Task\\s+(\\d+)'] }));
    await checkDelivery({ ...d.book, reference, referenceChapterOffset: 0 }, { work: d.work });
    const call = gate.calls[gate.calls.length - 1] as { itemPatterns?: RegExp[]; reference?: { file: string; sections: unknown[] } };
    expect(call.itemPatterns?.map((pattern) => pattern.source)).toEqual(['^Task\\s+(\\d+)']);
    expect(call.reference).toMatchObject({ file: reference });
    expect(call.reference?.sections).toHaveLength(4);
  });
});

describe('the verdict is built on what the gate says is perfect', () => {
  it('is not PERFECT when the gate does not call the project perfect, whatever else the check can see', async () => {
    const d = await copyDelivery(perfect);
    // The certificate says perfect, nothing the check knows is open, and the gate (which asks for more than it knew) is not content.
    const claimed = await checked(d, (report) => ({ ...report, perfect: false }));
    expect(claimed.status).toBe('MISMATCH');
    expect(claimed.reasons).toEqual(['The certificate says perfect, but the re-run is not (the gate does not call this project perfect now: mcprep audit gate --final says why).']);
    expect(claimed.rerun).toEqual({ passed: true, perfect: false });
    // A stale certificate: nothing to compare with, and the gate's word is still not perfect.
    const e = await copyDelivery(perfect);
    await touchOneFrame(e);
    const stale = await checked(e, (report) => ({ ...report, perfect: false }));
    expect(stale.status).toBe('NOT FINISHED');
    expect(stale.reasons[0]).toContain('The certificate is stale');
    expect(stale.reasons).toContain('The gate does not call this project perfect, and no check above says why: run mcprep audit gate --final to see what it asks for.');
    // And the same book with the gate as it is.
    expect((await checked(d)).status).toBe('PERFECT');
  });

  it('asks the gate whether the project would be perfect with the notes confirmed, on a copy outside the work folder that is removed again', async () => {
    const before = leftovers();
    const d = await copyDelivery(waiting);
    const plain = await checked(d);
    expect(plain.status).toBe('AWAITING CONFIRMATION');
    // One run for the notes as they are, one for the notes confirmed, with the same options.
    expect(gate.calls).toHaveLength(2);
    expect(gate.calls[1]).toEqual(gate.calls[0]);
    expect(leftovers()).toEqual(before);
    // The gate says no even with the notes confirmed: the check says what waits and that this is not all.
    const more = await checked(d, (report, call) => (call === 2 ? { ...report, perfect: false } : report));
    expect(more.status).toBe('NOT FINISHED');
    expect(more.reasons).toHaveLength(2);
    expect(more.reasons[0]).toContain('1 acknowledgement waits for a second reviewer');
    expect(more.reasons[1]).toBe('Even with every acknowledgement confirmed the gate would not call this project perfect: run mcprep audit gate --final to see what else it asks for.');
    expect(leftovers()).toEqual(before);
    // A project with nothing waiting is asked once.
    await checked(perfect);
    expect(gate.calls).toHaveLength(1);
  });
});
