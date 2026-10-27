import { loadPack, type ChapterFile } from '../engine/levels/pack';
import type { Verifier } from '../engine/levels/verify';
import { BRAIN_CHAPTERS } from './brain-lab';
import { verifier as lightBender } from './light-bender/verify';
import { verifier as mazeMaker } from './maze-maker/verify';
import { verifier as wireIt } from './wire-it/verify';

// Every Brain Lab game's headless verifier. Used by `npm run verify-levels` and the unit tests.
export const VERIFIERS: Verifier<unknown>[] = [
  lightBender as Verifier<unknown>,
  mazeMaker as Verifier<unknown>,
  wireIt as Verifier<unknown>,
];

export interface LevelReport { game: string; id: string; name: string; solved: boolean; stars: number; deterministic: boolean; note?: string }
export interface VerifyReport { levels: LevelReport[]; errors: string[] }

/**
 * Load each game's level files (via `readFiles(game)`), validate them, check
 * the chapter manifest, and run every stored solution 3 times comparing hashes.
 */
export function verifyAll(readFiles: (game: string) => Record<string, ChapterFile<unknown>>): VerifyReport {
  const levels: LevelReport[] = [];
  const errors: string[] = [];
  for (const v of VERIFIERS) {
    const pack = loadPack(v.game, readFiles(v.game), v.schema, v.lint);
    errors.push(...pack.errors);
    const manifest = BRAIN_CHAPTERS[v.game] ?? [];
    if (manifest.length !== pack.chapters.length) errors.push(`${v.game}: manifest has ${manifest.length} chapters, files have ${pack.chapters.length}`);
    manifest.forEach((m, i) => {
      const ch = pack.chapters[i];
      if (ch && ch.levels.length !== m.count) errors.push(`${v.game}: chapter ${i + 1} manifest says ${m.count} levels, file has ${ch.levels.length}`);
      if (ch && ch.title !== m.title) errors.push(`${v.game}: chapter ${i + 1} title "${ch.title}" vs manifest "${m.title}"`);
    });
    for (const lv of pack.levels) {
      let first: ReturnType<Verifier<unknown>['run']> | null = null;
      let deterministic = true;
      for (let k = 0; k < 3; k++) {
        const r = v.run(structuredClone(lv.def));
        if (!first) first = r; else if (r.hash !== first.hash) deterministic = false;
      }
      const name = (lv.def as { name?: string }).name ?? '';
      levels.push({ game: v.game, id: lv.id, name, solved: first!.solved, stars: first!.stars, deterministic, note: first!.note });
      if (!first!.solved) errors.push(`${v.game} ${lv.id} "${name}": stored solution does not solve the level${first!.note ? ` (${first!.note})` : ''}`);
      if (!deterministic) errors.push(`${v.game} ${lv.id} "${name}": not deterministic (hashes differ across 3 runs)`);
    }
  }
  return { levels, errors };
}
