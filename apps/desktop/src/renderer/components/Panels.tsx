import { KIND_COLORS, isAuthoritative, linesInRect, type Frame, type Issue } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { frameColor } from '../logic/colors.js';
import { guiFix } from '../logic/errors.js';
import { frameIndex, labelOf } from '../logic/model.js';
import type { Store, Tab } from '../logic/store.js';
import { Inspector } from './Inspector.js';
import { SectionsPanel } from './SectionsPanel.js';
import { Info } from './Toolbar.js';

const KIND_SYMBOL = { exercise: '✏', question: '?', bookmark: '🔖' } as const;

function Counts({ exercise, question, bookmark }: { exercise: number; question: number; bookmark: number }): preact.JSX.Element {
  return (
    <span class="counts">
      <span class="count exercise" title="Exercises">{KIND_SYMBOL.exercise} {exercise}</span>
      <span class="count question" title="Questions">{KIND_SYMBOL.question} {question}</span>
      <span class="count bookmark" title="Bookmarks">{KIND_SYMBOL.bookmark} {bookmark}</span>
    </span>
  );
}

// ------------------------------------------------------------------------------------------------------- frames

function FramesPanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const frames = state.project?.frames ?? [];
  const index = frameIndex(frames);
  const counts = index.counts;
  const ordered = [...index.ordinary, ...index.book];
  const snippet = (frame: Frame): string => {
    const lines = state.texts[frame.page]?.lines;
    return lines ? (linesInRect(lines, frame.rect).find((line) => line.headerFooter !== true)?.text.slice(0, 44) ?? '') : '';
  };
  const selectedUnit = store.selected()?.unit;
  const seen = new Set<string>();
  const rows: preact.JSX.Element[] = [];
  for (const frame of ordered) {
    const info = index.numbers.get(frame.id);
    const label = labelOf(index, frame);
    const color = frameColor(frame);
    const book = isAuthoritative(frame);
    const isPart = frame.unit !== undefined;
    if (isPart && !seen.has(frame.unit as string)) {
      seen.add(frame.unit as string);
      rows.push(
        <li key={`unit-${frame.unit}`} class="row unit-head" onClick={() => store.select(frame.id, { jump: true })}>
          <span class="chip" style={{ background: color }}>{`E${info?.number ?? ''}`}</span>
          <span class="muted">exercise with {info?.partCount ?? 2} parts</span>
        </li>,
      );
    }
    rows.push(
      <li key={frame.id} class={`row ${isPart ? 'part' : ''} ${state.selection === frame.id || (isPart && selectedUnit === frame.unit) ? 'selected' : ''}`} onClick={() => store.select(frame.id, { jump: true })}>
        <span class={`chip ${book ? 'book' : ''}`} style={{ background: color }}>{label}</span>
        <span class="row-text">{snippet(frame) || frame.kind}</span>
        <span class="muted">p{frame.page + 1}</span>
        {frame.context ? <span class="mini" title="Has context">📄{frame.context.length}</span> : null}
        {frame.solution ? <span class="mini" title="Has a hidden solution">🔑{frame.solution.length}</span> : null}
        {frame.continues ? <span class="mini" title="Continues">↪{frame.continues.length}</span> : null}
        <button
          class="row-delete"
          aria-label={`Delete ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            store.apply([frame.unit !== undefined ? { op: 'delete', unit: frame.unit } : { op: 'delete', id: frame.id }], { select: null });
          }}
        >
          ×
        </button>
      </li>,
    );
  }
  return (
    <div class="panel-body">
      <div class="panel-head">
        <Counts exercise={counts.exercise} question={counts.question} bookmark={counts.bookmark} />
        {index.book.length > 0 ? <span class="count book" title="Book exercises">📖 {index.book.length}</span> : null}
      </div>
      {frames.length === 0 ? <p class="empty">No frames yet. Pick a tool, drag around an exercise, or use Propose.</p> : <ul class="rows">{rows}</ul>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------- checks

function ChecksPanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const validation = state.validation;
  if (!validation) return <div class="panel-body" />;
  const issues: Issue[] = [...validation.errors, ...validation.warnings, ...validation.repairs];
  const jump = (issue: Issue): void => {
    if (issue.frameId !== undefined && state.project?.frames.some((frame) => frame.id === issue.frameId)) store.select(issue.frameId, { jump: true });
    else if (issue.page !== undefined) store.setPage(issue.page);
  };
  return (
    <div class="panel-body">
      <div class="panel-head">
        <span class={`verdict ${validation.ok ? 'ok' : 'bad'}`}>{validation.ok ? '✓ No errors' : `✕ ${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}`}</span>
        <span class="muted">{validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'}</span>
      </div>
      {issues.length === 0 ? <p class="empty">Nothing to fix.</p> : null}
      <ul class="rows issues">
        {issues.map((issue, index) => (
          <li key={index} class={`row issue ${issue.severity}`} onClick={() => jump(issue)}>
            <span class="severity">{issue.severity === 'error' ? '✕' : issue.severity === 'warning' ? '!' : '↻'}</span>
            <span class="issue-text">
              {issue.message}
              {guiFix(issue) ? <em> {guiFix(issue)}</em> : null}
            </span>
            {issue.frameId ? <span class="muted">{issue.frameId}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ----------------------------------------------------------------------------------------------------- propose

function ProposePanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const pending = store.pendingProposals();
  const decided = Object.keys(state.decided).length;
  return (
    <div class="panel-body">
      <div class="panel-head column">
        <div class="button-row">
          <button class="text-button small primary" disabled={state.proposalsBusy} onClick={() => void store.runPropose()}>
            {state.proposalsBusy ? 'Looking...' : state.proposals ? 'Find again' : 'Find proposals'}
          </button>
          <Info text="Reads the printed text offline (no AI) and suggests exercises, parts, context and bookmarks. Nothing is applied until you accept it." label="Propose" />
          <button class="text-button small" disabled={pending.length === 0} onClick={() => store.acceptAll()}>Accept all ({pending.length})</button>
          <button class="text-button small" disabled={pending.length === 0} onClick={() => store.rejectAll()}>Reject all</button>
        </div>
        {state.proposals?.notes.map((note) => <span class="muted" key={note}>{note}</span>)}
      </div>
      {state.proposals && pending.length === 0 ? <p class="empty">{decided > 0 ? `All ${decided} proposals decided.` : 'No proposals.'}</p> : null}
      <ul class="rows">
        {pending.map((proposal) => (
          <li key={proposal.id} class="row" onClick={() => store.showProposal(proposal.id)}>
            <span class="chip" style={{ background: KIND_COLORS[proposal.kind] }}>{proposal.id}</span>
            <span class="row-text">{proposal.title}</span>
            <span class="muted">p{proposal.page + 1}</span>
            <span class="muted">{Math.round(proposal.confidence * 100)}%</span>
            {proposal.parts ? <span class="mini" title="Has parts">▤{proposal.parts.dividers.length + 1}</span> : null}
            {proposal.continues ? <span class="mini" title="Continues">↪</span> : null}
            <Info text={proposal.evidence.join('. ')} label={proposal.title} />
            <button class="mini-button accept" aria-label="Accept" onClick={(event) => { event.stopPropagation(); store.acceptProposal(proposal.id); }}>✓</button>
            <button class="mini-button" aria-label="Reject" onClick={(event) => { event.stopPropagation(); store.rejectProposal(proposal.id); }}>✕</button>
          </li>
        ))}
      </ul>
      {state.proposals && state.proposals.contexts.length > 0 ? (
        <p class="muted pad">Instructions found: {state.proposals.contexts.map((entry) => `${entry.id} applies to ${entry.appliesTo.join(', ') || '(unknown)'}`).join('; ')}. They are added when you accept those exercises.</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------- container

export function SidePanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const errors = state.validation?.errors.length ?? 0;
  const warnings = state.validation?.warnings.length ?? 0;
  const tabs: { id: Tab; label: string; badge?: string; bad?: boolean }[] = [
    { id: 'frames', label: 'Frames', badge: String(state.project?.frames.length ?? 0) },
    { id: 'sections', label: 'Sections', badge: String((state.project?.outline?.entries ?? []).length) },
    { id: 'checks', label: 'Checks', badge: errors > 0 ? String(errors) : warnings > 0 ? String(warnings) : '✓', bad: errors > 0 },
    { id: 'propose', label: 'Propose', badge: state.proposals ? String(store.pendingProposals().length) : undefined },
  ];
  return (
    <aside class="side">
      <Inspector store={store} />
      <div class="tabs" role="tablist">
        {tabs.map((tab) => (
          <button key={tab.id} role="tab" aria-selected={state.tab === tab.id} class={`tab ${state.tab === tab.id ? 'active' : ''}`} onClick={() => store.setTab(tab.id)}>
            {tab.label}
            {tab.badge !== undefined ? <span class={`badge ${tab.bad ? 'bad' : ''}`}>{tab.badge}</span> : null}
          </button>
        ))}
      </div>
      {state.tab === 'frames' ? <FramesPanel store={store} /> : null}
      {state.tab === 'sections' ? <SectionsPanel store={store} /> : null}
      {state.tab === 'checks' ? <ChecksPanel store={store} /> : null}
      {state.tab === 'propose' ? <ProposePanel store={store} /> : null}
    </aside>
  );
}
