import { useStore } from '../hooks.js';
import { frameIndex } from '../logic/model.js';
import type { Store } from '../logic/store.js';

export function Welcome({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const api = window.mcprep;
  return (
    <main class="welcome">
      <h1>Math Canvas Prep</h1>
      <p class="lead">Mark the exercises, parts, context, questions and bookmarks of a PDF, or audit a whole book with its printed numbers, sections and solutions, then export a bundle for the Math Canvas app.</p>
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
