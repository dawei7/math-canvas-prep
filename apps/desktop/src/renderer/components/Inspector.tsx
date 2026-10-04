import { useEffect, useState } from 'preact/hooks';
import { isAuthoritative, linesInRect, type Frame, type PageText, type Region } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { suggestFor } from '../logic/book.js';
import { frameColor } from '../logic/colors.js';
import { NO_PARTS_REASON } from '../logic/errors.js';
import { entryOfSection, frameIndex, labelOf, sectionChoices } from '../logic/model.js';
import type { RegionKind, Store } from '../logic/store.js';
import { BookForm } from './BookForm.js';
import { Info } from './Toolbar.js';

/** What is printed under a region, in a few words: what the person checks when they list a context or solution region. */
function regionText(texts: Record<number, PageText>, region: Region): string {
  const lines = texts[region.page]?.lines;
  if (!lines) return '';
  return linesInRect(lines, region.rect)
    .filter((line) => line.headerFooter !== true)
    .map((line) => line.text)
    .join(' ')
    .slice(0, 46);
}

const REGION_INFO: Record<RegionKind, { title: string; info: string }> = {
  context: { title: 'Context', info: 'The instruction the learner is shown with the exercise. It is also sent to the AI with every check. Draw it with the Context tool.' },
  solution: { title: 'Solution', info: 'Where the answer is printed in this PDF, usually the answer key at the back. It is hidden from the learner: never shown with the exercise, never sent to a tutor chat, only used to grade. Draw it with the Solution tool.' },
  continues: { title: 'Continues', info: 'Where the exercise goes on after its first region (the next column or page). Draw it with the Continue tool.' },
};

function RegionList({ store, kind, frame, regions }: { store: Store; kind: RegionKind; frame: Frame; regions: readonly Region[] }): preact.JSX.Element | null {
  const state = useStore(store);
  const { title, info } = REGION_INFO[kind];
  if (regions.length === 0 && kind === 'continues') return null;
  return (
    <div class={`region-list region-list-${kind}`}>
      <div class="region-head">
        <span class="row-title">
          {title} ({regions.length})
        </span>
        {kind === 'solution' ? (
          <span class="hidden-badge" title="Hidden from the learner">
            hidden from the learner
          </span>
        ) : null}
        <Info text={info} label={title.toLowerCase()} />
      </div>
      {regions.length === 0 ? <p class="muted none">{kind === 'solution' ? 'None yet. Choose the Solution tool, go to the answer key and draw the answer.' : 'None yet. Choose the Context tool and draw the instruction.'}</p> : null}
      {regions.map((region, i) => (
        <div class="region-item" key={`${kind}-${i}-${region.page}-${region.rect.top}`}>
          <button class="region-pill" title="Show it on the page" onClick={() => store.showRegion(region.page, region.rect)}>
            <span class="pill-page">p{region.page + 1}</span>
            <span class="pill-text">{regionText(state.texts, region) || `${(region.rect.bottom - region.rect.top).toFixed(3)} tall`}</span>
          </button>
          <button class="row-delete" aria-label={`Remove ${kind} region ${i + 1}`} title="Remove this region" onClick={() => store.removeRegion(kind, frame.id, i)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The printed number and the section of a book exercise, editable: a change is one undoable step. */
function BookFields({ store, frame }: { store: Store; frame: Frame }): preact.JSX.Element {
  const [text, setText] = useState(frame.label ?? '');
  const [error, setError] = useState<string | null>(null);
  const choices = sectionChoices(store.book());
  const commitLabel = (): void => {
    if (text === frame.label) return;
    const result = store.setBookLabel(frame.id, text);
    setError(result.ok ? null : (result.error ?? 'The number could not be changed.'));
    if (!result.ok) setText(frame.label ?? '');
  };
  return (
    <div class="book-fields">
      <label class="field">
        <span>Printed number</span>
        <input
          class="label-input"
          value={text}
          maxLength={24}
          aria-label="Printed number"
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
          onChange={commitLabel}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') commitLabel();
            if (event.key === 'Escape') setText(frame.label ?? '');
          }}
        />
      </label>
      <label class="field">
        <span>Section</span>
        <select
          class="section-select"
          aria-label="Section"
          value={frame.section ?? ''}
          onChange={(event) => {
            const result = store.setBookSection(frame.id, (event.target as HTMLSelectElement).value);
            setError(result.ok ? null : (result.error ?? 'The section could not be changed.'));
          }}
        >
          {frame.section !== undefined && !choices.some((choice) => choice.id === frame.section) ? <option value={frame.section}>{frame.section} (not in the list)</option> : null}
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.text}
            </option>
          ))}
        </select>
      </label>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The card for the selected frame, at the top of the side panel whichever list is open: what it is, its printed number and
 * section when it is a book exercise, the regions that belong to it (context, the hidden solution, continuations) with a
 * button to show or remove each, and what can be done with it: turn it into a book exercise or back, cut it into parts.
 */
export function Inspector({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  const project = state.project;
  const frame = state.selection === null || !project ? undefined : frameIndex(project.frames).byId.get(state.selection);
  // One card per selected frame: what was open in the card of the last one does not carry over.
  return frame ? <InspectorCard key={frame.id} store={store} frameId={frame.id} /> : null;
}

function InspectorCard({ store, frameId }: { store: Store; frameId: string }): preact.JSX.Element | null {
  const state = useStore(store);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = state.project;
  const index = frameIndex(project?.frames ?? []);
  const frame = index.byId.get(frameId);
  const owner = frame !== undefined && frame.unit !== undefined ? (index.units.get(frame.unit)?.[0] ?? frame) : frame;
  const pagesKey = frame === undefined ? '' : [...(owner?.context ?? []), ...(frame.solution ?? []), ...(frame.continues ?? [])].map((region) => region.page).join(',');

  useEffect(() => {
    if (pagesKey !== '') void store.ensureTexts(pagesKey.split(',').map(Number));
  }, [pagesKey]);

  if (!project || !frame || !owner) return null;
  const book = isAuthoritative(frame);
  const exercise = frame.kind === 'exercise';
  const label = labelOf(index, frame);
  const color = frameColor(frame);
  const model = store.book();
  const parts = frame.unit !== undefined ? (index.units.get(frame.unit) ?? []) : [];
  const section = entryOfSection(model, frame.section);
  const suggestion = marking ? suggestFor(model, frame.page, frame.rect.top) : undefined;
  const kindName = book ? 'Book exercise' : frame.kind === 'exercise' ? (frame.unit !== undefined ? `Exercise, part ${Math.max(1, parts.indexOf(frame) + 1)} of ${parts.length}` : 'Exercise') : frame.kind === 'question' ? 'Question' : 'Bookmark';

  const remove = (): void => {
    store.apply([frame.unit !== undefined ? { op: 'delete', unit: frame.unit } : { op: 'delete', id: frame.id }], { select: null });
  };

  return (
    <section class="inspector" aria-label="Selected frame">
      <div class="inspector-head">
        <span class={`chip ${book ? 'book' : ''}`} style={{ background: color }}>
          {label}
        </span>
        <strong class="inspector-title">{kindName}</strong>
        {book ? (
          <Info
            text="A book exercise was audited from the book: it keeps the number the book prints and the section it is printed in. It is a single exercise, and it can carry the instruction (context) and a hidden solution to grade with."
            label="book exercise"
          />
        ) : null}
        <span class="spacer" />
        <button class="mini-button" title="Show it on the page" aria-label="Show the frame on its page" onClick={() => store.select(frame.id, { jump: true })}>
          ↗
        </button>
        <button class="mini-button" title="Deselect" aria-label="Deselect" onClick={() => store.select(null)}>
          ×
        </button>
      </div>
      <p class="muted inspector-where">
        Page {frame.page + 1}
        {book && section ? ` · section ${section.title}` : ''}
        {book && frame.section !== undefined && !section ? ` · section ${frame.section} is not in the list` : ''}
      </p>

      {book ? <BookFields key={`${frame.id}:${frame.label}:${frame.section}`} store={store} frame={frame} /> : null}

      {exercise ? (
        <div class="inspector-row" role="group" aria-label="Kind of exercise">
          <span class="row-title">Kind</span>
          {book ? (
            <button
              class="text-button small"
              onClick={() => {
                const result = store.unmark(frame.id);
                setError(result.ok ? null : (result.error ?? null));
              }}
            >
              Make it an ordinary exercise
            </button>
          ) : (
            <>
              <button class="text-button small" disabled={frame.unit !== undefined || marking} onClick={() => setMarking(true)}>
                Make it a book exercise...
              </button>
              {frame.unit !== undefined ? <Info text="A book exercise is a single exercise, and this one has parts. Join the parts first (below), or draw each printed exercise on its own with the Book exercise tool." label="book exercise" /> : null}
            </>
          )}
        </div>
      ) : null}
      {marking && suggestion ? (
        <BookForm
          key={`mark-${frame.id}`}
          store={store}
          heading="Make it a book exercise"
          at={{ page: frame.page, top: frame.rect.top }}
          label={suggestion.label}
          section={suggestion.section}
          note={suggestion.noSection ?? null}
          error={error}
          confirmText="Make book exercise"
          selfId={frame.id}
          onConfirm={(text, chosen) => {
            const result = store.markAsBook(frame.id, text, chosen);
            if (result.ok) {
              setMarking(false);
              setError(null);
            } else setError(result.error ?? 'It could not be made a book exercise.');
          }}
          onCancel={() => {
            setMarking(false);
            setError(null);
          }}
        />
      ) : null}
      {!marking && error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {exercise ? <RegionList store={store} kind="context" frame={owner} regions={owner.context ?? []} /> : null}
      {exercise ? <RegionList store={store} kind="solution" frame={frame} regions={frame.solution ?? []} /> : null}
      {exercise ? <RegionList store={store} kind="continues" frame={frame} regions={frame.continues ?? []} /> : null}

      {exercise ? (
        <div class="inspector-row" role="group" aria-label="Parts">
          <span class="row-title">Parts</span>
          {book ? (
            <>
              <button class="text-button small" disabled aria-disabled="true">
                Cut into parts
              </button>
              <Info text={NO_PARTS_REASON} label="parts of a book exercise" />
            </>
          ) : frame.unit !== undefined ? (
            <button class="text-button small" onClick={() => store.joinParts(frame.unit as string)}>
              Join the {parts.length} parts
            </button>
          ) : (
            <button
              class="text-button small"
              onClick={() => {
                const result = store.cutIntoParts(frame.id);
                setError(result.ok ? null : (result.error ?? null));
              }}
            >
              Cut into parts
            </button>
          )}
        </div>
      ) : null}

      <div class="inspector-row">
        <button class="text-button small danger" onClick={remove}>
          Delete {frame.unit !== undefined ? 'the exercise' : 'it'}
        </button>
      </div>
    </section>
  );
}
