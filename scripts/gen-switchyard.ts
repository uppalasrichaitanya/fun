// Generates Switchyard levels: lane layouts + train schedules, solved by the
// autopilot (with rollouts for loops and tight gaps). The autopilot's switch
// recording is stored and its flip count is par. Doing nothing must fail.
//   npx tsx scripts/gen-switchyard.ts [--ch N] [1-4]
import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng';
import { buildLayout, schedule, type LayoutSpec } from '../src/games/switchyard/build';
import { autopilot, Network, reachable, replay, type SYLevel } from '../src/games/switchyard/logic';

const DIR = 'src/games/switchyard/levels';

interface Spec extends LayoutSpec { name: string; trains: number; gap: number; express?: number; via?: number; needLoop?: boolean }
const S = (name: string, lanes: number, tunnels: number, connectors: number, trains: number, gap: number, o: Partial<Spec> = {}): Spec => ({ name, lanes, tunnels, connectors, trains, gap, ...o });

const SPECS: Spec[][] = [
  [
    S('First switch', 2, 1, 1, 1, 4), S('Two trains', 2, 1, 1, 2, 5), S('Fork in the road', 2, 1, 2, 2, 4.5), S('Three lines', 3, 1, 2, 3, 4.5),
    S('Two tunnels', 3, 2, 2, 3, 4), S('Crossing', 3, 1, 1, 3, 4, { crossings: 1 }), S('Busy morning', 3, 2, 3, 4, 3.6),
    S('Level crossing', 3, 2, 2, 4, 3.6, { crossings: 1 }), S('Buffers', 3, 2, 3, 4, 3.4, { deadEnds: 1 }),
    S('The loop', 3, 2, 2, 3, 1.6, { loop: true, needLoop: true }), S('Crossover', 4, 2, 3, 4, 3.4, { xovers: 1 }), S('Harvest run', 4, 2, 3, 5, 3.2, { crossings: 1, loop: true }),
  ],
  [
    S('City lines', 4, 2, 3, 4, 3.2), S('Clockwork', 4, 2, 3, 4, 3.2, { timed: 1 }), S('Rush hour', 4, 3, 3, 5, 3, { xovers: 1 }),
    S('Express', 4, 2, 3, 4, 3.2, { express: 0.4 }), S('Ticking points', 4, 2, 3, 5, 3, { timed: 2, crossings: 1 }), S('Overtake', 4, 2, 3, 5, 2.8, { loop: true, express: 0.3 }),
    S('Junction box', 4, 3, 4, 5, 2.8, { xovers: 1, crossings: 1 }), S('Pick-up', 4, 2, 3, 4, 3.4, { stops: 1, via: 0.5 }), S('Deliveries', 4, 2, 4, 5, 3, { stops: 2, via: 0.4, deadEnds: 1 }),
    S('Night shift', 4, 3, 4, 5, 2.8, { timed: 1, express: 0.3, xovers: 1 }), S('Grand central', 4, 3, 4, 6, 2.6, { crossings: 1, xovers: 1, stops: 1, via: 0.3 }),
    S('Downtown', 4, 3, 4, 6, 2.5, { loop: true, timed: 1, express: 0.3 }),
  ],
  [
    S('Foothills', 4, 2, 4, 5, 2.8), S('Switchbacks', 5, 2, 4, 5, 2.8, { crossings: 1 }), S('Avalanche', 5, 3, 4, 5, 2.6, { xovers: 1, timed: 1 }),
    S('Pass', 5, 2, 4, 5, 2.6, { loop: true, deadEnds: 1 }), S('Glacier', 5, 3, 4, 6, 2.5, { stops: 2, via: 0.4 }), S('Summit express', 5, 3, 4, 6, 2.5, { express: 0.5, crossings: 1 }),
    S('Viaduct', 5, 3, 5, 6, 2.4, { xovers: 2 }), S('Rockfall', 5, 3, 5, 6, 2.4, { timed: 2, deadEnds: 1 }), S('Ridge line', 5, 3, 5, 6, 2.3, { loop: true, crossings: 1, express: 0.3 }),
    S('Blizzard', 5, 3, 5, 6, 2.2, { timed: 2, xovers: 1, stops: 1, via: 0.3 }), S('Long haul', 5, 3, 5, 6, 2.2, { loop: true, stops: 2, via: 0.4, express: 0.3 }),
    S('Peak hour', 5, 3, 5, 6, 2, { loop: true, timed: 2, crossings: 1, xovers: 1, express: 0.4 }),
  ],
];

function canReachFn(level: SYLevel): (tunnel: number, color: number, via: number) => boolean {
  const net = new Network(level);
  const reach = reachable(net);
  return (tunnel, color, via) => reach(tunnel, net.outs[tunnel][0], color, via);
}

const why: Record<string, number> = {};
const no = (k: string) => { why[k] = (why[k] ?? 0) + 1; };

/** Hand-made: a red train from the lower tunnel must cross onto the top line just as
 *  the top line's own red train arrives. The only way: send the top train round the loop. */
function theLoop(): SYLevel {
  const nodes: SYLevel['nodes'] = [
    { k: 'tunnel', x: 0.8, y: 4 }, { k: 'tunnel', x: 0.8, y: 6.5 },
    { k: 'switch', x: 3.2, y: 4, key: 1 }, { k: 'merge', x: 4.4, y: 2.8 }, { k: 'switch', x: 6.4, y: 2.8, key: 2 }, { k: 'merge', x: 7.6, y: 4 },
    { k: 'switch', x: 9, y: 6.5, key: 3 }, { k: 'merge', x: 11, y: 4 },
    { k: 'station', x: 19.2, y: 4, c: 0 }, { k: 'station', x: 19.2, y: 6.5, c: 1 },
  ];
  const edges: SYLevel['edges'] = [
    [0, 2], [2, 5], [5, 7], [7, 8], [1, 6], [6, 9],
    [2, 3], [3, 4], [4, 5], [4, 3, [[7, 2.2], [6.4, 1.4], [4.4, 1.4], [3.8, 2.2]]],
    [6, 7],
  ];
  return { name: 'The loop', w: 20, h: 12, nodes, edges, trains: [[2, 1, 0, 0, -1], [2.6, 0, 0, 0, -1], [5.5, 1, 1, 0, -1]], par: 0, solution: [] };
}

function generate(spec: Spec, seed: number): SYLevel {
  if (spec.name === 'The loop') {
    const level = theLoop();
    // Find the top train's start time that crashes without the loop.
    for (let t = 1.6; t < 4; t += 0.1) {
      level.trains[1][0] = Math.round(t * 10) / 10;
      const g0 = autopilot(level, { rollout: false }).sim;
      const r = autopilot(level, { rollout: true });
      if (process.env.SY_DEBUG) console.log(t.toFixed(1), 'greedy', g0.fail?.kind ?? 'ok', g0.delivered, 'rollout', r.sim.fail?.kind ?? 'ok', r.sim.delivered, r.events.length);
      if (!g0.fail) continue;
      if (r.sim.fail) continue;
      level.solution = r.events;
      level.par = r.events.filter((e) => e[2] === 'f').length;
      return level;
    }
    throw new Error('the loop: no timing found');
  }
  const rng = new Rng(seed);
  for (const k of Object.keys(why)) delete why[k];
  for (let attempt = 0; attempt < 600; attempt++) {
    const lay = buildLayout(spec, rng, spec.name);
    if (!lay || !lay.tunnels.length) { no('layout'); continue; }
    const level = lay.level;
    level.trains = schedule(lay, rng, spec.trains, spec.gap, { express: spec.express, via: spec.via }, canReachFn(level));
    if (level.trains.length < spec.trains) { no('schedule'); continue; }
    // Doing nothing must fail.
    if (!replay(level, []).fail) { no('trivial'); continue; }
    let ok = false;
    for (let fix = 0; fix < 6 && !ok; fix++) {
      const r = autopilot(level, { rollout: true });
      if (!r.sim.fail && r.sim.delivered === level.trains.length) {
        const check = replay(level, r.events);
        if (!check.fail && check.delivered === level.trains.length) {
          level.solution = r.events.map(([t, n, a]) => [Math.round(t * 1e6) / 1e6, n, a]);
          level.par = r.events.filter((e) => e[2] === 'f').length;
          ok = true;
        }
      } else {
        // Nudge the train after the failure later and try again.
        const late = level.trains.find((t) => t[0] > r.sim.t - 6);
        if (!late) break;
        late[0] = Math.round((late[0] + 1.2) * 10) / 10;
      }
    }
    if (!ok) { no('unsolved'); continue; }
    if (spec.needLoop && !autopilot(level, { rollout: false }).sim.fail) { no('loop-unneeded'); continue; }
    return level;
  }
  throw new Error(`could not generate ${spec.name} ${JSON.stringify(why)}`);
}

const TITLES = [['1-countryside', 'Countryside'], ['2-city', 'City'], ['3-mountains', 'Mountains']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
for (let ch = 1; ch <= 3; ch++) {
  if (chOnly && ch !== chOnly) continue;
  const file = `${DIR}/${TITLES[ch - 1][0]}.json`;
  let existing: SYLevel[] = [];
  try { existing = JSON.parse(readFileSync(file, 'utf8')).levels; } catch { /* first run */ }
  const levels: SYLevel[] = [];
  SPECS[ch - 1].forEach((spec, i) => {
    const id = `${ch}-${i + 1}`;
    if (only && only !== id && existing[i]) { levels.push(existing[i]); return; }
    const t0 = Date.now();
    const l = generate(spec, 71000 + ch * 100 + i);
    levels.push(l);
    console.log(`${id.padEnd(5)} ${l.name.padEnd(16)} nodes ${l.nodes.length} trains ${l.trains.length} par ${l.par} last ${l.trains[l.trains.length - 1][0]}s (${Date.now() - t0} ms)`);
  });
  writeFileSync(file, JSON.stringify({ title: TITLES[ch - 1][1], levels }).replace(/\{"name"/g, '\n{"name"') + '\n');
}
