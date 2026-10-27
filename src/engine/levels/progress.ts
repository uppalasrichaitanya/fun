import { storage } from '../storage';

/** Bump when the save shape changes and add a migration below. */
export const SAVE_VERSION = 1;
const MIGRATIONS: Record<number, (game: string) => void> = {
  // 1 -> 2: (game) => { ... }
};

/**
 * Stars per level, best kept. Saved under `<game>:stars` as { "1-4": 2, ... }
 * (level ids are chapter-number pairs, so adding levels at the end of a
 * chapter never shifts saves). `<game>:save` holds the save version.
 */
export class Progress {
  constructor(readonly game: string) {
    const v = storage.get<number>(`${game}:save`, 0);
    if (v === SAVE_VERSION) return;
    for (let k = Math.max(1, v); k < SAVE_VERSION; k++) MIGRATIONS[k]?.(game);
    if (v < SAVE_VERSION) storage.set(`${game}:save`, SAVE_VERSION);
  }

  all(): Record<string, number> { return storage.get<Record<string, number>>(`${this.game}:stars`, {}); }
  stars(id: string): number { return this.all()[id] ?? 0; }
  total(): number { return Object.values(this.all()).reduce((a, b) => a + (b || 0), 0); }

  /** Save a result; returns the previous best and whether this improved it. */
  record(id: string, stars: number): { prev: number; best: number; improved: boolean } {
    const all = this.all();
    const prev = all[id] ?? 0;
    if (stars > prev) { all[id] = stars; storage.set(`${this.game}:stars`, all); }
    return { prev, best: Math.max(prev, stars), improved: stars > prev };
  }

  /**
   * The first level is always open; each later one opens when the previous
   * has a star (or, for gated levels, when its gate level has one).
   */
  unlocked(ids: readonly string[], i: number, gates: Record<string, string> = {}): boolean {
    if (i <= 0 || editorMode()) return true;
    const all = this.all();
    const need = gates[ids[i]] ?? ids[i - 1];
    return (all[need] ?? 0) >= 1 || (all[ids[i]] ?? 0) >= 1;
  }

  /** Where to put the cursor on the level select: the first open level without a star. */
  suggested(ids: readonly string[], gates: Record<string, string> = {}): string {
    const all = this.all();
    for (let i = 0; i < ids.length; i++) if (!all[ids[i]] && this.unlocked(ids, i, gates)) return ids[i];
    return ids[ids.length - 1];
  }
}

/** Dev level editor, enabled with `?editor` in the URL. Also unlocks every level. */
export function editorMode(): boolean {
  try { return /[?&]editor\b/.test(location.search) || /[?&]editor\b/.test(location.hash); } catch { return false; }
}
