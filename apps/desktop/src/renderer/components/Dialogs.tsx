import { useStore } from '../hooks.js';
import { frameIndex } from '../logic/model.js';
import type { Store } from '../logic/store.js';

export function Welcome({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const api = window.mcprep;
  return (
    <main class="welcome">
      <h1>Math Canvas Prep</h1>
      <p class="lead">Mark the exercises, parts, context, questions and bookmarks of a PDF, then export a bundle for the Math Canvas app.</p>
      <div class="button-row big">
        <button class="text-button primary big" onClick={() => void api.chooseAndOpenPdf().then((outcome) => store.open(outcome))}>
          Open a PDF
        </button>
        <button class="text-button big" onClick={() => void api.chooseAndOpenProject().then((outcome) => store.open(outcome))}>
          Open a project
        </button>
      </div>
      <p class="muted">or drop a PDF or a project file onto the window</p>
      {state.welcomeError ? <p class="error-text" role="alert">{state.welcomeError}</p> : null}
      {state.recent.length > 0 ? (
        <section class="recent">
          <h2>Recent</h2>
          <ul>
            {state.recent.map((entry) => (
              <li key={entry.path}>
                <button class="link" onClick={() => void api.openPath(entry.path).then((outcome) => store.open(outcome))}>
                  <strong>{entry.title}</strong>
                  <span class="muted">{entry.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

export function ExportDialog({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  const { exporting, validation, project, doc } = state;
  if (!exporting.open || !project || !validation) return null;
  const index = frameIndex(project.frames);
  const counts = index.counts;
  const api = window.mcprep;
  const outcome = exporting.outcome;
  return (
    <div class="modal-backdrop" onClick={() => store.closeExport()}>
      <section class="modal" role="dialog" aria-label="Export the bundle" onClick={(event) => event.stopPropagation()}>
        <h2>Export the bundle</h2>
        <p>
          {counts.exercise} exercise{counts.exercise === 1 ? '' : 's'}, {counts.question} question{counts.question === 1 ? '' : 's'}, {counts.bookmark} bookmark{counts.bookmark === 1 ? '' : 's'}
          {' '}of "{project.meta.title}"{project.meta.folder ? ` in ${project.meta.folder}` : ''}.
        </p>
        <div class={`verdict-box ${validation.ok ? 'ok' : 'bad'}`}>
          {validation.ok ? '✓ The importer would accept this project.' : `✕ ${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}: fix them first (see Checks).`}
        </div>
        {validation.errors.length > 0 ? (
          <ul class="issue-list">
            {validation.errors.slice(0, 6).map((issue, index) => (
              <li key={index}>
                {issue.message}
                {issue.fix ? <em> {issue.fix}</em> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {validation.warnings.length > 0 ? (
          <details>
            <summary>{validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'} (they do not stop the export)</summary>
            <ul class="issue-list">
              {validation.warnings.slice(0, 8).map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <fieldset class="options">
          <legend>Contents</legend>
          {(['project', 'pdf', 'none'] as const).map((choice) => {
            const label = { project: `The project's own contents${project.outline ? ` (${project.outline.entries.length})` : ' (none yet)'}`, pdf: `The PDF's bookmarks${doc?.pdfOutline ? ` (${doc.pdfOutline.length})` : ' (none)'}`, none: 'None' }[choice];
            return (
              <label key={choice} class="radio">
                <input type="radio" name="outline" checked={exporting.outline === choice} onChange={() => store.setExportOutline(choice)} />
                <span>{label}</span>
              </label>
            );
          })}
        </fieldset>
        {state.dirty ? <p class="muted">The project has unsaved changes; it is saved first.</p> : null}
        {outcome?.ok ? (
          <div class="verdict-box ok" role="status">
            <p>✓ Wrote {outcome.path} ({outcome.bytes} bytes, {outcome.frames} frames). The importer check passed.</p>
            {outcome.issues.length > 0 ? <p class="muted">{outcome.issues.length} note{outcome.issues.length === 1 ? '' : 's'}: {outcome.issues.slice(0, 3).map((issue) => issue.message).join(' ')}</p> : null}
            <div class="button-row">
              <button class="text-button small" onClick={() => void api.reveal(outcome.path)}>Show in folder</button>
              <button class="text-button small" onClick={() => void store.copyExport()}>Copy to a folder...</button>
            </div>
            {exporting.copiedTo ? <p class="muted">Copied to {exporting.copiedTo}</p> : null}
          </div>
        ) : null}
        {outcome && !outcome.ok ? (
          <div class="verdict-box bad" role="alert">
            <p>✕ Not exported: {outcome.message}</p>
            {outcome.hint ? <p class="muted">{outcome.hint}</p> : null}
            {outcome.issues && outcome.issues.length > 0 ? (
              <ul class="issue-list">
                {outcome.issues.slice(0, 5).map((issue, index) => (
                  <li key={index}>{issue.message}{issue.fix ? <em> {issue.fix}</em> : null}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div class="button-row end">
          <button class="text-button" onClick={() => store.closeExport()}>Close</button>
          <button class="text-button primary" disabled={!validation.ok || exporting.busy} onClick={() => void store.runExport()}>
            {exporting.busy ? 'Exporting...' : 'Export...'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ConflictDialog({ store }: { store: Store }): preact.JSX.Element | null {
  const { conflict } = useStore(store);
  if (!conflict) return null;
  return (
    <div class="modal-backdrop">
      <section class="modal" role="alertdialog" aria-label="The project changed on disk">
        <h2>The project changed on disk</h2>
        <p>
          {conflict.by ?? 'Another program'} saved a new version of the project while you have unsaved edits. Which should be kept?
        </p>
        <div class="button-row end">
          <button class="text-button" onClick={() => store.resolveConflict('theirs')}>Take their version (lose my edits)</button>
          <button class="text-button primary" onClick={() => store.resolveConflict('mine')}>Keep mine (save over theirs)</button>
        </div>
      </section>
    </div>
  );
}

export function Notices({ store }: { store: Store }): preact.JSX.Element | null {
  const { notice } = useStore(store);
  if (!notice) return null;
  return (
    <div class={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.kind === 'agent' ? '● ' : ''}{notice.text}</span>
      <button class="toast-close" aria-label="Dismiss" onClick={() => store.dismissNotice()}>×</button>
    </div>
  );
}

export function StatusBar({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const index = frameIndex(state.project?.frames ?? []);
  const counts = index.counts;
  const recentAgent = Date.now() - state.agentAt < 20_000;
  return (
    <footer class="statusbar">
      <span>{state.project?.meta.title}</span>
      <span class="muted">
        {counts.exercise} exercises · {counts.question} questions · {counts.bookmark} bookmarks
        {index.book.length > 0 ? ` · ${index.book.length} book exercises` : ''}
      </span>
      <span class={`save-state ${state.saveError ? 'bad' : state.dirty ? 'dirty' : 'clean'}`}>
        {state.saveError ? `Save failed: ${state.saveError}` : state.saving ? 'Saving...' : state.dirty ? 'Unsaved changes' : 'Saved'}
      </span>
      {recentAgent ? <span class="agent-dot" title="Updated by another program">● updated by an agent</span> : null}
      <span class="spacer" />
      <span class="muted path" title={state.doc?.projectPath}>{state.doc?.projectPath}</span>
    </footer>
  );
}
