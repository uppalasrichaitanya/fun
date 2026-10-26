import { dist } from '../../engine/math';
import type { Rng } from '../../engine/rng';
import { C } from '../../engine/theme';
import { CFG, Kind } from './config';
import type { Hazards } from './hazards';

export interface World {
  hz: Hazards;
  rng: Rng;
  px: number; py: number;
  /** Intensity I = 1 + t / 30. */
  I: number;
}

const speedMul = (w: World) => Math.min(2, w.I);
const countMul = (w: World) => Math.min(2.5, w.I);

/** A running pattern. `area` patterns can cut the arena, so at most one runs at a time. */
export interface Pattern { kind: Kind; area: boolean; update(dt: number, w: World): boolean }

/** Run a list of [time, action] steps; done when the last step fired and `tail` seconds passed. */
class Timeline implements Pattern {
  private t = 0;
  private i = 0;
  constructor(readonly kind: Kind, readonly area: boolean, private steps: [number, (w: World) => void][], private tail: number) {}
  update(dt: number, w: World): boolean {
    this.t += dt;
    while (this.i < this.steps.length && this.t >= this.steps[this.i][0]) { this.steps[this.i][1](w); this.i++; }
    return this.i >= this.steps.length && this.t >= this.steps[this.steps.length - 1][0] + this.tail;
  }
}

function aimedVolley(w: World): Pattern {
  const steps: [number, (w: World) => void][] = [];
  const volleys = 3;
  const gap = 1.5 / Math.sqrt(w.I);
  for (let v = 0; v < volleys; v++) {
    const at = v * gap;
    // Choose the edge + segment now so the flash telegraphs exactly where bullets come from.
    let edge = 0, ex = 0, ey = 0, len = 0;
    steps.push([at, (w) => {
      const { W, H } = w.hz;
      edge = w.rng.int(0, 3);
      len = edge % 2 === 0 ? Math.min(220, W * 0.4) : Math.min(220, H * 0.4);
      if (edge === 0) { ex = w.rng.range(0, W - len); ey = 0; w.hz.mark(ex, 0, len, 8, 0.4, C.pink); }
      else if (edge === 2) { ex = w.rng.range(0, W - len); ey = H; w.hz.mark(ex, H - 8, len, 8, 0.4, C.pink); }
      else if (edge === 1) { ex = W; ey = w.rng.range(0, H - len); w.hz.mark(W - 8, ey, 8, len, 0.4, C.pink); }
      else { ex = 0; ey = w.rng.range(0, H - len); w.hz.mark(0, ey, 8, len, 0.4, C.pink); }
    }]);
    steps.push([at + 0.4, (w) => {
      const n = Math.min(12, Math.round(w.rng.int(3, 7) * Math.min(1.8, countMul(w))));
      const sp = 230 * speedMul(w);
      for (let i = 0; i < n; i++) {
        const f = n === 1 ? 0.5 : i / (n - 1);
        const sx = edge % 2 === 0 ? ex + f * len : ex;
        const sy = edge % 2 === 0 ? ey : ey + f * len;
        // Aim at the player's position at fire time, with a slight fan.
        const a = Math.atan2(w.py - sy, w.px - sx) + (f - 0.5) * 0.25;
        w.hz.bullet(sx, sy, Math.cos(a) * sp, Math.sin(a) * sp, 6, Kind.Volley);
      }
    }]);
  }
  return new Timeline(Kind.Volley, false, steps, 1.2);
}

function spiral(w: World): Pattern {
  const { W, H } = w.hz;
  const inset = 36;
  const corners = [[inset, inset], [W - inset, inset], [W - inset, H - inset], [inset, H - inset]];
  // The corner farthest from the player, so the growth telegraph is never on top of them.
  let best = corners[0], bd = -1;
  for (const c of corners) { const d = dist(c[0], c[1], w.px, w.py); if (d > bd) { bd = d; best = c; } }
  const dur = 5;
  return new Timeline(Kind.Spiral, false, [[0, (w) => {
    w.hz.emitter(best[0], best[1], dur, 5 * Math.min(2, w.I), w.rng.chance(0.5) ? 2 : 3, 150 * speedMul(w), w.rng.sign() * 1.9);
  }]], dur + 1.2);
}

function laserSweep(w: World): Pattern {
  const steps: [number, (w: World) => void][] = [];
  const sweeps = 2;
  const fire = 1.3 / Math.sqrt(speedMul(w));
  for (let s = 0; s < sweeps; s++) {
    steps.push([s * (0.8 + fire + 0.3), (w) => {
      const { W, H } = w.hz;
      const diag = Math.hypot(W, H) + 20;
      // Pivot on a corner; sweep at most half of its quadrant so the arena is never sealed.
      const corner = w.rng.int(0, 3);
      const cx = corner === 1 || corner === 2 ? W : 0, cy = corner >= 2 ? H : 0;
      const qStart = [0, Math.PI / 2, Math.PI, -Math.PI / 2][corner];
      const span = w.rng.range(0.6, 0.85);       // 34-49 degrees
      const dir = w.rng.sign();
      const startOff = w.rng.range(0.05, Math.PI / 2 - span - 0.05);
      const a0 = dir > 0 ? qStart + startOff : qStart + startOff + span;
      w.hz.laser(cx, cy, a0, diag, 0.8, fire, (dir * span) / fire, dir * span, Kind.Sweep, 12);
    }]);
  }
  return new Timeline(Kind.Sweep, true, steps, 0.8 + fire + 0.4);
}

function laserGrid(_w: World): Pattern {
  const steps: [number, (w: World) => void][] = [];
  const bursts = 3;
  for (let b = 0; b < bursts; b++) {
    steps.push([b * 1.7, (w) => {
      const { W, H } = w.hz;
      const horizontal = w.rng.chance(0.5);
      const extent = horizontal ? H : W;
      const spacing = 96;
      const slots = Math.floor(extent / spacing);
      const k = Math.min(4, Math.max(2, Math.floor(2 + (w.I - 1) * 1.4)), slots - 1);
      const idx = w.rng.shuffle(Array.from({ length: slots }, (_, i) => i)).slice(0, k);
      for (const i of idx) {
        const pos = i * spacing + spacing / 2 + w.rng.range(-8, 8);
        if (horizontal) w.hz.laser(-10, pos, 0, W + 20, 0.9, 0.42, 0, 0, Kind.Grid, 14);
        else w.hz.laser(pos, -10, Math.PI / 2, H + 20, 0.9, 0.42, 0, 0, Kind.Grid, 14);
      }
    }]);
  }
  return new Timeline(Kind.Grid, true, steps, 1.5);
}

function closingWalls(w: World): Pattern {
  const vertical = w.rng.chance(w.hz.W >= w.hz.H ? 0.7 : 0.3);
  const extent = vertical ? w.hz.W : w.hz.H;
  const cross = vertical ? w.hz.H : w.hz.W;
  const speed = 150 * Math.min(1.6, speedMul(w));
  const gap = Math.max(84, 120 - 8 * (w.I - 1));
  const travel = (extent + 40) / speed;
  const mk = (w: World, fromStart: boolean) => {
    const a = w.rng.range(50, cross - 50 - gap);
    w.hz.wall(vertical, fromStart, a, a + gap, speed, 0.7);
  };
  const first = w.rng.chance(0.5);
  return new Timeline(Kind.Walls, true, [
    [0, (w) => mk(w, first)],
    [travel * 0.45, (w) => mk(w, !first)],
  ], travel + 0.8);
}

function bouncers(_w: World): Pattern {
  return new Timeline(Kind.Bouncers, false, [[0, (w) => {
    const n = Math.min(5, 1 + Math.floor(countMul(w) * 1.2));
    const { W, H } = w.hz;
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = w.rng.range(40, W - 40); y = w.rng.range(40, H - 40);
        if (dist(x, y, w.px, w.py) > CFG.safeSpawn + 60) break;
      }
      const a = w.rng.range(0, Math.PI * 2), sp = 150 * speedMul(w);
      w.hz.saw(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 8);
    }
  }]], 7);
}

function mines(_w: World): Pattern {
  return new Timeline(Kind.Mines, false, [[0, (w) => {
    const { W, H } = w.hz;
    const n = Math.min(4, 1 + Math.floor(countMul(w)));
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0;
      for (let tries = 0; tries < 20; tries++) {
        const edge = w.rng.int(0, 3);
        x = edge === 1 ? W - 20 : edge === 3 ? 20 : w.rng.range(20, W - 20);
        y = edge === 0 ? 20 : edge === 2 ? H - 20 : w.rng.range(20, H - 20);
        if (dist(x, y, w.px, w.py) > CFG.safeSpawn + 80) break;
      }
      w.hz.mine(x, y, 62 * speedMul(w));
    }
  }]], 5);
}

function rain(w: World): Pattern {
  const steps: [number, (w: World) => void][] = [];
  const rows = 9;
  const every = 0.55 / Math.sqrt(w.I);
  for (let r = 0; r < rows; r++) {
    const cols: number[] = [];
    steps.push([r * every, (w) => {
      const { W } = w.hz;
      const cw = 24;
      const n = Math.floor(W / cw);
      const pick = Math.min(Math.floor(n * 0.45), Math.round(n * 0.22 * Math.min(1.8, countMul(w))));
      const all = w.rng.shuffle(Array.from({ length: n }, (_, i) => i));
      cols.length = 0;
      for (let i = 0; i < pick; i++) cols.push(all[i]);
      for (const c of cols) w.hz.mark(c * cw + 4, 0, cw - 8, 10, 0.4, C.cyan);
    }]);
    steps.push([r * every + 0.4, (w) => {
      const sp = 240 * speedMul(w);
      for (const c of cols) w.hz.bullet(c * 24 + 12, -8, 0, sp, 6, Kind.Rain);
    }]);
  }
  return new Timeline(Kind.Rain, true, steps, 2);
}

const FACTORIES: [Kind, (w: World) => Pattern, number][] = [
  [Kind.Volley, aimedVolley, 3],
  [Kind.Spiral, spiral, 2],
  [Kind.Sweep, laserSweep, 2],
  [Kind.Grid, laserGrid, 2],
  [Kind.Walls, closingWalls, 2],
  [Kind.Bouncers, bouncers, 2],
  [Kind.Mines, mines, 1.5],
  [Kind.Rain, rain, 2],
];
const AREA = new Set([Kind.Sweep, Kind.Grid, Kind.Walls, Kind.Rain]);

/** Starts patterns on a schedule with escalating concurrency. */
export class Director {
  t = 0;
  active: Pattern[] = [];
  private nextAt = 0.6;
  private last: Kind | -1 = -1;

  reset(): void { this.t = 0; this.active.length = 0; this.nextAt = 0.6; this.last = -1; }

  get maxConcurrent(): number { return this.t < 20 ? 1 : this.t < 45 ? 2 : 3; }

  update(dt: number, w: World): void {
    this.t += dt;
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].update(dt, w)) this.active.splice(i, 1);
    }
    const idle = this.active.length === 0;
    // Never leave the arena empty; otherwise add concurrent patterns every 8-12 s.
    if (this.active.length < this.maxConcurrent && (idle ? this.t >= 0.6 : this.t >= this.nextAt)) {
      const p = this.pick(w);
      if (p) {
        this.active.push(p);
        // 8-12 s between starts at 1-at-once; overlapping patterns start proportionally sooner.
        this.nextAt = this.t + w.rng.range(8, 12) / this.maxConcurrent / Math.pow(w.I, 0.25);
      }
    }
  }

  private pick(w: World): Pattern | null {
    if (this.last === -1) { this.last = Kind.Volley; return aimedVolley(w); }
    const areaBusy = this.active.some((p) => p.area);
    const busy = new Set(this.active.map((p) => p.kind));
    const options = FACTORIES.filter(([k]) => k !== this.last && !busy.has(k) && !(areaBusy && AREA.has(k)));
    if (!options.length) return null;
    const i = w.rng.weighted(options.map((o) => o[2]));
    this.last = options[i][0];
    return options[i][1](w);
  }
}
