import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../hooks.js';
import type { Store, Tool } from '../logic/store.js';
import { loadPdf } from '../pdf.js';
import { ConflictDialog, Notices, StatusBar, Welcome } from './Dialogs.js';
import { ExportDialog } from './ExportDialog.js';
import { InfoDialog } from './InfoDialog.js';
import { PageView } from './PageView.js';
import { SidePanel } from './Panels.js';
import { Thumbnails } from './Thumbnails.js';
import { ToolRail, TopBar } from './Toolbar.js';

const KEY_TOOLS: Record<string, Tool> = { v: 'select', e: 'exercise', a: 'book', p: 'parts', c: 'context', l: 'solution', n: 'continues', q: 'question', b: 'bookmark' };

export function App({ store }: { store: Store }): preact.JSX.Element {
  const state = useStore(store);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [dropping, setDropping] = useState(false);
  const api = window.mcprep;

  // Load the PDF into the page viewer whenever another document is opened.
  useEffect(() => {
    if (!state.doc) {
      setPdf(null);
      return undefined;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | undefined;
    void api
      .readPdf()
      .then((bytes) => loadPdf(bytes))
      .then((document) => {
        if (cancelled) return document.destroy();
        loaded = document;
        setPdf(document);
        return undefined;
      })
      .catch((error: unknown) => store.notify('error', `Cannot display the PDF: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [state.doc?.projectPath, state.doc?.pdfPath]);

  // The theme, on the root element.
  useEffect(() => {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // Menu commands and changes made on disk by another program.
  useEffect(() => {
    const offMenu = api.onMenu((command) => {
      if (command === 'open-pdf') void api.chooseAndOpenPdf().then((outcome) => store.open(outcome));
      else if (command === 'open-project') void api.chooseAndOpenProject().then((outcome) => store.open(outcome));
      else if (command.startsWith('open-path:')) void api.openPath(command.slice('open-path:'.length)).then((outcome) => store.open(outcome));
      else if (command === 'save') void store.save();
      else if (command === 'export') store.openExport();
      else if (command === 'undo') store.undo();
      else if (command === 'redo') store.redo();
      else if (command === 'zoom-in') store.setZoom((store.state.zoom || 1) * 1.2);
      else if (command === 'zoom-out') store.setZoom((store.state.zoom || 1) / 1.2);
      else if (command === 'zoom-fit') store.setZoom(0);
      else if (command === 'theme') store.setTheme(store.state.theme === 'dark' ? 'light' : 'dark');
    });
    const offDisk = api.onDiskChange((change) => store.onDiskChange(change));
    const offProgress = api.onProgress((progress) => store.reportProgress(progress));
    void store.loadRecent();
    api.ready();
    return () => {
      offMenu();
      offDisk();
      offProgress();
    };
  }, [store]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (!store.state.project) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
      } else if (mod && key === 'y') {
        event.preventDefault();
        store.redo();
      } else if (mod && key === 's') {
        event.preventDefault();
        void store.save();
      } else if (mod && key === 'e') {
        event.preventDefault();
        store.openExport();
      } else if (!mod && (key === 'delete' || key === 'backspace')) {
        const selected = store.selected();
        if (selected) {
          event.preventDefault();
          store.apply([selected.unit !== undefined ? { op: 'delete', unit: selected.unit } : { op: 'delete', id: selected.id }], { select: null });
        }
      } else if (!mod && key === 'escape') {
        if (store.state.exporting.open) store.closeExport();
        else if (store.state.infoOpen) store.closeInfo();
        else if (store.state.draft) store.cancelDraft();
        else if (store.state.picking !== null) store.pickHeading(null);
        else if (store.state.tool !== 'select') store.setTool('select');
        else store.select(null);
      } else if (!mod && key === 'arrowright') store.setPage(store.state.page + 1);
      else if (!mod && key === 'arrowleft') store.setPage(store.state.page - 1);
      else if (!mod && key === 'pagedown') store.setPage(store.state.page + 1);
      else if (!mod && key === 'pageup') store.setPage(store.state.page - 1);
      else if (!mod && (key === '+' || key === '=')) store.setZoom((store.state.zoom || 1) * 1.2);
      else if (!mod && key === '-') store.setZoom((store.state.zoom || 1) / 1.2);
      else if (!mod && key === '0') store.setZoom(0);
      else if (!mod && key === 's') store.setSnap(!store.state.snap);
      else if (!mod && KEY_TOOLS[key] !== undefined) store.setTool(KEY_TOOLS[key] as Tool);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  // Drag and drop of a PDF or a project file.
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    const path = api.pathForFile(file);
    if (!path) return;
    void api.openPath(path).then((outcome) => store.open(outcome));
  };

  return (
    <div
      class={`app ${dropping ? 'dropping' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {state.project && state.doc ? (
        <>
          <TopBar store={store} />
          <div class="workspace">
            <ToolRail store={store} />
            <Thumbnails store={store} pdf={pdf} />
            <PageView store={store} pdf={pdf} />
            <SidePanel store={store} />
          </div>
          <StatusBar store={store} />
        </>
      ) : (
        <Welcome store={store} />
      )}
      <ExportDialog store={store} />
      <InfoDialog store={store} />
      <ConflictDialog store={store} />
      <Notices store={store} />
      {dropping ? <div class="drop-hint">Drop a PDF or a project to open it</div> : null}
    </div>
  );
}
