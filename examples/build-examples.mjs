// Builds the examples of this repository from scratch, with the tools themselves:
//
//   examples/sample.pdf         a synthetic three-page exercise sheet (generated here, nothing real)
//   examples/sample.mcprep.json the project after marking it
//   examples/sample.mcbundle    the exported bundle
//   examples/batch.json         the operations `mcprep propose --ops` wrote
//   examples/agent-session.md   a transcript of that session: every command and its real output
//
// Run it after `npm run build`:   node examples/build-examples.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { buildSampleSheet } = await import('../packages/core/dist/testing.js');
const { parseProject, serializeProject } = await import('../packages/core/dist/index.js');
const { run } = await import('../packages/cli/dist/index.js');

for (const name of ['sample.pdf', 'sample.mcprep.json', 'sample.mcbundle', 'batch.json', 'agent-session.md']) rmSync(join(here, name), { force: true });
rmSync(join(here, '.mcprep-cache'), { recursive: true, force: true });
mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'sample.pdf'), buildSampleSheet().pdf);

const FIXED_TIME = '2026-10-03T12:00:00Z';
const transcript = [];

function quote(argument) {
  return /[\s"'\\]/.test(argument) || argument === '' ? JSON.stringify(argument) : argument;
}

/** Runs one command in this folder; the transcript gets the command line, its output and its exit code. */
async function step(title, args, options = {}) {
  let out = '';
  let err = '';
  const code = await run(args, {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    stdin: () => Promise.resolve(''),
    cwd: here,
    env: { SOURCE_DATE_EPOCH: undefined },
  });
  // Paths shortened to ".", the same on every platform; times fixed, so that rebuilding gives the same transcript.
  const clean = (text) =>
    text
      .split(here)
      .join('.')
      .split(here.replaceAll('\\', '/'))
      .join('.')
      .replaceAll('\\', '/')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, FIXED_TIME);
  let shown = clean(out + err).trimEnd();
  if (options.keep) shown = options.keep(shown);
  if (options.lines) {
    const all = shown.split('\n');
    shown = all.length > options.lines ? `${all.slice(0, options.lines).join('\n')}\n... (${all.length - options.lines} more lines)` : shown;
  }
  transcript.push({ title, command: `mcprep ${args.map(quote).join(' ')}`, output: shown, code, note: options.note });
  if (code !== 0 && !options.allowFailure) throw new Error(`step failed: mcprep ${args.join(' ')}\n${out}${err}`);
  return { out, err, code };
}

await step('Create a project for the PDF. Nothing is written into the PDF; the project only points at it.', ['init', 'sample.pdf', '--title', 'Calculus Sheet 1', '--folder', 'Examples/Calculus']);
await step('Look at the document: pages, sizes, whether the pages have a text layer, the PDF\'s own outline.', ['info']);
await step('Read the text lines of the first page with their coordinates (fractions of the page, origin top-left, y downwards). The running header is marked.', ['lines', '0']);
await step('Render the page with a labelled grid, to read positions off the image. (The image is written to .mcprep-cache; look at it with your image viewer.)', ['render', '0', '--grid', '0.1']);
await step('Ask for proposals. They are offline heuristics with their evidence; nothing is applied.', ['propose'], { lines: 40, note: 'Output shortened.' });
await step('Write the proposals as a batch of operations that you can read, edit and apply.', ['propose', '--ops', 'batch.json'], { keep: (text) => [...text.split('\n').slice(0, 2), '...', text.split('\n').at(-1)].join('\n') });
writeFileSync(join(here, 'batch.json'), readFileSync(join(here, 'batch.json'), 'utf8').replaceAll('\r\n', '\n'));
await step('Apply the whole batch in one atomic call. One validation at the end; any failure would have changed nothing.', ['frames', 'apply', 'batch.json']);
await step('List the frames in reading order. The labels (E2.1, B1, ...) are computed from position and never stored.', ['frames', 'list']);
await step('Crop every frame to a PNG: now LOOK at each image. The title of the exercise must be at the top, nothing of the next exercise at the bottom, and no line of text cut in half.', ['crop', '--all'], { lines: 14, note: 'Output shortened.' });
await step('The learner wants the remark at the end of page 3 as a question for the tutor, not a bookmark. Change its kind; numbers follow by themselves (B2 becomes Q1).', ['frames', 'update', 'f12', '--kind', 'question']);
await step('A mistake an agent might make: pages are zero-based, this document has pages 0, 1 and 2.', ['frames', 'add', '--kind', 'exercise', '--page', '3', '--rect', '0.1,0.2,0.9,0.3'], { allowFailure: true });
await step('Another one: coordinates in percent. The error says what to do.', ['frames', 'add', '--kind', 'exercise', '--page', '2', '--rect', '10,20,90,30'], { allowFailure: true });
await step('Use the PDF\'s own bookmarks as the contents of the document, so that the app shows them and they can be edited.', ['outline', 'pdf', '--adopt'], { lines: 12 });
await step('Validate the project against every rule of the bundle format.', ['validate']);
await step('Export. The bundle is written atomically and read back with the importer\'s own checks.', ['export', '--out', 'sample.mcbundle', '--created-at', FIXED_TIME]);
await step('Check the bundle exactly as the Android importer would.', ['import-check', 'sample.mcbundle']);
await step('Look inside the bundle.', ['inspect-bundle', 'sample.mcbundle'], { lines: 40, note: 'Output shortened.' });

// A picture for the documentation: the first page with its grid and the frames that were marked.
mkdirSync(join(here, '..', 'docs', 'img'), { recursive: true });
await run(['render', '0', '--frames', '--grid', '0.1', '--max-side', '760', '--out', join(here, '..', 'docs', 'img', 'sample-page0.png')], {
  stdout: () => undefined,
  stderr: () => undefined,
  stdin: () => Promise.resolve(''),
  cwd: here,
  env: {},
});

// Fixed times in the committed project, so that rebuilding the examples gives the same files.
const projectPath = join(here, 'sample.mcprep.json');
const project = parseProject(JSON.parse(readFileSync(projectPath, 'utf8')), 'sample');
writeFileSync(projectPath, serializeProject({ ...project, createdAt: FIXED_TIME, updatedAt: FIXED_TIME }));
rmSync(join(here, '.mcprep-cache'), { recursive: true, force: true });

const lines = [
  '# A real session: marking the sample sheet',
  '',
  'This transcript is generated by [`build-examples.mjs`](build-examples.mjs): every command below was run by that script on the',
  'synthetic [`sample.pdf`](sample.pdf) and the output is what the tool printed (paths shortened to `.`). Images are not shown;',
  'an agent would open the PNG files that `render` and `crop` write. The end state is committed next to this file:',
  '[`sample.mcprep.json`](sample.mcprep.json) (the project), [`batch.json`](batch.json) (the proposals as operations) and',
  '[`sample.mcbundle`](sample.mcbundle) (the bundle for the Android app).',
  '',
];
transcript.forEach((entry, index) => {
  lines.push(`## ${index + 1}. ${entry.title}`, '', '```console', `$ ${entry.command}`, entry.output, ...(entry.code !== 0 ? [`(exit code ${entry.code})`] : []), '```', '');
  if (entry.note) lines.push(`_${entry.note}_`, '');
});
writeFileSync(join(here, 'agent-session.md'), `${lines.join('\n')}\n`);
console.log(`built ${transcript.length} steps in ${here}`);
