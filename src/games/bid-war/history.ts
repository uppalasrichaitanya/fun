import { storage } from '../../engine/storage';
import { HISTORY_MAX } from './config';
import type { MatchSettings, PackId } from './types';

// Versioned keys: a site update that changes these shapes bumps the suffix instead of misreading old saves.
const K = {
  names: 'bid-war:names',
  settings: 'bid-war:settings:v1',
  history: 'bid-war:history',
  played: 'bid-war:played',
};

export interface MatchRecord {
  id: string;
  date: number;
  pack: PackId;
  squadSize: number;
  names: [string, string];
  /** Index into `names`, or null for a dead heat. */
  winner: 0 | 1 | null;
  totals: [number, number];
  /** How the winner was decided. */
  via: 'auto' | 'vote';
  code: string;
}

export const savedNames = (): [string, string] => storage.get<[string, string]>(K.names, ['Player 1', 'Player 2']);
export const saveNames = (n: [string, string]): void => storage.set(K.names, n);

export const savedSettings = (): Partial<MatchSettings> => storage.get<Partial<MatchSettings>>(K.settings, {});
export const saveSettings = (s: MatchSettings): void => storage.set(K.settings, s);

export const history = (): MatchRecord[] => storage.get<MatchRecord[]>(K.history, []);

const norm = (n: string) => n.trim().toLowerCase();

/** Matches played per (normalised) name. */
export function playedBy(name: string): number {
  return storage.get<Record<string, number>>(K.played, {})[norm(name)] ?? 0;
}

/** Insert or update (same id) a finished match. Counts plays once per match. */
export function recordMatch(r: MatchRecord): void {
  const all = history();
  const i = all.findIndex((x) => x.id === r.id);
  if (i >= 0) all[i] = r;
  else {
    all.unshift(r);
    const played = storage.get<Record<string, number>>(K.played, {});
    for (const n of r.names) played[norm(n)] = (played[norm(n)] ?? 0) + 1;
    storage.set(K.played, played);
  }
  storage.set(K.history, all.slice(0, HISTORY_MAX));
}

/** Wins for each of the two names across stored history, in the order given. */
export function headToHead(a: string, b: string): [number, number] | null {
  const na = norm(a), nb = norm(b);
  if (!na || !nb || na === nb) return null;
  let wa = 0, wb = 0, games = 0;
  for (const r of history()) {
    const [x, y] = r.names.map(norm);
    if (!((x === na && y === nb) || (x === nb && y === na))) continue;
    games++;
    if (r.winner === null) continue;
    const w = norm(r.names[r.winner]);
    if (w === na) wa++; else wb++;
  }
  return games ? [wa, wb] : null;
}
