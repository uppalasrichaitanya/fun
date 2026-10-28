import type { Schema } from '../../engine/levels/schema';

// Heist 15: a 16 x 10 room, a 15 s clock, guards on fixed patrols, sweeping cameras,
// timed lasers. Fixed 1/60 s steps; the world only reacts to the player through
// noise and tools, so the scout timeline matches the run exactly.

export const W = 16;
export const H = 10;
export const DT = 1 / 60;
export const LIMIT = 15;
export const RUN = 4;
export const SNEAK = 2;
export const SPRINT = 6;
export const SPRINT_T = 1.5;
export const R = 0.3;
export const GUARD_SPEED = 2;
export const GUARD_PAUSE = 0.4;
export const GUARD_FOV = 70;
export const GUARD_RANGE = 5;
export const CAM_FOV = 60;
export const CAM_RANGE = 6;
export const SUSPICION = 0.3;
export const NOISE_RANGE = 4;
export const LOOK_T = 1.5;
export const SMOKE_T = 3;
export const VENT_T = 1;

export type ToolKind = 'smoke' | 'coin' | 'sprint';

export interface HLevel {
  name: string;
  /** "#" wall, "." floor, "~" noisy floor, "E" entrance/exit, "G" gem, "K" keycard, "D" keycard door, "V" vent. */
  rows: string[];
  /** Patrol loops (tile centres). One point = stands still facing `face`. */
  guards: { path: [number, number][]; face?: number; phase?: number }[];
  /** [x, y, centre angle deg, sweep half-angle deg, period s]. */
  cameras: [number, number, number, number, number][];
  /** [x1, y1, x2, y2, period s, on fraction, phase s]. */
  lasers: [number, number, number, number, number, number, number][];
  /** Vent pairs by index into "V" tiles in reading order: [a, b]. */
  vents: [number, number][];
  tools: Partial<Record<ToolKind, number>>;
  /** Winning input recording: [frames, bits] runs. Bits: 1 up 2 down 4 left 8 right 16 sneak. */
  solution: [number, number][];
}

export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', rows: { arr: 'string', min: H, max: H },
    guards: { arr: { obj: { path: { arr: { tuple: ['number', 'number'] }, min: 1 }, face: 'number', phase: 'number' }, opt: ['face', 'phase'] } },
    cameras: { arr: { tuple: ['number', 'number', 'number', 'number', 'number'] } },
    lasers: { arr: { tuple: ['number', 'number', 'number', 'number', 'number', 'number', 'number'] } },
    vents: { arr: { tuple: ['int', 'int'] } },
    tools: { obj: { smoke: 'int', coin: 'int', sprint: 'int' }, opt: ['smoke', 'coin', 'sprint'] },
    solution: { arr: { tuple: ['int', 'int'] } },
  },
};

export const BITS = { up: 1, down: 2, left: 4, right: 8, sneak: 16 } as const;

export class Room {
  readonly solid = new Uint8Array(W * H);
  readonly noisy = new Uint8Array(W * H);
  readonly door = new Uint8Array(W * H);
  readonly entrance: [number, number];
  readonly gem: [number, number];
  readonly card: [number, number] | null;
  readonly ventTiles: [number, number][] = [];
  readonly ventTo = new Map<number, number>();
  constructor(readonly level: HLevel) {
    let e: [number, number] = [1, 8], g: [number, number] = [8, 1], k: [number, number] | null = null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = level.rows[y][x], i = y * W + x;
      if (ch === '#') this.solid[i] = 1;
      if (ch === '~') this.noisy[i] = 1;
      if (ch === 'D') this.door[i] = 1;
      if (ch === 'E') e = [x, y];
      if (ch === 'G') g = [x, y];
      if (ch === 'K') k = [x, y];
      if (ch === 'V') this.ventTiles.push([x, y]);
    }
    this.entrance = e; this.gem = g; this.card = k;
    for (const [a, b] of level.vents) {
      const A = this.ventTiles[a], B = this.ventTiles[b];
      if (!A || !B) continue;
      this.ventTo.set(A[1] * W + A[0], B[1] * W + B[0]);
      this.ventTo.set(B[1] * W + B[0], A[1] * W + A[0]);
    }
  }
  wall(x: number, y: number, card: boolean): boolean {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const i = y * W + x;
    return !!this.solid[i] || (!!this.door[i] && !card);
  }
  /** Does a sight line from a to b pass only through open tiles (and no smoke)? */
  los(ax: number, ay: number, bx: number, by: number, smoke: Uint8Array | null): boolean {
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d * 6));
    for (let k = 1; k < n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const tx = Math.floor(x), ty = Math.floor(y);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
      const i = ty * W + tx;
      if (this.solid[i] || this.door[i]) return false;
      if (smoke && smoke[i]) return false;
    }
    // Corners: a ray squeezing between two diagonal walls is blocked.
    return true;
  }
}

// ---- guards ------------------------------------------------------------------------

interface Leg { x0: number; y0: number; x1: number; y1: number; t0: number; walk: number; ang: number; nextAng: number }

/** Precomputed patrol timeline: walk each leg, pause 0.4 s turning to the next. */
export class Patrol {
  readonly legs: Leg[] = [];
  readonly period: number;
  constructor(readonly path: [number, number][], readonly face = 0, readonly phase = 0) {
    let t = 0;
    const n = path.length;
    if (n < 2) { this.period = 1; return; }
    for (let i = 0; i < n; i++) {
      const [x0, y0] = path[i], [x1, y1] = path[(i + 1) % n], [x2, y2] = path[(i + 2) % n];
      const walk = Math.hypot(x1 - x0, y1 - y0) / GUARD_SPEED;
      const ang = Math.atan2(y1 - y0, x1 - x0), nextAng = Math.atan2(y2 - y1, x2 - x1);
      this.legs.push({ x0, y0, x1, y1, t0: t, walk, ang, nextAng });
      t += walk + GUARD_PAUSE;
    }
    this.period = t;
  }
  /** Position and facing at patrol clock τ. */
  at(tau: number): { x: number; y: number; ang: number } {
    if (this.legs.length === 0) return { x: this.path[0][0], y: this.path[0][1], ang: (this.face * Math.PI) / 180 };
    let t = ((tau + this.phase) % this.period + this.period) % this.period;
    for (const L of this.legs) {
      if (t > L.t0 + L.walk + GUARD_PAUSE) continue;
      const k = t - L.t0;
      if (k <= L.walk) { const f = L.walk ? k / L.walk : 1; return { x: L.x0 + (L.x1 - L.x0) * f, y: L.y0 + (L.y1 - L.y0) * f, ang: L.ang }; }
      const f = (k - L.walk) / GUARD_PAUSE;
      let d = L.nextAng - L.ang;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return { x: L.x1, y: L.y1, ang: L.ang + d * Math.min(1, f) };
    }
    const L = this.legs[this.legs.length - 1];
    return { x: L.x1, y: L.y1, ang: L.nextAng };
  }
}

export interface Guard {
  patrol: Patrol;
  tau: number;
  x: number; y: number; ang: number;
  /** Interruptions: look toward a noise, or walk to a coin and back. */
  mode: 'patrol' | 'look' | 'coin';
  modeT: number;
  lookAng: number;
  route: [number, number][];
  routeI: number;
  home: [number, number];
  alert: number;
}

export const camAngle = (c: HLevel['cameras'][number], t: number): number => ((c[2] + c[3] * Math.sin((2 * Math.PI * t) / c[4])) * Math.PI) / 180;
export const laserOn = (l: HLevel['lasers'][number], t: number): boolean => ((t + l[6]) % l[4] + l[4]) % l[4] < l[4] * l[5];

/** Tiles a laser covers. */
export function laserTiles(l: HLevel['lasers'][number]): [number, number][] {
  const out: [number, number][] = [];
  const [x1, y1, x2, y2] = l;
  const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let k = 0; k <= n; k++) out.push([Math.round(x1 + ((x2 - x1) * k) / Math.max(1, n)), Math.round(y1 + ((y2 - y1) * k) / Math.max(1, n))]);
  return out;
}

// ---- the run -------------------------------------------------------------------------

export type Outcome = 'run' | 'escaped' | 'caught' | 'alarm' | 'timeout';

export interface Watcher { kind: 'guard' | 'camera'; i: number }

export class Heist {
  t = 0;
  frame = 0;
  x: number; y: number;
  facing = -Math.PI / 2;
  gem = false;
  card = false;
  guards: Guard[];
  suspicion = 0;
  seenBy: Watcher | null = null;
  outcome: Outcome = 'run';
  tools: Record<ToolKind, number>;
  usedTools = 0;
  sprintT = 0;
  smokes: { x: number; y: number; t: number }[] = [];
  coins: { x: number; y: number; t: number }[] = [];
  vent: { to: number; t: number } | null = null;
  ventCool = 0;
  /** Things this step, for effects. */
  events: { kind: 'noise' | 'gem' | 'card' | 'vent' | 'smoke' | 'coin' | 'sprint' | 'spotted' | 'look' }[] = [];
  private smokeMask: Uint8Array | null = null;
  private lastNoiseTile = -1;

  constructor(readonly room: Room) {
    const L = room.level;
    [this.x, this.y] = [room.entrance[0] + 0.5, room.entrance[1] + 0.5];
    this.guards = L.guards.map((g) => {
      const patrol = new Patrol(g.path.map(([x, y]) => [x + 0.5, y + 0.5]), g.face ?? 0, g.phase ?? 0);
      const p = patrol.at(0);
      return { patrol, tau: 0, x: p.x, y: p.y, ang: p.ang, mode: 'patrol', modeT: 0, lookAng: 0, route: [], routeI: 0, home: [p.x, p.y], alert: 0 };
    });
    this.tools = { smoke: L.tools.smoke ?? 0, coin: L.tools.coin ?? 0, sprint: L.tools.sprint ?? 0 };
  }

  get timeLeft(): number { return LIMIT - this.t; }

  /** Use a tool now (recorded by the caller). */
  use(tool: ToolKind): boolean {
    if (this.outcome !== 'run' || this.tools[tool] <= 0 || this.vent) return false;
    this.tools[tool]--; this.usedTools++;
    if (tool === 'sprint') this.sprintT = SPRINT_T;
    else if (tool === 'smoke') this.smokes.push({ x: Math.floor(this.x), y: Math.floor(this.y), t: SMOKE_T });
    else {
      // Coin lands up to 4 tiles ahead (stops at walls); the nearest guard within 7 tiles walks over.
      let cx = this.x, cy = this.y;
      for (let k = 0; k < 16; k++) {
        const nx = cx + Math.cos(this.facing) * 0.25, ny = cy + Math.sin(this.facing) * 0.25;
        if (this.room.wall(Math.floor(nx), Math.floor(ny), this.card)) break;
        cx = nx; cy = ny;
      }
      const coin = { x: Math.floor(cx) + 0.5, y: Math.floor(cy) + 0.5, t: 0 };
      this.coins.push(coin);
      let best: Guard | null = null, bd = 7;
      for (const g of this.guards) { const d = Math.hypot(g.x - coin.x, g.y - coin.y); if (d < bd && g.mode !== 'coin') { bd = d; best = g; } }
      if (best) {
        best.mode = 'coin'; best.home = [best.x, best.y];
        best.route = [...this.route(best.x, best.y, coin.x, coin.y), [coin.x, coin.y]]; best.routeI = 0; best.modeT = 0;
      }
    }
    this.events.push({ kind: tool });
    return true;
  }

  /** Tile path (centres) for a guard, BFS. */
  private route(ax: number, ay: number, bx: number, by: number): [number, number][] {
    const s = Math.floor(ay) * W + Math.floor(ax), goal = Math.floor(by) * W + Math.floor(bx);
    const prev = new Int16Array(W * H).fill(-1);
    prev[s] = s;
    const q = [s];
    for (let h = 0; h < q.length && prev[goal] < 0; h++) {
      const i = q[h];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = (i % W) + dx, y = Math.floor(i / W) + dy;
        if (this.room.wall(x, y, true)) continue;
        const j = y * W + x;
        if (prev[j] >= 0) continue;
        prev[j] = i; q.push(j);
      }
    }
    if (prev[goal] < 0) return [];
    const out: [number, number][] = [];
    for (let i = goal; i !== s; i = prev[i]) out.unshift([(i % W) + 0.5, Math.floor(i / W) + 0.5]);
    return out;
  }

  step(bits: number): void {
    if (this.outcome !== 'run') return;
    this.events.length = 0;
    this.frame++;
    this.t = Math.round(this.frame * DT * 1e6) / 1e6;
    const room = this.room;
    // Player.
    if (this.vent) {
      this.vent.t -= DT;
      if (this.vent.t <= 0) { const to = this.vent.to; this.x = (to % W) + 0.5; this.y = Math.floor(to / W) + 0.5; this.vent = null; this.ventCool = 0.6; }
    } else {
      let dx = 0, dy = 0;
      if (bits & BITS.up) dy -= 1;
      if (bits & BITS.down) dy += 1;
      if (bits & BITS.left) dx -= 1;
      if (bits & BITS.right) dx += 1;
      const sneak = !!(bits & BITS.sneak) && this.sprintT <= 0;
      const sp = this.sprintT > 0 ? SPRINT : sneak ? SNEAK : RUN;
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        this.facing = Math.atan2(dy, dx);
        this.moveAxis((dx / len) * sp * DT, 0);
        this.moveAxis(0, (dy / len) * sp * DT);
        const tile = Math.floor(this.y) * W + Math.floor(this.x);
        if (room.noisy[tile] && !sneak && tile !== this.lastNoiseTile) { this.lastNoiseTile = tile; this.noise(); }
        if (!room.noisy[tile]) this.lastNoiseTile = -1;
      }
      this.sprintT = Math.max(0, this.sprintT - DT);
      const tx = Math.floor(this.x), ty = Math.floor(this.y);
      if (!this.gem && tx === room.gem[0] && ty === room.gem[1]) { this.gem = true; this.events.push({ kind: 'gem' }); }
      if (room.card && !this.card && tx === room.card[0] && ty === room.card[1]) { this.card = true; this.events.push({ kind: 'card' }); }
      this.ventCool = Math.max(0, this.ventCool - DT);
      const to = room.ventTo.get(ty * W + tx);
      if (to !== undefined && this.ventCool <= 0) { this.vent = { to, t: VENT_T }; this.events.push({ kind: 'vent' }); }
      if (this.gem && tx === room.entrance[0] && ty === room.entrance[1]) { this.outcome = 'escaped'; return; }
    }
    // Smoke and coins.
    for (const s of this.smokes) s.t -= DT;
    this.smokes = this.smokes.filter((s) => s.t > 0);
    this.smokeMask = null;
    if (this.smokes.length) {
      this.smokeMask = new Uint8Array(W * H);
      for (const s of this.smokes) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) this.smokeMask[y * W + x] = 1;
      }
    }
    this.moveGuards();
    // Lasers.
    if (!this.vent) for (const l of room.level.lasers) {
      if (!laserOn(l, this.t)) continue;
      for (const [lx, ly] of laserTiles(l)) if (Math.abs(this.x - (lx + 0.5)) < 0.5 + R * 0.5 && Math.abs(this.y - (ly + 0.5)) < 0.5 + R * 0.5 && Math.floor(this.x) === lx && Math.floor(this.y) === ly) {
        this.outcome = 'alarm'; this.seenBy = null; return;
      }
    }
    // Vision.
    const w = this.vent ? null : this.watcher();
    if (w) {
      if (!this.seenBy) this.events.push({ kind: 'spotted' });
      this.seenBy = w;
      this.suspicion += DT / SUSPICION;
      if (this.suspicion >= 1 - 1e-9) { this.outcome = 'caught'; return; }
    } else {
      this.seenBy = null;
      this.suspicion = Math.max(0, this.suspicion - DT / SUSPICION);
    }
    if (this.t >= LIMIT - 1e-9) this.outcome = 'timeout';
  }

  private moveAxis(dx: number, dy: number): void {
    const nx = this.x + dx, ny = this.y + dy;
    const x0 = Math.floor(nx - R), x1 = Math.floor(nx + R), y0 = Math.floor(ny - R), y1 = Math.floor(ny + R);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.room.wall(x, y, this.card)) return;
    this.x = nx; this.y = ny;
  }

  private noise(): void {
    this.events.push({ kind: 'noise' });
    for (const g of this.guards) {
      if (g.mode === 'coin') continue;
      if (Math.hypot(g.x - this.x, g.y - this.y) > NOISE_RANGE) continue;
      g.mode = 'look'; g.modeT = LOOK_T; g.lookAng = Math.atan2(this.y - g.y, this.x - g.x);
      this.events.push({ kind: 'look' });
    }
  }

  private moveGuards(): void {
    for (const g of this.guards) {
      g.alert = Math.max(0, g.alert - DT);
      if (g.mode === 'patrol') {
        g.tau += DT;
        const p = g.patrol.at(g.tau);
        g.x = p.x; g.y = p.y; g.ang = p.ang;
      } else if (g.mode === 'look') {
        let d = g.lookAng - g.ang;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        g.ang += Math.sign(d) * Math.min(Math.abs(d), 8 * DT);
        g.modeT -= DT;
        if (g.modeT <= 0) g.mode = 'patrol';
      } else {
        // Walk to the coin, look at it for 1 s, walk back, resume.
        const target = g.routeI < g.route.length ? g.route[g.routeI] : null;
        if (target) {
          const dx = target[0] - g.x, dy = target[1] - g.y, d = Math.hypot(dx, dy);
          g.ang = Math.atan2(dy, dx);
          const step = GUARD_SPEED * DT;
          if (d <= step) { g.x = target[0]; g.y = target[1]; g.routeI++; }
          else { g.x += (dx / d) * step; g.y += (dy / d) * step; }
        } else {
          g.modeT += DT;
          if (g.modeT > 1) {
            if (Math.hypot(g.x - g.home[0], g.y - g.home[1]) < 0.01) { g.mode = 'patrol'; continue; }
            g.route = [...this.route(g.x, g.y, g.home[0], g.home[1]), g.home]; g.routeI = 0; g.modeT = -999;
          }
        }
      }
    }
  }

  /** Who can see the player right now (null = nobody). */
  watcher(): Watcher | null {
    const room = this.room, L = room.level;
    const tile = Math.floor(this.y) * W + Math.floor(this.x);
    if (this.smokeMask && this.smokeMask[tile]) return null;
    for (let i = 0; i < this.guards.length; i++) {
      const g = this.guards[i];
      if (sees(room, g.x, g.y, g.ang, GUARD_FOV, GUARD_RANGE, this.x, this.y, this.smokeMask)) return { kind: 'guard', i };
    }
    for (let i = 0; i < L.cameras.length; i++) {
      const c = L.cameras[i];
      if (sees(room, c[0] + 0.5, c[1] + 0.5, camAngle(c, this.t), CAM_FOV, CAM_RANGE, this.x, this.y, this.smokeMask)) return { kind: 'camera', i };
    }
    return null;
  }
}

export function sees(room: Room, ox: number, oy: number, ang: number, fov: number, range: number, px: number, py: number, smoke: Uint8Array | null): boolean {
  const dx = px - ox, dy = py - oy, d = Math.hypot(dx, dy);
  if (d > range) return false;
  if (d > 0.35) {
    let a = Math.atan2(dy, dx) - ang;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    if (Math.abs(a) > ((fov / 2) * Math.PI) / 180) return false;
  }
  return room.los(ox, oy, px, py, smoke);
}

// ---- recordings -------------------------------------------------------------------------

export function expand(runs: readonly [number, number][]): number[] {
  const out: number[] = [];
  for (const [n, b] of runs) for (let k = 0; k < n; k++) out.push(b);
  return out;
}
export function compress(frames: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const b of frames) { const last = out[out.length - 1]; if (last && last[1] === b) last[0]++; else out.push([1, b]); }
  return out;
}

export function play(level: HLevel, runs: readonly [number, number][]): Heist {
  const h = new Heist(new Room(level));
  for (const b of expand(runs)) { h.step(b); if (h.outcome !== 'run') break; }
  // Keep stepping (idle) if the recording ended before an outcome.
  while (h.outcome === 'run') h.step(0);
  return h;
}

export function lintLevel(l: HLevel): string[] {
  const e: string[] = [];
  if (l.rows.some((r) => r.length !== W)) e.push(`rows must be ${W} wide`);
  const all = l.rows.join('');
  if (!all.includes('E')) e.push('no entrance');
  if (!all.includes('G')) e.push('no gem');
  if (all.includes('D') && !all.includes('K')) e.push('door without keycard');
  return e;
}
