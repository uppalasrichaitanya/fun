// Generates Heist 15 levels. Rooms are built from a theme (Museum, Bank, Casino),
// then a time-layered search finds a route that grabs the gem and gets out without
// ever being in sight (no tools, >= 4.5 s left). Its inputs are replayed through
// the real simulation before the level is accepted.
//   npx tsx scripts/gen-heist.ts [--ch N] [1-4]
import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng';
import {
  BITS, camAngle, CAM_FOV, CAM_RANGE, compress, GUARD_FOV, GUARD_RANGE, H, laserOn, laserTiles, Patrol, play, Room, sees, W,
  type HLevel, type ToolKind,
} from '../src/games/heist-15/logic';

const DIR = 'src/games/heist-15/levels';
const STEP = 15; // frames per tile at run speed

interface Spec {
  name: string;
  guards: number;
  cameras?: number;
  lasers?: number;
  noisy?: number;
  card?: boolean;
  vents?: boolean;
  walls: number;
  tools: Partial<Record<ToolKind, number>>;
  minWaits?: number;
}
const S = (name: string, guards: number, walls: number, tools: Spec['tools'], o: Partial<Spec> = {}): Spec => ({ name, guards, walls, tools, ...o });

const SPECS: Spec[][] = [
  [
    S('Night watch', 1, 2, { smoke: 1 }), S('The rounds', 1, 3, { smoke: 1 }), S('Eyes on the wall', 0, 3, { smoke: 1 }, { cameras: 1 }), S('Two guards', 2, 3, { coin: 1 }),
    S('Sculpture hall', 1, 4, { smoke: 1 }, { cameras: 1 }), S('Creaky floor', 1, 3, { coin: 1 }, { noisy: 1 }), S('Gallery', 2, 4, { smoke: 1, coin: 1 }, { cameras: 1, minWaits: 1 }),
    S('Long corridor', 2, 4, { sprint: 1 }, { minWaits: 1 }), S('Security room', 1, 4, { smoke: 1 }, { cameras: 2 }), S('Old masters', 2, 5, { coin: 1, smoke: 1 }, { cameras: 1, noisy: 1, minWaits: 1 }),
    S('Night shift', 3, 4, { smoke: 1, sprint: 1 }, { minWaits: 1 }), S('Crown jewel', 3, 5, { smoke: 1, coin: 1 }, { cameras: 1, minWaits: 2 }),
  ],
  [
    S('Lobby', 1, 3, { sprint: 1 }, { lasers: 1 }), S('Laser grid', 1, 3, { sprint: 1 }, { lasers: 2 }), S('Keycard', 1, 4, { smoke: 1 }, { card: true }),
    S('Tellers', 2, 4, { coin: 1 }, { lasers: 1 }), S('Deposit boxes', 2, 4, { smoke: 1 }, { cameras: 1, lasers: 1 }), S('Back office', 1, 4, { sprint: 1 }, { card: true, cameras: 1, minWaits: 1 }),
    S('Vault approach', 2, 5, { smoke: 1, sprint: 1 }, { lasers: 2, minWaits: 1 }), S('Night manager', 2, 4, { coin: 1 }, { card: true, lasers: 1 }), S('Strong room', 2, 5, { smoke: 1 }, { cameras: 2, lasers: 1, minWaits: 1 }),
    S('Gold bars', 3, 5, { smoke: 1, coin: 1 }, { lasers: 2 }), S('Time lock', 2, 5, { sprint: 1, smoke: 1 }, { card: true, lasers: 2, minWaits: 2 }), S('The vault', 3, 5, { smoke: 1, coin: 1, sprint: 1 }, { cameras: 1, lasers: 2, card: true, minWaits: 2 }),
  ],
  [
    S('Slot floor', 2, 3, { coin: 1 }, { noisy: 2 }), S('Air ducts', 1, 4, { smoke: 1 }, { vents: true }), S('High rollers', 2, 4, { coin: 1, smoke: 1 }, { noisy: 1, cameras: 1 }),
    S('Cage', 2, 5, { sprint: 1 }, { vents: true, lasers: 1 }), S('Eye in the sky', 1, 4, { smoke: 1 }, { cameras: 3 }), S('Count room', 2, 5, { coin: 1 }, { card: true, noisy: 1, minWaits: 1 }),
    S('Pit boss', 3, 4, { coin: 2 }, { noisy: 2, minWaits: 1 }), S('Penthouse', 2, 5, { smoke: 1, sprint: 1 }, { vents: true, cameras: 1, minWaits: 1 }), S('Showtime', 3, 5, { smoke: 1, coin: 1 }, { lasers: 2, noisy: 1, minWaits: 1 }),
    S('Blackjack', 3, 5, { coin: 1, sprint: 1 }, { cameras: 2, minWaits: 2 }), S('House edge', 3, 5, { smoke: 1, coin: 1 }, { card: true, vents: true, lasers: 1, minWaits: 2 }),
    S('Jackpot', 3, 6, { smoke: 1, coin: 1, sprint: 1 }, { cameras: 2, lasers: 2, noisy: 1, minWaits: 2 }),
  ],
];

// ---- rooms ---------------------------------------------------------------------------

function bfs(rows: string[], from: [number, number], passDoor: boolean): Int16Array {
  const d = new Int16Array(W * H).fill(-1);
  const q = [from[1] * W + from[0]];
  d[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = (i % W) + dx, y = Math.floor(i / W) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const ch = rows[y][x];
      if (ch === '#' || (ch === 'D' && !passDoor)) continue;
      const j = y * W + x;
      if (d[j] >= 0) continue;
      d[j] = d[i] + 1; q.push(j);
    }
  }
  return d;
}

function makeRoom(spec: Spec, rng: Rng): HLevel | null {
  const g: string[][] = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : '.')));
  for (let k = 0; k < spec.walls; k++) {
    const horiz = rng.chance(0.5);
    const len = rng.int(3, horiz ? 8 : 5);
    const x = rng.int(2, W - 3), y = rng.int(2, H - 3);
    const gap = rng.int(0, len - 1);
    for (let t = 0; t < len; t++) {
      if (t === gap) continue;
      const xx = horiz ? x + t : x, yy = horiz ? y : y + t;
      if (xx > 0 && yy > 0 && xx < W - 1 && yy < H - 1) g[yy][xx] = '#';
    }
  }
  for (let k = 0; k < 3; k++) g[rng.int(2, H - 3)][rng.int(2, W - 3)] = '#';
  const ex = rng.int(1, 4), gx = rng.int(W - 6, W - 2), gy = rng.int(1, 3);
  g[H - 2][ex] = 'E';
  g[gy][gx] = 'G';
  for (const [x, y] of [[ex, H - 3], [ex + 1, H - 2], [gx, gy + 1], [gx - 1, gy]]) if (g[y]?.[x] === '#') g[y][x] = '.';
  let rows = g.map((r) => r.join(''));
  if (bfs(rows, [ex, H - 2], true)[gy * W + gx] < 0) return null;
  const level: HLevel = { name: spec.name, rows, guards: [], cameras: [], lasers: [], vents: [], tools: spec.tools, solution: [] };
  const floor = (x: number, y: number) => rows[y]?.[x] === '.';
  // Keycard door: block a gap on the way to the gem.
  if (spec.card) {
    const dist = bfs(rows, [ex, H - 2], true);
    const fromGem = bfs(rows, [gx, gy], true);
    const total = dist[gy * W + gx];
    const cand: number[] = [];
    for (let i = 0; i < W * H; i++) if (dist[i] > 2 && fromGem[i] > 1 && dist[i] + fromGem[i] === total && floor(i % W, Math.floor(i / W))) cand.push(i);
    let placed = false;
    for (const i of rng.shuffle(cand)) {
      const test = rows.map((r) => r.split(''));
      test[Math.floor(i / W)][i % W] = 'D';
      const t2 = test.map((r) => r.join(''));
      if (bfs(t2, [ex, H - 2], false)[gy * W + gx] >= 0) continue; // must actually block
      const reach = bfs(t2, [ex, H - 2], false);
      const toDoor = bfs(t2, [i % W, Math.floor(i / W)], true);
      const direct = reach[i - 1] >= 0 ? reach[i - 1] : reach[i + 1] >= 0 ? reach[i + 1] : reach[i - W] >= 0 ? reach[i - W] : reach[i + W];
      const spots: number[] = [];
      // Close to the way in: at most ~4 extra tiles there and back.
      for (let j = 0; j < W * H; j++) if (reach[j] > 3 && toDoor[j] >= 0 && reach[j] + toDoor[j] - Math.max(0, direct) <= 4 && t2[Math.floor(j / W)][j % W] === '.') spots.push(j);
      if (!spots.length) continue;
      const k = rng.pick(spots);
      test[Math.floor(k / W)][k % W] = 'K';
      rows = test.map((r) => r.join(''));
      placed = true;
      break;
    }
    if (!placed) return null;
    level.rows = rows;
  }
  if (spec.vents) {
    const spots: [number, number][] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (floor(x, y)) spots.push([x, y]);
    const a = rng.pick(spots.filter(([x, y]) => y > H / 2 && x < W / 2));
    const b = rng.pick(spots.filter(([x, y]) => y < H / 2 && x > W / 2));
    if (!a || !b) return null;
    const t = rows.map((r) => r.split(''));
    t[a[1]][a[0]] = 'V'; t[b[1]][b[0]] = 'V';
    rows = t.map((r) => r.join(''));
    level.rows = rows;
    level.vents = [[0, 1]];
  }
  for (let k = 0; k < (spec.noisy ?? 0); k++) {
    const x0 = rng.int(3, W - 5), y0 = rng.int(2, H - 4);
    const t = rows.map((r) => r.split(''));
    for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 3; x++) if (t[y][x] === '.') t[y][x] = '~';
    rows = t.map((r) => r.join(''));
    level.rows = rows;
  }
  const open = (x: number, y: number) => rows[y]?.[x] !== undefined && rows[y][x] !== '#' && rows[y][x] !== 'D' && !(x === ex && y === H - 2);
  // Guards: rectangle loops or back-and-forth lines.
  for (let k = 0; k < spec.guards; k++) {
    for (let t = 0; t < 60; t++) {
      const x0 = rng.int(1, W - 3), y0 = rng.int(1, H - 3);
      const x1 = Math.min(W - 2, x0 + rng.int(2, 7)), y1 = Math.min(H - 2, y0 + rng.int(0, 4));
      const rect = y1 > y0 && rng.chance(0.6);
      const path: [number, number][] = rect ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : rng.chance(0.5) ? [[x0, y0], [x1, y0]] : [[x0, y0], [x0, y1 + 1 < H - 1 ? y1 + 1 : y1]];
      let ok = path.every(([x, y]) => open(x, y));
      // Every tile along each leg must be open.
      for (let i = 0; i < path.length && ok; i++) {
        const [ax, ay] = path[i], [bx, by] = path[(i + 1) % path.length];
        for (let s = 0; s <= Math.max(Math.abs(bx - ax), Math.abs(by - ay)); s++) {
          const x = ax + Math.sign(bx - ax) * s, y = ay + Math.sign(by - ay) * s;
          if (!open(x, y)) ok = false;
        }
      }
      if (!ok || (path[0][0] === path[1][0] && path[0][1] === path[1][1])) continue;
      // Not right on top of the entrance.
      if (path.some(([x, y]) => Math.abs(x - ex) + Math.abs(y - (H - 2)) < 3)) continue;
      level.guards.push({ path, phase: Math.round(rng.range(0, 6) * 10) / 10 });
      break;
    }
  }
  for (let k = 0; k < (spec.cameras ?? 0); k++) {
    for (let t = 0; t < 60; t++) {
      const x = rng.int(1, W - 2), y = rng.int(1, H - 2);
      if (!open(x, y)) continue;
      // Mounted against a wall, looking away from it.
      const away = [[0, 1, 90], [0, -1, 270], [1, 0, 0], [-1, 0, 180]].find(([dx, dy]) => rows[y - dy]?.[x - dx] === '#');
      if (!away) continue;
      if (Math.hypot(x - ex, y - (H - 2)) < 3) continue;
      level.cameras.push([x, y, away[2], rng.int(25, 55), rng.int(3, 6)]);
      break;
    }
  }
  for (let k = 0; k < (spec.lasers ?? 0); k++) {
    for (let t = 0; t < 80; t++) {
      const horiz = rng.chance(0.5);
      const x = rng.int(1, W - 2), y = rng.int(1, H - 2);
      if (!open(x, y)) continue;
      // Span the open corridor in that direction between walls.
      let a = 0, b = 0;
      while (open(horiz ? x - a - 1 : x, horiz ? y : y - a - 1)) a++;
      while (open(horiz ? x + b + 1 : x, horiz ? y : y + b + 1)) b++;
      if (a + b + 1 > 5 || a + b + 1 < 2) continue;
      const l: HLevel['lasers'][number] = horiz ? [x - a, y, x + b, y, rng.int(2, 4), 0.5, Math.round(rng.range(0, 2) * 10) / 10] : [x, y - a, x, y + b, rng.int(2, 4), 0.5, Math.round(rng.range(0, 2) * 10) / 10];
      if (laserTiles(l).some(([lx, ly]) => rows[ly][lx] !== '.')) continue;
      level.lasers.push(l);
      break;
    }
  }
  return level;
}

// ---- the bot ---------------------------------------------------------------------------

type Move = { dx: number; dy: number; frames: number; sneak: boolean };
const MOVES: Move[] = [{ dx: 0, dy: 0, frames: STEP, sneak: false }, { dx: 1, dy: 0, frames: STEP, sneak: false }, { dx: -1, dy: 0, frames: STEP, sneak: false }, { dx: 0, dy: 1, frames: STEP, sneak: false }, { dx: 0, dy: -1, frames: STEP, sneak: false }];

/** Time-layered search: never seen (with a margin), never on a live laser. */
export function solve(level: HLevel, maxFrames = 630): { frames: number[]; waits: number } | null {
  const room = new Room(level);
  const patrols = level.guards.map((g) => new Patrol(g.path.map(([x, y]) => [x + 0.5, y + 0.5]), g.face ?? 0, g.phase ?? 0));
  const seenCache = new Map<number, boolean>();
  const seen = (f: number, x: number, y: number): boolean => {
    const key = (f * 1000 + Math.round(x * 15)) * 1000 + Math.round(y * 15);
    const c = seenCache.get(key);
    if (c !== undefined) return c;
    const t = f / 60;
    let r = false;
    for (const p of patrols) { const g = p.at(t); if (sees(room, g.x, g.y, g.ang, GUARD_FOV + 10, GUARD_RANGE + 0.4, x, y, null)) { r = true; break; } }
    if (!r) for (const c2 of level.cameras) if (sees(room, c2[0] + 0.5, c2[1] + 0.5, camAngle(c2, t), CAM_FOV + 10, CAM_RANGE + 0.4, x, y, null)) { r = true; break; }
    if (!r) for (const l of level.lasers) if (laserOn(l, t) || laserOn(l, t + 0.05) || laserOn(l, t - 0.05)) for (const [lx, ly] of laserTiles(l)) if (Math.floor(x) === lx && Math.floor(y) === ly) r = true;
    seenCache.set(key, r);
    return r;
  };
  const [ex, ey] = room.entrance;
  const idx = (x: number, y: number, gem: number, card: number) => ((y * W + x) * 2 + gem) * 2 + card;
  type St = { x: number; y: number; gem: number; card: number; f: number; prev: St | null; move: Move | null };
  let layer = new Map<number, St>([[idx(ex, ey, 0, 0), { x: ex, y: ey, gem: 0, card: 0, f: 0, prev: null, move: null }]]);
  const visited = new Set<string>();
  const pending = new Map<number, Map<number, St>>(); // states arriving after slow (sneak/vent) moves, by frame
  for (let f = 0; f <= maxFrames; f += STEP) {
    const extra = pending.get(f);
    if (extra) for (const [k, s] of extra) if (!layer.has(k)) layer.set(k, s);
    const next = new Map<number, St>();
    for (const s of layer.values()) {
      if (s.gem && s.x === ex && s.y === ey && s.f > 0) {
        const frames: number[] = [];
        const moves: Move[] = [];
        for (let p: St | null = s; p && p.move; p = p.prev) moves.unshift(p.move);
        let waits = 0;
        for (const m of moves) {
          const b = (m.dy < 0 ? BITS.up : 0) | (m.dy > 0 ? BITS.down : 0) | (m.dx < 0 ? BITS.left : 0) | (m.dx > 0 ? BITS.right : 0) | (m.sneak ? BITS.sneak : 0);
          if (!m.dx && !m.dy) waits++;
          for (let k = 0; k < m.frames; k++) frames.push(b);
        }
        return { frames, waits };
      }
      for (const m0 of MOVES) {
        const nx = s.x + m0.dx, ny = s.y + m0.dy;
        if (room.wall(nx, ny, !!s.card)) continue;
        const noisy = room.noisy[ny * W + nx] || room.noisy[s.y * W + s.x];
        const m = noisy && (m0.dx || m0.dy) ? { ...m0, frames: STEP * 2, sneak: true } : m0;
        let bad = false;
        for (let k = 1; k <= m.frames && !bad; k += 2) {
          const px = s.x + 0.5 + (m.dx * k) / m.frames, py = s.y + 0.5 + (m.dy * k) / m.frames;
          if (seen(s.f + k, px, py)) bad = true;
        }
        if (bad || seen(s.f + m.frames, nx + 0.5, ny + 0.5)) continue;
        const ch = level.rows[ny][nx];
        const gem = s.gem || ch === 'G' ? 1 : 0, card = s.card || ch === 'K' ? 1 : 0;
        // Vents: avoid in the bot (the timing is fiddly); it never needs them.
        if (ch === 'V') continue;
        const st: St = { x: nx, y: ny, gem, card, f: s.f + m.frames, prev: s, move: m };
        const key = idx(nx, ny, gem, card);
        const vk = `${key}@${st.f}`;
        if (visited.has(vk)) continue;
        visited.add(vk);
        if (m.frames === STEP) { if (!next.has(key)) next.set(key, st); }
        else { const later = pending.get(st.f) ?? new Map(); if (!later.has(key)) later.set(key, st); pending.set(st.f, later); }
      }
    }
    layer = next;
    if (!layer.size && ![...pending.keys()].some((k) => k > f)) break;
  }
  return null;
}

/** The impatient player: shortest path, no waiting. Caught? */
function naiveCaught(level: HLevel): boolean {
  const room = new Room(level);
  const [ex, ey] = room.entrance, [gx, gy] = room.gem;
  const pathTo = (from: [number, number], to: [number, number], card: boolean): [number, number][] => {
    const prev = new Int16Array(W * H).fill(-1);
    const s = from[1] * W + from[0];
    prev[s] = s;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = (i % W) + dx, y = Math.floor(i / W) + dy;
        if (room.wall(x, y, card) || level.rows[y][x] === 'V') continue;
        const j = y * W + x;
        if (prev[j] >= 0) continue;
        prev[j] = i; q.push(j);
      }
    }
    const out: [number, number][] = [];
    for (let i = to[1] * W + to[0]; i !== s && i >= 0; i = prev[i]) out.unshift([i % W, Math.floor(i / W)]);
    return out;
  };
  let pts: [number, number][];
  if (room.card) pts = [...pathTo([ex, ey], room.card, false), ...pathTo(room.card, [gx, gy], true), ...pathTo([gx, gy], [ex, ey], true)];
  else pts = [...pathTo([ex, ey], [gx, gy], false), ...pathTo([gx, gy], [ex, ey], false)];
  const frames: number[] = [];
  let [cx, cy] = [ex, ey];
  for (const [x, y] of pts) {
    const b = (y < cy ? BITS.up : 0) | (y > cy ? BITS.down : 0) | (x < cx ? BITS.left : 0) | (x > cx ? BITS.right : 0) | (room.noisy[y * W + x] ? BITS.sneak : 0);
    for (let k = 0; k < (room.noisy[y * W + x] ? 30 : 15); k++) frames.push(b);
    cx = x; cy = y;
  }
  const h = play(level, compress(frames));
  return h.outcome !== 'escaped';
}

function generate(spec: Spec, seed: number): HLevel {
  const rng = new Rng(seed);
  let best: { l: HLevel; q: number } | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const l = makeRoom(spec, rng);
    if (!l) continue;
    const sol = solve(l);
    if (!sol || sol.waits < (spec.minWaits ?? 0)) continue;
    l.solution = compress(sol.frames);
    const h = play(l, l.solution);
    if (h.outcome !== 'escaped' || h.timeLeft < 4.5 || h.usedTools) continue;
    const challenge = naiveCaught(l);
    if (!challenge && (spec.guards + (spec.cameras ?? 0) + (spec.lasers ?? 0)) > 1) continue;
    const q = (challenge ? 10 : 0) + sol.waits * 2 + (15 - h.timeLeft) + rng.next();
    if (!best || q > best.q) best = { l, q };
    if (attempt > 30 && best) break;
  }
  if (!best && (spec.minWaits ?? 0) > 0) return generate({ ...spec, minWaits: 0 }, seed + 1);
  if (!best) throw new Error(`could not generate ${spec.name}`);
  return best.l;
}

const TITLES = [['1-museum', 'Museum'], ['2-bank', 'Bank'], ['3-casino', 'Casino']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 3; ch++) {
  if (chOnly && ch !== chOnly) continue;
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: HLevel[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: HLevel[] = [];
  SPECS[ch - 1].forEach((spec, i) => {
    const id = `${ch}-${i + 1}`;
    if (only && only !== id && existing[i]) { levels.push(existing[i]); return; }
    const t0 = Date.now();
    const l = generate(spec, 91000 + ch * 100 + i);
    levels.push(l);
    const h = play(l, l.solution);
    console.log(`${id.padEnd(5)} ${l.name.padEnd(16)} guards ${l.guards.length} cams ${l.cameras.length} lasers ${l.lasers.length} left ${h.timeLeft.toFixed(2)} s naive-caught ${naiveCaught(l)} (${Date.now() - t0} ms)`);
  });
  writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
