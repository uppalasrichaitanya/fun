import { describe, expect, it } from 'vitest';
import { Rng } from '../../engine/rng';
import { allInMinSlots, BASE_PRICE, TIMING } from './config';
import { Auction, type AuctionEvent } from './rules';
import type { Card, MatchSettings, PlayerIdx, SquadSize, Tier } from './types';

let uid = 0;
function card(tier: Tier, extra: Partial<Card> = {}): Card {
  uid++;
  return { id: `c${uid}`, name: `Card ${uid}`, tier, rating: { S: 90, A: 80, B: 70, C: 60 }[tier], role: 'Batter', stats: {}, tags: {}, ...extra };
}

function settings(over: Partial<MatchSettings> = {}): MatchSettings {
  return { pack: 'pokemon', squadSize: 3, cricketMode: 'general', marqueeFirst: false, roster: 'both', purseFeel: 'normal', showUpcoming: false, ...over };
}

function make(pool: Card[], opts: { size?: SquadSize; purse?: number; s?: Partial<MatchSettings> } = {}) {
  const a = new Auction(settings({ squadSize: opts.size ?? 3, ...opts.s }), pool, opts.purse ?? 20, 1);
  const events: AuctionEvent[] = [];
  const log = (e: AuctionEvent[]) => { events.push(...e); return e; };
  log(a.begin());
  const act = (type: 'bid1' | 'bid5' | 'pass' | 'allIn' | 'take' | 'leave', p: PlayerIdx, seen?: number) => log(a.dispatch({ type, p, seen }));
  const tick = (ms: number) => log(a.dispatch({ type: 'tick', ms }));
  /** Advance past the SOLD celebration into the next lot. */
  const next = () => tick(TIMING.sold);
  return { a, events, act, tick, next };
}

const types = (ev: AuctionEvent[]) => ev.map((e) => e.type);
const rejectReason = (ev: AuctionEvent[]) => ev.find((e) => e.type === 'reject') as Extract<AuctionEvent, { type: 'reject' }> | undefined;

describe('a normal lot', () => {
  it('opens at base, +1 pays base, +5 opens at base + 4, then adds to the price', () => {
    const { a, act } = make([card('A'), card('A')]);
    expect(a.state.lot!.price).toBe(5);
    act('bid1', 0);
    expect(a.state.lot!.price).toBe(5);
    expect(a.state.lot!.leader).toBe(0);
    act('bid5', 1);
    expect(a.state.lot!.price).toBe(10);
    act('bid1', 0);
    expect(a.state.lot!.price).toBe(11);

    const b = make([card('B')]);
    b.act('bid5', 1);
    expect(b.a.state.lot!.price).toBe(BASE_PRICE.B + 4);
  });

  it('the leader cannot bid against themselves', () => {
    const { a, act } = make([card('B')]);
    act('bid1', 0);
    const ev = act('bid1', 0);
    expect(rejectReason(ev)?.reason).toBe('leading');
    expect(a.state.lot!.price).toBe(3);
  });

  it('every valid bid resets the 8 s countdown; going once at 5 s, twice at 2.5 s, SOLD at 0', () => {
    const { a, act, tick } = make([card('B'), card('B')]);
    act('bid1', 0);
    expect(a.state.lot!.timer).toBe(TIMING.countdown);
    tick(2000);
    act('bid1', 1);
    expect(a.state.lot!.timer).toBe(TIMING.countdown);
    expect(types(tick(3000))).toContain('goingOnce');
    expect(types(tick(2500))).toContain('goingTwice');
    const ev = tick(2500);
    const sold = ev.find((e) => e.type === 'sold');
    expect(sold).toMatchObject({ p: 1, price: 4 });
    expect(a.state.players[1].purse).toBe(16);
    expect(a.state.players[1].squad.map((b) => b.card.id)).toEqual([a.state.history[0].card.id]);
  });

  it('moves on after the 1.2 s celebration', () => {
    const { a, act, tick } = make([card('B'), card('C')]);
    act('bid1', 0); act('pass', 1);
    expect(a.state.phase).toBe('resolved');
    tick(TIMING.sold - 1);
    expect(a.state.phase).toBe('resolved');
    expect(types(tick(1))).toContain('lot');
    expect(a.state.lot!.n).toBe(2);
  });

  it('passing while the other player leads sells immediately', () => {
    const { a, act } = make([card('B'), card('B')]);
    act('bid1', 0);
    const ev = act('pass', 1);
    expect(ev.find((e) => e.type === 'sold')).toMatchObject({ p: 0, price: 3 });
    expect(a.state.phase).toBe('resolved');
  });

  it('after a pass with no bids the other player may still buy at base', () => {
    const { a, act } = make([card('A'), card('A')]);
    act('pass', 0);
    expect(a.state.phase).toBe('lot');
    const ev = act('bid5', 1);
    expect(ev.find((e) => e.type === 'sold')).toMatchObject({ p: 1, price: 5 });
  });

  it('both passing with no bids is UNSOLD', () => {
    const { a, act } = make([card('S'), card('A')]);
    act('pass', 0);
    const ev = act('pass', 1);
    expect(types(ev)).toContain('unsold');
    expect(a.state.unsold).toHaveLength(1);
  });

  it('the opening timer running out with no bids is UNSOLD', () => {
    const { a, tick } = make([card('S'), card('A')]);
    expect(a.state.lot!.timer).toBe(TIMING.opening);
    tick(TIMING.opening - 100);
    expect(a.state.phase).toBe('lot');
    expect(types(tick(100))).toContain('unsold');
  });

  it('a pass by the leader is ignored', () => {
    const { a, act } = make([card('B'), card('B')]);
    act('bid1', 0);
    const ev = act('pass', 0);
    expect(rejectReason(ev)?.reason).toBe('leader-pass');
    expect(a.state.lot!.out).toEqual([false, false]);
    expect(a.state.phase).toBe('lot');
  });

  it('flags a steal (S or A tier at base) and a bidding war (4 bids)', () => {
    const { act, events } = make([card('A'), card('B')]);
    act('bid1', 0);
    const sold = act('pass', 1).find((e) => e.type === 'sold');
    expect(sold).toMatchObject({ steal: true });
    const b = make([card('B'), card('B')]);
    b.act('bid1', 0); b.act('bid1', 1); b.act('bid1', 0);
    const ev = b.act('bid1', 1);
    expect(ev.find((e) => e.type === 'bid')).toMatchObject({ war: true, count: 4 });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('simultaneous bids', () => {
  it('first processed wins; the second is re-evaluated against the new price', () => {
    // P2 can afford exactly one more dollar than base: P1's same-frame bid pushes the price past P2's guard.
    const { a, act } = make([card('B'), card('C'), card('C')], { purse: 20 });
    a.state.players[1].purse = 5; // 3 empty slots: maxBid = 5 - 2 = 3
    act('bid1', 0, 0);
    const ev = act('bid1', 1, 0);
    expect(rejectReason(ev)?.reason).toBe('too-late');
    expect(a.state.lot!.leader).toBe(0);
    expect(a.state.lot!.price).toBe(3);
  });

  it('a raced bid that is still valid lands at the new price', () => {
    const { a, act } = make([card('B'), card('B')]);
    act('bid1', 0, 0);
    act('bid1', 1, 0);
    expect(a.state.lot!.price).toBe(4);
    expect(a.state.lot!.leader).toBe(1);
  });
});

describe('budget guard', () => {
  it('maxBid = purse - (emptySlots - 1)', () => {
    const { a } = make([card('B'), card('B'), card('B')], { purse: 20 });
    expect(a.maxBid(0)).toBe(18);
  });

  it('a bid exactly at maxBid is allowed, one more is not', () => {
    const { a, act } = make([card('B'), card('C'), card('C')], { purse: 12 }); // maxBid 10
    act('bid5', 0); // 7
    act('bid1', 1); // 8
    act('bid1', 0); // 9
    const ok = act('bid1', 1); // 10 = maxBid
    expect(rejectReason(ok)).toBeUndefined();
    expect(a.state.lot!.price).toBe(10);
    const ev = act('bid1', 0); // 11 > 10
    expect(rejectReason(ev)?.reason).toBe('max');
    expect(a.state.lot!.leader).toBe(1);
  });

  it('jumps straight to going once when the trailer cannot respond', () => {
    const { a, act } = make([card('B'), card('C'), card('C')], { purse: 12 }); // both maxBid 10
    a.state.players[0].allInUsed = true; // otherwise P1 could still answer with an all-in
    act('bid5', 0);
    expect(rejectReason(act('bid5', 1))?.reason).toBe('max'); // 12 > 10
    expect(a.state.lot!.price).toBe(7);
    act('bid1', 1); act('bid1', 0); act('bid1', 1); // 8, 9, 10
    expect(a.state.lot!.price).toBe(10);
    expect(a.state.lot!.timer).toBe(TIMING.goingOnce);
  });
});

describe('caps', () => {
  it('squad full: that player auto-passes and the other gets take-or-leave', () => {
    const { a, act, next } = make([card('C'), card('C'), card('C'), card('C'), card('C')], { size: 3 });
    for (let i = 0; i < 3; i++) { act('bid1', 0); act('pass', 1); next(); }
    expect(a.state.players[0].squad).toHaveLength(3);
    expect(a.state.lot!.solo).toBe(1);
    expect(a.state.lot!.out).toEqual([true, false]);
    expect(rejectReason(act('bid1', 0))?.reason).toBe('full');
    const ev = act('take', 1);
    expect(ev.find((e) => e.type === 'sold')).toMatchObject({ p: 1, price: 1 });
  });

  it('IPL-style overseas cap blocks bids with a reason', () => {
    const os = () => card('B', { tags: { overseas: true } });
    const { a, act, next } = make([os(), os(), os(), card('B'), card('B'), card('B'), card('B'), card('B')], {
      size: 6, purse: 42, s: { pack: 'cricket', cricketMode: 'ipl' },
    });
    act('bid1', 0); act('pass', 1); next();
    act('bid1', 0); act('pass', 1); next();
    expect(a.capBlock(0, a.state.lot!.card)).toMatch(/Overseas cap/);
    expect(a.state.lot!.solo).toBe(1);
  });

  it('General cricket mode has no overseas rule', () => {
    const os = () => card('B', { tags: { overseas: true } });
    const { a } = make([os(), os(), os()], { size: 6, s: { pack: 'cricket', cricketMode: 'general' } });
    a.state.players[0].squad.push({ card: os(), price: 3, lot: 0, how: 'bid' }, { card: os(), price: 3, lot: 0, how: 'bid' });
    expect(a.capBlock(0, a.state.lot!.card)).toBeNull();
  });

  it('max 1 Legendary per Pokemon team, max 1 Cosmic per hero team', () => {
    const leg = () => card('S', { tags: { legendary: true } });
    const p = make([leg(), leg(), card('C')], { purse: 20 });
    p.act('bid1', 0); p.act('pass', 1); p.next();
    expect(p.a.capBlock(0, p.a.state.lot!.card)).toMatch(/Legendary/);
    const cos = () => card('S', { tags: { cosmic: true } });
    const h = make([cos(), cos(), card('C')], { s: { pack: 'heroes' } });
    h.act('bid1', 1); h.act('pass', 0); h.next();
    expect(h.a.capBlock(1, h.a.state.lot!.card)).toMatch(/Cosmic/);
  });
});

describe('all-in', () => {
  it('needs max(2, ceil(size/2)) empty slots', () => {
    expect([3, 4, 6, 12].map((n) => allInMinSlots(n as SquadSize))).toEqual([2, 2, 3, 6]);
  });

  it('works on the last allowed slot count and is closed one slot later', () => {
    const pool = Array.from({ length: 8 }, () => card('C'));
    const { a, act, next } = make(pool, { size: 6, purse: 42 });
    for (let i = 0; i < 3; i++) { act('bid1', 0); act('pass', 1); next(); }
    expect(a.empty(0)).toBe(3);
    expect(a.allInBlock(0)).toBeNull();
    act('bid1', 0); act('pass', 1); next();
    expect(a.empty(0)).toBe(2);
    expect(a.allInBlock(0)).toBe('all-in-closed');
  });

  it('wins when the opponent max equals the all-in amount, then locks the player', () => {
    const { a, act, tick } = make([card('S'), card('C'), card('C'), card('C')], { purse: 20 });
    a.state.players[0].purse = 14;
    a.state.players[1].purse = 16; // maxBid 16 - 2 = 14
    a.state.players[1].allInUsed = true; // no counter all-in
    act('allIn', 0);
    expect(a.state.lot!.price).toBe(14);
    expect(rejectReason(act('bid1', 1))?.reason).toBe('max');
    expect(a.state.lot!.timer).toBe(TIMING.goingOnce);
    const ev = tick(TIMING.goingOnce);
    expect(types(ev)).toEqual(expect.arrayContaining(['goingOnce', 'goingTwice', 'sold', 'locked']));
    expect(a.state.players[0]).toMatchObject({ purse: 0, locked: true, allInUsed: true });
    expect(a.state.allIns[0]).toMatchObject({ worked: true, amount: 14 });
  });

  it('fails when the opponent outbids it: money kept, all-in used up, lot continues', () => {
    const { a, act } = make([card('S'), card('C'), card('C'), card('C')], { purse: 20 });
    a.state.players[0].purse = 14;
    a.state.players[1].purse = 17; // maxBid 15
    act('allIn', 0);
    const ev = act('bid1', 1);
    expect(types(ev)).toContain('allInFailed');
    expect(a.state.lot!.price).toBe(15);
    expect(a.state.lot!.leader).toBe(1);
    expect(a.state.players[0]).toMatchObject({ purse: 14, locked: false, allInUsed: true });
    expect(a.allInBlock(0)).toBe('all-in-used');
    expect(a.state.allIns[0]).toMatchObject({ worked: false, by: 1 });
  });

  it('ignores the budget guard and whether you are already leading', () => {
    const { a, act } = make([card('B'), card('C'), card('C')], { purse: 20 });
    act('bid1', 0);
    expect(a.allInBlock(0)).toBeNull();
    act('allIn', 0);
    expect(a.state.lot!.price).toBe(20);
    expect(a.maxBid(0)).toBe(18);
  });

  it('a locked player gets what the opponent leaves for $0; the opponent takes at base', () => {
    const { a, act, tick, next } = make([card('S'), card('B'), card('A'), card('C'), card('C')], { purse: 20 });
    act('allIn', 0); act('pass', 1); next();
    expect(a.state.players[0].locked).toBe(true);
    expect(a.state.lot!.solo).toBe(1);
    expect(a.allInBlock(1)).toBe('all-in-hidden');
    expect(rejectReason(act('bid1', 0))?.reason).toBe('locked');
    expect(rejectReason(act('pass', 0))?.reason).toBe('locked');
    expect(act('take', 1).find((e) => e.type === 'sold')).toMatchObject({ p: 1, price: 3 });
    next();
    expect(types(act('leave', 1))).toContain('free');
    expect(a.state.players[0].squad.at(-1)).toMatchObject({ price: 0, how: 'free' });
    next();
    // Countdown runs out on a take-or-leave lot = leave.
    expect(types(tick(TIMING.countdown))).toContain('free');
    expect(a.full(0)).toBe(true);
  });

  it("a left card that would break the locked player's cap goes to Unsold", () => {
    const leg = () => card('S', { tags: { legendary: true } });
    const { a, act, next } = make([leg(), leg(), card('C'), card('C'), card('C')], { purse: 20 });
    act('allIn', 0); act('pass', 1); next();
    // P2 already... cannot take: give them a legendary first.
    a.state.players[1].squad.push({ card: leg(), price: 8, lot: 0, how: 'bid' });
    expect(a.capBlock(1, a.state.lot!.card)).toMatch(/Legendary/);
    // Current lot was opened before the cap applied: leave it and check the destination.
    const ev = act('leave', 1);
    expect(types(ev)).toContain('unsold');
    expect(a.state.players[0].squad).toHaveLength(1);
  });

  it('a lot nobody can act on resolves on its own (cap-blocked free player, cap-blocked locked player)', () => {
    const leg = () => card('S', { tags: { legendary: true } });
    const { a, act, next, events } = make([leg(), card('C'), leg(), card('C')], { purse: 20 });
    act('allIn', 0); act('pass', 1); next();        // P1 locked with a legendary
    act('take', 1);                                 // P2 takes the C...
    a.state.players[1].squad.push({ card: leg(), price: 0, lot: 0, how: 'bid' }); // ...and already owns a legendary
    next();
    // Lot 3 is a legendary: P2 already has one, P1 is locked and already has one.
    expect(a.state.lot!.out).toEqual([true, true]);
    expect(events.at(-1)?.type).toBe('unsold');
    expect(a.state.phase).toBe('resolved');
  });

  it('a counter all-in beats an all-in when the purse is bigger', () => {
    const { a, act } = make([card('S'), card('C'), card('C'), card('C')], { purse: 20 });
    a.state.players[0].purse = 14;
    act('allIn', 0);
    const ev = act('allIn', 1);
    expect(types(ev)).toEqual(expect.arrayContaining(['allInFailed', 'allIn']));
    expect(a.state.lot!.price).toBe(20);
    expect(a.state.lot!.allIn).toBe(1);
  });
});

describe('end of auction', () => {
  it('ends early when both squads are full before the pool ends', () => {
    const { a, act, next, events } = make(Array.from({ length: 8 }, () => card('C')), { size: 3 });
    for (let i = 0; i < 6; i++) { act('bid1', (i % 2) as PlayerIdx); act('pass', ((i + 1) % 2) as PlayerIdx); next(); }
    expect(a.state.phase).toBe('done');
    expect(types(events)).toContain('end');
    expect(a.state.unsold).toHaveLength(2);
  });

  it('runs an unsold round, then fills from the lowest-rated leftovers, then reserves', () => {
    const pool = [card('S', { rating: 95 }), card('A', { rating: 85 }), card('C', { rating: 61 })];
    const { a, act, next, events } = make(pool, { size: 3 });
    act('bid1', 0); act('pass', 1); next();  // S to P1
    act('pass', 0); act('pass', 1); next();  // A unsold
    act('pass', 0); act('pass', 1); next();  // C unsold
    expect(types(events)).toContain('unsoldRound');
    expect(a.state.round).toBe('unsold');
    act('pass', 0); act('pass', 1); next();
    act('pass', 0); act('pass', 1); next();
    expect(a.state.phase).toBe('done');
    const fills = events.find((e) => e.type === 'reserves') as Extract<AuctionEvent, { type: 'reserves' }>;
    expect(fills.fills[0].card.rating).toBe(61); // lowest-rated leftover goes first
    expect(fills.fills.some((f) => f.reserve)).toBe(true);
    expect(a.full(0) && a.full(1)).toBe(true);
    expect(a.state.players[1].squad.some((b) => b.card.name === 'Wild Rattata')).toBe(true);
  });
});

describe('undo', () => {
  it('undoes the last SOLD within 3 s, restoring purse and lot', () => {
    const { a, act, tick } = make([card('B'), card('B')]);
    act('bid1', 0);
    act('pass', 1);
    expect(a.state.players[0].purse).toBe(17);
    tick(2000);
    const ev = a.dispatch({ type: 'undo' });
    expect(types(ev)).toContain('undone');
    expect(a.state.players[0].purse).toBe(20);
    expect(a.state.phase).toBe('lot');
    expect(a.state.lot!.n).toBe(1);
    expect(a.state.lot!.leader).toBe(0);
    expect(a.state.lot!.timer).toBe(TIMING.countdown);
    expect(a.undoAge()).toBeNull(); // one step only
  });

  it('cannot undo after 3 s', () => {
    const { a, act, tick } = make([card('B'), card('B')]);
    act('bid1', 0); act('pass', 1);
    tick(TIMING.undo + 1);
    expect(a.dispatch({ type: 'undo' })).toEqual([]);
    expect(a.state.players[0].purse).toBe(17);
  });

  it('undoes a timer SOLD', () => {
    const { a, act, tick } = make([card('B'), card('B')]);
    act('bid1', 1);
    tick(TIMING.countdown);
    expect(a.state.players[1].squad).toHaveLength(1);
    a.dispatch({ type: 'undo' });
    expect(a.state.players[1].squad).toHaveLength(0);
    expect(a.state.phase).toBe('lot');
  });
});

describe('robustness', () => {
  const sizes: SquadSize[] = [3, 4, 6, 12];
  const acts = ['bid1', 'bid5', 'pass', 'allIn', 'take', 'leave'] as const;

  function randomAuction(seed: number, size: SquadSize) {
    const rng = new Rng(seed);
    const tiers: Tier[] = ['S', 'A', 'B', 'C'];
    const pool = Array.from({ length: size * 2 + 3 }, () => card(rng.pick(tiers), {
      tags: { legendary: rng.chance(0.2), overseas: rng.chance(0.4), cosmic: rng.chance(0.2) },
    }));
    const pack = rng.pick(['pokemon', 'heroes', 'cricket'] as const);
    const a = new Auction(settings({ squadSize: size, pack, cricketMode: 'ipl' }), pool, rng.int(size, size * 8), seed);
    const trace: string[] = [];
    a.begin();
    let guard = 0;
    while (a.state.phase !== 'done' && guard++ < 20000) {
      const r = rng.next();
      if (r < 0.5) a.dispatch({ type: 'tick', ms: rng.int(50, 1500) });
      else if (r < 0.52) a.dispatch({ type: 'undo' });
      else a.dispatch({ type: rng.pick(acts), p: rng.int(0, 1) as PlayerIdx });
      trace.push(JSON.stringify([a.state.phase, a.state.lot?.price, a.state.players[0].purse, a.state.players[1].purse]));
    }
    return { a, trace };
  }

  it('every random auction ends with two full squads and no negative purse', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const size = sizes[seed % 4];
      const { a } = randomAuction(seed, size);
      expect(a.state.phase, `seed ${seed}`).toBe('done');
      for (const p of a.state.players) {
        expect(p.squad, `seed ${seed}`).toHaveLength(size);
        expect(p.purse).toBeGreaterThanOrEqual(0);
        // Caps hold for every squad.
        if (a.state.settings.pack === 'pokemon') expect(p.squad.filter((b) => b.card.tags.legendary).length).toBeLessThanOrEqual(1);
        if (a.state.settings.pack === 'heroes') expect(p.squad.filter((b) => b.card.tags.cosmic).length).toBeLessThanOrEqual(1);
      }
      const ids = a.state.players.flatMap((p) => p.squad.map((b) => b.card.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('is deterministic: same seed and actions give the same auction', () => {
    const x = randomAuction(77, 6), y = randomAuction(77, 6);
    expect(x.trace).toEqual(y.trace);
  });
});
