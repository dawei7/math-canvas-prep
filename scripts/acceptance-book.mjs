// Acceptance run for the audit of a book on a real textbook PDF. Not part of the tests: it needs a book that is not in the repository.
//
//   node scripts/acceptance-book.mjs <book.pdf> [reference.json] --out <folder> [options]
//
// It creates a project next to the other results, stores the sections, proposes and applies the exercises with their solutions
// through the real operations, applies them a second time (nothing may change), validates, exports a bundle and runs the importer's
// checks. It then compares the sections and the number of exercises with a reference (the owner's own list of the book, see
// --reference-chapter-offset), checks every stored region against the ink of the page (does an edge run through printed text?)
// and writes a Markdown report with the evidence for every difference, a sample of crops of exercises and solution regions, and
// contact sheets of the same sample (red = frame, orange = continuation, blue = instruction, green = solution) to look at.
// Nothing is uploaded and the PDF is not copied or changed. A machine-readable summary (acceptance-summary.json) is written for
// scripts/audit-books.mjs, which runs this script for every book of a folder and writes the index of them.
//
// The licence, the author and the notice are optional and are what the options say and nothing else; what the front matter of a
// book run without --license-name seems to say is printed as suggestions to be confirmed by a person, and written nowhere. A bundle
// holds the whole book: keep it private.
//
// Options
//   --out <folder>              where the results go (required): <name>-audited.mcprep.json, <name>-audited.mcbundle,
//                               acceptance-report.md, acceptance-details.json, acceptance-summary.json, crops/, sheets/
//   --name <stem>               the stem of the file names (default: the name of the PDF)
//   --title <text>              the title of the document (default: the name of the PDF)
//   --folder <path>             where the document belongs in the library, for example "Books/Algebra"
//   --author, --series, --description, --license-name, --license-url, --source-url, --notice
//                               what the book says about itself (the same as `mcprep book meta`)
//   --reference-chapter-offset <n>   the chapter numbers of the reference plus n are the numbers the book prints (default 0)
//   --sample <n>                exercises to put on the contact sheets and write as crops (default 60)
//   --solution-sample <n>       the same for solution regions (default 30)
//   --max-items <n>             at most this many exercises per section (the surplus is listed as excluded)
//   --chapter-words, --practice-words, --answer-words, --stop-words, --item-words, --back-words, --answer-marker (repeatable),
//   --item-pattern (repeatable), --instructions
//                               passed on to the commands that read the book (see docs/AUDIT_A_BOOK.md)
//
// Run `npm run build` first.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { groupFindings, run, suggestFrontMatter } from '../packages/cli/dist/index.js';
import { PdfDocument, renderPage, renderRegion, titleKey } from '../packages/core/dist/index.js';

const MULTIPLE = new Set(['item-pattern', 'answer-marker']);
const args = process.argv.slice(2);
const positional = [];
const options = new Map();
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const name = arg.slice(2);
    const value = args[(i += 1)];
    if (value === undefined) {
      console.error(`--${name} needs a value`);
      process.exit(2);
    }
    if (MULTIPLE.has(name)) options.set(name, [...(options.get(name) ?? []), value]);
    else options.set(name, value);
  } else positional.push(arg);
}
const [pdfArg, referenceArg] = positional;
if (!pdfArg || !options.has('out')) {
  console.error('usage: node scripts/acceptance-book.mjs <book.pdf> [reference.json] --out <folder> [--name <stem>] [--title <text>] [--folder <path>] [--author <text>] [--license-name <text>] [--license-url <url>] [--source-url <url>] [--notice <text>] [--reference-chapter-offset <n>] [--max-items <n>] [--sample <n>] [--solution-sample <n>]');
  process.exit(2);
}
const pdfPath = resolve(pdfArg);
const outDir = resolve(options.get('out'));
const stem = options.get('name') ?? basename(pdfPath).replace(/\.pdf$/i, '');
const title = options.get('title') ?? basename(pdfPath).replace(/\.pdf$/i, '');
const sampleSize = Number(options.get('sample') ?? 60);
const solutionSampleSize = Number(options.get('solution-sample') ?? 30);
const chapterOffset = Number(options.get('reference-chapter-offset') ?? 0);
const projectPath = join(outDir, `${stem}-audited.mcprep.json`);
const bundlePath = join(outDir, `${stem}-audited.mcbundle`);

const readOptions = [];
for (const name of ['chapter-words', 'practice-words', 'answer-words', 'stop-words', 'item-words', 'back-words', 'instructions']) if (options.has(name)) readOptions.push(`--${name}`, options.get(name));
for (const marker of options.get('answer-marker') ?? []) readOptions.push('--answer-marker', marker);
for (const pattern of options.get('item-pattern') ?? []) readOptions.push('--item-pattern', pattern);
const proposeOptions = [...readOptions, ...(options.has('max-items') ? ['--max-items', options.get('max-items')] : [])];
const metaOptions = [];
for (const name of ['author', 'series', 'description', 'license-name', 'license-url', 'source-url', 'notice']) if (options.has(name)) metaOptions.push(`--${name}`, options.get(name));

const licenseStated = (options.get('license-name') ?? '').trim() !== '';
const startedAt = Date.now();
const work = await mkdtemp(join(tmpdir(), 'mcprep-acceptance-'));
const timings = [];

/** The lines of the first pages of the PDF, for the suggestions about the licence and the author. */
async function frontMatter(path, count = 8) {
  const doc = await PdfDocument.open(path);
  try {
    const found = [];
    for (let index = 0; index < Math.min(count, doc.pageCount); index += 1) found.push({ page: index, lines: (await doc.pageText(index)).lines.map((line) => line.text) });
    return found;
  } finally {
    await doc.close();
  }
}

async function mcprep(argv, { project = true, allowFailure = false } = {}) {
  let out = '';
  let err = '';
  const started = Date.now();
  const code = await run([...argv, '--json', ...(project ? ['--project', projectPath] : [])], {
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
  timings.push(`${argv.slice(0, 3).join(' ')}: ${Math.round((Date.now() - started) / 100) / 10} s`);
  const envelope = out.trim().startsWith('{') ? JSON.parse(out) : { ok: false, error: { message: err.trim() || 'no output' } };
  if (code !== 0 && !allowFailure) throw new Error(`mcprep ${argv.join(' ')} failed (exit ${code}): ${envelope.error?.message ?? err}\n${envelope.error?.hint ?? ''}`);
  return { code, envelope, result: envelope.result ?? {} };
}

const pct = (a, b) => (b === 0 ? 'n/a' : `${Math.round((10000 * a) / b) / 100} %`);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const safe = (text) => String(text).replace(/[^A-Za-z0-9._-]+/g, '_');
const pages = (a, b) => (a === b ? `${a}` : `${a}-${b}`);
const evenly = (list, n) => (list.length <= n ? [...list] : Array.from({ length: n }, (_unused, k) => list[Math.floor((k * list.length) / n)]));

try {
  await mkdir(join(outDir, 'crops'), { recursive: true });
  await mkdir(join(outDir, 'sheets'), { recursive: true });

  // --- what the front matter seems to say about the licence and the author: shown, never used ---------------------------------
  const suggestions = suggestFrontMatter(await frontMatter(pdfPath)).filter((entry) => {
    if (entry.field.startsWith('license')) return !licenseStated;
    if (entry.field === 'author') return !options.has('author');
    return !licenseStated;
  });

  // --- the project, what the book says about itself, the sections -----------------------------------------------------------
  await mcprep(['init', pdfPath, '--out', projectPath, '--title', title, ...(options.has('folder') ? ['--folder', options.get('folder')] : []), '--force'], { project: false });
  if (metaOptions.length > 0) await mcprep(['book', 'meta', ...metaOptions]);
  const derived = await mcprep(['outline', 'derive', '--book', ...readOptions]);
  await mcprep(['outline', 'derive', '--book', '--apply', ...readOptions]);
  const entries = derived.result.entries;
  const sections = entries.filter((entry) => entry.kind === 'section');
  const chapters = entries.filter((entry) => entry.kind === 'chapter');

  // --- exercises and solutions, then the same again --------------------------------------------------------------------------
  const detailsFile = join(work, 'details.json');
  const opsFile = join(work, 'ops.json');
  const propose = await mcprep(['exercises', 'propose', '--solutions', '--details', detailsFile, '--ops', opsFile, '--apply', ...proposeOptions]);
  const details = JSON.parse(await readFile(detailsFile, 'utf8'));
  const exerciseSections = details.sectionsDetail;
  const solutionSections = details.solutions?.sections ?? [];
  const proposals = details.proposals;
  const again = await mcprep(['exercises', 'propose', '--solutions', '--apply', ...proposeOptions]);
  const againSolutions = await mcprep(['solutions', 'propose', '--apply', ...readOptions]);

  // --- validate, the counts the project holds, export, import-check --------------------------------------------------------
  const validation = await mcprep(['validate'], { allowFailure: true });
  // The text check: what a person would find by looking at the crops (labels, overlaps, sizes, numbers that are missing), and, with
  // the canvas library, whether any of the four edges of a region runs through printed ink (the border of a box, a glyph).
  let canvasLib;
  try {
    canvasLib = await import('@napi-rs/canvas');
  } catch {
    canvasLib = undefined;
  }
  const verifyFile = join(work, 'verify.json');
  const verifyRun = await mcprep(['exercises', 'verify', ...(canvasLib ? ['--ink'] : []), '--details', verifyFile], { allowFailure: true });
  let verifyReport;
  try {
    verifyReport = JSON.parse(await readFile(verifyFile, 'utf8'));
  } catch {
    verifyReport = undefined;
  }
  // The exercises that the cap (--max-items) left out still have their answers in the key: that is what was asked for, not a defect, so those
  // answers are counted apart (the details file keeps every finding).
  const cappedRefs = new Set(exerciseSections.flatMap((entry) => (entry.excluded ?? []).map((label) => `${entry.section}:${label}`)));
  const cappedAnswers = (verifyReport?.findings ?? []).filter((finding) => finding.code === 'answer-left-behind' && cappedRefs.has(finding.ref));
  const verifyByCode = {};
  for (const finding of verifyReport?.findings ?? []) {
    if (cappedAnswers.includes(finding)) continue;
    const key = `${finding.severity} ${finding.code}`;
    verifyByCode[key] = (verifyByCode[key] ?? 0) + 1;
  }
  const verifyCounts = verifyReport
    ? { errors: verifyReport.summary.errors - cappedAnswers.length, warnings: verifyReport.summary.warnings, infos: verifyReport.summary.infos, byCode: verifyByCode, ...(cappedAnswers.length > 0 ? { answersBeyondTheCap: cappedAnswers.length } : {}) }
    : undefined;
  const book = await mcprep(['book', 'show']);
  const exported = await mcprep(['export', '--out', bundlePath], { allowFailure: true });
  const check = exported.code === 0 ? await mcprep(['import-check', bundlePath], { project: false, allowFailure: true }) : undefined;
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  const frames = project.frames.filter((frame) => frame.authority === 'book');
  const frameOf = new Map(frames.map((frame) => [`${frame.section}\u0000${frame.label}`, frame]));
  const stored = new Map(book.result.sections.map((entry) => [entry.id, entry]));

  // --- the reference -------------------------------------------------------------------------------------------------------------
  let reference;
  if (referenceArg) {
    const raw = JSON.parse(await readFile(resolve(referenceArg), 'utf8'));
    reference = [];
    if (Array.isArray(raw.chapters)) {
      for (const chapter of raw.chapters) {
        for (const section of chapter.sections) {
          reference.push({ label: `${chapter.number + chapterOffset}.${section.number}`, title: section.title, count: section.exercise_count, chapterTitle: chapter.title, chapterLabel: `${chapter.number + chapterOffset}` });
        }
      }
    } else if (Array.isArray(raw.sections)) {
      for (const section of raw.sections) reference.push({ label: section.label, title: section.title, count: section.exercise_count ?? section.count });
    }
  }
  const foundByLabel = new Map(sections.map((entry) => [entry.label, entry]));
  const countOf = (entry) => stored.get(entry.id)?.exercises ?? 0;

  // --- the ink check: does an edge of a stored region run through printed text? ------------------------------------------------
  const doc = await PdfDocument.open(pdfPath);
  const regions = [];
  for (const frame of frames) {
    const ref = `${frame.section}:${frame.label}`;
    regions.push({ ref, kind: 'frame', page: frame.page, rect: frame.rect });
    for (const [i, region] of (frame.continues ?? []).entries()) regions.push({ ref, kind: `continues${i}`, ...region });
    for (const [i, region] of (frame.context ?? []).entries()) regions.push({ ref, kind: `context${i}`, ...region });
    for (const [i, region] of (frame.solution ?? []).entries()) regions.push({ ref, kind: `solution${i}`, ...region });
  }
  const inkCuts = [];
  if (canvasLib) {
    const byPage = new Map();
    for (const region of regions) byPage.set(region.page, [...(byPage.get(region.page) ?? []), region]);
    for (const [page, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
      const image = await renderPage(doc, page, { scale: 2 });
      const img = await canvasLib.loadImage(Buffer.from(image.png));
      const canvas = canvasLib.createCanvas(img.width, img.height);
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, img.width, img.height).data;
      const share = (y, x0, x1) => {
        if (y < 0 || y >= img.height) return 0;
        let count = 0;
        for (let x = x0; x <= x1; x += 1) {
          const at = (y * img.width + x) * 4;
          if (0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2] < 150) count += 1;
        }
        return count / Math.max(1, x1 - x0 + 1);
      };
      for (const region of list) {
        const x0 = Math.max(0, Math.round(region.rect.left * img.width));
        const x1 = Math.min(img.width - 1, Math.round(region.rect.right * img.width) - 1);
        const edge = (y) => Math.max(share(y - 1, x0, x1), share(y, x0, x1), share(y + 1, x0, x1));
        const top = edge(Math.round(region.rect.top * img.height));
        const bottom = edge(Math.round(region.rect.bottom * img.height) - 1);
        if (top > 0.02 || bottom > 0.02) inkCuts.push({ ...region, top, bottom });
      }
    }
  }

  // --- the sample to look at ----------------------------------------------------------------------------------------------
  const proposalOf = new Map(proposals.map((proposal) => [`${proposal.section}\u0000${proposal.label}`, proposal]));
  const chapterOfSection = (label) => String(label).split('.')[0];
  const orderedFrames = [];
  for (const section of sections) for (const proposal of exerciseSections.find((entry) => entry.section === section.id)?.proposals ?? []) orderedFrames.push(proposal);
  const pickExercises = [];
  const byChapter = new Map();
  for (const section of sections) byChapter.set(chapterOfSection(section.label), [...(byChapter.get(chapterOfSection(section.label)) ?? []), section]);
  for (const list of byChapter.values()) {
    const first = exerciseSections.find((entry) => entry.section === list[0].id)?.proposals[0];
    const lastSet = exerciseSections.find((entry) => entry.section === list[list.length - 1].id)?.proposals;
    pickExercises.push(first, lastSet?.[lastSet.length - 1]);
  }
  pickExercises.push(...evenly(orderedFrames.filter((proposal) => proposal.continues), 6));
  pickExercises.push(...evenly(orderedFrames.filter((proposal) => proposal.layout === 'figure'), 10));
  pickExercises.push(...evenly(orderedFrames.filter((proposal) => new Set((proposal.context ?? []).map((region) => region.page)).size > 1), 4));
  pickExercises.push(...evenly(orderedFrames.filter((proposal) => proposal.confidence < 0.8), 8));
  pickExercises.push(...inkCuts.filter((cut) => cut.kind === 'frame').slice(0, 6).map((cut) => proposalOf.get(`${cut.ref.split(':')[0]}\u0000${cut.ref.slice(cut.ref.indexOf(':') + 1)}`)));
  const chosenSet = new Map();
  for (const proposal of pickExercises) if (proposal) chosenSet.set(`${proposal.section}\u0000${proposal.label}`, proposal);
  const rest = evenly(orderedFrames, Math.max(0, sampleSize - chosenSet.size));
  for (const proposal of rest) chosenSet.set(`${proposal.section}\u0000${proposal.label}`, proposal);
  const chosen = [...chosenSet.values()];

  const answers = solutionSections.flatMap((section) => section.answers);
  const pickAnswers = [];
  for (const list of byChapter.values()) {
    const first = solutionSections.find((entry) => entry.section === list[0].id)?.answers[0];
    const lastSet = solutionSections.find((entry) => entry.section === list[list.length - 1].id)?.answers;
    pickAnswers.push(first, lastSet?.[lastSet.length - 1]);
  }
  pickAnswers.push(...evenly(answers.filter((answer) => answer.regions.length > 1), 4));
  pickAnswers.push(...evenly(answers.filter((answer) => answer.evidence.some((line) => /stands alone|treated as a figure/.test(line))), 6));
  pickAnswers.push(...evenly(answers.filter((answer) => answer.confidence < 0.8), 4));
  pickAnswers.push(...inkCuts.filter((cut) => cut.kind.startsWith('solution')).slice(0, 6).map((cut) => answers.find((answer) => `${answer.section}:${answer.label}` === cut.ref)));
  const chosenAnswerSet = new Map();
  for (const answer of pickAnswers) if (answer) chosenAnswerSet.set(`${answer.section}\u0000${answer.label}`, answer);
  for (const answer of evenly(answers, Math.max(0, solutionSampleSize - chosenAnswerSet.size))) chosenAnswerSet.set(`${answer.section}\u0000${answer.label}`, answer);
  const chosenAnswers = [...chosenAnswerSet.values()];

  // The first exercise beyond the reference count of a section whose count differs: the evidence that the book prints it.
  const beyond = [];
  if (reference) {
    for (const entry of reference) {
      const section = foundByLabel.get(entry.label);
      if (!section || countOf(section) <= entry.count) continue;
      const list = exerciseSections.find((candidate) => candidate.section === section.id)?.proposals ?? [];
      const extra = list[entry.count];
      if (extra) beyond.push({ entry, section, proposal: extra, last: list[list.length - 1] });
    }
  }

  // --- crops and contact sheets ----------------------------------------------------------------------------------------------
  const written = [];
  async function crop(name, page, rect) {
    const image = await renderRegion(doc, page, rect, { maxSide: 800, padding: 0.01 });
    const path = join(outDir, 'crops', `${name}.png`);
    await writeFile(path, image.png);
    written.push(path);
  }
  const tilesOfExercise = (proposal) => {
    const frame = frameOf.get(`${proposal.section}\u0000${proposal.label}`);
    const more = [];
    for (const region of frame?.continues ?? []) more.push({ page: region.page, rect: region.rect, color: '#e08000' });
    for (const region of frame?.context ?? []) more.push({ page: region.page, rect: region.rect, color: '#0060e0' });
    return { label: `${proposal.section}:${proposal.label} p${frame?.page ?? proposal.page}${frame?.continues ? ' +cont' : ''}${frame?.context?.length ? ` ctx${frame.context.length}` : ''}`, page: frame?.page ?? proposal.page, rect: frame?.rect ?? proposal.rect, more };
  };
  const tilesOfAnswer = (answer) => {
    const frame = frameOf.get(`${answer.section}\u0000${answer.label}`);
    const [main, ...more] = frame?.solution ?? answer.regions;
    return { label: `A ${answer.section}:${answer.label} p${main.page}${more.length ? ` +${more.length}` : ''}`, page: main.page, rect: main.rect, color: '#00a000', more: more.map((region) => ({ page: region.page, rect: region.rect, color: '#e08000' })) };
  };
  async function sheet(name, tiles, columns = 3) {
    if (!canvasLib || tiles.length === 0) return undefined;
    const rendered = [];
    for (const tile of tiles) {
      const parts = [];
      for (const region of [{ page: tile.page, rect: tile.rect, color: tile.color ?? '#e00000' }, ...(tile.more ?? [])]) {
        const image = await renderRegion(doc, region.page, region.rect, { padding: 0.012, maxSide: 900, scale: 1.4 });
        const img = await canvasLib.loadImage(Buffer.from(image.png));
        const canvas = canvasLib.createCanvas(img.width, img.height);
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        g.strokeStyle = region.color ?? '#e00000';
        g.lineWidth = 2;
        const v = image.view;
        const fx = (x) => ((x - v.left) / (v.right - v.left)) * img.width;
        const fy = (y) => ((y - v.top) / (v.bottom - v.top)) * img.height;
        g.strokeRect(fx(region.rect.left), fy(region.rect.top), fx(region.rect.right) - fx(region.rect.left), fy(region.rect.bottom) - fy(region.rect.top));
        parts.push(canvas);
      }
      rendered.push({ label: tile.label, parts });
    }
    const tileWidth = 640;
    const gap = 8;
    const labelHeight = 18;
    const laid = rendered.map((tile) => {
      const scaled = tile.parts.map((part) => {
        const k = Math.min(1, tileWidth / part.width);
        return { part, w: Math.round(part.width * k), h: Math.round(part.height * k) };
      });
      return { ...tile, scaled, height: labelHeight + scaled.reduce((sum, item) => sum + item.h + 4, 0) };
    });
    const rows = [];
    for (let i = 0; i < laid.length; i += columns) rows.push(laid.slice(i, i + columns));
    const totalHeight = rows.reduce((sum, row) => sum + Math.max(...row.map((tile) => tile.height)) + gap, 0);
    const surface = canvasLib.createCanvas(columns * (tileWidth + gap), totalHeight);
    const g = surface.getContext('2d');
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, surface.width, surface.height);
    let y = 0;
    for (const row of rows) {
      let x = 0;
      for (const tile of row) {
        g.fillStyle = '#ffffff';
        g.fillRect(x, y, tileWidth, tile.height);
        g.fillStyle = '#0000a0';
        g.font = 'bold 14px sans-serif';
        g.fillText(tile.label, x + 4, y + 13);
        let yy = y + labelHeight;
        for (const item of tile.scaled) {
          g.drawImage(item.part, x, yy, item.w, item.h);
          yy += item.h + 4;
        }
        x += tileWidth + gap;
      }
      y += Math.max(...row.map((tile) => tile.height)) + gap;
    }
    const path = join(outDir, 'sheets', `${name}.png`);
    await writeFile(path, await surface.encode('png'));
    written.push(path);
    return path;
  }
  for (const proposal of chosen) {
    const tile = tilesOfExercise(proposal);
    await crop(`ex-${safe(proposal.section)}-${safe(proposal.label)}`, tile.page, tile.rect);
    for (const [index, region] of (frameOf.get(`${proposal.section}\u0000${proposal.label}`)?.continues ?? []).entries()) await crop(`ex-${safe(proposal.section)}-${safe(proposal.label)}-continues${index}`, region.page, region.rect);
    for (const [index, region] of (frameOf.get(`${proposal.section}\u0000${proposal.label}`)?.context ?? []).entries()) await crop(`ex-${safe(proposal.section)}-${safe(proposal.label)}-context${index}`, region.page, region.rect);
  }
  for (const answer of chosenAnswers) for (const [index, region] of (frameOf.get(`${answer.section}\u0000${answer.label}`)?.solution ?? answer.regions).entries()) await crop(`solution-${safe(answer.section)}-${safe(answer.label)}${index > 0 ? `-${index}` : ''}`, region.page, region.rect);
  for (const item of beyond) {
    const tile = tilesOfExercise(item.proposal);
    await crop(`beyond-${safe(item.section.label)}-first-extra-${safe(item.proposal.label)}`, tile.page, tile.rect);
    const lastTile = tilesOfExercise(item.last);
    await crop(`beyond-${safe(item.section.label)}-last-${safe(item.last.label)}`, lastTile.page, lastTile.rect);
  }
  const sheets = [];
  for (let k = 0; k * 12 < chosen.length; k += 1) {
    const made = await sheet(`exercises-${String(k + 1).padStart(2, '0')}`, chosen.slice(k * 12, k * 12 + 12).map(tilesOfExercise));
    if (made) sheets.push(made);
  }
  for (let k = 0; k * 12 < chosenAnswers.length; k += 1) {
    const made = await sheet(`solutions-${String(k + 1).padStart(2, '0')}`, chosenAnswers.slice(k * 12, k * 12 + 12).map(tilesOfAnswer));
    if (made) sheets.push(made);
  }
  await doc.close();

  // --- the report ----------------------------------------------------------------------------------------------------------------
  const lines = [];
  const found = new Map(exerciseSections.map((section) => [section.section, section]));
  const solved = new Map(solutionSections.map((section) => [section.section, section]));
  const offset = derived.result.numbering.offset;
  const printed = (page) => (offset === undefined ? '?' : page + offset);
  const totalExercises = book.result.totals?.exercises ?? frames.length;
  const totalSolved = book.result.totals?.withSolution ?? frames.filter((frame) => frame.solution?.length > 0).length;
  const withoutAnswer = solutionSections.reduce((sum, section) => sum + section.withoutAnswer.length, 0);
  const withoutExercise = solutionSections.reduce((sum, section) => sum + section.withoutExercise.length, 0);
  const warnings = validation.result.warnings ?? [];
  const warningsByCode = {};
  for (const warning of warnings) warningsByCode[warning.code] = (warningsByCode[warning.code] ?? 0) + 1;
  lines.push(`# Acceptance report: ${title}`, '', `Generated by scripts/acceptance-book.mjs. PDF: ${basename(pdfPath)}. Nothing was uploaded. Pages are zero-based, as in \`mcprep render\` and \`crop\`${offset === undefined ? '' : `; the printed page number is the page + ${offset}`}.`, '');
  lines.push('## Summary', '');
  lines.push(`- Chapters found: ${chapters.length}; sections: ${sections.length}; other entries: ${entries.length - chapters.length - sections.length}.`);
  lines.push(`- Printed contents on pages ${derived.result.toc.pages.join(', ') || 'none'}, ${derived.result.toc.openers.length} chapter opener lists; answer key from page ${derived.result.answerKey?.page ?? 'not found'}.`);
  lines.push(`- Exercises stored: ${totalExercises} in ${sections.filter((entry) => countOf(entry) > 0).length} sections; with a solution region: ${totalSolved} (${pct(totalSolved, totalExercises)}); proposed by the tool: ${proposals.length}.`);
  lines.push(`- Solutions: ${count(answers.length, 'answer')} matched; ${count(withoutAnswer, 'exercise')} without an answer, ${count(withoutExercise, 'answer')} without an exercise.`);
  lines.push(`- Applying the same proposals again: ${again.result.applied === false && again.result.counts.unchanged === proposals.length && again.result.counts.added === 0 ? `nothing changed (${again.result.counts.unchanged} exercises unchanged)` : `CHANGED the project: ${JSON.stringify(again.result.counts)}`}; \`solutions propose --apply\`: ${againSolutions.result.applied === false ? 'nothing to add' : `ADDED ${againSolutions.result.counts.added} solutions`}.`);
  lines.push(`- Validation: ${validation.result.ok ? 'ok' : 'ERRORS'}; errors ${validation.result.errors?.length ?? '?'}, warnings ${warnings.length}${warnings.length > 0 ? ` (${Object.entries(warningsByCode).map(([code, count]) => `${code} ${count}`).join(', ')})` : ''}.`);
  if (verifyCounts) lines.push(`- Text check (exercises verify${canvasLib ? ' --ink' : ''}): errors ${verifyCounts.errors}, warnings ${verifyCounts.warnings}, infos ${verifyCounts.infos}${Object.keys(verifyByCode).length > 0 ? ` (${Object.entries(verifyByCode).sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code} ${n}`).join(', ')})` : ''}${verifyCounts.answersBeyondTheCap ? `; ${verifyCounts.answersBeyondTheCap} answers of the exercises that the cap left out are in the key and are not counted` : ''}; every finding is in verify-details.json.`);
  else lines.push(`- Text check (exercises verify): it did not run (${verifyRun.envelope.error?.message ?? 'no report'}).`);
  lines.push(`- Bundle: ${exported.code === 0 ? bundlePath : `export failed: ${exported.envelope.error?.message}`}${check ? `; importer check: ${check.code === 0 && check.result.wouldImport ? 'would import' : `WOULD NOT IMPORT${check.envelope.error ? ` (${check.envelope.error.message})` : ''}`}` : ''}.`);
  lines.push(`- Project file: ${projectPath} (the PDF is referenced by its relative path, not copied).`);
  if (!licenseStated) {
    lines.push(`- Licence: none stated (optional); the bundle carries none and nothing was taken from the book.`);
    for (const suggestion of suggestions) lines.push(`  - suggestion (confirm it, nothing was written): ${suggestion.field}${suggestion.field === 'warning' ? '' : ' = '}${suggestion.value} (page ${suggestion.page + 1}: "${suggestion.evidence.slice(0, 140)}")`);
  }
  lines.push(`- Edges that run through ink (more than 2 % of the width of a region's top or bottom edge is dark): ${canvasLib ? `${inkCuts.length} of ${regions.length} regions (frames ${inkCuts.filter((cut) => cut.kind === 'frame').length}, instructions ${inkCuts.filter((cut) => cut.kind.startsWith('context')).length}, continuations ${inkCuts.filter((cut) => cut.kind.startsWith('continues')).length}, solutions ${inkCuts.filter((cut) => cut.kind.startsWith('solution')).length})` : 'not checked (no canvas)'}.`);
  lines.push(`- Looked at: ${chosen.length} exercises and ${chosenAnswers.length} solution regions as crops (${join(outDir, 'crops')}) and on ${sheets.length} contact sheets (${join(outDir, 'sheets')}).`, '');
  const documentInfo = project.meta?.document ?? project.meta ?? {};
  lines.push('## What the document says about itself', '', '```json', JSON.stringify(documentInfo, null, 2), '```', '');

  let referenceSummary = null;
  if (reference) {
    const refByLabel = new Map(reference.map((entry) => [entry.label, entry]));
    const missing = reference.filter((entry) => !foundByLabel.has(entry.label));
    const extra = sections.filter((entry) => !refByLabel.has(entry.label));
    const titleDiff = reference.filter((entry) => foundByLabel.has(entry.label) && titleKey(foundByLabel.get(entry.label).title) !== titleKey(entry.title));
    const countDiff = reference.filter((entry) => foundByLabel.has(entry.label) && countOf(foundByLabel.get(entry.label)) !== entry.count);
    const equal = reference.filter((entry) => foundByLabel.has(entry.label) && countOf(foundByLabel.get(entry.label)) === entry.count).length;
    const referenceTotal = reference.reduce((sum, entry) => sum + entry.count, 0);
    referenceSummary = {
      sections: reference.length,
      found: sections.length,
      missing: missing.map((entry) => entry.label),
      extra: extra.map((entry) => entry.label),
      equalCounts: equal,
      countDifferences: countDiff.map((entry) => ({ label: entry.label, title: entry.title, reference: entry.count, found: countOf(foundByLabel.get(entry.label)) })),
      titleDifferences: titleDiff.length,
      totalReference: referenceTotal,
      totalFound: totalExercises,
      pagesOf: Object.fromEntries(countDiff.map((entry) => [entry.label, found.get(foundByLabel.get(entry.label).id).pages])),
    };
    lines.push('## Comparison with the reference', '');
    lines.push(`- Sections: ${sections.length} found, ${reference.length} in the reference; missing ${missing.length}, extra ${extra.length}.`);
    lines.push(`- Exercise counts equal in ${equal} of ${reference.length} sections; they differ in ${countDiff.length}. Titles that differ after normalising: ${titleDiff.length}.`);
    lines.push(`- Exercises: ${totalExercises} stored, ${referenceTotal} in the reference (${totalExercises - referenceTotal >= 0 ? '+' : ''}${totalExercises - referenceTotal}).`, '');
    const chapterRows = new Map();
    for (const entry of reference) {
      const row = chapterRows.get(entry.chapterLabel ?? chapterOfSection(entry.label)) ?? { title: entry.chapterTitle ?? '', sections: 0, reference: 0, found: 0, equal: 0 };
      row.sections += 1;
      row.reference += entry.count;
      const section = foundByLabel.get(entry.label);
      if (section) {
        row.found += countOf(section);
        if (countOf(section) === entry.count) row.equal += 1;
      }
      chapterRows.set(entry.chapterLabel ?? chapterOfSection(entry.label), row);
    }
    lines.push('### Per chapter', '', '| chapter | title | sections | exercises in the reference | exercises found | sections with the same count |', '| --- | --- | --- | --- | --- | --- |');
    for (const [label, row] of chapterRows) lines.push(`| ${label} | ${cell(row.title)} | ${row.sections} | ${row.reference} | ${row.found} | ${row.equal} |`);
    lines.push('');
    if (titleDiff.length > 0) {
      lines.push('### Titles that differ', '', '| section | found | reference | where the spellings differ |', '| --- | --- | --- | --- |');
      for (const entry of titleDiff) lines.push(`| ${entry.label} | ${cell(foundByLabel.get(entry.label).title)} | ${cell(entry.title)} | ${cell(foundByLabel.get(entry.label).differences?.map((d) => `${d.source}: ${d.text}`).join('; '))} |`);
      lines.push('');
    }
    if (countDiff.length > 0) {
      lines.push('### Exercise counts that differ', '', 'Every number was read from a line of the page that starts with it; the first exercise beyond the reference count and the last one are cropped into `crops/beyond-*.png`.', '', '| section | title | reference | found | numbers | pages (printed) | why |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const entry of countDiff) {
        const section = found.get(foundByLabel.get(entry.label).id);
        const count = countOf(foundByLabel.get(entry.label));
        const why = [];
        if (section.gaps.length > 0) why.push(`no line starts with ${section.gaps.join(', ')}`);
        if (section.duplicates.length > 0) why.push(`printed twice: ${section.duplicates.join(', ')}`);
        if (count > entry.count && section.gaps.length === 0) why.push(`the book prints ${count} numbered exercises (${section.first}..${section.last}) on page${section.pages[0] === section.pages[1] ? '' : 's'} ${pages(section.pages[0], section.pages[1])}; the reference counts ${entry.count}`);
        if (count < entry.count && section.gaps.length === 0) why.push(`only ${count} numbered exercises were found; the reference counts ${entry.count}`);
        for (const note of section.notes) if (!why.some((text) => text.includes(note.slice(0, 20)))) why.push(note);
        lines.push(`| ${entry.label} | ${cell(entry.title)} | ${entry.count} | ${count} | ${section.first ?? ''}..${section.last ?? ''} | ${pages(section.pages[0], section.pages[1])} (${pages(printed(section.pages[0]), printed(section.pages[1]))}) | ${cell(why.join('; '))} |`);
      }
      lines.push('');
    }
    if (missing.length > 0) lines.push(`Sections of the reference that were not found: ${missing.map((entry) => entry.label).join(', ')}.`, '');
    if (extra.length > 0) lines.push(`Sections found that the reference does not have: ${extra.map((entry) => entry.label).join(', ')}.`, '');
  }

  lines.push('## Per section', '', `| section | title | page | conf | practice pages | exercises${reference ? ' / reference' : ''} | numbers | answers | no answer | no exercise | notes |`, '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of sections) {
    const section = found.get(entry.id);
    const solution = solved.get(entry.id);
    const notes = [...(section?.notes ?? []), ...(solution?.notes ?? [])];
    lines.push(
      `| ${entry.label} | ${cell(entry.title)} | ${entry.page} | ${entry.confidence} | ${section ? pages(section.pages[0], section.pages[1]) : ''} | ${countOf(entry)}${reference ? ` / ${reference.find((ref) => ref.label === entry.label)?.count ?? '?'}` : ''} | ${section?.first ?? ''}..${section?.last ?? ''} | ${stored.get(entry.id)?.withSolution ?? 0} | ${cell((solution?.withoutAnswer ?? []).join(', '))} | ${cell((solution?.withoutExercise ?? []).join(', '))} | ${cell(notes.join('; '))} |`,
    );
  }
  lines.push('');

  lines.push('## Solution coverage', '');
  lines.push(`- ${totalSolved} of ${totalExercises} exercises (${pct(totalSolved, totalExercises)}) have a solution region; ${count(withoutAnswer, 'exercise')} ${withoutAnswer === 1 ? 'has' : 'have'} no answer in the key, ${count(withoutExercise, 'answer')} in the key ${withoutExercise === 1 ? 'has' : 'have'} no exercise.`);
  for (const section of solutionSections) {
    if (section.withoutAnswer.length > 0 || section.withoutExercise.length > 0) {
      lines.push(`  - ${section.section}: ${section.withoutAnswer.length > 0 ? `no answer for ${section.withoutAnswer.join(', ')}` : ''}${section.withoutExercise.length > 0 ? `${section.withoutAnswer.length > 0 ? '; ' : ''}answers without an exercise: ${section.withoutExercise.join(', ')}` : ''}${section.notes.length > 0 ? ` (${section.notes.join('; ')})` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Validation warnings', '');
  if (warnings.length === 0) lines.push('None.');
  else {
    lines.push('Warnings are allowed; they are listed so that they can be looked at. `clips-line` on a solution region usually comes from a row of the answer key that the text layer joins across columns (its box is taller than either answer), `includes-header-footer` on an answer from a small number set above or below a line (an exponent) that looks like a page number. The ink check above is the more exact measure.', '');
    for (const [code, count] of Object.entries(warningsByCode)) lines.push(`- ${code}: ${count}`);
  }
  lines.push('');

  if (canvasLib && inkCuts.length > 0) {
    lines.push('## Edges on ink', '', 'The regions below have an edge whose pixel row runs through dark pixels (share of the width in brackets): a glyph of the neighbouring line is cut or included. Worst first.', '', '| exercise | region | page | top | bottom |', '| --- | --- | --- | --- | --- |');
    for (const cut of [...inkCuts].sort((a, b) => Math.max(b.top, b.bottom) - Math.max(a.top, a.bottom)).slice(0, 40)) lines.push(`| ${cut.ref} | ${cut.kind} | ${cut.page} | ${Math.round(cut.top * 100)} % | ${Math.round(cut.bottom * 100)} % |`);
    lines.push('');
  }

  lines.push('## Anomalies', '');
  for (const note of [...derived.result.notes, ...propose.result.notes.filter((note) => !derived.result.notes.includes(note))]) lines.push(`- ${note}`);
  for (const section of exerciseSections) for (const rejected of section.rejected) lines.push(`- ${section.section}: put aside "${rejected.text}" on page ${rejected.page}: ${rejected.reason}`);
  const lowConfidence = proposals.filter((proposal) => proposal.confidence < 0.8);
  if (lowConfidence.length > 0) lines.push(`- ${lowConfidence.length} exercises with a confidence below 0.8: ${lowConfidence.map((proposal) => `${proposal.section}:${proposal.label}`).join(', ')}.`);
  lines.push('', '## Timings', '', ...timings.map((line) => `- ${line}`), '');
  await writeFile(join(outDir, 'acceptance-report.md'), `${lines.join('\n')}\n`);
  if (verifyReport) await writeFile(join(outDir, 'verify-details.json'), `${JSON.stringify(verifyReport)}
`);
  await writeFile(join(outDir, 'acceptance-details.json'), `${JSON.stringify({ sections: entries, exercises: details.sectionsDetail, solutions: details.solutions, inkCuts: inkCuts.map((cut) => ({ ref: cut.ref, kind: cut.kind, page: cut.page, top: cut.top, bottom: cut.bottom })) }, null, 1)}\n`);
  // What there is to look at, for the index of the books: the findings that the report marks, most important first.
  const look = [];
  if (validation.result.ok === false) look.push(`validation reports ${validation.result.errors?.length ?? '?'} errors: ${validation.result.errors?.[0]?.message ?? 'see the report'}`);
  if (exported.code !== 0) look.push(`the bundle could not be written: ${exported.envelope.error?.message ?? ''}`);
  else if (check && !(check.code === 0 && check.result.wouldImport)) look.push(`the importer check says the bundle would NOT import: ${check.envelope.error?.message ?? check.result.rejection?.message ?? 'see the report'}`);
  if (!(again.result.applied === false && again.result.counts.unchanged === proposals.length && again.result.counts.added === 0) || againSolutions.result.applied !== false) look.push('running the proposals a second time changed the project: it should not');
  if (referenceSummary) {
    if (referenceSummary.missing.length > 0) look.push(`sections of the reference that were not found: ${referenceSummary.missing.join(', ')}`);
    if (referenceSummary.extra.length > 0) look.push(`sections found that the reference does not have: ${referenceSummary.extra.join(', ')}`);
    for (const entry of referenceSummary.countDifferences) {
      const where = referenceSummary.pagesOf[entry.label];
      look.push(`${entry.label} ${entry.title}: ${entry.found} exercises found, the reference lists ${entry.reference}${where ? ` (pages ${pages(where[0], where[1])}, crops/beyond-${safe(entry.label)}-*.png)` : ''}`);
    }
    if (referenceSummary.titleDifferences > 0) look.push(`${referenceSummary.titleDifferences} titles differ from the reference after normalising (see the report)`);
  }
  for (const note of [...derived.result.notes, ...propose.result.notes.filter((note) => !derived.result.notes.includes(note))]) look.push(note);
  for (const section of exerciseSections) for (const note of section.notes) look.push(`${section.section}: ${note}`);
  for (const section of exerciseSections) for (const rejected of section.rejected) look.push(`${section.section}: put aside "${rejected.text.slice(0, 50)}" on page ${rejected.page}: ${rejected.reason}`);
  for (const section of solutionSections) {
    if (section.withoutAnswer.length > 0) look.push(`${section.section}: no answer in the key for ${section.withoutAnswer.join(', ')}`);
    // An answer whose exercise was left out by the cap is expected.
    const capped = new Set(exerciseSections.find((entry) => entry.section === section.section)?.excluded ?? []);
    const orphans = section.withoutExercise.filter((label) => !capped.has(label));
    if (orphans.length > 0) look.push(`${section.section}: answers without an exercise: ${orphans.join(', ')}`);
  }
  if (lowConfidence.length > 0) look.push(`${lowConfidence.length} exercises with a confidence below 0.8: ${lowConfidence.map((proposal) => `${proposal.section}:${proposal.label}`).join(', ')}`);
  if (verifyCounts && verifyCounts.errors > 0) look.push(`exercises verify reports ${verifyCounts.errors} error${verifyCounts.errors === 1 ? '' : 's'} (${Object.entries(verifyByCode).filter(([key]) => key.startsWith('error')).sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key.slice(6)} ${n}`).join(', ')}); the first are in the report, all in verify-details.json`);
  if (canvasLib && inkCuts.length > 0) look.push(`${inkCuts.length} of ${regions.length} regions have an edge that runs through ink (the worst are listed in the report)`);
  if (warnings.length > 0) look.push(`${warnings.length} validation warning${warnings.length === 1 ? "" : "s"} (${Object.entries(warningsByCode).map(([code, n]) => `${code} ${n}`).join(', ')}); clips-line and includes-header-footer are usually not defects (see docs/AUDIT_A_BOOK.md)`);
  // A book the tool does not read the way it is written gives nothing to propose: say so first, and do not list it section by section.
  if (sections.length === 0) look.unshift('No chapters or sections were found: this PDF has no printed table of contents with numbered sections that the tool reads (see "Other books" in docs/AUDIT_A_BOOK.md), or it is not a textbook.');
  else if (totalExercises === 0) look.unshift('No exercises were found: the book does not print them as numbered practice sets under a heading that the tool reads. The words and the patterns can be set in the sidecar (options: practiceWords, itemPattern, instructions; see "Other books" in docs/AUDIT_A_BOOK.md), or the book needs another reading.');
  const toLookAt = groupFindings([...new Set(look)]);
  const summary = {
    name: stem,
    title,
    pages: project.pdf?.pageCount ?? doc.pageCount,
    chapters: chapters.length,
    sections: sections.length,
    exercises: totalExercises,
    withSolution: totalSolved,
    withoutAnswer,
    answersWithoutExercise: withoutExercise,
    validation: { ok: validation.result.ok === true, errors: validation.result.errors?.length ?? 0, warnings: warnings.length },
    verify: verifyCounts ?? null,
    importCheck: check ? { wouldImport: check.code === 0 && check.result.wouldImport === true } : null,
    idempotent: again.result.applied === false && againSolutions.result.applied === false,
    license: licenseStated ? { name: options.get('license-name'), ...(options.has('license-url') ? { url: options.get('license-url') } : {}) } : null,
    licenseStated,
    author: options.get('author') ?? null,
    suggestions,
    reference: referenceSummary ? { ...referenceSummary, pagesOf: undefined } : null,
    edgesOnInk: inkCuts.length,
    regions: regions.length,
    toLookAt: toLookAt.length > 40 ? [...toLookAt.slice(0, 40), `... and ${toLookAt.length - 40} more: see acceptance-report.md`] : toLookAt,
    files: { project: basename(projectPath), bundle: exported.code === 0 ? basename(bundlePath) : null, report: 'acceptance-report.md', details: 'acceptance-details.json', verify: verifyReport ? 'verify-details.json' : null, sheets: 'sheets', crops: 'crops' },
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
  await writeFile(join(outDir, 'acceptance-summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(`report: ${join(outDir, 'acceptance-report.md')}`);
  if (!licenseStated) {
    for (const suggestion of suggestions) console.log(`  suggestion (confirm it; nothing was written): ${suggestion.field}${suggestion.field === 'warning' ? '' : ' = '}${suggestion.value} (page ${suggestion.page + 1}: "${suggestion.evidence.slice(0, 100)}")`);
  }
  console.log(`${chapters.length} chapters, ${sections.length} sections, ${totalExercises} exercises (${totalSolved} with a solution), ${inkCuts.length} regions with an edge on ink, ${warnings.length} warnings; crops: ${written.length}`);
} catch (error) {
  // One line that says what stopped the book, for the index of the books (the log has the rest).
  const firstLine = (value) => String(value).split('\n')[0];
  console.error(`${stem}: ${firstLine(error?.message ?? error)}${error?.hint ? ` (${firstLine(error.hint)})` : ''}`);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
