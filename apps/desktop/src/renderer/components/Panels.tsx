import { KIND_COLORS, isAuthoritative, linesInRect, type Frame, type Issue, type OutlineEntry } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { frameColor } from '../logic/colors.js';
import { sectionCounts } from '../logic/contents.js';
import { guiFix } from '../logic/errors.js';
import { frameIndex, labelOf } from '../logic/model.js';
import type { Store, Tab } from '../logic/store.js';
import { Inspector } from './Inspector.js';
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

// ----------------------------------------------------------------------------------------------------- contents

function ContentsPanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const project = state.project;
  const doc = state.doc;
  if (!project || !doc) return <div class="panel-body" />;
  const own = project.outline;
  const entries: OutlineEntry[] = own?.entries ?? doc.pdfOutline ?? [];
  const sections = sectionCounts(entries, project.frames, doc.pageSizes.length);
  const edit = (next: OutlineEntry[]): void => store.setOutline(next, 'manual');
  const update = (index: number, change: Partial<OutlineEntry>): void => edit(entries.map((entry, i) => (i === index ? { ...entry, ...change } : entry)));
  const move = (index: number, by: number): void => {
    const target = index + by;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item as OutlineEntry);
    edit(next);
  };
  return (
    <div class="panel-body">
      <div class="panel-head column">
        <span class="muted">
          {own ? `The bundle carries this contents (${own.source}).` : doc.pdfOutline ? 'The bundle carries no contents of its own: the app reads the PDF\'s bookmarks (shown below).' : 'The PDF has no bookmarks and there is no contents yet.'}
        </span>
        <div class="button-row">
          {doc.pdfOutline ? <button class="text-button small" onClick={() => store.setOutline(doc.pdfOutline ?? [], 'pdf')}>{own ? 'Reset to PDF' : 'Edit PDF bookmarks'}</button> : null}
          <button class="text-button small" onClick={() => void store.deriveContents()}>Find headings</button>
          <button class="text-button small" disabled={!own} onClick={() => store.clearOutline()}>Use the PDF's</button>
          <button class="text-button small" onClick={() => edit([...entries, { title: 'New section', page: state.page, depth: 0 }])}>Add</button>
        </div>
      </div>
      {state.busy ? <p class="muted pad">{state.busy}</p> : null}
      {entries.length === 0 ? null : (
        <ul class="rows outline">
          {entries.map((entry, index) => {
            const counts = (sections[index] as ReturnType<typeof sectionCounts>[number]).counts;
            return (
              <li key={index} class="row outline-row" style={{ paddingLeft: `${8 + entry.depth * 16}px` }}>
                <button class="mini-button" disabled={entry.depth === 0} onClick={() => update(index, { depth: entry.depth - 1 })} aria-label="Less indent" title="Less indent">◂</button>
                <button class="mini-button" disabled={entry.depth >= 8} onClick={() => update(index, { depth: entry.depth + 1 })} aria-label="More indent" title="More indent">▸</button>
                <input
                  class="title-input"
                  value={entry.title}
                  aria-label="Title"
                  onChange={(event) => update(index, { title: (event.target as HTMLInputElement).value })}
                  onKeyDown={(event) => event.stopPropagation()}
                />
                <input
                  class="page-field"
                  value={String(entry.page + 1)}
                  aria-label="Page"
                  title="Page"
                  onChange={(event) => {
                    const page = Number.parseInt((event.target as HTMLInputElement).value, 10);
                    if (Number.isFinite(page)) update(index, { page: Math.min(Math.max(page - 1, 0), doc.pageSizes.length - 1) });
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                />
                <button class="mini-button" onClick={() => store.setPage(entry.page)} title="Show the page" aria-label="Go to page">↗</button>
                <Counts exercise={counts.exercise} question={counts.question} bookmark={counts.bookmark} />
                <button class="mini-button" onClick={() => move(index, -1)} aria-label="Move up" title="Move up">▲</button>
                <button class="mini-button" onClick={() => move(index, 1)} aria-label="Move down" title="Move down">▼</button>
                <button class="row-delete" onClick={() => edit(entries.filter((_unused, i) => i !== index))} aria-label="Remove entry">×</button>
              </li>
            );
          })}
        </ul>
      )}
      {state.derived ? (
        <div class="derived">
          <div class="panel-head">
            <strong>Headings found ({state.derived.length})</strong>
            <button class="text-button small primary" disabled={state.derived.length === 0} onClick={() => store.setOutline(state.derived?.map(({ title, page, depth }) => ({ title, page, depth })) ?? [], 'derived')}>
              Use these
            </button>
          </div>
          <ul class="rows">
            {state.derived.map((heading, index) => (
              <li key={index} class="row" style={{ paddingLeft: `${8 + heading.depth * 16}px` }}>
                <span class="row-text">{heading.title}</span>
                <span class="muted">p{heading.page + 1}</span>
                <span class="muted">{Math.round(heading.confidence * 100)}%</span>
                <Info text={heading.evidence.join('. ')} label={heading.title} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
    { id: 'sections', label: 'Sections', badge: String((state.project?.outline?.entries ?? state.doc?.pdfOutline ?? []).length) },
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
      {state.tab === 'sections' ? <ContentsPanel store={store} /> : null}
      {state.tab === 'checks' ? <ChecksPanel store={store} /> : null}
      {state.tab === 'propose' ? <ProposePanel store={store} /> : null}
    </aside>
  );
}
