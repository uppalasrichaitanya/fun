// Generates Light Bender levels 1-4 .. 4-10 (1-1 .. 1-3 are hand-made).
// Each candidate room is built by walking a beam and dropping pieces, then the
// exhaustive solver finds every minimal solution: par = the true minimum, the
// stored solution is a verified one, and the prism gem goes on a cell that only
// some par solutions light ("off the main path").
//   npx tsx scripts/gen-light-bender.ts            write src/games/light-bender/levels/*.json
//   npx tsx scripts/gen-light-bender.ts --dry      print stats only
import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng';
import { Board, DX, DY, opp, trace, piecesFrom, type Kind, type LBLevel, type Placed, type Thing } from '../src/games/light-bender/logic';
import { solve } from '../src/games/light-bender/solver';

const DIR = 'src/games/light-bender/levels';
const MIRROR_MAP = [[3, 2, 1, 0], [1, 0, 3, 2]];
const ONEWAY_N = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

interface Spec {
  name: string;
  size: [number, number];
  turns: number;
  oneway?: number;      // chance a turn uses a one-way mirror
  splits?: number;
  filters?: number;
  portals?: number;
  emitColor?: number;
  combiner?: 'fixed' | 'inv';
  crystals?: number;    // extra mid-path crystals
  walls: number;        // wall density off the solution path
  glass?: number;       // glass density on the solution path
  decoy?: Kind[];       // extra inventory pieces
  maxSols?: number;     // most par solutions allowed
  minPar?: number;
}

const S = (name: string, size: [number, number], turns: number, walls: number, o: Partial<Spec> = {}): Spec => ({ name, size, turns, walls, ...o });

const SPECS: Record<string, Spec> = {
  '1-4': S('Corner pocket', [6, 6], 2, 0.12, { maxSols: 4 }),
  '1-5': S('Zigzag', [7, 7], 3, 0.14, { maxSols: 4, minPar: 3 }),
  '1-6': S('Glasshouse', [7, 7], 3, 0.12, { glass: 0.35, maxSols: 4, minPar: 3 }),
  '1-7': S('One way only', [7, 7], 2, 0.14, { oneway: 1, maxSols: 4 }),
  '1-8': S('Back door', [8, 8], 3, 0.16, { oneway: 0.5, crystals: 1, maxSols: 4, minPar: 3 }),
  '1-9': S('Spare parts', [8, 8], 4, 0.16, { oneway: 0.4, decoy: ['mirror'], maxSols: 4, minPar: 4 }),
  '1-10': S('Hall of mirrors', [9, 9], 5, 0.18, { oneway: 0.4, crystals: 1, maxSols: 4, minPar: 5 }),
  '2-1': S('Fork', [7, 7], 1, 0.12, { splits: 1, maxSols: 4, minPar: 2 }),
  '2-2': S('Both ways', [7, 7], 2, 0.14, { splits: 1, maxSols: 4, minPar: 3 }),
  '2-3': S('Trident', [8, 8], 2, 0.14, { splits: 1, crystals: 1, maxSols: 4, minPar: 3 }),
  '2-4': S('Double split', [8, 8], 1, 0.16, { splits: 2, maxSols: 4, minPar: 3 }),
  '2-5': S('Crossfire', [8, 8], 3, 0.16, { splits: 1, oneway: 0.4, maxSols: 4, minPar: 4 }),
  '2-6': S('Branches', [9, 9], 2, 0.16, { splits: 2, crystals: 1, maxSols: 4, minPar: 4 }),
  '2-7': S('Chandelier', [9, 9], 3, 0.18, { splits: 2, maxSols: 4, minPar: 4 }),
  '2-8': S('Spare split', [9, 9], 3, 0.18, { splits: 1, decoy: ['splitter'], oneway: 0.3, maxSols: 4, minPar: 4 }),
  '2-9': S('Delta', [10, 10], 4, 0.18, { splits: 2, maxSols: 4, minPar: 5 }),
  '2-10': S('Lightning tree', [10, 10], 4, 0.2, { splits: 2, oneway: 0.3, crystals: 1, maxSols: 4, minPar: 5 }),
  '3-1': S('Red light', [8, 8], 2, 0.14, { emitColor: 1, maxSols: 4, minPar: 2 }),
  '3-2': S('Tint', [8, 8], 1, 0.14, { filters: 1, maxSols: 4, minPar: 2 }),
  '3-3': S('Traffic lights', [8, 8], 1, 0.16, { splits: 1, filters: 2, maxSols: 4, minPar: 3 }),
  '3-4': S('Magenta', [8, 8], 1, 0.12, { combiner: 'fixed', maxSols: 4 }),
  '3-5': S('Blue hour', [9, 9], 2, 0.16, { filters: 1, oneway: 0.3, crystals: 1, maxSols: 4, minPar: 3 }),
  '3-6': S('Mixing desk', [9, 9], 2, 0.14, { combiner: 'inv', maxSols: 4 }),
  '3-7': S('Prism', [9, 9], 2, 0.16, { splits: 1, filters: 2, maxSols: 4, minPar: 4 }),
  '3-8': S('Paint by light', [10, 10], 3, 0.16, { combiner: 'inv', maxSols: 4 }),
  '3-9': S('Spectrum', [10, 10], 3, 0.18, { splits: 2, filters: 2, maxSols: 4, minPar: 5 }),
  '3-10': S('White room', [11, 11], 4, 0.18, { combiner: 'inv', maxSols: 4 }),
  '4-1': S('Wormhole', [9, 9], 1, 0.12, { portals: 1, maxSols: 4, minPar: 1 }),
  '4-2': S('Elsewhere', [9, 9], 2, 0.14, { portals: 1, maxSols: 4, minPar: 2 }),
  '4-3': S('Round trip', [10, 10], 3, 0.16, { portals: 1, oneway: 0.3, maxSols: 4, minPar: 3 }),
  '4-4': S('Two doors', [10, 10], 2, 0.16, { portals: 2, maxSols: 4, minPar: 2 }),
  '4-5': S('Split second', [10, 10], 2, 0.16, { portals: 1, splits: 1, maxSols: 4, minPar: 3 }),
  '4-6': S('Coloured gates', [11, 11], 2, 0.16, { portals: 1, filters: 1, maxSols: 4, minPar: 3 }),
  '4-7': S('Relay', [11, 11], 3, 0.18, { portals: 2, splits: 1, maxSols: 4, minPar: 4 }),
  '4-8': S('Far mix', [11, 11], 2, 0.16, { portals: 1, combiner: 'inv', maxSols: 4 }),
  '4-9': S('Event horizon', [12, 12], 4, 0.18, { portals: 2, splits: 1, oneway: 0.3, maxSols: 4, minPar: 5 }),
  '4-10': S('Supernova', [12, 12], 4, 0.2, { portals: 2, splits: 2, filters: 1, crystals: 1, maxSols: 4, minPar: 6 }),
};

// ---- construction -----------------------------------------------------------

interface Draft {
  w: number; h: number;
  occ: Map<number, string>;      // emitter / piece / crystal / portal / combiner
  path: Map<number, number>;     // cell -> times crossed by the solution beam
  things: Thing[];
  pieces: Placed[];
}

function draft(w: number, h: number): Draft { return { w, h, occ: new Map(), path: new Map(), things: [], pieces: [] }; }
const inside = (d: Draft, c: number, r: number) => c >= 0 && r >= 0 && c < d.w && r < d.h;
const free = (d: Draft, c: number, r: number) => inside(d, c, r) && !d.occ.has(r * d.w + c);
const rot = (dir: number, k: number) => ((dir + k + 4) % 4);

function mirrorFor(din: number, dout: number): number { return MIRROR_MAP[0][din] === dout ? 0 : 1; }
function onewayFor(din: number, dout: number): number {
  const diag = mirrorFor(din, dout);
  for (const o of [diag, diag + 2]) { const n = ONEWAY_N[o]; if (DX[din] * n[0] + DY[din] * n[1] < 0) return o; }
  return diag;
}

function edgeStart(d: Draft, rng: Rng): { c: number; r: number; dir: number } {
  const side = rng.int(0, 3);
  const { w, h } = d;
  if (side === 0) return { c: 0, r: rng.int(1, h - 2), dir: 0 };
  if (side === 1) return { c: rng.int(1, w - 2), r: 0, dir: 1 };
  if (side === 2) return { c: w - 1, r: rng.int(1, h - 2), dir: 2 };
  return { c: rng.int(1, w - 2), r: h - 1, dir: 3 };
}

function forward(spec: Spec, rng: Rng): Draft | null {
  const [w, h] = spec.size;
  const d = draft(w, h);
  const e = edgeStart(d, rng);
  const color0 = spec.emitColor ?? 7;
  d.occ.set(e.r * w + e.c, 'emit');
  d.things.push(['emit', e.c, e.r, e.dir, color0]);
  const left = { turn: spec.turns, split: spec.splits ?? 0, filter: spec.filters ?? 0, portal: spec.portals ?? 0, crystal: spec.crystals ?? 0 };
  const stack = [{ c: e.c, r: e.r, dir: e.dir, color: color0, bent: false }];
  let ends = 0;
  while (stack.length) {
    let { c, r, dir, color, bent } = stack.pop()!;
    for (let guard = 0; guard < 20; guard++) {
      const L = rng.int(2, 4);
      let moved = 0;
      const seg: number[] = [];
      for (let k = 0; k < L; k++) {
        const nc = c + DX[dir], nr = r + DY[dir];
        if (!free(d, nc, nr)) break;
        c = nc; r = nr; moved++;
        const i = r * w + c;
        d.path.set(i, (d.path.get(i) ?? 0) + 1);
        seg.push(i);
      }
      if (moved === 0) return null;
      const i = r * w + c;
      const total = left.turn + left.split + left.filter + left.portal;
      // Mid-path crystal on this segment (only after the beam has been bent).
      if (bent && left.crystal > 0 && seg.length > 1 && rng.chance(0.5)) {
        const j = seg[rng.int(0, seg.length - 2)];
        if (!d.occ.has(j)) { d.occ.set(j, 'crystal'); d.things.push(['crystal', j % w, Math.floor(j / w), color === 7 ? 7 : color]); left.crystal--; }
      }
      if (total === 0 || (d.path.get(i) ?? 0) > 1) {
        if (!bent && color === color0) return null;
        if (d.occ.has(i)) return null;
        d.occ.set(i, 'crystal');
        d.things.push(['crystal', c, r, color === 7 && rng.chance(0.5) ? 7 : color]);
        ends++;
        break;
      }
      const act = rng.weighted([left.turn, left.split * 1.5, left.filter * 1.2, left.portal * 1.2]);
      if (act === 0) {
        const nd = rot(dir, rng.sign());
        const one = rng.chance(spec.oneway ?? 0);
        d.occ.set(i, 'piece');
        d.pieces.push(one ? ['oneway', c, r, onewayFor(dir, nd)] : ['mirror', c, r, mirrorFor(dir, nd)]);
        dir = nd; left.turn--; bent = true;
      } else if (act === 1) {
        const nd = rot(dir, rng.sign());
        d.occ.set(i, 'piece');
        d.pieces.push(['splitter', c, r, mirrorFor(dir, nd)]);
        stack.push({ c, r, dir: nd, color, bent: true });
        left.split--; bent = true;
      } else if (act === 2) {
        const choices = ([['filter-r', 1], ['filter-g', 2], ['filter-b', 4]] as const).filter(([, col]) => col !== color);
        const [k, col] = rng.pick(choices);
        d.occ.set(i, 'piece');
        d.pieces.push([k, c, r, 0]);
        color = col; left.filter--; bent = true;
      } else {
        // Portal on the next cell, partner somewhere free with room ahead.
        const pc = c + DX[dir], pr = r + DY[dir];
        if (!free(d, pc, pr)) return null;
        let placed = false;
        for (let t = 0; t < 40 && !placed; t++) {
          const qc = rng.int(1, w - 2), qr = rng.int(1, h - 2);
          if (!free(d, qc, qr) || d.path.has(qr * w + qc) || Math.abs(qc - pc) + Math.abs(qr - pr) < 4) continue;
          if (!free(d, qc + DX[dir], qr + DY[dir]) || !free(d, qc + 2 * DX[dir], qr + 2 * DY[dir])) continue;
          const id = left.portal;
          d.occ.set(pr * w + pc, 'portal'); d.occ.set(qr * w + qc, 'portal');
          d.things.push(['portal', pc, pr, id], ['portal', qc, qr, id]);
          c = qc; r = qr; placed = true;
        }
        if (!placed) return null;
        left.portal--;
      }
    }
  }
  if (left.turn + left.split + left.filter + left.portal > 0) return null;
  return ends ? d : null;
}

/** Two coloured emitters feeding a combiner whose output must reach a mixed crystal. Built backwards from the combiner. */
function combinerDraft(spec: Spec, rng: Rng): Draft | null {
  const [w, h] = spec.size;
  const d = draft(w, h);
  const xc = rng.int(2, w - 3), xr = rng.int(2, h - 3);
  const out = rng.int(0, 3);
  d.occ.set(xr * w + xc, 'combiner');
  if (spec.combiner === 'fixed') d.things.push(['fixed', xc, xr, 'combiner', out]);
  else d.pieces.push(['combiner', xc, xr, out]);
  const sides = [0, 1, 2, 3].filter((s) => opp(s) !== out); // travel directions into the combiner
  rng.shuffle(sides);
  const cols = rng.pick([[1, 4], [1, 2], [2, 4]]);
  let turns = spec.turns;
  // Output: forward from the combiner.
  let c = xc, r = xr, dir = out;
  const outTurns = turns > 2 && rng.chance(0.5) ? 1 : 0;
  for (let seg = 0; seg <= outTurns; seg++) {
    const L = rng.int(2, 4);
    let moved = 0;
    for (let k = 0; k < L; k++) {
      const nc = c + DX[dir], nr = r + DY[dir];
      if (!free(d, nc, nr)) break;
      c = nc; r = nr; moved++; d.path.set(r * w + c, 1);
    }
    if (!moved) return null;
    if (seg < outTurns) {
      const nd = rot(dir, rng.sign());
      d.occ.set(r * w + c, 'piece'); d.pieces.push(['mirror', c, r, mirrorFor(dir, nd)]); dir = nd; turns--;
    }
  }
  if (d.occ.has(r * w + c)) return null;
  d.occ.set(r * w + c, 'crystal');
  d.things.push(['crystal', c, r, cols[0] | cols[1]]);
  // Inputs: walk backwards from the combiner, turning with mirrors, and put an emitter at the far end.
  for (let k = 0; k < 2; k++) {
    let fd = sides[k];
    let pc = xc, pr = xr;
    const myTurns = k === 0 ? Math.ceil(turns / 2) : Math.floor(turns / 2);
    for (let t = 0; t <= myTurns; t++) {
      const L = rng.int(2, 3);
      let moved = 0;
      for (let s = 0; s < L; s++) {
        const nc = pc - DX[fd], nr = pr - DY[fd];
        if (!free(d, nc, nr) || d.path.has(nr * w + nc)) break;
        pc = nc; pr = nr; moved++; d.path.set(pr * w + pc, 1);
      }
      if (moved < 1) return null;
      if (t < myTurns) {
        const din = rot(fd, rng.sign());
        d.occ.set(pr * w + pc, 'piece');
        d.pieces.push(['mirror', pc, pr, mirrorFor(din, fd)]);
        fd = din;
      }
    }
    // Emitter one cell further back.
    const ec = pc - DX[fd], er = pr - DY[fd];
    if (!free(d, ec, er) || d.path.has(er * w + ec)) return null;
    d.occ.set(er * w + ec, 'emit');
    d.things.push(['emit', ec, er, fd, cols[k]]);
  }
  return d;
}

// ---- finishing: walls, glass, solve, gem ------------------------------------

const CAP_CHEAP = 150_000;
const CAP_ALL = 250_000;
const why: Record<string, number> = {};
const reject = (k: string): null => { why[k] = (why[k] ?? 0) + 1; return null; };

function finish(spec: Spec, d: Draft, rng: Rng): { level: LBLevel; sols: number; hidden: boolean } | null {
  const { w, h } = d;
  const rows: string[][] = Array.from({ length: h }, () => Array(w).fill('.'));
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (d.occ.has(i)) continue;
    if (d.path.has(i)) { if (spec.glass && rng.chance(spec.glass)) rows[r][c] = 'o'; continue; }
    if (rng.chance(spec.walls)) rows[r][c] = '#';
  }
  const inv: Partial<Record<Kind, number>> = {};
  for (const [k] of d.pieces) inv[k] = (inv[k] ?? 0) + 1;
  for (const k of spec.decoy ?? []) inv[k] = (inv[k] ?? 0) + 1;
  const level: LBLevel = { name: spec.name, w, h, rows: rows.map((r) => r.join('')), things: d.things, inv, par: d.pieces.length, solution: d.pieces };
  if (!trace(new Board(level), piecesFrom(level.solution)).solved) return reject('construction');
  if (trace(new Board(level), []).solved) return reject('free');
  const target = Math.max(spec.minPar ?? d.pieces.length, 1);
  // Block shortcuts: while a cheaper solution exists, wall a cell only it uses.
  for (let round = 0; ; round++) {
    const cheap = solve(level, target - 1, inv, CAP_CHEAP);
    if (!cheap.solutions.length) break; // none found (if capped: none within the search budget)
    if (round > 10) return reject('par');
    const s0 = rng.pick(cheap.solutions);
    const t = trace(new Board(level), s0.pieces);
    const cand: number[] = [];
    for (let i = 0; i < t.visit.length; i++) if (t.visit[i] >= 0 && !d.occ.has(i) && !d.path.has(i) && level.rows[Math.floor(i / w)][i % w] === '.') cand.push(i);
    if (!cand.length) return reject('par');
    const i = rng.pick(cand);
    const row = level.rows[Math.floor(i / w)];
    level.rows[Math.floor(i / w)] = row.slice(0, i % w) + '#' + row.slice(i % w + 1);
  }
  const b = new Board(level);
  if (!trace(b, piecesFrom(level.solution)).solved) return reject('construction');
  const res = solve(level, target, inv, CAP_ALL);
  const construction = { pieces: piecesFrom(level.solution), gem: false };
  const found = res.solutions.length ? res.solutions : [construction];
  const par = Math.min(...found.map((s) => s.pieces.length));
  if (par < target) return reject('par');
  const atPar = found.filter((s) => s.pieces.length === par);
  // Filters can sit anywhere along a segment, which multiplies solutions without making the puzzle easier.
  const maxSols = (spec.maxSols ?? 4) * (spec.filters ? 15 : 1);
  if (!res.capped && atPar.length > maxSols) return reject('sols');
  // Gem: a cell lit by as few par solutions as possible (ideally not all of them).
  const counts = new Map<number, number>();
  const visits = atPar.map((s) => {
    const t = trace(b, s.pieces);
    const own = new Set(s.pieces.map((p) => p.r * w + p.c));
    const cells: number[] = [];
    for (let i = 0; i < t.visit.length; i++) if (t.visit[i] >= 0 && !b.blocked[i] && !own.has(i)) cells.push(i);
    for (const i of cells) counts.set(i, (counts.get(i) ?? 0) + 1);
    return new Set(cells);
  });
  // Also consider cells off every par path that an alternative piece arrangement could reach: none, keep to lit cells.
  // Never on a cell some par solution puts a piece on (that would delete the solution).
  for (const sol of atPar) for (const p of sol.pieces) counts.delete(p.r * w + p.c);
  let best = -1, bestScore = Infinity;
  for (const [i, n] of counts) {
    // Fewer solutions lighting it = more hidden; prefer cells far from crystals.
    const score = n * 10 + rng.next();
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return null;
  const si = visits.findIndex((v) => v.has(best));
  level.things = [...level.things, ['gem', best % w, Math.floor(best / w)]];
  level.par = par;
  level.solution = atPar[si].pieces.map((p) => [p.kind, p.c, p.r, p.o] as Placed);
  // Re-check with the gem in place.
  const t = trace(new Board(level), piecesFrom(level.solution));
  if (!t.solved || !t.gemLit) return null;
  return { level, sols: atPar.length, hidden: counts.get(best)! < atPar.length };
}

function generate(id: string, spec: Spec, seed: number): LBLevel {
  const rng = new Rng(seed);
  let best: { level: LBLevel; score: number } | null = null;
  let tries = 0;
  for (const k of Object.keys(why)) delete why[k];
  let hidden = 0;
  const t0 = Date.now();
  for (let found = 0; tries < 3000 && found < 30 && hidden < 6 && (Date.now() - t0 < 45_000 || !best); tries++) {
    const d = spec.combiner ? combinerDraft(spec, rng) : forward(spec, rng);
    if (!d) { reject('draft'); continue; }
    const f = finish(spec, d, rng);
    if (!f) continue;
    found++;
    if (f.hidden) hidden++;
    // Prefer a gem only some par solutions reach, then few solutions, then long beams.
    const score = (f.hidden ? 0 : 50) + f.sols * 3 - countCells(f.level) / 30 + rng.next();
    if (!best || score < best.score) best = { level: f.level, score };
  }
  if (!best) throw new Error(`could not generate ${id} after ${tries} tries ${JSON.stringify(why)}`);
  console.log(`   ${tries} tries, hidden gems ${hidden}`, JSON.stringify(why));
  return best.level;
}

function countCells(l: LBLevel): number {
  const t = trace(new Board(l), piecesFrom(l.solution));
  return t.steps;
}

// ---- main ------------------------------------------------------------------

const dry = process.argv.includes('--dry');
const only = process.argv.find((a) => /^\d-\d+$/.test(a));
const CHAPTERS = [['1-mirrors', 'Mirrors'], ['2-splitters', 'Splitters'], ['3-colour', 'Colour'], ['4-portals', 'Portals']];
const chArg = process.argv.indexOf('--ch');
const chOnly = chArg > 0 ? Number(process.argv[chArg + 1]) : 0;
for (let ch = 1; ch <= 4; ch++) {
  if (chOnly && ch !== chOnly) continue;
  const file = `${DIR}/${CHAPTERS[ch - 1][0]}.json`;
  let existing: { title: string; levels: LBLevel[] } = { title: CHAPTERS[ch - 1][1], levels: [] };
  try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new file */ }
  const levels: LBLevel[] = [];
  for (let n = 1; n <= 10; n++) {
    const id = `${ch}-${n}`;
    const spec = SPECS[id];
    if (!spec || (only && only !== id)) { if (existing.levels[n - 1]) levels.push(existing.levels[n - 1]); continue; }
    const t0 = Date.now();
    const lv = generate(id, spec, 1000 * ch + n);
    levels.push(lv);
    const sol = solve(lv, lv.par, lv.inv, CAP_ALL);
    console.log(`${id.padEnd(5)} ${lv.name.padEnd(16)} ${lv.w}x${lv.h} par ${lv.par} inv ${JSON.stringify(lv.inv)} par-solutions ${sol.solutions.filter((s) => s.pieces.length === lv.par).length}${sol.capped ? '+' : ''} gem-solutions ${sol.solutions.filter((s) => s.gem && s.pieces.length <= lv.par).length} (${Date.now() - t0} ms)`);
  }
  if (!dry) writeFileSync(file, JSON.stringify({ title: CHAPTERS[ch - 1][1], levels }, null, 0).replace(/\{"name"/g, '\n{"name"') + '\n');
}
