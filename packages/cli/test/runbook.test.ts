import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGEABLE_CODES, NON_ACKNOWLEDGEABLE } from '@mcprep/core';
import { COMMANDS, commandOptions } from '../src/index.js';

const read = (name: string): string => readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');

/**
 * The runbook for an audit agent (docs/AGENT_RUNBOOK.md) is followed literally, so everything it names must exist: the commands and
 * their options, every finding code the tools can report and the list of what cannot be acknowledged. A command that is renamed, an
 * option that goes or a code that is added makes this test fail until the runbook says it too.
 */
const runbook = read('docs/AGENT_RUNBOOK.md');

/** Every `mcprep ...` command shown between backticks (a placeholder `mcprep ...` is not a command). */
function inlineCommands(markdown: string): string[] {
  return [...markdown.matchAll(/`(mcprep [^`]+)`/g)].map((match) => match[1] as string).filter((text) => !text.startsWith('mcprep ...'));
}

function specFor(words: string[]): (typeof COMMANDS)[number] | undefined {
  const two = COMMANDS.find((spec) => spec.name === `${words[0]} ${words[1]}`);
  return two ?? COMMANDS.find((spec) => spec.name === words[0]);
}

describe('the commands shown in docs/AGENT_RUNBOOK.md exist', () => {
  const shown = inlineCommands(runbook);

  it('shows commands at all', () => {
    expect(shown.length).toBeGreaterThan(30);
  });

  it('uses only known commands and options', () => {
    for (const text of shown) {
      const words = text.split(/\s+/).slice(1);
      const spec = specFor(words);
      expect(spec, `mcprep ${words.join(' ')}`).toBeDefined();
      const known = new Set(commandOptions(spec as NonNullable<typeof spec>).map((option) => option.name));
      known.add('json');
      for (const option of text.matchAll(/--([a-z][\w-]*)/g)) {
        expect(known.has(option[1] as string), `${text}: unknown option --${option[1] as string}`).toBe(true);
      }
    }
  });
});

describe('the finding codes in docs/AGENT_RUNBOOK.md', () => {
  const reportable = [...new Set([...Object.keys(NON_ACKNOWLEDGEABLE), ...ACKNOWLEDGEABLE_CODES])].filter((code) => !code.startsWith('reference-'));

  it('has a repair recipe for every code the tools report', () => {
    const table = runbook.slice(runbook.indexOf('## 7. Repair recipes'), runbook.indexOf('## 8.'));
    const missing = reportable.filter((code) => !table.includes(`\`${code}\``));
    expect(missing, 'codes without a row in the repair table').toEqual([]);
  });

  it('names the same codes as the tool as the ones that can never be acknowledged', () => {
    const start = runbook.indexOf('**B3. Acknowledging.**');
    const paragraph = runbook.slice(start, runbook.indexOf('**B4.**', start));
    const sentence = paragraph.slice(paragraph.indexOf('cannot be acknowledged at all'), paragraph.indexOf('repair them'));
    const named = [...sentence.matchAll(/`([a-z][a-z-]+)`/g)].map((match) => match[1] as string).sort();
    expect(named).toEqual(Object.keys(NON_ACKNOWLEDGEABLE).sort());
  });
});
