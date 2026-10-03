import { useEffect, useState } from 'preact/hooks';
import type { State, Store } from './logic/store.js';

/** The store's state; the component renders again whenever anything in it changes. */
export function useStore(store: Store): State {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store]);
  return store.state;
}

/** Calls `handler` for clicks outside the element (to close a popover). */
export function useOutsideClick(active: boolean, handler: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    const listener = (): void => handler();
    // Next tick, so that the click that opened the popover does not close it at once.
    const id = setTimeout(() => document.addEventListener('click', listener), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', listener);
    };
  }, [active, handler]);
}
