// Generates Gravity Golf levels: random galaxy layouts, then a search over planet
// placements and shots. Stored solutions are chosen for robustness (neighbouring
// angles and powers also sink it and collect the stardust), so a human aim has
// tolerance. Stardust goes along the stored path.
//   npx tsx scripts/gen-gravity-golf.ts [--ch N] [1-4]
import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng';
import { placeOk, simulate, WORLD, type GGLevel, type Placed, type Size } from '../src/games/gravity-golf/logic';

const DIR = 'src/games/gravity-golf/levels';

interface Spec {
  name: string;
  /** Planets the stored solution uses (inventory = this + 1). */
  use: 0 | 1;
  sizes?: Size[];
  fixed?: number;
  rocks?: 'belt' | 'field' | 'wall';
  moons?: number;
  worm?: boolean;
  stars?: number;
  /** Require that no shot works without placing a planet. */
  needPlanet?: boolean;
}

const S = (name: string, use: 0 | 1, o: Partial<Spec> = {}): Spec => ({ name, use, needPlanet: use === 1, ...o });
const SPECS: Spec[][] = [
  [S('Tee off', 0), S('Gentle curve', 0, { fixed: 1 }), S('Around the bend', 0, { fixed: 1 }), S('First planet', 1, { fixed: 1 }),
    S('Pull', 1, { fixed: 1 }), S('Heavyweight', 1, { fixed: 2, sizes: ['large'] }), S('Twin planets', 1, { fixed: 2 }),
    S('Hook shot', 1, { fixed: 2 }), S('Big or small', 1, { fixed: 2, sizes: ['small', 'large'] }), S('Home run', 1, { fixed: 3 })],
  [S('Rubble', 1, { rocks: 'belt' }), S('The gap', 1, { rocks: 'wall' }), S('Pebbles', 1, { rocks: 'field' }), S('Belt and braces', 1, { rocks: 'belt', fixed: 1 }),
    S('Needle', 1, { rocks: 'wall', fixed: 1 }), S('Debris', 1, { rocks: 'field', fixed: 1 }), S('Over the wall', 1, { rocks: 'wall', fixed: 1, sizes: ['large'] }),
    S('Gravel', 1, { rocks: 'field', fixed: 2 }), S('Two belts', 1, { rocks: 'belt', fixed: 2 }), S('Asteroid alley', 1, { rocks: 'field', fixed: 2, sizes: ['small', 'large'] })],
  [S('Moonrise', 1, { moons: 1 }), S('Tick tock', 1, { moons: 1, fixed: 1 }), S('Shortcut', 1, { worm: true }), S('Orbit dance', 1, { moons: 2 }),
    S('Through the hole', 1, { worm: true, fixed: 1 }), S('Moon garden', 1, { moons: 2, fixed: 1 }), S('Timing', 1, { moons: 1, rocks: 'belt' }),
    S('Tunnel vision', 1, { worm: true, rocks: 'field' }), S('Clockwork', 1, { moons: 2, worm: true }), S('Eclipse', 1, { moons: 2, fixed: 2 })],
  [S('Push', 1, { stars: 1 }), S('Pinball', 1, { stars: 1, fixed: 1 }), S('Repelled', 1, { stars: 2 }), S('Push and pull', 1, { stars: 1, fixed: 2 }),
    S('Far well', 1, { stars: 1, rocks: 'belt' }), S('Bumper', 1, { stars: 2, fixed: 1 }), S('Wormwood', 1, { stars: 1, worm: true }),
    S('Lunar push', 1, { stars: 1, moons: 1 }), S('Deep field', 1, { stars: 2, rocks: 'field', fixed: 1 }), S('Grand finale', 1, { stars: 1, moons: 1, worm: true, fixed: 1 })],
];

function layout(spec: Spec, rng: Rng): GGLevel {
  const l: GGLevel = {
    name: spec.name, comet: [rng.int(70, 120), rng.int(110, 490)], hole: [rng.int(820, 890), rng.int(110, 490)],
    planets: [], rocks: [], moons: [], holes: [], dust: [], inv: {}, solution: { planets: [], shot: [0, 0] },
  };
  const [cx, cy] = l.comet, [hx, hy] = l.hole;
  const along = (k: number, off: number) => [cx + (hx - cx) * k - ((hy - cy) / Math.hypot(hx - cx, hy - cy)) * off, cy + (hy - cy) * k + ((hx - cx) / Math.hypot(hx - cx, hy - cy)) * off];
  for (let i = 0; i < (spec.fixed ?? 0); i++) {
    const [x, y] = along(rng.range(0.3, 0.7), rng.range(-90, 90));
    const r = rng.int(18, 34);
    l.planets.push([Math.round(x), Math.round(Math.max(60, Math.min(540, y))), r, Math.round((r / 22) ** 2 * 10) / 10]);
  }
  for (let i = 0; i < (spec.stars ?? 0); i++) {
    const [x, y] = along(rng.range(0.3, 0.7), rng.range(-120, 120));
    l.planets.push([Math.round(x), Math.round(Math.max(70, Math.min(530, y))), 16, -1.4]);
  }
  if (spec.rocks === 'belt') {
    const x0 = rng.int(380, 580), gap = rng.int(80, 460);
    for (let y = 20; y < WORLD.h - 10; y += 26) if (Math.abs(y - gap) > 45) l.rocks.push([x0 + rng.int(-10, 10), y, rng.int(8, 12)]);
  } else if (spec.rocks === 'wall') {
    const x0 = rng.int(420, 540), gap = rng.int(100, 500);
    for (let y = 10; y < WORLD.h; y += 22) if (Math.abs(y - gap) > 32) l.rocks.push([x0, y, 11]);
  } else if (spec.rocks === 'field') {
    for (let i = 0; i < 26; i++) l.rocks.push([rng.int(260, 720), rng.int(30, 570), rng.int(7, 13)]);
  }
  for (let i = 0; i < (spec.moons ?? 0); i++) {
    const [x, y] = along(rng.range(0.35, 0.65), rng.range(-60, 60));
    l.moons.push([Math.round(x), Math.round(Math.max(150, Math.min(450, y))), rng.int(70, 120), rng.int(4, 8), rng.int(0, 359), 13, 0.8]);
  }
  if (spec.worm) {
    l.holes.push([rng.int(250, 400), rng.int(80, 520), rng.int(560, 720), rng.int(80, 520)]);
  }
  // Keep things off the comet and the hole.
  const far = (x: number, y: number, d: number) => Math.hypot(x - cx, y - cy) > d && Math.hypot(x - hx, y - hy) > d;
  l.planets = l.planets.filter(([x, y, r]) => far(x, y, r + 60));
  l.rocks = l.rocks.filter(([x, y, r]) => far(x, y, r + 50));
  return l;
}

const ANGLES = Array.from({ length: 180 }, (_, i) => i * 2 - 179);
const POWERS = Array.from({ length: 15 }, (_, i) => Math.round((0.3 + i * 0.05) * 1000) / 1000);

/** Shots that sink it, with a robustness score from the neighbourhood. */
function scan(l: GGLevel, placed: Placed[]): { shot: [number, number]; t: number }[] {
  const out: { shot: [number, number]; t: number }[] = [];
  for (const a of ANGLES) for (const p of POWERS) {
    const r = simulate(l, placed, [a, p]);
    if (r.outcome === 'capture') out.push({ shot: [a, p], t: r.t });
  }
  return out;
}

function freeDust(l: GGLevel): boolean {
  for (const a of ANGLES) for (const p of POWERS) { const r = simulate(l, [], [a, p]); if (r.outcome === 'capture' && r.dust === 7) return true; }
  for (const a of ANGLES) for (const p of POWERS) { const r = simulate(l, [], [a + 1, p + 0.025]); if (r.outcome === 'capture' && r.dust === 7) return true; }
  return false;
}

function robust(l: GGLevel, placed: Placed[], shot: [number, number], needDust: number): number {
  let n = 0;
  for (const da of [-1, -0.5, 0, 0.5, 1]) for (const dp of [-0.02, -0.01, 0, 0.01, 0.02]) {
    const r = simulate(l, placed, [shot[0] + da, Math.min(1, shot[1] + dp)]);
    if (r.outcome === 'capture' && (r.dust & needDust) === needDust) n++;
  }
  return n;
}

function pickDust(l: GGLevel, placed: Placed[], shot: [number, number], rng: Rng): [number, number][] | null {
  const r = simulate(l, placed, shot, 2);
  const pts: [number, number][] = [];
  for (let i = 0; i < r.path.length; i += 3) pts.push([r.path[i], r.path[i + 1]]);
  if (pts.length < 20) return null;
  const out: [number, number][] = [];
  for (const k of [rng.range(0.22, 0.34), rng.range(0.48, 0.6), rng.range(0.72, 0.84)]) {
    const [x, y] = pts[Math.floor(pts.length * k)];
    out.push([Math.round(x), Math.round(y)]);
  }
  return out;
}

function generate(spec: Spec, seed: number): GGLevel {
  const rng = new Rng(seed);
  let best: { l: GGLevel; score: number } | null = null;
  const t0 = Date.now();
  for (let attempt = 0; attempt < 400 && (Date.now() - t0 < 40_000 || !best); attempt++) {
    if (best && best.score >= 20) break;
    const l = layout(spec, rng);
    // Without planets: for "needPlanet" levels nothing may sink it.
    const free = spec.use === 0 ? scan(l, []) : [];
    const sizes = spec.sizes ?? ['small'];
    let found: { placed: Placed[]; shot: [number, number] }[] = [];
    if (spec.use === 0) found = free.map((f) => ({ placed: [], shot: f.shot }));
    else {
      for (let k = 0; k < 14 && found.length < 30; k++) {
        const s = rng.pick(sizes);
        const x = rng.int(200, 760), y = rng.int(50, 550);
        if (!placeOk(l, [], s, x, y)) continue;
        const placed: Placed[] = [[s, x, y]];
        for (const f of scan(l, placed)) found.push({ placed, shot: f.shot });
      }
    }
    if (!found.length) continue;
    // Most robust candidate (before dust), then add dust along its path and re-score.
    rng.shuffle(found);
    for (const cand of found.slice(0, 12)) {
      const rb = robust(l, cand.placed, cand.shot, 0);
      if (rb < 8) continue;
      const dust = pickDust(l, cand.placed, cand.shot, rng);
      if (!dust) continue;
      const lv: GGLevel = { ...l, dust, inv: invFor(spec, cand.placed), solution: { planets: cand.placed, shot: cand.shot } };
      const r = simulate(lv, cand.placed, cand.shot);
      if (r.outcome !== 'capture' || r.dust !== 7) continue;
      if (!cand.placed.every((p, i) => placeOk(lv, cand.placed, p[0], p[1], p[2], i))) continue;
      // With a planet to place, a shot without one may sink it but must not also collect all the dust.
      if (spec.needPlanet && freeDust(lv)) continue;
      const rd = robust(lv, cand.placed, cand.shot, 7);
      // Curvier, longer flights are more fun; robustness keeps it fair.
      const score = rd + (spec.use === 0 ? -2 * r.t : Math.min(8, r.t * 2));
      if (!best || score > best.score) best = { l: lv, score };
    }
  }
  if (!best) throw new Error(`could not generate ${spec.name}`);
  return best.l;
}

function invFor(spec: Spec, placed: Placed[]): GGLevel['inv'] {
  const inv: GGLevel['inv'] = {};
  for (const [s] of placed) inv[s] = (inv[s] ?? 0) + 1;
  // One more than the solution needs ("fewer than allowed" is the third star).
  const extra: Size = spec.sizes?.includes('large') && spec.sizes.length > 1 ? (placed[0]?.[0] === 'large' ? 'small' : 'large') : (spec.sizes?.[0] ?? 'small');
  inv[extra] = (inv[extra] ?? 0) + 1;
  return inv;
}

const TITLES = [['1-home', 'Home Galaxy'], ['2-asteroids', 'Asteroid Reach'], ['3-moons', 'Moon Gardens'], ['4-far-wells', 'Far Wells']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 4; ch++) {
  if (chOnly && ch !== chOnly) continue;
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: GGLevel[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: GGLevel[] = [];
  SPECS[ch - 1].forEach((spec, i) => {
    const id = `${ch}-${i + 1}`;
    if (only && only !== id && existing[i]) { levels.push(existing[i]); return; }
    const t0 = Date.now();
    const l = generate(spec, 31000 + ch * 100 + i);
    levels.push(l);
    console.log(`${id.padEnd(5)} ${l.name.padEnd(18)} inv ${JSON.stringify(l.inv)} shot ${l.solution.shot} planets ${l.solution.planets.length} (${Date.now() - t0} ms)`);
  });
  writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
