import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LIMITS } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { checkInfoForm, formFromMeta, patchFromForm, type InfoField, type InfoForm } from '../logic/info.js';
import type { Store } from '../logic/store.js';

const count = (text: string): number => Array.from(text.trim()).length;

function Field({
  form,
  field,
  label,
  help,
  problem,
  max,
  rows,
  placeholder,
  onChange,
  inputRef,
}: {
  form: InfoForm;
  field: InfoField;
  label: string;
  help?: string;
  problem: string | undefined;
  max?: number;
  rows?: number;
  placeholder?: string;
  onChange: (field: InfoField, value: string) => void;
  inputRef?: preact.RefObject<HTMLInputElement>;
}): preact.JSX.Element {
  const value = form[field];
  return (
    <label class={`info-field ${problem !== undefined ? 'has-problem' : ''}`}>
      <span class="info-label">
        {label}
        {max !== undefined && rows !== undefined ? (
          <span class="muted counter">
            {count(value)} / {max}
          </span>
        ) : null}
      </span>
      {rows !== undefined ? (
        <textarea class="info-input" rows={rows} value={value} aria-label={label} placeholder={placeholder} onInput={(event) => onChange(field, (event.target as HTMLTextAreaElement).value)} />
      ) : (
        <input ref={inputRef} class="info-input" value={value} aria-label={label} placeholder={placeholder} onInput={(event) => onChange(field, (event.target as HTMLInputElement).value)} />
      )}
      {problem !== undefined ? (
        <span class="form-error" role="alert">
          {problem}
        </span>
      ) : help !== undefined ? (
        <span class="muted help">{help}</span>
      ) : null}
    </label>
  );
}

/**
 * What the bundle says about the work: the title and folder the library shows, and the author, series, description,
 * licence, source and the notice a licence asks to be shown with the work. One undoable step; nothing is invented.
 */
export function InfoDialog({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  if (!state.infoOpen || !state.project) return null;
  return <InfoDialogBody key={state.project.pdf.sha256} store={store} />;
}

function InfoDialogBody({ store }: { store: Store }): preact.JSX.Element | null {
  const meta = store.state.project?.meta;
  const [form, setForm] = useState<InfoForm>(() => formFromMeta(meta ?? { title: '' }));
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  if (!meta) return null;
  const problems = checkInfoForm(form);
  const patch = patchFromForm(meta, form);
  const change = (field: InfoField, value: string): void => {
    setForm((old) => ({ ...old, [field]: value }));
    setError(null);
  };
  const save = (): void => {
    if (Object.keys(problems).length > 0) return;
    if (!patch) {
      store.closeInfo();
      return;
    }
    const result = store.setMeta(patch);
    if (result.ok) store.closeInfo();
    else setError(result.error ?? 'The information could not be saved.');
  };

  return (
    <div class="modal-backdrop" onClick={() => store.closeInfo()}>
      <form
        class="modal info-dialog"
        role="dialog"
        aria-label="Document information"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            store.closeInfo();
          }
        }}
      >
        <h2>Document information</h2>
        <p class="muted">What the bundle says about this work. A licence that asks for attribution travels with the file, and the app shows its notice. Copy the licence and the notice from the book itself; do not make them up.</p>
        <div class="info-grid">
          <Field form={form} field="title" label="Title" help="What the library shows (1 to 200 characters)." problem={problems.title} onChange={change} inputRef={first} />
          <Field form={form} field="folder" label="Folder" help="Where the library files it: names separated by /, at most seven levels." placeholder="Books/Algebra" problem={problems.folder} onChange={change} />
          <Field form={form} field="author" label="Author" problem={problems.author} onChange={change} />
          <Field form={form} field="series" label="Series" problem={problems.series} onChange={change} />
          <Field form={form} field="licenseName" label="Licence" placeholder="CC BY 3.0" problem={problems.licenseName} onChange={change} />
          <Field form={form} field="licenseUrl" label="Licence address" placeholder="https://creativecommons.org/licenses/by/3.0/" problem={problems.licenseUrl} onChange={change} />
          <Field form={form} field="sourceUrl" label="Source address" help="Where the work comes from." placeholder="https://example.org/the-book" problem={problems.sourceUrl} onChange={change} />
        </div>
        <Field form={form} field="description" label="Description" rows={3} max={LIMITS.descriptionMax} help="What the book is about, in a few sentences." problem={problems.description} onChange={change} />
        <Field
          form={form}
          field="notice"
          label="Notice"
          rows={4}
          max={LIMITS.noticeMax}
          help="The text the licence asks to be shown with the work, for example the attribution and what was changed."
          problem={problems.notice}
          onChange={change}
        />
        {error !== null ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="button-row end">
          <button type="button" class="text-button" onClick={() => store.closeInfo()}>
            Cancel
          </button>
          <button type="submit" class="text-button primary" disabled={Object.keys(problems).length > 0}>
            {patch ? 'Save' : 'Close'}
          </button>
        </div>
      </form>
    </div>
  );
}
