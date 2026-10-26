import type { MusicSpec } from '../../engine/audio';
import { C } from '../../engine/theme';

export const CFG = {
  landscape: { w: 800, h: 600 },
  portrait: { w: 450, h: 800 },
  hitR: 4,              // generous on purpose
  visR: 9,
  grazeR: 18,
  grazeNeed: 30,
  phaseDur: 2,
  startR: 30,
  touchOffset: 70,      // CSS px above the finger
  safeSpawn: 120,       // nothing appears this close without a telegraph
  deathFreeze: 400,     // ms
} as const;

export const enum Kind { Volley, Spiral, Sweep, Grid, Walls, Bouncers, Mines, Rain }
export const KIND_NAME = ['Aimed volley', 'Spiral', 'Laser sweep', 'Laser grid', 'Closing walls', 'Bouncers', 'Homing mines', 'Rain'];
export const KIND_COLOR = [C.pink, C.violet, C.pink, C.pink, C.orange, C.yellow, C.orange, C.cyan];

export const MUSIC: MusicSpec = {
  bpm: 112, root: 50, wave: 'sawtooth', bass: true, kick: true, hats: true, gain: 0.55,
  chords: [[0, 3, 7, 10], [0, 3, 7, 10], [-4, 0, 3, 7], [-2, 2, 5, 9]],
  arp: [0, 2, 4, 2, 1, 3, 5, 3],
};
