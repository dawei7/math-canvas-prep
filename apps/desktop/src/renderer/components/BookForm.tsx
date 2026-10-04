import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { suggestFor } from '../logic/book.js';
import { sectionChoices } from '../logic/model.js';
import type { Store } from '../logic/store.js';

/**
 * Asks for the two things a book exercise needs: the number the book prints for it and the section it is printed in. The
 * section is the one at this place of the document and the number is the next one in it (previous + 1, `5b` after `5a`),
 * so that auditing a section is: draw, press Enter, draw, press Enter.
 */
export function BookForm({
  store,
  heading,
  at,
  label,
  section,
  note,
  error,
  confirmText,
  selfId,
  onConfirm,
  onCancel,
}: {
  store: Store;
  heading: string;
  /** Where the exercise is: the section to offer is the one at this place. */
  at: { page: number; top: number };
  label: string;
  section: string | undefined;
  note: string | null;
  error: string | null;
  confirmText: string;
  /** The exercise being changed, which may keep its own number. */
  selfId?: string;
  onConfirm: (label: string, section: string | undefined) => void;
  onCancel: () => void;
}): preact.JSX.Element {
  const [text, setText] = useState(label);
  const [chosen, setChosen] = useState<string | undefined>(section);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const model = store.book();
  const choices = sectionChoices(model);
  const adoptable = (store.state.doc?.pdfOutline?.length ?? 0) > 0 && !store.state.project?.outline;

  // At once, before the next key is pressed: Enter must confirm this form, not click the tool button that still has the focus.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Sections appeared while the form was open (the person gave them ids, or adopted the bookmarks): offer the one here.
  useEffect(() => {
    if (chosen !== undefined || choices.length === 0) return;
    const suggestion = suggestFor(model, at.page, at.top, selfId === undefined ? {} : { exceptId: selfId });
    if (suggestion.section === undefined) return;
    setChosen(suggestion.section);
    if (!touched) setText(suggestion.label);
  }, [choices.length]);

  const chooseSection = (id: string): void => {
    setChosen(id);
    if (!touched) setText(store.nextLabelIn(id, selfId));
  };

  return (
    <form
      class="book-form"
      aria-label={heading}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(text, chosen);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <strong class="form-title">{heading}</strong>
      <label class="field">
        <span>Printed number</span>
        <input
          ref={input}
          class="label-input"
          value={text}
          maxLength={24}
          aria-label="Printed number"
          placeholder="5, 5a, A.3"
          onInput={(event) => {
            setText((event.target as HTMLInputElement).value);
            setTouched(true);
          }}
        />
      </label>
      <label class="field">
        <span>Section</span>
        <select class="section-select" aria-label="Section" value={chosen ?? ''} disabled={choices.length === 0} onChange={(event) => chooseSection((event.target as HTMLSelectElement).value)}>
          {chosen === undefined ? <option value="">Choose a section...</option> : null}
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.text}
            </option>
          ))}
        </select>
      </label>
      {note !== null && chosen === undefined ? <p class="form-note">{note}</p> : null}
      {choices.length === 0 ? (
        <div class="button-row">
          {adoptable ? (
            <button type="button" class="text-button small" onClick={() => store.adoptPdfOutline()}>
              Use the PDF's bookmarks as sections
            </button>
          ) : model.entries.length > 0 ? (
            <button type="button" class="text-button small" onClick={() => store.giveSectionIds()}>
              Give the sections ids
            </button>
          ) : (
            <button type="button" class="text-button small" onClick={() => store.setTab('sections')}>
              Open the Sections list
            </button>
          )}
        </div>
      ) : null}
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div class="button-row end tight">
        <button type="button" class="text-button small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" class="text-button small primary">
          {confirmText}
        </button>
      </div>
    </form>
  );
}
