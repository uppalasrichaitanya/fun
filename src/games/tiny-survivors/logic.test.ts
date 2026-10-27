import { describe, expect, it } from 'vitest';
import { Rng } from '../../engine/rng';
import { CAP, MAX_LEVEL, xpFor } from './data';
import { Survivors, SurvivorBot } from './logic';

const DT = 1 / 120;

function run(seed: number, skill: number, seconds = 300) {
  const s = new Survivors(new Rng(seed));
  s.reset();
  const bot = new SurvivorBot(s, skill);
  let maxLive = 0;
  for (let k = 0; k < 120 * seconds && !s.dead && !s.won; k++) {
    if (s.choosing) {
      // Every offered card must be valid.
      for (const c of s.choosing) if (c.kind === 'weapon' || c.kind === 'passive') expect(c.level).toBeLessThanOrEqual(MAX_LEVEL);
      s.choose(skill ? bot.pick() : 0);
    }
    const [mx, my] = skill ? bot.move(DT) : [Math.cos(k / 400), Math.sin(k / 400)];
    s.step(DT, mx, my);
    s.events.length = 0;
    maxLive = Math.max(maxLive, s.live);
  }
  return { s, maxLive };
}

describe('Tiny Survivors', () => {
  it('level n needs 5 + 6(n - 1) XP', () => {
    expect([1, 2, 3, 10].map(xpFor)).toEqual([5, 11, 17, 59]);
  });

  it('never exceeds 4 weapons / 4 passives or level 5, and falls back to heal/gold', () => {
    const s = new Survivors(new Rng(1));
    s.reset();
    for (let i = 0; i < 60; i++) {
      s.pendingLevels = 1;
      s.choosing = s.offer();
      s.choose(0);
      expect(s.weapons.size).toBeLessThanOrEqual(4);
      expect(s.passives.size).toBeLessThanOrEqual(4);
      for (const L of [...s.weapons.values(), ...s.passives.values()]) expect(L).toBeLessThanOrEqual(MAX_LEVEL);
    }
    s.pendingLevels = 1;
    expect(s.offer().map((c) => c.kind).sort()).toEqual(['gold', 'heal']);
  });

  it('respects the 350 enemy cap', () => {
    const { maxLive } = run(3, 1, 170);
    expect(maxLive).toBeLessThanOrEqual(CAP);
  });

  it('an unskilled player lasts over 60 s; a skilled one can beat the boss', () => {
    const naive = [1, 2, 3, 4, 5].map((seed) => run(seed, 0).s.t);
    expect(Math.min(...naive)).toBeGreaterThan(60);
    const wins = [11, 12, 13].filter((seed) => run(seed, 1).s.won).length;
    expect(wins).toBeGreaterThanOrEqual(2);
  });
});
