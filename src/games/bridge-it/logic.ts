import type { Schema } from '../../engine/levels/schema';

// Bridge It: joints are point masses, beams are XPBD distance constraints with
// compliance per material; stress = strain / break strain. Vehicles are two driven
// wheels plus a light body. Fixed 1/120 s step, 10 substeps. Deterministic.

export const DT = 1 / 120;
export const SUB = 10;
export const GRID = 20;
export const GRAVITY = 600;
export const MAX_T = 25;

export type Mat = 'road' | 'road2' | 'wood' | 'steel' | 'cable';
export interface MatDef { name: string; cost: number; max: number; density: number; E: number; breakT: number; breakC: number; road: boolean; color: string; width: number }
/** Cost is per 20 u. E = force per unit strain; break strains in tension (T) and compression (C). */
export const MATS: Record<Mat, MatDef> = {
  road: { name: 'Road', cost: 10, max: 80, density: 0.02, E: 5.5e6, breakT: 0.0105, breakC: 0.0105, road: true, color: '#C98B4A', width: 7 },
  road2: { name: 'Reinforced road', cost: 25, max: 100, density: 0.03, E: 1.2e7, breakT: 0.0125, breakC: 0.0125, road: true, color: '#E0A060', width: 8 },
  wood: { name: 'Wood beam', cost: 8, max: 80, density: 0.014, E: 6e6, breakT: 0.011, breakC: 0.011, road: false, color: '#A4703F', width: 4.5 },
  steel: { name: 'Steel beam', cost: 22, max: 120, density: 0.035, E: 1.6e7, breakT: 0.014, breakC: 0.014, road: false, color: '#8FA3C8', width: 5 },
  cable: { name: 'Cable', cost: 6, max: 200, density: 0.005, E: 1.2e7, breakT: 0.016, breakC: Infinity, road: false, color: '#2A2A33', width: 2 },
};

export type VehicleKind = 'car' | 'truck' | 'bus' | 'train' | 'convoy';
export const VEHICLES: Record<VehicleKind, { mass: number; base: number; wheel: number; speed: number; count: number; gap: number; h: number; color: string }> = {
  car: { mass: 40, base: 40, wheel: 9, speed: 95, count: 1, gap: 0, h: 18, color: '#FF4F8B' },
  truck: { mass: 110, base: 56, wheel: 11, speed: 75, count: 1, gap: 0, h: 30, color: '#FFD93D' },
  bus: { mass: 90, base: 90, wheel: 10, speed: 75, count: 1, gap: 0, h: 30, color: '#38E1F5' },
  train: { mass: 220, base: 110, wheel: 9, speed: 70, count: 1, gap: 0, h: 30, color: '#9B7BFF' },
  convoy: { mass: 45, base: 40, wheel: 9, speed: 85, count: 3, gap: 34, h: 18, color: '#4ADE80' },
};

export interface BLevel {
  name: string;
  /** Road level is y = 0; cliffs end at x = gap[0] and start again at gap[1]. Water at y = water. */
  gap: [number, number];
  water: number;
  /** Fixed anchors (cliff edges, below-edge points, rocks, towers). */
  anchors: [number, number][];
  budget: number;
  mats: Mat[];
  vehicle: VehicleKind;
  /** Boat channel [x0, x1, clear y]: nothing may go below `clear y` between x0 and x1. */
  boat?: [number, number, number];
  /** Rock in the river (drawn under its anchors): [x, top y, half width]. */
  rock?: [number, number, number];
  solution: Design;
}

/** Joints after the anchors; beams reference joint indices (anchors first). */
export interface Design { joints: [number, number][]; beams: [number, number, Mat][] }

export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', gap: { tuple: ['number', 'number'] }, water: 'number',
    anchors: { arr: { tuple: ['number', 'number'] }, min: 2 }, budget: 'int',
    mats: { arr: { enum: ['road', 'road2', 'wood', 'steel', 'cable'] }, min: 1 },
    vehicle: { enum: ['car', 'truck', 'bus', 'train', 'convoy'] },
    boat: { tuple: ['number', 'number', 'number'] }, rock: { tuple: ['number', 'number', 'number'] },
    solution: { obj: { joints: { arr: { tuple: ['number', 'number'] } }, beams: { arr: { tuple: ['int', 'int', { enum: ['road', 'road2', 'wood', 'steel', 'cable'] }] } } } },
  },
  opt: ['boat', 'rock'],
};

export function beamCost(l: BLevel, d: Design): number {
  const pts = [...l.anchors, ...d.joints];
  let c = 0;
  for (const [a, b, m] of d.beams) c += Math.ceil(Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]) / GRID) * MATS[m].cost;
  return c;
}

/** Where a design breaks the boat channel rule (if any). */
export function boatClash(l: BLevel, d: Design): boolean {
  if (!l.boat) return false;
  const [x0, x1, cy] = l.boat;
  const pts = [...l.anchors, ...d.joints];
  for (const [a, b] of d.beams) {
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    for (let k = 0; k <= 10; k++) {
      const x = ax + ((bx - ax) * k) / 10, y = ay + ((by - ay) * k) / 10;
      if (x > x0 && x < x1 && y > cy) return true;
    }
  }
  return false;
}

// ---- simulation --------------------------------------------------------------------

export interface Beam { a: number; b: number; mat: Mat; rest: number; alive: boolean; strain: number; stress: number; lambda: number }

export interface Wheel { p: number; r: number; contact: boolean; spin: number }

export class Bridge {
  x: Float64Array; y: Float64Array; px: Float64Array; py: Float64Array; vx: Float64Array; vy: Float64Array; w: Float64Array;
  beams: Beam[];
  wheels: Wheel[] = [];
  /** Vehicle rigid links (particle pairs with rest lengths). */
  links: [number, number, number][] = [];
  vehicles: { wheels: [number, number]; body: [number, number]; speed: number; mass: number }[] = [];
  t = 0;
  steps = 0;
  outcome: 'run' | 'crossed' | 'fell' | 'stuck' | 'timeout' = 'run';
  broke: Beam[] = [];
  maxStress = 0;
  readonly nAnchor: number;
  readonly flagX: number;
  private stuckT = 0;
  private ground: [number, number, number, number][];

  /** `massScale` makes the vehicles heavier (the generator uses it to check stored designs hold with a margin). */
  constructor(readonly level: BLevel, design: Design, massScale = 1) {
    const pts = [...level.anchors, ...design.joints];
    this.nAnchor = level.anchors.length;
    const veh = { ...VEHICLES[level.vehicle] };
    veh.mass *= massScale;
    const nv = veh.count * 4;
    const N = pts.length + nv;
    this.x = new Float64Array(N); this.y = new Float64Array(N); this.px = new Float64Array(N); this.py = new Float64Array(N);
    this.vx = new Float64Array(N); this.vy = new Float64Array(N); this.w = new Float64Array(N);
    pts.forEach(([x, y], i) => { this.x[i] = x; this.y[i] = y; });
    const mass = new Float64Array(N);
    this.beams = design.beams.map(([a, b, mat]) => {
      const rest = Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]);
      const m = MATS[mat].density * rest;
      mass[a] += m / 2; mass[b] += m / 2;
      return { a, b, mat, rest, alive: true, strain: 0, stress: 0, lambda: 0 };
    });
    for (let i = 0; i < pts.length; i++) this.w[i] = i < this.nAnchor ? 0 : 1 / Math.max(0.3, mass[i]);
    // Vehicles start on the left cliff, nose toward the gap.
    let x0 = level.gap[0] - 70;
    for (let k = 0; k < veh.count; k++) {
      const base = pts.length + k * 4;
      const front = x0, rear = x0 - veh.base;
      const r = veh.wheel;
      const ids = [base, base + 1, base + 2, base + 3];
      [[front, -r], [rear, -r], [front - 4, -r - veh.h], [rear + 4, -r - veh.h]].forEach(([x, y], i) => { this.x[ids[i]] = x; this.y[ids[i]] = y; });
      this.w[base] = 2 / veh.mass; this.w[base + 1] = 2 / veh.mass;
      this.w[base + 2] = 1 / (veh.mass * 0.15); this.w[base + 3] = 1 / (veh.mass * 0.15);
      this.wheels.push({ p: base, r, contact: false, spin: 0 }, { p: base + 1, r, contact: false, spin: 0 });
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) this.links.push([ids[i], ids[j], Math.hypot(this.x[ids[j]] - this.x[ids[i]], this.y[ids[j]] - this.y[ids[i]])]);
      this.vehicles.push({ wheels: [base, base + 1], body: [base + 2, base + 3], speed: veh.speed, mass: veh.mass });
      x0 -= veh.base + veh.gap + 20;
    }
    this.px.set(this.x); this.py.set(this.y);
    this.flagX = level.gap[1] + 110;
    // Cliff tops as static road (one-sided, up).
    this.ground = [[-2000, 0, level.gap[0], 0], [level.gap[1], 0, level.gap[1] + 2000, 0]];
    this.settle();
  }

  /** Let the structure sag into place (heavy damping, no breaks, vehicles held) before the test. */
  private settle(): void {
    const N = this.x.length, nb = N - this.vehicles.length * 4;
    const h = DT / SUB;
    for (let k = 0; k < 240 * SUB; k++) {
      for (let i = 0; i < nb; i++) {
        this.px[i] = this.x[i]; this.py[i] = this.y[i];
        if (!this.w[i]) continue;
        this.vy[i] += GRAVITY * h;
        this.x[i] += this.vx[i] * h; this.y[i] += this.vy[i] * h;
      }
      for (const b of this.beams) b.lambda = 0;
      this.solveBeams(h);
      for (let i = 0; i < nb; i++) {
        if (!this.w[i]) continue;
        this.vx[i] = ((this.x[i] - this.px[i]) / h) * 0.96; this.vy[i] = ((this.y[i] - this.py[i]) / h) * 0.96;
      }
    }
    for (let i = 0; i < nb; i++) { this.vx[i] = 0; this.vy[i] = 0; }
    this.px.set(this.x); this.py.set(this.y);
    /** Positions after settling, for drawing the start of a test. */
    this.settled = { x: this.x.slice(), y: this.y.slice() };
  }
  settled!: { x: Float64Array; y: Float64Array };

  step(): void {
    if (this.outcome !== 'run') return;
    this.steps++;
    this.t = this.steps * DT;
    const h = DT / SUB;
    const N = this.x.length;
    for (const b of this.beams) b.stress = 0;
    for (let s = 0; s < SUB; s++) {
      for (let i = 0; i < N; i++) {
        this.px[i] = this.x[i]; this.py[i] = this.y[i];
        if (!this.w[i]) continue;
        this.vy[i] += GRAVITY * h;
        this.x[i] += this.vx[i] * h; this.y[i] += this.vy[i] * h;
      }
      for (const b of this.beams) b.lambda = 0;
      this.solveBeams(h);
      this.solveLinks();
      this.solveContacts();
      for (let i = 0; i < N; i++) {
        if (!this.w[i]) continue;
        this.vx[i] = (this.x[i] - this.px[i]) / h; this.vy[i] = (this.y[i] - this.py[i]) / h;
        this.vx[i] *= 0.9995; this.vy[i] *= 0.9995;
        // Safety cap: nothing in this world moves faster than this.
        const sp = Math.hypot(this.vx[i], this.vy[i]);
        if (sp > 1500) { this.vx[i] *= 1500 / sp; this.vy[i] *= 1500 / sp; }
      }
      this.drive(h);
    }
    // Breaks: stress = strain / break strain.
    for (const b of this.beams) {
      if (!b.alive) continue;
      const len = Math.hypot(this.x[b.b] - this.x[b.a], this.y[b.b] - this.y[b.a]);
      b.strain = (len - b.rest) / b.rest;
      const M = MATS[b.mat];
      b.stress = b.strain >= 0 ? b.strain / M.breakT : M.breakC === Infinity ? 0 : -b.strain / M.breakC;
      this.maxStress = Math.max(this.maxStress, b.stress);
      if (b.stress >= 1) { b.alive = false; this.broke.push(b); }
    }
    this.judge();
  }

  private solveBeams(h: number): void {
    for (const b of this.beams) {
      if (!b.alive) continue;
      const { a, b: c } = b;
      const wa = this.w[a], wc = this.w[c];
      if (!wa && !wc) continue;
      const dx = this.x[c] - this.x[a], dy = this.y[c] - this.y[a];
      const len = Math.hypot(dx, dy) || 1e-9;
      const C = len - b.rest;
      const M = MATS[b.mat];
      if (M.breakC === Infinity && C < 0) continue; // cables go slack when pushed
      const alpha = b.rest / M.E / (h * h);
      const dl = (-C - alpha * b.lambda) / (wa + wc + alpha);
      b.lambda += dl;
      const nx = dx / len, ny = dy / len;
      this.x[a] -= nx * dl * wa; this.y[a] -= ny * dl * wa;
      this.x[c] += nx * dl * wc; this.y[c] += ny * dl * wc;
    }
  }

  private solveLinks(): void {
    for (const [a, c, rest] of this.links) {
      const wa = this.w[a], wc = this.w[c];
      const dx = this.x[c] - this.x[a], dy = this.y[c] - this.y[a];
      const len = Math.hypot(dx, dy) || 1e-9;
      const k = (len - rest) / len / (wa + wc);
      this.x[a] += dx * k * wa; this.y[a] += dy * k * wa;
      this.x[c] -= dx * k * wc; this.y[c] -= dy * k * wc;
    }
  }

  /** Wheels against roads (one-sided, from above) and the cliff tops. */
  private solveContacts(): void {
    for (const wh of this.wheels) {
      wh.contact = false;
      const p = wh.p;
      for (const [ax, ay, bx, by] of this.ground) this.contact(wh, p, ax, ay, bx, by, -1, -1);
      for (const b of this.beams) {
        if (!b.alive || !MATS[b.mat].road) continue;
        this.contact(wh, p, this.x[b.a], this.y[b.a], this.x[b.b], this.y[b.b], b.a, b.b);
      }
    }
    // Cliff faces are solid: anything of a vehicle below road level stays in the gap.
    const [gl, gr] = this.level.gap;
    for (let i = this.x.length - this.vehicles.length * 4; i < this.x.length; i++) {
      if (this.y[i] <= 0) continue;
      const r = this.wheels.find((w) => w.p === i)?.r ?? 2;
      if (this.x[i] < gl + r && this.x[i] > gl - 40) this.x[i] = gl + r;
      else if (this.x[i] > gr - r && this.x[i] < gr + 40) this.x[i] = gr - r;
    }
  }

  private contact(wh: Wheel, p: number, ax: number, ay: number, bx: number, by: number, ia: number, ib: number): void {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) return;
    let t = ((this.x[p] - ax) * dx + (this.y[p] - ay) * dy) / L2;
    // Small absolute overhang (1 u) so wheels don't drop into the seam between pieces.
    const e = 1 / Math.sqrt(L2);
    if (t < -e || t > 1 + e) return;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t, cy = ay + dy * t;
    // Upward normal of the segment.
    const L = 1 / e;
    let nx = dy / L, ny = -dx / L;
    if (ny > 0) { nx = -nx; ny = -ny; }
    const dist = (this.x[p] - cx) * nx + (this.y[p] - cy) * ny;
    if (dist >= wh.r || dist < -wh.r * 0.8) return;
    const C = dist - wh.r;
    const wp = this.w[p], wa = ia >= 0 ? this.w[ia] : 0, wb = ib >= 0 ? this.w[ib] : 0;
    const W = wp + wa * (1 - t) * (1 - t) + wb * t * t;
    if (!W) return;
    const dl = -C / W;
    this.x[p] += nx * dl * wp; this.y[p] += ny * dl * wp;
    if (ia >= 0) { this.x[ia] -= nx * dl * wa * (1 - t); this.y[ia] -= ny * dl * wa * (1 - t); }
    if (ib >= 0) { this.x[ib] -= nx * dl * wb * t; this.y[ib] -= ny * dl * wb * t; }
    wh.contact = true;
  }

  /** Constant motor: wheels on a surface accelerate toward cruising speed along it. */
  private drive(h: number): void {
    for (const v of this.vehicles) {
      for (const p of v.wheels) {
        const wh = this.wheels.find((q) => q.p === p)!;
        if (!wh.contact) continue;
        const dv = Math.max(-500 * h, Math.min(500 * h, v.speed - this.vx[p]));
        this.vx[p] += dv;
        wh.spin += (this.vx[p] * h) / wh.r;
      }
    }
  }

  private judge(): void {
    const N0 = this.x.length - this.vehicles.length * 4;
    for (let i = N0; i < this.x.length; i++) if (this.y[i] > this.level.water) { this.outcome = 'fell'; return; }
    if (this.vehicles.every((v) => this.x[v.wheels[1]] > this.flagX)) { this.outcome = 'crossed'; return; }
    const slow = this.vehicles.every((v) => Math.abs(this.vx[v.wheels[0]]) < 3);
    this.stuckT = slow ? this.stuckT + DT : 0;
    if (this.stuckT > 3) { this.outcome = 'stuck'; return; }
    if (this.t >= MAX_T) this.outcome = 'timeout';
  }

  run(): this { while (this.outcome === 'run') this.step(); return this; }
}

export function lintLevel(l: BLevel): string[] {
  const e: string[] = [];
  const n = l.anchors.length + l.solution.joints.length;
  for (const [a, b, m] of l.solution.beams) {
    if (a >= n || b >= n) e.push('beam uses a missing joint');
    if (!l.mats.includes(m)) e.push(`solution uses ${m}, not allowed here`);
  }
  for (const [x, y] of l.solution.joints) if (x % GRID || y % GRID) e.push(`joint ${x},${y} is off the 20 u grid`);
  if (beamCost(l, l.solution) > l.budget) e.push('solution over budget');
  if (boatClash(l, l.solution)) e.push('solution blocks the boat');
  const pts = [...l.anchors, ...l.solution.joints];
  for (const [a, b, m] of l.solution.beams) if (Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]) > MATS[m].max + 1e-6) e.push(`${m} beam longer than ${MATS[m].max}`);
  return e;
}

// ---- design editing (shared by the build screen and the level generator) -------

export function pointAt(l: BLevel, d: Design, x: number, y: number): number {
  const i = l.anchors.findIndex(([ax, ay]) => ax === x && ay === y);
  if (i >= 0) return i;
  const j = d.joints.findIndex(([jx, jy]) => jx === x && jy === y);
  return j >= 0 ? l.anchors.length + j : -1;
}

export function pointXY(l: BLevel, d: Design, i: number): [number, number] {
  return i < l.anchors.length ? l.anchors[i] : d.joints[i - l.anchors.length];
}

/** Adds a beam, cut into grid-snapped pieces no longer than the material allows. Returns the pieces added. */
export function addBeam(l: BLevel, d: Design, x0: number, y0: number, x1: number, y1: number, m: Mat): number {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / MATS[m].max - 1e-9));
  let px = x0, py = y0, added = 0;
  const joint = (x: number, y: number) => {
    let i = pointAt(l, d, x, y);
    if (i < 0) { d.joints.push([x, y]); i = l.anchors.length + d.joints.length - 1; }
    return i;
  };
  for (let k = 1; k <= n; k++) {
    const x = Math.round((x0 + ((x1 - x0) * k) / n) / GRID) * GRID, y = Math.round((y0 + ((y1 - y0) * k) / n) / GRID) * GRID;
    if (x === px && y === py) continue;
    const a = joint(px, py), c = joint(x, y);
    const dup = d.beams.findIndex(([p, q]) => (p === a && q === c) || (p === c && q === a));
    if (dup >= 0) d.beams[dup][2] = m;
    else { d.beams.push([a, c, m]); added++; }
    px = x; py = y;
  }
  return added;
}

/** Drops joints no beam uses and renumbers the beams. */
export function compact(l: BLevel, d: Design): Design {
  const nA = l.anchors.length;
  const used = new Set(d.beams.flatMap(([a, b]) => [a, b]));
  const map = new Map<number, number>();
  const joints: [number, number][] = [];
  d.joints.forEach((p, j) => { if (used.has(nA + j)) { map.set(nA + j, nA + joints.length); joints.push(p); } });
  const re = (i: number) => (i < nA ? i : map.get(i)!);
  return { joints, beams: d.beams.map(([a, b, m]) => [re(a), re(b), m]) };
}

/** Copies every beam to the other side of the gap's centre line. */
export function mirror(l: BLevel, d: Design): Design {
  const out: Design = structuredClone(d);
  const cx = l.gap[0] + l.gap[1];
  for (const [a, b, m] of d.beams) {
    const [ax, ay] = pointXY(l, d, a), [bx, by] = pointXY(l, d, b);
    addBeam(l, out, cx - ax, ay, cx - bx, by, m);
  }
  return out;
}

/** Stars: crosses within budget; at or under 80%; at or under 60%. */
export function starsMet(l: BLevel, d: Design, crossed: boolean): [boolean, boolean, boolean] {
  const c = beamCost(l, d);
  return [crossed && c <= l.budget, crossed && c <= l.budget * 0.8, crossed && c <= l.budget * 0.6];
}
