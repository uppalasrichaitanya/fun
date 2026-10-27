import { describe, expect, it } from 'vitest';
import { Autopilot } from './autopilot';
import { LEVELS } from './levels';
import { heightAt, LanderSim } from './sim';

function fly(i: number) {
  const sim = new LanderSim(LEVELS[i]);
  const ap = new Autopilot(sim);
  for (let k = 0; k < 120 * 60 && sim.state !== 'landed' && sim.state !== 'crashed'; k++) sim.step(1 / 120, ap.update());
  return sim;
}

describe('Rocket Lander levels', () => {
  it('has 15 levels in 3 worlds with valid pads', () => {
    expect(LEVELS).toHaveLength(15);
    expect(LEVELS.map((l) => l.world)).toEqual([...Array(5).fill('Moon'), ...Array(5).fill('Mars'), ...Array(5).fill('Ice moon')]);
    for (const l of LEVELS) {
      for (const p of l.pads) {
        expect(p.x2 - p.x1).toBeGreaterThanOrEqual(56); // both legs (34 apart) must fit
        if (!p.move) for (let x = p.x1; x <= p.x2; x += 5) expect(heightAt(l.terrain, x)).toBeCloseTo(p.y, 5);
      }
      for (let k = 1; k < l.terrain.length; k++) expect(l.terrain[k][0]).toBeGreaterThanOrEqual(l.terrain[k - 1][0]);
    }
  });

  it('every level is landable with 3 stars (autopilot flies the stored route)', () => {
    LEVELS.forEach((_, i) => {
      const sim = fly(i);
      expect(sim.state, `level ${i + 1}`).toBe('landed');
      expect(sim.landing!.stars, `level ${i + 1}`).toBe(3);
    });
  });

  it('is deterministic', () => {
    const a = fly(12), b = fly(12);
    expect([a.x, a.y, a.fuel, a.t]).toEqual([b.x, b.y, b.fuel, b.t]);
  });

  it('landing rules are exact', () => {
    const l = LEVELS[0];
    const touch = (vy: number, vx: number, tiltDeg: number) => {
      const s = new LanderSim(l);
      const a = (tiltDeg * Math.PI) / 180;
      // Lowest leg tip a hair above the pad, so the next step touches down.
      s.x = 400; s.y = l.pads[0].y - (26 * Math.cos(a) + 17 * Math.sin(a)) - 0.05; s.vx = vx; s.vy = vy; s.angle = a;
      s.step(1 / 120, { left: false, right: false, thrust: false });
      return s;
    };
    expect(touch(40, 0, 0).state).toBe('landed');
    expect(touch(46, 0, 0).state).toBe('crashed');
    expect(touch(20, 21, 0).state).toBe('landed');
    expect(touch(20, 23, 0).state).toBe('crashed');
    expect(touch(20, 0, 9).state).toBe('landed');
    expect(touch(20, 0, 11).state).toBe('crashed');
    expect(touch(12, 0, 2).landing!.butter).toBe(true);
    expect(touch(16, 0, 0).landing!.butter).toBe(false);
  });
});
