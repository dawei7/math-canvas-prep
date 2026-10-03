import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { ProjectSession } from '../src/session.js';
import type { Frame, FrameKind, Rect } from '../src/model/types.js';
import type { McPrepError } from '../src/rules/issues.js';
import { buildSampleSheet } from '../src/testing/sample.js';

const created: string[] = [];

/** A temporary folder that is removed after the test file. */
export async function tempDir(prefix = 'mcprep-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

export const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

export function frame(id: string, kind: FrameKind, page: number, area: Rect, extra: Partial<Frame> = {}): Frame {
  return { id, kind, page, rect: area, ...extra };
}

/** The synthetic sample as a PDF file and an open project next to it. */
export async function sampleProject(): Promise<{ dir: string; pdfPath: string; session: ProjectSession }> {
  const dir = await tempDir();
  const pdfPath = join(dir, 'sheet.pdf');
  await writeFile(pdfPath, buildSampleSheet().pdf);
  const session = await ProjectSession.create(pdfPath, { title: 'Calculus Sheet 1', folder: 'Examples/Calculus' });
  return { dir, pdfPath, session };
}

/** The error a promise rejects with (the test fails when it does not reject). */
export async function rejected(promise: Promise<unknown>): Promise<McPrepError> {
  try {
    await promise;
  } catch (error) {
    return error as McPrepError;
  }
  throw new Error('expected the promise to reject');
}
