import { McPrepError } from '@mcprep/core';
import type { OptionSpec, OptionValues } from './types.js';

/** A command line that cannot be understood: exit code 2. */
export function usage(message: string, hint?: string): McPrepError {
  return new McPrepError('E_USAGE', message, hint === undefined ? {} : { hint });
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = above;
    }
  }
  return row[b.length] as number;
}

export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const d = distance(word, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

export interface Parsed {
  options: OptionValues;
  positionals: string[];
}

const isNumber = (text: string): boolean => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text);

/**
 * A small, predictable parser: `--name value`, `--name=value`, `-s value`, boolean flags, repeatable options, `--` to end
 * the options, a lone `-` as a positional (standard input). A value may start with a dash (`--dy -0.05`).
 */
export function parseArguments(specs: readonly OptionSpec[], argv: readonly string[], command: string): Parsed {
  const byName = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }
  const options: OptionValues = {};
  const positionals: string[] = [];
  const store = (spec: OptionSpec, raw: string | true): void => {
    let value: string | number | boolean;
    if (spec.type === 'boolean') {
      value = raw === true ? true : !['false', '0', 'no'].includes(raw.toLowerCase());
    } else {
      if (raw === true) throw usage(`The option --${spec.name} needs a value.`, `Example: --${spec.name} ${spec.value ?? '<value>'}`);
      if (spec.type === 'number') {
        if (!isNumber(raw)) throw usage(`The option --${spec.name} needs a number, not "${raw}".`);
        value = Number(raw);
      } else value = raw;
    }
    if (spec.multiple === true) {
      const list = (options[spec.name] as (string | number)[] | undefined) ?? [];
      list.push(value as string | number);
      options[spec.name] = list;
    } else {
      options[spec.name] = value;
    }
  };
  let rest = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (rest || token === '-' || !token.startsWith('-') || isNumber(token)) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      rest = true;
      continue;
    }
    let spec: OptionSpec | undefined;
    let inline: string | undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      if (eq >= 0) inline = token.slice(eq + 1);
      spec = byName.get(name);
      if (!spec) {
        const suggestion = closest(name, [...byName.keys()]);
        throw usage(`Unknown option --${name} for \`mcprep ${command}\`.`, suggestion ? `Did you mean --${suggestion}?` : `Run \`mcprep help ${command}\` to see the options.`);
      }
    } else {
      const short = token.slice(1, 2);
      spec = byShort.get(short);
      if (!spec) {
        if (isNumber(token)) {
          positionals.push(token);
          continue;
        }
        throw usage(`Unknown option -${short} for \`mcprep ${command}\`.`, `Run \`mcprep help ${command}\` to see the options.`);
      }
      if (token.length > 2) inline = token.slice(2).replace(/^=/, '');
    }
    if (spec.type === 'boolean') {
      store(spec, inline ?? true);
    } else if (inline !== undefined) {
      store(spec, inline);
    } else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        throw usage(`The option --${spec.name} needs a value.`, `Example: --${spec.name} ${spec.value ?? '<value>'}`);
      }
      i += 1;
      store(spec, next);
    }
  }
  for (const spec of specs) {
    if (spec.required === true && options[spec.name] === undefined) {
      throw usage(`\`mcprep ${command}\` needs --${spec.name}${spec.value ? ` ${spec.value}` : ''}.`, `Run \`mcprep help ${command}\` for the usage.`);
    }
  }
  return { options, positionals };
}

export function stringOption(options: OptionValues, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

export function numberOption(options: OptionValues, name: string): number | undefined {
  const value = options[name];
  return typeof value === 'number' ? value : undefined;
}

export function flag(options: OptionValues, name: string): boolean {
  return options[name] === true;
}

export function listOption(options: OptionValues, name: string): string[] {
  const value = options[name];
  return Array.isArray(value) ? value.map(String) : [];
}

/** A zero-based page number from text. */
export function pageNumber(text: string, what = 'page'): number {
  if (!/^\d+$/.test(text)) throw usage(`The ${what} must be a whole number from 0 (pages are zero-based), not "${text}".`, 'The first page is 0.');
  return Number(text);
}

/** `1,2,5-7` as a list of zero-based pages. */
export function pageList(text: string): number[] {
  const pages = new Set<number>();
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const range = /^(\d+)-(\d+)$/.exec(trimmed);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) throw usage(`The page range "${trimmed}" runs backwards.`);
      for (let page = from; page <= to; page += 1) pages.add(page);
    } else pages.add(pageNumber(trimmed, 'page in the list'));
  }
  return [...pages].sort((a, b) => a - b);
}

/** `0.3,0.4` as numbers. */
export function numberList(text: string, what: string): number[] {
  const parts = text.split(/[\s,;]+/).filter((part) => part.length > 0);
  const numbers = parts.map(Number);
  if (parts.length === 0 || numbers.some((value) => !Number.isFinite(value))) {
    throw usage(`${what} must be numbers separated by commas, for example 0.3,0.45; got "${text}".`);
  }
  return numbers;
}
