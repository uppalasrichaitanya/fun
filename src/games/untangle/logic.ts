import { hashString, Rng } from '../../engine/rng';

export interface Puzzle {
  level: number;
  /** Positions with zero crossings (normalised to 0..1), for the demo and the tests. */
  solution: { x: number; y: number }[];
  /** Scrambled start positions (0..1). */
  start: { x: number; y: number }[];
  edges: [number, number][];
  startCrossings: number;
}

/** Lines per level, from the spec table (16+ is endless at 10 lines). */
export function linesFor(level: number): number {
  if (level <= 1) return 4;
  if (level <= 3) return 5;
  if (level <= 6) return 6;
  if (level <= 9) return 7;
  if (level <= 12) return 8;
  if (level <= 15) return 9;
  return 10;
}

interface Line { px: number; py: number; dx: number; dy: number }

function intersect(a: Line, b: Line): { x: number; y: number; ta: number } | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-9) return null;
  const ta = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return { x: a.px + a.dx * ta, y: a.py + a.dy * ta, ta };
}

/**
 * Line-arrangement puzzle: L lines in general position, every pairwise
 * intersection is a dot, consecutive intersections along a line are joined.
 * Planar by construction; scrambled onto a circle.
 */
export function makePuzzle(level: number, salt = 0): Puzzle {
  const L = linesFor(level);
  const rng = new Rng(hashString(`untangle:${level}:${salt}`));
  let lines: Line[] = [];
  let pts: { x: number; y: number }[] = [];
  let edges: [number, number][] = [];
  for (let attempt = 0; attempt < 4000; attempt++) {
    lines = [];
    // Angles spread around the half-turn with jitter, so no two lines are near-parallel.
    const slots = rng.shuffle([...Array(L).keys()]);
    for (let i = 0; i < L; i++) {
      const a = (slots[i] + rng.range(0.25, 0.75)) * Math.PI / L;
      lines.push({ px: rng.range(0.3, 0.7), py: rng.range(0.3, 0.7), dx: Math.cos(a), dy: Math.sin(a) });
    }
    const ok = generalPosition(lines);
    if (!ok) continue;
    const r = build(lines);
    pts = r.pts; edges = r.edges;
    break;
  }
  if (!pts.length) throw new Error(`untangle: no general-position lines for level ${level}`);
  // Normalise the solved layout into the unit square (with a margin).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const solution = pts.map((p) => ({ x: 0.08 + 0.84 * (p.x - minX) / span + 0.42 * (1 - (maxX - minX) / span), y: 0.08 + 0.84 * (p.y - minY) / span + 0.42 * (1 - (maxY - minY) / span) }));
  // Scramble on a circle; reshuffle until genuinely tangled.
  const n = pts.length;
  let start: { x: number; y: number }[] = [];
  let crossings = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    const order = rng.shuffle([...Array(n).keys()]);
    start = new Array(n);
    order.forEach((v, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      start[v] = { x: 0.5 + Math.cos(a) * 0.42, y: 0.5 + Math.sin(a) * 0.42 };
    });
    crossings = countCrossings(start, edges);
    if (crossings >= L * 2) break;
  }
  return { level, solution, start, edges, startCrossings: crossings };
}

/** No two lines (near-)parallel, no three through one point, intersections not absurdly far out. */
function generalPosition(lines: Line[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = intersect(lines[i], lines[j]);
      if (!p) return false;
      const ang = Math.abs(lines[i].dx * lines[j].dy - lines[i].dy * lines[j].dx);
      if (ang < 0.09) return false;
      if (p.x < -5 || p.x > 6 || p.y < -5 || p.y > 6) return false;
      for (let k = 0; k < lines.length; k++) {
        if (k === i || k === j) continue;
        const l = lines[k];
        const d = Math.abs((p.x - l.px) * l.dy - (p.y - l.py) * l.dx);
        if (d < 0.006) return false;
      }
    }
  }
  return true;
}

function build(lines: Line[]): { pts: { x: number; y: number }[]; edges: [number, number][] } {
  const pts: { x: number; y: number }[] = [];
  const id = new Map<string, number>();
  const onLine: { t: number; v: number }[][] = lines.map(() => []);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = intersect(lines[i], lines[j])!;
      const v = pts.length;
      pts.push({ x: p.x, y: p.y });
      id.set(`${i},${j}`, v);
      onLine[i].push({ t: p.ta, v });
      const q = intersect(lines[j], lines[i])!;
      onLine[j].push({ t: q.ta, v });
    }
  }
  const edges: [number, number][] = [];
  for (const list of onLine) {
    list.sort((a, b) => a.t - b.t);
    for (let k = 1; k < list.length; k++) edges.push([list[k - 1].v, list[k].v]);
  }
  return { pts, edges };
}

// ---- crossings -------------------------------------------------------------------

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const EPS = 1e-9;

function onSeg(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return Math.min(ax, bx) - EPS <= px && px <= Math.max(ax, bx) + EPS && Math.min(ay, by) - EPS <= py && py <= Math.max(ay, by) + EPS;
}

/**
 * Do segments (a,b) and (c,d) cross? Edges that share an endpoint never count.
 * Collinear overlap and an endpoint lying on the other segment do count.
 */
export function segCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  if (Math.abs(d1) <= EPS && onSeg(cx, cy, dx, dy, ax, ay)) return true;
  if (Math.abs(d2) <= EPS && onSeg(cx, cy, dx, dy, bx, by)) return true;
  if (Math.abs(d3) <= EPS && onSeg(ax, ay, bx, by, cx, cy)) return true;
  if (Math.abs(d4) <= EPS && onSeg(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

export function edgesCross(p: { x: number; y: number }[], e: [number, number], f: [number, number]): boolean {
  if (e[0] === f[0] || e[0] === f[1] || e[1] === f[0] || e[1] === f[1]) return false;
  const a = p[e[0]], b = p[e[1]], c = p[f[0]], d = p[f[1]];
  return segCross(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
}

export function countCrossings(p: { x: number; y: number }[], edges: [number, number][]): number {
  let n = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) if (edgesCross(p, edges[i], edges[j])) n++;
  return n;
}

/**
 * Crossing bookkeeping with cheap updates: moving one dot only re-tests the
 * edges touching it.
 */
export class Crossings {
  /** Crossings per edge. */
  per: Int32Array;
  total = 0;
  private incident: number[][];

  constructor(private p: { x: number; y: number }[], private edges: [number, number][]) {
    this.per = new Int32Array(edges.length);
    this.incident = p.map(() => []);
    edges.forEach((e, i) => { this.incident[e[0]].push(i); this.incident[e[1]].push(i); });
    this.recount();
  }

  recount(): number {
    this.per.fill(0);
    this.total = 0;
    const E = this.edges;
    for (let i = 0; i < E.length; i++) {
      for (let j = i + 1; j < E.length; j++) {
        if (edgesCross(this.p, E[i], E[j])) { this.per[i]++; this.per[j]++; this.total++; }
      }
    }
    return this.total;
  }

  /** Call after moving dot v (the positions array is shared). */
  moved(v: number, before: { x: number; y: number }): void {
    const E = this.edges, inc = this.incident[v];
    const now = this.p[v];
    // Remove crossings measured at the old position, then add the new ones.
    for (const sign of [-1, 1]) {
      if (sign < 0) this.p[v] = before;
      else this.p[v] = now;
      for (const i of inc) {
        for (let j = 0; j < E.length; j++) {
          if (inc.includes(j)) continue; // includes i itself; edges sharing v never cross
          if (edgesCross(this.p, E[i], E[j])) { this.per[i] += sign; this.per[j] += sign; this.total += sign; }
        }
      }
    }
  }

  /** Dot with the most crossings on its edges (for hints). */
  worst(): number {
    let best = -1, bestN = 0;
    this.incident.forEach((inc, v) => {
      const n = inc.reduce((a, i) => a + this.per[i], 0);
      if (n > bestN) { bestN = n; best = v; }
    });
    return best;
  }

  degree(v: number): number[] { return this.incident[v]; }
}
