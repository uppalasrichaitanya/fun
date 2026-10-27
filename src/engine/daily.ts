import { hashString, Rng } from './rng';
import { storage } from './storage';

/** Games in the daily rotation, in a fixed shuffled order; 3 per day so each returns every few days. */
const ROTATION = ['stack', 'merge-drop', 'circle', 'untangle', 'cursor-panic', 'rocket-lander', 'odd-tile', 'grapple-swing', 'tiny-survivors', 'sumo-blobs'];
const EPOCH = Date.UTC(2026, 0, 1);

export interface DailyEntry { score: number; label: string }
interface Streak { last: string; count: number }

/** Local date as YYYY-MM-DD. */
export function dateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Daily number shown in shares (#1 = 1 Jan 2026). */
export function dailyNumber(key = dateKey()): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - EPOCH) / 86_400_000) + 1;
}

export function dailyGames(key = dateKey()): string[] {
  const n = dailyNumber(key);
  const order = new Rng(hashString('pocket-arcade-rotation')).shuffle([...ROTATION]);
  const start = (((n * 3) % order.length) + order.length) % order.length;
  return [0, 1, 2].map((i) => order[(start + i) % order.length]);
}

/** Every player gets the same seed for a game on a given day. */
export function dailySeed(gameId: string, key = dateKey()): number {
  return hashString(`${key}:${gameId}`);
}

export function dailyResults(key = dateKey()): Record<string, DailyEntry> {
  return storage.get<Record<string, DailyEntry>>(`daily:${key}`, {});
}

/**
 * Record a finished daily attempt. The first completed attempt is the official
 * score; later ones are practice. Returns whether this one was official.
 */
export function recordDaily(gameId: string, score: number, label: string, key = dateKey()): { official: boolean; entry: DailyEntry } {
  const all = dailyResults(key);
  if (all[gameId]) return { official: false, entry: all[gameId] };
  all[gameId] = { score, label };
  storage.set(`daily:${key}`, all);
  bumpStreak(key);
  return { official: true, entry: all[gameId] };
}

function prevKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d - 1));
}

function bumpStreak(key: string): void {
  const s = storage.get<Streak>('daily:streak', { last: '', count: 0 });
  if (s.last === key) return;
  storage.set('daily:streak', { last: key, count: s.last === prevKey(key) ? s.count + 1 : 1 });
}

/** Consecutive days with at least one official daily attempt (still alive if the last one was yesterday). */
export function streak(key = dateKey()): number {
  const s = storage.get<Streak>('daily:streak', { last: '', count: 0 });
  return s.last === key || s.last === prevKey(key) ? s.count : 0;
}

export function dailyShareText(titles: Record<string, string>, key = dateKey()): string {
  const res = dailyResults(key);
  const parts = dailyGames(key).filter((g) => res[g]).map((g) => `${titles[g]} ${res[g].label}`);
  const st = streak(key);
  return `Pocket Arcade Daily #${dailyNumber(key)} | ${parts.join(' | ')}${st > 1 ? ` | streak ${st}` : ''}`;
}
