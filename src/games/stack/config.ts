import type { MusicSpec } from '../../engine/audio';

export const CFG = {
  base: 200,           // base slab top face, u
  height: 30,          // slab thickness, u
  speed0: 180,         // u/s
  speedGrow: 1.02,     // per floor
  speedMax: 420,
  breatherEvery: 15,   // every N floors...
  breatherLen: 3,      // ...for this many floors...
  breatherMul: 0.85,   // ...speed drops 15%
  swing: 1.3,          // ping-pong range, x slab size
  perfectAbs: 4,       // u
  perfectRel: 0.03,    // of slab size
  growAfter: 5,        // consecutive perfects before slabs grow back
  grow: 6,             // u per axis
  gravity: 1800,       // falling pieces
  pieceLife: 1.5,
  topFrac: 0.4,        // tower top sits at 40% from the top of the screen
  camTween: 0.25,
  overZoomDelay: 0.4,
  overZoomDur: 0.9,
  maxPieces: 16,
} as const;

export const MUSIC: MusicSpec = {
  bpm: 76, root: 57, wave: 'sine', pad: true, bass: true, gain: 0.9,
  chords: [[0, 4, 7, 11], [-3, 0, 4, 7], [5, 9, 12, 16], [2, 5, 9, 12]],
  arp: [0, 2, 1, 3, 2, 4, 3, 1],
};
