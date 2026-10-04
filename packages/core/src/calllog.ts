import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The log of the calls an agent makes, so that two runs can be compared (docs/AGENT_GUIDE.md, "Comparing two agent runs"). Every
 * call is one line of JSON, written after the call has returned, with the keys of every object in sorted order: the same call
 * gives the same line. The MCP server writes a line for each tool call (`--call-log FILE` or the environment variable
 * {@link CALL_LOG_ENV}); the command line writes one for each command when {@link CALL_LOG_ENV} is set. Arguments are logged
 * as they were given: paths as given, and never the contents of a PDF (a tool takes the path of one, not its bytes).
 */

export const CALL_LOG_ENV = 'MCPREP_CALL_LOG';

export interface CallLogEntry {
  /** Who was called: an MCP tool or a command of the command line. */
  surface: 'mcp' | 'cli';
  /** The tool (`exercises_propose`) or the command path (`exercises propose`). */
  tool: string;
  /** What the call was given: the tool's arguments, or the command's options as parsed (`_` holds the positional arguments). */
  arguments: Record<string, unknown>;
  /** The call returned a result (a tool that did not fail, a command with exit code 0). */
  ok: boolean;
  /** The code of the error when the call failed with one (`E_PAGE`). */
  error?: string;
  /** Command line only: the exit code. */
  exitCode?: number;
}

/** JSON with the keys of every object in sorted order (code-unit order) and no undefined values, so that equal calls give equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    if (typeof value === 'bigint') return JSON.stringify(String(value));
    return value === undefined || typeof value === 'function' || typeof value === 'symbol' ? 'null' : JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined && typeof record[key] !== 'function')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(',')}}`;
}

/** The line of the log for a call (without the line break). */
export function callLogLine(entry: CallLogEntry): string {
  return canonicalJson(entry);
}

/**
 * Appends the call to the log, creating the folder if it is missing. A log that cannot be written must never break the call it
 * is about: the reason is returned instead of thrown (undefined when the line was written).
 */
export async function appendCallLog(file: string, entry: CallLogEntry): Promise<string | undefined> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${callLogLine(entry)}\n`, 'utf8');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
