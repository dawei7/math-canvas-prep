import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { isAuthoritative, linesInRect, type Frame } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { frameColor } from '../logic/colors.js';
import { FRAME_ROW_HEIGHT, ORDINARY_KEY, UNPLACED_KEY, buildFrameRows, sectionGroupKey, type FrameRow } from '../logic/list.js';
import { frameIndex } from '../logic/model.js';
import type { FramesFilter, Store } from '../logic/store.js';
import { VirtualList } from './VirtualList.js';

const FILTERS: { id: FramesFilter; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Book exercises by section, then what you framed yourself' },
  { id: 'book', label: 'Book exercises', title: 'Only the exercises audited from the book, by section' },
  { id: 'ordinary', label: 'Framed by you', title: 'Only what you framed for yourself: exercises (E1, E2.1), questions and bookmarks' },
];

const KIND_SYMBOL = { exercise: '✏', question: '?', bookmark: '🔖' } as const;

/**
 * Every frame of the project in a list that stays quick with thousands: the book exercises grouped by section with the
 * number the book prints, what a person framed for themselves in reading order, a filter between the two, a search by number
 * (`5a`, `1.2:5a`), and rows that exist only for what is in view. A click shows the frame on its page.
 */
export function FramesPanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const [query, setQuery] = useState('');
  const frames = state.project?.frames ?? [];
  const index = frameIndex(frames);
  const model = store.book();
  const listed = useMemo(() => buildFrameRows({ index, model, filter: state.framesFilter, query, collapsed: state.collapsed }), [index, model, state.framesFilter, query, state.collapsed]);
  const selected = state.selection === null ? undefined : index.byId.get(state.selection);
  const selectedUnit = selected?.unit;
  // The list scrolls to a frame when the person chooses it, not whenever the rows above it change.
  const chosen = useRef({ id: state.selection, tick: 0 });
  if (chosen.current.id !== state.selection) chosen.current = { id: state.selection, tick: chosen.current.tick + 1 };

  // A frame chosen on the page is shown in the list, also when its group was folded away.
  useEffect(() => {
    if (!selected) return;
    const key = isAuthoritative(selected) ? sectionGroupKey(selected.section ?? '') : ORDINARY_KEY;
    const unplaced = isAuthoritative(selected) && selected.section !== undefined && !model.tree.byId.has(selected.section);
    if (store.state.collapsed[unplaced ? UNPLACED_KEY : key]) store.toggleGroup(unplaced ? UNPLACED_KEY : key);
  }, [state.selection]);

  const snippet = (frame: Frame): string => {
    const lines = state.texts[frame.page]?.lines;
    return lines ? (linesInRect(lines, frame.rect).find((line) => line.headerFooter !== true)?.text.slice(0, 44) ?? '') : '';
  };

  // The text of the pages of the rows in view comes first: the first words of a frame are shown with it.
  const loadVisible = (first: number, end: number): void => {
    const pages = new Set<number>();
    for (let at = first; at < end; at += 1) {
      const row = listed.rows[at];
      if (row && row.type !== 'group') pages.add(row.frame.page);
    }
    if (pages.size > 0) void store.ensureTexts([...pages]);
  };

  const renderRow = (row: FrameRow): preact.JSX.Element => {
    if (row.type === 'group') {
      return (
        <div class={`frame-group ${row.problem ? 'problem' : ''}`} data-key={row.key} onClick={() => store.toggleGroup(row.key)}>
          <span class="chevron-text">{row.collapsed ? '▸' : '▾'}</span>
          <span class="group-title" title={row.title}>
            {row.title}
          </span>
          <span class="muted group-count">
            {row.count}
            {row.solved !== undefined ? ` · 🔑 ${row.solved}` : ''}
          </span>
          {row.sectionIndex !== undefined ? (
            <button
              class="mini-button"
              aria-label="Go to the heading of this section"
              title="Go to the heading of this section"
              onClick={(event) => {
                event.stopPropagation();
                store.goToSection(row.sectionIndex as number);
              }}
            >
              ↗
            </button>
          ) : null}
        </div>
      );
    }
    if (row.type === 'unit') {
      return (
        <div class="frame-row unit-head" onClick={() => store.select(row.frame.id, { jump: true })}>
          <span class="chip" style={{ background: frameColor(row.frame) }}>
            {row.label}
          </span>
          <span class="muted">exercise with {row.parts} parts</span>
        </div>
      );
    }
    const { frame, label, book, part } = row;
    const picked = state.selection === frame.id || (part && selectedUnit === frame.unit);
    return (
      <div class={`frame-row ${part ? 'part' : ''} ${picked ? 'selected' : ''}`} data-id={frame.id} onClick={() => store.select(frame.id, { jump: true })}>
        <span class={`chip ${book ? 'book' : ''}`} style={{ background: frameColor(frame) }}>
          {label}
        </span>
        <span class="row-text">{snippet(frame) || frame.kind}</span>
        <span class="muted">p{frame.page + 1}</span>
        {frame.context ? (
          <span class="mini" title={`${frame.context.length} context region${frame.context.length === 1 ? '' : 's'}`}>
            📄{frame.context.length}
          </span>
        ) : null}
        {frame.solution ? (
          <span class="mini solution" title={`${frame.solution.length} solution region${frame.solution.length === 1 ? '' : 's'} (hidden from the learner)`}>
            🔑{frame.solution.length}
          </span>
        ) : null}
        {frame.continues ? (
          <span class="mini" title="Continues">
            ↪{frame.continues.length}
          </span>
        ) : null}
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
      </div>
    );
  };

  const counts = index.counts;
  const total = frames.length;
  const selectedRow = state.selection === null ? -1 : (listed.indexOfFrame.get(state.selection) ?? -1);
  return (
    <div class="panel-body fill frames-panel">
      <div class="panel-head column">
        <div class="counts-line">
          <span class="counts">
            <span class="count exercise" title="Exercises you framed">
              {KIND_SYMBOL.exercise} {counts.exercise}
            </span>
            <span class="count question" title="Questions">
              {KIND_SYMBOL.question} {counts.question}
            </span>
            <span class="count bookmark" title="Bookmarks">
              {KIND_SYMBOL.bookmark} {counts.bookmark}
            </span>
          </span>
          {index.book.length > 0 ? (
            <span class="count book" title={`${index.book.length} book exercises, ${index.bookWithSolution} with a hidden solution`}>
              📖 {index.book.length} · 🔑 {index.bookWithSolution}
            </span>
          ) : null}
        </div>
        {total > 0 ? (
          <div class="button-row">
            <div class="segmented" role="group" aria-label="Which frames to list">
              {FILTERS.map((filter) => (
                <button key={filter.id} class={`segment ${state.framesFilter === filter.id ? 'active' : ''}`} aria-pressed={state.framesFilter === filter.id} title={filter.title} onClick={() => store.setFramesFilter(filter.id)}>
                  {filter.label}
                </button>
              ))}
            </div>
            <input class="commit-input search" type="search" value={query} placeholder="Find a number (5a, 1.2:5a)" aria-label="Find a frame by its number" onInput={(event) => setQuery((event.target as HTMLInputElement).value)} onKeyDown={(event) => event.stopPropagation()} />
          </div>
        ) : null}
        {total > 0 && (query.trim() !== '' || listed.shown !== listed.total) ? (
          <span class="muted" role="status">
            {listed.shown} of {listed.total} listed
          </span>
        ) : null}
      </div>
      {total === 0 ? <p class="empty">No frames yet. Pick a tool, drag around an exercise, or use Propose.</p> : null}
      {total > 0 && listed.rows.length === 0 ? <p class="empty">{query.trim() !== '' ? 'No frame matches.' : state.framesFilter === 'book' ? 'No book exercises yet. Choose the Book exercise tool and draw around one.' : 'Nothing framed by you yet.'}</p> : null}
      {listed.rows.length > 0 ? (
        <VirtualList
          label="Frames"
          class="frames-list"
          rows={listed.rows}
          rowHeight={FRAME_ROW_HEIGHT}
          rowKey={(row) => row.key}
          scrollTo={{ index: selectedRow, tick: chosen.current.tick }}
          onRange={loadVisible}
          renderRow={renderRow}
        />
      ) : null}
    </div>
  );
}
