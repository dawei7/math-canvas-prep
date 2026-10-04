import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { describeSection, type OutlineEntry } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { sectionCounts } from '../logic/contents.js';
import { frameIndex, sectionChoices, type BookModel } from '../logic/model.js';
import { buildSectionRows, canMove, canShiftDepth, exercisesUnder, idsUnder, sectionWarnings, suggestSectionId, type SectionRow } from '../logic/sections.js';
import type { SectionFilter, Store } from '../logic/store.js';
import { Info } from './Toolbar.js';
import { VirtualList } from './VirtualList.js';

const ROW_HEIGHT = 46;

/** The title without the number that the label already shows ("1.2 Subtracting" with the label "1.2"). */
function titleWithoutLabel(entry: OutlineEntry): string {
  const label = entry.label?.trim();
  if (label !== undefined && label !== '' && entry.title.toLowerCase().startsWith(label.toLowerCase())) {
    const rest = entry.title.slice(label.length).replace(/^[\s.:)-]+/, '');
    if (rest !== '') return rest;
  }
  return entry.title;
}

/**
 * An input that changes its entry when the person leaves it (or presses Enter), and takes back what was typed on Escape. It
 * is not controlled: what is typed stays in the field (also when the change is refused, next to the reason) and nothing is
 * redrawn per key. When the value of the entry changes from outside (another entry, an agent) the field is made anew.
 */
function CommitInput({
  value,
  onCommit,
  label,
  class: className = '',
  type = 'text',
  inputRef,
  maxLength,
  placeholder,
  onEdit,
}: {
  value: string;
  onCommit: (text: string) => void;
  /** Called when the person types: what was said about the last attempt no longer applies. */
  onEdit?: () => void;
  label: string;
  class?: string;
  type?: string;
  inputRef?: preact.RefObject<HTMLInputElement>;
  maxLength?: number;
  placeholder?: string;
}): preact.JSX.Element {
  // Enter commits and then leaves the field, which commits again: the same text is committed once.
  const last = useRef<string | null>(null);
  const commit = (input: HTMLInputElement): void => {
    if (input.value === value || input.value === last.current) return;
    last.current = input.value;
    onCommit(input.value);
  };
  return (
    <input
      key={value}
      ref={inputRef}
      class={`commit-input ${className}`}
      type={type}
      defaultValue={value}
      aria-label={label}
      {...(maxLength !== undefined ? { maxLength } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onInput={() => {
        last.current = null;
        onEdit?.();
      }}
      onChange={(event) => commit(event.target as HTMLInputElement)}
      onKeyDown={(event) => {
        event.stopPropagation();
        const input = event.target as HTMLInputElement;
        if (event.key === 'Enter') {
          commit(input);
          input.blur();
        } else if (event.key === 'Escape') {
          input.value = value;
          last.current = null;
          input.blur();
        }
      }}
    />
  );
}

/** The card for the selected section: every field of the entry, where it starts, its place in the tree, and deleting it. */
function SectionEditor({ store, model, index, autofocus }: { store: Store; model: BookModel; index: number; autofocus: boolean }): preact.JSX.Element | null {
  const entry = model.entries[index];
  const state = useStore(store);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [subtree, setSubtree] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const title = useRef<HTMLInputElement>(null);
  const pages = state.doc?.pageSizes.length ?? 1;

  useLayoutEffect(() => {
    if (autofocus) {
      title.current?.focus();
      title.current?.select();
    }
  }, [index, autofocus]);

  if (!entry) return null;
  const node = model.tree.nodes[index];
  const move = canMove(model, index);
  const clearError = (): void => setError(null);
  const change = (patch: Parameters<Store['updateSection']>[1]): void => {
    const result = store.updateSection(index, patch);
    setError(result.ok ? null : (result.error ?? 'The change could not be made.'));
  };
  const underIds = idsUnder(model, index, subtree);
  const exercises = exercisesUnder(model, underIds);
  const targets = sectionChoices(model).filter((choice) => !underIds.includes(choice.id));
  const hasChildren = (node?.children.length ?? 0) > 0;
  const shift = (delta: 1 | -1): void => {
    const result = store.shiftSectionDepth(index, delta);
    setError(result.ok ? null : (result.error ?? null));
  };
  const relocate = (delta: 1 | -1): void => {
    const result = store.moveSection(index, delta);
    setError(result.ok ? null : (result.error ?? null));
  };
  const remove = (): void => {
    const result = store.deleteSection(index, { ...(subtree ? { subtree: true } : {}), ...(exercises > 0 ? { moveTo } : {}) });
    if (!result.ok) setError(result.error ?? 'The section could not be deleted.');
  };

  return (
    <section class="section-editor" aria-label="Selected section">
      <div class="inspector-head">
        <strong class="inspector-title">Section</strong>
        <span class="muted">level {entry.depth + 1}</span>
        <span class="spacer" />
        <button class="mini-button" disabled={!canShiftDepth(model, index, -1)} title="Make it one level shallower, with everything below it" aria-label="Outdent" onClick={() => shift(-1)}>
          ◂
        </button>
        <button class="mini-button" disabled={!canShiftDepth(model, index, 1)} title="Make it one level deeper, with everything below it" aria-label="Indent" onClick={() => shift(1)}>
          ▸
        </button>
        <button class="mini-button" disabled={!move.up} title="Move it up, with everything below it" aria-label="Move up" onClick={() => relocate(-1)}>
          ▲
        </button>
        <button class="mini-button" disabled={!move.down} title="Move it down, with everything below it" aria-label="Move down" onClick={() => relocate(1)}>
          ▼
        </button>
        <button class="mini-button" title="Select nothing" aria-label="Close" onClick={() => store.selectSection(null)}>
          ×
        </button>
      </div>
      <label class="field">
        <span>Title</span>
        <CommitInput value={entry.title} label="Title" inputRef={title} maxLength={200} onEdit={clearError} onCommit={(text) => change({ title: text })} />
      </label>
      <label class="field">
        <span>Printed number</span>
        <CommitInput value={entry.label ?? ''} label="Printed number" maxLength={24} placeholder="1.2, Chapter 3" onEdit={clearError} onCommit={(text) => change({ label: text.trim() === '' ? null : text.trim() })} />
      </label>
      <label class="field">
        <span>Id</span>
        <CommitInput value={entry.id ?? ''} label="Id" class="mono" maxLength={60} placeholder="what exercises name" onEdit={clearError} onCommit={(text) => change({ id: text.trim() === '' ? null : text.trim() })} />
        {entry.id === undefined ? (
          <button
            class="text-button small"
            title="An id from the printed number or the title"
            onClick={() => {
              const id = suggestSectionId(model, index);
              if (id !== undefined) change({ id });
            }}
          >
            Suggest
          </button>
        ) : null}
      </label>
      <div class="field">
        <span>Starts on</span>
        <CommitInput
          value={String(entry.page + 1)}
          label="Page"
          class="narrow"
          type="number"
          onEdit={clearError}
          onCommit={(text) => {
            const page = Number.parseInt(text, 10);
            if (!Number.isFinite(page) || page < 1 || page > pages) setError(`The page must be a number from 1 to ${pages}.`);
            else change({ page: page - 1 });
          }}
        />
        <span class="inline-label">at</span>
        <CommitInput
          value={entry.top === undefined ? '' : String(entry.top)}
          label="Top of the heading"
          class="narrow"
          placeholder="top of page"
          onEdit={clearError}
          onCommit={(text) => {
            if (text.trim() === '') return change({ top: null });
            const top = Number(text.replace(',', '.'));
            if (!Number.isFinite(top) || top < 0 || top > 1) return setError('The position of the heading is a number from 0 (top of the page) to 1 (bottom).');
            return change({ top });
          }}
        />
      </div>
      <div class="inspector-row">
        <button class="text-button small" title="The next click on the page sets where this heading is" onClick={() => {
          store.showPlace(entry.page, entry.top);
          store.pickHeading(index);
        }}>
          Pick the heading on the page
        </button>
        <button class="text-button small" title="Start this section on the page that is showing" onClick={() => change({ page: state.page })}>
          Use page {state.page + 1}
        </button>
        <Info text="A section runs from its heading (its page and position) to the next heading of the same or a higher level. With the position, two sections that share a page can be told apart. Exercises are filed under a section by its id." label="where a section starts" />
      </div>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div class="inspector-row">
        <button class="text-button small" onClick={() => store.addSection({ after: index })}>
          Add a section after it
        </button>
        <button class="text-button small" disabled={entry.depth >= 8} onClick={() => store.addSection({ after: index, child: true })}>
          Add a subsection
        </button>
        <button class="text-button small danger" onClick={() => setDeleting(!deleting)}>
          Delete...
        </button>
      </div>
      {deleting ? (
        <div class="delete-panel" role="group" aria-label="Delete the section">
          <p class="muted">
            Delete <strong>{describeSection(entry)}</strong>
            {hasChildren && !subtree ? '; the sections below it move up one level' : ''}.
          </p>
          {hasChildren ? (
            <label class="radio">
              <input type="checkbox" checked={subtree} onChange={(event) => setSubtree((event.target as HTMLInputElement).checked)} />
              <span>Delete the sections below it too</span>
            </label>
          ) : null}
          {exercises > 0 ? (
            <>
              <p class="form-note">
                {exercises} book exercise{exercises === 1 ? ' is' : 's are'} filed here. Move {exercises === 1 ? 'it' : 'them'} to another section first:
              </p>
              <select class="section-select" aria-label="Move the exercises to" value={moveTo} onChange={(event) => setMoveTo((event.target as HTMLSelectElement).value)}>
                <option value="">Choose a section...</option>
                {targets.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.text}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <div class="button-row end tight">
            <button class="text-button small" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button class="text-button small danger" disabled={exercises > 0 && moveTo === ''} onClick={remove}>
              Delete the section
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** What a person framed for themselves in the pages of a section: exercises, questions, bookmarks. */
type Ordinary = { exercise: number; question: number; bookmark: number };

function SectionRowView({ store, row, selected, ordinary }: { store: Store; row: SectionRow; selected: boolean; ordinary: Ordinary | undefined }): preact.JSX.Element {
  const { entry } = row;
  const coverage = row.total === 0 ? 'none' : row.totalSolved === row.total ? 'full' : 'partial';
  return (
    <div
      class={`section-row ${selected ? 'selected' : ''} ${row.problems.length > 0 ? 'has-problem' : ''}`}
      style={{ paddingLeft: `${6 + Math.min(row.depth, 6) * 14}px` }}
      onClick={() => store.goToSection(row.index)}
      data-index={row.index}
    >
      <button
        class="chevron"
        aria-label={row.collapsed ? 'Unfold' : 'Fold'}
        tabIndex={row.hasChildren ? 0 : -1}
        style={{ visibility: row.hasChildren ? 'visible' : 'hidden' }}
        onClick={(event) => {
          event.stopPropagation();
          store.toggleSection(row.key);
        }}
      >
        {row.collapsed ? '▸' : '▾'}
      </button>
      {entry.label !== undefined ? <span class="chip section-chip">{entry.label}</span> : null}
      <div class="section-main">
        <div class="section-title" title={entry.title}>
          {titleWithoutLabel(entry)}
        </div>
        <div class="section-sub">
          <span class="mono">{entry.id !== undefined ? `id ${entry.id}` : 'no id'}</span>
          <span>p{entry.page + 1}</span>
          {entry.top !== undefined ? <span>at {entry.top.toFixed(2)}</span> : null}
          {ordinary !== undefined && ordinary.exercise + ordinary.question + ordinary.bookmark > 0 ? (
            <span title="Exercises, questions and bookmarks framed for yourself on these pages">
              ✏ {ordinary.exercise} ? {ordinary.question} 🔖 {ordinary.bookmark}
            </span>
          ) : null}
          {row.problems.map((problem) => (
            <span key={problem} class="problem">
              {problem}
            </span>
          ))}
        </div>
      </div>
      <div class="section-counts">
        <span class="count book" title={`${row.own} book exercise${row.own === 1 ? '' : 's'} filed under this section${row.total !== row.own ? `, ${row.total} with the sections below it` : ''}`}>
          📖 {row.own}
          {row.total !== row.own ? <span class="muted"> ({row.total})</span> : null}
        </span>
        <span class={`coverage ${coverage}`} title={row.total === 0 ? 'No book exercises yet' : `${row.totalSolved} of ${row.total} have a hidden solution`}>
          🔑 {row.totalSolved}/{row.total}
        </span>
      </div>
    </div>
  );
}

/**
 * RESERVED FOR "DERIVE SECTIONS" (PHASE B). The button that finds the chapters and sections from the printed text, and the
 * list of what it found with the evidence, go here. Nothing is shown until it exists; see the note at the end of
 * logic/sections.ts for what plugs in where.
 */
function DeriveSectionsSlot(_props: { store: Store }): null {
  return null;
}

const FILTERS: { id: SectionFilter; label: string }[] = [
  { id: 'all', label: 'All sections' },
  { id: 'empty', label: 'Without exercises' },
  { id: 'unsolved', label: 'Exercises without a solution' },
  { id: 'problems', label: 'With problems' },
];

/**
 * The sections of the book: the entries of the outline as a tree, each with the number the book prints, its title, page and
 * id, how many book exercises are filed under it (and under the sections below it) and how many of them have a solution.
 * A click goes to the heading; a section can be added, changed, moved, made deeper or shallower and deleted.
 */
export function SectionsPanel({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState(false);
  const model = store.book();
  const index = frameIndex(state.project?.frames ?? []);
  const rows = useMemo(() => buildSectionRows(model, { collapsed: state.collapsedSections, filter: state.sectionFilter, query }), [model, state.collapsedSections, state.sectionFilter, query]);
  const ordinary = useMemo(() => (index.ordinary.length > 0 ? sectionCounts(model.entries, index.ordinary, model.pageCount).map((entry) => entry.counts) : undefined), [model, index]);
  useEffect(() => setAdded(false), [state.sectionSelection]);
  const project = state.project;
  const doc = state.doc;
  if (!project || !doc) return <div class="panel-body" />;
  const own = project.outline;
  const warnings = sectionWarnings(model);
  const total = model.entries.length;
  const selected = state.sectionSelection !== null && model.entries[state.sectionSelection] !== undefined ? state.sectionSelection : null;
  const selectedRow = selected === null ? -1 : rows.findIndex((row) => row.index === selected);
  const pdfCount = doc.pdfOutline?.length ?? 0;
  const solved = index.bookWithSolution;

  return (
    <div class="panel-body fill sections-panel">
      <div class="panel-head column">
        <span class="muted" role="status">
          {total === 0
            ? pdfCount > 0
              ? `No sections yet. The PDF has ${pdfCount} bookmarks: they can be the sections.`
              : 'No sections yet. A book is divided into sections (chapters, then the sections in them); book exercises are filed under them.'
            : `${total} section${total === 1 ? '' : 's'} · ${index.book.length} book exercise${index.book.length === 1 ? '' : 's'}${index.book.length > 0 ? ` · ${solved} with a solution (${Math.round((100 * solved) / index.book.length)}%)` : ''}`}
        </span>
        <div class="button-row">
          <button class="text-button small primary" onClick={() => {
            setAdded(true);
            store.addSection(selected !== null ? { after: selected } : {});
          }}>
            Add a section
          </button>
          {warnings.withoutId.length > 0 ? (
            <button class="text-button small" title="Exercises are filed under a section by its id" onClick={() => store.giveSectionIds()}>
              Give ids ({warnings.withoutId.length})
            </button>
          ) : null}
          {pdfCount > 0 ? (
            <button class="text-button small" title="Make the PDF's own bookmarks the sections, each with an id" onClick={() => store.adoptPdfOutline()}>
              {own ? "Reset to the PDF's bookmarks" : "Use the PDF's bookmarks"}
            </button>
          ) : null}
          <button class="text-button small" title="Look for headings in the printed text (offline)" onClick={() => void store.deriveContents()}>
            Find headings
          </button>
          <button class="text-button small" disabled={!own} title="Remove the sections: the bundle then carries no contents of its own and the app reads the PDF's" onClick={() => store.clearOutline()}>
            Use the PDF's contents
          </button>
          <DeriveSectionsSlot store={store} />
        </div>
        {warnings.duplicateIds.length > 0 ? (
          <p class="warn-line bad" role="alert">
            ✕ Two sections have the id {warnings.duplicateIds.map((id) => `"${id}"`).join(', ')}: only the first can hold exercises. Change one of them.
          </p>
        ) : null}
        {warnings.withoutId.length > 0 ? (
          <p class="warn-line" role="status">
            ! {warnings.withoutId.length} section{warnings.withoutId.length === 1 ? ' has' : 's have'} no id: no exercise can be filed under {warnings.withoutId.length === 1 ? 'it' : 'them'}.{' '}
            <button class="link-button" onClick={() => store.setSectionFilter('problems')}>
              Show
            </button>
          </p>
        ) : null}
        {warnings.unplaced.length > 0 ? (
          <p class="warn-line bad" role="alert">
            ✕ {warnings.unplaced.length} book exercise{warnings.unplaced.length === 1 ? ' is' : 's are'} filed under a section that is not in this list ({[...new Set(warnings.unplaced.map((frame) => frame.section))].slice(0, 4).join(', ')}).{' '}
            <button class="link-button" onClick={() => store.select((warnings.unplaced[0] as { id: string }).id, { jump: true })}>
              Show the first
            </button>
          </p>
        ) : null}
        {total > 0 && index.book.length > 0 && warnings.empty > 0 ? (
          <p class="warn-line note">
            {warnings.empty} of {total} sections have no exercises yet.{' '}
            <button class="link-button" onClick={() => store.setSectionFilter('empty')}>
              Show them
            </button>
          </p>
        ) : null}
        {warnings.unsolved > 0 ? (
          <p class="warn-line note">
            {warnings.unsolved} section{warnings.unsolved === 1 ? ' has' : 's have'} exercises without a solution.{' '}
            <button class="link-button" onClick={() => store.setSectionFilter('unsolved')}>
              Show
            </button>
          </p>
        ) : null}
        {total > 0 ? (
          <div class="button-row">
            <select class="section-select" aria-label="Which sections to show" value={state.sectionFilter} onChange={(event) => store.setSectionFilter((event.target as HTMLSelectElement).value as SectionFilter)}>
              {FILTERS.map((filter) => (
                <option key={filter.id} value={filter.id}>
                  {filter.label}
                </option>
              ))}
            </select>
            <input class="commit-input search" type="search" value={query} placeholder="Find a section" aria-label="Find a section" onInput={(event) => setQuery((event.target as HTMLInputElement).value)} onKeyDown={(event) => event.stopPropagation()} />
          </div>
        ) : null}
      </div>
      {state.busy ? <p class="muted pad">{state.busy}</p> : null}
      {selected !== null ? <SectionEditor key={selected} store={store} model={model} index={selected} autofocus={added} /> : null}
      {total > 0 ? (
        rows.length > 0 ? (
          <VirtualList
            label="Sections"
            class="sections-list"
            rows={rows}
            rowHeight={ROW_HEIGHT}
            rowKey={(row) => `${row.index}:${row.key}`}
            scrollTo={{ index: selectedRow, tick: selected ?? -1 }}
            renderRow={(row) => <SectionRowView store={store} row={row} selected={row.index === selected} ordinary={ordinary?.[row.index]} />}
          />
        ) : (
          <p class="empty">No section matches.</p>
        )
      ) : null}
      {state.derived ? (
        <div class="derived">
          <div class="panel-head">
            <strong>Headings found ({state.derived.length})</strong>
            <button class="text-button small primary" disabled={state.derived.length === 0} onClick={() => store.setOutline(state.derived?.map(({ title, page, depth }) => ({ title, page, depth })) ?? [], 'derived')}>
              Use these
            </button>
          </div>
          <ul class="rows derived-list">
            {state.derived.map((heading, at) => (
              <li key={at} class="row" style={{ paddingLeft: `${8 + heading.depth * 16}px` }}>
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
