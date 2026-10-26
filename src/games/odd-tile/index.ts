import { pent } from '../../engine/audio';
import { clamp, TAU } from '../../engine/math';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { oklch } from './color';
import { CFG, MUSIC, rankFor } from './config';
import { makeRound, type Round } from './logic';

const MAXT = 81;

class OddTileGame implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private demo = false;
  private round!: Round;
  private next: Round | null = null;
  private roundNo = 1;
  private cleared = 0;
  private timeLeft: number = CFG.duration;
  private roundT = 0;          // time spent on the current grid
  private swapT = -1;          // >= 0 while transitioning to `next`
  private tapIdx = -1;
  private mistakes = 0;
  private fastest = Infinity;
  private combo = 0;
  private over = false;
  private flash = 0;           // timer bar red flash
  private lastSecond = -1;
  // Per-tile animation.
  private popDelay = new Float32Array(MAXT);
  private popT = new Float32Array(MAXT);
  private bounceDelay = new Float32Array(MAXT);
  private bounceT = new Float32Array(MAXT).fill(1);
  private shakeT = new Float32Array(MAXT).fill(1);
  private xMark = new Float32Array(MAXT);
  // Layout.
  private ox = 0; private oy = 0; private size = 0; private tile = 0; private gap: number = CFG.gap;
  // Keyboard focus.
  private focus = 0;
  private kbd = false;
  // Background tint (hue lerps toward round hue).
  private bgHue = 260;
  private demoWait = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => {
      if (this.demo) return;
      this.kbd = false;
      const i = this.hit(p.x, p.y);
      if (i >= 0) this.select(i);
    });
    ctx.input.onKey((code) => {
      if (this.demo || this.over) return;
      const n = this.round.n;
      let fx = this.focus % n, fy = Math.floor(this.focus / n);
      if (code === 'ArrowLeft') fx--; else if (code === 'ArrowRight') fx++;
      else if (code === 'ArrowUp') fy--; else if (code === 'ArrowDown') fy++;
      else if (code === 'Enter' || code === 'Space') { if (this.kbd) this.select(this.focus); this.kbd = true; return; }
      else return;
      if (!this.kbd) { this.kbd = true; return; }
      this.focus = clamp(fy, 0, n - 1) * n + clamp(fx, 0, n - 1);
      this.ctx.audio.tick(2400, 0.03);
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    this.roundNo = 1;
    this.cleared = 0;
    this.timeLeft = CFG.duration;
    this.mistakes = 0; this.fastest = Infinity; this.combo = 0;
    this.over = false; this.flash = 0; this.lastSecond = -1;
    this.swapT = -1; this.next = null;
    this.round = this.make(1);
    this.bgHue = this.round.hue;
    this.enterRound();
    this.demoWait = this.rng.range(0.6, 1.1);
    this.ctx.audio.music(MUSIC);
    this.ctx.audio.musicRate(1);
    if (!this.demo) this.ctx.shell.setScore(0);
  }

  private make(round: number): Round { return makeRound(round, this.rng, this.ctx.settings.data.colorblind); }

  private enterRound(): void {
    const n = this.round.n;
    const c = (n - 1) / 2;
    for (let i = 0; i < n * n; i++) {
      const ring = Math.max(Math.abs((i % n) - c), Math.abs(Math.floor(i / n) - c));
      this.popDelay[i] = Math.floor(ring) * CFG.stagger;
      this.popT[i] = 0;
      this.bounceT[i] = 1; this.shakeT[i] = 1; this.xMark[i] = 0;
    }
    this.roundT = 0;
    this.focus = Math.min(this.focus, n * n - 1);
  }

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const preview = this.ctx.preview;
    const top = preview ? 8 : 104, bottom = preview ? 8 : 28;
    const avail = Math.min(w - (preview ? 16 : 32), h - top - bottom);
    this.size = Math.max(60, Math.min(CFG.maxGrid, avail));
    const n = this.round.n;
    this.gap = preview ? 3 : CFG.gap;
    this.tile = (this.size - this.gap * (n - 1)) / n;
    this.ox = (w - this.size) / 2;
    this.oy = top + (h - top - bottom - this.size) / 2;
  }

  /** Full-tile hit test; taps in the gaps go to the nearest tile. */
  private hit(x: number, y: number): number {
    if (this.over || this.swapT >= 0) return -1;
    const n = this.round.n, half = this.gap / 2;
    if (x < this.ox - half || y < this.oy - half || x > this.ox + this.size + half || y > this.oy + this.size + half) return -1;
    const step = this.tile + this.gap;
    const cx = clamp(Math.floor((x - this.ox + half) / step), 0, n - 1);
    const cy = clamp(Math.floor((y - this.oy + half) / step), 0, n - 1);
    return cy * n + cx;
  }

  private tileCenter(i: number): { x: number; y: number } {
    const n = this.round.n, step = this.tile + this.gap;
    return { x: this.ox + (i % n) * step + this.tile / 2, y: this.oy + Math.floor(i / n) * step + this.tile / 2 };
  }

  private select(i: number): void {
    if (this.over || this.swapT >= 0) return;
    const { audio, fx } = this.ctx;
    const c = this.tileCenter(i);
    if (i === this.round.odd) {
      const t = this.roundT;
      this.fastest = Math.min(this.fastest, t);
      this.combo = t < CFG.fastFind ? this.combo + 1 : 0;
      audio.pluck(pent(Math.min(12, this.combo + 2), 523.25), 0.24);
      if (this.combo >= 2) audio.tone({ f: pent(this.combo + 7, 523.25), type: 'sine', d: 0.2, g: 0.06, at: 0.05 });
      fx.particles.burst(c.x, c.y, this.round.oddColor, { count: 14, speed: 260, size: 5 });
      fx.camera.shake(0.06);
      if (this.combo >= 3) fx.floaters.add(`x${this.combo}`, c.x, c.y - this.tile * 0.4, C.yellow, 22);
      this.cleared++;
      if (!this.demo) this.ctx.shell.setScore(this.cleared);
      // Ripple outward across the old grid from the found tile.
      const n = this.round.n;
      for (let k = 0; k < n * n; k++) {
        const d = Math.hypot((k % n) - (i % n), Math.floor(k / n) - Math.floor(i / n));
        this.bounceDelay[k] = d * 0.018;
        this.bounceT[k] = 0;
      }
      this.tapIdx = i;
      this.swapT = 0;
      this.roundNo++;
      this.next = this.make(this.roundNo);
    } else {
      this.mistakes++;
      this.combo = 0;
      this.timeLeft = Math.max(0, this.timeLeft - CFG.penalty);
      this.shakeT[i] = 0;
      this.xMark[i] = 1;
      this.flash = 1;
      audio.buzz();
      fx.camera.shake(0.18);
      fx.floaters.add(`-${CFG.penalty}s`, c.x, c.y - this.tile * 0.3, C.pink, 24);
    }
  }

  update(dt: number): void {
    this.roundT += dt;
    this.flash = Math.max(0, this.flash - dt * 3);
    const r = this.round, n = r.n;
    for (let i = 0; i < n * n; i++) {
      if (this.popT[i] < 1) {
        if (this.popDelay[i] > 0) this.popDelay[i] -= dt;
        else this.popT[i] = Math.min(1, this.popT[i] + dt / CFG.popIn);
      }
      if (this.bounceT[i] < 1) {
        if (this.bounceDelay[i] > 0) this.bounceDelay[i] -= dt;
        else this.bounceT[i] = Math.min(1, this.bounceT[i] + dt / 0.09);
      }
      if (this.shakeT[i] < 1) this.shakeT[i] = Math.min(1, this.shakeT[i] + dt / 0.32);
      if (this.xMark[i] > 0) this.xMark[i] = Math.max(0, this.xMark[i] - dt / 0.6);
    }
    // Background hue drifts toward the round hue along the shortest path.
    const dh = ((r.hue - this.bgHue + 540) % 360) - 180;
    this.bgHue = (this.bgHue + dh * Math.min(1, dt * 4) + 360) % 360;

    if (this.swapT >= 0) {
      this.swapT += dt;
      if (this.swapT >= CFG.swapAt && this.next) {
        this.round = this.next;
        this.next = null;
        this.swapT = -1;
        this.tapIdx = -1;
        this.enterRound();
        this.demoWait = this.rng.range(0.45, 1.2);
      }
    }

    if (this.demo) {
      if (this.swapT < 0) {
        this.demoWait -= dt;
        if (this.demoWait <= 0) {
          const wrong = this.rng.chance(0.08);
          let i = this.round.odd;
          if (wrong) i = (i + 1 + this.rng.int(0, n * n - 2)) % (n * n);
          this.select(i);
          this.demoWait = this.rng.range(0.6, 1.2);
        }
      }
      if (this.roundNo > 13) this.start(this.rng.int(0, 1e9), { demo: true });
      return;
    }

    if (this.over) return;
    this.timeLeft -= dt;
    const sec = Math.ceil(this.timeLeft);
    if (this.timeLeft <= CFG.lowTime && sec !== this.lastSecond && sec > 0) {
      this.lastSecond = sec;
      this.ctx.audio.tick(1200, 0.07);
    }
    this.ctx.audio.musicRate(this.timeLeft <= CFG.lowTime ? 1.12 : 1);
    if (this.timeLeft <= 0) this.end();
  }

  private end(): void {
    this.timeLeft = 0;
    this.over = true;
    const a = this.ctx.audio;
    [0, 2, 4, 7].forEach((s, i) => a.tone({ f: pent(s, 523.25), type: 'triangle', d: 0.25, g: 0.14, at: i * 0.08 }));
    this.ctx.fx.camera.shake(0.2);
    this.ctx.shell.gameOver({
      score: this.cleared,
      title: "Time's up!",
      rank: `Your eyes are... ${rankFor(this.cleared)}`,
      stats: [
        { label: 'rounds', value: String(this.cleared) },
        { label: 'mistakes', value: String(this.mistakes) },
        { label: 'fastest find', value: this.fastest === Infinity ? '-' : `${this.fastest.toFixed(2)}s` },
      ],
    }, 600);
  }

  render(): void {
    const { canvas, fx } = this.ctx;
    const bg = oklch(0.2, 0.035, this.bgHue) ?? C.bg;
    const g = canvas.begin(bg);
    const W = canvas.w, H = canvas.h;
    this.layout();
    fx.camera.begin(g, W, H);
    const r = this.round, n = r.n, step = this.tile + this.gap;
    const rad = this.tile * CFG.radius;
    for (let i = 0; i < n * n; i++) {
      let s = ease.outBack(this.popT[i]);
      if (this.bounceT[i] < 1) s *= 1 + 0.1 * Math.sin(this.bounceT[i] * Math.PI);
      let dx = 0;
      if (this.shakeT[i] < 1) dx = Math.sin(this.shakeT[i] * Math.PI * 6) * 7 * (1 - this.shakeT[i]);
      if (i === this.tapIdx && this.swapT >= 0) {
        const k = this.swapT / CFG.swapAt;
        s = k < 0.35 ? 1 + 0.15 * ease.outCubic(k / 0.35) : 1.15 * (1 - ease.outCubic((k - 0.35) / 0.65));
      }
      if (s <= 0.001) continue;
      const x = this.ox + (i % n) * step + this.tile / 2 + dx;
      const y = this.oy + Math.floor(i / n) * step + this.tile / 2;
      const half = (this.tile / 2) * s;
      g.fillStyle = i === r.odd ? r.oddColor : r.base;
      g.beginPath();
      g.roundRect(x - half, y - half, half * 2, half * 2, rad * s);
      g.fill();
      if (this.xMark[i] > 0) {
        g.strokeStyle = rgba(C.pink, this.xMark[i]);
        g.lineWidth = Math.max(3, this.tile * 0.08);
        g.lineCap = 'round';
        const q = half * 0.45;
        g.beginPath(); g.moveTo(x - q, y - q); g.lineTo(x + q, y + q); g.moveTo(x + q, y - q); g.lineTo(x - q, y + q); g.stroke();
      }
    }
    if (this.kbd && !this.demo) {
      const c = this.tileCenter(this.focus);
      const half = this.tile / 2 + 4;
      g.strokeStyle = C.text;
      g.lineWidth = 3;
      g.beginPath(); g.roundRect(c.x - half, c.y - half, half * 2, half * 2, rad + 4); g.stroke();
    }
    fx.particles.render(g);
    fx.camera.end(g);
    if (!this.ctx.preview) this.renderTimer(g, W);
    fx.floaters.render(g);
  }

  private renderTimer(g: CanvasRenderingContext2D, W: number): void {
    const x = 16, y = 70, w = W - 32, h = 10;
    const k = clamp(this.timeLeft / CFG.duration, 0, 1);
    const low = this.timeLeft <= CFG.lowTime && !this.over;
    const pulse = low ? 0.5 + 0.5 * Math.sin(performance.now() / 1000 * TAU * 2) : 0;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill();
    const col = this.flash > 0 ? C.pink : low ? (pulse > 0.5 ? C.pink : C.orange) : C.text;
    g.fillStyle = col;
    if (k > 0) { g.beginPath(); g.roundRect(x, y, Math.max(h, w * k), h, h / 2); g.fill(); }
    if (this.flash > 0) {
      g.globalAlpha = this.flash * 0.5;
      g.fillStyle = C.pink;
      g.beginPath(); g.roundRect(x - 3, y - 3, w + 6, h + 6, h); g.fill();
      g.globalAlpha = 1;
    }
    g.font = `500 ${low ? 22 + pulse * 3 : 20}px ${FONT.mono}`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = low ? C.pink : C.text;
    g.fillText(Math.max(0, this.timeLeft).toFixed(1), W / 2, y + h + 6);
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number | string> {
    return { round: this.roundNo, grid: this.round.n, delta: this.round.delta, channel: this.round.channel, time: this.timeLeft };
  }
}

export default (): Game => new OddTileGame();
