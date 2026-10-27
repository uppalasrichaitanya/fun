import type { Schema } from '../../engine/levels/schema';

// Maze Maker rules. The monster always takes the shortest route; ties are broken
// in a fixed order (right, down, up, left), so the same maze always gives the
// same path. Pure and deterministic: the game, verifier and generator share it.

export const W = 15;
export const H = 11;
/** Neighbour order for tie-breaks: right, down, up, left. */
export const ORDER: readonly [number, number][] = [[1, 0], [0, 1], [0, -1], [-1, 0]];

export type TrapKind = 'spikes' | 'goo' | 'cannon' | 'bounce';
export type MonsterKind = 'blob' | 'runner' | 'tank' | 'hopper';
export const TRAPS: Record<TrapKind, { cost: number; name: string }> = {
  spikes: { cost: 3, name: 'Spikes' }, goo: { cost: 4, name: 'Goo' }, cannon: { cost: 8, name: 'Cannon' }, bounce: { cost: 6, name: 'Bounce pad' },
};
export const MONSTERS: Record<MonsterKind, { hp: number; speed: number; name: string }> = {
  blob: { hp: 10, speed: 2.0, name: 'Blob' }, runner: { hp: 6, speed: 3.6, name: 'Runner' },
  tank: { hp: 40, speed: 1.1, name: 'Tank' }, hopper: { hp: 12, speed: 1.8, name: 'Hopper' },
};
export const SPIKE_DMG = 4;
export const GOO_SLOW = 0.5;
export const GOO_TIME = 2;
export const CANNON_DMG = 6;
export const CANNON_EVERY = 1.5;
export const BOUNCE_BACK = 2;
export const HEARTS = 5;
export const SIM_DT = 1 / 60;

export type Wave = Partial<Record<MonsterKind, number>>;

export interface MMLevel {
  name: string;
  mode: 'puzzle' | 'defence';
  /**
   * 11 rows of 15: "." grass, "#" rock, "w" deep water (blocks), "~" shallow water
   * and "=" bridge (both walkable, but walls are not allowed on them).
   */
  rows: string[];
  start: [number, number];
  goal: [number, number];
  /** Wall budget. */
  walls: number;
  /** Puzzle: path length needed for 1 star, and the best known (3 stars). */
  target?: number;
  best?: number;
  /** Defence: trap money and the five waves. */
  money?: number;
  waves?: Wave[];
  solution: { walls: [number, number][]; traps?: [TrapKind, number, number][] };
}

const cell: Schema = { tuple: ['int', 'int'] };
export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', mode: { enum: ['puzzle', 'defence'] }, rows: { arr: 'string', min: H, max: H },
    start: cell, goal: cell, walls: 'int', target: 'int', best: 'int', money: 'int',
    waves: { arr: { obj: { blob: 'int', runner: 'int', tank: 'int', hopper: 'int' }, opt: ['blob', 'runner', 'tank', 'hopper'] }, min: 5, max: 5 },
    solution: { obj: { walls: { arr: cell }, traps: { arr: { tuple: [{ enum: Object.keys(TRAPS) }, 'int', 'int'] } } }, opt: ['traps'] },
  },
  opt: ['target', 'best', 'money', 'waves'],
};

export const idx = (c: number, r: number): number => r * W + c;
export const inside = (c: number, r: number): boolean => c >= 0 && r >= 0 && c < W && r < H;

export class Field {
  /** 1 where nothing can walk (rock). */
  readonly rock = new Uint8Array(W * H);
  /** 1 where walls and traps can go. */
  readonly buildable = new Uint8Array(W * H);
  readonly start: number;
  readonly goal: number;
  constructor(readonly level: MMLevel) {
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const ch = level.rows[r]?.[c] ?? '.';
      const i = idx(c, r);
      this.rock[i] = ch === '#' || ch === 'w' ? 1 : 0;
      this.buildable[i] = ch === '.' ? 1 : 0;
    }
    this.start = idx(level.start[0], level.start[1]);
    this.goal = idx(level.goal[0], level.goal[1]);
    this.buildable[this.start] = 0; this.buildable[this.goal] = 0;
  }
  terrain(c: number, r: number): string { return this.level.rows[r]?.[c] ?? '.'; }
}

const dist = new Int16Array(W * H);
const queue = new Int16Array(W * H);

/**
 * Shortest path from start to goal avoiding rocks and walls, as cell indices
 * (start first). Null if blocked. BFS distances from the goal, then a walk from
 * the start that always takes the first neighbour (right, down, up, left) one
 * step closer: deterministic tie-breaks.
 */
export function shortestPath(f: Field, walls: Uint8Array): number[] | null {
  dist.fill(-1);
  let head = 0, tail = 0;
  dist[f.goal] = 0; queue[tail++] = f.goal;
  while (head < tail) {
    const i = queue[head++];
    const c = i % W, r = (i / W) | 0;
    for (const [dx, dy] of ORDER) {
      const nc = c + dx, nr = r + dy;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      const j = nr * W + nc;
      if (dist[j] >= 0 || f.rock[j] || walls[j]) continue;
      dist[j] = dist[i] + 1; queue[tail++] = j;
    }
  }
  if (dist[f.start] < 0) return null;
  const path = [f.start];
  let i = f.start;
  while (i !== f.goal) {
    const c = i % W, r = (i / W) | 0;
    for (const [dx, dy] of ORDER) {
      const nc = c + dx, nr = r + dy;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      const j = nr * W + nc;
      if (dist[j] === dist[i] - 1 && !f.rock[j] && !walls[j]) { i = j; break; }
    }
    path.push(i);
  }
  return path;
}

/** Path length in tiles (steps from spawn to castle), or -1 if blocked. */
export function pathLength(f: Field, walls: Uint8Array): number {
  const p = shortestPath(f, walls);
  return p ? p.length - 1 : -1;
}

/**
 * Hopper route: may jump over exactly one player wall (two cells in a straight
 * line, landing on open ground). BFS over (cell, jumped) with the same tie-breaks.
 */
export function hopperPath(f: Field, walls: Uint8Array): number[] | null {
  const N = W * H;
  const d = new Int16Array(N * 2).fill(-1);
  const q: number[] = [];
  // Search backwards from the goal over states (cell, jumpsLeft) — reversed moves are symmetric.
  d[f.goal * 2 + 0] = 0; d[f.goal * 2 + 1] = 0;
  q.push(f.goal * 2, f.goal * 2 + 1);
  for (let h = 0; h < q.length; h++) {
    const s = q[h], i = s >> 1, j = s & 1;
    const c = i % W, r = (i / W) | 0;
    for (const [dx, dy] of ORDER) {
      const nc = c - dx, nr = r - dy;
      if (inside(nc, nr)) {
        const k = idx(nc, nr);
        if (!f.rock[k] && !walls[k] && d[k * 2 + j] < 0) { d[k * 2 + j] = d[s] + 1; q.push(k * 2 + j); }
      }
      // A jump into i from two cells away (only for states that still had their jump).
      if (j === 0) {
        const mc = c - dx, mr = r - dy, sc = c - 2 * dx, sr = r - 2 * dy;
        if (inside(sc, sr) && walls[idx(mc, mr)]) {
          const k = idx(sc, sr);
          if (!f.rock[k] && !walls[k] && d[k * 2 + 1] < 0) { d[k * 2 + 1] = d[s] + 1; q.push(k * 2 + 1); }
        }
      }
    }
  }
  let s = f.start * 2 + 1;
  if (d[s] < 0) return null;
  const path = [f.start];
  while ((s >> 1) !== f.goal) {
    const i = s >> 1, j = s & 1;
    const c = i % W, r = (i / W) | 0;
    let next = -1;
    for (const [dx, dy] of ORDER) {
      const nc = c + dx, nr = r + dy;
      if (inside(nc, nr)) {
        const k = idx(nc, nr);
        if (!f.rock[k] && !walls[k] && d[k * 2 + j] === d[s] - 1) { next = k * 2 + j; break; }
      }
      if (j === 1) {
        const mc = c + dx, mr = r + dy, ec = c + 2 * dx, er = r + 2 * dy;
        if (inside(ec, er) && walls[idx(mc, mr)]) {
          const k = idx(ec, er);
          if (!f.rock[k] && !walls[k] && d[k * 2] === d[s] - 1) { next = k * 2; break; }
        }
      }
    }
    if (next < 0) return null;
    s = next;
    path.push(s >> 1);
  }
  return path;
}

export function wallMask(list: readonly [number, number][]): Uint8Array {
  const m = new Uint8Array(W * H);
  for (const [c, r] of list) m[idx(c, r)] = 1;
  return m;
}

/** Puzzle stars: target, target + 10%, best known. */
export function puzzleGoals(l: MMLevel): [number, number, number] {
  const t = l.target ?? 0;
  return [t, Math.min(l.best ?? t, Math.ceil(t * 1.1)), l.best ?? t];
}

// ---- defence ----------------------------------------------------------------

export interface Trap { kind: TrapKind; c: number; r: number; cd: number }

export interface Monster {
  id: number;
  kind: MonsterKind;
  hp: number;
  max: number;
  path: number[];
  /** Position along the path in tiles. */
  pos: number;
  /** Last whole tile entered (for spike / goo / bounce triggers). */
  tile: number;
  slow: number;
  bounced: Set<number>;
  alive: boolean;
  arrived: boolean;
  hit: number;
}

export interface Shot { from: number; to: number; t: number }

export class DefenceSim {
  readonly monsters: Monster[] = [];
  readonly traps: Trap[];
  hearts = HEARTS;
  wave = -1;
  t = 0;
  done = false;
  /** Events since the last drain, for sounds and effects. */
  events: { type: 'spawn' | 'hit' | 'die' | 'leak' | 'shot' | 'bounce' | 'goo' | 'wave'; x: number; y: number; kind?: string }[] = [];
  shots: Shot[] = [];
  private pending: MonsterKind[] = [];
  private spawnT = 0;
  private waveGap = 1.2;
  private nextId = 1;
  private path: number[];
  private hop: number[] | null;
  private trapAt = new Map<number, Trap>();
  private steps = 0;

  constructor(readonly f: Field, readonly walls: Uint8Array, traps: readonly [TrapKind, number, number][]) {
    this.path = shortestPath(f, walls) ?? [];
    this.hop = hopperPath(f, walls);
    this.traps = traps.map(([kind, c, r]) => ({ kind, c, r, cd: CANNON_EVERY * 0.5 }));
    for (const t of this.traps) this.trapAt.set(idx(t.c, t.r), t);
  }

  get leaked(): number { return HEARTS - this.hearts; }

  step(dt = SIM_DT): void {
    if (this.done) return;
    this.t += dt;
    this.steps++;
    const waves = this.f.level.waves ?? [];
    // Waves: the next one starts once the field is clear.
    if (!this.pending.length && this.monsters.every((m) => !m.alive)) {
      if (this.wave >= waves.length - 1) { this.done = true; return; }
      this.waveGap -= dt;
      if (this.waveGap <= 0) {
        this.wave++;
        this.pending = order(waves[this.wave]);
        this.spawnT = 0;
        this.waveGap = 2.5;
        this.events.push({ type: 'wave', x: 0, y: 0 });
      }
    }
    if (this.pending.length) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        const kind = this.pending.shift()!;
        const path = kind === 'hopper' && this.hop ? this.hop : this.path;
        const hp = MONSTERS[kind].hp;
        this.monsters.push({ id: this.nextId++, kind, hp, max: hp, path, pos: 0, tile: 0, slow: 0, bounced: new Set(), alive: true, arrived: false, hit: 0 });
        this.spawnT = kind === 'tank' ? 1.3 : 0.75;
        const [x, y] = xy(this.f.start);
        this.events.push({ type: 'spawn', x, y, kind });
      }
    }
    for (const m of this.monsters) {
      if (!m.alive) continue;
      m.hit = Math.max(0, m.hit - dt);
      m.slow = Math.max(0, m.slow - dt);
      const sp = MONSTERS[m.kind].speed * (m.slow > 0 ? GOO_SLOW : 1);
      m.pos += sp * dt;
      const last = m.path.length - 1;
      if (m.pos >= last) {
        m.alive = false; m.arrived = true; this.hearts = Math.max(0, this.hearts - 1);
        const [x, y] = xy(m.path[last]);
        this.events.push({ type: 'leak', x, y, kind: m.kind });
        continue;
      }
      const tile = Math.floor(m.pos + 0.5);
      while (m.tile < tile && m.alive) {
        m.tile++;
        const at = m.path[m.tile];
        const trap = this.trapAt.get(at);
        if (!trap) continue;
        const [x, y] = xy(at);
        if (trap.kind === 'spikes') this.damage(m, SPIKE_DMG);
        else if (trap.kind === 'goo') { m.slow = GOO_TIME; this.events.push({ type: 'goo', x, y }); }
        else if (trap.kind === 'bounce' && !m.bounced.has(at)) {
          m.bounced.add(at);
          m.pos = Math.max(0, m.pos - BOUNCE_BACK);
          m.tile = Math.floor(m.pos + 0.5);
          this.events.push({ type: 'bounce', x, y });
          break;
        }
      }
    }
    for (const t of this.traps) {
      if (t.kind !== 'cannon') continue;
      t.cd -= dt;
      if (t.cd > 0) continue;
      const target = this.cannonTarget(t);
      if (!target) { t.cd = 0; continue; }
      t.cd = CANNON_EVERY;
      const p = monsterXY(target);
      this.shots.push({ from: idx(t.c, t.r), to: Math.round(p.x) + Math.round(p.y) * W, t: 0.18 });
      this.events.push({ type: 'shot', x: t.c, y: t.r });
      this.damage(target, CANNON_DMG);
    }
    for (const s of this.shots) s.t -= dt;
    this.shots = this.shots.filter((s) => s.t > 0);
    if (this.steps > 60 * 600) this.done = true; // safety: 10 minutes
  }

  /** Nearest live monster in the cannon's row with no rock or wall in between. */
  private cannonTarget(t: Trap): Monster | null {
    let best: Monster | null = null, bestD = Infinity;
    for (const m of this.monsters) {
      if (!m.alive) continue;
      const p = monsterXY(m);
      if (Math.abs(p.y - t.r) > 0.45) continue;
      const d = Math.abs(p.x - t.c);
      if (d >= bestD) continue;
      const step = p.x > t.c ? 1 : -1;
      let clear = true;
      for (let c = t.c + step; step > 0 ? c < Math.round(p.x) : c > Math.round(p.x); c += step) {
        const i = idx(c, t.r);
        if (this.f.rock[i] || this.walls[i]) { clear = false; break; }
      }
      if (clear) { best = m; bestD = d; }
    }
    return best;
  }

  private damage(m: Monster, n: number): void {
    m.hp -= n; m.hit = 0.15;
    const p = monsterXY(m);
    this.events.push({ type: 'hit', x: p.x, y: p.y });
    if (m.hp <= 0) { m.alive = false; this.events.push({ type: 'die', x: p.x, y: p.y, kind: m.kind }); }
  }

  /** Run to the end (verifier / generator). */
  run(): { hearts: number; leaked: number; t: number } {
    while (!this.done) this.step();
    return { hearts: this.hearts, leaked: this.leaked, t: this.t };
  }
}

/** Interleave a wave's monsters so mixed waves alternate. */
function order(w: Wave): MonsterKind[] {
  const left = { ...w };
  const out: MonsterKind[] = [];
  const kinds: MonsterKind[] = ['blob', 'runner', 'tank', 'hopper'];
  while (kinds.some((k) => (left[k] ?? 0) > 0)) for (const k of kinds) if ((left[k] ?? 0) > 0) { out.push(k); left[k]!--; }
  return out;
}

export const xy = (i: number): [number, number] => [i % W, (i / W) | 0];

/** Monster position in tile units (fractional, between path cells). */
export function monsterXY(m: Monster): { x: number; y: number } {
  const i = Math.min(m.path.length - 1, Math.floor(m.pos));
  const k = m.pos - i;
  const a = m.path[i], b = m.path[Math.min(m.path.length - 1, i + 1)];
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k };
}

export function lintLevel(l: MMLevel): string[] {
  const e: string[] = [];
  if (l.rows.some((r) => r.length !== W)) e.push(`rows must be ${W} wide`);
  const f = new Field(l);
  if (f.rock[f.start] || f.rock[f.goal]) e.push('start or goal on rock');
  if (l.solution.walls.length > l.walls) e.push(`solution uses ${l.solution.walls.length} walls, budget ${l.walls}`);
  for (const [c, r] of l.solution.walls) if (!f.buildable[idx(c, r)]) e.push(`solution wall on unbuildable ${c},${r}`);
  if (l.mode === 'puzzle' && (l.target === undefined || l.best === undefined)) e.push('puzzle needs target and best');
  if (l.mode === 'defence' && (!l.waves || l.money === undefined)) e.push('defence needs waves and money');
  const cost = (l.solution.traps ?? []).reduce((a, [k]) => a + TRAPS[k].cost, 0);
  if (l.money !== undefined && cost > l.money) e.push(`solution traps cost ${cost}, budget ${l.money}`);
  return e;
}
