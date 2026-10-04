#!/usr/bin/env node
// Compares the call logs of two agent runs and says whether they made the same calls.
//
//   node scripts/compare-calls.mjs run-a.jsonl run-b.jsonl [--json] [--strict]
//
// A log is what `mcprep-mcp --call-log FILE` (or MCPREP_CALL_LOG) writes for every tool call and what the `mcprep` command line
// appends when MCPREP_CALL_LOG is set: one line of JSON per call, {"arguments":{...},"ok":true,"surface":"mcp","tool":"..."}.
// Two calls are the same when they are the same tool (or the command that does what the tool does) with the same arguments, after
// these changes: an absolute path becomes <path> and its last two segments; an MCP argument is renamed to the option or the
// positional argument of the command that takes it (`details_file` is `--details`, `sections` is `--section`); numbers, the
// comma lists, rectangles and regions are written one way; an option that is false is no option. Whether a call succeeded is only
// compared with --strict. The tools that carry the contents of a batch (apply_operations, set_outline) are compared by their
// contents when both logs come from one surface, and by their name only when one log is MCP and the other the command line.
//
// Exit code: 0 the same calls, 1 they differ, 2 a log cannot be read. docs/AGENT_GUIDE.md, "Comparing two agent runs".
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Each MCP tool and the command line command that does the same. `positional` lists the arguments of the tool that the command
 * takes as positional arguments, in order; `spread` is one that holds several of them (merge_frames: ids); `implied` are options
 * the command needs that the tool does not take (outline_derive_book is `outline derive --book`); `invert` names the options that
 * a tool turns off with a false argument (validate with text: false is `validate --no-text`); `rename` is a name that is not the
 * usual one; `content` are the arguments that carry the contents of a batch. A test checks the table against the live tool list
 * and the command registry, so that it cannot go stale.
 */
export const TOOLS = {
  create_project: { command: 'init', positional: ['pdf'], rename: { project: 'out' } },
  open_project: { command: 'info' },
  project_info: { command: 'info' },
  set_metadata: { command: 'meta' },
  get_page_lines: { command: 'lines', positional: ['page'] },
  render_page: { command: 'render', positional: ['page'] },
  render_crop: { command: 'crop', positional: ['frame'] },
  get_outline: { command: 'outline' },
  adopt_pdf_outline: { command: 'outline pdf', implied: { adopt: true } },
  derive_outline: { command: 'outline derive' },
  set_outline: { command: 'outline set', content: ['entries'] },
  clear_outline: { command: 'outline clear' },
  propose: { command: 'propose', invert: { bookmarks: 'no-bookmarks', graphics: 'no-graphics' } },
  list_frames: { command: 'frames list' },
  add_frame: { command: 'frames add' },
  update_frame: { command: 'frames update', positional: ['id'] },
  delete_frame: { command: 'frames delete', positional: ['id'] },
  move_frame: { command: 'frames move', positional: ['id'] },
  split_frame: { command: 'frames split', positional: ['id'] },
  merge_frames: { command: 'frames merge', spread: 'ids' },
  set_dividers: { command: 'frames dividers', positional: ['id'] },
  set_area: { command: 'frames area', positional: ['id'] },
  add_context: { command: 'context add', positional: ['id'] },
  remove_context: { command: 'context remove', positional: ['id'] },
  add_continuation: { command: 'continues add', positional: ['id'] },
  remove_continuation: { command: 'continues remove', positional: ['id'] },
  apply_operations: { command: 'frames apply', content: ['operations'] },
  validate: { command: 'validate', invert: { text: 'no-text' } },
  export_bundle: { command: 'export' },
  inspect_bundle: { command: 'inspect-bundle', positional: ['file'] },
  import_check: { command: 'import-check', positional: ['file'] },
  get_guide: { command: 'guide' },
  get_schema: { command: 'schema', positional: ['name'] },
  exercises_list: { command: 'exercises list' },
  exercises_add: { command: 'exercises add' },
  exercises_mark: { command: 'exercises mark', positional: ['id'] },
  exercises_unmark: { command: 'exercises unmark', positional: ['id'] },
  exercises_label: { command: 'exercises label', positional: ['id', 'label'] },
  exercises_section: { command: 'exercises section', positional: ['id', 'section'] },
  solution_add: { command: 'solution add', positional: ['id'] },
  solution_list: { command: 'solution list', positional: ['id'] },
  solution_remove: { command: 'solution remove', positional: ['id'] },
  book_show: { command: 'book show' },
  book_meta: { command: 'book meta' },
  book_export: { command: 'book export' },
  outline_add: { command: 'outline add' },
  outline_update: { command: 'outline update', positional: ['id'] },
  outline_delete: { command: 'outline delete', positional: ['id'] },
  outline_ids: { command: 'outline ids' },
  outline_derive_book: { command: 'outline derive', implied: { book: true } },
  exercises_propose: { command: 'exercises propose' },
  solutions_propose: { command: 'solutions propose' },
  exercises_verify: { command: 'exercises verify' },
  exercises_sample: { command: 'exercises sample' },
  book_compare: { command: 'book compare', positional: ['reference'] },
  exercises_sheets: { command: 'exercises sheets' },
  audit_gate: { command: 'audit gate' },
  audit_ack: { command: 'audit ack' },
};

/** The commands that take the contents of a batch from a file or standard input: their positional argument says nothing. */
const CONTENT_COMMANDS = new Set(Object.values(TOOLS).filter((entry) => entry.content).map((entry) => entry.command));

/** Argument names that are not the option's name once `_` is `-`. */
const ALIASES = { sections: 'section', 'item-patterns': 'item-pattern', 'ops-file': 'ops', 'details-file': 'details', 'out-file': 'out', 'crops-dir': 'crops', 'out-dir': 'out' };
/** Options that hold a number: `3` and `"3"` and `3.0` are one value. */
const NUMBERS = new Set(['page', 'pages', 'index', 'depth', 'dx', 'dy', 'top', 'first', 'at', 'max-side', 'scale', 'padding', 'grid', 'min-confidence', 'max-items', 'exercises', 'solutions', '$page']);
/** Options that hold a list written with commas on the command line. */
const LISTS = new Set(['section', 'ids', 'at', 'pages']);
/** Options that hold regions (`page:left,top,right,bottom`). */
const REGIONS = new Set(['context', 'continues', 'solution']);
/** What carries no meaning for the comparison: where the project is, and how the command line was told to find it. */
const IGNORED = new Set(['project', 'ignore-pdf-change', 'json', 'help']);

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** An absolute path as `<path>` and its last two segments (without the drive); anything else as it is. */
export function normalizePath(text) {
  if (!ABSOLUTE.test(text)) return text;
  const parts = text.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0])) parts.shift();
  return parts.length === 0 ? text : `<path>/${parts.slice(-2).join('/')}`;
}

const NUMERIC_TEXT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/** Numbers as text, without the noise (`0.10` is `0.1`). */
function numberText(value) {
  return String(Number(value));
}

function rectText(value) {
  let numbers;
  if (Array.isArray(value)) numbers = value;
  else if (value !== null && typeof value === 'object') numbers = [value.left, value.top, value.right, value.bottom];
  else numbers = String(value).trim().split(/[\s,;]+/);
  return numbers.map((entry) => (NUMERIC_TEXT.test(String(entry)) ? numberText(entry) : String(entry))).join(',');
}

function regionText(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return `${numberText(value.page)}:${rectText(value.rect)}`;
  const text = String(value);
  const colon = text.indexOf(':');
  return colon < 0 ? text : `${numberText(text.slice(0, colon))}:${rectText(text.slice(colon + 1))}`;
}

/** One value in its canonical form; undefined for a value that is no option at all (false, null). */
function canonicalValue(name, value) {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return true;
  if (name === 'rect') return rectText(value);
  if (REGIONS.has(name)) return (Array.isArray(value) ? value : [value]).map(regionText);
  if (LISTS.has(name)) {
    const items = (Array.isArray(value) ? value : String(value).split(',')).map((item) => (NUMBERS.has(name) && NUMERIC_TEXT.test(String(item)) ? numberText(item) : normalizePath(String(item).trim())));
    return name === 'section' ? [...new Set(items)].sort() : items;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(name, item));
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'object') return JSON.parse(JSON.stringify(value));
  const text = String(value);
  return NUMBERS.has(name) && NUMERIC_TEXT.test(text) ? numberText(text) : normalizePath(text);
}

const kebab = (name) => {
  const key = name.replace(/_/g, '-');
  return ALIASES[key] ?? key;
};

/**
 * The call in a form that is the same for an MCP tool and the command that does what it does: `{ command, args }`, where `args`
 * has the options by their command line names and the positional arguments as `$0`, `$1`, ... `cross` says that one log is MCP and
 * the other the command line, which cannot be compared by the contents of a batch.
 */
export function canonicalCall(entry, cross = false) {
  const given = entry.arguments !== null && typeof entry.arguments === 'object' ? entry.arguments : {};
  const args = {};
  let command = entry.tool;
  if (entry.surface === 'mcp') {
    const known = TOOLS[entry.tool];
    command = known ? known.command : entry.tool;
    const positional = known?.positional ?? [];
    const rename = known?.rename ?? {};
    for (const [name, value] of Object.entries(given)) {
      if (known?.content?.includes(name)) {
        if (!cross) args[name] = value;
        continue;
      }
      if (known?.spread === name && Array.isArray(value)) {
        value.forEach((item, at) => void (args[`$${at}`] = canonicalValue('$', item)));
        continue;
      }
      const at = positional.indexOf(name);
      if (at >= 0) {
        const canonical = canonicalValue(name === 'page' ? '$page' : name, value);
        if (canonical !== undefined) args[`$${at}`] = canonical;
        continue;
      }
      if (known?.invert && Object.hasOwn(known.invert, name)) {
        if (value === false) args[known.invert[name]] = true;
        continue;
      }
      const key = rename[name] ?? kebab(name);
      if (IGNORED.has(key)) continue;
      const canonical = canonicalValue(key, value);
      if (canonical !== undefined) args[key] = canonical;
    }
    for (const [name, value] of Object.entries(known?.implied ?? {})) args[name] = value;
  } else {
    for (const [name, value] of Object.entries(given)) {
      if (IGNORED.has(name) || name === 'argv') continue;
      if (name === '_') {
        if (CONTENT_COMMANDS.has(command) && cross) continue;
        (Array.isArray(value) ? value : [value]).forEach((item, at) => {
          const canonical = canonicalValue(at === 0 && ['lines', 'render'].includes(command) ? '$page' : '$', item);
          if (canonical !== undefined) args[`$${at}`] = canonical;
        });
        continue;
      }
      const canonical = canonicalValue(name, value);
      if (canonical !== undefined) args[name] = canonical;
    }
  }
  return { command, args };
}

const sortedJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
};

/** The lines of a log as calls; throws an Error that names the line when one is not a call. */
export function parseLog(text, name = 'the log') {
  const calls = [];
  text.split(/\r?\n/).forEach((line, at) => {
    if (line.trim() === '') return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`${name}, line ${at + 1}: not JSON`);
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.tool !== 'string') throw new Error(`${name}, line ${at + 1}: not a call (it has no "tool")`);
    calls.push({ surface: entry.surface === 'cli' ? 'cli' : 'mcp', tool: entry.tool, arguments: entry.arguments ?? {}, ok: entry.ok !== false, error: entry.error });
  });
  return calls;
}

/** What the call was, for a person: the tool as logged and the arguments in their canonical form. */
const describe = (call, canonical) => `${call.tool} ${sortedJson(canonical.args)}${call.ok ? '' : ` (failed${call.error ? `: ${call.error}` : ''})`}`;

/**
 * Compares two logs (arrays of calls from {@link parseLog}). Returns { identical, calls: { a, b }, divergence?, onlyInA, onlyInB,
 * outcomes } where `divergence` is the first place the sequences differ, `onlyInA` and `onlyInB` count what one log has more of
 * (by tool, as lists of { tool, count }), and `outcomes` lists the calls that were the same but succeeded in one run and failed in the other.
 */
export function compareCalls(a, b, options = {}) {
  const surfaces = new Set([...a, ...b].map((call) => call.surface));
  const cross = surfaces.size > 1;
  const prepare = (call) => {
    const canonical = canonicalCall(call, cross);
    return { call, canonical, key: sortedJson({ command: canonical.command, args: canonical.args }) };
  };
  const left = a.map(prepare);
  const right = b.map(prepare);
  let at = 0;
  while (at < left.length && at < right.length && left[at].key === right[at].key) at += 1;
  const outcomes = [];
  for (let i = 0; i < at; i += 1) if (left[i].call.ok !== right[i].call.ok) outcomes.push({ index: i + 1, tool: left[i].call.tool, a: left[i].call.ok, b: right[i].call.ok });

  const counts = (list) => {
    const map = new Map();
    for (const entry of list) map.set(entry.key, { count: (map.get(entry.key)?.count ?? 0) + 1, tool: entry.canonical.command });
    return map;
  };
  const inA = counts(left);
  const inB = counts(right);
  const surplus = (from, other) => {
    const byTool = new Map();
    for (const [key, { count, tool }] of from) {
      const extra = count - (other.get(key)?.count ?? 0);
      if (extra > 0) byTool.set(tool, (byTool.get(tool) ?? 0) + extra);
    }
    return [...byTool.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([tool, count]) => ({ tool, count }));
  };
  const identical = at === left.length && at === right.length && (options.strict !== true || outcomes.length === 0);
  const result = { identical, calls: { a: left.length, b: right.length }, onlyInA: surplus(inA, inB), onlyInB: surplus(inB, inA), outcomes };
  if (at < left.length || at < right.length) {
    result.divergence = {
      index: at + 1,
      a: left[at] ? describe(left[at].call, left[at].canonical) : null,
      b: right[at] ? describe(right[at].call, right[at].canonical) : null,
    };
  }
  return result;
}

const total = (list) => list.reduce((sum, entry) => sum + entry.count, 0);
const listed = (list) => list.map((entry) => `${entry.tool}${entry.count > 1 ? ` x${entry.count}` : ''}`).join(', ');

/** The report as text. */
export function formatComparison(result, names = ['A', 'B']) {
  const [a, b] = names;
  if (result.identical) return `identical: ${result.calls.a} calls`;
  const lines = [`different: ${a} made ${result.calls.a} calls, ${b} made ${result.calls.b}.`];
  if (result.divergence) {
    const { index, a: left, b: right } = result.divergence;
    lines.push(`first divergence at call ${index}:`, `  ${a}: ${left ?? '(no more calls)'}`, `  ${b}: ${right ?? '(no more calls)'}`);
  } else if (result.outcomes.length > 0) {
    lines.push('the calls are the same, but not their outcomes (--strict).');
  }
  lines.push(`only in ${a}: ${total(result.onlyInA)} calls${result.onlyInA.length > 0 ? ` (${listed(result.onlyInA)})` : ''}`);
  lines.push(`only in ${b}: ${total(result.onlyInB)} calls${result.onlyInB.length > 0 ? ` (${listed(result.onlyInB)})` : ''}`);
  if (result.outcomes.length > 0) lines.push(`the same call with another outcome (failed in one run only): ${result.outcomes.map((entry) => `${entry.index} ${entry.tool}`).join(', ')}`);
  return lines.join('\n');
}

function main(argv) {
  const files = argv.filter((arg) => !arg.startsWith('--'));
  const known = new Set(['--json', '--strict']);
  const unknown = argv.filter((arg) => arg.startsWith('--') && !known.has(arg));
  if (files.length !== 2 || unknown.length > 0) {
    process.stderr.write(`${unknown.length > 0 ? `Unknown option ${unknown[0]}.\n` : ''}Usage: node scripts/compare-calls.mjs <run-a.jsonl> <run-b.jsonl> [--json] [--strict]\n`);
    return 2;
  }
  let logs;
  try {
    logs = files.map((file) => parseLog(readFileSync(file, 'utf8'), file));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const result = compareCalls(logs[0], logs[1], { strict: argv.includes('--strict') });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${formatComparison(result, ['A', 'B'])}\n`);
  return result.identical ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
