import { describe, expect, it } from 'vitest';
import { Rng } from '../../engine/rng';
import { ARENA, CFG, CpuBrain, SumoSim, type Difficulty } from './logic';

const DT = 1 / 120;
const idle = { x: 0, y: 0, dash: false };

function match(a: Difficulty, b: Difficulty, seed: number) {
  const sim = new SumoSim(new Rng(seed));
  sim.reset();
  const A = new CpuBrain(0, a, new Rng(seed + 1)), B = new CpuBrain(1, b, new Rng(seed + 2));
  const lens: number[] = [];
  let wait = -1;
  for (let k = 0; k < 120 * 600 && !sim.matchOver; k++) {
    sim.step(DT, [A.think(sim, DT), B.think(sim, DT)]);
    for (const e of sim.events) if (e.type === 'round') { lens.push(sim.t); wait = 0; }
    sim.events.length = 0;
    if (wait >= 0 && (wait += DT) > 1.5) { sim.newRound(); wait = -1; }
  }
  return { winner: sim.winner, lens };
}

describe('Sumo Blobs', () => {
  it('both players can move and dash in the same tick', () => {
    const sim = new SumoSim(new Rng(1));
    sim.reset();
    for (let k = 0; k < 300; k++) sim.step(DT, [idle, idle]);
    sim.step(DT, [{ x: 1, y: 1, dash: true }, { x: -1, y: -1, dash: true }]);
    expect(sim.blobs[0].dashT).toBeGreaterThan(0);
    expect(sim.blobs[1].dashT).toBeGreaterThan(0);
  });

  it('head-on dashes clash and both bounce back', () => {
    const sim = new SumoSim(new Rng(1));
    sim.reset();
    for (let k = 0; k < 300; k++) sim.step(DT, [idle, idle]);
    sim.blobs[0].x = ARENA.x - 60; sim.blobs[1].x = ARENA.x + 60;
    let clash = false;
    for (let k = 0; k < 30; k++) {
      sim.step(DT, [{ x: 1, y: 0, dash: k === 0 }, { x: -1, y: 0, dash: k === 0 }]);
      if (sim.events.some((e) => e.type === 'clash')) clash = true;
      sim.events.length = 0;
    }
    expect(clash).toBe(true);
    expect(sim.blobs[0].vx).toBeLessThan(0);
    expect(sim.blobs[1].vx).toBeGreaterThan(0);
  });

  it('a blob past the edge by 30% of its radius falls and the other scores', () => {
    const sim = new SumoSim(new Rng(1));
    sim.reset();
    for (let k = 0; k < 300; k++) sim.step(DT, [idle, idle]);
    sim.blobs[1].x = ARENA.x + ARENA.r0 + CFG.r * 0.31;
    for (let k = 0; k < 60; k++) sim.step(DT, [idle, idle]);
    expect(sim.score).toEqual([1, 0]);
  });

  it('both falling within 0.2 s is a draw', () => {
    const sim = new SumoSim(new Rng(1));
    sim.reset();
    for (let k = 0; k < 300; k++) sim.step(DT, [idle, idle]);
    sim.blobs[0].x = ARENA.x - ARENA.r0 - CFG.r;
    sim.blobs[1].x = ARENA.x + ARENA.r0 + CFG.r;
    for (let k = 0; k < 60; k++) sim.step(DT, [idle, idle]);
    expect(sim.score).toEqual([0, 0]);
    expect(sim.roundOver).toBe(true);
  });

  it('CPU difficulty is ordered and rounds last a sensible time', () => {
    let hardWins = 0;
    const lens: number[] = [];
    for (let s = 1; s <= 12; s++) {
      const r = match('easy', 'hard', s);
      if (r.winner === 1) hardWins++;
      lens.push(...match('normal', 'normal', s + 100).lens);
    }
    expect(hardWins).toBeGreaterThanOrEqual(10);
    lens.sort((a, b) => a - b);
    const median = lens[lens.length >> 1];
    expect(median).toBeGreaterThan(8);
    expect(median).toBeLessThan(40);
  });
});
