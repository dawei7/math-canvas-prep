import { isAuthoritative } from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { frameIndex, labelOf } from '../logic/model.js';
import type { Store } from '../logic/store.js';

/**
 * A line above the page that says what the tool in use will do and, for the tools that attach something to the selected
 * exercise (context, solution, continuation), which exercise that is: the page shown may be the answer key, far from it.
 */
export function ToolHint({ store }: { store: Store }): preact.JSX.Element | null {
  const state = useStore(store);
  const project = state.project;
  if (!project) return null;
  const index = frameIndex(project.frames);
  const selected = state.selection === null ? undefined : index.byId.get(state.selection);
  const exercise = selected !== undefined && selected.kind === 'exercise' ? selected : undefined;
  const name = exercise ? labelOf(index, exercise) : undefined;
  const target =
    exercise !== undefined && name !== undefined ? (
      <>
        <span class={`hint-chip ${isAuthoritative(exercise) ? 'book' : ''}`}>{name}</span>
        {isAuthoritative(exercise) && exercise.section !== undefined ? <span class="muted"> in section {exercise.section}</span> : null}
      </>
    ) : null;
  const showExercise =
    exercise !== undefined ? (
      <button class="text-button small" onClick={() => store.select(exercise.id, { jump: true })}>
        Show the exercise
      </button>
    ) : null;

  if (state.picking !== null) {
    const entry = state.project?.outline?.entries[state.picking];
    return (
      <div class="tool-hint tool-hint-pick" role="status">
        <span>
          Click the heading of <strong>{entry?.title ?? 'the section'}</strong> on its page: it starts at the line you click.
        </span>
        <button class="text-button small" onClick={() => store.pickHeading(null)}>
          Cancel
        </button>
      </div>
    );
  }
  switch (state.tool) {
    case 'book':
      return (
        <div class="tool-hint tool-hint-book" role="status">
          <span>
            <strong>Book exercise.</strong> Drag around one printed exercise, or click its first line. Then give the number the book prints for it and its section. It is a single exercise: the parts 5a and 5b are two exercises.
          </span>
        </div>
      );
    case 'context':
      return (
        <div class="tool-hint tool-hint-context" role="status">
          {target ? (
            <span>
              <strong>Context</strong> for {target}: drag around the instruction the learner is shown with it, on any page.
            </span>
          ) : (
            <span>
              <strong>Context.</strong> Select an exercise first (click it), then drag around its instruction.
            </span>
          )}
          {showExercise}
        </div>
      );
    case 'solution':
      return (
        <div class="tool-hint tool-hint-solution" role="status">
          {target ? (
            <span>
              <strong>Solution</strong> for {target}: go to the answer key (any page of this PDF) and drag around its answer. It is <strong>hidden from the learner</strong> and only used to grade.
            </span>
          ) : (
            <span>
              <strong>Solution.</strong> Select an exercise first (click it), go to the answer key, then drag around its answer. It is hidden from the learner.
            </span>
          )}
          {showExercise}
        </div>
      );
    case 'continues':
      return (
        <div class="tool-hint tool-hint-continues" role="status">
          {selected !== undefined ? (
            <span>
              <strong>Continuation</strong> of <span class="hint-chip">{labelOf(index, selected)}</span>: drag where it goes on (the next column or page).
            </span>
          ) : (
            <span>
              <strong>Continue.</strong> Select a frame first (click it), then drag where it goes on.
            </span>
          )}
        </div>
      );
    default:
      return null;
  }
}
