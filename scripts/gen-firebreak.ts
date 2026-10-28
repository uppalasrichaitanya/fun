// Generates Firebreak levels: noise-painted maps with a village downwind of the fire,
// then an annealing search over tool placements. The best plan is stored; targets come
// from it (1 star needs more houses than doing nothing saves).
//   npx tsx scripts/gen-firebreak.ts [--ch N] [1-4]
import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng';
import { canPlace, DIRS, emptyPlan, run, type FBLevel, type Plan, type ToolKind, type WindStep } from '../src/games/firebreak/logic';

const DIR = 'src/games/firebreak/levels';

interface Spec {
  name: string;
  size: [number, number];
  wind: number;            // strength 0-2
  shift?: boolean;         // wind changes direction mid-burn
  houses: number;
  tools: Partial<Record<ToolKind, number>>;
  grass?: number;          // extra dryness (summer)
  river?: boolean;
  road?: boolean;
  starts?: number;
}
const S = (name: string, size: [number, number], wind: number, houses: number, tools: Spec['tools'], o: Partial<Spec> = {}): Spec => ({ name, size, wind, houses, tools, ...o });

const SPECS: Spec[][] = [
  [
    S('First spark', [14, 9], 1, 3, { firebreak: 2 }), S('Fire line', [16, 10], 1, 4, { firebreak: 4 }), S('Two paths', [16, 10], 1, 4, { firebreak: 5 }, { river: true }),
    S('Soak it', [16, 10], 1, 4, { firebreak: 3, water: 1 }), S('Meadow', [18, 11], 1, 5, { firebreak: 5, water: 1 }), S('Crossroads', [18, 11], 1, 5, { firebreak: 4, water: 2 }, { road: true }),
    S('Riverbank', [18, 12], 1, 6, { firebreak: 5, water: 2 }, { river: true }), S('Orchard', [20, 12], 1, 6, { firebreak: 6, water: 2 }), S('Burn it first', [20, 12], 1, 6, { firebreak: 3, backburn: 3 }),
    S('Spring fair', [20, 13], 1, 7, { firebreak: 5, water: 2, backburn: 2 }, { road: true }),
  ],
  [
    S('Dry spell', [20, 12], 1, 6, { firebreak: 6, water: 1 }, { grass: 0.25 }), S('Tinder', [20, 13], 1, 6, { firebreak: 6, backburn: 2 }, { grass: 0.3 }),
    S('Two fires', [20, 13], 1, 7, { firebreak: 6, water: 2 }, { grass: 0.2, starts: 2 }), S('Heatwave', [22, 13], 1, 7, { firebreak: 7, water: 2, backburn: 2 }, { grass: 0.3, river: true }),
    S('Cloudburst', [22, 14], 1, 7, { firebreak: 5, rain: 1 }, { grass: 0.25 }), S('Scorched', [22, 14], 1, 8, { firebreak: 6, water: 2, rain: 1 }, { grass: 0.35, road: true }),
    S('Brushfire', [22, 14], 1, 8, { firebreak: 6, backburn: 3, rain: 1 }, { grass: 0.3, starts: 2 }), S('Dust bowl', [24, 15], 1, 8, { firebreak: 8, water: 2, rain: 1 }, { grass: 0.4 }),
    S('Wildfire', [24, 15], 1, 9, { firebreak: 8, water: 2, backburn: 2, rain: 1 }, { grass: 0.35, river: true }), S('Last water', [24, 16], 1, 9, { firebreak: 7, water: 3, backburn: 2, rain: 2 }, { grass: 0.4, starts: 2 }),
  ],
  [
    S('Gusts', [20, 13], 2, 6, { firebreak: 6, water: 2 }), S('Embers', [22, 13], 2, 7, { firebreak: 6, water: 2, backburn: 2 }), S('Turning wind', [22, 14], 1, 7, { firebreak: 7, water: 2 }, { shift: true }),
    S('Gale', [22, 14], 2, 7, { firebreak: 7, water: 2, rain: 1 }, { river: true }), S('Storm front', [24, 15], 2, 8, { firebreak: 7, water: 2, backburn: 2 }, { shift: true }),
    S('Firestorm', [24, 15], 2, 8, { firebreak: 8, water: 3, rain: 1 }, { starts: 2 }), S('Leaf fall', [24, 15], 2, 8, { firebreak: 8, backburn: 3, rain: 1 }, { road: true }),
    S('Weathervane', [24, 16], 2, 9, { firebreak: 8, water: 3, rain: 1 }, { shift: true, river: true }), S('Hurricane', [24, 16], 2, 9, { firebreak: 9, water: 3, backburn: 2, rain: 1 }, { starts: 2 }),
    S('Final stand', [24, 16], 2, 10, { firebreak: 10, water: 3, backburn: 3, rain: 2 }, { shift: true, starts: 2 }),
  ],
];

function noise(w: number, h: number, rng: Rng, scale: number): number[][] {
  const gw = Math.ceil(w / scale) + 2, gh = Math.ceil(h / scale) + 2;
  const grid = Array.from({ length: gh }, () => Array.from({ length: gw }, () => rng.next()));
  const out: number[][] = [];
  for (let y = 0; y < h; y++) {
    out.push([]);
    for (let x = 0; x < w; x++) {
      const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = grid[iy][ix] + (grid[iy][ix + 1] - grid[iy][ix]) * sx;
      const b = grid[iy + 1][ix] + (grid[iy + 1][ix + 1] - grid[iy + 1][ix]) * sx;
      out[y].push(a + (b - a) * sy);
    }
  }
  return out;
}

function makeMap(spec: Spec, rng: Rng): FBLevel | null {
  const [w, h] = spec.size;
  const n = noise(w, h, rng, 4);
  const g: string[][] = n.map((row) => row.map((v) => {
    const dry = spec.grass ?? 0;
    if (v < 0.38 + dry) return '.';
    if (v < 0.55 + dry * 0.5) return 'b';
    return 'f';
  }));
  for (let k = 0; k < Math.round(w * h * 0.03); k++) g[rng.int(0, h - 1)][rng.int(0, w - 1)] = '#';
  // Wind: from the fire side toward the village side.
  const dir = rng.pick([0, 1, 7, 2, 6]);
  const [dx, dy] = DIRS[dir];
  // Village near the downwind edge, fire near the upwind edge.
  const vx = Math.round(w / 2 + dx * (w / 2 - 3)), vy = Math.round(h / 2 + dy * (h / 2 - 2.5));
  const fx = Math.round(w / 2 - dx * (w / 2 - 2)), fy = Math.round(h / 2 - dy * (h / 2 - 2));
  // A barrier across the wind (river or rocky ridge) with gaps the tools must deal with.
  const vertical = Math.abs(dx) >= Math.abs(dy);
  const len = vertical ? h : w;
  const at = vertical ? Math.round(w / 2 + dx * rng.int(-1, 1)) : Math.round(h / 2 + dy * rng.int(-1, 1));
  const gapCells = (spec.tools.firebreak ?? 0) + (spec.tools.backburn ?? 0) + ((spec.tools.water ?? 0) > 0 ? 1 : 0) + ((spec.tools.rain ?? 0) > 0 ? 1 : 0);
  // Strong wind throws embers 2 tiles: the barrier is 2 cells thick, so each gap row costs 2 tools.
  const thick = spec.wind === 2 ? 2 : 1;
  const gapRows = Math.max(1, Math.round((gapCells * 0.75) / thick));
  const gaps = new Set<number>();
  while (gaps.size < Math.min(len - 2, gapRows)) {
    const start = rng.int(0, len - 1), width = rng.int(1, thick === 2 ? 2 : 3);
    for (let k = 0; k < width && gaps.size < gapRows; k++) if (start + k < len) gaps.add(start + k);
  }
  const mat = spec.river ? '~' : '#';
  const gapList: [number, number][] = [];
  let wob = 0, prev = -1;
  const sx = vertical ? Math.sign(dx || 1) : 0, sy = vertical ? 0 : Math.sign(dy || 1);
  for (let k = 0; k < len; k++) {
    if (k % 3 === 0) wob = Math.max(-1, Math.min(1, wob + rng.int(-1, 1)));
    const p = Math.max(1, Math.min((vertical ? w : h) - 1 - thick, at + wob));
    for (let t = 0; t < thick; t++) {
      const cx = vertical ? p + t * sx : k, cy = vertical ? k : p + t * sy;
      if (gaps.has(k)) {
        // Gaps are grass or bush unless backburns are available (then forest gaps are fair).
        const ch = (spec.tools.backburn ?? 0) > 0 && rng.chance(0.4) ? 'f' : rng.chance(0.5) ? '.' : 'b';
        g[cy][cx] = ch;
        gapList.push([cx, cy]);
      } else {
        g[cy][cx] = mat;
        // Where the barrier steps sideways, fill the corner so fire can't slip through diagonally.
        if (prev >= 0 && prev !== p && !gaps.has(k - 1)) { if (vertical) g[k][prev + t * sx] = mat; else g[prev + t * sy][k] = mat; }
      }
    }
    prev = p;
  }
  if (spec.road) {
    const r = rng.int(2, h - 3);
    for (let x = 0; x < w; x++) if (g[r][x] !== '~') g[r][x] = '=';
  }
  // Village: houses on cleared ground around (vx, vy).
  let placed = 0;
  for (let t = 0; t < 200 && placed < spec.houses; t++) {
    const x = vx + rng.int(-3, 3), y = vy + rng.int(-2, 2);
    if (x < 0 || y < 0 || x >= w || y >= h || g[y][x] === 'H' || g[y][x] === '~' || g[y][x] === '#') continue;
    // Houses stay on the village side of the barrier, two cells clear of it.
    if (vertical ? (x - at) * Math.sign(dx || 1) < 3 : (y - at) * Math.sign(dy || 1) < 3) continue;
    g[y][x] = 'H'; placed++;
    if (rng.chance(0.4)) { const gx = x + rng.sign(), gy = y; if (gx >= 0 && gx < w && g[gy][gx] !== 'H' && g[gy][gx] !== '~') g[gy][gx] = '.'; }
  }
  if (placed < spec.houses) return null;
  const starts: [number, number][] = [];
  for (let k = 0; k < (spec.starts ?? 1); k++) {
    const x = Math.max(0, Math.min(w - 1, fx + (k ? rng.int(-4, 4) : 0))), y = Math.max(0, Math.min(h - 1, fy + (k ? rng.int(-4, 4) : rng.int(-1, 1))));
    g[y][x] = 'f'; starts.push([x, y]);
  }
  const wind: WindStep[] = [[0, dir, spec.wind]];
  if (spec.shift) wind.push([rng.int(8, 14), (dir + rng.pick([1, 7, 2, 6])) % 8, spec.wind]);
  GAPS.set(spec.name, gapList);
  return { name: spec.name, rows: g.map((r) => r.join('')), starts, wind, tools: spec.tools, target: 0, forest: 0, solution: emptyPlan() };
}

/** Gap cells of the last map made for each spec (seeds the search). */
const GAPS = new Map<string, [number, number][]>();

const score = (o: { saved: number; forestPct: number }) => o.saved * 1000 + o.forestPct;

function search(l: FBLevel, rng: Rng, iters: number): { plan: Plan; o: ReturnType<typeof run>['out'] } {
  const base = run(l, emptyPlan());
  const w = l.rows[0].length, h = l.rows.length;
  // Candidates: anything that burned without help, and cells next to it.
  const near: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hot = false;
    for (let dy = -1; dy <= 1 && !hot; dy++) for (let dx = -1; dx <= 1 && !hot; dx++) {
      const i = (y + dy) * w + x + dx;
      if (y + dy >= 0 && y + dy < h && x + dx >= 0 && x + dx < w && base.sim.litAt[i] >= 0) hot = true;
    }
    if (hot) near.push([x, y]);
  }
  const kinds = (['firebreak', 'water', 'backburn'] as const).filter((k) => (l.tools[k] ?? 0) > 0);
  const rainN = l.tools.rain ?? 0;
  const randomCell = (k: ToolKind): [number, number] | null => {
    for (let t = 0; t < 40; t++) { const c = rng.pick(near); if (canPlace(l.rows, k, c[0], c[1], l.starts)) return [c[0], c[1]]; }
    return null;
  };
  const plan = emptyPlan();
  // Seed: plug the barrier gaps (firebreaks, or backburns on forest), then fill the rest randomly.
  for (const [c, r] of GAPS.get(l.name) ?? []) {
    for (const k of ['firebreak', 'backburn'] as const) {
      if (plan[k].length < (l.tools[k] ?? 0) && canPlace(l.rows, k, c, r, l.starts)) { plan[k].push([c, r]); break; }
    }
  }
  for (const k of kinds) while (plan[k].length < (l.tools[k] ?? 0)) { const c = randomCell(k); if (!c) break; if (!plan[k].some((p) => p[0] === c[0] && p[1] === c[1])) plan[k].push(c); }
  for (let i = 0; i < rainN; i++) { const c = rng.pick(near); plan.rain.push([Math.round(rng.range(1, 12) * 20) / 20, c[0], c[1]]); }
  let cur = run(l, plan).out;
  let best = { plan: structuredClone(plan), o: cur };
  for (let it = 0; it < iters; it++) {
    const T = 600 * Math.pow(0.002, it / iters);
    const next = structuredClone(plan);
    const pickKind = rng.pick([...kinds, ...(rainN ? ['rain' as const] : [])]);
    if (pickKind === 'rain') {
      const i = rng.int(0, next.rain.length - 1);
      const c = rng.chance(0.5) ? rng.pick(near) : [next.rain[i][1] + rng.int(-1, 1), next.rain[i][2] + rng.int(-1, 1)];
      next.rain[i] = [Math.max(0.05, Math.round((next.rain[i][0] + rng.range(-1.5, 1.5)) * 20) / 20), Math.max(0, Math.min(w - 1, c[0])), Math.max(0, Math.min(h - 1, c[1]))];
    } else {
      const list = next[pickKind];
      if (!list.length) continue;
      const i = rng.int(0, list.length - 1);
      const c = rng.chance(0.6) ? [list[i][0] + rng.int(-1, 1), list[i][1] + rng.int(-1, 1)] as [number, number] : randomCell(pickKind);
      if (!c || !canPlace(l.rows, pickKind, c[0], c[1], l.starts) || list.some((p) => p[0] === c[0] && p[1] === c[1])) continue;
      list[i] = c;
    }
    const o = run(l, next).out;
    if (score(o) >= score(cur) || rng.next() < Math.exp((score(o) - score(cur)) / T)) {
      Object.assign(plan, next); cur = o;
      if (score(o) > score(best.o)) best = { plan: structuredClone(next), o };
    }
  }
  return best;
}

function generate(spec: Spec, seed: number): FBLevel {
  const rng = new Rng(seed);
  let best: { l: FBLevel; q: number } | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const l = makeMap(spec, rng);
    if (!l) continue;
    const base = run(l, emptyPlan()).out;
    if (base.saved > l.rows.join('').split('H').length - 1 - 2) continue; // fire must threaten at least 3 houses
    const r = search(l, rng, 1500);
    if (process.env.FB_DEBUG) {
      console.log(`  attempt ${attempt}: base ${base.saved}/${r.o.houses} best ${r.o.saved} forest ${r.o.forestPct} wind ${JSON.stringify(l.wind)} plan ${JSON.stringify(r.plan)}`);
      if (attempt === 0) console.log(l.rows.join('\n'));
    }
    if (r.o.saved !== r.o.houses) continue;
    l.solution = r.plan;
    l.target = Math.min(r.o.houses, Math.max(base.saved + 1, Math.ceil(r.o.houses * 0.6)));
    l.forest = Math.floor(r.o.forestPct / 5) * 5;
    // Quality: big gap between doing nothing and the stored plan.
    const q = (r.o.houses - base.saved) * 10 + r.o.forestPct / 10 + rng.next();
    if (!best || q > best.q) best = { l, q };
    if (attempt > 6 && best) break;
  }
  if (!best) throw new Error(`could not generate ${spec.name}`);
  return best.l;
}

const TITLES = [['1-spring', 'Spring'], ['2-summer', 'Summer drought'], ['3-autumn', 'Autumn storms']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 3; ch++) {
  if (chOnly && ch !== chOnly) continue;
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: FBLevel[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: FBLevel[] = [];
  SPECS[ch - 1].forEach((spec, i) => {
    const id = `${ch}-${i + 1}`;
    if (only && only !== id && existing[i]) { levels.push(existing[i]); return; }
    const t0 = Date.now();
    const l = generate(spec, 51000 + ch * 100 + i);
    levels.push(l);
    const base = run(l, emptyPlan()).out, sol = run(l, l.solution).out;
    console.log(`${id.padEnd(5)} ${l.name.padEnd(14)} ${l.rows[0].length}x${l.rows.length} houses ${sol.houses} nothing-saves ${base.saved} target ${l.target} forest ${l.forest}% (stored ${sol.forestPct}%) tools ${JSON.stringify(l.tools)} (${Date.now() - t0} ms)`);
  });
  writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
