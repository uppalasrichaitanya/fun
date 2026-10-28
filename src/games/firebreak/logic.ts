import type { Schema } from '../../engine/levels/schema';

// Firebreak: deterministic fire spread on a grid. No dice: every cell heats its 8
// neighbours, wind scales ignite times, strong wind throws embers exactly 2 tiles.
// The game, forecast, verifier and generator all run this same step function.

export const DT = 0.05;
export const MAX_T = 240;
export const FORECAST_T = 4;
export const EMBER_AT = 3;
export const RAIN_T = 5;
export const SOAK = 3;

/** Terrain: "." dry grass, "f" forest, "b" bush, "H" house, "#" rock, "~" water, "=" road, ":" dirt. */
export const IGNITE: Record<string, number> = { '.': 0.5, b: 1.0, f: 1.5, H: 2.0 };
export const BURN: Record<string, number> = { '.': 1, b: 2, f: 4, H: 5 };
export const flammable = (ch: string): boolean => ch in IGNITE;

/** 8 directions, clockwise from east. */
export const DIRS: readonly [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
export const DIR_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

export type ToolKind = 'firebreak' | 'water' | 'backburn' | 'rain';
/** Wind changes: [time s, direction 0-7 (where it blows to), strength 0 calm / 1 breeze / 2 strong]. */
export type WindStep = [number, number, number];

export interface FBLevel {
  name: string;
  rows: string[];
  starts: [number, number][];
  wind: WindStep[];
  tools: Partial<Record<ToolKind, number>>;
  /** Houses to save for 1 star. */
  target: number;
  /** Forest percentage to keep (with every house saved) for 3 stars. */
  forest: number;
  solution: Plan;
}

export interface Plan {
  firebreak: [number, number][];
  water: [number, number][];
  backburn: [number, number][];
  /** Rain clouds: [time s, centre c, centre r]. */
  rain: [number, number, number][];
}

const cell: Schema = { tuple: ['int', 'int'] };
export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', rows: { arr: 'string', min: 6, max: 16 }, starts: { arr: cell, min: 1 },
    wind: { arr: { tuple: ['number', 'int', 'int'] }, min: 1 },
    tools: { obj: { firebreak: 'int', water: 'int', backburn: 'int', rain: 'int' }, opt: ['firebreak', 'water', 'backburn', 'rain'] },
    target: 'int', forest: 'int',
    solution: { obj: { firebreak: { arr: cell }, water: { arr: cell }, backburn: { arr: cell }, rain: { arr: { tuple: ['number', 'int', 'int'] } } } },
  },
};

export const emptyPlan = (): Plan => ({ firebreak: [], water: [], backburn: [], rain: [] });

/** Where each tool may go. Firebreaks clear grass and bush; backburns burn any plant; water anywhere on land. */
export function canPlace(rows: readonly string[], kind: ToolKind, c: number, r: number, starts: readonly [number, number][]): boolean {
  const ch = rows[r]?.[c];
  if (ch === undefined) return false;
  if (starts.some(([sc, sr]) => sc === c && sr === r)) return false;
  if (kind === 'firebreak') return ch === '.' || ch === 'b';
  if (kind === 'backburn') return ch === '.' || ch === 'b' || ch === 'f';
  if (kind === 'water') return ch !== '~';
  return true;
}

export interface Sim {
  w: number;
  h: number;
  t: number;
  /** Terrain after tools (firebreaks are dirt, backburns ash "a"). */
  ter: string[];
  /** 0 unburnt, 1 burning, 2 burnt. */
  state: Uint8Array;
  heat: Float32Array;
  burnT: Float32Array;
  soaked: Uint8Array;
  rainUntil: Float32Array;
  ember: Uint8Array;
  /** Time each cell caught fire (-1 never). */
  litAt: Float32Array;
  rainQueue: [number, number, number][];
  done: boolean;
  /** Ember throws this step (from -> to), for effects. */
  embers: [number, number][];
  houses: number;
  forestCells: number;
}

export function makeSim(l: FBLevel, plan: Plan): Sim {
  const h = l.rows.length, w = l.rows[0].length;
  const ter = l.rows.map((row) => row.split(''));
  for (const [c, r] of plan.firebreak) if (ter[r]?.[c] !== undefined) ter[r][c] = ':';
  for (const [c, r] of plan.backburn) if (ter[r]?.[c] !== undefined) ter[r][c] = 'a';
  const soaked = new Uint8Array(w * h);
  for (const [c, r] of plan.water) for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (c + dc < w && r + dr < h) soaked[(r + dr) * w + c + dc] = 1;
  const s: Sim = {
    w, h, t: 0, ter: ter.map((row) => row.join('')), state: new Uint8Array(w * h), heat: new Float32Array(w * h),
    burnT: new Float32Array(w * h), soaked, rainUntil: new Float32Array(w * h).fill(-1), ember: new Uint8Array(w * h),
    litAt: new Float32Array(w * h).fill(-1), rainQueue: [...plan.rain].sort((a, b) => a[0] - b[0]), done: false, embers: [],
    houses: 0, forestCells: 0,
  };
  for (let i = 0; i < w * h; i++) {
    const ch = s.ter[(i / w) | 0][i % w];
    if (ch === 'H') s.houses++;
    if (l.rows[(i / w) | 0][i % w] === 'f') s.forestCells++;
  }
  for (const [c, r] of l.starts) { const i = r * w + c; if (flammable(s.ter[r][c])) { s.state[i] = 1; s.litAt[i] = 0; } }
  return s;
}

export function windAt(l: FBLevel, t: number): { dir: number; strength: number } {
  let cur = l.wind[0];
  for (const step of l.wind) if (step[0] <= t + 1e-9) cur = step;
  return { dir: cur[1], strength: cur[2] };
}

/** Ignite-time multiplier for heat travelling in direction d (from burner to cell). */
export function windFactor(d: number, wind: { dir: number; strength: number }): number {
  if (wind.strength === 0) return 1;
  const [ax, ay] = DIRS[d], [bx, by] = DIRS[wind.dir];
  const dot = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
  if (dot > 0.5) return 0.5;
  if (dot < -0.5) return 2;
  return 1;
}

export function applyRain(s: Sim, c: number, r: number): void {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const x = c + dc, y = r + dr;
    if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
    const i = y * s.w + x;
    if (s.state[i] === 1) { s.state[i] = 0; s.burnT[i] = 0; }
    s.heat[i] = 0;
    s.soaked[i] = 1;
    s.rainUntil[i] = s.t + RAIN_T;
  }
}

export function step(l: FBLevel, s: Sim): void {
  if (s.done) return;
  s.embers.length = 0;
  while (s.rainQueue.length && s.rainQueue[0][0] <= s.t + 1e-9) { const [, c, r] = s.rainQueue.shift()!; applyRain(s, c, r); }
  s.t = Math.round((s.t + DT) * 1000) / 1000;
  const wind = windAt(l, s.t);
  const { w, h } = s;
  const ignite: number[] = [];
  let burning = 0;
  for (let i = 0; i < w * h; i++) {
    if (s.state[i] !== 1) continue;
    burning++;
    const ch = s.ter[(i / w) | 0][i % w];
    const before = s.burnT[i];
    s.burnT[i] += DT;
    if (wind.strength === 2 && ch === 'f' && before < EMBER_AT && s.burnT[i] >= EMBER_AT - 1e-6 && !s.ember[i]) {
      s.ember[i] = 1;
      const [dx, dy] = DIRS[wind.dir];
      const x = (i % w) + dx * 2, y = ((i / w) | 0) + dy * 2;
      if (x >= 0 && y >= 0 && x < w && y < h) { s.embers.push([i, y * w + x]); ignite.push(y * w + x); }
    }
    if (s.burnT[i] >= BURN[ch] - 1e-6) s.state[i] = 2;
  }
  for (let i = 0; i < w * h; i++) {
    if (s.state[i] !== 0) continue;
    const x = i % w, y = (i / w) | 0;
    const ch = s.ter[y][x];
    if (!flammable(ch) || s.rainUntil[i] > s.t) continue;
    let best = 0;
    for (let d = 0; d < 8; d++) {
      // Burner sits opposite to d: heat travels in direction d from (x - dx, y - dy) to (x, y).
      const nx = x - DIRS[d][0], ny = y - DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || s.state[ny * w + nx] !== 1) continue;
      best = Math.max(best, 1 / windFactor(d, wind));
    }
    if (!best) continue;
    s.heat[i] += (DT * best) / (IGNITE[ch] * (s.soaked[i] ? SOAK : 1));
    if (s.heat[i] >= 1 - 1e-6) ignite.push(i);
  }
  for (const i of ignite) {
    const ch = s.ter[(i / w) | 0][i % w];
    if (s.state[i] === 0 && flammable(ch) && !(s.rainUntil[i] > s.t)) { s.state[i] = 1; s.burnT[i] = 0; s.litAt[i] = s.t; }
  }
  if ((burning === 0 && !ignite.length && !s.rainQueue.length) || s.t >= MAX_T) s.done = true;
}

export interface Outcome { saved: number; houses: number; forestPct: number; t: number }

export function outcome(l: FBLevel, s: Sim): Outcome {
  let saved = 0, forest = 0;
  for (let i = 0; i < s.w * s.h; i++) {
    const y = (i / s.w) | 0, x = i % s.w;
    if (s.ter[y][x] === 'H' && s.litAt[i] < 0) saved++;
    if (l.rows[y][x] === 'f' && s.ter[y][x] === 'f' && s.litAt[i] < 0) forest++;
  }
  return { saved, houses: s.houses, forestPct: s.forestCells ? Math.floor((forest / s.forestCells) * 100) : 100, t: s.t };
}

export function run(l: FBLevel, plan: Plan): { sim: Sim; out: Outcome } {
  const s = makeSim(l, plan);
  while (!s.done) step(l, s);
  return { sim: s, out: outcome(l, s) };
}

/** Ignition times in the first 4 seconds (the Forecast). Same step function as the burn. */
export function forecast(l: FBLevel, plan: Plan): Float32Array {
  const s = makeSim(l, { ...plan, rain: [] });
  while (!s.done && s.t < FORECAST_T - 1e-9) step(l, s);
  return s.litAt;
}

export function starsMet(l: FBLevel, o: Outcome): [boolean, boolean, boolean] {
  const all = o.saved === o.houses;
  return [o.saved >= l.target, all, all && o.forestPct >= l.forest];
}

export function lintLevel(l: FBLevel): string[] {
  const e: string[] = [];
  const w = l.rows[0]?.length ?? 0;
  if (l.rows.some((r) => r.length !== w)) e.push('rows must be the same width');
  const p = l.solution;
  const n = (k: ToolKind) => (k === 'rain' ? p.rain.length : p[k].length);
  for (const k of ['firebreak', 'water', 'backburn', 'rain'] as ToolKind[]) if (n(k) > (l.tools[k] ?? 0)) e.push(`solution uses ${n(k)} ${k}, level allows ${l.tools[k] ?? 0}`);
  for (const k of ['firebreak', 'water', 'backburn'] as const) for (const [c, r] of p[k]) if (!canPlace(l.rows, k, c, r, l.starts)) e.push(`${k} not allowed at ${c},${r}`);
  if (!l.rows.some((r) => r.includes('H'))) e.push('no houses');
  return e;
}
