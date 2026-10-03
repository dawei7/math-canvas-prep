import { McPrepError, VERSION, type ProjectSession } from '@mcprep/core';
import { closest, parseArguments, usage } from './args.js';
import { GLOBAL_OPTIONS } from './commands/common.js';
import { commandOptions, renderCommandHelp, renderTopHelp } from './help.js';
import { findProject, openSession } from './project.js';
import { COMMANDS } from './registry.js';
import type { CommandContext, CommandOutput, CommandSpec, IO } from './types.js';
import { issueLines } from './format.js';

export function realIO(): IO {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    cwd: process.cwd(),
    env: process.env,
  };
}

/** The exit code for an error: 2 usage, 3 a file cannot be used, 4 the data is not acceptable. */
export function exitCodeFor(error: McPrepError): number {
  const code = error.code;
  if (code === 'E_USAGE') return 2;
  if (/^E_(PROJECT|PDF|FILE|EXISTS|LOCK|CONFLICT|WRITE|NO_PROJECT|ASSET|ZIP)/.test(code) || code.startsWith('zip-')) return 3;
  return 4;
}

function findCommand(argv: readonly string[]): { spec?: CommandSpec; rest: string[]; word?: string } {
  const rest: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (words.length < 2 && !token.startsWith('-') && !(words.length === 0 && rest.length > 0 && false)) {
      words.push(token);
      continue;
    }
    rest.push(token);
    // A global option with a value: its value is not a command word.
    if ((token === '--project' || token === '-p') && argv[i + 1] !== undefined) {
      rest.push(argv[i + 1] as string);
      i += 1;
    }
  }
  const [first, second] = words;
  if (first === undefined) return { rest };
  const two = second !== undefined ? COMMANDS.find((spec) => spec.name === `${first} ${second}`) : undefined;
  if (two) return { spec: two, rest };
  const one = COMMANDS.find((spec) => spec.name === first);
  if (one) return { spec: one, rest: second !== undefined ? [second, ...rest] : rest };
  return { rest: [...words.slice(1), ...rest], word: first };
}

/** Positional words after the command name that were separated from the options by the command search. */
function orderedRest(argv: readonly string[], spec: CommandSpec): string[] {
  // Rebuild the original order of everything after the command name so that positionals and options stay in place.
  const name = spec.name.split(' ');
  const result: string[] = [];
  let skipped = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (skipped < name.length && token === name[skipped]) {
      skipped += 1;
      continue;
    }
    result.push(token);
    if ((token === '--project' || token === '-p') && argv[i + 1] !== undefined) {
      result.push(argv[i + 1] as string);
      i += 1;
    }
  }
  return result;
}

function envelope(command: string, output: CommandOutput, exitCode: number): string {
  return `${JSON.stringify({ ok: exitCode === 0, command, result: output.result, ...(output.warnings && output.warnings.length > 0 ? { warnings: output.warnings } : {}), ...(output.notes && output.notes.length > 0 ? { notes: output.notes } : {}) }, null, 2)}\n`;
}

function errorEnvelope(command: string, error: McPrepError): string {
  return `${JSON.stringify(
    {
      ok: false,
      command,
      error: { code: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}), ...(error.issues.length > 0 ? { issues: error.issues } : {}), ...(error.details !== undefined ? { details: error.details } : {}) },
    },
    null,
    2,
  )}\n`;
}

function errorText(error: McPrepError): string {
  const lines = [`mcprep: error [${error.code}] ${error.message}`];
  if (error.hint) lines.push(`  hint: ${error.hint}`);
  if (error.issues.length > 0) lines.push(...issueLines(error.issues, '  '));
  return `${lines.join('\n')}\n`;
}

/**
 * Runs one command line and returns the exit code. Nothing is read from a terminal and nothing prompts; with --json the
 * only thing written to standard output is one JSON document.
 */
export async function run(argv: readonly string[], io: IO = realIO()): Promise<number> {
  const wantsJson = argv.includes('--json');
  const found = findCommand(argv);

  if (argv.length === 0 || (found.spec === undefined && found.word === 'help')) {
    const topic = found.word === 'help' ? found.rest.filter((token) => !token.startsWith('-')) : [];
    if (topic.length > 0) {
      const spec = COMMANDS.find((candidate) => candidate.name === topic.join(' ')) ?? COMMANDS.find((candidate) => candidate.name === topic[0]);
      if (spec) {
        io.stdout(`${renderCommandHelp(spec)}\n`);
        return 0;
      }
      io.stderr(`mcprep: there is no command "${topic.join(' ')}".\n${renderTopHelp()}\n`);
      return 2;
    }
    io.stdout(`${renderTopHelp()}\n`);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout(wantsJson ? `${JSON.stringify({ ok: true, command: 'version', result: { version: VERSION } })}\n` : `${VERSION}\n`);
    return 0;
  }
  if (found.spec === undefined) {
    const name = found.word ?? '';
    const suggestion = closest(name, COMMANDS.flatMap((spec) => spec.name.split(' ')[0] as string));
    const error = usage(`Unknown command "${name}".`, suggestion ? `Did you mean \`mcprep ${suggestion}\`? Run \`mcprep help\` for the list.` : 'Run `mcprep help` for the list.');
    io.stderr(wantsJson ? '' : errorText(error));
    if (wantsJson) io.stdout(errorEnvelope(name, error));
    return 2;
  }

  const spec = found.spec;
  const command = spec.name;
  let session: ProjectSession | undefined;
  try {
    const known = commandOptions(spec);
    const globalsOnly = spec.noProject === true ? GLOBAL_OPTIONS.filter((option) => option.name === 'json' || option.name === 'help') : [];
    const parsed = parseArguments([...known, ...globalsOnly.filter((option) => !known.some((own) => own.name === option.name))], orderedRest(argv, spec), command);
    if (parsed.options['help'] === true) {
      io.stdout(`${renderCommandHelp(spec)}\n`);
      return 0;
    }
    const required = (spec.args ?? []).filter((arg) => arg.required === true).length;
    const max = (spec.args ?? []).some((arg) => arg.variadic === true) ? Number.POSITIVE_INFINITY : (spec.args ?? []).length;
    if (parsed.positionals.length < required) {
      const missing = (spec.args ?? [])[parsed.positionals.length];
      throw usage(`\`mcprep ${command}\` needs <${missing?.name ?? 'argument'}>.`, `Run \`mcprep help ${command}\` for the usage.`);
    }
    if (parsed.positionals.length > max) throw usage(`\`mcprep ${command}\` got an unexpected argument "${parsed.positionals[max]}".`, `Run \`mcprep help ${command}\` for the usage.`);
    const context: CommandContext = {
      options: parsed.options,
      args: parsed.positionals,
      io,
      json: parsed.options['json'] === true,
      session: async () => {
        session ??= await openSession(io, parsed.options);
        return session;
      },
      projectPath: () => findProject(io, parsed.options),
      readStdin: () => io.stdin(),
    };
    const output = await spec.run(context);
    const exitCode = output.exitCode ?? 0;
    if (context.json) io.stdout(envelope(command, output, exitCode));
    else {
      io.stdout(`${output.text}\n`);
    }
    return exitCode;
  } catch (error) {
    if (error instanceof McPrepError) {
      if (wantsJson) io.stdout(errorEnvelope(command, error));
      else io.stderr(errorText(error));
      return exitCodeFor(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new McPrepError('E_INTERNAL', `Unexpected error: ${message}`, { hint: 'This is a bug in mcprep. Re-run with MCPREP_DEBUG=1 for the stack trace and report it.' });
    if (wantsJson) io.stdout(errorEnvelope(command, wrapped));
    else io.stderr(errorText(wrapped) + (io.env['MCPREP_DEBUG'] && error instanceof Error ? `${error.stack ?? ''}\n` : ''));
    return 1;
  } finally {
    await session?.close();
  }
}
