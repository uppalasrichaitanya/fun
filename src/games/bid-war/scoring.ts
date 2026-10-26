import { BASE_PRICE, PURSE_FEEL, ROLE_MIN } from './config';
import { BAT_ROLES, BOWL_ROLES } from './pool';
import type { AuctionState, Bought } from './rules';
import type { Card, MatchSettings, PlayerIdx } from './types';

// ---- Pokemon type chart (attacker -> defenders it hits super-effectively) ----
export const SUPER: Record<string, string[]> = {
  normal: [], fire: ['grass', 'ice', 'bug', 'steel'], water: ['fire', 'ground', 'rock'],
  electric: ['water', 'flying'], grass: ['water', 'ground', 'rock'], ice: ['grass', 'ground', 'flying', 'dragon'],
  fighting: ['normal', 'ice', 'rock', 'dark', 'steel'], poison: ['grass', 'fairy'],
  ground: ['fire', 'electric', 'poison', 'rock', 'steel'], flying: ['grass', 'fighting', 'bug'],
  psychic: ['fighting', 'poison'], bug: ['grass', 'psychic', 'dark'], rock: ['fire', 'ice', 'flying', 'bug'],
  ghost: ['psychic', 'ghost'], dragon: ['dragon'], dark: ['psychic', 'ghost'], steel: ['ice', 'rock', 'fairy'],
  fairy: ['fighting', 'dragon', 'dark'],
};

export interface Breakdown {
  strength: number;
  balance: number;
  value: number;
  battle: number;
  total: number;
  /** Short lines explaining Balance, e.g. "Keeper: met (+4)". */
  notes: string[];
  best: number;
  spent: number;
}

export interface AutoScore { teams: [Breakdown, Breakdown]; winner: PlayerIdx | null; tiebreak: boolean }

const round1 = (n: number) => Math.round(n * 10) / 10;

export function spentOf(squad: Bought[]): number { return squad.reduce((a, b) => a + b.price, 0); }

/** Cricket role counts for a squad. */
export function cricketRoles(cards: Card[]): { wk: number; bat: number; bowl: number } {
  return {
    wk: cards.filter((c) => c.role === 'Wicketkeeper').length,
    bat: cards.filter((c) => BAT_ROLES.includes(c.role)).length,
    bowl: cards.filter((c) => BOWL_ROLES.includes(c.role)).length,
  };
}

function balance(cards: Card[], s: MatchSettings): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;
  if (s.pack === 'cricket') {
    const min = ROLE_MIN[s.squadSize] ?? ROLE_MIN[6]!;
    const have = cricketRoles(cards);
    const rows: [string, number, number][] = [['Keeper', have.wk, min.wk], ['Batting', have.bat, min.bat], ['Bowling', have.bowl, min.bowl]];
    for (const [label, n, need] of rows) {
      const ok = n >= need;
      score += ok ? 4 : -8;
      notes.push(`${label} ${n}/${need}: ${ok ? '+4' : '-8'}`);
    }
  } else if (s.pack === 'pokemon') {
    const types = new Set(cards.flatMap((c) => c.tags.types ?? [c.role]));
    const t = Math.min(12, types.size * 2);
    const hits = new Set<string>();
    for (const ty of types) for (const d of SUPER[ty] ?? []) hits.add(d);
    const cov = Math.min(10, hits.size);
    score = t + cov;
    notes.push(`${types.size} types: +${t}`, `Super-effective vs ${hits.size}: +${cov}`);
  } else {
    const roles = new Set(cards.map((c) => c.role));
    score = Math.min(15, roles.size * 3);
    notes.push(`${roles.size} roles: +${score}`);
  }
  return { score, notes };
}

/** Strength + Balance + Value (+ Battle for Superheroes). */
export function autoScore(state: AuctionState, battleWinner: PlayerIdx | null = null): AutoScore {
  const s = state.settings;
  const parts = state.players.map((pl, i) => {
    const cards = pl.squad.map((b) => b.card);
    const strength = round1(cards.reduce((a, c) => a + c.rating, 0) / Math.max(1, cards.length));
    const bal = balance(cards, s);
    const spent = spentOf(pl.squad);
    const perDollar = cards.reduce((a, c) => a + c.rating, 0) / Math.max(1, spent);
    const battle = s.pack === 'heroes' && battleWinner === i ? 10 : 0;
    return { strength, balance: bal.score, notes: bal.notes, spent, perDollar, battle, best: Math.max(0, ...cards.map((c) => c.rating)) };
  });
  const valueWinner = parts[0].perDollar === parts[1].perDollar ? null : parts[0].perDollar > parts[1].perDollar ? 0 : 1;
  const teams = parts.map((p, i): Breakdown => {
    const value = valueWinner === i ? 5 : 0;
    return {
      strength: p.strength, balance: p.balance, value, battle: p.battle,
      total: round1(p.strength + p.balance + value + p.battle), notes: p.notes, best: p.best, spent: p.spent,
    };
  }) as [Breakdown, Breakdown];
  let winner: PlayerIdx | null = teams[0].total === teams[1].total ? null : teams[0].total > teams[1].total ? 0 : 1;
  let tiebreak = false;
  if (winner === null && teams[0].best !== teams[1].best) { winner = teams[0].best > teams[1].best ? 0 : 1; tiebreak = true; }
  return { teams, winner, tiebreak };
}

// ---- Civil War ----------------------------------------------------------------

export interface WarRound { name: string; keys: [string, string]; totals: [number, number]; winner: PlayerIdx | null }
export interface CivilWar { rounds: WarRound[]; wins: [number, number]; winner: PlayerIdx | null }

export const WAR_ROUNDS: { name: string; keys: [string, string] }[] = [
  { name: 'Clash of Might', keys: ['STR', 'DUR'] },
  { name: 'Battle of Wits', keys: ['INT', 'CMB'] },
  { name: 'Final Surge', keys: ['PWR', 'SPD'] },
];

const statSum = (cards: Card[], keys: string[]) => cards.reduce((a, c) => a + keys.reduce((b, k) => b + (c.stats[k] ?? 0), 0), 0);

/** Best-of-3, decided by team stat sums only. A drawn round goes to the higher all-stat total. */
export function civilWar(state: AuctionState): CivilWar {
  const teams = state.players.map((p) => p.squad.map((b) => b.card));
  const all = ['STR', 'DUR', 'INT', 'CMB', 'PWR', 'SPD'];
  const grand = teams.map((t) => statSum(t, all));
  const wins: [number, number] = [0, 0];
  const rounds = WAR_ROUNDS.map((r): WarRound => {
    const totals = teams.map((t) => statSum(t, r.keys)) as [number, number];
    let winner: PlayerIdx | null = totals[0] === totals[1] ? null : totals[0] > totals[1] ? 0 : 1;
    if (winner === null && grand[0] !== grand[1]) winner = grand[0] > grand[1] ? 0 : 1;
    if (winner !== null) wins[winner]++;
    return { ...r, totals, winner };
  });
  const winner = wins[0] === wins[1] ? null : wins[0] > wins[1] ? 0 : 1;
  return { rounds, wins, winner };
}

/** Hero that leads a round's charge: highest sum of that round's stats. */
export function champion(cards: Card[], keys: string[]): Card | undefined {
  return [...cards].sort((a, b) => statSum([b], keys) - statSum([a], keys))[0];
}

// ---- Awards ----------------------------------------------------------------

export interface Award { id: string; title: string; text: string; p: PlayerIdx | null }

export function awards(state: AuctionState, names: [string, string]): Award[] {
  const out: Award[] = [];
  const bought = state.players.flatMap((pl, p) => pl.squad.filter((b) => b.price > 0).map((b) => ({ ...b, p: p as PlayerIdx })));
  if (bought.length) {
    const steal = [...bought].sort((a, b) => b.card.rating / b.price - a.card.rating / a.price || a.lot - b.lot)[0];
    out.push({ id: 'steal', title: 'Steal of the Auction', p: steal.p, text: `${steal.card.name} for $${steal.price} (${names[steal.p]})` });
    const over = [...bought].sort((a, b) => b.price / BASE_PRICE[b.card.tier] - a.price / BASE_PRICE[a.card.tier] || a.lot - b.lot)[0];
    const ratio = over.price / BASE_PRICE[over.card.tier];
    out.push({ id: 'overpay', title: 'Biggest Overpay', p: over.p, text: `${names[over.p]} paid $${over.price} for ${over.card.name} (${ratio.toFixed(1)}x base)` });
  }
  const war = [...state.history].sort((a, b) => b.bids.length - a.bids.length || a.n - b.n)[0];
  if (war && war.bids.length >= 2) {
    const who = war.winner === null ? 'nobody' : names[war.winner];
    out.push({ id: 'war', title: 'Bidding War of the Night', p: war.winner, text: `${war.card.name}: ${war.bids.length} bids, $${war.price} to ${who}` });
  }
  for (const a of state.allIns) {
    const victim = names[a.p === 0 ? 1 : 0];
    const verdict = a.worked ? 'and it worked' : `and ${names[a.by ?? (a.p === 0 ? 1 : 0)]} outbid it`;
    out.push({ id: 'allin', title: 'All-In Moment', p: a.p, text: `${names[a.p]} went all in on ${a.card.name} against ${victim} for $${a.amount}, ${verdict}` });
  }
  const left = state.players.map((p) => p.purse);
  out.push({
    id: 'purse', title: 'Purse Left', p: null,
    text: `${names[0]} $${left[0]}, ${names[1]} $${left[1]}${Math.max(...left) >= 5 ? '. Money does not score points, by the way.' : ''}`,
  });
  return out;
}

// ---- AI judge ----------------------------------------------------------------

const PACK_LABEL = { cricket: 'Cricket', pokemon: 'Pokemon', heroes: 'Superheroes' } as const;
const CONTEXT = { cricket: 'a T20 match', pokemon: 'a 6v6 Pokemon battle', heroes: 'saving the world' } as const;

export function modeLabel(s: MatchSettings): string {
  if (s.pack === 'cricket') return s.cricketMode === 'ipl' ? 'IPL-style' : 'General';
  if (s.pack === 'heroes') return s.roster === 'marvel' ? 'Marvel' : 'Marvel + DC';
  return 'Standard';
}

export function judgePrompt(state: AuctionState, names: [string, string], aw: Award[]): string {
  const s = state.settings;
  const list = (p: PlayerIdx) => state.players[p].squad
    .map((b) => `- ${b.card.name} - ${roleLabel(b.card)} - ${b.card.rating} - $${b.price}${b.how === 'free' ? ' (free all-in leftover)' : b.how === 'reserve' ? ' (reserve)' : ''}`)
    .join('\n');
  const spent = (p: PlayerIdx) => spentOf(state.players[p].squad);
  return [
    'You are a witty but fair judge. Two friends just held a draft auction.',
    `Pack: ${PACK_LABEL[s.pack]}, ${modeLabel(s)}, ${s.squadSize}-player squads, purse $${state.purseStart} each (${PURSE_FEEL[s.purseFeel].label} purse).`,
    '',
    `Team ${names[0]} (spent $${spent(0)}, left $${state.players[0].purse}):`,
    list(0),
    '',
    `Team ${names[1]} (spent $${spent(1)}, left $${state.players[1].purse}):`,
    list(1),
    '',
    `Auction highlights: ${aw.map((a) => `${a.title}: ${a.text}`).join('; ')}`,
    '',
    `Decide which team is stronger for ${CONTEXT[s.pack]}.`,
    'Give: the winner, a score out of 10 for each team, the best signing,',
    'the worst overpay, and one friendly roast per team. Under 200 words.',
  ].join('\n');
}

export function roleLabel(c: Card): string {
  if (c.tags.types) return c.tags.types.map((t) => t[0].toUpperCase() + t.slice(1)).join('/');
  return c.role;
}

/** Plain-text summary for "Copy as text". */
export function summaryText(state: AuctionState, names: [string, string], score: AutoScore, aw: Award[]): string {
  const s = state.settings;
  const team = (p: PlayerIdx) => [
    `${names[p]} (${score.teams[p].total} pts, spent $${spentOf(state.players[p].squad)}, left $${state.players[p].purse})`,
    ...state.players[p].squad.map((b) => `  ${b.card.name} $${b.price}`),
  ].join('\n');
  const head = score.winner === null ? 'Dead heat!' : `${names[score.winner]} wins the auction!`;
  return [
    `BID WAR - ${PACK_LABEL[s.pack]} (${modeLabel(s)}, ${s.squadSize}-a-side)`, head, '', team(0), '', team(1), '',
    ...aw.map((a) => `${a.title}: ${a.text}`),
  ].join('\n');
}
