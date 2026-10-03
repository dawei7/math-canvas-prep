import type { Issue, ProjectSession } from '@mcprep/core';

/** Where the command line reads and writes; the real one is the process, tests use their own. */
export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of standard input (for `-`). */
  stdin(): Promise<string>;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface OptionSpec {
  /** Long name without dashes, e.g. `rect`. */
  name: string;
  short?: string;
  type: 'string' | 'number' | 'boolean';
  /** May be given several times. */
  multiple?: boolean;
  /** Placeholder shown in help: `<l,t,r,b>`. */
  value?: string;
  description: string;
  required?: boolean;
}

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Takes all remaining positionals. */
  variadic?: boolean;
}

export type OptionValues = Record<string, string | number | boolean | (string | number)[] | undefined>;

export interface CommandContext {
  options: OptionValues;
  args: string[];
  io: IO;
  /** The project this command works on (found from --project, MCPREP_PROJECT or the folder). */
  session(): Promise<ProjectSession>;
  /** Path of the project without opening it. */
  projectPath(): Promise<string>;
  readStdin(): Promise<string>;
  json: boolean;
}

/** What a command returns: the data (`result`), things worth saying, and a human rendering. */
export interface CommandOutput {
  result: unknown;
  /** Warnings and other issues to show next to the result (JSON: `warnings`). */
  warnings?: Issue[];
  /** Short plain sentences about what was done (JSON: `notes`). */
  notes?: string[];
  /** Plain text for people. */
  text: string;
  /** Exit code; default 0. */
  exitCode?: number;
}

export interface CommandSpec {
  /** `frames add`, `init`, ... */
  name: string;
  summary: string;
  /** Longer explanation for help and the docs. */
  description?: string;
  args?: ArgSpec[];
  options?: OptionSpec[];
  examples?: string[];
  /** What `result` holds in --json mode, as one sentence or a few lines. */
  output: string;
  /** True when the command needs no project (init, inspect-bundle, ...). */
  noProject?: boolean;
  /** True when the command writes the project file. */
  writes?: boolean;
  run(context: CommandContext): Promise<CommandOutput>;
}
