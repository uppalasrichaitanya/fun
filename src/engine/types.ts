import type { AudioBus } from './audio';
import type { Camera, TimeCtl } from './camera';
import type { GameCanvas } from './canvas';
import type { Floaters } from './floaters';
import type { Input } from './input';
import type { Particles } from './particles';
import type { storage } from './storage';
import type { settings } from './settings';

export interface Stat { label: string; value: string }

export interface GameResult {
  score: number;
  /** Optional rank/title line, e.g. "Mantis shrimp". */
  rank?: string;
  /** Run stats shown on the game-over panel (2-3). */
  stats: Stat[];
  /** Headline above the score, defaults to "Game over". */
  title?: string;
  /** Overrides the default share text. */
  share?: string;
  /** Adds a focused "Next" button that starts the given mode (e.g. the next level). */
  next?: { label: string; mode: string };
  /** Hide the score/best block (puzzle results that are not a score). */
  noScore?: boolean;
  /** How this result reads in the daily share line (default: the formatted score). */
  dailyLabel?: string;
  /** Brain Lab: stars earned with their three goals (met or not). */
  stars?: { earned: number; goals: readonly string[]; met: readonly boolean[]; improved?: boolean };
}

export interface ShellHooks {
  /** End the run. The panel slides up after `delayMs` (default 650) so the death animation lands. */
  gameOver(result: GameResult, delayMs?: number): void;
  /** Update the HUD score (pops on change). */
  setScore(score: number): void;
  /** Save a score without ending the run (Draw a Perfect Circle). */
  recordScore(score: number): { best: number; isNewBest: boolean };
  best(): number;
  /** Show or hide a share pill in the HUD (for games without a game-over panel). */
  setShare(text: string | null): void;
}

export interface GameContext {
  canvas: GameCanvas;
  input: Input;
  audio: AudioBus;
  storage: typeof storage;
  settings: typeof settings;
  fx: { camera: Camera; time: TimeCtl; particles: Particles; floaters: Floaters };
  shell: ShellHooks;
  debug: { enabled: boolean };
  /** True for hub previews: no input, no audio, never ends. */
  preview: boolean;
}

export interface StartOpts {
  /** Run the attract-mode autopilot (start screen, hub card). */
  demo?: boolean;
  /** Game-specific mode chosen on the start screen. */
  mode?: string;
}

export interface Game {
  init(ctx: GameContext): void;
  start(seed: number, opts?: StartOpts): void;
  update(dt: number): void;
  render(alpha: number): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  /** Counts for the F3 debug overlay. */
  debugInfo?(): Record<string, number | string>;
  /** Return true to keep a key the shell would otherwise use (e.g. Escape = back to build, not pause). */
  captureKey?(code: string): boolean;
}

export type GameFactory = () => Game;
