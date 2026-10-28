// Generates Rocket Builder missions. Candidate rockets are built from stage
// templates (tanks, engine, boosters, fins, legs, parachute), pruned by delta-v
// and launch thrust, then flown cheapest-first by the flight computer. The first
// that earns 3 stars - and still does with 3% weaker engines - is stored.
// Budget = cost / 0.6 (normal) or cost / 0.8 (budget challenges).
//   npx tsx scripts/gen-rocket-builder.ts [--ch N] [2-3]
import { readFileSync, writeFileSync } from 'node:fs';
import { fly } from '../src/games/rocket-builder/autopilot';
import { designCost, stageInfo, type Design, type Goal, type PartKind, type RMission } from '../src/games/rocket-builder/logic';

const DIR = 'src/games/rocket-builder/levels';
type Row = Design['rows'][number];

const P1: PartKind[] = ['pod', 'chute', 'cone', 'tankS', 'tankM', 'tankL', 'engineS', 'engineB', 'fins'];
const P2: PartKind[] = [...P1, 'decoupler', 'booster'];
const P3: PartKind[] = [...P2, 'legs'];

interface Spec { name: string; goal: Goal; tight?: boolean; parts: PartKind[]; dv: number }
const SPECS: Spec[][] = [
  [
    { name: 'Hop to 1 km', goal: { kind: 'alt', alt: 1000 }, parts: P1, dv: 200 },
    { name: 'Sky high', goal: { kind: 'alt', alt: 20_000 }, parts: P1, dv: 700 },
    { name: 'Safe return', goal: { kind: 'return', alt: 30_000 }, parts: P1, dv: 900 },
    { name: 'Touch space', goal: { kind: 'alt', alt: 100_000 }, parts: P2, dv: 1600 },
    { name: 'Space on a shoestring', goal: { kind: 'alt', alt: 100_000 }, parts: P2, dv: 1600, tight: true },
  ],
  [
    { name: 'Reach orbit', goal: { kind: 'orbit' }, parts: P2, dv: 3000 },
    { name: 'Two-stage orbit', goal: { kind: 'orbit', stages: 2 }, parts: P2, dv: 3000 },
    { name: 'Orbit and home', goal: { kind: 'orbitReturn' }, parts: P2, dv: 3100 },
    { name: 'Budget orbit', goal: { kind: 'orbit' }, parts: P2, dv: 3000, tight: true },
    { name: 'Round trip on a budget', goal: { kind: 'orbitReturn' }, parts: P2, dv: 3100, tight: true },
  ],
  [
    { name: 'Flyby the Moon', goal: { kind: 'moonFlyby' }, parts: P3, dv: 4300 },
    { name: 'Orbit the Moon', goal: { kind: 'moonOrbit' }, parts: P3, dv: 4500 },
    { name: 'Land on the Moon', goal: { kind: 'moonLand' }, parts: P3, dv: 4700 },
    { name: 'Moon and back', goal: { kind: 'moonReturn' }, parts: P3, dv: 5600 },
    { name: 'Budget Moon landing', goal: { kind: 'moonLand' }, parts: P3, dv: 4700, tight: true },
  ],
];

interface Stage { tanks: PartKind[]; engine: PartKind; boosters: 0 | 2 | 4; fins: boolean; legs: boolean }

const TANKS: PartKind[][] = [['tankS'], ['tankM'], ['tankL'], ['tankM', 'tankM'], ['tankL', 'tankM'], ['tankL', 'tankL'], ['tankL', 'tankL', 'tankL']];

function build(stages: Stage[], chute: boolean, cone: boolean): Design {
  const rows: Row[] = [];
  if (cone) rows.push(['cone', '', '']);
  if (chute) rows.push(['chute', '', '']);
  rows.push(['pod', '', '']);
  // stages[0] is the top stage.
  stages.forEach((s, i) => {
    if (i > 0) rows.push(['decoupler', '', '']);
    s.tanks.forEach((t, k) => {
      const b = s.boosters === 4 ? 'booster' : s.boosters === 2 && k === s.tanks.length - 1 ? 'booster' : '';
      rows.push([t, b as Row[1], b as Row[2]]);
    });
    const side = s.fins ? 'fins' : s.legs ? 'legs' : '';
    rows.push([s.engine, side, side]);
  });
  return { rows };
}

function* candidates(spec: Spec): Generator<Design> {
  const allow = new Set(spec.parts);
  const engines: PartKind[] = ['engineS', 'engineB'];
  const boosts: (0 | 2 | 4)[] = allow.has('booster') ? [0, 2, 4] : [0];
  const moon = spec.goal.kind.startsWith('moon');
  const maxStages = !allow.has('decoupler') ? 1 : moon ? 3 : 2;
  const stageOpts = (top: boolean, bottom: boolean): Stage[] => {
    const out: Stage[] = [];
    for (const tanks of TANKS) for (const engine of engines) for (const boosters of bottom ? boosts : [0 as const]) for (const fins of bottom ? [false, true] : [false]) {
      if (boosters === 4 && tanks.length < 2) continue;
      const legs = top && moon && allow.has('legs');
      out.push({ tanks, engine, boosters, fins, legs: legs && !(bottom && fins) });
    }
    return out;
  };
  for (let n = 1; n <= maxStages; n++) {
    const levels: Stage[][] = [];
    for (let i = 0; i < n; i++) levels.push(stageOpts(i === 0, i === n - 1));
    const idx = new Array(n).fill(0);
    for (;;) {
      const st = idx.map((k, i) => levels[i][k]);
      for (const cone of allow.has('cone') ? [false, true] : [false]) yield build(st, true, cone);
      let i = n - 1;
      while (i >= 0 && ++idx[i] >= levels[i].length) { idx[i] = 0; i--; }
      if (i < 0) break;
    }
  }
}

function generate(spec: Spec): RMission {
  const pool: { d: Design; cost: number }[] = [];
  for (const d of candidates(spec)) {
    const si = stageInfo(d);
    const dv = si.reduce((s, x) => s + x.dv, 0);
    if (dv < spec.dv || si[0].twr < 1.25) continue;
    if (spec.goal.kind === 'orbit' && spec.goal.stages && si.length < 2) continue;
    pool.push({ d, cost: designCost(d) });
  }
  pool.sort((a, b) => a.cost - b.cost || a.d.rows.length - b.d.rows.length);
  let tried = 0;
  for (const { d, cost } of pool) {
    tried++;
    const r = fly(spec.goal, d, 1e9);
    if (r.stars < 3) continue;
    if (fly(spec.goal, d, 1e9, { thrustScale: 0.97 }).stars < 3) continue;
    const budget = spec.tight ? Math.ceil(cost / 0.8 / 5) * 5 : Math.ceil(cost / 0.6 / 10) * 10;
    if (process.env.RB_DEBUG) console.log(`  tried ${tried}/${pool.length}`);
    return { name: spec.name, goal: spec.goal, budget, parts: spec.parts, solution: d };
  }
  throw new Error(`no design flies ${spec.name} (${pool.length} candidates)`);
}

const TITLES = [['1-liftoff', 'Liftoff'], ['2-orbit', 'Orbit'], ['3-moon', 'The Moon']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 3; ch++) {
  if (chOnly && ch !== chOnly) continue;
  if (only && !only.startsWith(`${ch}-`)) continue;
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: RMission[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: RMission[] = [];
  SPECS[ch - 1].forEach((spec, i) => {
    const id = `${ch}-${i + 1}`;
    if (only && only !== id && existing[i]) { levels.push(existing[i]); return; }
    const t0 = Date.now();
    try {
      const m = generate(spec);
      levels.push(m);
      console.log(`${id.padEnd(5)} ${m.name.padEnd(24)} cost ${designCost(m.solution)} budget ${m.budget} rows ${m.solution.rows.length} ${m.solution.rows.map((r) => r.filter(Boolean).join('+')).join(',')} (${Date.now() - t0} ms)`);
    } catch (e) { console.log(`${id} FAILED ${(e as Error).message}`); }
  });
  if (levels.length === SPECS[ch - 1].length) writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
