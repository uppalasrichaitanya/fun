/*
 * Bid War tuning.
 *
 * Bot simulator results (scripts/simulate-bid-war.ts, 1,000 auctions per
 * configuration, Normal purse). Targets: price/base 1.2-1.5, unsold < 15%,
 * each bot style wins 40-60%, zero auctions without two full squads.
 *
 *   SIM_RESULTS_START
 *   (1000 auctions each; *unsold% counts first offers, see the script)
 *   config              price/base  unsold%* stars win%  balanced%  all-ins  broken
 *   cricket ipl 6       1.23        7.8      47.5        52.5       2/4      0
 *   cricket general 6   1.23        0.8      45.8        54.2       2/3      0
 *   cricket ipl 12      1.22        7.1      43.9        56.1       0/0      0
 *   cricket general 12  1.22        0.0      43.5        56.5       0/0      0
 *   pokemon 3           1.24        9.8      49.8        50.2       29/29    0
 *   pokemon 4           1.26        5.1      52.6        47.4       4/4      0
 *   pokemon 6           1.27        6.7      51.8        48.2       0/0      0
 *   heroes 3            1.24        10.3     51.8        48.2       25/25    0
 *   heroes 4            1.26        5.0      53.1        46.9       5/5      0
 *   heroes 6            1.25        6.5      52.5        47.5       1/1      0
 *   heroes marvel 6     1.26        6.4      51.1        48.9       1/1      0
 *   SIM_RESULTS_END
 *
 * Purses and tier mixes are the spec's numbers; they hit every target as is.
 * What did change: cricket ratings are spread per tier (S 88-97, A 75-86,
 * B 60-74, C 44-58). With the first, compressed ratings an S-tier was barely
 * better than an A, and stars-and-scrubs lost about 70% of cricket matches.
 */
import type { MusicSpec } from '../../engine/audio';
import type { PurseFeel, SquadSize, Tier } from './types';

export const TIERS: Tier[] = ['S', 'A', 'B', 'C'];
export const BASE_PRICE: Record<Tier, number> = { S: 8, A: 5, B: 3, C: 1 };

export interface SquadTuning {
  pool: number;
  mix: Record<Tier, number>;
  /** Normal-feel purse per player. */
  purse: number;
}

/** Both purses together come to about 1.3x the base total of the pool. */
export const SQUADS: Record<SquadSize, SquadTuning> = {
  3: { pool: 8, mix: { S: 2, A: 2, B: 2, C: 2 }, purse: 20 },
  4: { pool: 10, mix: { S: 2, A: 3, B: 3, C: 2 }, purse: 28 },
  6: { pool: 15, mix: { S: 3, A: 4, B: 5, C: 3 }, purse: 42 },
  12: { pool: 30, mix: { S: 5, A: 8, B: 10, C: 7 }, purse: 78 },
};

export const PURSE_FEEL: Record<PurseFeel, { mult: number; label: string }> = {
  tight: { mult: 0.85, label: 'Tight' },
  normal: { mult: 1, label: 'Normal' },
  loose: { mult: 1.2, label: 'Loose' },
};

export const pursesFor = (size: SquadSize, feel: PurseFeel): number => Math.round(SQUADS[size].purse * PURSE_FEEL[feel].mult);

/** All-in needs at least this many empty slots. */
export const allInMinSlots = (size: SquadSize): number => Math.max(2, Math.ceil(size / 2));

export const OVERSEAS_CAP: Partial<Record<SquadSize, number>> = { 6: 2, 12: 4 };

/** Cricket role minimums (scored, not enforced). */
export const ROLE_MIN: Partial<Record<SquadSize, { wk: number; bat: number; bowl: number }>> = {
  6: { wk: 1, bat: 3, bowl: 2 },
  12: { wk: 1, bat: 5, bowl: 5 },
};

export const TIMING = {
  opening: 10_000,     // no bids yet
  countdown: 8_000,    // reset by every valid bid
  goingOnce: 5_000,
  goingTwice: 2_500,
  sold: 1_200,         // celebration before the next lot
  undo: 3_000,         // one-step undo window after SOLD / UNSOLD
  allInHold: 1_000,
} as const;

/** 4+ bids on one lot. */
export const WAR_BIDS = 4;

export const NAME_MAX = 12;
/** Rules card becomes skippable once a name has played this many matches. */
export const SKIP_RULES_AFTER = 3;
export const HISTORY_MAX = 30;

export const MUSIC: MusicSpec = {
  bpm: 100, root: 45, wave: 'triangle', bass: true, kick: true, gain: 0.7,
  chords: [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 2, 5]],
  arp: [0, 2, 1, 2, 0, 2, 1, 3],
};
/** Bidding-war layer: hats and a busier arp. */
export const MUSIC_WAR: MusicSpec = { ...MUSIC, hats: true, gain: 0.85, arp: [0, 1, 2, 3, 2, 3, 4, 3] };
/** Muffled reveal loop. */
export const MUSIC_REVEAL: MusicSpec = { ...MUSIC, kick: false, pad: true, gain: 0.5, wave: 'sine', arp: [0, 2, 1, 2] };
