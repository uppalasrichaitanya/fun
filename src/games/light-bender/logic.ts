import type { Schema } from '../../engine/levels/schema';

// Light Bender rules: a grid ray march between tile centres, 4 directions only.
// Pure and deterministic; shared by the game, the level verifier and the generator.

export type Dir = 0 | 1 | 2 | 3; // right, down, left, up
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;
export const opp = (d: number): Dir => ((d + 2) % 4) as Dir;

/** Colours are RGB bit masks: 1 red, 2 green, 4 blue; 7 = white. */
export const WHITE = 7;
export const COLOR_HEX: Record<number, string> = {
  1: '#FF4F6D', 2: '#4ADE80', 3: '#FFD93D', 4: '#4F8BFF', 5: '#E05BFF', 6: '#38E1F5', 7: '#E8FBFF',
};

export type Kind = 'mirror' | 'oneway' | 'splitter' | 'filter-r' | 'filter-g' | 'filter-b' | 'combiner';
export const KINDS: Kind[] = ['mirror', 'oneway', 'splitter', 'filter-r', 'filter-g', 'filter-b', 'combiner'];
/** How many orientations each piece cycles through when tapped. */
export const TURNS: Record<Kind, number> = { mirror: 2, oneway: 4, splitter: 2, 'filter-r': 1, 'filter-g': 1, 'filter-b': 1, combiner: 4 };
export const FILTER_COLOR: Partial<Record<Kind, number>> = { 'filter-r': 1, 'filter-g': 2, 'filter-b': 4 };

export type Thing =
  | ['emit', number, number, number, number]       // c, r, dir, colour
  | ['crystal', number, number, number]            // c, r, colour (7 = any)
  | ['gem', number, number]                        // optional prism gem
  | ['portal', number, number, number]             // c, r, pair id
  | ['fixed', number, number, Kind, number];       // c, r, kind, orientation

export type Placed = [Kind, number, number, number]; // kind, c, r, orientation

export interface LBLevel {
  name: string;
  w: number;
  h: number;
  /** Terrain rows: "." empty, "#" absorber wall, "o" glass block. */
  rows: string[];
  things: Thing[];
  inv: Partial<Record<Kind, number>>;
  par: number;
  solution: Placed[];
}

export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', w: 'int', h: 'int',
    rows: { arr: 'string', min: 4, max: 12 },
    things: { arr: { arr: { or: ['int', 'string'] }, min: 3, max: 5 }, min: 2 },
    inv: { obj: Object.fromEntries(KINDS.map((k) => [k, 'int'])), opt: KINDS },
    par: 'int',
    solution: { arr: { tuple: [{ enum: KINDS }, 'int', 'int', 'int'] } },
  },
};

export interface Piece { kind: Kind; c: number; r: number; o: number; fixed: boolean }

export interface Beam {
  /** Polyline in cell units (cell centres are x + 0.5). Filters and portals start a new beam. */
  pts: number[];
  color: number;
  end: 'wall' | 'edge' | 'loop' | 'block' | 'absorb' | 'cap' | 'pass';
  /** Steps travelled before this beam started (for the draw-on animation). */
  start: number;
  steps: number;
}

export interface Trace {
  beams: Beam[];
  /** Per crystal (things order, gems included): lit or not. */
  lit: boolean[];
  solved: boolean;
  gemLit: boolean;
  steps: number;
  /** Points where the beam hit a wall (for sparks), in cell units. */
  hits: { x: number; y: number; color: number }[];
  /** Combiner output colours by cell index. */
  combined: Map<number, number>;
  /** Step at which each cell was first entered (-1 = never), in processing order. */
  visit: Int16Array;
}

export const MAX_STEPS = 400;

const MIRROR_MAP = [[3, 2, 1, 0], [1, 0, 3, 2]] as const; // '/' and '\'
const ONEWAY_N = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;

export class Board {
  readonly w: number;
  readonly h: number;
  /** 0 empty, 1 wall, 2 glass. */
  readonly terrain: Uint8Array;
  readonly emitters: { c: number; r: number; d: Dir; color: number }[] = [];
  readonly crystals: { c: number; r: number; color: number; gem: boolean }[] = [];
  readonly portals = new Map<number, number>();
  readonly fixed: Piece[] = [];
  /** Cells that hold something fixed (no pieces allowed). */
  readonly blocked: Uint8Array;
  /** Crystal index per cell (-1 = none) and emitter flags, for the march. */
  readonly crystalAt: Int16Array;
  readonly emitterAt: Uint8Array;
  /** Per-cell piece lookup reused by `trace` (always left empty). */
  readonly scratch: (Piece | undefined)[];

  constructor(readonly level: LBLevel) {
    const { w, h } = level;
    this.w = w; this.h = h;
    this.terrain = new Uint8Array(w * h);
    this.blocked = new Uint8Array(w * h);
    this.crystalAt = new Int16Array(w * h).fill(-1);
    this.emitterAt = new Uint8Array(w * h);
    this.scratch = new Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const ch = level.rows[r]?.[c] ?? '.';
      const t = ch === '#' ? 1 : ch === 'o' ? 2 : 0;
      this.terrain[r * w + c] = t;
      if (t) this.blocked[r * w + c] = 1;
    }
    const pairs = new Map<number, number>();
    for (const t of level.things) {
      const i = t[2] * w + t[1];
      this.blocked[i] = 1;
      if (t[0] === 'emit') { this.emitters.push({ c: t[1], r: t[2], d: t[3] as Dir, color: t[4] || WHITE }); this.emitterAt[i] = 1; }
      else if (t[0] === 'crystal') { this.crystalAt[i] = this.crystals.length; this.crystals.push({ c: t[1], r: t[2], color: t[3] || WHITE, gem: false }); }
      else if (t[0] === 'gem') { this.crystalAt[i] = this.crystals.length; this.crystals.push({ c: t[1], r: t[2], color: WHITE, gem: true }); }
      else if (t[0] === 'fixed') this.fixed.push({ kind: t[3], c: t[1], r: t[2], o: t[4], fixed: true });
      else if (t[0] === 'portal') {
        const other = pairs.get(t[3]);
        if (other === undefined) pairs.set(t[3], i);
        else { this.portals.set(i, other); this.portals.set(other, i); }
      }
    }
  }

  idx(c: number, r: number): number { return r * this.w + c; }
  inside(c: number, r: number): boolean { return c >= 0 && r >= 0 && c < this.w && r < this.h; }
  /** Can a player piece go here? */
  open(c: number, r: number): boolean { return this.inside(c, r) && !this.blocked[this.idx(c, r)]; }
}

/** March every beam through the board with the given player pieces. `lite` skips drawing data (solver). */
export function trace(b: Board, placed: readonly Piece[], lite = false): Trace {
  const grid = b.scratch;
  for (const p of b.fixed) grid[b.idx(p.c, p.r)] = p;
  for (const p of placed) grid[b.idx(p.c, p.r)] = p;
  // Combiners need their inputs first: iterate until the outputs stop changing.
  let combined = new Map<number, number>();
  let result: Trace | null = null;
  try {
    for (let iter = 0; iter < 6; iter++) {
      const inputs = new Map<number, number>();
      result = march(b, grid, combined, inputs, lite);
      let same = inputs.size === combined.size;
      if (same) for (const [k, v] of inputs) if (combined.get(k) !== v) { same = false; break; }
      if (same) break;
      const next = new Map(combined);
      for (const [k, v] of inputs) next.set(k, (next.get(k) ?? 0) | v);
      combined = next;
    }
  } finally {
    for (const p of b.fixed) grid[b.idx(p.c, p.r)] = undefined;
    for (const p of placed) grid[b.idx(p.c, p.r)] = undefined;
  }
  return result!;
}

function march(b: Board, pieceAt: (Piece | undefined)[], combined: Map<number, number>, inputs: Map<number, number>, lite: boolean): Trace {
  const beams: Beam[] = [];
  const lit = b.crystals.map(() => false);
  const hits: Trace['hits'] = [];
  const seen = new Uint8Array(b.w * b.h * 4);
  const visit = new Int16Array(b.w * b.h).fill(-1);
  const { crystalAt, emitterAt, terrain, portals, w } = b;
  let steps = 0;
  const queue: { c: number; r: number; d: number; color: number; start: number }[] = [];
  for (const e of b.emitters) queue.push({ c: e.c, r: e.r, d: e.d, color: e.color, start: 0 });
  for (const [i, color] of combined) {
    const p = pieceAt[i];
    if (p?.kind === 'combiner' && color) queue.push({ c: i % w, r: Math.floor(i / w), d: p.o, color, start: 0 });
  }

  for (let qi = 0; qi < queue.length; qi++) {
    const s = queue[qi];
    let { c, r, d, color } = s;
    let beam: Beam = { pts: lite ? [] : [c + 0.5, r + 0.5], color, end: 'edge', start: s.start, steps: 0 };
    beams.push(beam);
    const point = (x: number, y: number) => { if (!lite) beam.pts.push(x, y); };
    const restart = () => {
      beam.end = 'pass';
      beam = { pts: lite ? [] : [c + 0.5, r + 0.5], color, end: 'edge', start: beam.start + beam.steps, steps: 0 };
      beams.push(beam);
    };
    for (;;) {
      if (steps >= MAX_STEPS) { point(c + 0.5, r + 0.5); beam.end = 'cap'; break; }
      const nc = c + DX[d], nr = r + DY[d];
      if (nc < 0 || nr < 0 || nc >= w || nr >= b.h) { point(c + 0.5 + DX[d] * 0.5, r + 0.5 + DY[d] * 0.5); beam.end = 'edge'; break; }
      const i = nr * w + nc;
      const bit = 1 << color;
      if (seen[i * 4 + d] & bit) { point(nc + 0.5, nr + 0.5); beam.end = 'loop'; break; }
      seen[i * 4 + d] |= bit;
      c = nc; r = nr; steps++; beam.steps++;
      if (visit[i] < 0) visit[i] = steps;
      if (terrain[i] === 1 || emitterAt[i]) {
        const x = c + 0.5 - DX[d] * 0.5, y = r + 0.5 - DY[d] * 0.5;
        point(x, y); if (!lite) hits.push({ x, y, color }); beam.end = 'wall'; break;
      }
      const k = crystalAt[i];
      if (k >= 0) { const want = b.crystals[k].color; if (want === WHITE || want === color) lit[k] = true; }
      const p = pieceAt[i];
      if (p) {
        if (p.kind === 'mirror') { point(c + 0.5, r + 0.5); d = MIRROR_MAP[p.o & 1][d]; continue; }
        if (p.kind === 'splitter') {
          point(c + 0.5, r + 0.5);
          queue.push({ c, r, d: MIRROR_MAP[p.o & 1][d], color, start: beam.start + beam.steps });
          continue;
        }
        if (p.kind === 'oneway') {
          const n = ONEWAY_N[p.o & 3];
          point(c + 0.5, r + 0.5);
          if (DX[d] * n[0] + DY[d] * n[1] < 0) { d = MIRROR_MAP[p.o & 1][d]; continue; }
          beam.end = 'block'; if (!lite) hits.push({ x: c + 0.5, y: r + 0.5, color }); break;
        }
        if (p.kind === 'combiner') {
          point(c + 0.5, r + 0.5);
          if (opp(d) === p.o) { beam.end = 'block'; if (!lite) hits.push({ x: c + 0.5, y: r + 0.5, color }); break; }
          inputs.set(i, (inputs.get(i) ?? 0) | color);
          beam.end = 'absorb'; break;
        }
        const f = FILTER_COLOR[p.kind];
        if (f !== undefined && f !== color) { point(c + 0.5, r + 0.5); color = f; restart(); }
        continue;
      }
      const to = portals.get(i);
      if (to !== undefined) {
        point(c + 0.5, r + 0.5);
        // The beam reappears at the partner portal, same direction.
        c = to % w; r = Math.floor(to / w);
        restart();
      }
    }
  }
  let crystalsOk = true, any = false, gemLit = false;
  b.crystals.forEach((k, i) => { if (k.gem) { if (lit[i]) gemLit = true; } else { any = true; if (!lit[i]) crystalsOk = false; } });
  return { beams, lit, hits, steps, combined, visit, solved: crystalsOk && any, gemLit };
}

/** Player pieces from a stored solution. */
export function piecesFrom(sol: readonly Placed[]): Piece[] {
  return sol.map(([kind, c, r, o]) => ({ kind, c, r, o, fixed: false }));
}

/** Level sanity checks beyond the schema. */
export function lintLevel(l: LBLevel): string[] {
  const e: string[] = [];
  if (l.rows.length !== l.h || l.rows.some((row) => row.length !== l.w)) e.push(`rows must be ${l.h} strings of ${l.w}`);
  if (!l.things.some((t) => t[0] === 'emit')) e.push('no emitter');
  if (!l.things.some((t) => t[0] === 'crystal')) e.push('no crystal');
  const b = new Board(l);
  const used: Record<string, number> = {};
  for (const [k, c, r] of l.solution) {
    used[k] = (used[k] ?? 0) + 1;
    if (!b.open(c, r)) e.push(`solution piece on a blocked cell ${c},${r}`);
  }
  for (const [k, n] of Object.entries(used)) if (n > (l.inv[k as Kind] ?? 0)) e.push(`solution uses ${n} ${k}, inventory has ${l.inv[k as Kind] ?? 0}`);
  return e;
}
