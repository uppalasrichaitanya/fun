import type { Schema } from '../../engine/levels/schema';

// Switchyard: a directed track graph, trains as 2-unit intervals along their path,
// switches flipped by recorded events. Fixed 1/60 s steps; fully deterministic.

export const DT = 1 / 60;
export const TRAIN_LEN = 2;
export const SPEED = 2.2;
export const EXPRESS = 1.5;
export const COLORS = ['#FF4F6D', '#4F8BFF', '#FFD93D', '#4ADE80', '#B07BFF', '#FF9F43'];
export const COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Green', 'Purple', 'Orange'];

export type NodeKind = 'tunnel' | 'buffer' | 'switch' | 'merge' | 'cross' | 'join' | 'stop' | 'station' | 'end';
export interface NodeDef { k: NodeKind; x: number; y: number; c?: number; timed?: number; key?: number }
/** [from node, to node, intermediate points]. Switch outs: the first listed edge is "straight" (state 0). */
export type EdgeDef = [number, number, [number, number][]?];
/** [time s, tunnel node, colour, express 0/1, via colour or -1]. */
export type TrainDef = [number, number, number, number, number];
/** [time s, switch node, action]: f flip, h hold (timed switch), r release. */
export type Event = [number, number, 'f' | 'h' | 'r'];

export interface SYLevel {
  name: string;
  w: number;
  h: number;
  nodes: NodeDef[];
  edges: EdgeDef[];
  trains: TrainDef[];
  par: number;
  solution: Event[];
}

export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', w: 'number', h: 'number',
    nodes: { arr: { obj: { k: { enum: ['tunnel', 'buffer', 'switch', 'merge', 'cross', 'join', 'stop', 'station', 'end'] }, x: 'number', y: 'number', c: 'int', timed: 'number', key: 'int' }, opt: ['c', 'timed', 'key'] } },
    edges: { arr: { arr: 'any', min: 2, max: 3 } },
    trains: { arr: { tuple: ['number', 'int', 'int', 'int', 'int'] }, min: 1 },
    par: 'int',
    solution: { arr: { tuple: ['number', 'int', { enum: ['f', 'h', 'r'] }] } },
  },
};

export interface Edge { id: number; a: number; b: number; pts: [number, number][]; len: number; cum: number[] }

export class Network {
  readonly edges: Edge[];
  readonly outs: number[][];
  readonly ins: number[][];
  /** Cross nodes: in-edge -> out-edge. */
  readonly pass = new Map<number, number>();
  /** Switch nodes in key order (1-9). */
  readonly switches: number[];

  constructor(readonly level: SYLevel) {
    const N = level.nodes;
    this.outs = N.map(() => []);
    this.ins = N.map(() => []);
    this.edges = level.edges.map(([a, b, via], id) => {
      const pts: [number, number][] = [[N[a].x, N[a].y], ...(via ?? []), [N[b].x, N[b].y]];
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      this.outs[a].push(id); this.ins[b].push(id);
      return { id, a, b, pts, len: cum[cum.length - 1], cum };
    });
    N.forEach((n, i) => {
      if (n.k !== 'cross') return;
      // Pair each in-edge with the out-edge that keeps its heading.
      for (const e of this.ins[i]) {
        const hin = this.heading(e, 1);
        let best = -1, bd = -2;
        for (const o of this.outs[i]) { const h = this.heading(o, 0); const d = Math.cos(h - hin); if (d > bd) { bd = d; best = o; } }
        this.pass.set(e, best);
      }
    });
    this.switches = N.map((n, i) => ({ n, i })).filter((x) => x.n.k === 'switch').sort((a, b) => (a.n.key ?? 99) - (b.n.key ?? 99) || a.n.x - b.n.x || a.n.y - b.n.y).map((x) => x.i);
  }

  /** Heading (radians) at the start (end = 0) or end (end = 1) of an edge. */
  heading(e: number, end: 0 | 1): number {
    const p = this.edges[e].pts;
    const [a, b] = end ? [p[p.length - 2], p[p.length - 1]] : [p[0], p[1]];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  /** Point at distance s along an edge. */
  at(e: number, s: number): { x: number; y: number; ang: number } {
    const E = this.edges[e];
    s = Math.max(0, Math.min(E.len, s));
    let i = 1;
    while (i < E.cum.length - 1 && E.cum[i] < s) i++;
    const k = (s - E.cum[i - 1]) / Math.max(1e-9, E.cum[i] - E.cum[i - 1]);
    const [ax, ay] = E.pts[i - 1], [bx, by] = E.pts[i];
    return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, ang: Math.atan2(by - ay, bx - ax) };
  }

  /** Where a train arriving at node n via edge e goes next (-1 = it stops here). */
  next(n: number, e: number, sw: Int8Array): number {
    const node = this.level.nodes[n];
    if (node.k === 'switch') return this.outs[n][sw[n] ?? 0] ?? -1;
    if (node.k === 'cross') return this.pass.get(e) ?? -1;
    if (node.k === 'merge' || node.k === 'join' || node.k === 'stop') return this.outs[n][0] ?? -1;
    return -1;
  }
}

export interface Train {
  id: number;
  color: number;
  via: number;
  speed: number;
  /** Edges entered, with the travelled distance at entry. */
  path: { e: number; s0: number }[];
  /** Total distance travelled by the head. */
  s: number;
  visited: boolean;
  state: 'wait' | 'run' | 'home' | 'crash';
  spawn: number;
  tunnel: number;
}

export type Fail = { kind: 'crash' | 'wrong' | 'dead' | 'via'; trains: number[]; x: number; y: number };

export class Sim {
  t = 0;
  steps = 0;
  sw: Int8Array;
  held: Uint8Array;
  trains: Train[];
  fail: Fail | null = null;
  delivered = 0;
  flips = 0;
  /** Things that happened this step, for sound and effects. */
  events: { kind: 'flip' | 'home' | 'spawn' | 'auto' | 'near'; node?: number; train?: number }[] = [];
  private queue: Event[];
  private nearCool = new Map<string, number>();

  constructor(readonly net: Network, events: readonly Event[] = []) {
    const L = net.level;
    this.sw = new Int8Array(L.nodes.length);
    this.held = new Uint8Array(L.nodes.length);
    this.trains = L.trains.map(([t, tunnel, color, express, via], id) => ({
      id, color, via, speed: SPEED * (express ? EXPRESS : 1), path: [], s: 0, visited: via < 0, state: 'wait', spawn: t, tunnel,
    }));
    this.queue = [...events].sort((a, b) => a[0] - b[0]);
  }

  /** Endless mode keeps going until a failure. */
  endless = false;

  get done(): boolean { return !!this.fail || (!this.endless && this.trains.every((t) => t.state === 'home')); }

  /** Endless: add a train that spawns at `t`. */
  addTrain([t, tunnel, color, express, via]: TrainDef): void {
    const id = this.trains.length;
    this.trains.push({ id, color, via, speed: SPEED * (express ? EXPRESS : 1), path: [], s: 0, visited: via < 0, state: 'wait', spawn: t, tunnel });
  }

  /** Is the start of a tunnel's track clear (so a train can enter safely)? */
  tunnelFree(tunnel: number, room = TRAIN_LEN * 2): boolean {
    const e = this.net.outs[tunnel][0];
    return !this.trains.some((t) => (t.state === 'run' && this.pieces(t).some(([pe, a]) => pe === e && a < room)) || (t.state === 'wait' && t.tunnel === tunnel));
  }

  /** Apply a player action now (recorded by the caller at `this.t`). */
  act(node: number, a: 'f' | 'h' | 'r'): void {
    if (a === 'f') { this.sw[node] ^= 1; this.flips++; this.events.push({ kind: 'flip', node }); }
    else this.held[node] = a === 'h' ? 1 : 0;
  }

  step(): void {
    if (this.done) return;
    this.events.length = 0;
    while (this.queue.length && this.queue[0][0] <= this.t + 1e-9) { const [, n, a] = this.queue.shift()!; this.act(n, a); }
    const net = this.net, L = net.level;
    const prevT = this.t;
    this.steps++;
    this.t = Math.round(this.steps * DT * 1e6) / 1e6;
    // Timed switches flip themselves every N seconds unless held.
    L.nodes.forEach((n, i) => {
      if (n.k !== 'switch' || !n.timed) return;
      if (Math.floor(this.t / n.timed) !== Math.floor(prevT / n.timed) && !this.held[i]) { this.sw[i] ^= 1; this.events.push({ kind: 'auto', node: i }); }
    });
    for (const tr of this.trains) {
      if (tr.state === 'wait' && this.t >= tr.spawn - 1e-9) {
        tr.state = 'run'; tr.path = [{ e: net.outs[tr.tunnel][0], s0: 0 }]; tr.s = 0;
        this.events.push({ kind: 'spawn', train: tr.id });
      }
      if (tr.state !== 'run') continue;
      tr.s += tr.speed * DT;
      // Cross nodes as the head reaches the end of each edge.
      for (;;) {
        const cur = tr.path[tr.path.length - 1];
        const E = net.edges[cur.e];
        if (tr.s - cur.s0 < E.len) break;
        const node = L.nodes[E.b];
        if (node.k === 'stop' && node.c === tr.via) tr.visited = true;
        if (node.k === 'station') {
          if (node.c !== tr.color) return this.failWith('wrong', [tr.id], node.x, node.y);
          if (!tr.visited) return this.failWith('via', [tr.id], node.x, node.y);
          tr.state = 'home'; this.delivered++; this.events.push({ kind: 'home', train: tr.id, node: E.b });
          break;
        }
        const nx = net.next(E.b, cur.e, this.sw);
        if (nx < 0) return this.failWith('dead', [tr.id], node.x, node.y);
        tr.path.push({ e: nx, s0: cur.s0 + E.len });
      }
    }
    this.collide();
  }

  private failWith(kind: Fail['kind'], trains: number[], x: number, y: number): void {
    this.fail = { kind, trains, x, y };
    for (const id of trains) this.trains[id].state = 'crash';
  }

  /** Occupied pieces of track: [edge, from, to] in edge coordinates. */
  pieces(tr: Train): [number, number, number][] {
    const out: [number, number, number][] = [];
    const lo = tr.s - TRAIN_LEN;
    for (let i = tr.path.length - 1; i >= 0; i--) {
      const p = tr.path[i];
      const len = this.net.edges[p.e].len;
      const a = Math.max(0, lo - p.s0), b = Math.min(len, tr.s - p.s0);
      if (b >= a) out.push([p.e, a, b]);
      if (p.s0 <= lo) break;
    }
    return out;
  }

  private collide(): void {
    const run = this.trains.filter((t) => t.state === 'run');
    const P = run.map((t) => this.pieces(t));
    for (let i = 0; i < run.length; i++) for (let j = i + 1; j < run.length; j++) {
      for (const [ea, a0, a1] of P[i]) for (const [eb, b0, b1] of P[j]) {
        const hit = (ea === eb && a0 <= b1 && b0 <= a1)
          // Shared node points (crossings, merges, switches): both trains spanning the same node.
          || this.touchesNode(ea, a0, a1, eb, b0, b1);
        if (hit) {
          const p = this.net.at(run[i].path[run[i].path.length - 1].e, run[i].s - run[i].path[run[i].path.length - 1].s0);
          return this.failWith('crash', [run[i].id, run[j].id], p.x, p.y);
        }
      }
      // Near miss: heads within 1.4 units (effects only).
      const ha = this.headXY(run[i]), hb = this.headXY(run[j]);
      const key = `${run[i].id}-${run[j].id}`;
      if (Math.hypot(ha.x - hb.x, ha.y - hb.y) < TRAIN_LEN + 0.6 && (this.nearCool.get(key) ?? -9) < this.t - 2) {
        this.nearCool.set(key, this.t);
        this.events.push({ kind: 'near', train: run[i].id });
      }
    }
  }

  private touchesNode(ea: number, a0: number, a1: number, eb: number, b0: number, b1: number): boolean {
    const E = this.net.edges;
    const ends = (e: number, s0: number, s1: number) => [s0 <= 1e-9 ? E[e].a : -1, s1 >= E[e].len - 1e-9 ? E[e].b : -1];
    const [p, q] = ends(ea, a0, a1), [r, s] = ends(eb, b0, b1);
    return (p >= 0 && (p === r || p === s)) || (q >= 0 && (q === r || q === s));
  }

  headXY(tr: Train): { x: number; y: number; ang: number } {
    const cur = tr.path[tr.path.length - 1];
    return this.net.at(cur.e, tr.s - cur.s0);
  }

  run(maxT = 300): void { while (!this.done && this.t < maxT) this.step(); }

  clone(): Sim {
    const c = Object.create(Sim.prototype) as Sim;
    Object.assign(c, this, {
      sw: this.sw.slice(), held: this.held.slice(), trains: this.trains.map((t) => ({ ...t, path: [...t.path] })),
      events: [], queue: [...this.queue], nearCool: new Map(this.nearCool), fail: this.fail,
    });
    return c;
  }
}

// ---- routing & autopilot (generator, demo) ----------------------------------------

/** For each switch, the out-edges from which each (station colour) is reachable. */
export function reachable(net: Network): (n: number, out: number, color: number, needVia: number) => boolean {
  const L = net.level;
  const memo = new Map<string, boolean>();
  const can = (e: number, color: number, via: number, depth: number): boolean => {
    const key = `${e}|${color}|${via}`;
    if (memo.has(key)) return memo.get(key)!;
    if (depth > 60) return false;
    memo.set(key, false);
    const b = net.edges[e].b, node = L.nodes[b];
    let ok = false;
    const v = node.k === 'stop' && node.c === via ? -1 : via;
    if (node.k === 'station') ok = node.c === color && v < 0;
    else if (node.k === 'switch') ok = net.outs[b].some((o) => can(o, color, v, depth + 1));
    else if (node.k === 'cross') { const o = net.pass.get(e); ok = o !== undefined && can(o, color, v, depth + 1); }
    else if (net.outs[b].length) ok = can(net.outs[b][0], color, v, depth + 1);
    memo.set(key, ok);
    return ok;
  };
  return (_n, out, color, via) => can(out, color, via, 0);
}

/** Next switch ahead of a train (within `look` units), with the distance to it. */
export function nextSwitch(sim: Sim, tr: Train, look: number): { node: number; dist: number; via: number } | null {
  const net = sim.net, L = net.level;
  const cur = tr.path[tr.path.length - 1];
  let e = cur.e, dist = net.edges[e].len - (tr.s - cur.s0);
  let via = tr.visited ? -1 : tr.via;
  for (let k = 0; k < 20 && dist <= look; k++) {
    const b = net.edges[e].b, node = L.nodes[b];
    if (node.k === 'switch') return { node: b, dist, via };
    if (node.k === 'stop' && node.c === via) via = -1;
    const nx = net.next(b, e, sim.sw);
    if (nx < 0) return null;
    e = nx; dist += net.edges[e].len;
  }
  return null;
}

/**
 * Autopilot: flips each switch shortly before a train needs it. With `rollout`,
 * when both ways can reach home it simulates each choice ahead and takes the one
 * that doesn't end in a crash (so it can use loops and wait for gaps).
 */
export function autopilot(level: SYLevel, opts: { rollout?: boolean; lead?: number } = {}): { sim: Sim; events: Event[] } {
  const net = new Network(level);
  const reach = reachable(net);
  const sim = new Sim(net);
  const events: Event[] = [];
  const lead = opts.lead ?? 0.9;
  const decide = (s: Sim, tr: Train, sw: { node: number; via: number }, depth: number, pins: Map<string, number>, key: string): number => {
    const outs = net.outs[sw.node];
    const ok = outs.map((o, i) => (reach(sw.node, o, tr.color, sw.via) ? i : -1)).filter((i) => i >= 0);
    if (ok.length <= 1 || !opts.rollout || depth > 1) return ok[0] ?? s.sw[sw.node];
    // Try each option (pinned inside its own rollout) and greedy to the end; prefer success, then speed.
    let best = ok[0], bestScore = -Infinity;
    for (const choice of ok) {
      const c = s.clone();
      const p2 = new Map(pins); p2.set(key, choice);
      if (c.sw[sw.node] !== choice) c.act(sw.node, 'f');
      while (!c.done && c.t < 300) { control(c, depth + 1, null, p2); c.step(); }
      const score = (c.fail ? 0 : 1e6) + c.delivered * 1000 - c.t;
      if (score > bestScore) { bestScore = score; best = choice; }
    }
    return best;
  };
  const control = (s: Sim, depth: number, rec: Event[] | null, pins: Map<string, number>) => {
    // Nearest train to each switch decides it.
    const claims = new Map<number, { tr: Train; dist: number; via: number }>();
    for (const tr of s.trains) {
      if (tr.state !== 'run') continue;
      const n = nextSwitch(s, tr, lead + tr.speed * 0.2);
      if (!n) continue;
      const c = claims.get(n.node);
      if (!c || n.dist < c.dist) claims.set(n.node, { tr, dist: n.dist, via: n.via });
    }
    for (const [node, c] of claims) {
      // Don't flip under a train that is still crossing the switch point.
      const busy = s.trains.some((t) => t !== c.tr && t.state === 'run' && t.path.some((p) => net.edges[p.e].b === node && t.s - p.s0 - net.edges[p.e].len > -0.01 && t.s - p.s0 - net.edges[p.e].len < TRAIN_LEN));
      if (busy) continue;
      const key = `${c.tr.id}@${node}@${c.tr.path.length}`;
      let want = pins.get(key) ?? -1;
      if (want < 0) { want = decide(s, c.tr, { node, via: c.via }, depth, pins, key); pins.set(key, want); }
      if (s.sw[node] !== want) { if (rec) rec.push([s.t, node, 'f']); s.act(node, 'f'); }
      // Hold timed switches in the wanted state while the train approaches.
      if (net.level.nodes[node].timed && !s.held[node]) { if (rec) rec.push([s.t, node, 'h']); s.act(node, 'h'); }
    }
    // Release timed switches nobody is approaching.
    net.level.nodes.forEach((n, i) => {
      if (n.timed && s.held[i] && !claims.has(i)) { if (rec) rec.push([s.t, i, 'r']); s.act(i, 'r'); }
    });
  };
  const pins = new Map<string, number>();
  while (!sim.done && sim.t < 300) {
    control(sim, 0, events, pins);
    sim.step();
  }
  return { sim, events };
}

export function replay(level: SYLevel, events: readonly Event[]): Sim {
  const sim = new Sim(new Network(level), events);
  sim.run();
  return sim;
}

export function lintLevel(l: SYLevel): string[] {
  const e: string[] = [];
  l.edges.forEach(([a, b], i) => { if (!l.nodes[a] || !l.nodes[b]) e.push(`edge ${i} uses a missing node`); });
  l.trains.forEach(([, n], i) => { if (l.nodes[n]?.k !== 'tunnel') e.push(`train ${i} does not start in a tunnel`); });
  if (l.solution.filter((x) => x[2] === 'f').length > l.par) e.push('solution flips more than par');
  return e;
}
