import type { Drone, MusicSpec } from '../../engine/audio';
import { drawGlow } from '../../engine/glow';
import { clamp, damp, TAU } from '../../engine/math';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { anchorPos, Cave, CFG, Swinger, SwingBot, type Anchor } from './logic';

const MUSIC: MusicSpec = {
  bpm: 108, root: 57, wave: 'triangle', bass: true, kick: true, hats: true, gain: 0.55,
  chords: [[0, 3, 7, 10], [-4, 0, 3, 7], [-2, 2, 5, 9], [-5, -2, 2, 5]],
  arp: [0, 2, 1, 3, 2, 1, 3, 2],
};
const VIEW_H = 600;
const BEST_KEY = 'grapple-swing:bestDist';

class GrappleSwing implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private vis = new Rng();
  private demo = false;
  private cave = new Cave(1);
  private s = new Swinger(this.cave);
  private bot = new SwingBot(this.s);
  private camX = 0; private camY = 300; private zoom = 1;
  private scarf: { x: number; y: number }[] = [];
  private twang = 0;
  private squash = 0;
  private sparkleT = 0;
  private deadT = -1;
  private best = 0;
  private passedBest = false;
  private bestBanner = 0;
  private wind: Drone | null = null;
  private keyHold = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.onKey((code) => { if (code === 'Space' || code === 'ArrowUp') this.keyHold = true; });
    ctx.input.onKeyUp((code) => { if (code === 'Space' || code === 'ArrowUp') this.keyHold = false; });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    this.vis.seed(seed ^ 0x99);
    this.cave = new Cave(seed);
    this.s = new Swinger(this.cave);
    this.bot = new SwingBot(this.s);
    this.cave.ensure(0);
    this.camX = 0; this.camY = 300; this.zoom = 1;
    this.scarf = Array.from({ length: 10 }, () => ({ x: this.s.x, y: this.s.y }));
    this.twang = 0; this.squash = 0; this.sparkleT = 0; this.deadT = -1;
    this.best = this.ctx.storage.get<number>(BEST_KEY, 0);
    this.passedBest = false; this.bestBanner = 0;
    this.keyHold = false;
    this.ctx.audio.music(MUSIC);
    if (!this.demo) this.ctx.shell.setScore(0);
  }

  private holding(): boolean {
    const i = this.ctx.input;
    return this.keyHold || i.isDown('Space') || i.pressed > 0;
  }

  update(dt: number): void {
    const s = this.s, { fx, audio } = this.ctx;
    const hold = this.demo ? this.bot.update(dt) : this.holding();
    s.step(dt, hold);
    for (const e of s.events) {
      switch (e.type) {
        case 'fire':
          audio.whoosh(0.1, 0.12);
          if (!e.hit) audio.tone({ f: 2400, type: 'triangle', d: 0.08, g: 0.06, at: 0.1 });
          break;
        case 'attach':
          this.twang = 0.12; this.squash = 1;
          audio.tone({ f: 196, f2: 150, type: 'triangle', a: 0.002, d: 0.3, g: 0.18 });
          audio.tone({ f: 392, type: 'sine', a: 0.002, d: 0.15, g: 0.06 });
          fx.particles.sparkle(e.x, e.y, C.cyan, 6, 12);
          break;
        case 'release':
          if (e.perfect) {
            audio.chime(2 + e.streak * 2, 0.16);
            fx.floaters.add(e.streak > 1 ? `PERFECT x${e.streak}` : 'PERFECT', s.x, s.y - 34, C.yellow, 20);
            this.sparkleT = 0.5;
          }
          break;
        case 'crumble':
          audio.noise({ d: 0.3, g: 0.15, f: 900, q: 0.8 });
          fx.particles.burst(e.x, e.y, C.orange, { count: 14, speed: 160, gravity: 900, shape: Shape.Dot, size: 4 });
          break;
        case 'star':
          audio.sparkle(1318);
          fx.particles.burst(e.x, e.y, C.yellow, { count: 12, speed: 180, size: 4 });
          fx.floaters.add('+25', e.x, e.y - 18, C.yellow, 18);
          break;
        case 'dead':
          this.deadT = 0;
          fx.time.slowMo(0.3, 300);
          fx.camera.shake(0.5);
          audio.pop(300, 0.3);
          audio.tone({ f: 500, f2: 90, type: 'triangle', d: 0.5, g: 0.18 });
          fx.particles.burst(e.x, e.y, C.cyan, { count: 30, speed: 320, size: 6, life: 0.8, colors: [C.cyan, C.pink, '#fff'] });
          if (!this.demo) this.finish();
          break;
      }
    }
    s.events.length = 0;
    // Scarf trails behind.
    if (!s.dead) {
      this.scarf.unshift({ x: s.x, y: s.y });
      this.scarf.length = 10;
    }
    this.twang = Math.max(0, this.twang - dt);
    this.squash = Math.max(0, this.squash - dt * 5);
    if (this.sparkleT > 0) {
      this.sparkleT -= dt;
      fx.particles.spawn(s.x, s.y, this.vis.range(-40, 40), this.vis.range(-40, 40), 0.4, 3, 0, C.yellow, Shape.Glow, 0, 2);
    }
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > 800 && !s.dead && this.vis.chance(0.5)) {
      fx.particles.spawn(s.x + this.vis.range(-200, 200) + 300, s.y + this.vis.range(-200, 200), -sp * 0.6, -s.vy * 0.2, 0.25, 1.5, 1.5, 'rgba(255,255,255,0.5)', Shape.Spark, 0, 0);
    }
    // Best distance flag.
    if (!this.demo && this.best > 20 && !this.passedBest && s.distance > this.best) {
      this.passedBest = true; this.bestBanner = 1.6;
      audio.fanfare();
    }
    this.bestBanner = Math.max(0, this.bestBanner - dt);
    if (!this.demo && !s.dead) this.ctx.shell.setScore(this.score());
    this.cameraUpdate(dt, sp);
    this.sound(sp);
    if (this.deadT >= 0) {
      this.deadT += dt;
      if (this.demo && this.deadT > 1.6) this.start(this.rng.int(1, 1e9), { demo: true });
    }
  }

  private score(): number { return Math.floor(this.s.distance) + this.s.stars * CFG.star; }

  private finish(): void {
    const s = this.s;
    if (s.distance > this.best) this.ctx.storage.set(BEST_KEY, s.distance);
    this.ctx.shell.gameOver({
      score: this.score(),
      stats: [
        { label: 'distance', value: `${Math.floor(s.distance)} m` },
        { label: 'perfect releases', value: String(s.perfects) },
        { label: 'top speed', value: `${Math.round(s.topSpeed / CFG.unitsPerMeter)} m/s` },
      ],
    }, 700);
  }

  private cameraUpdate(dt: number, sp: number): void {
    const s = this.s, { w, h } = this.ctx.canvas;
    const k = clamp((sp - 400) / 800, 0, 1);
    this.zoom = damp(this.zoom, 1 / (1 + 0.15 * k), 3, dt);
    const scale = (h / VIEW_H) * this.zoom;
    if (this.deadT < 0) {
      this.camX = damp(this.camX, s.x - (w * 0.35) / scale, 10, dt);
      this.camY = damp(this.camY, 300 + clamp(s.vy * 0.08, -60, 60) + (s.y - 300) * 0.25, 4, dt);
    }
  }

  private sound(sp: number): void {
    if (this.ctx.preview) return;
    if (!this.wind) this.wind = this.ctx.audio.drone('noise', 600);
    const k = this.s.dead ? 0 : clamp(sp / CFG.maxSpeed, 0, 1);
    this.wind.set(500 + k * 1800, 0.01 + k * 0.08, 0.1);
  }

  // ---- render -----------------------------------------------------------------------

  render(): void {
    const { canvas, fx } = this.ctx;
    const g = canvas.begin('#070814');
    const { w, h } = canvas;
    const s = this.s;
    const scale = (h / VIEW_H) * this.zoom;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0E1230'); bg.addColorStop(1, '#05060E');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    fx.camera.begin(g, w, h);
    // Parallax silhouettes.
    for (const [f, col] of [[0.25, 'rgba(56,225,245,0.05)'], [0.5, 'rgba(155,123,255,0.07)']] as const) {
      g.save();
      g.translate(0, h / 2);
      g.scale(scale, scale);
      g.translate(-this.camX * f, -this.camY);
      this.cavePath(g, this.camX * f, w / scale, col, 0.85 + f * 0.3);
      g.restore();
    }
    g.save();
    g.translate(0, h / 2);
    g.scale(scale, scale);
    g.translate(-this.camX, -this.camY);
    const x0 = this.camX - 60, x1 = this.camX + w / scale + 60;
    this.drawCave(g, x0, x1);
    // Best flag.
    if (this.best > 20 && !this.demo) {
      const bx = 120 + this.best * CFG.unitsPerMeter;
      if (bx > x0 && bx < x1) {
        const fy = this.cave.floorAt(bx);
        g.strokeStyle = rgba(C.yellow, 0.7); g.lineWidth = 2;
        g.beginPath(); g.moveTo(bx, fy); g.lineTo(bx, fy - 120); g.stroke();
        g.fillStyle = C.yellow;
        g.beginPath(); g.moveTo(bx, fy - 120); g.lineTo(bx + 34, fy - 108); g.lineTo(bx, fy - 96); g.fill();
        g.font = `700 12px ${FONT.title}`; g.textAlign = 'left';
        g.fillText('BEST', bx + 4, fy - 128);
      }
    }
    // Anchors.
    const sel = s.anchor ? null : s.select();
    for (const a of this.cave.anchors()) {
      const p = anchorPos(a, s.t);
      if (p.x < x0 || p.x > x1) continue;
      this.anchor(g, a, p.x, p.y, a === sel, a === s.anchor);
    }
    for (const st of this.cave.stars()) {
      if (st.taken || st.x < x0 || st.x > x1) continue;
      drawGlow(g, C.yellow, st.x, st.y, 22, 0.4);
      star(g, st.x, st.y, 9 + Math.sin(s.t * 4 + st.x) * 1.5, C.yellow);
    }
    this.rope(g);
    if (!s.dead) this.player(g);
    fx.particles.render(g);
    fx.floaters.render(g);
    g.restore();
    fx.camera.end(g);
    if (this.bestBanner > 0) {
      const k = this.bestBanner / 1.6;
      g.globalAlpha = Math.min(1, k * 3);
      g.font = `700 ${Math.round(48 * ease.outBack(Math.min(1, (1 - k) * 4)))}px ${FONT.title}`;
      g.fillStyle = C.yellow; g.textAlign = 'center';
      g.fillText('NEW BEST!', w / 2 + (1 - k) * -120, h * 0.25);
      g.globalAlpha = 1;
    }
  }

  private cavePath(g: CanvasRenderingContext2D, x0: number, span: number, col: string, k: number): void {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x0 - 100, -200);
    for (let x = x0 - 100; x <= x0 + span + 100; x += 40) g.lineTo(x, this.cave.ceilAt(x) * k);
    g.lineTo(x0 + span + 100, -200);
    g.fill();
    g.beginPath();
    g.moveTo(x0 - 100, 900);
    for (let x = x0 - 100; x <= x0 + span + 100; x += 40) g.lineTo(x, 600 - (600 - this.cave.floorAt(x)) * k);
    g.lineTo(x0 + span + 100, 900);
    g.fill();
  }

  private drawCave(g: CanvasRenderingContext2D, x0: number, x1: number): void {
    const c = this.cave;
    // Ceiling rock.
    g.fillStyle = '#151933';
    g.beginPath(); g.moveTo(x0, -300);
    for (let x = x0; x <= x1; x += 25) g.lineTo(x, c.ceilAt(x));
    g.lineTo(x1, -300); g.fill();
    g.strokeStyle = rgba(C.cyan, 0.35); g.lineWidth = 2;
    g.beginPath();
    for (let x = x0; x <= x1; x += 25) (x === x0 ? g.moveTo(x, c.ceilAt(x)) : g.lineTo(x, c.ceilAt(x)));
    g.stroke();
    // Floor edge with the void beneath.
    const grad = g.createLinearGradient(0, 480, 0, 800);
    grad.addColorStop(0, '#1A1030'); grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(x0, 900);
    for (let x = x0; x <= x1; x += 25) g.lineTo(x, c.floorAt(x));
    g.lineTo(x1, 900); g.fill();
    g.strokeStyle = rgba(C.pink, 0.35);
    g.beginPath();
    for (let x = x0; x <= x1; x += 25) (x === x0 ? g.moveTo(x, c.floorAt(x)) : g.lineTo(x, c.floorAt(x)));
    g.stroke();
    // Spikes.
    for (const sp of c.spikes()) {
      if (sp.x < x0 || sp.x > x1) continue;
      g.fillStyle = sp.up ? '#3B2450' : '#C8CDE6';
      g.beginPath();
      if (sp.up) { g.moveTo(sp.x - 12, sp.y + 2); g.lineTo(sp.x, sp.y - 26); g.lineTo(sp.x + 12, sp.y + 2); }
      else { g.moveTo(sp.x - 12, sp.y - 2); g.lineTo(sp.x, sp.y + 26); g.lineTo(sp.x + 12, sp.y - 2); }
      g.fill();
    }
  }

  private anchor(g: CanvasRenderingContext2D, a: Anchor, x: number, y: number, selected: boolean, active: boolean): void {
    if (a.broken) return;
    const col = a.kind === 'crumble' ? C.orange : a.kind === 'moving' ? C.violet : C.cyan;
    const ceil = this.cave.ceilAt(a.x0);
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, ceil); g.lineTo(x, y); g.stroke();
    if (a.kind === 'moving') {
      g.strokeStyle = rgba(C.violet, 0.3);
      g.beginPath(); g.moveTo(a.x0 - a.rail, y); g.lineTo(a.x0 + a.rail, y); g.stroke();
    }
    drawGlow(g, col, x, y, active ? 34 : 24, active ? 0.7 : 0.4);
    const shake = a.kind === 'crumble' && active ? Math.sin(this.s.t * 60) * 2 : 0;
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x + shake, y - 11); g.lineTo(x + 8 + shake, y); g.lineTo(x + shake, y + 11); g.lineTo(x - 8 + shake, y);
    g.closePath(); g.fill();
    if (selected) {
      // The anchor a press grabs is always marked.
      const pulse = 1 + 0.12 * Math.sin(this.s.t * 8);
      g.strokeStyle = rgba('#ffffff', 0.85); g.lineWidth = 2.5;
      g.beginPath(); g.arc(x, y, 20 * pulse, 0, TAU); g.stroke();
    }
  }

  private rope(g: CanvasRenderingContext2D): void {
    const s = this.s;
    let tx: number, ty: number, k = 1;
    if (s.anchor) {
      const p = anchorPos(s.anchor, s.t);
      tx = p.x; ty = p.y;
      if (!s.attached) k = 1 - s.hookT / CFG.hookTime;
    } else if (s.missT > 0) {
      tx = s.missX; ty = s.missY; k = 1 - s.missT / 0.18;
    } else return;
    const ex = s.x + (tx - s.x) * k, ey = s.y + (ty - s.y) * k;
    const sag = s.attached ? Math.sin(this.twang * 160) * this.twang * 120 : 30;
    const mx = (s.x + ex) / 2, my = (s.y + ey) / 2 + sag;
    g.strokeStyle = s.anchor ? '#EFF4FF' : rgba('#EFF4FF', 0.5); g.lineWidth = 2.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(s.x, s.y); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
  }

  private player(g: CanvasRenderingContext2D): void {
    const s = this.s, r = CFG.r;
    const sp = Math.hypot(s.vx, s.vy);
    // Scarf.
    g.strokeStyle = C.pink; g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = sp > 800 ? 7 : 5;
    g.beginPath();
    this.scarf.forEach((p, i) => (i ? g.lineTo(p.x, p.y + Math.sin(s.t * 20 + i) * 2) : g.moveTo(p.x, p.y)));
    g.stroke();
    // Body: stretch along velocity, squash on attach.
    const ang = Math.atan2(s.vy, s.vx);
    const stretch = 1 + Math.min(0.25, sp / 4000) - this.squash * 0.2;
    g.save();
    g.translate(s.x, s.y);
    g.rotate(ang);
    g.scale(stretch, 1 / stretch);
    drawGlow(g, C.cyan, 0, 0, r * 2.4, 0.4);
    g.fillStyle = C.cyan;
    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
    g.restore();
    // Eyes look where it is going.
    const lx = Math.cos(ang) * 3, ly = Math.sin(ang) * 3;
    g.fillStyle = '#fff';
    for (const side of [-1, 1]) { g.beginPath(); g.arc(s.x - 3 + side * 4 + lx * 0.5, s.y - 3 + ly * 0.5, 3.4, 0, TAU); g.fill(); }
    g.fillStyle = '#0E0F1A';
    for (const side of [-1, 1]) { g.beginPath(); g.arc(s.x - 3 + side * 4 + lx, s.y - 3 + ly, 1.7, 0, TAU); g.fill(); }
  }

  pause(): void { this.wind?.set(500, 0, 0.05); }
  resume(): void {}
  destroy(): void { this.wind?.stop(); this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number> {
    const s = this.s;
    return { dist: s.distance, speed: Math.hypot(s.vx, s.vy), rope: s.rope, chunks: this.cave.chunks.length, streak: s.streak };
  }
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  g.fillStyle = col;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
}

export default (): Game => new GrappleSwing();
