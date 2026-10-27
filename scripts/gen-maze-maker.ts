// Generates Maze Maker levels and verifies best-known path lengths.
//   npx tsx scripts/gen-maze-maker.ts           (re)generate src/games/maze-maker/levels/*.json
//   npx tsx scripts/gen-maze-maker.ts --check   re-run the best-length search on the shipped
//                                               levels; report any level where it beats "best"
// Puzzle "best" lengths come from an exhaustive search for budgets up to 3 walls and
// from simulated annealing with restarts above that (walls only help on the current path).
import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng';
import {
  DefenceSim, Field, H, idx, pathLength, shortestPath, TRAPS, W, wallMask,
  type MMLevel, type TrapKind, type Wave,
} from '../src/games/maze-maker/logic';

const DIR = 'src/games/maze-maker/levels';

// ---- best-length search -------------------------------------------------------

function buildableCells(f: Field): number[] {
  const out: number[] = [];
  for (let i = 0; i < W * H; i++) if (f.buildable[i]) out.push(i);
  return out;
}

export function exhaustive(f: Field, n: number): { len: number; walls: number[] } {
  const cells = buildableCells(f);
  const m = new Uint8Array(W * H);
  let best = { len: pathLength(f, m), walls: [] as number[] };
  const pick: number[] = [];
  const rec = (from: number) => {
    if (pick.length === n) return;
    // Only cells on the current path can lengthen it.
    const path = shortestPath(f, m);
    if (!path) return;
    const onPath = new Set(path);
    for (let k = from; k < cells.length; k++) {
      const c = cells[k];
      if (!onPath.has(c) && pick.length === n - 1) continue;
      m[c] = 1; pick.push(c);
      const L = pathLength(f, m);
      if (L > 0) {
        if (L > best.len) best = { len: L, walls: [...pick] };
        rec(k + 1);
      }
      m[c] = 0; pick.pop();
    }
  };
  rec(0);
  return best;
}

export function anneal(f: Field, n: number, rng: Rng, restarts = 8, iters = 25_000): { len: number; walls: number[] } {
  const cells = buildableCells(f);
  let best = { len: -1, walls: [] as number[] };
  for (let rs = 0; rs < restarts; rs++) {
    const m = new Uint8Array(W * H);
    const S: number[] = [];
    // Random valid start.
    for (const c of rng.shuffle([...cells])) {
      if (S.length >= n) break;
      m[c] = 1;
      if (pathLength(f, m) < 0) m[c] = 0; else S.push(c);
    }
    let cur = pathLength(f, m);
    let path = shortestPath(f, m)!;
    for (let it = 0; it < iters; it++) {
      const T = 4 * Math.pow(0.02 / 4, it / iters);
      const ai = rng.int(0, S.length - 1);
      const a = S[ai];
      let b: number;
      if (rng.chance(0.8)) { b = path[rng.int(1, path.length - 2)]; if (!f.buildable[b]) continue; }
      else b = rng.pick(cells);
      if (m[b]) continue;
      m[a] = 0; m[b] = 1;
      const L = pathLength(f, m);
      if (L > 0 && (L >= cur || rng.next() < Math.exp((L - cur) / T))) {
        S[ai] = b; cur = L; path = shortestPath(f, m)!;
        if (L > best.len) best = { len: L, walls: [...S] };
      } else { m[b] = 0; m[a] = 1; }
    }
  }
  return best;
}

function bestFor(f: Field, n: number, rng: Rng): { len: number; walls: number[] } {
  return n <= 3 ? exhaustive(f, n) : anneal(f, n, rng);
}

/** One wall at a time, always the biggest immediate gain: what an impatient player finds. */
function greedy(f: Field, n: number): number {
  const m = new Uint8Array(W * H);
  let cur = pathLength(f, m);
  for (let k = 0; k < n; k++) {
    const path = shortestPath(f, m)!;
    let bestC = -1, bestL = cur;
    for (const c of path) {
      if (!f.buildable[c]) continue;
      m[c] = 1;
      const L = pathLength(f, m);
      if (L > bestL) { bestL = L; bestC = c; }
      m[c] = 0;
    }
    if (bestC < 0) break;
    m[bestC] = 1; cur = bestL;
  }
  return cur;
}

// ---- layouts ------------------------------------------------------------------

type Grid = string[][];
const blank = (): Grid => Array.from({ length: H }, () => Array(W).fill('.'));

/** Rock fences: vertical lines with a few gaps (chapter 1). */
function fences(rng: Rng, count: number): Grid {
  const g = blank();
  const cols = rng.shuffle([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).slice(0, count).sort((a, b) => a - b);
  for (const c of cols) {
    const gaps = new Set<number>();
    const ng = rng.int(2, 3);
    while (gaps.size < ng) gaps.add(rng.int(0, H - 1));
    for (let r = 0; r < H; r++) if (!gaps.has(r)) g[r][c] = '#';
  }
  // A few loose rocks.
  for (let k = 0; k < rng.int(2, 6); k++) g[rng.int(0, H - 1)][rng.int(1, W - 2)] = '#';
  return g;
}

/** Braided maze: rooms on even cells, rock between, then loops knocked through (chapter 2). */
function braided(rng: Rng, openP: number, water: boolean): Grid {
  const g: Grid = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => (r % 2 === 0 && c % 2 === 0 ? '.' : '#')));
  const RW = 8, RH = 6;
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const cx = cur % RW, cy = Math.floor(cur / RW);
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [cx + dx, cy + dy]).filter(([x, y]) => x >= 0 && y >= 0 && x < RW && y < RH && !seen.has(y * RW + x));
    if (!nb.length) { stack.pop(); continue; }
    const [nx, ny] = rng.pick(nb);
    g[cy * 2 + (ny - cy)][cx * 2 + (nx - cx)] = '.';
    seen.add(ny * RW + nx); stack.push(ny * RW + nx);
  }
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (g[r][c] !== '#') continue;
    const between = (r % 2 === 0) !== (c % 2 === 0);
    if (between && rng.chance(openP)) g[r][c] = '.';
    else if (!between && rng.chance(openP * 0.5)) g[r][c] = '.';
  }
  if (water) {
    // A river down one column with a bridge or two and some shallows.
    const c = rng.pick([5, 7, 9]);
    const bridges = new Set([rng.int(1, 4), rng.int(6, 9)]);
    for (let r = 0; r < H; r++) g[r][c] = bridges.has(r) ? '=' : 'w';
    for (let k = 0; k < 4; k++) { const r = rng.int(0, H - 1), cc = c + rng.sign(); if (g[r][cc] === '.') g[r][cc] = '~'; }
  }
  return g;
}

/** Open field with scattered rocks and pools (chapters 3 and 4). */
function field(rng: Rng, rocks: number, water: boolean): Grid {
  const g = blank();
  for (let k = 0; k < rocks; k++) {
    const r = rng.int(0, H - 1), c = rng.int(1, W - 2);
    g[r][c] = '#';
    if (rng.chance(0.4)) { const r2 = Math.max(0, Math.min(H - 1, r + rng.sign())); g[r2][c] = '#'; }
  }
  if (water) {
    const r0 = rng.int(2, H - 3), c0 = rng.int(4, W - 5);
    for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) if (rng.chance(0.8)) g[r][c] = rng.chance(0.5) ? 'w' : '~';
  }
  return g;
}

function toLevel(name: string, g: Grid, sr: number, gr: number, walls: number): MMLevel {
  g[sr][0] = '.'; g[gr][W - 1] = '.';
  return { name, mode: 'puzzle', rows: g.map((r) => r.join('')), start: [0, sr], goal: [W - 1, gr], walls, solution: { walls: [] } };
}

// ---- puzzles --------------------------------------------------------------------

interface PSpec { name: string; kind: 'fences' | 'braid' | 'field'; walls: number; fences?: number; open?: number; water?: boolean; rocks?: number }

const P: Record<string, PSpec> = {
  '1-2': { name: 'Two gaps', kind: 'fences', walls: 1, fences: 2 },
  '1-3': { name: 'Plug it', kind: 'fences', walls: 2, fences: 2 },
  '1-4': { name: 'Slalom', kind: 'fences', walls: 2, fences: 3 },
  '1-5': { name: 'The long way', kind: 'fences', walls: 3, fences: 3 },
  '1-6': { name: 'Gatekeeper', kind: 'fences', walls: 3, fences: 4 },
  '1-7': { name: 'Picket fence', kind: 'fences', walls: 4, fences: 4 },
  '1-8': { name: 'Switchbacks', kind: 'fences', walls: 4, fences: 5 },
  '1-9': { name: 'Five posts', kind: 'fences', walls: 5, fences: 5 },
  '1-10': { name: 'Fence maze', kind: 'fences', walls: 6, fences: 6 },
  '2-1': { name: 'Corridors', kind: 'braid', walls: 3, open: 0.12 },
  '2-2': { name: 'Riverside', kind: 'braid', walls: 3, open: 0.12, water: true },
  '2-3': { name: 'Loops', kind: 'braid', walls: 4, open: 0.16 },
  '2-4': { name: 'Two bridges', kind: 'braid', walls: 4, open: 0.14, water: true },
  '2-5': { name: 'Shortcut city', kind: 'braid', walls: 5, open: 0.2 },
  '2-6': { name: 'Ferry', kind: 'braid', walls: 5, open: 0.18, water: true },
  '2-7': { name: 'Catacombs', kind: 'braid', walls: 6, open: 0.22 },
  '2-8': { name: 'Wetlands', kind: 'braid', walls: 6, open: 0.22, water: true },
  '2-9': { name: 'Rat run', kind: 'braid', walls: 7, open: 0.26 },
  '2-10': { name: 'Delta', kind: 'braid', walls: 8, open: 0.26, water: true },
  '3-1': { name: 'Open field', kind: 'field', walls: 10, rocks: 8 },
  '3-2': { name: 'Meadow', kind: 'field', walls: 12, rocks: 6 },
  '3-3': { name: 'Pond', kind: 'field', walls: 12, rocks: 8, water: true },
  '3-4': { name: 'Boulders', kind: 'field', walls: 14, rocks: 12 },
  '3-5': { name: 'Serpent', kind: 'field', walls: 15, rocks: 6 },
  '3-6': { name: 'Lakeside', kind: 'field', walls: 16, rocks: 8, water: true },
  '3-7': { name: 'Quarry', kind: 'field', walls: 18, rocks: 14 },
  '3-8': { name: 'Great maze', kind: 'field', walls: 20, rocks: 6 },
  '3-9': { name: 'Marsh', kind: 'field', walls: 22, rocks: 8, water: true },
  '3-10': { name: 'Endless walk', kind: 'field', walls: 26, rocks: 10 },
};

function hand11(): MMLevel {
  const g = blank();
  for (let r = 0; r < H; r++) if (r !== 5 && r !== 10) g[r][7] = '#';
  const l = toLevel('One wall', g, 5, 5, 1);
  return l;
}

function puzzle(spec: PSpec, seed: number): MMLevel {
  const rng = new Rng(seed);
  let best: { l: MMLevel; score: number } | null = null;
  for (let t = 0; t < (spec.walls <= 3 ? 60 : 24); t++) {
    const g = spec.kind === 'fences' ? fences(rng, spec.fences ?? 2) : spec.kind === 'braid' ? braided(rng, spec.open ?? 0.15, !!spec.water) : field(rng, spec.rocks ?? 8, !!spec.water);
    const sr = spec.kind === 'braid' ? rng.int(0, 5) * 2 : rng.int(1, H - 2);
    const gr = spec.kind === 'braid' ? rng.int(0, 5) * 2 : rng.int(1, H - 2);
    const l = toLevel(spec.name, g, sr, gr, spec.walls);
    const f = new Field(l);
    const base = pathLength(f, new Uint8Array(W * H));
    if (base < 0) continue;
    const b = bestFor(f, spec.walls, rng);
    const gr0 = greedy(f, spec.walls);
    // Interesting = walls matter a lot, and the greedy player falls short.
    const score = (b.len - base) + 3 * (b.len - gr0);
    if (!best || score > best.score) {
      l.best = b.len;
      l.target = Math.max(base + 1, Math.round(base + (b.len - base) * 0.72));
      l.solution = { walls: b.walls.map((i) => [i % W, Math.floor(i / W)] as [number, number]) };
      best = { l, score };
    }
  }
  return best!.l;
}

// ---- defence --------------------------------------------------------------------

function waves(k: number): Wave[] {
  return [
    { blob: 4 + k },
    { blob: 4 + k, runner: 2 + Math.floor(k / 2) },
    { blob: 3 + k, tank: 1 + Math.floor(k / 4) },
    { runner: 3 + Math.floor(k / 2), hopper: 2 + Math.floor(k / 3) },
    { blob: 5 + k, runner: 3, tank: 1 + Math.floor(k / 3), hopper: 2 + Math.floor(k / 4) },
  ];
}

function simulate(l: MMLevel, walls: Uint8Array, traps: [TrapKind, number, number][]): { leaked: number; hpLeft: number } {
  const sim = new DefenceSim(new Field(l), walls, traps);
  let hpLeft = 0;
  while (!sim.done) {
    sim.step();
    for (const m of sim.monsters) if (m.arrived && m.hp > 0) { hpLeft += m.hp; m.hp = 0; }
  }
  return { leaked: sim.leaked, hpLeft };
}

/** Greedy traps: repeatedly buy whichever trap removes the most leaking HP per dollar. */
function greedyTraps(l: MMLevel, walls: Uint8Array, money: number): { traps: [TrapKind, number, number][]; leaked: number; spent: number } {
  const f = new Field(l);
  const path = shortestPath(f, walls)!;
  const rows = new Set(path.map((i) => Math.floor(i / W)));
  const traps: [TrapKind, number, number][] = [];
  let spent = 0;
  let cur = simulate(l, walls, traps);
  const used = new Set<number>();
  while (cur.leaked > 0) {
    let pick: { t: [TrapKind, number, number]; res: ReturnType<typeof simulate>; gain: number } | null = null;
    const cands: [TrapKind, number, number][] = [];
    for (const i of path.slice(1, -1)) {
      if (used.has(i) || !f.buildable[i]) continue;
      for (const k of ['spikes', 'goo', 'bounce'] as TrapKind[]) cands.push([k, i % W, Math.floor(i / W)]);
    }
    for (let i = 0; i < W * H; i++) {
      if (used.has(i) || !f.buildable[i] || walls[i] || !rows.has(Math.floor(i / W)) || path.includes(i)) continue;
      cands.push(['cannon', i % W, Math.floor(i / W)]);
    }
    for (const t of cands) {
      const cost = TRAPS[t[0]].cost;
      if (spent + cost > money) continue;
      const res = simulate(l, walls, [...traps, t]);
      const gain = ((cur.hpLeft - res.hpLeft) + (cur.leaked - res.leaked) * 20) / cost;
      if (!pick || gain > pick.gain) pick = { t, res, gain };
    }
    if (!pick || pick.gain <= 0) break;
    traps.push(pick.t); used.add(idx(pick.t[1], pick.t[2])); spent += TRAPS[pick.t[0]].cost; cur = pick.res;
  }
  return { traps, leaked: cur.leaked, spent };
}

const D_NAMES = ['First wave', 'Spike alley', 'Goo trap', 'Cannon row', 'Hoppers!', 'Bounce house', 'Tank buster', 'Gauntlet', 'Siege', 'Last stand'];

function defence(k: number, seed: number): MMLevel {
  const rng = new Rng(seed);
  for (let attempt = 0; attempt < 40; attempt++) {
    const g = field(rng, 5 + k, k % 3 === 2);
    const l = toLevel(D_NAMES[k], g, rng.int(1, H - 2), rng.int(1, H - 2), 8 + Math.floor(k / 2) * 2);
    l.mode = 'defence';
    l.waves = waves(k);
    const f = new Field(l);
    if (pathLength(f, new Uint8Array(W * H)) < 0) continue;
    const maze = anneal(f, l.walls, rng, 4, 15_000);
    const walls = new Uint8Array(W * H);
    for (const i of maze.walls) walls[i] = 1;
    // Find the least money (in $2 steps) where the greedy defence loses nothing, then give $4 slack.
    for (let money = 16 + k * 2; money <= 90; money += 2) {
      const r = greedyTraps(l, walls, money);
      if (r.leaked === 0) {
        l.money = Math.max(money, r.spent) + 4;
        l.solution = { walls: maze.walls.map((i) => [i % W, Math.floor(i / W)] as [number, number]), traps: r.traps };
        // Without traps the waves must hurt.
        if (simulate(l, walls, []).leaked < 3) break;
        return l;
      }
    }
  }
  throw new Error(`defence ${k + 1} failed`);
}

// ---- main ---------------------------------------------------------------------------

const TITLES = [['1-first-walls', 'First walls'], ['2-detours', 'Detours'], ['3-labyrinths', 'Labyrinths'], ['4-defence', 'Defence']];

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [file] of TITLES) {
    const data = JSON.parse(readFileSync(`${DIR}/${file}.json`, 'utf8')) as { levels: MMLevel[] };
    data.levels.forEach((l, i) => {
      if (l.mode !== 'puzzle') return;
      const f = new Field(l);
      const stored = pathLength(f, wallMask(l.solution.walls));
      const search = bestFor(f, l.walls, new Rng(99 + i));
      const flag = stored !== l.best ? ' STORED SOLUTION MISMATCH' : search.len > l.best! ? ` search found ${search.len} > best` : '';
      if (flag) bad++;
      console.log(`${file} ${i + 1}: best ${l.best}, stored ${stored}, search ${search.len}${flag}`);
    });
  }
  process.exit(bad ? 1 : 0);
}

const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 4; ch++) {
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: MMLevel[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: MMLevel[] = [];
  for (let n = 1; n <= 10; n++) {
    const id = `${ch}-${n}`;
    if (only && only !== id && existing[n - 1]) { levels.push(existing[n - 1]); continue; }
    const t0 = Date.now();
    let l: MMLevel;
    if (id === '1-1') {
      l = hand11();
      const b = exhaustive(new Field(l), 1);
      l.best = b.len; l.target = b.len;
      l.solution = { walls: b.walls.map((i) => [i % W, Math.floor(i / W)] as [number, number]) };
    } else if (ch < 4) l = puzzle(P[id], 7000 + ch * 100 + n);
    else l = defence(n - 1, 9000 + n);
    levels.push(l);
    const f = new Field(l);
    const base = pathLength(f, new Uint8Array(W * H));
    console.log(`${id.padEnd(5)} ${l.name.padEnd(14)} walls ${l.walls} base ${base}` +
      (l.mode === 'puzzle' ? ` target ${l.target} best ${l.best} greedy ${greedy(f, l.walls)}` : ` money ${l.money} traps ${l.solution.traps?.length}`) + ` (${Date.now() - t0} ms)`);
  }
  writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
