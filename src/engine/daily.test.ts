import { beforeEach, describe, expect, it } from 'vitest';
import { dailyGames, dailyNumber, dailyResults, dailySeed, dateKey, recordDaily, streak } from './daily';

// Minimal localStorage for the storage wrapper.
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; },
  },
};

describe('daily challenge', () => {
  beforeEach(() => mem.clear());

  it('same date, same games and seeds; each game appears every few days', () => {
    expect(dailyGames('2026-10-27')).toEqual(dailyGames('2026-10-27'));
    expect(dailySeed('stack', '2026-10-27')).toBe(dailySeed('stack', '2026-10-27'));
    expect(dailySeed('stack', '2026-10-27')).not.toBe(dailySeed('stack', '2026-10-28'));
    const seen = new Map<string, number[]>();
    for (let d = 1; d <= 30; d++) {
      const key = `2026-11-${String(d).padStart(2, '0')}`;
      const g = dailyGames(key);
      expect(new Set(g).size).toBe(3);
      g.forEach((id) => seen.set(id, [...(seen.get(id) ?? []), d]));
    }
    expect(seen.size).toBe(10);
    for (const days of seen.values()) for (let i = 1; i < days.length; i++) expect(days[i] - days[i - 1]).toBeLessThanOrEqual(4);
  });

  it('numbers days from 1 Jan 2026', () => {
    expect(dailyNumber('2026-01-01')).toBe(1);
    expect(dailyNumber('2026-02-01')).toBe(32);
  });

  it('the first completed attempt is official; later ones are practice', () => {
    expect(recordDaily('stack', 37, '37', '2026-10-27').official).toBe(true);
    const again = recordDaily('stack', 80, '80', '2026-10-27');
    expect(again.official).toBe(false);
    expect(dailyResults('2026-10-27').stack.label).toBe('37');
  });

  it('streak counts consecutive days with an official attempt', () => {
    recordDaily('stack', 1, '1', '2026-10-25');
    recordDaily('circle', 1, '1', '2026-10-26');
    recordDaily('stack', 1, '1', '2026-10-27');
    expect(streak('2026-10-27')).toBe(3);
    expect(streak('2026-10-28')).toBe(3);   // still alive until the day ends
    expect(streak('2026-10-30')).toBe(0);
    recordDaily('stack', 1, '1', '2026-10-30');
    expect(streak('2026-10-30')).toBe(1);
  });

  it('dateKey is local YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
