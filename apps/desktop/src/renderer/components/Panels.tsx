import { KIND_COLORS, type Issue } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { guiFix } from '../logic/errors.js';
import { frameIndex } from '../logic/model.js';
import type { ProposeMode, Store, Tab } from '../logic/store.js';
import { BookProposalsPanel } from './BookProposals.js';
import { FramesPanel } from './FramesPanel.js';
import { Inspector } from './Inspector.js';
import { SectionsPanel } from './SectionsPanel.js';
import { Info } from './Toolbar.js';
import { VirtualList } from './VirtualList.js';

// ------------------------------------------------------------------------------------------------------- checks

const ISSUE_ROW_HEIGHT = 50;

function ChecksPanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const validation = state.validation;
  if (!validation) return <div class="panel-body" />;
  const issues: Issue[] = [...validation.errors, ...validation.warnings, ...validation.repairs];
  const frames = frameIndex(state.project?.frames ?? []).byId;
  const jump = (issue: Issue): void => {
    if (issue.frameId !== undefined && frames.has(issue.frameId)) store.select(issue.frameId, { jump: true });
    else if (issue.page !== undefined) store.setPage(issue.page);
  };
  return (
    <div class="panel-body fill">
      <div class="panel-head">
        <span class={`verdict ${validation.ok ? 'ok' : 'bad'}`}>{validation.ok ? '✓ No errors' : `✕ ${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}`}</span>
        <span class="muted">{validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'}</span>
      </div>
      {issues.length === 0 ? <p class="empty">Nothing to fix.</p> : null}
      {issues.length > 0 ? (
        <VirtualList
          label="Checks"
          class="issues"
          rows={issues}
          rowHeight={ISSUE_ROW_HEIGHT}
          rowKey={(_issue, at) => String(at)}
          renderRow={(issue) => {
            const fix = guiFix(issue);
            return (
              <div class={`issue-row ${issue.severity}`} title={`${issue.message}${fix ? ` ${fix}` : ''}`} onClick={() => jump(issue)}>
                <span class="severity">{issue.severity === 'error' ? '✕' : issue.severity === 'warning' ? '!' : '↻'}</span>
                <span class="issue-text">
                  {issue.message}
                  {fix ? <em> {fix}</em> : null}
                </span>
                {issue.frameId ? <span class="muted">{issue.frameId}</span> : null}
              </div>
            );
          }}
        />
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------------------------------- propose

const PROPOSAL_ROW_HEIGHT = 38;

/** Frames suggested from the text of the pages: exercises, parts, context and bookmarks that a person frames for themselves. */
function FrameProposals({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const pending = store.pendingProposals();
  const decided = Object.keys(state.decided).length;
  return (
    <div class="panel-body fill">
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
      {pending.length > 0 ? (
        <VirtualList
          label="Proposals"
          class="proposals"
          rows={pending}
          rowHeight={PROPOSAL_ROW_HEIGHT}
          rowKey={(proposal) => proposal.id}
          renderRow={(proposal) => (
            <div class="proposal-row" onClick={() => store.showProposal(proposal.id)}>
              <span class="chip" style={{ background: KIND_COLORS[proposal.kind] }}>{proposal.id}</span>
              <span class="row-text">{proposal.title}</span>
              <span class="muted">p{proposal.page + 1}</span>
              <span class="muted">{Math.round(proposal.confidence * 100)}%</span>
              {proposal.parts ? <span class="mini" title="Has parts">▤{proposal.parts.dividers.length + 1}</span> : null}
              {proposal.continues ? <span class="mini" title="Continues">↪</span> : null}
              <Info text={proposal.evidence.join('. ')} label={proposal.title} />
              <button class="mini-button accept" aria-label="Accept" onClick={(event) => { event.stopPropagation(); store.acceptProposal(proposal.id); }}>✓</button>
              <button class="mini-button" aria-label="Reject" onClick={(event) => { event.stopPropagation(); store.rejectProposal(proposal.id); }}>✕</button>
            </div>
          )}
        />
      ) : null}
      {state.proposals && state.proposals.contexts.length > 0 ? (
        <p class="muted pad">Instructions found: {state.proposals.contexts.map((entry) => `${entry.id} applies to ${entry.appliesTo.join(', ') || '(unknown)'}`).join('; ')}. They are added when you accept those exercises.</p>
      ) : null}
    </div>
  );
}

const MODES: { id: ProposeMode; label: string; title: string }[] = [
  { id: 'frames', label: 'Frames', title: 'Exercises, parts, context and bookmarks to frame for yourself, from the text of the pages' },
  { id: 'exercises', label: 'Book exercises', title: 'The numbered exercises of the practice sets of a book, filed under its sections' },
  { id: 'solutions', label: 'Solutions', title: 'The answers of the answer key at the back of the book, matched to its exercises' },
];

/** What the search can propose: frames from the text, the numbered exercises of a book, or the answers of its answer key. */
function ProposePanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  return (
    <div class="propose">
      <div class="modes" role="group" aria-label="What to propose">
        {MODES.map((mode) => (
          <button key={mode.id} class={`mode ${state.proposeMode === mode.id ? 'active' : ''}`} aria-pressed={state.proposeMode === mode.id} title={mode.title} onClick={() => store.setProposeMode(mode.id)}>
            {mode.label}
          </button>
        ))}
      </div>
      {state.proposeMode === 'frames' ? <FrameProposals store={store} /> : <BookProposalsPanel store={store} kind={state.proposeMode} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------- container

/** The number on the Propose tab: frame proposals waiting, or the exercises or answers of the book that are new or different. */
function proposeBadge(store: Store): string | undefined {
  const { proposeMode, proposals } = store.state;
  if (proposeMode !== 'frames') {
    const counts = store.bookModel(proposeMode)?.counts;
    return counts ? String(counts.new + counts.different) : undefined;
  }
  return proposals ? String(store.pendingProposals().length) : undefined;
}

export function SidePanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const errors = state.validation?.errors.length ?? 0;
  const warnings = state.validation?.warnings.length ?? 0;
  const tabs: { id: Tab; label: string; badge?: string; bad?: boolean }[] = [
    { id: 'frames', label: 'Frames', badge: String(state.project?.frames.length ?? 0) },
    { id: 'sections', label: 'Sections', badge: String((state.project?.outline?.entries ?? []).length) },
    { id: 'checks', label: 'Checks', badge: errors > 0 ? String(errors) : warnings > 0 ? String(warnings) : '✓', bad: errors > 0 },
    { id: 'propose', label: 'Propose', badge: proposeBadge(store) },
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
