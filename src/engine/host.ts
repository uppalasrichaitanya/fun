import { AudioBus } from './audio';
import { Camera, TimeCtl } from './camera';
import { GameCanvas, type CanvasMode } from './canvas';
import { Floaters } from './floaters';
import { Input } from './input';
import { Loop } from './loop';
import { Particles } from './particles';
import { Rng } from './rng';
import { settings } from './settings';
import { storage } from './storage';
import type { Game, GameContext, ShellHooks } from './types';

export interface HostOpts {
  mode: CanvasMode;
  logical?: { w: number; h: number };
  preview: boolean;
  hooks: ShellHooks;
  maxDpr?: number;
}

/** Owns one running game: canvas, input, audio bus, fx and the fixed-step loop. */
export class GameHost {
  readonly canvas: GameCanvas;
  readonly input: Input;
  readonly audio: AudioBus;
  readonly ctx: GameContext;
  readonly loop: Loop;
  /** When true the simulation is frozen but frames still render. */
  paused = false;
  readonly debug = { enabled: false };

  constructor(container: HTMLElement, readonly game: Game, opts: HostOpts) {
    this.canvas = new GameCanvas(container, opts.mode, opts.maxDpr ?? 2, opts.logical);
    this.input = new Input(this.canvas, !opts.preview);
    this.audio = new AudioBus(!opts.preview);
    const camera = new Camera(), time = new TimeCtl();
    const particles = new Particles(new Rng()), floaters = new Floaters();
    this.ctx = {
      canvas: this.canvas, input: this.input, audio: this.audio, storage, settings,
      fx: { camera, time, particles, floaters }, shell: opts.hooks, debug: this.debug, preview: opts.preview,
    };
    this.loop = new Loop(
      (dt) => { this.game.update(dt); particles.update(dt); floaters.update(dt); },
      (alpha) => this.game.render(alpha),
      (realDt) => time.scale(realDt),
      (realDt) => { if (!this.paused) camera.update(realDt); },
    );
    game.init(this.ctx);
  }

  frame(now: number): boolean { return this.loop.advance(now, !this.paused); }

  /** Clear transient fx between runs. */
  resetFx(): void {
    const fx = this.ctx.fx;
    fx.particles.clear(); fx.floaters.clear(); fx.camera.reset(); fx.time.reset();
  }

  destroy(): void {
    this.game.destroy();
    this.input.destroy();
    this.canvas.destroy();
  }
}
