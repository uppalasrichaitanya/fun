import { describe, expect, it } from 'vitest';
import { anchorPos, Cave, CFG, Swinger, SwingBot } from './logic';

const DT = 1 / 120;

describe('Grapple Swing', () => {
  it('the highlighted anchor is always the one a press grabs', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = new Swinger(new Cave(seed));
      const bot = new SwingBot(s);
      let holding = false;
      for (let k = 0; k < 120 * 30 && !s.dead; k++) {
        const want = bot.update(DT);
        const highlighted = holding ? null : s.select();
        s.step(DT, want);
        if (want && !holding && highlighted) expect(s.anchor).toBe(highlighted);
        holding = want;
      }
    }
  });

  it('a swing never gains energy (no perfect boosts)', () => {
    const cave = new Cave(3);
    const s = new Swinger(cave);
    cave.ensure(0);
    const a = cave.chunks[0].anchors[0];
    const p = anchorPos(a, 0);
    s.x = p.x - 150; s.y = p.y + 150; s.vx = 0; s.vy = 0;
    s.step(DT, true);
    for (let k = 0; k < 20; k++) s.step(DT, true);
    const energy = () => 0.5 * (s.vx * s.vx + s.vy * s.vy) + CFG.gravity * (1000 - s.y);
    const e0 = energy();
    let max = e0;
    for (let k = 0; k < 120 * 4; k++) { s.step(DT, true); max = Math.max(max, energy()); }
    // Reeling in shortens the rope (and adds a little speed in a real pendulum); allow a tiny tolerance.
    expect(max).toBeLessThan(e0 * 1.05);
  });

  it('generated caves are deterministic per seed', () => {
    const a = new Cave(42), b = new Cave(42);
    a.ensure(5000); b.ensure(5000);
    expect(a.chunks.map((c) => c.anchors.map((x) => [x.x0, x.y0, x.kind]))).toEqual(b.chunks.map((c) => c.anchors.map((x) => [x.x0, x.y0, x.kind])));
  });

  it('every generated chunk keeps anchors in reach of each other', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const cave = new Cave(seed);
      cave.ensure(12000);
      const all = [...cave.anchors()];
      for (let i = 1; i < all.length; i++) {
        const gap = all[i].x0 - all[i - 1].x0;
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(340);
      }
    }
  });

  it('the demo bot gets well into the cave on most seeds', () => {
    const dists: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const s = new Swinger(new Cave(seed));
      const bot = new SwingBot(s);
      for (let k = 0; k < 120 * 40 && !s.dead; k++) s.step(DT, bot.update(DT));
      dists.push(s.distance);
    }
    dists.sort((x, y) => x - y);
    expect(dists[4]).toBeGreaterThan(150);
  });
});
