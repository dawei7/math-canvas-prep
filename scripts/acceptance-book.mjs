// Acceptance run for the book audit on a real textbook PDF. Not part of the tests (it needs a book that is not in the repository).
//
//   node scripts/acceptance-book.mjs <book.pdf> [reference.json] [--out <folder>] [--sample <n>] [--solution-sample <n>] [--no-apply] [--title <text>]
//
// It creates a project in a temporary folder, derives the sections, proposes and applies the exercises and the solutions through the
// real operations, validates, exports a bundle and runs the importer's checks, then compares the sections and the number of
// exercises with the reference (the owner's sample book.json, or any JSON with { sections: [{ label, title, exercise_count }] }) and
// writes a Markdown report with the evidence for every difference. It also renders a sample of crops of exercises and of
// solution regions into <out>/crops so that they can be looked at. Nothing is uploaded; the PDF stays where it is.
//
// Run `npm run build` first.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { run } from '../packages/cli/dist/index.js';
import { PdfDocument, renderRegion, titleKey } from '../packages/core/dist/index.js';

const args = process.argv.slice(2);
const positional = [];
const options = new Map();
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const name = arg.slice(2);
    if (['no-apply'].includes(name)) options.set(name, true);
    else options.set(name, args[(i += 1)]);
  } else positional.push(arg);
}
const [pdfArg, referenceArg] = positional;
if (!pdfArg) {
  console.error('usage: node scripts/acceptance-book.mjs <book.pdf> [reference.json] [--out <folder>] [--sample <n>] [--solution-sample <n>] [--no-apply] [--title <text>]');
  process.exit(2);
}
const pdfPath = resolve(pdfArg);
const outDir = resolve(options.get('out') ?? 'acceptance-out');
const sampleSize = Number(options.get('sample') ?? 40);
const solutionSampleSize = Number(options.get('solution-sample') ?? 20);
const applyAll = options.get('no-apply') !== true;
const title = options.get('title') ?? basename(pdfPath).replace(/\.pdf$/i, '');

const work = await mkdtemp(join(tmpdir(), 'mcprep-acceptance-'));
const projectPath = join(work, 'book.mcprep.json');
const timings = [];

async function mcprep(argv, { quiet = false } = {}) {
  let out = '';
  let err = '';
  const started = Date.now();
  const code = await run([...argv, '--json', '--project', projectPath], {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    stdin: () => Promise.resolve(''),
    cwd: work,
    env: {},
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  timings.push(`${argv.slice(0, 3).join(' ')}: ${seconds} s`);
  const envelope = out.trim().startsWith('{') ? JSON.parse(out) : { ok: false, error: { message: err.trim() || 'no output' } };
  if (!quiet && code !== 0 && !['validate', 'import-check'].includes(argv[0])) {
    throw new Error(`mcprep ${argv.join(' ')} failed (exit ${code}): ${envelope.error?.message ?? err}\n${envelope.error?.hint ?? ''}`);
  }
  return { code, envelope, result: envelope.result ?? {} };
}

const pct = (a, b) => (b === 0 ? 'n/a' : `${Math.round((1000 * a) / b) / 10} %`);
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

try {
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, 'crops'), { recursive: true });
  const pdfCopy = join(work, 'book.pdf');
  await copyFile(pdfPath, pdfCopy);

  // --- the project and the sections -----------------------------------------------------------------------------------
  const init = await run(['init', pdfCopy, '--out', projectPath, '--title', title, '--json'], { stdout: () => undefined, stderr: () => undefined, stdin: () => Promise.resolve(''), cwd: work, env: {} });
  if (init !== 0) throw new Error('mcprep init failed');
  const derived = await mcprep(['outline', 'derive', '--book']);
  const sections = derived.result.entries.filter((entry) => entry.kind === 'section');
  const chapters = derived.result.entries.filter((entry) => entry.kind === 'chapter');
  if (applyAll) await mcprep(['outline', 'derive', '--book', '--apply']);

  // --- exercises and solutions ------------------------------------------------------------------------------------------
  const detailsFile = join(work, 'details.json');
  const opsFile = join(work, 'ops.json');
  const propose = await mcprep(['exercises', 'propose', '--solutions', '--details', detailsFile, '--ops', opsFile, ...(applyAll ? ['--apply'] : [])]);
  const details = JSON.parse(await readFile(detailsFile, 'utf8'));
  const exerciseSections = details.sectionsDetail;
  const solutionSections = details.solutions?.sections ?? [];
  const proposals = details.proposals;

  // --- validate, export, import-check ---------------------------------------------------------------------------------------
  let validation;
  let bundle;
  let check;
  const bundlePath = join(outDir, `${basename(pdfPath).replace(/\.pdf$/i, '')}-audited.mcbundle`);
  if (applyAll) {
    validation = await mcprep(['validate'], { quiet: true });
    if (validation.result.ok === false) console.error('validation reports errors; see the report');
    bundle = await mcprep(['export', '--out', bundlePath], { quiet: true });
    check = bundle.code === 0 ? await mcprep(['import-check', bundlePath], { quiet: true }) : undefined;
    await copyFile(projectPath, join(outDir, `${basename(pdfPath).replace(/\.pdf$/i, '')}-audited.mcprep.json`));
  }

  // --- the reference ----------------------------------------------------------------------------------------------------------
  let reference;
  if (referenceArg) {
    const raw = JSON.parse(await readFile(resolve(referenceArg), 'utf8'));
    reference = [];
    if (Array.isArray(raw.chapters)) {
      // The owner's sample: chapters numbered from 1, sections numbered inside the chapter; the book prints chapter 0 first.
      for (const chapter of raw.chapters) for (const section of chapter.sections) reference.push({ label: `${chapter.number - 1}.${section.number}`, title: section.title, count: section.exercise_count, chapterTitle: chapter.title, chapterLabel: `Chapter ${chapter.number - 1}` });
    } else if (Array.isArray(raw.sections)) {
      for (const section of raw.sections) reference.push({ label: section.label, title: section.title, count: section.exercise_count ?? section.count });
    }
  }

  // --- crops to look at ----------------------------------------------------------------------------------------------------------
  const doc = await PdfDocument.open(pdfPath);
  const written = [];
  async function crop(name, page, rect) {
    const image = await renderRegion(doc, page, rect, { maxSide: 800, padding: 0.01 });
    const path = join(outDir, 'crops', `${name}.png`);
    await writeFile(path, image.png);
    written.push(path);
  }
  const pick = [];
  const withContinuation = proposals.filter((proposal) => proposal.continues);
  const figures = proposals.filter((proposal) => proposal.layout === 'figure');
  const bySection = new Map();
  for (const proposal of proposals) bySection.set(proposal.section, [...(bySection.get(proposal.section) ?? []), proposal]);
  const evenly = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_unused, k) => list[Math.floor((k * list.length) / n)]));
  for (const list of bySection.values()) pick.push(list[0], list[list.length - 1]);
  pick.push(...evenly(withContinuation, 4), ...evenly(figures, 10), ...evenly(proposals, sampleSize));
  const chosen = [...new Map(pick.filter(Boolean).map((proposal) => [proposal.id, proposal])).values()].slice(0, Math.max(sampleSize, 1));
  for (const proposal of chosen) {
    await crop(`ex-${proposal.id}`, proposal.page, proposal.rect);
    for (const [index, region] of (proposal.continues ?? []).entries()) await crop(`ex-${proposal.id}-continues${index}`, region.page, region.rect);
    for (const [index, region] of (proposal.context ?? []).entries()) await crop(`ex-${proposal.id}-context${index}`, region.page, region.rect);
  }
  const answers = solutionSections.flatMap((section) => section.answers);
  const answerPick = [];
  for (const section of solutionSections) if (section.answers.length > 0) answerPick.push(section.answers[0], section.answers[section.answers.length - 1]);
  answerPick.push(...evenly(answers.filter((answer) => answer.regions.length > 1), 4), ...evenly(answers, solutionSampleSize));
  const chosenAnswers = [...new Map(answerPick.filter(Boolean).map((answer) => [answer.exercise, answer])).values()].slice(0, Math.max(solutionSampleSize, 1));
  for (const answer of chosenAnswers) for (const [index, region] of answer.regions.entries()) await crop(`solution-${answer.exercise}${index > 0 ? `-${index}` : ''}`, region.page, region.rect);
  await doc.close();

  // --- the report ------------------------------------------------------------------------------------------------------------------
  const lines = [];
  const found = new Map(exerciseSections.map((section) => [section.section, section]));
  const solved = new Map(solutionSections.map((section) => [section.section, section]));
  lines.push(`# Acceptance report: ${title}`, '', `Generated by scripts/acceptance-book.mjs. PDF: ${basename(pdfPath)}. Nothing was uploaded.`, '');
  lines.push('## Summary', '');
  const totalExercises = proposals.length;
  const totalAnswers = answers.length;
  lines.push(`- Chapters found: ${chapters.length}; sections found: ${sections.length}; other entries: ${derived.result.entries.length - chapters.length - sections.length}.`);
  lines.push(`- Printed contents on pages ${derived.result.toc.pages.join(', ') || 'none'}, ${derived.result.toc.openers.length} chapter opener lists; printed page = page + ${derived.result.numbering.offset ?? '?'}; answer key from page ${derived.result.answerKey?.page ?? 'not found'}.`);
  lines.push(`- Exercises found: ${totalExercises} in ${exerciseSections.filter((section) => section.proposals.length > 0).length} sections; solutions found: ${totalAnswers} (${pct(propose.result.counts.withSolution, totalExercises)} of the exercises have a solution region).`);
  lines.push(`- Applied: ${applyAll ? 'yes, through the operations of the project' : 'no (--no-apply)'}.`);
  if (validation) lines.push(`- Validation: ${validation.result.ok ? 'ok' : 'ERRORS'}; errors ${validation.result.errors?.length ?? '?'}, warnings ${validation.result.warnings?.length ?? '?'}.`);
  if (bundle) lines.push(`- Bundle: ${bundle.code === 0 ? bundlePath : `export failed: ${bundle.envelope.error?.message}`}${check ? `; importer check: ${check.result.wouldImport ? 'would import' : 'WOULD NOT IMPORT'}` : ''}.`);
  lines.push(`- Crops written to ${join(outDir, 'crops')}: ${written.length} images (${chosen.length} exercises, ${chosenAnswers.length} solutions).`, '');

  if (reference) {
    const refByLabel = new Map(reference.map((entry) => [entry.label, entry]));
    const foundByLabel = new Map(sections.map((entry) => [entry.label, entry]));
    const missing = reference.filter((entry) => !foundByLabel.has(entry.label));
    const extra = sections.filter((entry) => !refByLabel.has(entry.label));
    const titleDiff = reference.filter((entry) => foundByLabel.has(entry.label) && titleKey(foundByLabel.get(entry.label).title) !== titleKey(entry.title));
    const countDiff = reference.filter((entry) => found.has(entry.label) && found.get(entry.label).proposals.length !== entry.count);
    lines.push('## Comparison with the reference', '');
    lines.push(`- Sections: ${sections.length} found, ${reference.length} in the reference; missing ${missing.length}, extra ${extra.length}.`);
    lines.push(`- Titles that differ after normalising: ${titleDiff.length}. Exercise counts that differ: ${countDiff.length} of ${reference.length} sections.`);
    const chapterRef = new Map(reference.filter((entry) => entry.chapterLabel).map((entry) => [entry.chapterLabel, entry.chapterTitle]));
    const chapterDiff = chapters.filter((entry) => chapterRef.has(entry.label) && titleKey(entry.title) !== titleKey(chapterRef.get(entry.label)));
    if (chapterRef.size > 0) lines.push(`- Chapters: ${chapters.length} found, ${chapterRef.size} in the reference; titles that differ: ${chapterDiff.length}.`);
    lines.push('');
    if (titleDiff.length > 0) {
      lines.push('### Titles that differ', '', '| section | found | reference | evidence |', '| --- | --- | --- | --- |');
      for (const entry of titleDiff) lines.push(`| ${entry.label} | ${cell(foundByLabel.get(entry.label).title)} | ${cell(entry.title)} | ${cell(foundByLabel.get(entry.label).differences?.map((d) => `${d.source}: ${d.text}`).join('; '))} |`);
      lines.push('');
    }
    if (countDiff.length > 0) {
      lines.push('### Exercise counts that differ', '', '| section | title | reference | found | numbers | pages | why |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const entry of countDiff) {
        const section = found.get(entry.label);
        const why = [];
        if (section.gaps.length > 0) why.push(`no line starts with ${section.gaps.join(', ')}`);
        if (section.duplicates.length > 0) why.push(`printed twice: ${section.duplicates.join(', ')}`);
        if (section.proposals.length > entry.count && section.gaps.length === 0) why.push(`the book prints ${section.proposals.length} numbered exercises (${section.first}..${section.last}) on page${section.pages[0] === section.pages[1] ? '' : 's'} ${section.pages[0] === section.pages[1] ? section.pages[0] : `${section.pages[0]}-${section.pages[1]}`}; the reference counts ${entry.count}`);
        for (const note of section.notes) if (!why.some((text) => text.includes(note.slice(0, 20)))) why.push(note);
        lines.push(`| ${entry.label} | ${cell(entry.title)} | ${entry.count} | ${section.proposals.length} | ${section.first ?? ''}..${section.last ?? ''} | ${section.pages.join('-')} | ${cell(why.join('; '))} |`);
      }
      lines.push('');
    }
    if (missing.length > 0) lines.push(`Sections of the reference that were not found: ${missing.map((entry) => entry.label).join(', ')}.`, '');
    if (extra.length > 0) lines.push(`Sections found that the reference does not have: ${extra.map((entry) => entry.label).join(', ')}.`, '');
  }

  lines.push('## Per section', '', '| section | title | page | conf | practice pages | exercises | numbers | answers | no answer | no exercise | notes |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of sections) {
    const section = found.get(entry.label);
    const solution = solved.get(entry.label);
    const notes = [...(section?.notes ?? []), ...(solution?.notes ?? [])];
    lines.push(
      `| ${entry.label} | ${cell(entry.title)} | ${entry.page} | ${entry.confidence} | ${section ? (section.pages[0] === section.pages[1] ? section.pages[0] : `${section.pages[0]}-${section.pages[1]}`) : ''} | ${section?.proposals.length ?? 0}${reference ? ` / ${reference.find((ref) => ref.label === entry.label)?.count ?? '?'}` : ''} | ${section?.first ?? ''}..${section?.last ?? ''} | ${solution?.answers.length ?? 0} | ${cell((solution?.withoutAnswer ?? []).join(', '))} | ${cell((solution?.withoutExercise ?? []).join(', '))} | ${cell(notes.join('; '))} |`,
    );
  }
  lines.push('');

  lines.push('## Solution coverage', '');
  const withoutAnswer = solutionSections.reduce((sum, section) => sum + section.withoutAnswer.length, 0);
  const withoutExercise = solutionSections.reduce((sum, section) => sum + section.withoutExercise.length, 0);
  lines.push(`- ${totalAnswers} answers found for ${totalExercises} exercises: ${pct(totalExercises - withoutAnswer, totalExercises)} of the exercises have an answer; ${withoutAnswer} exercises without an answer, ${withoutExercise} answers without an exercise.`);
  for (const section of solutionSections) if (section.withoutAnswer.length > 0 || section.withoutExercise.length > 0) lines.push(`  - ${section.section}: ${section.withoutAnswer.length > 0 ? `no answer for ${section.withoutAnswer.join(', ')}` : ''}${section.withoutExercise.length > 0 ? `; answers without an exercise: ${section.withoutExercise.join(', ')}` : ''}${section.notes.length > 0 ? ` (${section.notes.join('; ')})` : ''}`);
  lines.push('');

  lines.push('## Anomalies', '');
  for (const note of [...derived.result.notes, ...propose.result.notes.filter((note) => !derived.result.notes.includes(note))]) lines.push(`- ${note}`);
  for (const section of exerciseSections) for (const note of section.notes) lines.push(`- ${section.section}: ${note}`);
  for (const section of exerciseSections) for (const rejected of section.rejected) lines.push(`- ${section.section}: put aside "${rejected.text}" on page ${rejected.page}: ${rejected.reason}`);
  const lowConfidence = proposals.filter((proposal) => proposal.confidence < 0.8);
  if (lowConfidence.length > 0) lines.push(`- ${lowConfidence.length} exercises with a confidence below 0.8: ${lowConfidence.map((proposal) => `${proposal.section} #${proposal.label}`).join(', ')}.`);
  lines.push('', '## Timings', '', ...timings.map((line) => `- ${line}`), '');
  await writeFile(join(outDir, 'acceptance-report.md'), `${lines.join('\n')}\n`);
  await writeFile(join(outDir, 'acceptance-details.json'), `${JSON.stringify({ sections: derived.result.entries, exercises: details.sectionsDetail, solutions: details.solutions }, null, 1)}\n`);
  console.log(`report: ${join(outDir, 'acceptance-report.md')}`);
  console.log(`${chapters.length} chapters, ${sections.length} sections, ${totalExercises} exercises, ${totalAnswers} answers; crops: ${written.length}`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
