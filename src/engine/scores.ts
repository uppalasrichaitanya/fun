import { storage } from './storage';

export interface ScoreInfo { best: number | null; plays: number; last: number[] }

export function getScores(id: string): ScoreInfo {
  return {
    best: storage.get<number | null>(`${id}:best`, null),
    plays: storage.get<number>(`${id}:plays`, 0),
    last: storage.get<number[]>(`${id}:last`, []),
  };
}

/** Records a finished run. Higher is better for every game. */
export function recordScore(id: string, score: number): { best: number; isNewBest: boolean; plays: number } {
  const s = getScores(id);
  const beats = s.best === null || score > s.best;
  const best = beats ? score : (s.best as number);
  const plays = s.plays + 1;
  storage.set(`${id}:best`, best);
  storage.set(`${id}:plays`, plays);
  storage.set(`${id}:last`, [score, ...s.last].slice(0, 5));
  // The very first run is not celebrated as a "new best"; beating a real record is.
  return { best, isNewBest: beats && s.best !== null, plays };
}
