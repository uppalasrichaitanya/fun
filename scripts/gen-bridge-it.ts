// Generates Bridge It levels. For each level, candidate designs are built from
// templates (over-truss, under-truss tied to low anchors, cable fans from towers,
// piers on a river rock) in different depths and materials, and simulated. The
// cheapest design that gets the vehicle across is stored; budget = cost / 0.6
// (rounded up to $50), so the stored design earns 3 stars and sloppier ones 1-2.
//   npx tsx scripts/gen-bridge-it.ts [--ch N] [1-4]
import { readFileSync, writeFileSync } from 'node:fs';
import { addBeam, beamCost, boatClash, Bridge, MATS, type BLevel, type Design, type Mat, type VehicleKind } from '../src/games/bridge-it/logic';

const DIR = 'src/games/bridge-it/levels';

interface Spec { name: string; span: number; vehicle: VehicleKind; mats: Mat[]; low?: number; towers?: number; rock?: boolean; boat?: boolean }
const S = (name: string, span: number, vehicle: VehicleKind, mats: Mat[], o: Partial<Spec> = {}): Spec => ({ name, span, vehicle, mats, ...o });
const R1: Mat[] = ['road', 'wood'];
const R2: Mat[] = ['road', 'wood', 'steel'];
const C2: Mat[] = ['road', 'road2', 'wood', 'steel'];
const M3: Mat[] = ['road', 'road2', 'wood', 'steel', 'cable'];

const SPECS: Spec[][] = [
  [
    S('First crossing', 120, 'car', R1, { low: 60 }), S('Creek', 160, 'car', R1, { low: 60 }), S('Brook', 200, 'car', R1, { low: 80 }),
    S('Steel', 240, 'car', R2, { low: 60 }), S('Ferry lane', 240, 'car', R2, { boat: true }), S('Stepping stone', 280, 'car', R2, { rock: true }),
    S('Wide river', 280, 'car', R2, { low: 80 }), S('Delivery', 240, 'truck', R2, { low: 80 }), S('Riverboat', 280, 'car', R2, { boat: true }),
    S('Heavy load', 320, 'truck', R2, { rock: true, low: 60 }),
  ],
  [
    S('Canyon rim', 280, 'truck', C2, { low: 100 }), S('Deep cut', 320, 'truck', C2, { low: 120 }), S('School run', 280, 'bus', C2, { low: 80 }),
    S('Gorge', 360, 'truck', C2, { low: 120 }), S('Long bus', 320, 'bus', C2, { low: 100 }), S('Pillar', 360, 'bus', C2, { rock: true }),
    S('Rapids', 320, 'truck', C2, { boat: true, low: 0 }), S('Dry wash', 400, 'truck', C2, { low: 120 }), S('Double decker', 360, 'bus', C2, { low: 120 }),
    S('Grand canyon', 440, 'truck', C2, { low: 140, rock: true }),
  ],
  [
    S('Up the pass', 360, 'car', ['road', 'wood', 'cable'], { towers: 120 }), S('Hanging road', 360, 'truck', M3, { towers: 140 }), S('Pass', 360, 'bus', M3, { towers: 120, low: 100 }),
    S('Freight line', 320, 'train', M3, { towers: 160, low: 120 }), S('Convoy', 400, 'convoy', M3, { towers: 140 }), S('Switchback', 400, 'bus', M3, { towers: 160, rock: true }),
    S('Summit rail', 400, 'train', M3, { towers: 160, low: 120 }), S('Avalanche gap', 440, 'truck', M3, { towers: 160, low: 140 }), S('Night convoy', 440, 'convoy', M3, { towers: 160, rock: true }),
    S('Mountain express', 480, 'train', M3, { towers: 180, low: 140, rock: true }),
  ],
];

function baseLevel(spec: Spec): BLevel {
  const L = spec.span;
  const anchors: [number, number][] = [[0, 0], [L, 0]];
  if (spec.low) anchors.push([0, spec.low], [L, spec.low]);
  if (spec.towers) anchors.push([0, -spec.towers], [L, -spec.towers]);
  const l: BLevel = { name: spec.name, gap: [0, L], water: 260, anchors, budget: 0, mats: spec.mats, vehicle: spec.vehicle, solution: { joints: [], beams: [] } };
  if (spec.rock) {
    const mx = Math.round(L / 2 / 20) * 20;
    l.rock = [mx, 140, 30];
    anchors.push([mx - 20, 140], [mx + 20, 140]);
  }
  if (spec.boat) l.boat = [L * 0.25, L * 0.75, 30];
  return l;
}

interface Params { kind: 'over' | 'under' | 'cable' | 'cableUnder' | 'pier' | 'deck'; depth: number; deck: Mat; truss: Mat; seg: number }

function design(l: BLevel, p: Params): Design | null {
  const b: Design = { joints: [], beams: [] };
  const L = l.gap[1];
  const seg = p.seg;
  const n = L / seg;
  if (!Number.isInteger(n)) return null;
  for (let k = 0; k < n; k++) addBeam(l, b, k * seg, 0, (k + 1) * seg, 0, p.deck);
  const m = p.truss;
  const truss = (from: number, to: number, dir: 1 | -1, depth: number) => {
    // Warren truss between deck x = from..to, nodes at the half-segment points.
    for (let x = from; x < to; x += seg) {
      const mx = x + seg / 2;
      addBeam(l, b, x, 0, mx, dir * depth, m);
      addBeam(l, b, mx, dir * depth, x + seg, 0, m);
      if (x + seg < to) addBeam(l, b, mx, dir * depth, mx + seg, dir * depth, m);
    }
  };
  if (p.kind === 'over') truss(0, L, -1, p.depth);
  else if (p.kind === 'under' || p.kind === 'cableUnder') {
    truss(0, L, 1, p.depth);
    // Tie the bottom chord ends to the low anchors when there are any.
    const low = l.anchors.filter(([x, y]) => y > 0 && (x === 0 || x === L));
    for (const [ax, ay] of low) addBeam(l, b, ax, ay, ax === 0 ? seg / 2 : L - seg / 2, p.depth, m);
    if (p.kind === 'cableUnder') {
      const towers = l.anchors.filter(([, y]) => y < 0);
      if (!towers.length) return null;
      for (let k = 1; k < n; k++) {
        const x = k * seg;
        const [tx, ty] = x <= L / 2 ? towers[0] : towers[towers.length - 1];
        addBeam(l, b, tx, ty, x, 0, 'cable');
      }
    }
  } else if (p.kind === 'cable') {
    const towers = l.anchors.filter(([, y]) => y < 0);
    if (!towers.length) return null;
    for (let k = 1; k < n; k++) {
      const x = k * seg;
      const [tx, ty] = x <= L / 2 ? towers[0] : towers[towers.length - 1];
      addBeam(l, b, tx, ty, x, 0, 'cable');
    }
    if (p.depth) truss(0, L, -1, Math.min(p.depth, 40));
  } else if (p.kind === 'pier') {
    if (!l.rock) return null;
    const [rx] = l.rock;
    addBeam(l, b, rx - 20, 140, rx - 20, 0, m);
    addBeam(l, b, rx + 20, 140, rx + 20, 0, m);
    addBeam(l, b, rx - 20, 140, rx + 20, 0, m);
    truss(0, rx - 20, -1, p.depth);
    truss(rx + 20, L, -1, p.depth);
  }
  const d = b;
  if (d.beams.some(([, , mm]) => !l.mats.includes(mm))) return null;
  if (boatClash(l, d)) return null;
  return d;
}

function generate(spec: Spec): BLevel {
  const l = baseLevel(spec);
  let best: { d: Design; cost: number } | null = null;
  const kinds: Params['kind'][] = ['deck', 'over', 'under', 'cable', 'cableUnder', 'pier'];
  const decks = spec.mats.filter((m) => MATS[m].road);
  const trusses = spec.mats.filter((m) => !MATS[m].road && m !== 'cable');
  for (const kind of kinds) for (const depth of [20, 40, 60, 80, 100, 120]) for (const deck of decks) for (const truss of trusses) for (const seg of [40, 80, 120]) {
    if (kind === 'deck' && (depth !== 20 || truss !== trusses[0])) continue;
    const d = design(l, { kind, depth, deck, truss, seg });
    if (!d) continue;
    const cost = beamCost(l, d);
    if (best && cost >= best.cost) continue;
    const sim = new Bridge(l, d).run();
    if (sim.outcome !== 'crossed') continue;
    // Robust: must also hold with the vehicle 10% heavier.
    if (new Bridge(l, d, 1.1).run().outcome !== 'crossed') continue;
    best = { d, cost };
  }
  if (!best) throw new Error(`no design holds for ${spec.name}`);
  l.solution = best.d;
  l.budget = Math.ceil(best.cost / 0.6 / 50) * 50;
  return l;
}

const TITLES = [['1-river', 'River'], ['2-canyon', 'Canyon'], ['3-mountain', 'Mountain pass']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 3; ch++) {
  if (chOnly && ch !== chOnly) continue;
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: BLevel[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: BLevel[] = [];
  SPECS[ch - 1].forEach((spec, i) => {
    const id = `${ch}-${i + 1}`;
    if (only && only !== id && existing[i]) { levels.push(existing[i]); return; }
    const t0 = Date.now();
    try {
      const l = generate(spec);
      levels.push(l);
      const kinds = [...new Set(l.solution.beams.map((b) => b[2]))].join('+');
      console.log(`${id.padEnd(5)} ${l.name.padEnd(18)} span ${spec.span} ${spec.vehicle.padEnd(6)} cost ${beamCost(l, l.solution)} budget ${l.budget} beams ${l.solution.beams.length} ${kinds} (${Date.now() - t0} ms)`);
    } catch (e) { console.log(`${id} FAILED ${(e as Error).message}`); }
  });
  if (levels.length === SPECS[ch - 1].length) writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
