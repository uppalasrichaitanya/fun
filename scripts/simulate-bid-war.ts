/**
 * Bid War bot simulator. Two bots ("stars and scrubs" vs "balanced") play
 * headless auctions through the real rules engine and the real pool builder.
 *
 *   npm run sim                    1,000 auctions per configuration
 *   npm run sim -- --n 200         fewer
 *   npm run sim -- --write         also record the table at the top of config.ts
 *
 * Exits non-zero if any target is missed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Rng } from '../src/engine/rng';
import { allInMinSlots, BASE_PRICE, pursesFor } from '../src/games/bid-war/config';
import { applyOverrides, type Overrides } from '../src/games/bid-war/packs';
import { BAT_ROLES, BOWL_ROLES, buildPool } from '../src/games/bid-war/pool';
import { Auction } from '../src/games/bid-war/rules';
import { autoScore, civilWar, cricketRoles } from '../src/games/bid-war/scoring';
import type { Card, MatchSettings, Pack, PackId, PlayerIdx, SquadSize, Tier } from '../src/games/bid-war/types';

const root = resolve(import.meta.dirname, '..');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(resolve(root, p), 'utf8')) as T;
const PACKS: Record<PackId, Pack> = {
  cricket: applyOverrides(readJson('src/games/bid-war/packs/cricket.json'), readJson<Overrides>('src/games/bid-war/packs/cricket.overrides.json')),
  pokemon: applyOverrides(readJson('src/games/bid-war/packs/pokemon.json'), readJson<Overrides>('src/games/bid-war/packs/pokemon.overrides.json')),
  heroes: applyOverrides(readJson('src/games/bid-war/packs/heroes.json'), readJson<Overrides>('src/games/bid-war/packs/heroes.overrides.json')),
};

type Style = 'stars' | 'balanced';
/**
 * Willingness to pay, as a multiple of base price, before budget pressure.
 * Stars at 1.8x = about $14 for an S-tier, the war price the spec's worked example assumes.
 */
const STYLE_MULT: Record<Style, Record<Tier, number>> = {
  stars: { S: 1.8, A: 1.15, B: 0.95, C: 1.0 },
  balanced: { S: 1.35, A: 1.45, B: 1.4, C: 1.0 },
};
const TICK = 250;

/** Does this card fill something the squad is missing? (balanced bots care, star hunters barely do) */
function fillsNeed(squad: Card[], card: Card, s: MatchSettings): boolean {
  if (s.pack === 'cricket') {
    const r = cricketRoles(squad);
    if (card.role === 'Wicketkeeper' && r.wk < 1) return true;
    if (BOWL_ROLES.includes(card.role) && r.bowl < (s.squadSize === 12 ? 5 : 2)) return true;
    if (BAT_ROLES.includes(card.role) && r.bat < (s.squadSize === 12 ? 5 : 3)) return true;
    return false;
  }
  if (s.pack === 'pokemon') {
    const have = new Set(squad.flatMap((c) => c.tags.types ?? []));
    return (card.tags.types ?? []).some((t) => !have.has(t));
  }
  return !squad.some((c) => c.role === card.role);
}

class Bot {
  /** Per-lot valuation, fixed when the lot opens (seeded noise = human variance). */
  private value = 0;
  private lotN = -1;
  constructor(readonly p: PlayerIdx, readonly style: Style, private rng: Rng) {}

  private valuation(a: Auction): number {
    const st = a.state, lot = st.lot!, me = st.players[this.p];
    if (lot.n === this.lotN) return this.value;
    this.lotN = lot.n;
    const card = lot.card, s = st.settings;
    const base = BASE_PRICE[card.tier];
    let v = base * STYLE_MULT[this.style][card.tier];
    // Rating within the tier matters a little.
    v *= 0.85 + (card.rating / 100) * 0.3;
    const squad = me.squad.map((b) => b.card);
    // Star hunters chase stars and fill roles with cheap scrubs; balanced bots pay up for roles at every tier.
    if (fillsNeed(squad, card, s)) v *= this.style === 'balanced' ? 1.25 : card.tier === 'S' ? 1 : 1.2;
    // Budget pressure: rich bots bid more, broke bots less.
    const share = me.purse / Math.max(1, a.empty(this.p));
    const startShare = st.purseStart / s.squadSize;
    v *= Math.max(0.55, Math.min(1.6, share / startShare));
    // Late in the auction, empty slots make every lot more urgent.
    const left = st.queue.length + 1;
    if (a.empty(this.p) >= left) v *= 1.3;
    this.value = Math.max(base, Math.round(v * this.rng.range(0.85, 1.15)));
    return this.value;
  }

  act(a: Auction): void {
    const st = a.state, lot = st.lot;
    if (st.phase !== 'lot' || !lot) return;
    const p = this.p;
    if (st.players[p].locked || lot.out[p]) return;
    if (lot.solo !== null && lot.solo !== p) return;
    // Humans are not instant: roughly one decision every ~0.6 s.
    if (!this.rng.chance(0.4)) return;
    const v = this.valuation(a);
    if (lot.solo === p) {
      a.dispatch({ type: BASE_PRICE[lot.card.tier] <= Math.min(v, a.maxBid(p)) ? 'take' : 'leave', p });
      return;
    }
    if (lot.leader === p) return;
    const price1 = a.nextPrice('bid1', p);
    const cap = Math.min(v, a.maxBid(p));
    if (price1 <= cap) {
      const price5 = a.nextPrice('bid5', p);
      const jump = price5 <= cap && cap - lot.price >= 8 && this.rng.chance(0.3);
      a.dispatch({ type: jump ? 'bid5' : 'bid1', p });
      return;
    }
    // Star hunters gamble on S-tier lots they cannot otherwise win.
    if (this.style === 'stars' && lot.card.tier === 'S' && a.allInBlock(p) === null && a.empty(p) >= allInMinSlots(st.settings.squadSize)
      && st.players[p].purse <= v * 1.6 && this.rng.chance(0.25)) {
      a.dispatch({ type: 'allIn', p });
      return;
    }
    if (lot.leader !== null || this.rng.chance(0.5)) a.dispatch({ type: 'pass', p });
  }
}

interface Config { label: string; s: MatchSettings }
interface Result {
  label: string; n: number; priceRatio: number; unsoldPct: number; starsWin: number; balancedWin: number;
  broken: number; allIns: number; allInWorked: number; lots: number;
}

function runOne(cfg: Config, seed: number, starsSeat: PlayerIdx) {
  const pack = PACKS[cfg.s.pack];
  const purse = pursesFor(cfg.s.squadSize, cfg.s.purseFeel);
  const pool = buildPool(pack, cfg.s, seed);
  const a = new Auction(cfg.s, pool.cards, purse, seed);
  const rng = new Rng(seed ^ 0x9e3779b9);
  const bots = [0, 1].map((p) => new Bot(p as PlayerIdx, p === starsSeat ? 'stars' : 'balanced', rng));
  a.begin();
  let guard = 0;
  while (a.state.phase !== 'done' && guard++ < 50_000) {
    // Alternate who reacts first so neither seat has an edge.
    const order = guard % 2 ? [bots[0], bots[1]] : [bots[1], bots[0]];
    for (const b of order) b.act(a);
    a.dispatch({ type: 'tick', ms: TICK });
  }
  return a;
}

function simulate(cfg: Config, n: number): Result {
  let ratioSum = 0, sold = 0, unsold = 0, lots = 0, starsW = 0, balW = 0, broken = 0, allIns = 0, worked = 0;
  for (let i = 0; i < n; i++) {
    const seed = (i * 2654435761 + 12345) >>> 0;
    const starsSeat = (i % 2) as PlayerIdx;
    const a = runOne(cfg, seed, starsSeat);
    const st = a.state;
    const ok = st.phase === 'done' && st.players.every((p) => p.squad.length === cfg.s.squadSize);
    if (!ok) { broken++; continue; }
    // Unsold % counts first offers only: unsold-round re-offers to a broke player are skipped instantly by the engine.
    for (const h of st.history) {
      if (h.round !== 'main') continue;
      lots++;
      if (h.how === 'bid' || h.how === 'allIn') { ratioSum += h.price / BASE_PRICE[h.card.tier]; sold++; }
      if (h.how === 'unsold') unsold++;
    }
    allIns += st.allIns.length;
    worked += st.allIns.filter((x) => x.worked).length;
    const battle = cfg.s.pack === 'heroes' ? civilWar(st).winner : null;
    const sc = autoScore(st, battle);
    if (sc.winner === null) { starsW += 0.5; balW += 0.5; } else if (sc.winner === starsSeat) starsW++; else balW++;
  }
  const done = n - broken;
  return {
    label: cfg.label, n, priceRatio: ratioSum / Math.max(1, sold), unsoldPct: (100 * unsold) / Math.max(1, lots),
    starsWin: (100 * starsW) / Math.max(1, done), balancedWin: (100 * balW) / Math.max(1, done), broken, allIns, allInWorked: worked, lots,
  };
}

function configs(): Config[] {
  const base: Omit<MatchSettings, 'pack' | 'squadSize'> = {
    cricketMode: 'ipl', marqueeFirst: true, roster: 'both', purseFeel: 'normal', showUpcoming: false,
  };
  const out: Config[] = [];
  for (const size of [6, 12] as SquadSize[]) {
    out.push({ label: `cricket ipl ${size}`, s: { ...base, pack: 'cricket', squadSize: size } });
    out.push({ label: `cricket general ${size}`, s: { ...base, pack: 'cricket', squadSize: size, cricketMode: 'general' } });
  }
  for (const size of [3, 4, 6] as SquadSize[]) out.push({ label: `pokemon ${size}`, s: { ...base, pack: 'pokemon', squadSize: size, marqueeFirst: false } });
  for (const size of [3, 4, 6] as SquadSize[]) out.push({ label: `heroes ${size}`, s: { ...base, pack: 'heroes', squadSize: size, marqueeFirst: false } });
  out.push({ label: 'heroes marvel 6', s: { ...base, pack: 'heroes', squadSize: 6, roster: 'marvel', marqueeFirst: false } });
  return out;
}

function main(): void {
  const argN = process.argv.indexOf('--n');
  const n = argN > 0 ? Number(process.argv[argN + 1]) : 1000;
  const rows: Result[] = [];
  for (const c of configs()) {
    const r = simulate(c, n);
    rows.push(r);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  const fails: string[] = [];
  const pad = (s: string | number, w: number) => String(s).padEnd(w);
  const header = `${pad('config', 20)}${pad('price/base', 12)}${pad('unsold%*', 9)}${pad('stars win%', 12)}${pad('balanced%', 11)}${pad('all-ins', 9)}broken`;
  const lines = [header];
  for (const r of rows) {
    lines.push(`${pad(r.label, 20)}${pad(r.priceRatio.toFixed(2), 12)}${pad(r.unsoldPct.toFixed(1), 9)}${pad(r.starsWin.toFixed(1), 12)}${pad(r.balancedWin.toFixed(1), 11)}${pad(`${r.allInWorked}/${r.allIns}`, 9)}${r.broken}`);
    if (r.priceRatio < 1.2 || r.priceRatio > 1.5) fails.push(`${r.label}: price/base ${r.priceRatio.toFixed(2)}`);
    if (r.unsoldPct >= 15) fails.push(`${r.label}: unsold ${r.unsoldPct.toFixed(1)}%`);
    if (r.starsWin < 40 || r.starsWin > 60) fails.push(`${r.label}: stars win ${r.starsWin.toFixed(1)}%`);
    if (r.broken) fails.push(`${r.label}: ${r.broken} broken auctions`);
  }
  console.log(lines.join('\n'));
  console.log(fails.length ? `\nMISSED TARGETS:\n  ${fails.join('\n  ')}` : '\nAll targets met.');
  if (process.argv.includes('--write')) {
    const file = resolve(root, 'src/games/bid-war/config.ts');
    const src = readFileSync(file, 'utf8');
    const body = [`(${n} auctions each; *unsold% counts first offers, see the script)`, ...lines].map((l) => ` *   ${l}`).join('\n');
    writeFileSync(file, src.replace(/( \*   SIM_RESULTS_START\n)[\s\S]*?( \*   SIM_RESULTS_END)/, `$1${body}\n$2`));
    console.log(`Recorded in ${file}`);
  }
  if (fails.length) process.exit(1);
}

main();
