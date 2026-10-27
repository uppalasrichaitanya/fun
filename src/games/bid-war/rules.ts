/**
 * Bid War rules engine: a deterministic state machine with no rendering, no
 * clock and no Math.random. The UI sends actions (including `tick` for time)
 * and renders `state`; every action returns the events it caused.
 */
import { Rng } from '../../engine/rng';
import { allInMinSlots, BASE_PRICE, OVERSEAS_CAP, TIMING, WAR_BIDS } from './config';
import type { Card, MatchSettings, PackId, PlayerIdx, SquadSize } from './types';

export type PlayerAction = 'bid1' | 'bid5' | 'pass' | 'allIn' | 'take' | 'leave';
export type Action =
  | { type: PlayerAction; p: PlayerIdx; /** Bid count the player saw when pressing (simultaneous-bid detection). */ seen?: number }
  | { type: 'tick'; ms: number }
  | { type: 'undo' };

export type Reject =
  | 'no-lot' | 'locked' | 'full' | 'cap' | 'passed' | 'leading' | 'max' | 'too-late'
  | 'leader-pass' | 'all-in-used' | 'all-in-closed' | 'all-in-hidden' | 'cant-afford' | 'solo-only' | 'not-solo';

export type How = 'bid' | 'allIn' | 'free' | 'reserve';
export interface Bought { card: Card; price: number; lot: number; how: How }

export interface PlayerState {
  purse: number;
  squad: Bought[];
  allInUsed: boolean;
  locked: boolean;
}

export interface Bid { p: PlayerIdx; price: number; allIn?: boolean }

export interface Lot {
  /** 1-based lot number across the whole auction. */
  n: number;
  card: Card;
  round: 'main' | 'unsold';
  price: number;
  leader: PlayerIdx | null;
  /** Passed, or never eligible for this lot. */
  out: [boolean, boolean];
  bids: Bid[];
  timer: number;
  /** 0 none, 1 going once, 2 going twice. */
  stage: 0 | 1 | 2;
  /** Player whose all-in is the standing bid. */
  allIn: PlayerIdx | null;
  /** Take-or-leave lot: only this player may act. */
  solo: PlayerIdx | null;
}

export interface LotRecord {
  n: number;
  card: Card;
  round: 'main' | 'unsold';
  bids: Bid[];
  winner: PlayerIdx | null;
  price: number;
  how: How | 'unsold';
}

export interface AllInRecord { p: PlayerIdx; card: Card; amount: number; worked: boolean | null; by?: PlayerIdx }

export interface AuctionState {
  settings: MatchSettings;
  seed: number;
  purseStart: number;
  clock: number;
  phase: 'lot' | 'resolved' | 'done';
  players: [PlayerState, PlayerState];
  /** Main pool still to come (next lot first). */
  queue: Card[];
  /** Unsold tray. */
  unsold: Card[];
  round: 'main' | 'unsold';
  lot: Lot | null;
  lotCount: number;
  resolveTimer: number;
  history: LotRecord[];
  allIns: AllInRecord[];
  reserves: number;
}

export type AuctionEvent =
  | { type: 'lot'; lot: Lot }
  | { type: 'bid'; p: PlayerIdx; price: number; jump: boolean; count: number; war: boolean }
  | { type: 'reject'; p: PlayerIdx; action: PlayerAction; reason: Reject }
  | { type: 'pass'; p: PlayerIdx }
  | { type: 'goingOnce' } | { type: 'goingTwice' }
  | { type: 'allIn'; p: PlayerIdx; amount: number }
  | { type: 'allInFailed'; p: PlayerIdx; by: PlayerIdx }
  | { type: 'sold'; p: PlayerIdx; price: number; card: Card; allIn: boolean; steal: boolean; bids: number }
  | { type: 'unsold'; card: Card }
  | { type: 'free'; p: PlayerIdx; card: Card }
  | { type: 'locked'; p: PlayerIdx }
  | { type: 'unsoldRound'; count: number }
  | { type: 'reserves'; fills: { p: PlayerIdx; card: Card; reserve: boolean }[] }
  | { type: 'end' }
  | { type: 'undone' };

const other = (p: PlayerIdx): PlayerIdx => (p === 0 ? 1 : 0);
const clone = <T>(v: T): T => structuredClone(v);

const RESERVE: Record<PackId, { name: string; role: string }> = {
  cricket: { name: 'Net bowler', role: 'Pace bowler' },
  pokemon: { name: 'Wild Rattata', role: 'normal' },
  heroes: { name: 'Rookie agent', role: 'Fighter' },
};

export function reserveCard(pack: PackId, n: number): Card {
  const r = RESERVE[pack];
  return {
    id: `reserve-${pack}-${n}`, name: r.name, tier: 'C', rating: 30, role: r.role, reserve: true,
    stats: pack === 'cricket' ? { Bat: 10, Bowl: 45 } : pack === 'pokemon' ? { HP: 30, Atk: 56, Def: 35, SpA: 25, SpD: 35, Spe: 72, BST: 253 }
      : { INT: 40, STR: 20, SPD: 30, DUR: 30, PWR: 20, CMB: 45 },
    tags: pack === 'pokemon' ? { types: ['normal'] } : {},
  };
}

export class Auction {
  state: AuctionState;
  private undoSnap: { at: number; snap: AuctionState } | null = null;

  constructor(settings: MatchSettings, pool: Card[], purse: number, seed: number) {
    const player = (): PlayerState => ({ purse, squad: [], allInUsed: false, locked: false });
    this.state = {
      settings, seed, purseStart: purse, clock: 0, phase: 'resolved',
      players: [player(), player()], queue: [...pool], unsold: [], round: 'main', lot: null,
      lotCount: 0, resolveTimer: 0, history: [], allIns: [], reserves: 0,
    };
  }

  /** Open the first lot. */
  begin(): AuctionEvent[] {
    const ev: AuctionEvent[] = [];
    this.nextLot(ev);
    return ev;
  }

  // ---- queries -------------------------------------------------------------

  get size(): SquadSize { return this.state.settings.squadSize; }
  empty(p: PlayerIdx): number { return this.size - this.state.players[p].squad.length; }
  full(p: PlayerIdx): boolean { return this.empty(p) <= 0; }

  /** Budget guard: every remaining slot must still be fillable at $1. */
  maxBid(p: PlayerIdx): number {
    const e = this.empty(p);
    return e <= 0 ? 0 : this.state.players[p].purse - (e - 1);
  }

  /** Hard cap that stops `p` owning `card`, or null. */
  capBlock(p: PlayerIdx, card: Card): string | null {
    const s = this.state.settings;
    const squad = this.state.players[p].squad;
    if (squad.length >= s.squadSize) return 'Squad full';
    if (s.pack === 'cricket' && s.cricketMode === 'ipl' && card.tags.overseas) {
      const cap = OVERSEAS_CAP[s.squadSize] ?? 2;
      if (squad.filter((b) => b.card.tags.overseas).length >= cap) return `Overseas cap (${cap}) reached`;
    }
    if (s.pack === 'pokemon' && card.tags.legendary && squad.some((b) => b.card.tags.legendary)) return 'Already has a Legendary';
    if (s.pack === 'heroes' && card.tags.cosmic && squad.some((b) => b.card.tags.cosmic)) return 'Already has a Cosmic hero';
    return null;
  }

  /** Price a +1 / +5 would set right now. */
  nextPrice(kind: 'bid1' | 'bid5', p?: PlayerIdx): number {
    const lot = this.state.lot;
    if (!lot) return 0;
    const base = BASE_PRICE[lot.card.tier];
    // Nobody left to bid against: any bid buys at base.
    if (lot.leader === null && (lot.solo !== null || (p !== undefined && lot.out[other(p)]))) return base;
    if (lot.leader === null) return kind === 'bid1' ? base : base + 4;
    return lot.price + (kind === 'bid1' ? 1 : 5);
  }

  /** Why `p` cannot bid `price` on the current lot, or null. */
  bidBlock(p: PlayerIdx, price: number): Reject | null {
    const lot = this.state.lot;
    const pl = this.state.players[p];
    if (!lot || this.state.phase !== 'lot') return 'no-lot';
    if (pl.locked) return 'locked';
    if (this.full(p)) return 'full';
    if (this.capBlock(p, lot.card)) return 'cap';
    if (lot.solo !== null && lot.solo !== p) return 'passed';
    if (lot.out[p]) return 'passed';
    if (lot.leader === p) return 'leading';
    if (price > this.maxBid(p)) return 'max';
    return null;
  }

  allInAmount(p: PlayerIdx): number { return this.state.players[p].purse; }

  /** Why `p` cannot go all-in now, or null. Hidden reasons are not shown as buttons at all. */
  allInBlock(p: PlayerIdx): Reject | null {
    const st = this.state, lot = st.lot, pl = st.players[p];
    if (pl.allInUsed) return 'all-in-used';
    if (pl.locked || st.players[other(p)].locked) return 'all-in-hidden';
    if (this.empty(p) < allInMinSlots(this.size)) return 'all-in-closed';
    if (!lot || st.phase !== 'lot') return 'no-lot';
    if (lot.solo !== null) return 'all-in-hidden';
    if (lot.out[p]) return 'passed';
    if (this.capBlock(p, lot.card)) return 'cap';
    const need = lot.leader === null ? BASE_PRICE[lot.card.tier] : lot.price + 1;
    if (pl.purse < need) return 'cant-afford';
    return null;
  }

  /** Can `p` do anything except pass on this lot? */
  canRespond(p: PlayerIdx): boolean {
    return this.bidBlock(p, this.nextPrice('bid1', p)) === null || this.allInBlock(p) === null;
  }

  /** How long ago the last SOLD/UNSOLD happened if it can still be undone, else null. */
  undoAge(): number | null {
    if (!this.undoSnap) return null;
    const age = this.state.clock - this.undoSnap.at;
    return age <= TIMING.undo ? age : null;
  }

  // ---- actions -------------------------------------------------------------

  dispatch(a: Action): AuctionEvent[] {
    const ev: AuctionEvent[] = [];
    if (a.type === 'tick') { this.tick(a.ms, ev); return ev; }
    if (a.type === 'undo') { this.undo(ev); return ev; }
    if (this.state.phase !== 'lot' || !this.state.lot) return ev;
    const before = this.snapshot();
    const resolvedBefore = this.state.history.length;
    switch (a.type) {
      case 'bid1': case 'bid5': case 'take': this.bid(a.p, a.type === 'take' ? 'bid1' : a.type, a.type === 'take', a.seen, ev); break;
      case 'pass': case 'leave': this.pass(a.p, a.type === 'leave', ev); break;
      case 'allIn': this.allIn(a.p, ev); break;
    }
    if (this.state.history.length > resolvedBefore) this.undoSnap = { at: this.state.clock, snap: before };
    return ev;
  }

  private reject(p: PlayerIdx, action: PlayerAction, reason: Reject, ev: AuctionEvent[]): void {
    ev.push({ type: 'reject', p, action, reason });
  }

  private bid(p: PlayerIdx, kind: 'bid1' | 'bid5', take: boolean, seen: number | undefined, ev: AuctionEvent[]): void {
    const lot = this.state.lot!;
    const action: PlayerAction = take ? 'take' : kind;
    if (take && lot.solo === null) { this.reject(p, action, 'not-solo', ev); return; }
    if (lot.solo !== null && kind === 'bid5') { this.reject(p, action, 'solo-only', ev); return; }
    const price = this.nextPrice(kind, p);
    const block = this.bidBlock(p, price);
    if (block) {
      // A bid that was valid on screen but lost a same-frame race is "too late", not "illegal".
      const raced = seen !== undefined && seen !== lot.bids.length;
      this.reject(p, action, raced ? 'too-late' : block, ev);
      return;
    }
    if (lot.allIn !== null && lot.allIn !== p) {
      this.closeAllIn(lot.allIn, false, p);
      ev.push({ type: 'allInFailed', p: lot.allIn, by: p });
    }
    const jump = lot.leader !== null ? kind === 'bid5' : price > BASE_PRICE[lot.card.tier];
    lot.price = price;
    lot.leader = p;
    lot.allIn = null;
    lot.bids.push({ p, price });
    ev.push({ type: 'bid', p, price, jump, count: lot.bids.length, war: lot.bids.length === WAR_BIDS });
    this.afterBid(p, ev);
  }

  private allIn(p: PlayerIdx, ev: AuctionEvent[]): void {
    const lot = this.state.lot!;
    const block = this.allInBlock(p);
    if (block) { this.reject(p, 'allIn', block, ev); return; }
    const pl = this.state.players[p];
    pl.allInUsed = true;
    if (lot.allIn !== null && lot.allIn !== p) {
      this.closeAllIn(lot.allIn, false, p);
      ev.push({ type: 'allInFailed', p: lot.allIn, by: p });
    }
    const amount = pl.purse;
    lot.price = amount;
    lot.leader = p;
    lot.allIn = p;
    lot.bids.push({ p, price: amount, allIn: true });
    this.state.allIns.push({ p, card: lot.card, amount, worked: null });
    ev.push({ type: 'allIn', p, amount });
    ev.push({ type: 'bid', p, price: amount, jump: true, count: lot.bids.length, war: lot.bids.length === WAR_BIDS });
    this.afterBid(p, ev);
  }

  private afterBid(p: PlayerIdx, ev: AuctionEvent[]): void {
    const lot = this.state.lot!;
    const o = other(p);
    if (lot.solo !== null || lot.out[o]) { this.sell(p, ev); return; }
    lot.timer = TIMING.countdown;
    lot.stage = 0;
    // The trailer can only pass: skip straight to "going once".
    if (!this.canRespond(o)) lot.timer = TIMING.goingOnce;
  }

  private pass(p: PlayerIdx, leave: boolean, ev: AuctionEvent[]): void {
    const lot = this.state.lot!;
    const action: PlayerAction = leave ? 'leave' : 'pass';
    if (this.state.players[p].locked) { this.reject(p, action, 'locked', ev); return; }
    if (lot.solo !== null) {
      if (lot.solo !== p) { this.reject(p, action, 'passed', ev); return; }
      ev.push({ type: 'pass', p });
      this.leaveLot(ev);
      return;
    }
    if (lot.leader === p) { this.reject(p, action, 'leader-pass', ev); return; }
    if (lot.out[p]) { this.reject(p, action, 'passed', ev); return; }
    lot.out[p] = true;
    ev.push({ type: 'pass', p });
    if (lot.leader !== null) this.sell(lot.leader, ev);
    else if (lot.out[other(p)]) this.leaveLot(ev);
  }

  private tick(ms: number, ev: AuctionEvent[]): void {
    const st = this.state;
    st.clock += ms;
    if (st.phase === 'resolved') {
      st.resolveTimer -= ms;
      if (st.resolveTimer <= 0) this.nextLot(ev);
      return;
    }
    const lot = st.lot;
    if (st.phase !== 'lot' || !lot) return;
    lot.timer -= ms;
    if (lot.stage < 1 && lot.timer <= TIMING.goingOnce && lot.leader !== null) { lot.stage = 1; ev.push({ type: 'goingOnce' }); }
    if (lot.stage < 2 && lot.timer <= TIMING.goingTwice && lot.leader !== null) { lot.stage = 2; ev.push({ type: 'goingTwice' }); }
    if (lot.timer > 0) return;
    const before = this.snapshot();
    if (lot.leader !== null) this.sell(lot.leader, ev);
    else this.leaveLot(ev);
    this.undoSnap = { at: st.clock, snap: before };
  }

  private undo(ev: AuctionEvent[]): void {
    if (this.undoAge() === null) return;
    const snap = this.undoSnap!.snap;
    snap.clock = this.state.clock;
    const lot = snap.lot!;
    // Give everyone a fresh, fair countdown on the restored lot.
    lot.timer = lot.leader === null && lot.solo === null ? TIMING.opening : TIMING.countdown;
    lot.stage = 0;
    this.state = snap;
    this.undoSnap = null;
    ev.push({ type: 'undone' });
    ev.push({ type: 'lot', lot });
  }

  private snapshot(): AuctionState { return clone(this.state); }

  // ---- resolution ----------------------------------------------------------

  private closeAllIn(p: PlayerIdx, worked: boolean, by?: PlayerIdx): void {
    for (let i = this.state.allIns.length - 1; i >= 0; i--) {
      const r = this.state.allIns[i];
      if (r.p === p && r.worked === null) { r.worked = worked; r.by = by; return; }
    }
  }

  private sell(p: PlayerIdx, ev: AuctionEvent[]): void {
    const st = this.state, lot = st.lot!, pl = st.players[p];
    const viaAllIn = lot.allIn === p;
    const price = lot.price;
    pl.purse -= price;
    pl.squad.push({ card: lot.card, price, lot: lot.n, how: viaAllIn ? 'allIn' : 'bid' });
    const base = BASE_PRICE[lot.card.tier];
    const steal = !viaAllIn && price === base && (lot.card.tier === 'S' || lot.card.tier === 'A');
    ev.push({ type: 'sold', p, price, card: lot.card, allIn: viaAllIn, steal, bids: lot.bids.length });
    if (viaAllIn) {
      pl.purse = 0;
      pl.locked = true;
      this.closeAllIn(p, true);
      ev.push({ type: 'locked', p });
    }
    this.record(lot, p, price, viaAllIn ? 'allIn' : 'bid');
  }

  /** Nobody bought it: a locked player with room takes it free, otherwise Unsold. */
  private leaveLot(ev: AuctionEvent[]): void {
    const st = this.state, lot = st.lot!;
    const taker = ([0, 1] as PlayerIdx[]).find((q) => st.players[q].locked && !this.capBlock(q, lot.card));
    if (taker !== undefined) {
      st.players[taker].squad.push({ card: lot.card, price: 0, lot: lot.n, how: 'free' });
      ev.push({ type: 'free', p: taker, card: lot.card });
      this.record(lot, taker, 0, 'free');
    } else {
      st.unsold.push(lot.card);
      ev.push({ type: 'unsold', card: lot.card });
      this.record(lot, null, 0, 'unsold');
    }
  }

  private record(lot: Lot, winner: PlayerIdx | null, price: number, how: LotRecord['how']): void {
    const st = this.state;
    st.history.push({ n: lot.n, card: lot.card, round: lot.round, bids: lot.bids, winner, price, how });
    st.phase = 'resolved';
    st.resolveTimer = TIMING.sold;
  }

  private nextLot(ev: AuctionEvent[]): void {
    const st = this.state;
    st.lot = null;
    if (this.full(0) && this.full(1)) { this.finish(ev); return; }
    if (!st.queue.length) {
      if (st.round === 'main' && st.unsold.length) {
        st.round = 'unsold';
        st.queue = new Rng((st.seed ^ 0x5bd1e995) >>> 0).shuffle([...st.unsold]);
        st.unsold = [];
        ev.push({ type: 'unsoldRound', count: st.queue.length });
      } else { this.finish(ev); return; }
    }
    const card = st.queue.shift()!;
    st.lotCount++;
    const lot: Lot = {
      n: st.lotCount, card, round: st.round, price: BASE_PRICE[card.tier], leader: null, out: [false, false],
      bids: [], timer: TIMING.opening, stage: 0, allIn: null, solo: null,
    };
    st.lot = lot;
    st.phase = 'lot';
    // Players who cannot act on this lot at all sit it out from the start.
    const can = ([0, 1] as PlayerIdx[]).map((q) => this.bidBlock(q, BASE_PRICE[card.tier]) === null || this.allInBlock(q) === null);
    lot.out = [!can[0], !can[1]];
    if (can[0] !== can[1]) { lot.solo = can[0] ? 0 : 1; lot.timer = TIMING.countdown; }
    ev.push({ type: 'lot', lot });
    // Nobody can act: it resolves straight away (free to a locked player, or Unsold) and shows for the usual beat.
    if (!can[0] && !can[1]) this.leaveLot(ev);
  }

  private finish(ev: AuctionEvent[]): void {
    const st = this.state;
    const fills: { p: PlayerIdx; card: Card; reserve: boolean }[] = [];
    // Lowest-rated leftovers first, then generic reserves. Alternate so neither side gets first pick of the scraps.
    const leftovers = [...st.unsold, ...st.queue].sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
    while (!this.full(0) || !this.full(1)) {
      for (const p of [0, 1] as PlayerIdx[]) {
        if (this.full(p)) continue;
        const i = leftovers.findIndex((c) => !this.capBlock(p, c));
        const card = i >= 0 ? leftovers.splice(i, 1)[0] : reserveCard(st.settings.pack, ++st.reserves);
        st.players[p].squad.push({ card, price: 0, lot: 0, how: 'reserve' });
        fills.push({ p, card, reserve: i < 0 });
      }
    }
    st.unsold = leftovers;
    st.queue = [];
    st.lot = null;
    st.phase = 'done';
    if (fills.length) ev.push({ type: 'reserves', fills });
    ev.push({ type: 'end' });
  }
}
