import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { McPrepError, PROJECT_SUFFIX, ProjectSession } from '@mcprep/core';
import type { IO, OptionValues } from './types.js';

async function projectsIn(folder: string): Promise<string[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(PROJECT_SUFFIX)).sort();
}

/**
 * Which project a command works on: `--project <file or folder>`, else the environment variable MCPREP_PROJECT, else the
 * only `*.mcprep.json` in the current folder.
 */
export async function findProject(io: IO, options: OptionValues): Promise<string> {
  const given = (typeof options['project'] === 'string' ? options['project'] : undefined) ?? io.env['MCPREP_PROJECT'];
  if (given !== undefined && given !== '') {
    const path = isAbsolute(given) ? given : resolve(io.cwd, given);
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      const found = await projectsIn(path);
      if (found.length === 1) return join(path, found[0] as string);
      throw new McPrepError('E_NO_PROJECT', found.length === 0 ? `There is no ${PROJECT_SUFFIX} file in "${path}".` : `There are several projects in "${path}": ${found.join(', ')}.`, {
        hint: 'Pass the project file itself with --project.',
      });
    }
    return path;
  }
  const found = await projectsIn(io.cwd);
  if (found.length === 1) return join(io.cwd, found[0] as string);
  if (found.length === 0) {
    throw new McPrepError('E_NO_PROJECT', `There is no ${PROJECT_SUFFIX} file in "${io.cwd}".`, {
      hint: 'Create one with `mcprep init <pdf>`, or pass --project <file>, or set MCPREP_PROJECT.',
    });
  }
  throw new McPrepError('E_NO_PROJECT', `There are several projects here: ${found.join(', ')}.`, { hint: 'Say which one with --project <file>.' });
}

export async function openSession(io: IO, options: OptionValues): Promise<ProjectSession> {
  return ProjectSession.open(await findProject(io, options), { ignorePdfChange: options['ignore-pdf-change'] === true });
}
