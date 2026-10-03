import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  McPrepError,
  PdfDocument,
  linesInRect,
  overlayBoxes,
  parseRect,
  renderPage,
  renderRegion,
  type Frame,
  type OverlayBox,
  type PageText,
  type Project,
  type Rect,
  type RenderOptions,
} from '@mcprep/core';
import { flag, numberOption, pageNumber, stringOption, usage } from '../args.js';
import { plural, rectText, round4, table } from '../format.js';
import type { CommandContext, CommandSpec, OptionSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

const PDF_OPTION: OptionSpec = { name: 'pdf', type: 'string', value: '<file>', description: 'Work on this PDF directly, without a project (no frames, no numbering).' };

interface Opened {
  doc: PdfDocument;
  project?: Project;
  /** Folder for generated images: `.mcprep-cache` next to the project or the PDF. */
  cache: string;
  close(): Promise<void>;
}

async function open(context: CommandContext): Promise<Opened> {
  const pdfOption = stringOption(context.options, 'pdf');
  if (pdfOption !== undefined) {
    const path = resolve(context.io.cwd, pdfOption);
    const doc = await PdfDocument.open(path);
    return { doc, cache: join(dirname(path), '.mcprep-cache'), close: () => doc.close() };
  }
  const session = await context.session();
  const doc = await session.document();
  return { doc, project: session.project, cache: join(dirname(session.projectPath), '.mcprep-cache'), close: () => session.close() };
}

/** `--out` may be a file, or a folder (existing, or ending with a slash); the default is the cache folder. */
async function outputPath(out: string | undefined, cwd: string, cache: string, fileName: string): Promise<string> {
  if (out === undefined) return join(cache, fileName);
  const path = resolve(cwd, out);
  const isFolder = /[\\/]$/.test(out) || (await stat(path).then((info) => info.isDirectory(), () => false));
  return isFolder ? join(path, fileName) : extname(path) === '' ? `${path}.png` : path;
}

async function save(path: string, png: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
}

function gridOption(options: CommandContext['options']): number | false {
  const step = numberOption(options, 'grid');
  if (step === undefined) return false;
  if (!(step > 0 && step <= 0.5)) throw usage(`--grid must be a step between 0 and 0.5 (for example 0.1 or 0.05), not ${step}.`);
  return step;
}

function imageOptions(context: CommandContext, boxes?: OverlayBox[]): RenderOptions {
  const grid = gridOption(context.options);
  const maxSide = numberOption(context.options, 'max-side');
  const scale = numberOption(context.options, 'scale');
  const padding = numberOption(context.options, 'padding');
  return {
    ...(grid !== false ? { grid } : {}),
    ...(maxSide !== undefined ? { maxSide } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(boxes && boxes.length > 0 ? { boxes } : {}),
  };
}

const IMAGE_OPTIONS: OptionSpec[] = [
  { name: 'grid', type: 'number', value: '<step>', description: 'Draw a labelled grid with a line every <step> of the page (0.1 or 0.05). The labels are page coordinates: read positions straight off the image.' },
  { name: 'frames', type: 'boolean', description: 'Draw the project\'s frames (with their labels E1, E2.1, Q1, B1), continuations and context.' },
  { name: 'max-side', type: 'number', value: '<px>', description: 'Longer side of the image in pixels (default 1600 for a page, 1400 for a crop).' },
  { name: 'scale', type: 'number', value: '<px/pt>', description: 'Pixels per point instead of --max-side.' },
  { name: 'out', short: 'o', type: 'string', value: '<file|folder>', description: 'Where to write the PNG (default: .mcprep-cache next to the project).' },
];

export const lines: CommandSpec = {
  name: 'lines',
  summary: 'List the text lines of a page with their coordinates.',
  description:
    'Lines come in reading order (columns left to right, each top to bottom) with their box as fractions of the displayed page (origin top-left), the font size and the column. Running headers and footers are marked. An empty list means the page has no text layer: it is a scan.',
  args: [{ name: 'page', description: 'Zero-based page.', required: true }],
  options: [
    { name: 'region', type: 'string', value: '<l,t,r,b>', description: 'Only the lines inside this rectangle (page fractions).' },
    { name: 'fonts', type: 'boolean', description: 'Also tell which lines are set in bold (slower).' },
    PDF_OPTION,
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep lines 2', 'mcprep lines 2 --region 0,0.3,1,0.6 --json'],
  output: '{ page, size: { width, height, rotation }, columns, hasText, lines: [{ text, rect, fontSize, column, chars, headerFooter?, bold? }] }',
  async run(context) {
    const opened = await open(context);
    try {
      const page = pageNumber(context.args[0] as string);
      const fonts = flag(context.options, 'fonts');
      const text: PageText = await opened.doc.pageText(page, fonts ? { fonts: true } : {});
      const regionText = stringOption(context.options, 'region');
      const region: Rect | undefined = regionText !== undefined ? parseRect(regionText) : undefined;
      const selected = region ? linesInRect(text.lines, region) : text.lines;
      const result = { page, size: text.size, columns: text.columns, hasText: text.hasText, lines: selected };
      const header = `Page ${page}: ${round4(text.size.width)} x ${round4(text.size.height)} pt${text.size.rotation ? `, /Rotate ${text.size.rotation}` : ''}, ${plural(text.columns, 'column')}, ${plural(selected.length, 'line')}${region ? ` in ${rectText(region)}` : ''}.`;
      const note = text.hasText ? '' : '\nNo text layer: this page is a scan. Render it with `mcprep render <page> --grid 0.1` and mark it by eye.';
      const rows = selected.map((line) => [`${round4(line.rect.top)}-${round4(line.rect.bottom)}`, `${round4(line.rect.left)}-${round4(line.rect.right)}`, String(line.fontSize), String(line.column), `${line.headerFooter === true ? '[header/footer] ' : ''}${line.bold === true ? '[bold] ' : ''}${line.text}`]);
      return { result, text: `${header}${note}\n${table(rows, ['top-bottom', 'left-right', 'size', 'col', 'text'])}` };
    } finally {
      await opened.close();
    }
  },
};

export const render: CommandSpec = {
  name: 'render',
  summary: 'Render a page to a PNG, optionally with a coordinate grid and the frames drawn on it.',
  description:
    'The image is what a model should look at to read coordinates (--grid) and to check the marking (--frames). The grid labels are page fractions with the origin at the top-left.',
  args: [{ name: 'page', description: 'Zero-based page.', required: true }],
  options: [...IMAGE_OPTIONS, PDF_OPTION, ...GLOBAL_OPTIONS],
  examples: ['mcprep render 3 --grid 0.1', 'mcprep render 3 --frames --grid 0.05 --out check/page3.png'],
  output: '{ page, path, width, height, scale, view: { left, top, right, bottom }, grid?, frames: number }',
  async run(context) {
    const opened = await open(context);
    try {
      const page = pageNumber(context.args[0] as string);
      const boxes = flag(context.options, 'frames') && opened.project ? overlayBoxes(opened.project.frames, page) : [];
      const image = await renderPage(opened.doc, page, imageOptions(context, boxes));
      const path = await outputPath(stringOption(context.options, 'out'), context.io.cwd, opened.cache, `page-${page}.png`);
      await save(path, image.png);
      const grid = gridOption(context.options);
      return {
        result: { page, path, width: image.width, height: image.height, scale: round4(image.scale), view: image.view, ...(grid !== false ? { grid } : {}), frames: boxes.length },
        text: `Wrote ${path} (${image.width} x ${image.height} px${grid !== false ? `, grid every ${grid}` : ''}${boxes.length > 0 ? `, ${plural(boxes.length, 'box', 'boxes')} drawn` : ''}).`,
      };
    } finally {
      await opened.close();
    }
  },
};

function regionOf(frame: Frame, which: string, frames: readonly Frame[]): { page: number; rect: Rect; label: string } {
  if (which === 'main') return { page: frame.page, rect: frame.rect, label: frame.id };
  const match = /^(continues|context):(\d+)$/.exec(which);
  if (!match) throw usage(`--region must be main, continues:N or context:N, not "${which}".`);
  const index = Number(match[2]);
  let owner = frame;
  if (match[1] === 'context' && frame.unit !== undefined) {
    // The context of a unit is kept on its first part.
    owner = frames.filter((item) => item.unit === frame.unit).sort((a, b) => a.page - b.page || a.rect.top - b.rect.top)[0] ?? frame;
  }
  const list = match[1] === 'continues' ? owner.continues : owner.context;
  const region = list?.[index];
  if (!region) throw new McPrepError('E_NO_REGION', `${owner.id} has no ${match[1] as string} region ${index}.`, { hint: `It has ${list?.length ?? 0}.` });
  return { page: region.page, rect: region.rect, label: `${frame.id}-${match[1] as string}${index}` };
}

export const crop: CommandSpec = {
  name: 'crop',
  summary: 'Render one frame, or any rectangle of a page, to a PNG: the way to check a frame by looking at it.',
  description:
    'Give a frame id, or --page and --rect. With a grid the labels are still page coordinates, so a crop can be read in page fractions. --all writes a crop of every frame (and its continuation and context regions) in one go.',
  args: [{ name: 'frame', description: 'A frame id (omit it when you give --page and --rect, or --all).' }],
  options: [
    { name: 'page', type: 'string', value: '<n>', description: 'Zero-based page (with --rect).' },
    { name: 'rect', type: 'string', value: '<l,t,r,b>', description: 'The rectangle to crop, as page fractions.' },
    { name: 'region', type: 'string', value: 'main|continues:N|context:N', description: 'Which region of the frame (default main).' },
    { name: 'all', type: 'boolean', description: 'Crop every frame of the project.' },
    { name: 'padding', type: 'number', value: '<fraction>', description: 'Page fraction to include around the rectangle (default 0.01).' },
    ...IMAGE_OPTIONS,
    PDF_OPTION,
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep crop f3', 'mcprep crop f3 --region context:0 --grid 0.05', 'mcprep crop --page 2 --rect 0.1,0.3,0.9,0.5 --grid 0.05', 'mcprep crop --all --out check/'],
  output: '{ crops: [{ frame?, region, page, rect, path, width, height, scale, view }] }',
  async run(context) {
    const opened = await open(context);
    try {
      const out = stringOption(context.options, 'out');
      const crops: Record<string, unknown>[] = [];
      const make = async (target: { page: number; rect: Rect; label: string }, frameId: string | undefined, region: string): Promise<void> => {
        const boxes = flag(context.options, 'frames') && opened.project ? overlayBoxes(opened.project.frames, target.page) : [];
        const image = await renderRegion(opened.doc, target.page, target.rect, imageOptions(context, boxes));
        const path = await outputPath(context.options['all'] === true && out !== undefined && !/[\\/]$/.test(out) ? `${out}/` : out, context.io.cwd, opened.cache, `crop-${target.label}.png`);
        await save(path, image.png);
        crops.push({ ...(frameId !== undefined ? { frame: frameId } : {}), region, page: target.page, rect: target.rect, path, width: image.width, height: image.height, scale: round4(image.scale), view: image.view });
      };
      if (context.options['all'] === true) {
        if (!opened.project) throw usage('--all needs a project.');
        for (const frame of [...opened.project.frames].sort((a, b) => a.page - b.page || a.rect.top - b.rect.top)) {
          await make(regionOf(frame, 'main', opened.project.frames), frame.id, 'main');
          for (let i = 0; i < (frame.continues?.length ?? 0); i += 1) await make(regionOf(frame, `continues:${i}`, opened.project.frames), frame.id, `continues:${i}`);
          if (frame.unit === undefined) for (let i = 0; i < (frame.context?.length ?? 0); i += 1) await make(regionOf(frame, `context:${i}`, opened.project.frames), frame.id, `context:${i}`);
        }
      } else if (context.args[0] !== undefined) {
        if (!opened.project) throw usage('A frame id needs a project; use --page and --rect for a plain PDF.');
        const frame = opened.project.frames.find((item) => item.id === context.args[0]);
        if (!frame) throw new McPrepError('E_NO_FRAME', `There is no frame with the id "${context.args[0]}".`, { hint: 'List the ids with `mcprep frames list`.' });
        const region = stringOption(context.options, 'region') ?? 'main';
        await make(regionOf(frame, region, opened.project.frames), frame.id, region);
      } else {
        const page = stringOption(context.options, 'page');
        const rect = stringOption(context.options, 'rect');
        if (page === undefined || rect === undefined) throw usage('`mcprep crop` needs a frame id, or --page and --rect, or --all.');
        const number = pageNumber(page);
        await make({ page: number, rect: parseRect(rect), label: `p${number}` }, undefined, 'rect');
      }
      return {
        result: { crops },
        text: crops.map((entry) => `Wrote ${entry['path'] as string} (${entry['frame'] !== undefined ? `${entry['frame'] as string} ${entry['region'] as string}, ` : ''}page ${entry['page'] as number}, ${entry['width'] as number} x ${entry['height'] as number} px)`).join('\n'),
      };
    } finally {
      await opened.close();
    }
  },
};

export { basename };
