import { describe, expect, it } from 'vitest';
import { placeOk, PREVIEW, shotFromPull, simulate, type GGLevel } from './logic';

const base: GGLevel = {
  name: 't', comet: [100, 300], hole: [860, 300], planets: [[480, 300, 30, 2]], rocks: [], moons: [[480, 300, 120, 6, 90, 12, 0.8]],
  holes: [], dust: [[300, 200], [500, 150], [700, 220]], inv: { small: 2 }, solution: { planets: [], shot: [0, 0] },
};

describe('Gravity Golf physics', () => {
  it('identical placement and launch give an identical path', () => {
    const a = simulate(base, [['small', 600, 420]], [-12.5, 0.73], 1);
    const b = simulate(base, [['small', 600, 420]], [-12.5, 0.73], 1);
    expect(b.path).toEqual(a.path);
    expect(b.outcome).toBe(a.outcome);
  });

  it('the aim preview is exactly the start of the real path', () => {
    const full = simulate(base, [], [-20, 0.8], 2);
    const n = Math.floor((full.path.length / 3) * PREVIEW);
    const again = simulate(base, [], [-20, 0.8], 2);
    expect(again.path.slice(0, n * 3)).toEqual(full.path.slice(0, n * 3));
    // Recording rate does not change the physics.
    const fine = simulate(base, [], [-20, 0.8], 1);
    expect(fine.outcome).toBe(full.outcome);
    expect(fine.t).toBe(full.t);
  });

  it('crashes into planets, gets lost off the map, captures in the hole', () => {
    expect(simulate(base, [], [0, 0.6]).outcome).toBe('crash');
    expect(simulate(base, [], [180, 1]).outcome).toBe('lost');
    const open: GGLevel = { ...base, planets: [], moons: [] };
    expect(simulate(open, [], [0, 0.9]).outcome).toBe('capture');
  });

  it('slingshot pulls round to stored precision and placement keeps clearances', () => {
    expect(shotFromPull(140, 0)).toEqual([0, 1]);
    expect(shotFromPull(0, 500)).toEqual([90, 1]);
    expect(placeOk(base, [], 'small', 480, 300)).toBe(false);
    expect(placeOk(base, [], 'small', 300, 520)).toBe(true);
    expect(placeOk(base, [['small', 300, 520]], 'large', 310, 530)).toBe(false);
  });
});
