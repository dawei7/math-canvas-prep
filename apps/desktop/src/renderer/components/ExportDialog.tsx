import { useStore } from '../hooks.js';
import { guiFix } from '../logic/errors.js';
import { FEATURE_TEXT, exportFacts, percent } from '../logic/export.js';
import { frameIndex } from '../logic/model.js';
import type { Store } from '../logic/store.js';

const featureName = (feature: string): string => FEATURE_TEXT[feature as keyof typeof FEATURE_TEXT]?.name ?? feature;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * What is about to be written, said before it is: which optional parts of the format the bundle uses (sections, book
 * exercises, hidden solutions), what it contains (what a person framed, the book exercises per section and how many have a
 * solution), the warnings, and after the export the result of the importer check. Next to the bundle, the plain JSON summary
 * of the book can be written for other programs.
 */
export function ExportDialog({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  const { exporting, validation, project, doc } = state;
  if (!exporting.open || !project || !validation) return null;
  const index = frameIndex(project.frames);
  const model = store.book();
  const facts = exportFacts(project, exporting.outline, doc?.pdfOutline ?? null, index, model);
  const api = window.mcprep;
  const outcome = exporting.outcome;
  const summary = exporting.summary;
  const book = facts.book.exercises > 0;
  const ordinary = facts.ordinary.exercises + facts.ordinary.questions + facts.ordinary.bookmarks;
  return (
    <div class="modal-backdrop" onClick={() => store.closeExport()}>
      <section class="modal export-dialog" role="dialog" aria-label="Export the bundle" onClick={(event) => event.stopPropagation()}>
        <h2>Export the bundle</h2>
        <p class="export-title">
          <strong>{project.meta.title}</strong>
          {project.meta.folder ? <span class="muted"> in {project.meta.folder}</span> : null}
        </p>
        <dl class="facts">
          <dt>Framed by you</dt>
          <dd>
            {plural(facts.ordinary.exercises, 'exercise')}, {plural(facts.ordinary.questions, 'question')}, {plural(facts.ordinary.bookmarks, 'bookmark')}
            {ordinary === 0 ? <span class="muted"> (none)</span> : null}
          </dd>
          <dt>Book exercises</dt>
          <dd>
            {book ? (
              <>
                {facts.book.exercises} in {plural(facts.book.sectionsWithExercises, 'section')}: {facts.book.withSolution} with a solution ({percent(facts.book.withSolution, facts.book.exercises)}), {facts.book.withoutSolution} without
                {facts.book.unfiled > 0 ? <span class="bad-text"> · {facts.book.unfiled} filed under a section that does not exist</span> : null}
              </>
            ) : (
              <span class="muted">none</span>
            )}
          </dd>
          <dt>Uses</dt>
          <dd class="features">
            {facts.features.length === 0 ? <span class="muted">none of the optional parts of the format: a plain bundle</span> : null}
            {facts.features.map((feature) => (
              <span key={feature} class={`feature feature-${feature}`} title={FEATURE_TEXT[feature].text}>
                {FEATURE_TEXT[feature].name}
              </span>
            ))}
          </dd>
        </dl>
        {facts.sections.length > 0 ? (
          <details class="per-section" open>
            <summary>{plural(facts.sections.length, 'section')} with book exercises</summary>
            <table class="section-table" aria-label="Book exercises per section">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Exercises</th>
                  <th>With solution</th>
                </tr>
              </thead>
              <tbody>
                {facts.sections.map((row) => (
                  <tr key={row.index}>
                    <td style={{ paddingLeft: `${6 + Math.min(row.depth, 5) * 12}px` }}>{row.label !== undefined && !row.title.toLowerCase().startsWith(row.label.toLowerCase()) ? `${row.label} ${row.title}` : row.title}</td>
                    <td class="num">{row.own === row.total ? row.own : `${row.own} (${row.total})`}</td>
                    <td class={`num ${row.totalSolved === row.total ? 'ok-text' : 'warn-text'}`}>
                      {row.totalSolved}/{row.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
        <div class={`verdict-box ${validation.ok ? 'ok' : 'bad'}`}>
          {validation.ok ? '✓ The importer would accept this project.' : `✕ ${plural(validation.errors.length, 'error')}: fix them first (see Checks).`}
        </div>
        {validation.errors.length > 0 ? (
          <ul class="issue-list">
            {validation.errors.slice(0, 6).map((issue, at) => (
              <li key={at}>
                {issue.message}
                {guiFix(issue) ? <em> {guiFix(issue)}</em> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {validation.warnings.length > 0 ? (
          <details>
            <summary>{plural(validation.warnings.length, 'warning')} (they do not stop the export)</summary>
            <ul class="issue-list">
              {validation.warnings.slice(0, 8).map((issue, at) => (
                <li key={at}>{issue.message}</li>
              ))}
              {validation.warnings.length > 8 ? <li class="muted">and {validation.warnings.length - 8} more (see Checks)</li> : null}
            </ul>
          </details>
        ) : null}
        <fieldset class="options">
          <legend>Contents</legend>
          {(['project', 'pdf', 'none'] as const).map((choice) => {
            const label = { project: `The project's own contents${project.outline ? ` (${project.outline.entries.length})` : ' (none yet)'}`, pdf: `The PDF's bookmarks${doc?.pdfOutline ? ` (${doc.pdfOutline.length})` : ' (none)'}`, none: 'None' }[choice];
            const locked = book && choice !== 'project';
            return (
              <label key={choice} class="radio">
                <input type="radio" name="outline" checked={exporting.outline === choice} disabled={locked} onChange={() => store.setExportOutline(choice)} />
                <span>{label}</span>
              </label>
            );
          })}
          {book ? <p class="muted pad">Book exercises are filed under the sections of the project's own contents, so the bundle carries those.</p> : null}
        </fieldset>
        {state.dirty ? <p class="muted">The project has unsaved changes; it is saved first.</p> : null}
        {outcome?.ok ? (
          <div class="verdict-box ok" role="status">
            <p>✓ Wrote {outcome.path} ({outcome.bytes} bytes, {plural(outcome.frames, 'frame')}).</p>
            <p class="importer-check">
              The importer check passed: the app would import {plural(outcome.check.frames, 'frame')} and {plural(outcome.check.outlineEntries, 'contents entry', 'contents entries')}
              {outcome.check.features.length > 0 ? `, using ${outcome.check.features.map(featureName).join(', ')}` : ''}
              {outcome.check.repairs > 0 ? `; ${plural(outcome.check.repairs, 'thing')} repaired as it reads` : ''}
              {outcome.check.warnings > 0 ? `; ${plural(outcome.check.warnings, 'warning')}` : ''}.
            </p>
            {outcome.check.steps.length > 0 ? (
              <details>
                <summary>The steps of the importer</summary>
                <ol class="steps">
                  {outcome.check.steps.map((step) => (
                    <li key={step.step}>
                      <strong>{step.name}</strong> <span class="muted">{step.status}</span>: {step.detail}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {outcome.issues.length > 0 ? <p class="muted">{plural(outcome.issues.length, 'note')}: {outcome.issues.slice(0, 3).map((issue) => issue.message).join(' ')}</p> : null}
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
                {outcome.issues.slice(0, 5).map((issue, at) => (
                  <li key={at}>
                    {issue.message}
                    {issue.fix ? <em> {issue.fix}</em> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {summary?.ok ? (
          <div class="verdict-box ok summary-result">
            <p>
              ✓ Wrote the book summary {summary.path} ({summary.bytes} bytes): {plural(summary.sections, 'section')}, {plural(summary.exercises, 'book exercise')}.
            </p>
            <div class="button-row">
              <button class="text-button small" onClick={() => void api.reveal(summary.path)}>Show in folder</button>
            </div>
          </div>
        ) : null}
        {summary && !summary.ok ? (
          <div class="verdict-box bad summary-result" role="alert">
            <p>✕ The book summary was not written: {summary.message}</p>
          </div>
        ) : null}
        <div class="button-row end">
          <button class="text-button" onClick={() => store.closeExport()}>Close</button>
          <button
            class="text-button"
            disabled={exporting.summaryBusy || exporting.busy}
            title="The sections of the book with the number of book exercises and solutions in each, as a plain JSON file for other programs"
            onClick={() => void store.exportBookSummary()}
          >
            {exporting.summaryBusy ? 'Writing...' : 'Export book summary (JSON)...'}
          </button>
          <button class="text-button primary" disabled={!validation.ok || exporting.busy} onClick={() => void store.runExport()}>
            {exporting.busy ? 'Exporting...' : 'Export bundle...'}
          </button>
        </div>
      </section>
    </div>
  );
}
