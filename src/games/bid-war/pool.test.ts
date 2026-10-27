import { describe, expect, it } from 'vitest';
import { SQUADS } from './config';
import cricketJson from './packs/cricket.json';
import heroesJson from './packs/heroes.json';
import pokemonJson from './packs/pokemon.json';
import { buildPool, codeForSeed, poolProblem, seedFromCode } from './pool';
import { Auction } from './rules';
import { autoScore, civilWar, judgePrompt, awards } from './scoring';
import type { MatchSettings, Pack, PlayerIdx, SquadSize } from './types';

const PACKS = { cricket: cricketJson as Pack, pokemon: pokemonJson as Pack, heroes: heroesJson as Pack };

function settings(over: Partial<MatchSettings>): MatchSettings {
  return { pack: 'cricket', squadSize: 6, cricketMode: 'ipl', marqueeFirst: true, roster: 'both', purseFeel: 'normal', showUpcoming: false, ...over };
}

const CONFIGS: MatchSettings[] = [
  settings({ squadSize: 6 }), settings({ squadSize: 12 }), settings({ squadSize: 12, cricketMode: 'general', marqueeFirst: false }),
  ...([3, 4, 6] as SquadSize[]).map((n) => settings({ pack: 'pokemon', squadSize: n, marqueeFirst: false })),
  ...([3, 4, 6] as SquadSize[]).map((n) => settings({ pack: 'heroes', squadSize: n, marqueeFirst: false })),
  settings({ pack: 'heroes', squadSize: 6, roster: 'marvel', marqueeFirst: false }),
];

describe('packs', () => {
  it('cards have unique ids, valid tiers and 0-100 ratings', () => {
    for (const p of Object.values(PACKS)) {
      expect(new Set(p.cards.map((c) => c.id)).size).toBe(p.cards.length);
      for (const c of p.cards) {
        expect(['S', 'A', 'B', 'C']).toContain(c.tier);
        expect(c.rating).toBeGreaterThanOrEqual(0);
        expect(c.rating).toBeLessThanOrEqual(100);
      }
    }
    expect(PACKS.cricket.cards).toHaveLength(80);
    expect(PACKS.cricket.cards.filter((c) => c.tags.overseas)).toHaveLength(30);
    expect(PACKS.pokemon.cards.filter((c) => c.tags.legendary).length).toBeGreaterThanOrEqual(20);
    expect(PACKS.heroes.cards.every((c) => c.tier !== 'S' || c.tags.cosmic)).toBe(true);
  });
});

describe('pool builder', () => {
  it('draws the tier mix and passes the pack checks for every configuration', () => {
    for (const s of CONFIGS) {
      for (let seed = 1; seed <= 60; seed++) {
        const r = buildPool(PACKS[s.pack], s, seed);
        const mix = SQUADS[s.squadSize].mix;
        expect(r.cards).toHaveLength(SQUADS[s.squadSize].pool);
        for (const t of ['S', 'A', 'B', 'C'] as const) expect(r.cards.filter((c) => c.tier === t)).toHaveLength(mix[t]);
        expect(r.problem, `${s.pack} ${s.squadSize} seed ${seed}`).toBeNull();
        expect(poolProblem(r.cards, s)).toBeNull();
        if (s.roster === 'marvel' && s.pack === 'heroes') expect(r.cards.every((c) => c.tags.publisher === 'Marvel')).toBe(true);
      }
    }
  });

  it('puts every S-tier first with Marquee first on; spreads them otherwise', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const on = buildPool(PACKS.cricket, settings({ squadSize: 12 }), seed).cards;
      expect(on.slice(0, 5).every((c) => c.tier === 'S')).toBe(true);
      const off = buildPool(PACKS.cricket, settings({ squadSize: 12, marqueeFirst: false }), seed).cards;
      expect(off.slice(0, 3).filter((c) => c.tier === 'S').length).toBeLessThanOrEqual(2);
      expect(off.slice(-3).filter((c) => c.tier === 'S').length).toBeLessThanOrEqual(2);
    }
  });

  it('a match code replays the same draw', () => {
    const seed = 123456789;
    const code = codeForSeed(seed);
    expect(seedFromCode(code)).toBe(seed);
    expect(seedFromCode(code.toLowerCase())).toBe(seed);
    const a = buildPool(PACKS.pokemon, settings({ pack: 'pokemon' }), seedFromCode(code)).cards.map((c) => c.id);
    const b = buildPool(PACKS.pokemon, settings({ pack: 'pokemon' }), seed).cards.map((c) => c.id);
    expect(a).toEqual(b);
    expect(seedFromCode('Rahul vs Sai')).toBe(seedFromCode('RAHUL VS SAI'));
  });
});

describe('scoring', () => {
  /** Plays a quick auction: players alternate buying at base. */
  function played(s: MatchSettings, seed: number) {
    const pool = buildPool(PACKS[s.pack], s, seed).cards;
    const a = new Auction(s, pool, SQUADS[s.squadSize].purse, seed);
    a.begin();
    let turn: PlayerIdx = 0;
    for (let i = 0; i < 500 && a.state.phase !== 'done'; i++) {
      if (a.state.phase === 'lot') {
        const lot = a.state.lot!;
        const p = lot.solo ?? turn;
        a.dispatch({ type: lot.solo !== null ? 'take' : 'bid1', p });
        if (a.state.phase === 'lot') a.dispatch({ type: 'pass', p: p === 0 ? 1 : 0 });
        if (a.state.phase === 'lot') a.dispatch({ type: 'leave', p });
        turn = turn === 0 ? 1 : 0;
      }
      a.dispatch({ type: 'tick', ms: 1200 });
    }
    expect(a.state.phase).toBe('done');
    return a.state;
  }

  it('Civil War is decided by stats only and identical on replay', () => {
    const s = settings({ pack: 'heroes', squadSize: 6, marqueeFirst: false });
    const x = civilWar(played(s, 9)), y = civilWar(played(s, 9));
    expect(x).toEqual(y);
    expect(x.rounds.map((r) => r.keys)).toEqual([['STR', 'DUR'], ['INT', 'CMB'], ['PWR', 'SPD']]);
    const winner = x.winner;
    if (winner !== null) expect(x.wins[winner]).toBeGreaterThanOrEqual(2);
  });

  it('auto score adds Strength + Balance + Value (+ Battle) and picks a winner', () => {
    for (const s of CONFIGS) {
      const st = played(s, 4);
      const war = s.pack === 'heroes' ? civilWar(st).winner : null;
      const sc = autoScore(st, war);
      for (const t of sc.teams) expect(t.total).toBeCloseTo(t.strength + t.balance + t.value + t.battle, 5);
      expect(sc.teams.filter((t) => t.value === 5).length).toBeLessThanOrEqual(1);
      if (s.pack === 'heroes' && war !== null) expect(sc.teams[war].battle).toBe(10);
    }
  });

  it('the AI judge prompt follows the template', () => {
    const st = played(settings({ pack: 'cricket', squadSize: 6 }), 2);
    const text = judgePrompt(st, ['Rahul', 'Sai'], awards(st, ['Rahul', 'Sai']));
    expect(text.startsWith('You are a witty but fair judge. Two friends just held a draft auction.')).toBe(true);
    expect(text).toContain('Pack: Cricket, IPL-style, 6-player squads, purse $42 each');
    expect(text).toContain('Team Rahul (spent $');
    expect(text).toContain('Decide which team is stronger for a T20 match.');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(12);
    expect(text).not.toMatch(/undefined|NaN|\{/);
  });
});
