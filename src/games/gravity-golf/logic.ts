import type { Schema } from '../../engine/levels/schema';

// Gravity Golf physics. Deterministic: same placement and launch, same path.
// Velocity Verlet at a fixed 1/240 s; the aim preview runs this exact sim.

export const WORLD = { w: 960, h: 600 };
export const G = 2.0e6;
export const SOFT = 12;
export const DT = 1 / 240;
export const MAX_T = 10;
export const LOST_MARGIN = 200;
export const COMET_R = 7;
export const HOLE_M = 0.6;
export const HOLE_CAPTURE = 18;
export const DUST_R = 14;
export const VMAX = 470;
/** Slingshot: max pull in world units, and the share of the path the preview shows. */
export const MAX_PULL = 140;
export const PREVIEW = 0.25;
export const PLANET = { small: { m: 1, r: 20 }, large: { m: 2.5, r: 30 } } as const;
export type Size = keyof typeof PLANET;

export interface Body { x: number; y: number; r: number; m: number }
export interface Moon { cx: number; cy: number; R: number; period: number; phase: number; r: number; m: number }

export interface GGLevel {
  name: string;
  comet: [number, number];
  hole: [number, number];
  /** Fixed planets [x, y, r, mass]; negative mass = repulsor star. */
  planets: [number, number, number, number][];
  /** Asteroids [x, y, r] (crash, no pull). */
  rocks: [number, number, number][];
  /** Moons [cx, cy, R, period s, phase deg, r, mass]. They orbit from launch. */
  moons: [number, number, number, number, number, number, number][];
  /** Wormhole pairs [ax, ay, bx, by]. */
  holes: [number, number, number, number][];
  dust: [number, number][];
  /** Planets you may place. */
  inv: Partial<Record<Size, number>>;
  solution: { planets: [Size, number, number][]; shot: [number, number] };
}

const n = 'number' as const;
export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', comet: { tuple: [n, n] }, hole: { tuple: [n, n] },
    planets: { arr: { tuple: [n, n, n, n] } }, rocks: { arr: { tuple: [n, n, n] } },
    moons: { arr: { tuple: [n, n, n, n, n, n, n] } }, holes: { arr: { tuple: [n, n, n, n] } },
    dust: { arr: { tuple: [n, n] }, min: 3, max: 3 },
    inv: { obj: { small: 'int', large: 'int' }, opt: ['small', 'large'] },
    solution: { obj: { planets: { arr: { tuple: [{ enum: ['small', 'large'] }, n, n] } }, shot: { tuple: [n, n] } } },
  },
};

export type Placed = [Size, number, number];
export type Outcome = 'capture' | 'crash' | 'lost' | 'fizzle';

export interface SimResult {
  outcome: Outcome;
  t: number;
  /** Bitmask of collected stardust. */
  dust: number;
  /** Path samples x, y, speed every `every` steps (when recording). */
  path: number[];
  /** Where it ended (crash point / capture). */
  end: { x: number; y: number };
  /** What it hit, for effects. */
  hit?: 'planet' | 'rock' | 'moon' | 'star';
  /** Wormhole jumps (path index where each happened) so drawing can break the line. */
  jumps: number[];
}

/** Launch velocity from a stored shot [angle degrees, power 0..1]. */
export function shotVelocity(shot: readonly [number, number]): { vx: number; vy: number } {
  const a = (shot[0] * Math.PI) / 180;
  return { vx: Math.cos(a) * shot[1] * VMAX, vy: Math.sin(a) * shot[1] * VMAX };
}

/** Shot from a slingshot pull (comet minus pointer, world units), rounded the way levels store it. */
export function shotFromPull(dx: number, dy: number): [number, number] {
  const len = Math.min(MAX_PULL, Math.hypot(dx, dy));
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return [Math.round(angle * 10) / 10, Math.round((len / MAX_PULL) * 1000) / 1000];
}

export function moonPos(m: GGLevel['moons'][number], t: number): { x: number; y: number } {
  const a = ((m[4] * Math.PI) / 180) + (2 * Math.PI * t) / m[3];
  return { x: m[0] + Math.cos(a) * m[2], y: m[1] + Math.sin(a) * m[2] };
}

export function bodies(l: GGLevel, placed: readonly Placed[]): Body[] {
  const out: Body[] = l.planets.map(([x, y, r, m]) => ({ x, y, r, m }));
  for (const [s, x, y] of placed) out.push({ x, y, r: PLANET[s].r, m: PLANET[s].m });
  return out;
}

/**
 * Fly the comet. `every` > 0 records the path every N steps. `limit` stops early
 * (seconds) for the aim preview, which then shows a share of the real path.
 */
export function simulate(l: GGLevel, placed: readonly Placed[], shot: readonly [number, number], every = 0, limit = MAX_T): SimResult {
  const B = bodies(l, placed);
  const [hx, hy] = l.hole;
  let x = l.comet[0], y = l.comet[1];
  let { vx, vy } = shotVelocity(shot);
  let dust = 0;
  const path: number[] = [];
  const jumps: number[] = [];
  let cool = 0;
  const acc = (px: number, py: number, t: number): [number, number] => {
    let ax = 0, ay = 0;
    for (const b of B) {
      const dx = b.x - px, dy = b.y - py;
      const d2 = dx * dx + dy * dy + SOFT * SOFT;
      const f = (G * b.m) / d2 / Math.sqrt(d2);
      ax += dx * f; ay += dy * f;
    }
    for (const m of l.moons) {
      const p = moonPos(m, t);
      const dx = p.x - px, dy = p.y - py;
      const d2 = dx * dx + dy * dy + SOFT * SOFT;
      const f = (G * m[6]) / d2 / Math.sqrt(d2);
      ax += dx * f; ay += dy * f;
    }
    const dx = hx - px, dy = hy - py;
    const d2 = dx * dx + dy * dy + SOFT * SOFT;
    const f = (G * HOLE_M) / d2 / Math.sqrt(d2);
    return [ax + dx * f, ay + dy * f];
  };
  let [ax, ay] = acc(x, y, 0);
  const steps = Math.round(Math.min(MAX_T, limit) / DT);
  const end = (outcome: Outcome, k: number, hit?: SimResult['hit']): SimResult => {
    if (every) path.push(x, y, Math.hypot(vx, vy));
    return { outcome, t: k * DT, dust, path, end: { x, y }, hit, jumps };
  };
  for (let k = 1; k <= steps; k++) {
    const t = k * DT;
    x += vx * DT + 0.5 * ax * DT * DT;
    y += vy * DT + 0.5 * ay * DT * DT;
    const [nax, nay] = acc(x, y, t);
    vx += 0.5 * (ax + nax) * DT;
    vy += 0.5 * (ay + nay) * DT;
    ax = nax; ay = nay;
    if (every && k % every === 0) path.push(x, y, Math.hypot(vx, vy));
    if ((x - hx) ** 2 + (y - hy) ** 2 < HOLE_CAPTURE * HOLE_CAPTURE) return end('capture', k);
    for (const b of B) if ((x - b.x) ** 2 + (y - b.y) ** 2 < (b.r + COMET_R) ** 2) return end('crash', k, b.m < 0 ? 'star' : 'planet');
    for (const [rx, ry, rr] of l.rocks) if ((x - rx) ** 2 + (y - ry) ** 2 < (rr + COMET_R) ** 2) return end('crash', k, 'rock');
    for (const m of l.moons) { const p = moonPos(m, t); if ((x - p.x) ** 2 + (y - p.y) ** 2 < (m[5] + COMET_R) ** 2) return end('crash', k, 'moon'); }
    for (let i = 0; i < l.dust.length; i++) {
      const [dx, dy] = l.dust[i];
      if (!(dust & (1 << i)) && (x - dx) ** 2 + (y - dy) ** 2 < DUST_R * DUST_R) dust |= 1 << i;
    }
    if (cool > 0) cool -= DT;
    else for (const [ax0, ay0, bx0, by0] of l.holes) {
      const inA = (x - ax0) ** 2 + (y - ay0) ** 2 < 16 * 16, inB = (x - bx0) ** 2 + (y - by0) ** 2 < 16 * 16;
      if (inA || inB) {
        const ox = x - (inA ? ax0 : bx0), oy = y - (inA ? ay0 : by0);
        x = (inA ? bx0 : ax0) + ox; y = (inA ? by0 : ay0) + oy;
        cool = 0.25;
        [ax, ay] = acc(x, y, t);
        if (every) { jumps.push(path.length); path.push(x, y, Math.hypot(vx, vy)); }
        break;
      }
    }
    if (x < -LOST_MARGIN || y < -LOST_MARGIN || x > WORLD.w + LOST_MARGIN || y > WORLD.h + LOST_MARGIN) return end('lost', k);
  }
  return end('fizzle', steps);
}

/** Can a planet of this size go here? */
export function placeOk(l: GGLevel, placed: readonly Placed[], s: Size, x: number, y: number, ignore = -1): boolean {
  const r = PLANET[s].r;
  if (x < r + 8 || y < r + 8 || x > WORLD.w - r - 8 || y > WORLD.h - r - 8) return false;
  const clear = (bx: number, by: number, br: number) => (x - bx) ** 2 + (y - by) ** 2 >= (r + br + 6) ** 2;
  if (!clear(l.comet[0], l.comet[1], 40) || !clear(l.hole[0], l.hole[1], 36)) return false;
  for (const [px, py, pr] of l.planets) if (!clear(px, py, pr)) return false;
  for (const [rx, ry, rr] of l.rocks) if (!clear(rx, ry, rr)) return false;
  for (const m of l.moons) if (Math.abs(Math.hypot(x - m[0], y - m[1]) - m[2]) < r + m[5] + 6) return false;
  for (const [ax, ay, bx, by] of l.holes) if (!clear(ax, ay, 16) || !clear(bx, by, 16)) return false;
  for (const [dx, dy] of l.dust) if (!clear(dx, dy, 8)) return false;
  for (let i = 0; i < placed.length; i++) if (i !== ignore && !clear(placed[i][1], placed[i][2], PLANET[placed[i][0]].r)) return false;
  return true;
}

export const invTotal = (l: GGLevel): number => (l.inv.small ?? 0) + (l.inv.large ?? 0);

export function lintLevel(l: GGLevel): string[] {
  const e: string[] = [];
  const used: Record<string, number> = {};
  l.solution.planets.forEach((p, i) => {
    used[p[0]] = (used[p[0]] ?? 0) + 1;
    if (!placeOk(l, l.solution.planets, p[0], p[1], p[2], i)) e.push(`solution planet ${i + 1} overlaps something`);
  });
  for (const [k, v] of Object.entries(used)) if (v > (l.inv[k as Size] ?? 0)) e.push(`solution uses ${v} ${k}, inventory ${l.inv[k as Size] ?? 0}`);
  if (Math.abs(l.solution.shot[1]) > 1) e.push('shot power above 1');
  return e;
}
