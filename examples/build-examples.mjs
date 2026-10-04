// Builds the examples of this repository from scratch, with the tools themselves:
//
//   examples/sample.pdf         a synthetic three-page exercise sheet (generated here, nothing real)
//   examples/sample.mcprep.json the project after marking it
//   examples/sample.mcbundle    the exported bundle
//   examples/batch.json         the operations `mcprep propose --ops` wrote
//   examples/agent-session.md   a transcript of that session: every command and its real output
//
//   examples/workbook/          the audit of a synthetic four-page workbook as an authority (docs/AGENT_GUIDE.md, chapter 14):
//     workbook.pdf              the workbook (generated here, nothing real) with its answer key
//     workbook.mcprep.json      the project: sections, book exercises with labels, hidden solutions, the licence
//     workbook-batch.json       the operations that mark every printed exercise in one atomic call
//     workbook.mcbundle         the exported bundle
//     workbook.book.json        the summary of the sections with their exercise counts (`mcprep book export`)
//     audit-session.md          a transcript of that session
//
// Run it after `npm run build`:   node examples/build-examples.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { buildSampleSheet, buildAuthoritySample } = await import('../packages/core/dist/testing.js');
const { parseProject, serializeProject } = await import('../packages/core/dist/index.js');
const { run } = await import('../packages/cli/dist/index.js');

for (const name of ['sample.pdf', 'sample.mcprep.json', 'sample.mcbundle', 'batch.json', 'agent-session.md']) rmSync(join(here, name), { force: true });
rmSync(join(here, '.mcprep-cache'), { recursive: true, force: true });
rmSync(join(here, 'workbook'), { recursive: true, force: true });
mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'sample.pdf'), buildSampleSheet().pdf);

const FIXED_TIME = '2026-10-03T12:00:00Z';

function quote(argument) {
  return /[\s"'\\]/.test(argument) || argument === '' ? JSON.stringify(argument) : argument;
}

/** A session in one folder: every command is run there, and the transcript gets its command line, output and exit code. */
function session(cwd) {
  const transcript = [];
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
      stdin: () => Promise.resolve(options.stdin ?? ''),
      cwd,
      env: { SOURCE_DATE_EPOCH: undefined },
    });
    // Paths shortened to ".", the same on every platform; times fixed, so that rebuilding gives the same transcript.
    const clean = (text) =>
      text
        .split(cwd)
        .join('.')
        .split(cwd.replaceAll('\\', '/'))
        .join('.')
        .replaceAll('\\', '/')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, FIXED_TIME);
    let shown = clean(out + err).trimEnd();
    let shortened = false;
    if (options.keep) {
      shown = options.keep(shown);
      shortened = true;
    }
    if (options.lines) {
      const all = shown.split('\n');
      if (all.length > options.lines) {
        shown = `${all.slice(0, options.lines).join('\n')}\n... (${all.length - options.lines} more lines)`;
        shortened = true;
      }
    }
    // A note that says the output was shortened is only kept when it was.
    transcript.push({ title, command: `mcprep ${args.map(quote).join(' ')}`, output: shown, code, note: options.note === 'Output shortened.' && !shortened ? undefined : options.note });
    if (code !== 0 && !options.allowFailure) throw new Error(`step failed: mcprep ${args.join(' ')}\n${out}${err}`);
    return { out, err, code };
  }
  return { step, transcript };
}

function writeTranscript(path, transcript, heading, intro) {
  const lines = [heading, '', ...intro, ''];
  transcript.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${entry.title}`, '', '```console', `$ ${entry.command}`, entry.output, ...(entry.code !== 0 ? [`(exit code ${entry.code})`] : []), '```', '');
    if (entry.note) lines.push(`_${entry.note}_`, '');
  });
  writeFileSync(path, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The exercise sheet: ordinary exercises, marked with proposals.

const { step, transcript } = session(here);

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

writeTranscript(
  join(here, 'agent-session.md'),
  transcript,
  '# A real session: marking the sample sheet',
  [
    'This transcript is generated by [`build-examples.mjs`](build-examples.mjs): every command below was run by that script on the',
    'synthetic [`sample.pdf`](sample.pdf) and the output is what the tool printed (paths shortened to `.`). Images are not shown;',
    'an agent would open the PNG files that `render` and `crop` write. The end state is committed next to this file:',
    '[`sample.mcprep.json`](sample.mcprep.json) (the project), [`batch.json`](batch.json) (the proposals as operations) and',
    '[`sample.mcbundle`](sample.mcbundle) (the bundle for the Android app).',
  ],
);
console.log(`built ${transcript.length} steps in ${here}`);

// ---------------------------------------------------------------------------------------------------------------------
// The workbook: a book audited as an authority (docs/AGENT_GUIDE.md, chapter 14).

const book = join(here, 'workbook');
mkdirSync(book, { recursive: true });
const workbook = buildAuthoritySample();
writeFileSync(join(book, 'workbook.pdf'), workbook.pdf);
const audit = session(book);

await audit.step('Create a project for the workbook (a synthetic one: its text is invented, with an answer key on the last page).', ['init', 'workbook.pdf', '--title', 'Pre-Algebra Workbook', '--folder', 'Books/Algebra']);
await audit.step(
  'Say what the book is. The licence and the notice the licence asks for are copied from the book itself (here: invented ones).',
  ['book', 'meta', '--author', 'A. Author', '--series', 'Prerequisites', '--license-name', 'CC BY 3.0', '--license-url', 'https://creativecommons.org/licenses/by/3.0/', '--source-url', 'https://example.org/the-workbook', '--notice', 'Attribution: A. Author, Pre-Algebra Workbook, CC BY 3.0. Changes: marked for study, nothing else.'],
);
await audit.step('The sections of the book are the entries of its outline. Adopt the PDF\'s own bookmarks...', ['outline', 'pdf', '--adopt'], { lines: 12 });
await audit.step('...and give every entry an id, which is what exercises name as their section (from the printed label, else the number in the title).', ['outline', 'ids']);
await audit.step('Where two sections start on one page, the top of the heading tells them apart. Section 1.1 starts a quarter of the way down page 0.', ['outline', 'update', '1.1', '--top', '0.2577', '--label', '1.1']);
const asText = (rect) => `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
const first = workbook.exercises[0];
await audit.step(
  'Add the first exercise by hand: the printed number is the label, "1.1" the section it is printed in; the answer is a region of the answer key on page 3 (hidden from the learner).',
  ['exercises', 'add', '--section', first.section, '--label', first.label, '--page', String(first.page), '--rect', asText(first.rect), '--snap', '--solution', `${first.solution[0].page}:${asText(first.solution[0].rect)}`],
);
const operations = workbook.exercises.slice(1).map((entry) => ({
  op: 'add',
  authority: 'book',
  section: entry.section,
  label: entry.label,
  page: entry.page,
  rect: entry.rect,
  ...(entry.context ? { context: entry.context } : {}),
  ...(entry.continues ? { continues: entry.continues } : {}),
  solution: entry.solution,
}));
writeFileSync(join(book, 'workbook-batch.json'), `${JSON.stringify({ operations }, null, 2)}\n`);
await audit.step(
  'The other nine printed exercises in one atomic batch. Exercise 3 of section 1.1 has two parts: they are two exercises, 3a and 3b, and the statement "3. Evaluate each sum." they share is context on both. Exercise 4 of section 1.2 goes on at the top of the next page (a continuation).',
  ['frames', 'apply', 'workbook-batch.json'],
  { lines: 18, note: 'Output shortened.' },
);
await audit.step('Applying the same batch again duplicates nothing: an exercise is identified by its section and label, so the second time is an error and nothing is written.', ['frames', 'apply', 'workbook-batch.json'], { allowFailure: true });
await audit.step('Authoritative exercises are single exercises: they are never cut into parts. The error explains the convention.', ['frames', 'split', '1.1:3a', '--at', '0.5'], { allowFailure: true });
await audit.step('The exercises of one section, by the number the book prints; none is numbered by position.', ['exercises', 'list', '--section', '1.1']);
await audit.step('Which exercises still have no answer attached? (The key answers all of them here.)', ['solution', 'list', '--missing']);
await audit.step('Look at the regions: one crop per exercise, continuation, context and solution of a section. Open the images and check that each starts at the printed number and that each solution is the answer to its own exercise.', ['crop', '--all', '--section', '1.2'], { lines: 12, note: 'Output shortened.' });
await audit.step('Validate: every rule of the format, including the rules of books.', ['validate']);
await audit.step('Compare the book with what it should contain: the sections with the number of exercises in each, how many have a solution, and the first and last label.', ['book', 'show']);
await audit.step('Export. The bundle carries the sections, the exercises with their labels, the hidden solutions and the licence.', ['export', '--out', 'workbook.mcbundle', '--created-at', FIXED_TIME]);
await audit.step('Check the bundle exactly as the Android importer would.', ['import-check', 'workbook.mcbundle'], { lines: 16, note: 'Output shortened.' });
await audit.step('Write the plain JSON summary of the sections with their counts, for other programs (format: mcprep schema book-summary).', ['book', 'export', '--out', 'workbook.book.json']);

const workbookProject = join(book, 'workbook.mcprep.json');
writeFileSync(workbookProject, serializeProject({ ...parseProject(JSON.parse(readFileSync(workbookProject, 'utf8')), 'workbook'), createdAt: FIXED_TIME, updatedAt: FIXED_TIME }));
rmSync(join(book, '.mcprep-cache'), { recursive: true, force: true });

writeTranscript(
  join(book, 'audit-session.md'),
  audit.transcript,
  '# A real session: auditing a book as an authority',
  [
    'This transcript is generated by [`build-examples.mjs`](../build-examples.mjs): every command below was run by that script on the',
    'synthetic [`workbook.pdf`](workbook.pdf) (invented text, with an answer key on the last page) and the output is what the tool',
    'printed (paths shortened to `.`). The concepts are in chapter 14 of the [agent guide](../../docs/AGENT_GUIDE.md). The end state is',
    'committed next to this file: [`workbook.mcprep.json`](workbook.mcprep.json) (the project), [`workbook-batch.json`](workbook-batch.json)',
    '(the batch), [`workbook.mcbundle`](workbook.mcbundle) (the bundle for the Android app) and',
    '[`workbook.book.json`](workbook.book.json) (the summary of the sections).',
  ],
);
console.log(`built ${audit.transcript.length} steps in ${book}`);
