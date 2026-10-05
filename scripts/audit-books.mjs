// Audit several books in one go.
//
//   node scripts/audit-books.mjs <inbox-folder | queue.json> --out <results-folder> [--only NAME[,NAME]] [--sample N]
//   npm run audit-books -- <inbox-folder | queue.json> --out <results-folder>
//
// Folder mode: every *.pdf in the folder (not the folders in it) is a book, named by its file; a sidecar `<name>.meta.json` beside
// it says what is known about the book (title, author, series, description, license { name, url }, sourceUrl, notice, folder,
// options { chapterWords, practiceWords, answerWords, itemPattern, instructions }, maxItems, reference, referenceChapterOffset).
// Queue mode: a JSON file { "books": [ { "pdf": "relative/or/absolute.pdf", "name"?, ...the same fields } ] } with paths relative to
// the file. For every book scripts/acceptance-book.mjs is run as a child process (the results of a book go to <results>/<name>/,
// its output to <results>/<name>/run.log); a book that fails does not stop the others. <results>/INDEX.md has a row per book, what
// to look at, and what to do next. The exit code is 1 when a book failed or could not be read, else 0.
//
// The author, the licence and the notice are optional: a book without them is processed like any other (INDEX.md mentions it in one
// line). They are what the sidecar says and are never taken from the book by themselves. A bundle holds the whole book, so keep it
// private; nothing is uploaded.
//
// What is checked and written lives in packages/cli/src/audit-queue.ts (tested); this file only runs the books. Run `npm run build` first.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceArguments, formatSeconds, indexMarkdown, licenseStated, loadQueue, parseSummary } from '../packages/cli/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const acceptanceScript = join(here, 'acceptance-book.mjs');
const USAGE = 'usage: node scripts/audit-books.mjs <inbox-folder | queue.json> --out <results-folder> [--only NAME[,NAME]] [--sample N]';

const positional = [];
const options = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (arg.startsWith('--')) {
    const value = argv[(i += 1)];
    if (value === undefined) {
      console.error(`${arg} needs a value\n${USAGE}`);
      process.exit(2);
    }
    options.set(arg.slice(2), value);
  } else positional.push(arg);
}
const [source] = positional;
if (!source || !options.has('out') || positional.length > 1) {
  console.error(USAGE);
  process.exit(2);
}
for (const name of options.keys()) {
  if (!['out', 'only', 'sample'].includes(name)) {
    console.error(`unknown option --${name}\n${USAGE}`);
    process.exit(2);
  }
}
const sample = options.has('sample') ? Number(options.get('sample')) : undefined;
if (sample !== undefined && (!Number.isInteger(sample) || sample < 1)) {
  console.error('--sample must be a whole number of at least 1');
  process.exit(2);
}
const resultsDir = resolve(options.get('out'));

const queue = await loadQueue(source);
const everyName = [...queue.books.map((book) => book.name), ...queue.problems.map((problem) => problem.name)];
let only;
if (options.has('only')) {
  only = new Set(options.get('only').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  const known = new Set(everyName.map((name) => name.toLowerCase()));
  const unknown = [...only].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    console.error(`no such book: ${unknown.join(', ')}. The books are ${everyName.join(', ') || '(none)'}.`);
    process.exit(2);
  }
}
const selected = (name) => only === undefined || only.has(name.toLowerCase());

console.log(`${queue.books.length + queue.problems.length} book${queue.books.length + queue.problems.length === 1 ? '' : 's'} in ${queue.source}; results go to ${resultsDir}`);
for (const warning of queue.warnings) console.log(`note: ${warning}`);
await mkdir(resultsDir, { recursive: true });

/** Runs the acceptance script for a book; resolves with the exit code and the last line it printed. The whole output goes to run.log. */
function runBook(book, outDir) {
  return new Promise((resolveRun) => {
    const log = createWriteStream(join(outDir, 'run.log'));
    const child = spawn(process.execPath, [acceptanceScript, ...acceptanceArguments(book, { outDir, ...(sample !== undefined ? { sample } : {}) })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const tee = (stream) => {
      let pending = '';
      stream.on('data', (chunk) => {
        log.write(chunk);
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          last = line.trim();
          console.log(`  ${line}`);
        }
      });
      stream.on('end', () => {
        if (pending.trim() !== '') {
          last = pending.trim();
          console.log(`  ${pending}`);
        }
      });
    };
    tee(child.stdout);
    tee(child.stderr);
    child.on('error', (error) => {
      log.end();
      resolveRun({ code: -1, last: error.message });
    });
    child.on('close', (code) => {
      log.end(() => resolveRun({ code: code ?? -1, last }));
    });
  });
}

const rows = [];
let failures = queue.problems.filter((problem) => selected(problem.name)).length;
const total = queue.books.filter((book) => selected(book.name)).length;
let position = 0;
for (const book of queue.books) {
  const outDir = join(resultsDir, book.name);
  if (!selected(book.name)) {
    // Not run now: what an earlier run found stays in the index.
    try {
      const earlier = parseSummary(JSON.parse(await readFile(join(outDir, 'acceptance-summary.json'), 'utf8'))).summary;
      if (earlier) rows.push({ name: book.name, status: 'ok', summary: earlier, seconds: earlier.seconds, folder: book.name, licenseStated: earlier.licenseStated });
    } catch {
      // never run: no row
    }
    continue;
  }
  position += 1;
  console.log(`[${position}/${total}] ${book.name}`);
  await mkdir(outDir, { recursive: true });
  await rm(join(outDir, 'acceptance-summary.json'), { force: true });
  const started = Date.now();
  const done = await runBook(book, outDir);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  let row;
  if (done.code !== 0) {
    row = { name: book.name, status: 'failed', reason: `the script stopped (exit ${done.code}): ${done.last || 'no output'}`.slice(0, 300), seconds, folder: book.name, licenseStated: licenseStated(book) };
    console.log(`  FAILED after ${formatSeconds(seconds)}; see ${join(outDir, 'run.log')}`);
  } else {
    try {
      const parsed = parseSummary(JSON.parse(await readFile(join(outDir, 'acceptance-summary.json'), 'utf8')));
      if (!parsed.summary) throw new Error(parsed.problem);
      row = { name: book.name, status: 'ok', summary: parsed.summary, seconds, folder: book.name, licenseStated: parsed.summary.licenseStated };
    } catch (error) {
      row = { name: book.name, status: 'failed', reason: `no usable summary: ${error.message}`, seconds, folder: book.name, licenseStated: licenseStated(book) };
    }
  }
  if (row.status === 'failed') failures += 1;
  rows.push(row);
}
for (const problem of queue.problems) {
  if (!selected(problem.name)) continue;
  console.log(`not run: ${problem.name}: ${problem.message}`);
  rows.push({ name: problem.name, status: 'not run', reason: problem.message, seconds: 0, folder: problem.name });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const index = join(resultsDir, 'INDEX.md');
await writeFile(index, indexMarkdown({ generatedAt: new Date(), source: queue.source, outDir: resultsDir, rows, warnings: queue.warnings }));
console.log('');
for (const row of rows) {
  const summary = row.summary;
  if (!summary) console.log(`${row.name}: ${row.status === 'not run' ? 'NOT RUN' : 'FAILED'}: ${row.reason ?? ''}`);
  else {
    console.log(
      `${row.name}: ${summary.sections} sections, ${summary.exercises} exercises, ${summary.withSolution} with an answer, validation ${summary.validation.ok ? 'ok' : 'ERRORS'} (${summary.validation.errors} errors, ${summary.validation.warnings} warnings), importer ${summary.importCheck?.wouldImport ? 'accepts' : 'REJECTS'}${summary.licenseStated ? `, licence ${summary.license?.name}` : ''}, ${formatSeconds(row.seconds)}`,
    );
  }
}
console.log(`INDEX: ${index}${failures > 0 ? ` (${failures} book${failures === 1 ? '' : 's'} failed or not run)` : ''}`);
process.exit(failures > 0 ? 1 : 0);
