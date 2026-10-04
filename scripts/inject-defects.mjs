// A synthetic proof that the audit harness has teeth: a seeded set of defects of every kind is injected into the audited synthetic
// workbook (and into a three-page span), and `audit gate` must not pass for any of them and must name the exercise. The untouched
// projects must pass. Nothing of any real book is used.
//
//   node scripts/inject-defects.mjs [--seed N] [--per-type N] [--no-ink] [--json]
//
// Options
//   --seed N       the seed of the damage (default 20261004): the same seed damages the same exercises
//   --per-type N   damaged projects of each kind of defect (default 5)
//   --no-ink       do not run the pixel check of the edges (it needs the canvas; it is on by default)
//   --json         print the whole result as JSON
//
// Exit code: 0 when every injected defect stopped the gate and was named and the untouched projects passed, 1 otherwise.
// Run `npm run build` first. The rates per kind and what the checks cannot see are in docs/AUDIT_A_BOOK.md, "The gate".
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../packages/cli/dist/index.js';
import { PdfDocument, newProject } from '../packages/core/dist/index.js';
import { DEFECT_TYPES, INVISIBLE_DEFECTS, buildSpanBook, buildSyntheticBook, defectRates, evaluateDefects, injectDefects } from '../packages/core/dist/testing.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const seed = Number(option('seed', 20261004));
const perType = Number(option('per-type', 5));
const ink = !args.includes('--no-ink');
if (!Number.isInteger(seed) || !Number.isInteger(perType) || perType < 1) {
  console.error('usage: node scripts/inject-defects.mjs [--seed N] [--per-type N] [--no-ink] [--json]');
  process.exit(2);
}

const folders = [];
async function scratch() {
  const folder = await mkdtemp(join(tmpdir(), 'mcprep-defects-'));
  folders.push(folder);
  return folder;
}

try {
  // The workbook: audited with the real proposals, as `mcprep exercises propose --solutions --apply` does.
  const dir = await scratch();
  const book = buildSyntheticBook();
  await writeFile(join(dir, 'book.pdf'), book.pdf);
  for (const argv of [['init', 'book.pdf', '--title', 'Synthetic Algebra Workbook'], ['outline', 'derive', '--book', '--apply'], ['exercises', 'propose', '--solutions', '--apply']]) {
    let out = '';
    const code = await run([...argv, '--json'], { stdout: (text) => (out += text), stderr: () => undefined, stdin: async () => '', cwd: dir, env: {} });
    if (code !== 0) throw new Error(`mcprep ${argv.join(' ')} failed: ${out.slice(0, 300)}`);
  }
  const project = JSON.parse(await readFile(join(dir, 'book.mcprep.json'), 'utf8'));
  const workbook = await evaluateDefects(injectDefects(project, { on: 'workbook', seed, perType }), project, new Uint8Array(book.pdf), await scratch(), { ink });

  // The span: the project of a careful audit of three pages, built from the fixture.
  const span = buildSpanBook();
  const doc = await PdfDocument.fromBytes(span.pdf);
  const spanProject = { ...newProject({ pdf: { path: 'book.pdf', sha256: doc.sha256, bytes: doc.bytes, pageCount: span.pageCount }, title: 'Span' }), outline: { source: 'manual', entries: span.outline }, frames: span.frames };
  await doc.close();
  const spans = await evaluateDefects(injectDefects(spanProject, { on: 'span', seed }), spanProject, span.pdf, await scratch(), {});

  const results = [...workbook.results, ...spans.results];
  const rates = defectRates(results);
  const order = DEFECT_TYPES.map((entry) => entry.type);
  rates.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const clean = [workbook.clean, spans.clean];
  const failures = results.filter((result) => !result.caught || !result.named);
  const ok = failures.length === 0 && clean.every((entry) => !entry.caught && entry.named);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ seed, perType, ink, clean: clean.map((entry) => ({ id: entry.id, passed: !entry.caught, open: entry.open })), rates, failures: failures.map((entry) => ({ id: entry.id, description: entry.description, caught: entry.caught, named: entry.named, first: entry.finding ? `${entry.finding.code} ${entry.finding.ref}` : null })), cannotSee: INVISIBLE_DEFECTS }, null, 1));
  } else {
    const pad = (text, n) => String(text).padEnd(n);
    console.log(`Defect injection (seed ${seed}, ${perType} per kind, ink check ${ink ? 'on' : 'off'}): ${results.length} damaged projects.`);
    console.log(`${pad('defect', 26)} ${pad('injected', 9)} ${pad('stopped', 8)} ${pad('named', 6)} what`);
    for (const rate of rates) {
      const what = DEFECT_TYPES.find((entry) => entry.type === rate.type)?.what ?? '';
      console.log(`${pad(rate.type, 26)} ${pad(rate.injected, 9)} ${pad(rate.caught, 8)} ${pad(rate.named, 6)} ${what}`);
    }
    const total = (key) => rates.reduce((sum, rate) => sum + rate[key], 0);
    console.log(`${pad('all', 26)} ${pad(total('injected'), 9)} ${pad(total('caught'), 8)} ${pad(total('named'), 6)} (${Math.round((100 * total('named')) / Math.max(1, total('injected')))} percent named)`);
    console.log(`The untouched projects: ${clean.map((entry, index) => `${index === 0 ? 'workbook' : 'span'} ${entry.caught ? `NOT passed (${entry.open} open)` : 'passes'}`).join(', ')}.`);
    for (const failure of failures) console.log(`MISSED ${failure.id}: ${failure.description} -> ${failure.caught ? 'stopped but not named' : 'the gate passed'}${failure.finding ? ` (first open: ${failure.finding.code} ${failure.finding.ref})` : ''}`);
    console.log('What the checks cannot see:');
    for (const line of INVISIBLE_DEFECTS) console.log(`  - ${line}`);
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const folder of folders) await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
