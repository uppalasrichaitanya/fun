import type { MusicSpec } from '../../engine/audio';

export const CFG = {
  resample: 128,
  roundnessK: 4.5,       // score = 100 * (1 - clamp(K * E + ...))
  closureK: 0.3,
  closureFree: 0.1,
  minRadius: 60,         // CSS px
  minSweep: 330,         // degrees
  tooClose: 0.4,         // of mean radius
  reverseLimit: 30,      // degrees of backwards sweep
  maxTime: 8,            // seconds
  maxPoints: 6000,
  countUp: 0.6,
  worstFrac: 0.1,
} as const;

export const RANKS: [number, string][] = [
  [98, 'Are you a robot?'],
  [95, 'Machine'],
  [90, 'Compass grade'],
  [80, 'Solid wheel'],
  [70, 'Decent donut'],
  [50, 'Potato'],
  [-1, 'Egg'],
];
export const rankFor = (score: number): string => RANKS.find(([min]) => score >= min)![1];

export const MUSIC: MusicSpec = {
  bpm: 84, root: 60, wave: 'sine', pad: true, gain: 0.6,
  chords: [[0, 4, 7, 14], [5, 9, 12, 16], [-3, 0, 4, 7], [7, 11, 14, 17]],
  arp: [0, 2, 4, 2, 1, 3, 4, 3],
};
