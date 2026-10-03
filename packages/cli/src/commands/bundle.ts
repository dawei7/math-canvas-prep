import { resolve } from 'node:path';
import { checkBundle, hashFile, type BundleReport } from '@mcprep/core';
import { flag, stringOption, usage } from '../args.js';
import { FRAME_HEADERS, issueLines, plural, rectText, table } from '../format.js';
import type { CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

export const exportBundle: CommandSpec = {
  name: 'export',
  summary: 'Write the project as a .mcbundle: the PDF plus its frames and outline, ready for the Android app\'s library.',
  description:
    'Validates the project (errors stop the export), writes the bundle atomically (a temporary file, then a rename), and reads it back with the importer\'s own checks; a bundle that fails them is removed. The PDF inside is byte for byte the original. The output is deterministic: the same project and --created-at give the same bytes (also with SOURCE_DATE_EPOCH set).',
  options: [
    { name: 'out', short: 'o', type: 'string', value: '<file.mcbundle>', description: 'Where to write the bundle (default: <pdf name>.mcbundle next to the project).' },
    { name: 'title', type: 'string', value: '<text>', description: 'Library title for this export (default: the project\'s).' },
    { name: 'folder', type: 'string', value: '<A/B>', description: 'Library folder for this export (default: the project\'s).' },
    { name: 'outline', type: 'string', value: 'project|pdf|none', description: 'Which contents to put in the bundle: the project\'s own outline (default; none if it has none), the PDF\'s own bookmarks, or none.' },
    { name: 'created-at', type: 'string', value: '<ISO time>', description: 'The creation time written into the manifest (default: now, or SOURCE_DATE_EPOCH).' },
    { name: 'no-verify', type: 'boolean', description: 'Do not read the bundle back with the importer checks.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep export', 'mcprep export --out out/analysis1.mcbundle --folder "University/Analysis"'],
  output: '{ path, bytes, sha256, manifest, counts: { frames, outlineEntries }, issues: Issue[] (repairs and warnings), validation: { errors, warnings, repairs }, importCheck?: { ok, steps } }',
  async run(context) {
    const session = await context.session();
    const outline = stringOption(context.options, 'outline') ?? 'project';
    if (!['project', 'pdf', 'none'].includes(outline)) throw usage('--outline must be project, pdf or none.');
    const createdOption = stringOption(context.options, 'created-at');
    const epoch = context.io.env['SOURCE_DATE_EPOCH'];
    let createdAt: Date | undefined;
    if (createdOption !== undefined) {
      createdAt = new Date(createdOption);
      if (Number.isNaN(createdAt.getTime())) throw usage(`--created-at must be a date and time such as 2026-10-03T12:00:00Z, not "${createdOption}".`);
    } else if (epoch !== undefined && /^\d+$/.test(epoch)) createdAt = new Date(Number(epoch) * 1000);
    const out = stringOption(context.options, 'out');
    const title = stringOption(context.options, 'title');
    const folder = stringOption(context.options, 'folder');
    const done = await session.exportBundle(out !== undefined ? resolve(context.io.cwd, out) : undefined, {
      outline: outline as 'project' | 'pdf' | 'none',
      ...(title !== undefined ? { title } : {}),
      ...(folder !== undefined ? { folder } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      verify: !flag(context.options, 'no-verify'),
    });
    const hashed = await hashFile(done.write.path);
    const result = {
      path: done.write.path,
      bytes: done.write.bytes,
      sha256: hashed.sha256,
      manifest: done.write.manifest,
      counts: done.write.counts,
      issues: done.write.issues,
      validation: { errors: done.validation.errors, warnings: done.validation.warnings, repairs: done.validation.repairs },
      ...(done.check ? { importCheck: { ok: done.check.ok, steps: done.check.steps } } : {}),
    };
    const manifest = done.write.manifest;
    const lines = [
      `Wrote ${done.write.path} (${done.write.bytes} bytes).`,
      `  title: ${manifest.document.title}${manifest.document.folder ? `   folder: ${manifest.document.folder}` : ''}`,
      `  ${plural(done.write.counts.frames, 'frame')}, ${plural(done.write.counts.outlineEntries, 'outline entry', 'outline entries')}, ${plural(manifest.document.pageCount, 'page')}`,
      done.check ? '  The importer check passed: the app will accept it.' : '  (not verified)',
      'Copy it to the tablet and open it in the Math Canvas library.',
      ...issueLines(done.write.issues.filter((entry) => entry.severity !== 'error'), '  '),
    ];
    return { result, warnings: done.write.issues.filter((entry) => entry.severity === 'warning'), text: lines.join('\n') };
  },
};

function describeReport(report: BundleReport, verdict: boolean): string {
  const lines: string[] = [];
  if (verdict) lines.push(report.ok ? 'The importer would ACCEPT this bundle.' : `The importer would REJECT this bundle: ${report.rejection?.message ?? ''}`);
  lines.push(...report.steps.map((step) => `  step ${step.step} ${step.name}: ${step.status}${step.detail ? ` - ${step.detail}` : ''}`));
  if (report.errors.length > 0) lines.push('Errors:', ...issueLines(report.errors, '  '));
  if (report.repairs.length > 0) lines.push('Repairs the importer applies silently:', ...issueLines(report.repairs, '  '));
  if (report.warnings.length > 0) lines.push('Warnings:', ...issueLines(report.warnings, '  '));
  return lines.join('\n');
}

export const inspectBundle: CommandSpec = {
  name: 'inspect-bundle',
  summary: 'Look inside a .mcbundle: manifest, entries, frames with their labels, outline, problems.',
  noProject: true,
  args: [{ name: 'file', description: 'The .mcbundle file.', required: true }],
  options: [{ name: 'no-open-pdf', type: 'boolean', description: 'Do not open the PDF to count its pages.' }, { name: 'json', type: 'boolean', description: 'Print one JSON document.' }, { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' }],
  examples: ['mcprep inspect-bundle analysis1.mcbundle'],
  output: '{ ok, rejection?, errors, repairs, warnings, steps, archive: { bytes, entries }, manifest?, document?, frames?, numbers?, outline? } - the same report as import-check, with everything that was read',
  async run(context) {
    const path = resolve(context.io.cwd, context.args[0] as string);
    const report = await checkBundle(path, { openPdf: !flag(context.options, 'no-open-pdf') });
    const lines: string[] = [`${path}`];
    if (report.archive) lines.push(`  ${report.archive.bytes} bytes, ${plural(report.archive.entries.length, 'entry', 'entries')}:`, table(report.archive.entries.map((entry) => [entry.name, String(entry.bytes), entry.method, entry.role]), ['name', 'bytes', 'method', 'role']));
    if (report.manifest) lines.push(`format ${report.manifest.format} v${report.manifest.version}, written ${report.manifest.createdAt} by ${report.manifest.generator?.name ?? '?'} ${report.manifest.generator?.version ?? ''}`.trim());
    if (report.document) lines.push(`document: "${report.document.title}"${report.document.folder ? ` in ${report.document.folder}` : ''}, ${plural(report.document.pageCount, 'page')}, ${report.document.bytes} bytes, sha256 ${report.document.sha256.slice(0, 16)}...`);
    if (report.frames && report.numbers) {
      const labels = new Map(report.numbers.map((entry) => [entry.id, entry.label]));
      lines.push(`${plural(report.frames.length, 'frame')}:`, table(report.frames.map((frame) => [frame.id, labels.get(frame.id) ?? '', frame.kind, String(frame.page), rectText(frame.rect), [frame.unit ? `unit ${frame.unit}` : '', frame.continues ? `continues ${frame.continues.length}` : '', frame.context ? `context ${frame.context.length}` : ''].filter(Boolean).join(', ')]), FRAME_HEADERS));
    }
    if (report.outline) lines.push(`${plural(report.outline.length, 'outline entry', 'outline entries')}:`, ...report.outline.map((entry) => `  ${'  '.repeat(entry.depth)}${entry.title} (page ${entry.page})`));
    lines.push(describeReport(report, true));
    return { result: report, warnings: report.warnings, text: lines.join('\n') };
  },
};

export const importCheck: CommandSpec = {
  name: 'import-check',
  summary: 'Do exactly what the Android importer does with a bundle, step by step, and say whether it would accept it.',
  description:
    'The six steps of docs/BUNDLE_FORMAT.md section 5: open the archive and apply the limits; read bundle.json and check format and version; stream document.pdf and compare its SHA-256 and size; open the PDF and compare its page count; parse and validate frames.json and outline.json, repairing what may be repaired and naming the frame id of anything that is rejected; and what would be created in the library. Exit code 4 when the bundle would be rejected.',
  noProject: true,
  args: [{ name: 'file', description: 'The .mcbundle file.', required: true }],
  options: [{ name: 'no-open-pdf', type: 'boolean', description: 'Do not open the PDF to count its pages (step 4 is then skipped).' }, { name: 'json', type: 'boolean', description: 'Print one JSON document.' }, { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' }],
  examples: ['mcprep import-check analysis1.mcbundle', 'mcprep import-check analysis1.mcbundle --json'],
  output: '{ wouldImport: boolean, rejection?: Issue, steps: [{ step, name, status, detail }], errors, repairs, warnings, document?, frames?, numbers?, outline? }',
  async run(context) {
    const path = resolve(context.io.cwd, context.args[0] as string);
    const report = await checkBundle(path, { openPdf: !flag(context.options, 'no-open-pdf') });
    const { ok, ...rest } = report;
    return { result: { wouldImport: ok, ...rest }, warnings: report.warnings, text: describeReport(report, true), exitCode: ok ? 0 : 4 };
  },
};
