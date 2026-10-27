import type { CanvasMode } from '../engine/canvas';
import { storage } from '../engine/storage';
import type { GameFactory } from '../engine/types';

export type Group = 'Addictive' | 'Quick challenges' | 'Chill' | 'Brain Lab' | 'Play together';
export type ControlIcon = 'mouse' | 'tap' | 'keys' | '2p';
export type Tab = 'arcade' | 'brain' | 'together';

/** A game that runs its own screens instead of the arcade shell (Bid War). */
export interface App { destroy(): void }
export type AppFactory = (parent: HTMLElement) => App;

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
  /** Self-contained app (own setup/results screens). Mutually exclusive with `load`. */
  app?: () => Promise<{ default: AppFactory }>;
  /** Attract-mode renderer for the hub card when the game itself is an app. */
  preview?: () => Promise<{ default: GameFactory }>;
  /** Brain Lab: total stars available (3 per level). */
  stars?: number;
  /** Custom hub chip, e.g. "12 auctions". */
  chip?: () => string | null;
  /** Start-screen choices (modes or levels). The chosen id reaches the game as `StartOpts.mode`. */
  picker?: () => PickItem[];
}

export interface PickItem { id: string; label: string; sub?: string; locked?: boolean }

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
    color: '#FF4F8B', group: 'Addictive', controls: ['mouse', 'tap', 'keys'], unit: 'points',
    canvas: 'fit', logical: { w: 400, h: 640 }, hud: 'left', format: int,
    load: () => import('./merge-drop'),
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
    color: '#FF9F43', group: 'Quick challenges', controls: ['keys', 'tap'], unit: 'points',
    canvas: 'fill', hud: 'none', format: int,
    load: () => import('./rocket-lander'),
    picker: () => {
      const unlocked = storage.get<number>('rocket-lander:unlocked', 1);
      const stars = storage.get<Record<string, number>>('rocket-lander:stars', {});
      return Array.from({ length: 15 }, (_, i) => ({
        id: String(i + 1), label: String(i + 1), locked: i + 1 > unlocked,
        sub: stars[i + 1] ? '★'.repeat(stars[i + 1]) : undefined,
      }));
    },
    chip: () => {
      const n = Object.values(storage.get<Record<string, number>>('rocket-lander:stars', {})).reduce((a, b) => a + b, 0);
      return n ? `${n} / 45 stars` : null;
    },
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
    canvas: 'fill', hud: 'none', format: int,
    load: () => import('./untangle'),
    picker: () => {
      const unlocked = storage.get<number>('untangle:unlocked', 1);
      const items: PickItem[] = Array.from({ length: 15 }, (_, i) => ({ id: String(i + 1), label: String(i + 1), locked: i + 1 > unlocked }));
      items.push({ id: 'endless', label: '16+', sub: 'endless', locked: unlocked < 16 });
      return items;
    },
    chip: () => {
      const n = storage.get<number>('untangle:unlocked', 1) - 1;
      return n > 0 ? `Level ${n}` : null;
    },
  },
  // ---- Brain Lab (batches 5-7) ----
  brain('light-bender', 'Light Bender', 'Bend the beam. Light every crystal.', '#38E1F5', ['mouse', 'tap', 'keys'], 120),
  brain('maze-maker', 'Maze Maker', "Don't block the monster. Just make its walk very, very long.", '#9B7BFF', ['mouse', 'tap'], 120),
  brain('wire-it', 'Wire It', 'Wire the gates. Light the right bulbs.', '#4ADE80', ['mouse', 'tap'], 90),
  brain('gravity-golf', 'Gravity Golf', 'Place your planets. One shot. Hole in one.', '#9B7BFF', ['mouse', 'tap'], 120),
  brain('switchyard', 'Switchyard', 'Flip the switches. Every train home.', '#4ADE80', ['tap', 'keys'], 108),
  brain('heist-15', 'Heist 15', "15 seconds. One gem. Don't get seen.", '#FFD93D', ['keys', 'tap'], 108),
  brain('firebreak', 'Firebreak', 'Read the wind. Save the village.', '#FF9F43', ['mouse', 'tap'], 90),
  brain('bridge-it', 'Bridge It', 'Build it cheap. Hope it holds.', '#FF9F43', ['mouse', 'tap'], 90),
  brain('rocket-builder', 'Rocket Builder', 'Build a rocket. Reach the Moon. Fail gloriously.', '#FF9F43', ['mouse', 'keys'], 45),
  brain('micro-escape', 'Micro Escape', 'One room. One trick. Get out.', '#FF9F43', ['mouse', 'tap'], 9),
  // ---- Play together ----
  {
    id: 'bid-war', title: 'Bid War', tagline: 'Two players. One purse each. Every legend goes to the highest bidder.',
    color: '#FFD93D', gradient: 'linear-gradient(90deg,#FF4F8B,#FFD93D,#38E1F5)',
    group: 'Play together', controls: ['2p', 'keys', 'tap'], unit: 'auctions',
    canvas: 'fit', logical: { w: 640, h: 400 }, hud: 'none', format: int,
    app: () => import('./bid-war/app'),
    preview: () => import('./bid-war/preview'),
    chip: () => {
      const n = storage.get<unknown[]>('bid-war:history', []).length;
      return n ? `${n} auction${n === 1 ? '' : 's'}` : null;
    },
  },
  {
    id: 'sumo-blobs', title: 'Sumo Blobs', tagline: 'Bump your friend off the platform. First to 3.',
    color: '#FF4F8B', gradient: 'linear-gradient(90deg,#FF4F8B,#38E1F5)',
    group: 'Play together', controls: ['2p', 'keys'], unit: 'rounds',
    canvas: 'fit', hud: 'none', format: int,
  },
];

function brain(id: string, title: string, tagline: string, color: string, controls: ControlIcon[], stars: number): GameMeta {
  return { id, title, tagline, color, group: 'Brain Lab', controls, unit: 'stars', canvas: 'fit', hud: 'none', format: int, stars };
}

/** Stars earned in a Brain Lab game: best stars per level, saved under `<id>:stars`. */
export function starsEarned(id: string): number {
  const levels = storage.get<Record<string, number>>(`${id}:stars`, {});
  return Object.values(levels).reduce((a, b) => a + (b || 0), 0);
}

export const TABS: { id: Tab; label: string; groups: Group[]; sub: string }[] = [
  { id: 'arcade', label: 'Arcade', groups: ['Addictive', 'Quick challenges', 'Chill'], sub: 'Ten tiny games. One more try.' },
  { id: 'brain', label: 'Brain Lab', groups: ['Brain Lab'], sub: 'Build it, run it, solve it. Never by luck.' },
  { id: 'together', label: 'Play Together', groups: ['Play together'], sub: 'Two players, one screen. Trash talk encouraged.' },
];
export const GROUPS: Group[] = TABS.flatMap((t) => t.groups);
export const playable = (g: GameMeta): boolean => !!(g.load || g.app);
export const findGame = (id: string): GameMeta | undefined => GAMES.find((g) => g.id === id);
