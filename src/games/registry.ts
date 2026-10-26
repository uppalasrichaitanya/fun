import type { CanvasMode } from '../engine/canvas';
import type { GameFactory } from '../engine/types';

export type Group = 'Addictive' | 'Quick challenges' | 'Chill' | 'Play together';
export type ControlIcon = 'mouse' | 'tap' | 'keys' | '2p';

export interface GameMeta {
  id: string;
  title: string;
  tagline: string;
  /** Signature colour (CSS value); `glow` is used for card hover. */
  color: string;
  gradient?: string;
  group: Group;
  controls: ControlIcon[];
  /** Noun for the score, e.g. "floors". */
  unit: string;
  canvas: CanvasMode;
  logical?: { w: number; h: number };
  hud: 'left' | 'center' | 'none';
  format: (score: number) => string;
  /** Missing loader = not built yet (shown as "coming soon"). */
  load?: () => Promise<{ default: GameFactory }>;
}

const int = (n: number) => String(Math.round(n));

export const GAMES: GameMeta[] = [
  {
    id: 'cursor-panic', title: 'Cursor Panic', tagline: "You are the cursor. Don't get touched.",
    color: '#FFD93D', group: 'Addictive', controls: ['mouse', 'tap'], unit: 'points',
    canvas: 'fit', logical: { w: 800, h: 600 }, hud: 'none', format: int,
    load: () => import('./cursor-panic'),
  },
  {
    id: 'merge-drop', title: 'Merge Drop', tagline: "Drop. Match. Merge. Don't overflow.",
    color: '#FF4F8B', group: 'Addictive', controls: ['mouse', 'tap'], unit: 'points',
    canvas: 'fit', hud: 'left', format: int,
  },
  {
    id: 'tiny-survivors', title: 'Tiny Survivors', tagline: 'Just move. Your weapons do the rest. Survive 3 minutes.',
    color: '#9B7BFF', group: 'Addictive', controls: ['keys', 'tap'], unit: 'points',
    canvas: 'fit', hud: 'left', format: int,
  },
  {
    id: 'grapple-swing', title: 'Grapple Swing', tagline: 'Hold to grab. Let go to fly.',
    color: '#38E1F5', group: 'Addictive', controls: ['tap'], unit: 'm',
    canvas: 'fit', hud: 'left', format: int,
  },
  {
    id: 'circle', title: 'Draw a Perfect Circle', tagline: 'One stroke. Around the dot. How perfect can you get?',
    color: '#4ADE80', group: 'Quick challenges', controls: ['mouse', 'tap'], unit: '%',
    canvas: 'fill', hud: 'none', format: (n) => n.toFixed(1) + '%',
    load: () => import('./circle'),
  },
  {
    id: 'odd-tile', title: 'Odd Tile Out', tagline: 'One tile is different. Find it. Fast.',
    color: '#FF9F43', gradient: 'linear-gradient(135deg,#FF4F8B,#FFD93D,#4ADE80,#38E1F5,#9B7BFF)',
    group: 'Quick challenges', controls: ['tap', 'keys'], unit: 'rounds',
    canvas: 'fill', hud: 'left', format: int,
    load: () => import('./odd-tile'),
  },
  {
    id: 'rocket-lander', title: 'Rocket Lander', tagline: 'Gentle. Gentler. Touchdown.',
    color: '#FF9F43', group: 'Quick challenges', controls: ['keys', 'tap'], unit: 'stars',
    canvas: 'fit', hud: 'left', format: int,
  },
  {
    id: 'stack', title: 'Stack', tagline: 'Tap to drop. Stay perfect.',
    color: '#FF4F8B', gradient: 'linear-gradient(135deg,#FF4F8B,#FF9F43,#FFD93D)',
    group: 'Chill', controls: ['tap'], unit: 'floors',
    canvas: 'fill', hud: 'center', format: int,
    load: () => import('./stack'),
  },
  {
    id: 'untangle', title: 'Untangle', tagline: 'Drag the dots until no lines cross.',
    color: '#38E1F5', group: 'Chill', controls: ['mouse', 'tap'], unit: 'level',
    canvas: 'fill', hud: 'left', format: int,
  },
  {
    id: 'sumo-blobs', title: 'Sumo Blobs', tagline: 'Bump your friend off the platform. First to 3.',
    color: '#FF4F8B', gradient: 'linear-gradient(90deg,#FF4F8B,#38E1F5)',
    group: 'Play together', controls: ['2p', 'keys'], unit: 'rounds',
    canvas: 'fit', hud: 'none', format: int,
  },
];

export const GROUPS: Group[] = ['Addictive', 'Quick challenges', 'Chill', 'Play together'];
export const findGame = (id: string): GameMeta | undefined => GAMES.find((g) => g.id === id);
