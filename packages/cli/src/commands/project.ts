import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  McPrepError,
  PdfDocument,
  ProjectSession,
  countFrames,
  hashFile,
  readProjectFile,
  resolvePdfPath,
  updateProjectFile,
  type PageSize,
} from '@mcprep/core';
import { stringOption } from '../args.js';
import { plural } from '../format.js';
import type { CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS, applyAndReport } from './common.js';

export const init: CommandSpec = {
  name: 'init',
  summary: 'Create a project for a PDF.',
  description:
    'Reads the PDF once (page count, SHA-256) and writes <name>.mcprep.json next to it. The project holds the frames you mark; the PDF is only referenced by a relative path and its hash.',
  noProject: true,
  writes: true,
  args: [{ name: 'pdf', description: 'The PDF to mark.', required: true }],
  options: [
    { name: 'out', short: 'o', type: 'string', value: '<file>', description: 'Where to write the project (default: next to the PDF).' },
    { name: 'title', type: 'string', value: '<text>', description: 'The title the app library shows (default: the file name).' },
    { name: 'folder', type: 'string', value: '<A/B>', description: 'Where the document is filed in the library, names separated by "/", at most seven levels.' },
    { name: 'force', type: 'boolean', description: 'Overwrite an existing project file.' },
  ],
  examples: ['mcprep init analysis.pdf --title "Analysis 1: Sheets" --folder "University/Analysis"', 'mcprep init book.pdf --out work/book.mcprep.json --force'],
  output: '{ project, pdf: { path, sha256, bytes, pageCount }, title, folder?, next: string[] }',
  async run(context) {
    const pdf = context.args[0] as string;
    const title = stringOption(context.options, 'title');
    const folder = stringOption(context.options, 'folder');
    const out = stringOption(context.options, 'out');
    const session = await ProjectSession.create(resolve(context.io.cwd, pdf), {
      ...(out !== undefined ? { projectPath: resolve(context.io.cwd, out) } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(folder !== undefined ? { folder } : {}),
      ...(context.options['force'] === true ? { force: true } : {}),
      modifiedBy: 'cli',
    });
    const project = session.project;
    await session.close();
    const next = [
      `mcprep info --project "${session.projectPath}"`,
      `mcprep propose --project "${session.projectPath}"`,
      `mcprep render 0 --grid 0.1 --project "${session.projectPath}"`,
    ];
    return {
      result: { project: session.projectPath, pdf: project.pdf, title: project.meta.title, ...(project.meta.folder !== undefined ? { folder: project.meta.folder } : {}), next },
      text: [`Created ${session.projectPath}`, `  PDF: ${project.pdf.path} (${plural(project.pdf.pageCount, 'page')}, ${project.pdf.bytes} bytes)`, `  title: ${project.meta.title}`, ...(project.meta.folder ? [`  folder: ${project.meta.folder}`] : []), 'Next:', ...next.map((line) => `  ${line}`)].join('\n'),
    };
  },
};

interface SizeGroup {
  width: number;
  height: number;
  rotation: number;
  pages: number[];
}

function groupSizes(sizes: readonly PageSize[]): SizeGroup[] {
  const groups = new Map<string, SizeGroup>();
  sizes.forEach((size, page) => {
    const key = `${Math.round(size.width)}x${Math.round(size.height)}@${size.rotation}`;
    const group = groups.get(key);
    if (group) group.pages.push(page);
    else groups.set(key, { width: Math.round(size.width * 10) / 10, height: Math.round(size.height * 10) / 10, rotation: size.rotation, pages: [page] });
  });
  return [...groups.values()];
}

const rangeText = (pages: readonly number[]): string => {
  const parts: string[] = [];
  let start = pages[0] as number;
  let previous = start;
  for (const page of [...pages.slice(1), Number.POSITIVE_INFINITY]) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  return parts.join(',');
};

export const info: CommandSpec = {
  name: 'info',
  summary: 'Show the project, the PDF (pages, sizes, text layer, outline) and the frames.',
  description:
    'Page numbers are zero-based everywhere. The text layer is checked on a sample of up to 12 pages (all pages with --full-text); a page without a text layer is a scan and must be marked by eye (see `render --grid`).',
  options: [
    { name: 'full-text', type: 'boolean', description: 'Check the text layer of every page, not a sample.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep info', 'mcprep info --json'],
  output:
    '{ project: { path, title, folder?, revision, modifiedBy?, updatedAt }, pdf: { path, pageCount, bytes, sha256, pageSizes: [{ width, height, rotation, pages }], textLayer: { checked, withText, withoutText: number[] } }, outline: { pdf: number|null, project: number|null, source? }, frames: { exercises, questions, bookmarks, total, partsOfUnits, byPage } }',
  async run(context) {
    const session = await context.session();
    const project = session.project;
    const pdf = await session.document();
    const sizes = await pdf.pageSizes();
    const checked: number[] = [];
    if (context.options['full-text'] === true || pdf.pageCount <= 12) for (let page = 0; page < pdf.pageCount; page += 1) checked.push(page);
    else for (let i = 0; i < 12; i += 1) checked.push(Math.round((i * (pdf.pageCount - 1)) / 11));
    const withoutText: number[] = [];
    for (const page of [...new Set(checked)]) if (!(await pdf.rawPageText(page)).hasText) withoutText.push(page);
    const pdfOutline = await pdf.outline();
    const counts = countFrames(project.frames);
    const byPage: Record<string, number> = {};
    for (const frame of project.frames) byPage[String(frame.page)] = (byPage[String(frame.page)] ?? 0) + 1;
    const groups = groupSizes(sizes);
    const result = {
      project: {
        path: session.projectPath,
        title: project.meta.title,
        ...(project.meta.folder !== undefined ? { folder: project.meta.folder } : {}),
        revision: project.revision,
        ...(project.modifiedBy !== undefined ? { modifiedBy: project.modifiedBy } : {}),
        updatedAt: project.updatedAt,
      },
      pdf: {
        path: session.pdfPath,
        pageCount: pdf.pageCount,
        bytes: pdf.bytes,
        sha256: pdf.sha256,
        pageSizes: groups,
        textLayer: { checked: new Set(checked).size, withText: new Set(checked).size - withoutText.length, withoutText },
      },
      outline: { pdf: pdfOutline ? pdfOutline.length : null, project: project.outline ? project.outline.entries.length : null, ...(project.outline ? { source: project.outline.source } : {}) },
      frames: { exercises: counts.exercise, questions: counts.question, bookmarks: counts.bookmark, total: project.frames.length, partsOfUnits: project.frames.filter((frame) => frame.unit !== undefined).length, byPage },
    };
    const lines = [
      `Project ${session.projectPath}`,
      `  title: ${project.meta.title}${project.meta.folder ? `   folder: ${project.meta.folder}` : ''}`,
      `  revision ${project.revision}${project.modifiedBy ? `, last saved by ${project.modifiedBy}` : ''} at ${project.updatedAt}`,
      `PDF ${session.pdfPath}`,
      `  ${plural(pdf.pageCount, 'page')}, ${pdf.bytes} bytes, sha256 ${pdf.sha256.slice(0, 16)}...`,
      ...groups.map((group) => `  size ${group.width} x ${group.height} pt${group.rotation ? `, /Rotate ${group.rotation}` : ''}: pages ${rangeText(group.pages)}`),
      withoutText.length === 0 ? `  text layer: present on all ${new Set(checked).size} pages checked` : `  text layer: MISSING on pages ${rangeText(withoutText)} (scans: mark them by eye with \`render --grid\`)`,
      `  outline: ${pdfOutline ? `${plural(pdfOutline.length, 'entry', 'entries')} in the PDF` : 'none in the PDF'}${project.outline ? `; the project has its own (${project.outline.source}, ${plural(project.outline.entries.length, 'entry', 'entries')})` : ''}`,
      `Frames: ${plural(counts.exercise, 'exercise')}, ${plural(counts.question, 'question')}, ${plural(counts.bookmark, 'bookmark')}`,
    ];
    return { result, text: lines.join('\n') };
  },
};

export const meta: CommandSpec = {
  name: 'meta',
  summary: 'Show or change the title and library folder of the project.',
  writes: true,
  options: [
    { name: 'title', type: 'string', value: '<text>', description: 'The title the app library shows (1 to 200 characters).' },
    { name: 'folder', type: 'string', value: '<A/B>', description: 'Library folder, names separated by "/", at most seven levels. An empty text ("") removes it.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep meta --title "Analysis 1" --folder "University/Analysis/Sheets"', 'mcprep meta'],
  output: '{ title, folder? } (with the usual change report when something was changed)',
  async run(context) {
    const title = stringOption(context.options, 'title');
    const folder = stringOption(context.options, 'folder');
    if (title === undefined && folder === undefined) {
      const session = await context.session();
      const { title: current, folder: where } = session.project.meta;
      return { result: { title: current, ...(where !== undefined ? { folder: where } : {}) }, text: `title: ${current}\nfolder: ${where ?? '(none)'}` };
    }
    return applyAndReport(context, [{ op: 'meta.set', ...(title !== undefined ? { title } : {}), ...(folder !== undefined ? { folder } : {}) }], 'changed the title and folder');
  },
};

export const relink: CommandSpec = {
  name: 'relink',
  summary: 'Point the project at the PDF where it now is.',
  description:
    'Use it when the PDF was moved or renamed. The new file must be the same PDF (same SHA-256); a different file is refused unless --accept-changed, because frames are positions on the pages of one exact file.',
  noProject: true,
  writes: true,
  args: [{ name: 'pdf', description: 'The PDF at its new place.', required: true }],
  options: [
    { name: 'accept-changed', type: 'boolean', description: 'Accept a PDF with a different hash (and update the page count). Check `validate` afterwards.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep relink "D:/books/analysis.pdf"'],
  output: '{ project, pdf: { path, sha256, bytes, pageCount }, changed: boolean }',
  async run(context) {
    const projectPath = await context.projectPath();
    const target = resolve(context.io.cwd, context.args[0] as string);
    const current = await readProjectFile(projectPath);
    const hashed = await hashFile(target);
    const same = hashed.sha256 === current.pdf.sha256;
    if (!same && context.options['accept-changed'] !== true) {
      throw new McPrepError('E_PDF_CHANGED', 'That PDF is not the one this project was made for: its SHA-256 differs.', {
        hint: 'Relink to the original file, or accept the change with --accept-changed and check `mcprep validate`.',
      });
    }
    let pageCount = current.pdf.pageCount;
    if (!same) {
      const pdf = await PdfDocument.open(target);
      pageCount = pdf.pageCount;
      await pdf.close();
    }
    const rel = relative(dirname(projectPath), target).replace(/\\/g, '/');
    const stored = isAbsolute(rel) ? target.replace(/\\/g, '/') : rel;
    const written = await updateProjectFile(projectPath, (project) => ({ ...project, pdf: { path: stored, sha256: hashed.sha256, bytes: hashed.size, pageCount } }), { modifiedBy: 'cli' });
    return {
      result: { project: projectPath, pdf: written.pdf, changed: !same, resolved: resolvePdfPath(projectPath, written) },
      text: `The project now points at ${written.pdf.path}${same ? '' : ` (a different file; ${plural(pageCount, 'page')})`}.`,
    };
  },
};

