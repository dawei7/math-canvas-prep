import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { proposalSetToOperations, proposeFrames, type FrameProposal, type PageText, type ProposalSet } from '@mcprep/core';
import { flag, listOption, numberOption, pageList, stringOption, usage } from '../args.js';
import { plural, rectText, round4, table } from '../format.js';
import type { CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS, applyAndReport } from './common.js';

function describe(proposal: FrameProposal): string[] {
  const lines = [`${proposal.id}  ${proposal.kind}  page ${proposal.page}  ${rectText(proposal.rect)}  confidence ${proposal.confidence.toFixed(2)}  "${proposal.title}"`];
  for (const reason of proposal.evidence) lines.push(`      - ${reason}`);
  if (proposal.continues) for (const region of proposal.continues) lines.push(`      continues: page ${region.page} ${rectText(region.rect)}`);
  if (proposal.parts) {
    lines.push(`      parts (${proposal.parts.style}): ${proposal.parts.markers.map((marker) => `"${marker.text.slice(0, 14)}"`).join(', ')}`);
    lines.push(`        dividers at ${proposal.parts.dividers.map(round4).join(', ')}${proposal.parts.first !== undefined ? `; the first part starts at ${round4(proposal.parts.first)} (the statement above it can be context)` : ''}`);
  }
  return lines;
}

export const propose: CommandSpec = {
  name: 'propose',
  summary: 'Suggest exercises, parts, context and bookmarks from the printed text (offline heuristics, nothing is applied).',
  description:
    'Finds lines that start an exercise ("Exercise 3", "Aufgabe 3", "3.", "3)"), where each ends (before the next start, a heading or a definition; over a figure; onto the next page when the text goes on), part markers (a) (b) (c) inside an exercise, instructions printed for several exercises ("Exercises 3 and 4"), and definitions, theorems and remarks as bookmarks. Every proposal carries its evidence and a confidence. It is a starting point: look at the crops before you trust it. `--ops` writes the proposals as a batch for `frames apply`; `--apply` applies them (only the ones you name with --ids, if given).',
  options: [
    { name: 'pages', type: 'string', value: '<0,2,5-7>', description: 'Only these zero-based pages (default all).' },
    { name: 'min-confidence', type: 'number', value: '<0..1>', description: 'Proposals below this go to "rejected" (default 0.5).' },
    { name: 'no-bookmarks', type: 'boolean', description: 'Do not propose definitions, theorems and remarks as bookmarks.' },
    { name: 'no-graphics', type: 'boolean', description: 'Do not render pages to find figures (faster; frames then end after the last line of text).' },
    { name: 'parts', type: 'string', value: 'context|keep|none', description: 'What to do with the statement above (a): context (recommended: it becomes context of the exercise and the first part starts at (a)), keep (leave it inside the first part, as the app\'s own splitter does), none (do not cut into parts). Default context.' },
    { name: 'ids', type: 'string', value: '<p1,p3>', description: 'With --ops or --apply: only these proposals.' },
    { name: 'ops', type: 'string', value: '<file>', description: 'Write the operations that create these frames as a JSON batch (for `frames apply`).' },
    { name: 'apply', type: 'boolean', description: 'Apply the proposals to the project now (one atomic batch).' },
    ...GLOBAL_OPTIONS,
  ],
  writes: true,
  examples: ['mcprep propose', 'mcprep propose --pages 0-4 --ops batch.json', 'mcprep propose --apply --ids p1,p2,p3'],
  output:
    '{ pages, proposals: [{ id, kind, page, rect, continues?, title, number?, confidence, evidence, parts? }], contexts: [{ id, page, rect, text, numbers, appliesTo }], rejected, operations, bodyFontSize, notes, applied? }',
  async run(context) {
    const session = await context.session();
    const pdf = await session.document();
    const pagesText = stringOption(context.options, 'pages');
    const selected = pagesText !== undefined ? pageList(pagesText) : Array.from({ length: pdf.pageCount }, (_unused, i) => i);
    for (const page of selected) if (page >= pdf.pageCount) throw usage(`Page ${page} does not exist: the PDF has ${plural(pdf.pageCount, 'page')} (zero-based 0..${pdf.pageCount - 1}).`);
    const read = [...new Set([...selected, ...selected.map((page) => page + 1).filter((page) => page < pdf.pageCount)])].sort((a, b) => a - b);
    const texts: PageText[] = [];
    for (const page of read) texts.push(await pdf.pageText(page, { fonts: true, ...(flag(context.options, 'no-graphics') ? {} : { ink: true }) }));
    const minConfidence = numberOption(context.options, 'min-confidence');
    const raw = proposeFrames(texts, {
      ...(minConfidence !== undefined ? { minConfidence } : {}),
      ...(flag(context.options, 'no-bookmarks') ? { bookmarks: false } : {}),
    });
    const inSelection = new Set(selected);
    const kept = raw.proposals.filter((proposal) => inSelection.has(proposal.page));
    const keptIds = new Set(kept.map((proposal) => proposal.id));
    const set: ProposalSet = {
      ...raw,
      proposals: kept,
      contexts: raw.contexts.filter((entry) => inSelection.has(entry.page)).map((entry) => ({ ...entry, appliesTo: entry.appliesTo.filter((id) => keptIds.has(id)) })),
      rejected: raw.rejected.filter((entry) => inSelection.has(entry.page)),
    };
    const partsOption = stringOption(context.options, 'parts') ?? 'context';
    if (!['context', 'keep', 'none'].includes(partsOption)) throw usage('--parts must be context, keep or none.');
    const ids = listOption(context.options, 'ids').flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
    for (const id of ids) if (!keptIds.has(id)) throw usage(`There is no proposal "${id}". The proposals are ${[...keptIds].join(', ') || '(none)'}.`);
    const operations = proposalSetToOperations(set, { parts: partsOption as 'context' | 'keep' | 'none', ...(ids.length > 0 ? { only: ids } : {}) });
    const opsFile = stringOption(context.options, 'ops');
    if (opsFile !== undefined) await writeFile(resolve(context.io.cwd, opsFile), `${JSON.stringify({ operations }, null, 2)}\n`);

    const summary = table(set.proposals.map((proposal) => [proposal.id, proposal.kind, String(proposal.page), rectText(proposal.rect), proposal.confidence.toFixed(2), `${proposal.continues ? '+cont ' : ''}${proposal.parts ? `${proposal.parts.dividers.length + 1} parts ` : ''}${proposal.title.slice(0, 50)}`]), ['id', 'kind', 'page', 'rect', 'conf', 'what']);
    const blocks = set.proposals.flatMap(describe).join('\n');
    const contextLines = set.contexts.map((entry) => `${entry.id}  context  page ${entry.page}  ${rectText(entry.rect)}  applies to ${entry.appliesTo.length > 0 ? entry.appliesTo.join(', ') : '(unknown: attach it by hand)'}  "${entry.text.slice(0, 60)}"`);
    const rejectedLines = set.rejected.map((entry) => `page ${entry.page}  ${entry.confidence.toFixed(2)}  "${entry.text}"  (${entry.evidence[0] ?? ''})`);
    const textParts = [
      `${plural(set.proposals.length, 'proposal')} on ${plural(selected.length, 'page')} (body text ${set.bodyFontSize} pt). Nothing is applied unless you say --apply.`,
      summary,
      ...(contextLines.length > 0 ? ['Context:', ...contextLines] : []),
      ...(set.notes.length > 0 ? set.notes : []),
      'Evidence:',
      blocks,
      ...(rejectedLines.length > 0 ? ['Below the confidence threshold:', ...rejectedLines] : []),
      opsFile !== undefined ? `Wrote ${plural(operations.length, 'operation')} to ${opsFile}; apply them with \`mcprep frames apply ${opsFile}\`.` : 'Add --ops <file> to write them as a batch for `frames apply`, or --apply to apply them.',
    ];
    const base = { pages: selected, proposals: set.proposals, contexts: set.contexts, rejected: set.rejected, operations, bodyFontSize: set.bodyFontSize, notes: set.notes };
    if (flag(context.options, 'apply')) {
      if (operations.length === 0) return { result: { ...base, applied: false }, text: `${textParts.join('\n')}\nNothing to apply.`, ...(set.notes.length > 0 ? { notes: set.notes } : {}) };
      const done = await applyAndReport(context, operations, `applied ${plural(ids.length > 0 ? ids.length : set.proposals.length, 'proposal')}`);
      return { ...done, result: { ...base, applied: true, ...(done.result as object) }, text: `${textParts.slice(0, 2).join('\n')}\n${done.text}` };
    }
    return { result: { ...base, applied: false }, text: textParts.join('\n'), ...(set.notes.length > 0 ? { notes: set.notes } : {}) };
  },
};
