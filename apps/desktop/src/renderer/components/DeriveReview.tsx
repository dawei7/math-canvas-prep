import { describeSection } from '@mcprep/core/pure';
import { useProgress, useStore } from '../hooks.js';
import { confidenceLevel, filterRows, inWindowPages, type DeriveFilter, type DeriveOutcome, type DerivePlan, type DerivedRow, type YoursRow } from '../logic/derive.js';
import { titleWithoutLabel } from '../logic/sections.js';
import type { Store } from '../logic/store.js';
import { VirtualList } from './VirtualList.js';

const ROW_HEIGHT = 46;
const YOURS_HEIGHT = 56;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * The bar of a long job in the main process: what it is doing, how far it is, and a button that stops it. It redraws by
 * itself ten times a second (the progress is not part of the editor's state).
 */
export function AuditBar({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  const progress = useProgress(store);
  if (state.audit.job === null) return null;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : 0;
  const phase = state.audit.stopping ? 'Stopping...' : (progress?.phase ?? 'Starting...');
  return (
    <div class="audit-bar" role="group" aria-label="Progress of the search">
      <div class="audit-line">
        <span class="audit-phase" role="status">
          {phase}
        </span>
        {total > 0 ? (
          <span class="muted">
            {done} of {total}
          </span>
        ) : null}
        <button class="text-button small" disabled={state.audit.stopping} onClick={() => store.cancelAudit()}>
          Stop
        </button>
      </div>
      <div class="audit-track" role="progressbar" aria-label={phase} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div class="audit-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

const FILTERS: { id: DeriveFilter; label: (plan: DerivePlan) => string }[] = [
  { id: 'all', label: (plan) => `All (${plan.counts.total})` },
  { id: 'changes', label: (plan) => `New or different (${plan.counts.new + plan.counts.changed})` },
  { id: 'new', label: (plan) => `New (${plan.counts.new})` },
  { id: 'changed', label: (plan) => `Different from yours (${plan.counts.changed})` },
  { id: 'same', label: (plan) => `The same (${plan.counts.same})` },
  { id: 'unsure', label: (plan) => `Not sure (${plan.counts.unsure})` },
];

const STATUS_WORDS = { new: 'New', changed: 'Different', same: 'The same' } as const;

/** What taking the selected sections would do, in one sentence. */
function effectOf(outcome: DeriveOutcome, selected: number): string {
  if (selected === 0) return 'Nothing is selected.';
  if (outcome.nothing) return 'Nothing would change with this selection.';
  const parts: string[] = [];
  const { taken } = outcome;
  const detail = [taken.new > 0 ? `${taken.new} new` : '', taken.changed > 0 ? `${taken.changed} different` : ''].filter((text) => text !== '').join(', ');
  parts.push(`Takes ${plural(taken.new + taken.changed + taken.same, 'section')}${detail !== '' ? ` (${detail})` : ''}`);
  if (outcome.moves.length > 0) parts.push(`${plural(outcome.moves.length, 'exercise')} move${outcome.moves.length === 1 ? 's' : ''} to the section you chose`);
  if (outcome.removed > 0) parts.push(`${plural(outcome.removed, 'section')} of yours ${outcome.removed === 1 ? 'is' : 'are'} replaced`);
  if (outcome.keptWithExercises > 0) parts.push(`${plural(outcome.keptWithExercises, 'section')} of yours stay${outcome.keptWithExercises === 1 ? 's' : ''}: exercises are filed under ${outcome.keptWithExercises === 1 ? 'it' : 'them'}`);
  return `${parts.join('; ')}.`;
}

function DerivedRowView({ store, row, selected, focused }: { store: Store; row: DerivedRow; selected: boolean; focused: boolean }): preact.JSX.Element {
  const { entry } = row;
  return (
    <div class={`derive-row ${focused ? 'focused' : ''} ${selected ? '' : 'off'}`} data-id={entry.id} onClick={() => store.focusDerived(entry.id)}>
      <input
        type="checkbox"
        checked={selected}
        aria-label={`Take ${describeSection(entry)}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => store.setDerived(entry.id, (event.target as HTMLInputElement).checked)}
      />
      {entry.label !== undefined ? <span class="chip section-chip">{entry.label}</span> : null}
      <div class="section-main">
        <div class="section-title" title={entry.title}>
          {titleWithoutLabel(entry)}
        </div>
        <div class="section-sub">
          <span class="mono">id {entry.id}</span>
          <span>p{entry.page + 1}</span>
          {entry.top !== undefined ? <span>at {entry.top.toFixed(2)}</span> : null}
          {row.exercises > 0 ? <span>{plural(row.exercises, 'exercise')}</span> : null}
          {row.status === 'changed' && row.changes[0] !== undefined ? (
            <span class="change">
              {row.changes[0]}
              {row.changes.length > 1 ? ` (+${row.changes.length - 1})` : ''}
            </span>
          ) : null}
        </div>
      </div>
      <div class="derive-side">
        <span class={`derive-tag ${row.status}`}>{STATUS_WORDS[row.status]}</span>
        <span class={`conf ${confidenceLevel(entry.confidence)}`} title="How sure the search is that this section is there, as printed">
          {Math.round(entry.confidence * 100)}%
        </span>
      </div>
    </div>
  );
}

/** Why a derived section is proposed: what each source says, where they differ, and how it differs from the project's own. */
function Evidence({ row }: { row: DerivedRow }): preact.JSX.Element {
  const { entry } = row;
  return (
    <section class="derive-detail" aria-label="Why this section">
      <div class="inspector-head">
        <strong class="inspector-title">{describeSection(entry)}</strong>
        <span class="muted">
          {entry.kind === 'chapter' ? 'chapter' : entry.kind === 'section' ? 'section' : 'other'} · {Math.round(entry.confidence * 100)}% sure
        </span>
      </div>
      {row.status === 'changed' ? (
        <ul class="evidence-list change-list" aria-label="How it differs from your section">
          {row.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      ) : null}
      {row.status === 'new' && row.exercises > 0 ? <p class="form-note">{plural(row.exercises, 'exercise')} already name this section: taking it gives them their section.</p> : null}
      <ul class="evidence-list" aria-label="Evidence">
        {entry.evidence.map((line, at) => (
          <li key={at}>{inWindowPages(line)}</li>
        ))}
      </ul>
      {entry.differences.length > 0 ? (
        <p class="muted small-note">Other spellings of the title: {entry.differences.map((other) => `${other.source}: "${other.text}"`).join('; ')}.</p>
      ) : null}
    </section>
  );
}

/** A section of the project that holds exercises and that the derived list does not have: keep it, or move its exercises. */
function YoursRowView({ store, row, plan, target }: { store: Store; row: YoursRow; plan: DerivePlan; target: string | undefined }): preact.JSX.Element {
  const id = row.entry.id as string;
  return (
    <div class="yours-row">
      <div class="section-main">
        <div class="section-title" title={row.entry.title}>
          {describeSection(row.entry)}
        </div>
        <div class="section-sub">
          <span class="mono">id {id}</span>
          <span>{plural(row.exercises, 'exercise')} filed here</span>
          {row.suggested !== undefined ? <span>looks like {row.suggested}</span> : null}
        </div>
      </div>
      <select class="section-select" aria-label={`What to do with ${describeSection(row.entry)}`} value={target ?? ''} onChange={(event) => store.moveSectionTo(id, (event.target as HTMLSelectElement).value || null)}>
        <option value="">Keep the section</option>
        {plan.rows.map((derived) => (
          <option key={derived.entry.id} value={derived.entry.id}>
            Move the exercises to {describeSection(derived.entry)} ({derived.entry.id})
            {derived.entry.id === row.suggested ? ' - looks the same' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The sections the search found in the printed text of the book, for review: each with the evidence and how sure the search
 * is, compared with the sections the project already has (new, different, the same). The person takes all of them or some;
 * a section of the project that holds exercises is never lost, and what the derived list does not have is listed.
 */
export function DeriveReviewPanel({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  const review = state.derive;
  const plan = store.derivePlan();
  const outcome = store.deriveOutcome();
  if (!review || !plan || !outcome) return null;
  const rows = filterRows(plan.rows, review.filter);
  const selectedCount = Object.keys(review.selected).length;
  const focusedRow = review.focus === null ? undefined : plan.rows.find((row) => row.entry.id === review.focus);
  const focusedAt = focusedRow === undefined ? -1 : rows.indexOf(focusedRow);
  const { counts } = plan;
  const holders = plan.yours.filter((row) => row.exercises > 0 && row.entry.id !== undefined);
  const others = plan.yours.length - holders.length;
  const suggestions = holders.filter((row) => row.suggested !== undefined && review.moves[row.entry.id as string] !== row.suggested).length;
  const identical = counts.new === 0 && counts.changed === 0 && plan.yours.length === 0;
  const notes = review.structure.notes;
  return (
    <div class="derive-review" aria-label="Sections found in the book">
      <div class="panel-head column">
        <div class="derive-title">
          <strong>Sections found in the book</strong>
          <span class="spacer" />
          <button class="mini-button" aria-label="Close" title="Discard what was found; nothing is changed" onClick={() => store.discardDerive()}>
            ×
          </button>
        </div>
        <p class="derive-summary" role="status">
          {counts.total === 0
            ? 'No chapters or sections were found.'
            : identical
              ? `${plural(counts.total, 'section')} found, and the book already has exactly these: nothing new, nothing different.`
              : `${plural(counts.total, 'section')} found (${plural(counts.chapters, 'chapter')}, ${plural(counts.sections, 'section')}): ${counts.new} new, ${counts.changed} different from yours, ${counts.same} the same.`}
        </p>
        {notes.length > 0 ? (
          <details class="derive-notes">
            <summary>Things to look at ({notes.length})</summary>
            <ul class="evidence-list">
              {notes.map((note, at) => (
                <li key={at}>{inWindowPages(note)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {counts.total > 0 ? (
          <>
            <div class="button-row derive-select">
              <span class="muted">Take:</span>
              <button class="link-button" onClick={() => store.selectDerived('all')}>
                all
              </button>
              <button class="link-button" onClick={() => store.selectDerived('new')}>
                the new ones
              </button>
              <button class="link-button" onClick={() => store.selectDerived('changes')}>
                new and different
              </button>
              <button class="link-button" onClick={() => store.selectDerived('none')}>
                none
              </button>
              <span class="muted" role="status">
                {selectedCount} selected
              </span>
            </div>
            <div class="button-row">
              <button class="text-button small primary" title="Take every section found and make them the sections of the book" onClick={() => store.applyDerive('all')}>
                Accept all
              </button>
              <button class="text-button small" disabled={selectedCount === 0} title="Take only the sections that are ticked" onClick={() => store.applyDerive('selected')}>
                Accept selected ({selectedCount})
              </button>
              <button class="text-button small" onClick={() => store.discardDerive()}>
                Discard
              </button>
            </div>
            <p class="derive-effect" role="status">
              {effectOf(outcome, selectedCount)}
            </p>
          </>
        ) : (
          <div class="button-row">
            <button class="text-button small" onClick={() => store.discardDerive()}>
              Close
            </button>
          </div>
        )}
        {review.error !== null ? (
          <p class="form-error" role="alert">
            {review.error}
          </p>
        ) : null}
        {counts.total > 0 ? (
          <div class="button-row">
            <select class="section-select" aria-label="Which sections to show" value={review.filter} onChange={(event) => store.setDeriveFilter((event.target as HTMLSelectElement).value as DeriveFilter)}>
              {FILTERS.map((filter) => (
                <option key={filter.id} value={filter.id}>
                  {filter.label(plan)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {focusedRow ? <Evidence row={focusedRow} /> : null}
      {counts.total > 0 ? (
        rows.length > 0 ? (
          <VirtualList
            label="Sections found"
            class="derive-list"
            rows={rows}
            rowHeight={ROW_HEIGHT}
            rowKey={(row) => row.entry.id}
            scrollTo={{ index: focusedAt, tick: focusedAt }}
            renderRow={(row) => <DerivedRowView store={store} row={row} selected={review.selected[row.entry.id] === true} focused={row.entry.id === review.focus} />}
          />
        ) : (
          <p class="empty">No section matches.</p>
        )
      ) : null}
      {plan.yours.length > 0 ? (
        <section class="yours" aria-label="Your sections that the search did not find">
          <div class="yours-head">
            <strong>
              {plural(plan.yours.length, 'section')} of yours {plan.yours.length === 1 ? 'is' : 'are'} not in the list
            </strong>
            <p class="muted small-note">
              {others > 0 ? `${others} ha${others === 1 ? 's' : 've'} no exercises. ` : ''}
              {outcome.replacing ? (others > 0 ? 'They are replaced when all sections are taken, unless you keep them.' : '') : 'Taking only some of the sections removes none of them.'}
              {holders.length > 0 ? ` ${plural(holders.length, 'section')} ${holders.length === 1 ? 'holds' : 'hold'} exercises and stay${holders.length === 1 ? 's' : ''} unless you move the exercises.` : ''}
            </p>
            <div class="button-row">
              {others > 0 ? (
                <label class="radio">
                  <input type="checkbox" checked={review.keepOthers} onChange={(event) => store.setKeepOthers((event.target as HTMLInputElement).checked)} />
                  <span>Keep my sections without exercises too</span>
                </label>
              ) : null}
              {suggestions > 0 ? (
                <button class="text-button small" title="For each section of yours that looks like a section found (same printed number or title): move its exercises there" onClick={() => store.moveToSuggested()}>
                  Move exercises to the same-looking sections ({suggestions})
                </button>
              ) : null}
            </div>
          </div>
          {holders.length > 0 ? <VirtualList label="Sections of yours with exercises" class="yours-list" rows={holders} rowHeight={YOURS_HEIGHT} rowKey={(row) => String(row.index)} renderRow={(row) => <YoursRowView store={store} row={row} plan={plan} target={review.moves[row.entry.id as string]} />} /> : null}
        </section>
      ) : null}
    </div>
  );
}
