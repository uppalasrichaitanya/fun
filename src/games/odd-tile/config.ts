import type { MusicSpec } from '../../engine/audio';

export const CFG = {
  duration: 60,
  penalty: 3,
  maxGrid: 560,
  gap: 6,
  radius: 0.18,
  minTile: 32,
  fastFind: 1.5,
  lowTime: 10,
  swapAt: 0.11,      // s after a correct tap the next grid appears (and is tappable)
  popIn: 0.11,
  stagger: 0.015,
} as const;

/** Rounds -> grid size. */
export function gridFor(round: number): number {
  if (round <= 1) return 2;
  if (round <= 3) return 3;
  if (round <= 6) return 4;
  if (round <= 10) return 5;
  if (round <= 15) return 6;
  if (round <= 21) return 7;
  if (round <= 28) return 8;
  return 9;
}

export const RANKS: [number, string][] = [[32, 'Mantis shrimp'], [25, 'Hawk'], [18, 'Cat'], [10, 'Human'], [0, 'Sleepy mole']];
export const rankFor = (rounds: number): string => RANKS.find(([m]) => rounds >= m)![1];

export const MUSIC: MusicSpec = {
  bpm: 104, root: 62, wave: 'triangle', bass: true, hats: true, gain: 0.7,
  chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
  arp: [0, 1, 2, 3, 2, 1, 2, 3],
};
