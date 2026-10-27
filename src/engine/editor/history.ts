/**
 * Snapshot undo / redo for a build. States are stored as JSON, so a snapshot
 * can never alias live data. `track` records only edits that changed something.
 */
export class History<T> {
  private past: string[] = [];
  private future: string[] = [];
  constructor(readonly limit = 100) {}

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get size(): number { return this.past.length; }

  /** Run `edit` (which mutates `state`); keep an undo step if the state changed. */
  track(state: T, edit: () => void): boolean {
    const before = JSON.stringify(state);
    edit();
    if (JSON.stringify(state) === before) return false;
    this.push(before);
    return true;
  }

  /** Record `before` as an undo step (for edits applied outside `track`). */
  push(before: string | T): void {
    this.past.push(typeof before === 'string' ? before : JSON.stringify(before));
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  undo(current: T): T | null {
    const s = this.past.pop();
    if (s === undefined) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(s) as T;
  }

  redo(current: T): T | null {
    const s = this.future.pop();
    if (s === undefined) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(s) as T;
  }

  clear(): void { this.past.length = 0; this.future.length = 0; }
}

/** Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. */
export function undoKey(code: string, e: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
  if (code === 'KeyY') return 'redo';
  return null;
}
