import { render } from 'preact';
import { App } from './components/App.js';
import { Store } from './logic/store.js';

const THEME_KEY = 'mcprep.theme';
const SNAP_KEY = 'mcprep.snap';
const AUTOSAVE_KEY = 'mcprep.autosave';

function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the preference just is not kept.
  }
}

const theme = remembered(THEME_KEY);
const store = new Store(window.mcprep, {
  theme: theme === 'light' || theme === 'dark' ? theme : 'system',
  snap: remembered(SNAP_KEY) !== 'off',
  autosave: remembered(AUTOSAVE_KEY) === 'on',
});

// Keep the person's preferences between sessions.
store.subscribe(() => {
  remember(THEME_KEY, store.state.theme);
  remember(SNAP_KEY, store.state.snap ? 'on' : 'off');
  remember(AUTOSAVE_KEY, store.state.autosave ? 'on' : 'off');
});

// For the end-to-end test and for debugging: the store is reachable from the page's console.
(window as unknown as { __store: Store }).__store = store;

const root = document.getElementById('root');
if (root) render(<App store={store} />, root);
