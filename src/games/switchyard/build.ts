import { Rng } from '../../engine/rng';
import type { EdgeDef, NodeDef, SYLevel, TrainDef } from './logic';

// Lane-based track builder shared by the level generator and Endless mode.
// Lanes run left to right; connectors switch a train between lanes; extras add
// crossings, X-crossovers, a holding loop on the top lane and colour stops.

export interface LayoutSpec {
  lanes: number;
  tunnels: number;
  connectors: number;
  crossings?: number;     // connectors that jump two lanes over a middle lane
  xovers?: number;        // X-shaped crossover pairs
  loop?: boolean;
  stops?: number;
  timed?: number;
  deadEnds?: number;
}

export interface Layout { level: SYLevel; tunnels: number[]; stations: { node: number; c: number }[]; stops: { node: number; c: number }[] }

export function buildLayout(spec: LayoutSpec, rng: Rng, name = 'Endless'): Layout | null {
  const W = 20, H = 12;
  const top = spec.loop ? 4 : spec.lanes >= 5 ? 1.8 : 2.5;
  const gapY = Math.min(2, (H - 1.2 - top) / Math.max(1, spec.lanes - 1));
  const ys = Array.from({ length: spec.lanes }, (_, i) => Math.round((top + i * gapY) * 10) / 10);
  const nodes: NodeDef[] = [];
  const edges: EdgeDef[] = [];
  const lanePts: { x: number; n: number }[][] = ys.map(() => []);
  const add = (n: NodeDef, lane = -1) => { nodes.push(n); if (lane >= 0) lanePts[lane].push({ x: n.x, n: nodes.length - 1 }); return nodes.length - 1; };
  const used: { lane: number; a: number; b: number }[] = [];
  const free = (lane: number, a: number, b: number) => !used.some((u) => u.lane === lane && a < u.b + 0.6 && u.a < b + 0.6);
  const take = (lane: number, a: number, b: number) => used.push({ lane, a, b });
  const diag: { from: number; to: number; via?: number }[] = [];
  const cols = [3.2, 5.6, 8, 10.4, 12.8, 15.2];

  // Tunnels on the left of some lanes; the rest start at a buffer.
  const tunnelLanes = rng.shuffle([...ys.keys()]).slice(0, spec.tunnels).sort((a, b) => a - b);
  const tunnels: number[] = [];
  ys.forEach((y, i) => { const t = tunnelLanes.includes(i); const n = add({ k: t ? 'tunnel' : 'buffer', x: 0.8, y }, i); if (t) tunnels.push(n); });

  if (spec.loop) {
    const x = rng.pick([5.6, 8]);
    if (!free(0, x, x + 4.4)) return null;
    take(0, x, x + 4.4);
    const y = ys[0];
    const S = add({ k: 'switch', x, y }, 0);
    const E = add({ k: 'merge', x: x + 1.2, y: y - 1.2 });
    const B = add({ k: 'switch', x: x + 3.2, y: y - 1.2 });
    const M = add({ k: 'merge', x: x + 4.4, y }, 0);
    diag.push({ from: S, to: E });
    edges.push([E, B]);
    edges.push([B, M]);
    edges.push([B, E, [[x + 3.8, y - 1.8], [x + 3.2, y - 2.6], [x + 1.2, y - 2.6], [x + 0.6, y - 1.8]]]);
  }
  for (let k = 0; k < (spec.xovers ?? 0); k++) {
    for (let t = 0; t < 30; t++) {
      const i = rng.int(0, spec.lanes - 2), x = rng.pick(cols);
      if (!free(i, x, x + 2) || !free(i + 1, x, x + 2)) continue;
      take(i, x, x + 2); take(i + 1, x, x + 2);
      const s1 = add({ k: 'switch', x, y: ys[i] }, i), s2 = add({ k: 'switch', x, y: ys[i + 1] }, i + 1);
      const m1 = add({ k: 'merge', x: x + 2, y: ys[i + 1] }, i + 1), m2 = add({ k: 'merge', x: x + 2, y: ys[i] }, i);
      const cx = add({ k: 'cross', x: x + 1, y: (ys[i] + ys[i + 1]) / 2 });
      diag.push({ from: s1, to: m1, via: cx }, { from: s2, to: m2, via: cx });
      break;
    }
  }
  for (let k = 0; k < (spec.crossings ?? 0); k++) {
    for (let t = 0; t < 30; t++) {
      if (spec.lanes < 3) break;
      const i = rng.int(0, spec.lanes - 3), dir = rng.chance(0.5) ? 1 : -1;
      const a = dir > 0 ? i : i + 2, b = dir > 0 ? i + 2 : i, x = rng.pick(cols);
      if (!free(a, x, x + 2) || !free(i + 1, x, x + 2) || !free(b, x, x + 2)) continue;
      take(a, x, x + 2); take(i + 1, x + 0.5, x + 1.5); take(b, x, x + 2);
      const s = add({ k: 'switch', x, y: ys[a] }, a);
      const cx = add({ k: 'cross', x: x + 1, y: ys[i + 1] }, i + 1);
      const m = add({ k: 'merge', x: x + 2, y: ys[b] }, b);
      diag.push({ from: s, to: m, via: cx });
      break;
    }
  }
  for (let k = 0; k < spec.connectors; k++) {
    for (let t = 0; t < 40; t++) {
      const i = rng.int(0, spec.lanes - 1), j = i + rng.sign();
      const x = rng.pick(cols);
      if (j < 0 || j >= spec.lanes || !free(i, x, x) || !free(j, x + 2, x + 2)) continue;
      take(i, x, x); take(j, x + 2, x + 2);
      const s = add({ k: 'switch', x, y: ys[i] }, i), m = add({ k: 'merge', x: x + 2, y: ys[j] }, j);
      diag.push({ from: s, to: m });
      break;
    }
  }
  // Stations (and a few dead ends) on the right.
  const stations: { node: number; c: number }[] = [];
  const order = rng.shuffle([0, 1, 2, 3, 4, 5]);
  const dead = new Set(rng.shuffle([...ys.keys()]).slice(0, spec.deadEnds ?? 0));
  ys.forEach((y, i) => {
    if (dead.has(i)) { add({ k: 'end', x: 19.2, y }, i); return; }
    const c = order[stations.length];
    stations.push({ node: add({ k: 'station', x: 19.2, y, c }, i), c });
  });
  // Colour stops on free lane spots.
  const stops: { node: number; c: number }[] = [];
  for (let k = 0; k < (spec.stops ?? 0); k++) {
    for (let t = 0; t < 30; t++) {
      const i = rng.int(0, spec.lanes - 1), x = rng.pick([2.2, 4.4, 6.8, 9.2, 11.6, 14, 16.6]);
      if (!free(i, x, x)) continue;
      take(i, x, x);
      const c = order[(stations.length + k) % 6];
      stops.push({ node: add({ k: 'stop', x, y: ys[i], c }, i), c });
      break;
    }
  }
  // Lane edges first (so a switch's first out-edge is "straight"), then diagonals.
  for (const lane of lanePts) {
    lane.sort((a, b) => a.x - b.x);
    for (let k = 1; k < lane.length; k++) edges.push([lane[k - 1].n, lane[k].n]);
  }
  for (const d of diag) {
    if (d.via !== undefined) { edges.push([d.from, d.via]); edges.push([d.via, d.to]); }
    else edges.push([d.from, d.to]);
  }
  // Number the switches left to right for keys 1-9; mark some as timed.
  const sws = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.k === 'switch').sort((a, b) => a.n.x - b.n.x || a.n.y - b.n.y);
  sws.forEach((s, k) => { s.n.key = k + 1; });
  for (const s of rng.shuffle([...sws]).slice(0, spec.timed ?? 0)) s.n.timed = rng.pick([4, 5, 6]);
  const level: SYLevel = { name, w: W, h: H, nodes, edges, trains: [], par: 0, solution: [] };
  return { level, tunnels, stations, stops };
}

/** Schedule trains: colours each tunnel can reach, spaced by `gap` seconds. */
export function schedule(lay: Layout, rng: Rng, n: number, gap: number, opts: { express?: number; via?: number; start?: number }, canReach: (tunnel: number, color: number, via: number) => boolean): TrainDef[] {
  const out: TrainDef[] = [];
  let t = opts.start ?? 2;
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 30; tries++) {
      const tunnel = rng.pick(lay.tunnels);
      const st = rng.pick(lay.stations);
      const via = lay.stops.length && rng.chance(opts.via ?? 0) ? rng.pick(lay.stops).c : -1;
      if (!canReach(tunnel, st.c, via)) continue;
      out.push([Math.round(t * 10) / 10, tunnel, st.c, rng.chance(opts.express ?? 0) ? 1 : 0, via]);
      break;
    }
    t += gap * rng.range(0.8, 1.25);
  }
  return out;
}
