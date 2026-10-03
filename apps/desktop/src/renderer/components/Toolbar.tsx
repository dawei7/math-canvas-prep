import { useState } from 'preact/hooks';
import { useOutsideClick, useStore } from '../hooks.js';
import type { Store, Tool } from '../logic/store.js';

interface ToolSpec {
  tool: Tool;
  symbol: string;
  label: string;
  info: string;
  color: string;
  key: string;
}

export const TOOLS: ToolSpec[] = [
  { tool: 'select', symbol: '⬚', label: 'Select', info: 'Click a frame to select it. Drag to move it, drag a handle to resize it.', color: '#475569', key: 'V' },
  { tool: 'exercise', symbol: '✏', label: 'Exercise', info: 'Drag around one exercise. Click a line for a one-line frame.', color: '#4f46e5', key: 'E' },
  { tool: 'parts', symbol: '▤', label: 'Parts', info: 'Drag around an exercise with parts: slicers cut it. Click a frame to cut it.', color: '#4f46e5', key: 'P' },
  { tool: 'context', symbol: '📄', label: 'Context', info: 'Select an exercise, then drag around its instruction.', color: '#64748b', key: 'C' },
  { tool: 'continues', symbol: '↪', label: 'Continue', info: 'Select a frame, then drag where it goes on (next column or page).', color: '#4f46e5', key: 'N' },
  { tool: 'question', symbol: '?', label: 'Question', info: 'Drag around what you want to ask the tutor about.', color: '#0d9488', key: 'Q' },
  { tool: 'bookmark', symbol: '🔖', label: 'Bookmark', info: 'Drag around a definition or theorem to keep.', color: '#7c3aed', key: 'B' },
];

/** A small round "i" that shows a short explanation next to it. */
export function Info({ text, label }: { text: string; label: string }): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  useOutsideClick(open, () => setOpen(false));
  return (
    <span class="info-wrap">
      <button
        class="info"
        aria-label={`About ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        i
      </button>
      {open ? <span class="info-pop" role="tooltip">{text}</span> : null}
    </span>
  );
}

export function ToolRail({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const selected = store.selected();
  return (
    <nav class="rail" aria-label="Tools">
      {TOOLS.map((spec) => (
        <div class="tool" key={spec.tool}>
          <button
            class={`round ${state.tool === spec.tool ? 'active' : ''}`}
            style={{ '--tool': spec.color } as never}
            title={`${spec.label} (${spec.key})`}
            aria-pressed={state.tool === spec.tool}
            onClick={() => store.setTool(spec.tool)}
          >
            {spec.symbol}
          </button>
          <span class="tool-label">{spec.label}</span>
          <Info text={spec.info} label={spec.label} />
        </div>
      ))}
      <div class="tool">
        <button
          class="round danger"
          title="Delete the selected frame (Delete)"
          disabled={!selected}
          onClick={() => {
            if (selected) store.apply([selected.unit !== undefined ? { op: 'delete', unit: selected.unit } : { op: 'delete', id: selected.id }], { select: null });
          }}
        >
          🗑
        </button>
        <span class="tool-label">Delete</span>
        <Info text="Deletes the selected frame (an exercise with parts goes as a whole)." label="Delete" />
      </div>
    </nav>
  );
}

export function TopBar({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const pages = state.doc?.pageSizes.length ?? 0;
  const [typed, setTyped] = useState<string | null>(null);
  const zoomLabel = state.zoom === 0 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
  const api = window.mcprep;
  return (
    <header class="topbar">
      <div class="group">
        <button class="text-button" onClick={() => void api.chooseAndOpenPdf().then((outcome) => store.open(outcome))}>
          Open PDF
        </button>
        <button class="text-button" onClick={() => void api.chooseAndOpenProject().then((outcome) => store.open(outcome))}>
          Open project
        </button>
      </div>
      <div class="group">
        <button class="text-button primary" disabled={!state.dirty || state.saving} onClick={() => void store.save()} title="Save (Ctrl+S)">
          {state.saving ? 'Saving...' : 'Save'}
        </button>
        <button class="text-button" disabled={!state.project} onClick={() => store.openExport()} title="Export the bundle (Ctrl+E)">
          Export
        </button>
      </div>
      <div class="group">
        <button class="square" disabled={state.past.length === 0} onClick={() => store.undo()} title="Undo (Ctrl+Z)" aria-label="Undo">
          ↶
        </button>
        <button class="square" disabled={state.future.length === 0} onClick={() => store.redo()} title="Redo (Ctrl+Y)" aria-label="Redo">
          ↷
        </button>
      </div>
      <div class="group pager">
        <button class="square" disabled={state.page <= 0} onClick={() => store.setPage(state.page - 1)} aria-label="Previous page" title="Previous page (←)">
          ‹
        </button>
        <input
          class="page-input"
          aria-label="Page number"
          value={typed ?? String(state.page + 1)}
          onFocus={() => setTyped(String(state.page + 1))}
          onInput={(event) => setTyped((event.target as HTMLInputElement).value)}
          onBlur={() => setTyped(null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const number = Number.parseInt(typed ?? '', 10);
              if (Number.isFinite(number)) store.setPage(number - 1);
              setTyped(null);
              (event.target as HTMLInputElement).blur();
            }
            event.stopPropagation();
          }}
        />
        <span class="of">/ {pages}</span>
        <button class="square" disabled={state.page >= pages - 1} onClick={() => store.setPage(state.page + 1)} aria-label="Next page" title="Next page (→)">
          ›
        </button>
      </div>
      <div class="group">
        <button class="square" onClick={() => store.setZoom((state.zoom || 1) / 1.2)} aria-label="Zoom out" title="Zoom out (-)">
          −
        </button>
        <button class="text-button zoom" onClick={() => store.setZoom(0)} title="Fit the width (0)">
          {zoomLabel}
        </button>
        <button class="square" onClick={() => store.setZoom((state.zoom || 1) * 1.2)} aria-label="Zoom in" title="Zoom in (+)">
          +
        </button>
      </div>
      <div class="group toggles">
        <label class="toggle" title="Edges snap to lines of text (S)">
          <input type="checkbox" checked={state.snap} onChange={(event) => store.setSnap((event.target as HTMLInputElement).checked)} />
          <span>Snap</span>
        </label>
        <label class="toggle" title="Save a moment after every change">
          <input type="checkbox" checked={state.autosave} onChange={(event) => store.setAutosave((event.target as HTMLInputElement).checked)} />
          <span>Autosave</span>
        </label>
        <button
          class="square"
          onClick={() => store.setTheme(state.theme === 'system' ? 'dark' : state.theme === 'dark' ? 'light' : 'system')}
          title={`Theme: ${state.theme} (click to change)`}
          aria-label="Theme"
        >
          {state.theme === 'dark' ? '🌙' : state.theme === 'light' ? '☀' : '◐'}
        </button>
      </div>
    </header>
  );
}
