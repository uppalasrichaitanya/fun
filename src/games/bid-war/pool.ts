import { hashString, Rng } from '../../engine/rng';
import { ROLE_MIN, SQUADS, TIERS } from './config';
import type { Card, MatchSettings, Pack, Tier } from './types';

export const BAT_ROLES = ['Batter', 'Wicketkeeper', 'All-rounder'];
export const BOWL_ROLES = ['Pace bowler', 'Spin bowler', 'All-rounder'];
export const HERO_ROLES = ['Powerhouse', 'Genius', 'Fighter', 'Mystic', 'Speedster'];

/** Short shareable code for a seed (base 36). */
export function codeForSeed(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase().padStart(6, '0');
}

/** A typed match code replays the same draw. Any other text is hashed, so "RAHUL VS SAI" works too. */
export function seedFromCode(code: string): number {
  const c = code.trim().toUpperCase();
  return /^[0-9A-Z]{1,6}$/.test(c) ? parseInt(c, 36) >>> 0 : hashString(c);
}

/** Cards a match may draw from, after roster filters. */
export function eligibleCards(pack: Pack, s: MatchSettings): Card[] {
  if (pack.id === 'heroes' && s.roster === 'marvel') return pack.cards.filter((c) => c.tags.publisher === 'Marvel');
  return pack.cards;
}

/** Why a drawn pool is unfit, or null when it is fine. */
export function poolProblem(cards: Card[], s: MatchSettings): string | null {
  if (s.pack === 'cricket') {
    const min = ROLE_MIN[s.squadSize] ?? ROLE_MIN[6]!;
    const n = (roles: string[]) => cards.filter((c) => roles.includes(c.role)).length;
    if (n(['Wicketkeeper']) < 2 * min.wk) return 'keepers';
    if (n(BAT_ROLES) < 2 * min.bat) return 'batting';
    if (n(BOWL_ROLES) < 2 * min.bowl) return 'bowling';
    if (s.cricketMode === 'ipl') {
      const os = cards.filter((c) => c.tags.overseas).length / cards.length;
      if (os < 0.3 || os > 0.45) return 'overseas';
    }
  } else if (s.pack === 'pokemon') {
    if (cards.some((c) => c.tier === 'S' && !c.tags.legendary)) return 'legendary';
    const types = new Set(cards.flatMap((c) => c.tags.types ?? [c.role]));
    if (types.size < 6) return 'types';
  } else {
    if (cards.some((c) => c.tier === 'S' && !c.tags.cosmic)) return 'cosmic';
    // Small pools cannot hold every role twice (8 cards, 5 roles), so they need each once.
    const need = cards.length >= 15 ? 2 : 1;
    for (const r of HERO_ROLES) if (cards.filter((c) => c.role === r).length < need) return 'roles';
  }
  return null;
}

/** Spread order: never more than 2 S-tier lots in the first 3 or the last 3. */
function spreadOk(order: Card[]): boolean {
  const s = (xs: Card[]) => xs.filter((c) => c.tier === 'S').length;
  return s(order.slice(0, 3)) <= 2 && s(order.slice(-3)) <= 2;
}

export interface PoolResult { cards: Card[]; tries: number; problem: string | null }

/**
 * Draw a seeded pool: the tier mix for the squad size, redrawn (up to 50 tries)
 * until the pack's validity checks pass, then ordered.
 */
export function buildPool(pack: Pack, s: MatchSettings, seed: number): PoolResult {
  const rng = new Rng(seed);
  const tune = SQUADS[s.squadSize];
  const byTier = new Map<Tier, Card[]>(TIERS.map((t) => [t, eligibleCards(pack, s).filter((c) => c.tier === t)]));
  let cards: Card[] = [];
  let problem: string | null = null;
  let tries = 0;
  while (tries < 50) {
    tries++;
    cards = [];
    for (const t of TIERS) cards.push(...rng.shuffle([...byTier.get(t)!]).slice(0, tune.mix[t]));
    problem = poolProblem(cards, s);
    if (!problem) break;
  }
  let order: Card[];
  if (s.marqueeFirst && s.pack === 'cricket') {
    const stars = rng.shuffle(cards.filter((c) => c.tier === 'S'));
    order = [...stars, ...rng.shuffle(cards.filter((c) => c.tier !== 'S'))];
  } else {
    order = rng.shuffle([...cards]);
    for (let i = 0; i < 200 && !spreadOk(order); i++) rng.shuffle(order);
  }
  return { cards: order, tries, problem };
}
