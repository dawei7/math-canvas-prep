import type { AuditProgress } from '../../shared/api.js';

/**
 * How far the long job in the main process is (reading the pages of a book). It is kept outside the editor's state: it
 * changes about ten times a second, and only the bar that shows it should redraw for that.
 */
export class Progress {
  value: AuditProgress | null = null;
  private readonly listeners = new Set<() => void>();

  set(value: AuditProgress | null): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
