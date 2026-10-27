import { describe, expect, it } from 'vitest';
import { Rng } from '../../engine/rng';
import { CFG, JAR, TIERS } from './config';
import { MergeSim } from './logic';

const DT = 1 / 120;
const run = (sim: MergeSim, seconds: number) => { for (let i = 0; i < seconds * 120; i++) sim.step(DT); };

describe('Merge Drop physics', () => {
  it('two same-tier balls dropped together produce exactly one merge', () => {
    for (let tier = 0; tier < 6; tier++) {
      const sim = new MergeSim(new Rng(1));
      sim.reset();
      sim.held = tier; sim.aimX = 190; sim.drop();
      sim.cooldown = 0; sim.held = tier; sim.aimX = 210; sim.drop();
      run(sim, 3);
      expect(sim.balls.filter((b) => b.tier === tier + 1)).toHaveLength(1);
      expect(sim.balls.filter((b) => b.tier === tier)).toHaveLength(0);
    }
  });

  it('no ball ever leaves the jar, and a settled pile does not jitter', () => {
    const rng = new Rng(7);
    const sim = new MergeSim(rng);
    sim.reset();
    let maxBalls = 0;
    for (let i = 0; i < 160 && !sim.over; i++) {
      sim.aimX = rng.range(JAR.l, JAR.r);
      sim.cooldown = 0;
      sim.drop();
      run(sim, 0.25);
      maxBalls = Math.max(maxBalls, sim.balls.length);
      for (const b of sim.balls) {
        expect(b.x - b.r).toBeGreaterThanOrEqual(JAR.l - 0.5);
        expect(b.x + b.r).toBeLessThanOrEqual(JAR.r + 0.5);
        expect(b.y + b.r).toBeLessThanOrEqual(JAR.bottom + 0.5);
        expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
      }
    }
    expect(maxBalls).toBeGreaterThan(20);
    // Let the pile rest, then measure motion.
    sim.danger = -1e9;
    run(sim, 3);
    const before = sim.balls.map((b) => [b.x, b.y]);
    run(sim, 1);
    const moved = sim.balls.map((b, i) => Math.hypot(b.x - before[i][0], b.y - before[i][1]));
    expect(Math.max(...moved)).toBeLessThan(1.5);
  });

  it('a just-dropped ball passing the line never ends the run', () => {
    const sim = new MergeSim(new Rng(3));
    sim.reset();
    sim.held = 4; sim.drop();
    for (let i = 0; i < 40; i++) { sim.step(DT); expect(sim.over).toBe(false); }
  });

  it('a pile held above the line for 2 s ends the run', () => {
    const sim = new MergeSim(new Rng(4));
    sim.reset();
    // Fill the jar with big non-matching balls.
    const order = [9, 8, 9, 8, 7, 9, 8, 7, 9, 8, 7, 6];
    for (const t of order) { sim.held = t; sim.cooldown = 0; sim.aimX = 100 + (t % 3) * 100; sim.drop(); run(sim, 0.6); if (sim.over) break; }
    run(sim, 4);
    expect(sim.over).toBe(true);
  });

  it('chain multiplier and Supernova trigger', () => {
    const sim = new MergeSim(new Rng(5));
    sim.reset();
    sim.held = TIERS.length - 1; sim.aimX = 120; sim.drop();
    sim.cooldown = 0; sim.held = TIERS.length - 1; sim.aimX = 280; sim.drop();
    run(sim, 4);
    expect(sim.score).toBeGreaterThanOrEqual(CFG.supernova);
    const s2 = new MergeSim(new Rng(6));
    s2.reset();
    // Two tier-1 balls meet just above a resting tier-2 ball: 1+1 -> 2, then 2+2 -> 3 within the chain window.
    const place = (tier: number, x: number, y: number) => {
      s2.cooldown = 0; s2.held = tier; s2.drop();
      const b = s2.balls[s2.balls.length - 1];
      b.x = b.px = x; b.y = b.py = y; b.vx = b.vy = 0;
    };
    place(1, 200, 601);   // resting on the floor
    place(0, 186, 570);
    place(0, 214, 570);
    run(s2, 1);
    expect(s2.bestChain).toBeGreaterThanOrEqual(2);
  });
});
