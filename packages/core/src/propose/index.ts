import type { Operation } from '../project/ops.js';
import type { ContextProposal, FrameProposal, ProposalSet } from './exercises.js';

export * from './exercises.js';
export * from './headings.js';
export * from './parts.js';

export interface ProposalOperationOptions {
  /**
   * What to do with the statement above the first part (the text before "(a)"): `context` marks it as context of the
   * exercise and starts the first part at its marker (recommended); `keep` leaves it inside the first part, as the
   * Android app's own splitter does; `none` does not cut the exercise into parts at all.
   */
  parts?: 'context' | 'keep' | 'none';
}

/**
 * The operations that turn a proposal into frames: an `add` (with `ref` = the proposal id, so that the next operations
 * can say `@p3`) and, when parts were found, a `split`. Apply them with `frames apply` or `applyOperations`.
 */
export function proposalToOperations(proposal: FrameProposal, options: ProposalOperationOptions = {}): Operation[] {
  const mode = options.parts ?? 'context';
  const ref = proposal.id;
  const add: Operation = {
    op: 'add',
    ref,
    kind: proposal.kind,
    page: proposal.page,
    rect: proposal.rect,
    ...(proposal.continues && proposal.continues.length > 0 ? { continues: proposal.continues } : {}),
  };
  const ops: Operation[] = [add];
  if (proposal.kind === 'exercise' && proposal.parts && mode !== 'none' && !(proposal.continues && proposal.continues.length > 0)) {
    const parts = proposal.parts;
    const useContext = mode === 'context' && parts.first !== undefined;
    ops.push({
      op: 'split',
      id: `@${ref}`,
      at: parts.dividers,
      ...(useContext ? { first: parts.first, preamble: 'context' as const } : {}),
    });
  }
  return ops;
}

/** `context.add` for every exercise the instruction names. */
export function contextToOperations(context: ContextProposal): Operation[] {
  return context.appliesTo.map((id): Operation => ({ op: 'context.add', id: `@${id}`, page: context.page, rect: context.rect }));
}

/** All operations for the chosen proposals (default: all) and the instructions that belong to them. */
export function proposalSetToOperations(
  set: ProposalSet,
  options: ProposalOperationOptions & { only?: readonly string[]; contexts?: boolean } = {},
): Operation[] {
  const chosen = new Set(options.only ?? set.proposals.map((proposal) => proposal.id));
  const ops: Operation[] = [];
  for (const proposal of set.proposals) if (chosen.has(proposal.id)) ops.push(...proposalToOperations(proposal, options));
  if (options.contexts !== false) {
    for (const context of set.contexts) {
      const targets = context.appliesTo.filter((id) => chosen.has(id));
      if (targets.length > 0) ops.push(...contextToOperations({ ...context, appliesTo: targets }));
    }
  }
  return ops;
}
