import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, commandOptions } from '../src/index.js';
import { workspace } from './helpers.js';

const read = (name: string): string => readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');

/** Splits a command line into words, keeping quoted text together. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? (match[3] as string));
}

/** Every `mcprep ...` command shown in a document (console blocks and indented examples). */
function commandsIn(markdown: string): string[][] {
  const found: string[][] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^\$ /, '').trim();
    if (!line.startsWith('mcprep ')) continue;
    for (const segment of line.split('&&')) {
      const text = segment.split(' #')[0]?.trim() ?? '';
      if (text.startsWith('mcprep ')) found.push(words(text).slice(1));
    }
  }
  return found;
}

function specFor(tokens: string[]): (typeof COMMANDS)[number] | undefined {
  const two = COMMANDS.find((spec) => spec.name === `${tokens[0]} ${tokens[1]}`);
  return two ?? COMMANDS.find((spec) => spec.name === tokens[0]);
}

describe.each(['docs/AGENT_GUIDE.md', 'README.md', 'docs/CLI.md'])('the commands shown in %s exist', (file) => {
  it('uses only known commands and options', () => {
    const shown = commandsIn(read(file));
    for (const tokens of shown) {
      if (['help', 'guide', 'schema'].includes(tokens[0] as string) || tokens[0]?.startsWith('<')) continue;
      const spec = specFor(tokens);
      expect(spec, `mcprep ${tokens.join(' ')}`).toBeDefined();
      const known = new Set(commandOptions(spec as NonNullable<typeof spec>).map((option) => option.name));
      known.add('json');
      for (const token of tokens) {
        if (!token.startsWith('--')) continue;
        const name = token.slice(2).split('=')[0] as string;
        expect(known.has(name), `mcprep ${tokens.join(' ')}: unknown option --${name}`).toBe(true);
      }
    }
  });
});

describe('the agent guide', () => {
  it('has a batch example that applies cleanly to the sample', async () => {
    const guide = read('docs/AGENT_GUIDE.md');
    const marker = guide.indexOf('<!-- test:batch -->');
    expect(marker).toBeGreaterThan(0);
    const fence = guide.indexOf('```json', marker);
    const end = guide.indexOf('```', fence + 7);
    const batch = guide.slice(fence + 7, end).trim();
    const cli = await workspace();
    const applied = await cli(['frames', 'apply', '-'], { stdin: batch });
    expect(applied.code, applied.stdout).toBe(0);
    expect(applied.json.result).toMatchObject({ applied: true, validation: { ok: true } });
    expect((applied.json.warnings ?? []).length).toBe(0);
    const labels = (applied.json.result.frames as { label: string }[]).map((frame) => frame.label);
    expect(labels).toEqual(['E1', 'E2', 'B1']);
  });

  it('is the text that `mcprep guide` prints, and mentions every command it relies on', async () => {
    const cli = await workspace({ init: false });
    const printed = await cli(['guide']);
    expect(printed.code).toBe(0);
    expect(printed.json.result.markdown).toBe(read('docs/AGENT_GUIDE.md'));
    const guide = read('docs/AGENT_GUIDE.md');
    for (const needed of ['zero-based', 'top-left', 'frames split', 'context add', 'continues add', 'crop --all', 'import-check', 'Checklist']) {
      expect(guide).toContain(needed);
    }
  });
});
