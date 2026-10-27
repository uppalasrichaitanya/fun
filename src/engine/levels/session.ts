import { hashString } from '../rng';
import type { GameContext, Stat } from '../types';
import type { Level, Pack } from './pack';
import { Progress } from './progress';

/** The level a run should play: the picked id, or (demo) any level, seeded. */
export function pickLevel<L>(pack: Pack<L>, mode: string | undefined, demo: boolean, seed: number, demoFrom = 0): Level<L> {
  if (demo) {
    const pool = pack.levels.slice(Math.min(demoFrom, pack.levels.length - 1));
    return pool[seed % pool.length];
  }
  return pack.get(mode) ?? pack.levels[0];
}

export interface Finish {
  /** One label per star goal, in order (e.g. ["Solved", "Par 3 pieces", "Prism gem"]). */
  goals: [string, string, string];
  /** Which goals were met. Stars = met goals counted in order (a later goal needs the earlier ones). */
  met: [boolean, boolean, boolean];
  stats: Stat[];
  delayMs?: number;
}

/** Stars from goals: 1 for solving, then each further goal in order. */
export function starsFrom(met: readonly boolean[]): number {
  let n = 0;
  for (const m of met) { if (!m) break; n++; }
  return n;
}

/**
 * Save the result and hand the solved panel to the shell: stars with their
 * goals, a Next button for the next level, and share text.
 */
export function finishLevel<L>(ctx: GameContext, pack: Pack<L>, level: Level<L>, title: string, f: Finish): number {
  const stars = starsFrom(f.met);
  const rec = new Progress(pack.game).record(level.id, stars);
  const next = pack.next(level.id);
  const starText = '★'.repeat(stars) + '☆'.repeat(3 - stars);
  ctx.shell.gameOver({
    score: stars,
    noScore: true,
    title: stars === 3 ? 'Perfect!' : 'Solved!',
    stars: { earned: stars, goals: f.goals, met: f.met, improved: rec.improved && rec.prev > 0 },
    stats: f.stats,
    next: next ? { label: 'Next level', mode: next.id } : undefined,
    share: `Pocket Arcade - ${title} ${level.chapter} ${level.n}: ${starText}`,
  }, f.delayMs ?? 900);
  return stars;
}

/** Hash of a final sim state for determinism checks. */
export const stateHash = (state: unknown): string => hashString(JSON.stringify(state)).toString(16);
