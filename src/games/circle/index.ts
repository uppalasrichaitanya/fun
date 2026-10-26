import { TAU, clamp } from '../../engine/math';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import { drawGlow } from '../../engine/glow';
import type { Drone } from '../../engine/audio';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { gameUrl } from '../../shell/share';
import { CFG, MUSIC, rankFor } from './config';
import { FAIL_TEXT, Stroke, scoreStroke, type FailReason, type Scored } from './logic';
import { StrokeLayer, deviationColor } from './render';

type Phase = 'idle' | 'drawing' | 'result' | 'fail';

const CONFETTI = [C.pink, C.orange, C.yellow, C.green, C.cyan, C.violet];

class CircleGame implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private stroke = new Stroke();
  private layer = new StrokeLayer();
  private phase: Phase = 'idle';
  private pointerId = -1;
  private t = 0;            // time in phase
  private drawT = 0;
  private result: Scored | null = null;
  private fail: FailReason | null = null;
  private best = 0;
  private isNewBest = false;
  private shownScore = 0;
  private lastTickScore = -1;
  private tone: Drone | null = null;
  private demo = false;
  private demoT = 0;
  private demoWobble = [0, 0, 0, 0];
  private layerKey = '';
  private dotPulse = 0;
  private ringFlash = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => {
      if (this.demo || this.pointerId !== -1) return;
      this.pointerId = p.id;
      this.beginStroke(p.x, p.y);
    });
    ctx.input.on('move', (p) => {
      if (this.phase !== 'drawing' || p.id !== this.pointerId) return;
      this.addPoint(p.x, p.y);
    });
    ctx.input.on('up', (p) => {
      if (p.id !== this.pointerId) return;
      this.pointerId = -1;
      if (this.phase === 'drawing') this.finish();
    });
  }

  start(_seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.phase = 'idle';
    this.pointerId = -1;
    this.result = null; this.fail = null;
    this.layer.clear();
    this.best = this.ctx.shell.best();
    this.demoT = 0;
    this.stopTone();
    this.ctx.audio.music(MUSIC);
  }

  private get cx(): number { return this.ctx.canvas.w / 2; }
  private get cy(): number { return this.ctx.canvas.h * 0.53; }

  private beginStroke(x: number, y: number): void {
    this.phase = 'drawing';
    this.t = 0; this.drawT = 0;
    this.result = null; this.fail = null; this.isNewBest = false;
    this.layer.clear();
    this.stroke.begin(this.cx, this.cy);
    this.stroke.add(x, y);
    this.ctx.shell.setShare(null);
    this.ctx.audio.pluck(660, 0.12);
    this.dotPulse = 1;
    this.stopTone();
    this.tone = this.ctx.audio.drone('triangle', 440);
  }

  private addPoint(x: number, y: number): void {
    const s = this.stroke;
    const n0 = s.n;
    if (!s.add(x, y)) return;
    if (s.n === n0) return;
    const i = s.n - 1;
    const r = Math.hypot(x - s.cx, y - s.cy);
    const dev = s.n < 12 ? 0 : Math.abs(r - s.meanR) / s.meanR;
    this.layer.segment(s.xs[i - 1], s.ys[i - 1], x, y, deviationColor(dev));
    if (s.reversed && !this.demo) this.finish();
  }

  private finish(): void {
    this.stopTone();
    const s = this.stroke;
    this.t = 0;
    if (s.n < 8) { this.phase = 'idle'; this.layer.clear(); return; }
    const reason = this.drawT > CFG.maxTime ? 'slow' : s.validate(this.demo ? 0 : CFG.minRadius);
    if (reason) {
      this.phase = 'fail';
      this.fail = reason;
      this.ctx.audio.buzz();
      this.ctx.fx.camera.shake(0.15);
      return;
    }
    this.result = scoreStroke(s.xs, s.ys, s.n, s.cx, s.cy);
    this.phase = 'result';
    this.shownScore = 0;
    this.lastTickScore = -1;
    if (!this.demo) {
      const rec = this.ctx.shell.recordScore(this.result.score);
      this.isNewBest = rec.isNewBest;
      this.best = rec.best;
      const sc = this.result.score.toFixed(1);
      this.ctx.shell.setShare(`I drew a ${sc}% perfect circle - ${rankFor(this.result.score)}. Beat me: ${gameUrl('circle')}`);
    }
  }

  private stopTone(): void { this.tone?.stop(); this.tone = null; }

  private celebrate(): void {
    const r = this.result!;
    const { fx, audio, canvas } = this.ctx;
    if (r.score >= 90) { this.ringFlash = 1; audio.chime(9, 0.18); }
    if (r.score >= 98) { audio.fanfare(); fx.particles.sparkle(this.cx, this.cy, C.yellow, 40, r.R * 1.1); }
    if (this.isNewBest) {
      audio.sparkle(784);
      fx.particles.confetti(0, canvas.h * 0.8, -Math.PI / 3, CONFETTI, 60, canvas.h * 1.2);
      fx.particles.confetti(canvas.w, canvas.h * 0.8, -Math.PI * 2 / 3, CONFETTI, 60, canvas.h * 1.2);
      fx.floaters.add('NEW BEST!', this.cx, this.cy - r.R - 30, C.yellow, 30);
    }
  }

  update(dt: number): void {
    this.t += dt;
    this.dotPulse = Math.max(0, this.dotPulse - dt * 3);
    this.ringFlash = Math.max(0, this.ringFlash - dt * 1.5);
    if (this.phase === 'drawing') {
      this.drawT += dt;
      if (this.tone) {
        const live = this.stroke.live();
        this.tone.set(220 + (live / 100) * (live / 100) * 660, 0.05);
      }
      if (this.drawT > CFG.maxTime && !this.demo) this.finish();
    }
    if (this.phase === 'result' && this.result) {
      const k = Math.min(1, this.t / CFG.countUp);
      const before = this.shownScore;
      this.shownScore = this.result.score * ease.outCubic(k);
      const whole = Math.floor(this.shownScore);
      if (whole !== this.lastTickScore && !this.demo) { this.lastTickScore = whole; this.ctx.audio.tick(900 + whole * 12, 0.035); }
      if (before < this.result.score && k >= 1) this.celebrate();
    }
    if (this.demo) this.updateDemo(dt);
  }

  private updateDemo(dt: number): void {
    this.demoT += dt;
    const R = Math.min(this.ctx.canvas.w, this.ctx.canvas.h) * 0.32;
    const DRAW = 1.4;
    if (this.phase === 'idle' || ((this.phase === 'result' || this.phase === 'fail') && this.t > 1.8)) {
      this.demoT = 0;
      for (let i = 0; i < 4; i++) this.demoWobble[i] = this.rng.range(-1, 1);
      const a0 = this.rng.range(0, TAU);
      this.demoWobble[3] = a0;
      this.beginStroke(this.cx + Math.cos(a0) * R, this.cy + Math.sin(a0) * R);
      return;
    }
    if (this.phase === 'drawing') {
      const k = Math.min(1, this.demoT / DRAW);
      const [w1, w2, w3, a0] = this.demoWobble;
      const steps = 6;
      for (let j = 1; j <= steps; j++) {
        const kk = Math.min(1, (this.demoT - dt + (dt * j) / steps) / DRAW);
        const a = a0 + kk * (TAU + 0.12);
        const rr = R * (1 + 0.035 * w1 * Math.sin(2 * a + w3) + 0.02 * w2 * Math.sin(3 * a) + 0.01 * Math.sin(7 * a));
        this.addPoint(this.cx + Math.cos(a) * rr, this.cy + Math.sin(a) * rr);
      }
      if (k >= 1) this.finish();
    }
  }

  render(): void {
    const { canvas, fx } = this.ctx;
    const g = canvas.begin(C.bg);
    const W = canvas.w, H = canvas.h, cx = this.cx, cy = this.cy;
    const key = `${canvas.el.width}x${canvas.el.height}`;
    if (key !== this.layerKey) {
      this.layerKey = key;
      this.layer.resize(canvas.el.width, canvas.el.height, canvas.dpr);
      if (this.phase !== 'idle') { this.phase = 'idle'; this.result = null; }
    }
    // Soft vignette.
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
    grad.addColorStop(0, 'rgba(74,222,128,0.07)');
    grad.addColorStop(1, 'rgba(14,15,26,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    fx.camera.begin(g, W, H);
    const res = this.result;
    // Reference circle.
    if (this.phase === 'result' && res) {
      const a = Math.min(1, this.t / 0.4);
      g.globalAlpha = 0.35 * a;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.setLineDash([6, 8]);
      g.beginPath(); g.arc(cx, cy, res.R, 0, TAU); g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    // Stroke.
    const fade = this.phase === 'fail' ? Math.max(0.15, 1 - this.t * 1.2) : 1;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = fade;
    g.drawImage(this.layer.el, 0, 0);
    g.restore();
    // Worst 10% pulse.
    if (this.phase === 'result' && res && this.t > 0.3) {
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 9);
      g.strokeStyle = rgba(C.pink, 0.45 + 0.5 * pulse);
      g.lineWidth = 10;
      g.lineCap = 'round';
      g.beginPath();
      const M = res.rx.length;
      for (const i of res.worst) {
        const j = Math.min(M - 1, i + 1), h = Math.max(0, i - 1);
        g.moveTo(res.rx[h], res.ry[h]); g.lineTo(res.rx[j], res.ry[j]);
      }
      g.stroke();
    }
    if (this.ringFlash > 0 && res) {
      const k = 1 - this.ringFlash;
      g.globalAlpha = this.ctx.settings.motion ? this.ringFlash : this.ringFlash * 0.4;
      g.strokeStyle = C.yellow;
      g.lineWidth = 6 * this.ringFlash + 1;
      g.beginPath(); g.arc(cx, cy, res.R * (1 + k * 0.25), 0, TAU); g.stroke();
      g.globalAlpha = 1;
    }
    // Centre dot.
    drawGlow(g, '#ffffff', cx, cy, 26 + this.dotPulse * 20, 0.5);
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(cx, cy, 5 + this.dotPulse * 3, 0, TAU); g.fill();
    if (this.phase === 'idle') {
      const p = (this.t * 0.8) % 1;
      g.strokeStyle = rgba(C.green, 0.6 * (1 - p));
      g.lineWidth = 2;
      g.beginPath(); g.arc(cx, cy, 8 + p * 40, 0, TAU); g.stroke();
    }
    fx.particles.render(g);
    fx.camera.end(g);

    this.renderText(g, W, H, cx, cy);
    fx.floaters.render(g);
  }

  private renderText(g: CanvasRenderingContext2D, W: number, H: number, cx: number, cy: number): void {
    const small = Math.min(W, H) < 300;
    const big = Math.round(clamp(Math.min(W, H) * 0.13, 28, 84));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const label = (text: string, y: number, size: number, color: string, font: string = FONT.title, weight = 700) => {
      g.font = `${weight} ${size}px ${font}`;
      g.fillStyle = color;
      g.fillText(text, cx, y);
    };
    const R = this.stroke.meanR || Math.min(W, H) * 0.3;
    if (this.phase === 'idle' && !this.demo) {
      label('Draw a circle around the dot', cy + Math.min(W, H) * 0.36, small ? 14 : 20, C.muted, FONT.ui, 600);
      label(this.best > 0 ? `Best: ${this.best.toFixed(1)}%` : 'One stroke. Lift to finish.', cy - Math.min(W, H) * 0.36, small ? 13 : 17, C.muted, FONT.ui, 600);
    } else if (this.phase === 'drawing') {
      const live = this.stroke.live();
      label(`${live.toFixed(1)}%`, cy - Math.min(R * 0.45, big), big, deviationColor((100 - live) / 100 / 4.5 * 1.2));
    } else if (this.phase === 'result' && this.result) {
      const sc = this.shownScore;
      const col = sc >= 90 ? C.yellow : sc >= 70 ? C.green : C.text;
      // Score above the dot, rank below it, both inside the ring.
      const y = cy - Math.max(big * 0.75, Math.min(R * 0.42, big * 1.1));
      label(`${sc.toFixed(1)}%`, y, big, col);
      if (this.t > CFG.countUp) {
        const a = Math.min(1, (this.t - CFG.countUp) / 0.25);
        g.globalAlpha = a;
        const rs = Math.round(big * 0.38);
        label(rankFor(this.result.score), cy + Math.max(rs * 1.6, Math.min(R * 0.38, big)), rs, C.text);
        if (!this.demo) {
          label(this.isNewBest ? 'New best!' : `Best: ${this.best.toFixed(1)}%`, cy + R + 36, small ? 13 : 17, this.isNewBest ? C.yellow : C.muted, FONT.ui, 600);
          label('Draw again', cy + R + 62, small ? 12 : 15, C.muted, FONT.ui, 400);
        }
        g.globalAlpha = 1;
      }
    } else if (this.phase === 'fail' && this.fail) {
      const wob = Math.sin(Math.min(1, this.t * 3) * Math.PI * 4) * 8 * (1 - Math.min(1, this.t * 3));
      g.save(); g.translate(wob, 0);
      label(FAIL_TEXT[this.fail], cy - Math.min(W, H) * 0.36, small ? 15 : Math.round(big * 0.4), C.pink);
      g.restore();
      if (!this.demo) label('Try again: draw anywhere', cy + Math.min(W, H) * 0.36, small ? 12 : 15, C.muted, FONT.ui, 400);
    }
  }

  pause(): void {
    if (this.phase === 'drawing') { this.pointerId = -1; this.phase = 'idle'; this.layer.clear(); }
    this.stopTone();
  }
  resume(): void {}
  destroy(): void { this.stopTone(); this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number | string> {
    return { phase: this.phase, points: this.stroke.n, meanR: this.stroke.meanR, E: this.result?.E ?? 0, G: this.result?.G ?? 0 };
  }
}

export default (): Game => new CircleGame();
