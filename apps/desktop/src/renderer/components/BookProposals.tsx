import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../hooks.js';
import { BOOK_COLOR, SOLUTION_COLOR } from '../logic/colors.js';
import { inWindowPages } from '../logic/derive.js';
import { sectionChoices } from '../logic/model.js';
import { viewRows, type BookCounts, type BookFilter, type BookKind, type BookRow, type BookRows, type ConfidenceFilter, type FindingGroup } from '../logic/proposals.js';
import type { BookReview, Store } from '../logic/store.js';
import { AuditBar } from './DeriveReview.js';
import { Info } from './Toolbar.js';
import { VirtualList } from './VirtualList.js';

const ROW_HEIGHT = 46;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const NOUNS: Record<BookKind, { one: string; many: string; find: string; running: string }> = {
  exercises: { one: 'exercise', many: 'exercises', find: 'Find the exercises', running: 'Looking for the exercises...' },
  solutions: { one: 'answer', many: 'answers', find: 'Find the answers', running: 'Looking for the answers...' },
};

const FILTERS: { id: BookFilter; label: (counts: BookCounts, dismissed: number) => string }[] = [
  { id: 'todo', label: (counts) => `To do (${counts.new + counts.different})` },
  { id: 'new', label: (counts) => `New (${counts.new})` },
  { id: 'different', label: (counts) => `Different (${counts.different})` },
  { id: 'same', label: (counts) => `In the book (${counts.same})` },
  { id: 'all', label: (counts) => `All (${counts.total})` },
  { id: 'rejected', label: (_counts, dismissed) => `Dismissed (${dismissed})` },
];

const CONFIDENCES: { id: ConfidenceFilter; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'sure', label: 'Sure, 80%+' },
  { id: 'unsure', label: 'Not sure' },
];

const STATE_TAG = { new: { text: 'New', style: 'new' }, different: { text: 'Different', style: 'changed' }, same: { text: 'The same', style: 'same' } } as const;

/** The one-sentence verdict on a result: how many of the proposals the book has, lacks or has differently. */
function summaryOf(kind: BookKind, model: BookRows, result: BookReview['result']): string {
  const { counts } = model;
  const noun = NOUNS[kind];
  if (counts.total === 0) return kind === 'exercises' ? 'No exercises were found.' : 'No answers were found for the exercises of the book.';
  if (counts.new === 0 && counts.different === 0) return `All ${counts.total} ${noun.many} are in the book already, exactly as the search found ${counts.total === 1 ? 'it' : 'them'}: nothing new, nothing different.`;
  const where = kind === 'exercises' && result.kind === 'exercises' ? ` in ${plural(result.exercises.sections.filter((section) => section.proposals.length > 0).length, 'section')}` : '';
  return `${plural(counts.total, noun.one, noun.many)} found${where}: ${counts.new} new, ${counts.different} different from yours, ${counts.same} in the book already${counts.unsure > 0 ? `; ${counts.unsure} not sure` : ''}.`;
}

function RowView({ store, kind, row, review, listing }: { store: Store; kind: BookKind; row: BookRow; review: BookReview; listing: BookFilter }): preact.JSX.Element {
  const tag = STATE_TAG[row.state];
  const canTake = row.state !== 'same' && row.refusal === undefined;
  const dismissed = review.rejected[row.key] === true;
  return (
    <div class={`book-row ${review.focus === row.key ? 'focused' : ''} ${dismissed ? 'off' : ''}`} data-key={row.key} onClick={() => store.focusBook(kind, row.key)}>
      <input
        type="checkbox"
        checked={review.ticked[row.key] === true}
        disabled={!canTake}
        aria-label={`${row.state === 'different' ? 'Replace yours with' : 'Take'} ${row.key}`}
        title={row.state === 'different' ? 'Tick to replace the one the book has with this one' : row.state === 'same' ? 'The book has this already' : 'Take this one'}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => store.tickBook(kind, row.key, (event.target as HTMLInputElement).checked)}
      />
      <span class="chip book label-chip" style={{ background: kind === 'solutions' ? SOLUTION_COLOR : BOOK_COLOR }}>
        {kind === 'solutions' ? `S ${row.label}` : row.label}
      </span>
      <div class="section-main">
        <div class="section-title" title={row.title}>
          {row.title || '(no text)'}
        </div>
        <div class="section-sub">
          <span class="mono">{row.section}</span>
          <span>p{row.page + 1}</span>
          {row.refusal !== undefined ? (
            <span class="problem" title={row.refusal}>
              cannot be applied
            </span>
          ) : null}
          {row.state === 'different' && row.changes[0] !== undefined ? <span class="change">{row.changes[0]}</span> : null}
        </div>
      </div>
      <div class="derive-side">
        <span class={`derive-tag ${tag.style}`}>{tag.text}</span>
        <span class={`conf ${row.confidence >= 0.8 ? 'high' : row.confidence >= 0.6 ? 'middle' : 'low'}`} title="How sure the search is">
          {Math.round(row.confidence * 100)}%
        </span>
      </div>
      <button
        class="mini-button"
        aria-label={listing === 'rejected' ? `Bring back ${row.key}` : `Dismiss ${row.key}`}
        title={listing === 'rejected' ? 'Bring this proposal back' : 'Dismiss this proposal: it is not applied'}
        onClick={(event) => {
          event.stopPropagation();
          store.rejectBook(kind, row.key, listing !== 'rejected');
        }}
      >
        {listing === 'rejected' ? '↺' : '✕'}
      </button>
    </div>
  );
}

function Evidence({ row }: { row: BookRow }): preact.JSX.Element {
  return (
    <section class="derive-detail" aria-label="Why this proposal">
      <div class="inspector-head">
        <strong class="inspector-title">{row.key}</strong>
        <span class="muted">{Math.round(row.confidence * 100)}% sure</span>
      </div>
      {row.refusal !== undefined ? <p class="form-error">{row.refusal}.</p> : null}
      {row.state === 'different' ? (
        <ul class="evidence-list change-list" aria-label="How it differs from the book's own">
          {row.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      ) : null}
      <ul class="evidence-list" aria-label="Evidence">
        {row.evidence.map((line, at) => (
          <li key={at}>{inWindowPages(line)}</li>
        ))}
      </ul>
    </section>
  );
}

function Findings({ store, groups }: { store: Store; groups: readonly FindingGroup[] }): preact.JSX.Element | null {
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.lines.length, 0);
  const tree = store.book().tree;
  return (
    <details class="book-findings">
      <summary>To look at ({total})</summary>
      {groups.map((group) => (
        <div key={group.title} class="finding-group">
          <strong>{group.title}</strong>
          <ul class="evidence-list">
            {group.lines.slice(0, 40).map((line, at) => (
              <li key={at}>
                {line.text}
                {line.section !== undefined && tree.byId.has(line.section) ? (
                  <>
                    {' '}
                    <button class="link-button" onClick={() => store.goToSection(tree.byId.get(line.section as string) as number)}>
                      Show the section
                    </button>
                  </>
                ) : null}
              </li>
            ))}
            {group.lines.length > 40 ? <li class="muted">... and {group.lines.length - 40} more</li> : null}
          </ul>
        </div>
      ))}
    </details>
  );
}

/**
 * The exercises or the answers the search found in the book, for review: each compared with what the book has, ticked to
 * be taken, dismissed when wrong, shown as a ghost on its page. "Apply all" takes every new one the list shows, "Apply
 * selected" the ticked ones (also those that replace a different one): one atomic step, the same operations the command line
 * writes. Running it again on a book that has them says so and offers nothing.
 */
export function BookProposalsPanel({ store, kind }: { store: Store; kind: BookKind }): preact.JSX.Element {
  const state = useStore(store);
  const [query, setQuery] = useState('');
  const review = state.book[kind];
  const model = store.bookModel(kind);
  const noun = NOUNS[kind];
  const book = store.book();
  const exercisesInBook = useMemo(() => (state.project?.frames ?? []).some((frame) => frame.kind === 'exercise' && frame.authority === 'book'), [state.project?.frames]);
  const hasIds = book.entries.some((entry) => entry.id !== undefined);
  const choices = sectionChoices(book).filter((choice) => (book.entries[choice.index]?.depth ?? 0) > 0);
  const running = state.audit.job === kind;
  const busy = state.audit.job !== null;
  const message = state.bookMessage?.kind === kind ? state.bookMessage.text : null;
  const dismissed = review ? Object.keys(review.rejected).length : 0;
  const listed = useMemo(
    () => (review && model ? viewRows(model.rows, { filter: review.filter, confidence: review.confidence, rejected: review.rejected, query }) : []),
    [model, review?.filter, review?.confidence, review?.rejected, query],
  );
  const applyAll = review ? store.applicableKeys(kind, listed, 'all') : [];
  const applySelected = review ? store.applicableKeys(kind, listed, 'selected') : [];
  const focusedRow = review && model && review.focus !== null ? model.byKey.get(review.focus) : undefined;
  const focusedAt = focusedRow ? listed.indexOf(focusedRow) : -1;
  const focused = focusedAt >= 0 ? focusedRow : undefined;
  const lacking = kind === 'exercises' ? (hasIds ? null : 'The book has no sections yet, and exercises are filed under sections.') : exercisesInBook ? null : 'The book has no book exercises yet, and an answer belongs to an exercise.';

  return (
    <div class="book-proposals" aria-label={kind === 'exercises' ? 'Book exercises' : 'Solutions'}>
      <div class="panel-head column">
        <div class="button-row">
          {kind === 'exercises' ? (
            <select class="section-select" aria-label="Which sections to search" value={state.bookScope} disabled={busy} onChange={(event) => store.setBookScope((event.target as HTMLSelectElement).value)}>
              <option value="all">All sections</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.text}
                </option>
              ))}
            </select>
          ) : null}
          <button class="text-button small primary" disabled={busy || lacking !== null} onClick={() => void store.proposeBook(kind)}>
            {running ? noun.running : review ? 'Find again' : noun.find}
          </button>
          <Info
            text={
              kind === 'exercises'
                ? 'Reads the whole book offline (no AI) and finds the numbered exercises of the practice sets, each with the instruction above it. Nothing is changed until you apply: look at them, tick the ones to take, dismiss what is wrong.'
                : 'Reads the answer key at the back of the book offline (no AI) and matches each answer to the exercise of the book with the same section and number. An answer is hidden from the learner and used to grade. Nothing is changed until you apply.'
            }
            label={kind === 'exercises' ? 'finding the exercises' : 'finding the answers'}
          />
        </div>
        <AuditBar store={store} />
        {lacking !== null ? (
          <p class="warn-line" role="status">
            {lacking}{' '}
            <button class="link-button" onClick={() => (kind === 'exercises' ? store.setTab('sections') : store.setProposeMode('exercises'))}>
              {kind === 'exercises' ? 'Find the sections first' : 'Find the exercises first'}
            </button>
          </p>
        ) : null}
        {message !== null ? (
          <p class="form-error" role="alert">
            {message}
          </p>
        ) : null}
        {review && model ? (
          <>
            <p class="derive-summary" role="status">
              {summaryOf(kind, model, review.result)}
            </p>
            {model.counts.total > 0 ? (
              <>
                <div class="button-row derive-select">
                  <span class="muted">Take:</span>
                  <button class="link-button" onClick={() => store.tickRows(kind, listed, true)}>
                    all listed
                  </button>
                  <button class="link-button" onClick={() => store.tickRows(kind, listed, false)}>
                    none
                  </button>
                  <span class="muted" role="status">
                    {applySelected.length} selected
                  </span>
                </div>
                <div class="button-row">
                  <button class="text-button small primary" disabled={applyAll.length === 0} title={`Add every new ${noun.one} in the list, as one step`} onClick={() => store.applyBook(kind, applyAll)}>
                    Apply all ({applyAll.length})
                  </button>
                  <button class="text-button small" disabled={applySelected.length === 0} title="Apply only the ticked ones: new ones are added, different ones replace the book's own" onClick={() => store.applyBook(kind, applySelected)}>
                    Apply selected ({applySelected.length})
                  </button>
                  <button class="text-button small" onClick={() => store.discardBook(kind)}>
                    Discard
                  </button>
                </div>
              </>
            ) : null}
            {review.summary !== null ? (
              <p class="derive-effect applied" role="status">
                {review.summary}
              </p>
            ) : null}
            {review.error !== null ? (
              <p class="form-error" role="alert">
                {review.error}
              </p>
            ) : null}
            {model.counts.total > 0 ? (
              <div class="button-row">
                <select class="section-select" aria-label="Which proposals to show" value={review.filter} onChange={(event) => store.setBookFilter(kind, (event.target as HTMLSelectElement).value as BookFilter)}>
                  {FILTERS.map((filter) => (
                    <option key={filter.id} value={filter.id}>
                      {filter.label(model.counts, dismissed)}
                    </option>
                  ))}
                </select>
                <select class="section-select" aria-label="How sure the search is" value={review.confidence} onChange={(event) => store.setBookConfidence(kind, (event.target as HTMLSelectElement).value as ConfidenceFilter)}>
                  {CONFIDENCES.map((confidence) => (
                    <option key={confidence.id} value={confidence.id}>
                      {confidence.label}
                    </option>
                  ))}
                </select>
                <input class="commit-input search" type="search" value={query} placeholder="Find a number" aria-label="Find a proposal" onInput={(event) => setQuery((event.target as HTMLInputElement).value)} onKeyDown={(event) => event.stopPropagation()} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {focused ? <Evidence row={focused} /> : null}
      {review && model && model.counts.total > 0 ? (
        listed.length > 0 ? (
          <VirtualList
            label={kind === 'exercises' ? 'Exercises found' : 'Answers found'}
            class="book-list"
            rows={listed}
            rowHeight={ROW_HEIGHT}
            rowKey={(row) => row.key}
            scrollTo={{ index: focusedAt, tick: focusedAt }}
            renderRow={(row) => <RowView store={store} kind={kind} row={row} review={review} listing={review.filter} />}
          />
        ) : (
          <p class="empty">{review.filter === 'todo' && review.confidence === 'any' && query.trim() === '' ? 'Nothing new or different: the book has everything the search found.' : 'No proposal matches.'}</p>
        )
      ) : null}
      {review && model ? <Findings store={store} groups={model.findings} /> : null}
    </div>
  );
}
