import type { MusicSpec } from '../../engine/audio';

export const W = 400, H = 640;

export const JAR = {
  l: 20, r: 380,
  rim: 100,          // top of the jar walls
  bottom: 620,
  corner: 24,
} as const;

/** 70 u below the rim. */
export const DANGER_Y = JAR.rim + 70;
export const HOLD_Y = 52;

export interface TierDef { r: number; color: string; pts: number }
export const TIERS: TierDef[] = [
  { r: 14, color: '#FF4F8B', pts: 0 },
  { r: 19, color: '#FF9F43', pts: 3 },
  { r: 25, color: '#FFD93D', pts: 6 },
  { r: 32, color: '#4ADE80', pts: 10 },
  { r: 40, color: '#38E1F5', pts: 15 },
  { r: 49, color: '#9B7BFF', pts: 21 },
  { r: 59, color: '#F472B6', pts: 28 },
  { r: 70, color: '#FB7185', pts: 36 },
  { r: 82, color: '#A3E635', pts: 45 },
  { r: 95, color: '#60A5FA', pts: 55 },
  { r: 110, color: '#FDE68A', pts: 66 },
];
/** Spawn weights for tiers 1-5 (index 0-4). */
export const SPAWN_WEIGHTS = [30, 26, 20, 14, 10];

export const CFG = {
  gravity: 1600,
  substeps: 4,
  iterations: 6,
  friction: 0.3,
  restitution: 0.12,
  damping: 0.996,
  sleepSpeed: 6,
  sleepTime: 0.4,
  aimSpeed: 420,
  cooldown: 0.45,
  settleAge: 1.0,
  dangerWarn: 0.5,
  dangerOver: 2.0,
  chainWindow: 0.8,
  chainMults: [1, 1.5, 2, 3],
  growTime: 0.12,
  mergeKick: 140,
  supernova: 500,
  maxBalls: 220,
  /** Max velocity a position correction may add per substep (u/s). */
  maxPush: 260,
} as const;

export const MUSIC: MusicSpec = {
  bpm: 96, root: 60, wave: 'triangle', bass: true, pad: true, gain: 0.8,
  chords: [[0, 4, 7, 11], [-3, 0, 4, 7], [-7, -3, 0, 4], [-5, -1, 2, 5]],
  arp: [0, 2, 1, 3, 2, 1, 0, 2],
};
