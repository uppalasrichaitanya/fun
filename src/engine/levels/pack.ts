import { validate, type Schema } from './schema';

/** One chapter file: `levels/<n>-<slug>.json`. */
export interface ChapterFile<L> { title: string; levels: L[] }

export interface Level<L> {
  /** Stable id used for saves: "<chapter>-<n>", both 1-based. */
  id: string;
  ch: number;
  n: number;
  chapter: string;
  /** Position in the whole pack (0-based). */
  index: number;
  def: L;
}

export interface Pack<L> {
  game: string;
  levels: Level<L>[];
  chapters: { title: string; levels: Level<L>[] }[];
  errors: string[];
  get(id: string | undefined): Level<L> | undefined;
  next(id: string): Level<L> | undefined;
}

/**
 * Build a level pack from chapter files keyed by path (from `import.meta.glob`
 * in the game, or from `fs` in scripts). Files are ordered by name; every
 * level is validated and problems are collected in `errors` (and logged in dev).
 */
export function loadPack<L>(game: string, files: Record<string, ChapterFile<L>>, schema: Schema, lint?: (l: L) => string[]): Pack<L> {
  const errors: string[] = [];
  const chapters: Pack<L>['chapters'] = [];
  const levels: Level<L>[] = [];
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  names.forEach((name, ci) => {
    const file = files[name];
    const ch = { title: file?.title ?? `Chapter ${ci + 1}`, levels: [] as Level<L>[] };
    if (!file || !Array.isArray(file.levels)) { errors.push(`${game}/${name}: no "levels" array`); return; }
    file.levels.forEach((def, li) => {
      const id = `${ci + 1}-${li + 1}`;
      for (const e of validate(def, schema, `${game} ${id}`)) errors.push(e);
      if (lint) for (const e of lint(def)) errors.push(`${game} ${id}: ${e}`);
      const lv: Level<L> = { id, ch: ci + 1, n: li + 1, chapter: ch.title, index: levels.length, def };
      levels.push(lv); ch.levels.push(lv);
    });
    chapters.push(ch);
  });
  if (errors.length && isDev()) console.error(`[levels] ${game}: ${errors.length} problem(s)\n` + errors.join('\n'));
  return {
    game, levels, chapters, errors,
    get: (id) => levels.find((l) => l.id === id),
    next: (id) => { const i = levels.findIndex((l) => l.id === id); return i >= 0 ? levels[i + 1] : undefined; },
  };
}

function isDev(): boolean {
  try { return !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV; } catch { return false; }
}

/** Level ids for a chapter manifest, in order. */
export function levelIds(chapters: readonly { count: number }[]): string[] {
  return chapters.flatMap((c, ci) => Array.from({ length: c.count }, (_, i) => `${ci + 1}-${i + 1}`));
}
