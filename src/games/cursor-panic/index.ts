import { pent } from '../../engine/audio';
import { drawGlow } from '../../engine/glow';
import { clamp, dist, pointSegDist2, TAU } from '../../engine/math';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { CFG, KIND_NAME, MUSIC } from './config';
import { Hazards, type Hit } from './hazards';
import { Director, type World } from './patterns';

type Phase = 'wait' | 'play' | 'countdown' | 'lifted' | 'dead';

class CursorPanic implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private hz = new Hazards();
  private dir = new Director();
  private world: World = { hz: this.hz, rng: this.rng, px: 0, py: 0, I: 1 };
  private phase: Phase = 'wait';
  private demo = false;
  private px = 0; private py = 0;
  private placed = false;
  private touchId = -1;
  private lastFx = 0; private lastFy = 0;
  private t = 0;
  private grazes = 0;
  private grazePts = 0;
  private meter = 0;
  private shieldReady = false;
  private phaseT = 0;
  private countdown = 0;
  private deadT = 0;
  private killer: Hit | null = null;
  private grazeCombo = 0;
  private lastGraze = -1;
  private clock = 0;
  private aiVx = 0; private aiVy = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    if (!ctx.preview) ctx.canvas.el.style.cursor = 'none';
    this.hz.onEvent = (e, x, y) => {
      if (e === 'charge') ctx.audio.tone({ f: 180, f2: 620, type: 'sawtooth', a: 0.05, d: 0.75, g: 0.035, lp: 1400 });
      else if (e === 'fire') { ctx.audio.noise({ d: 0.3, g: 0.1, f: 2400, q: 0.6 }); ctx.fx.camera.shake(0.06); }
      else { ctx.audio.thud(0.8); ctx.fx.particles.burst(x, y, C.orange, { count: 14, speed: 240, size: 5 }); ctx.fx.camera.shake(0.12); }
    };
    ctx.input.on('down', (p) => {
      if (this.demo) return;
      if (p.type === 'touch') {
        if (this.touchId !== -1) return;
        this.touchId = p.id;
        this.lastFx = p.x; this.lastFy = p.y;
        if (!this.placed) {
          this.placed = true;
          this.px = clamp(p.x, 0, this.hz.W);
          this.py = clamp(p.y - CFG.touchOffset / ctx.canvas.scale, 0, this.hz.H);
        }
        if (this.phase === 'lifted') { this.phase = 'countdown'; this.countdown = 1.5; ctx.audio.tick(1400, 0.06); }
      } else {
        this.placed = true;
        this.setAbs(p.x, p.y);
      }
    });
    ctx.input.on('move', (p) => {
      if (this.demo || this.phase === 'dead') return;
      if (p.type === 'touch') {
        if (p.id !== this.touchId) return;
        this.px = clamp(this.px + p.x - this.lastFx, 0, this.hz.W);
        this.py = clamp(this.py + p.y - this.lastFy, 0, this.hz.H);
        this.lastFx = p.x; this.lastFy = p.y;
      } else {
        this.placed = true;
        this.setAbs(p.x, p.y);
      }
    });
    ctx.input.on('up', (p) => {
      if (p.id !== this.touchId) return;
      this.touchId = -1;
      if (this.phase === 'play' || this.phase === 'countdown') this.phase = 'lifted';
    });
  }

  private setAbs(x: number, y: number): void {
    this.px = clamp(x, 0, this.hz.W);
    this.py = clamp(y, 0, this.hz.H);
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    const c = this.ctx.canvas;
    // Arena shape is chosen per run; rotating mid-run letterboxes instead of breaking state.
    const res = c.portrait ? CFG.portrait : CFG.landscape;
    c.setLogicalSize(res.w, res.h);
    this.hz.W = res.w; this.hz.H = res.h;
    this.hz.clear();
    this.dir.reset();
    this.t = 0; this.grazes = 0; this.grazePts = 0; this.meter = 0; this.shieldReady = false; this.phaseT = 0;
    this.killer = null; this.deadT = 0; this.grazeCombo = 0; this.lastGraze = -1;
    this.touchId = -1;
    this.px = res.w / 2; this.py = res.h / 2 + 90;
    this.placed = !this.ctx.input.hasHover || this.ctx.input.hover.type === 'touch' ? false : true;
    if (this.placed) this.setAbs(this.ctx.input.hover.x, this.ctx.input.hover.y);
    this.phase = this.demo ? 'play' : 'wait';
    if (this.demo) { this.px = res.w / 2; this.py = res.h / 2; this.placed = true; }
    this.aiVx = this.aiVy = 0;
    this.ctx.audio.music(MUSIC);
    this.ctx.audio.musicRate(1);
  }

  get score(): number { return Math.floor(this.t * 100) + this.grazePts; }

  update(dt: number): void {
    this.clock += dt;
    if (this.phaseT > 0) this.phaseT -= dt;
    if (this.demo && this.phase === 'play') this.ai(dt);
    const w = this.world;
    w.px = this.px; w.py = this.py; w.I = 1 + this.t / 30;

    switch (this.phase) {
      case 'wait':
        if (this.placed && dist(this.px, this.py, this.hz.W / 2, this.hz.H / 2) < CFG.startR) {
          this.phase = 'play';
          this.ctx.audio.chime(4, 0.2);
          this.ctx.fx.particles.burst(this.px, this.py, C.yellow, { count: 18, speed: 200, size: 4 });
        }
        return;
      case 'countdown':
        this.countdown -= dt;
        if (Math.ceil(this.countdown) !== Math.ceil(this.countdown + dt) && this.countdown > 0) this.ctx.audio.tick(1400, 0.06);
        if (this.countdown <= 0) { this.phase = 'play'; this.ctx.audio.tick(2100, 0.08); }
        return;
      case 'lifted':
        return;
      case 'dead':
        this.deadT += dt;
        this.hz.update(dt * 0.5, this.px, this.py);
        if (this.demo && this.deadT > 1.6) this.start(this.rng.int(0, 1e9), { demo: true });
        return;
      case 'play':
        break;
    }

    this.t += dt;
    this.dir.update(dt, w);
    this.hz.update(dt, this.px, this.py);
    if (!this.demo) this.ctx.audio.musicRate(Math.min(1.3, 1 + this.t / 150));
    const hit = this.hz.collide(this.px, this.py, CFG.hitR, CFG.grazeR, (x, y) => this.graze(x, y));
    if (hit && this.phaseT <= 0) {
      if (this.shieldReady) {
        this.shieldReady = false;
        this.meter = 0;
        this.phaseT = CFG.phaseDur;
        this.ctx.audio.sparkle(1318);
        this.ctx.fx.floaters.add('PHASE!', this.px, this.py - 24, '#ffffff', 24);
        this.ctx.fx.particles.burst(this.px, this.py, '#ffffff', { count: 20, speed: 260, size: 4 });
      } else {
        this.die(hit);
      }
    }
  }

  private graze(x: number, y: number): void {
    if (this.phaseT > 0) return;
    this.grazes++;
    this.grazePts += 5;
    if (!this.shieldReady) {
      this.meter++;
      if (this.meter >= CFG.grazeNeed) {
        this.shieldReady = true;
        this.ctx.audio.chime(10, 0.15);
        this.ctx.fx.floaters.add('PHASE READY', this.px, this.py - 30, C.cyan, 20);
      }
    }
    this.grazeCombo = this.clock - this.lastGraze < 0.45 ? this.grazeCombo + 1 : 0;
    this.lastGraze = this.clock;
    this.ctx.audio.tick(pent(Math.min(14, this.grazeCombo + 3), 880), 0.05);
    const mx = (x + this.px) / 2, my = (y + this.py) / 2;
    this.ctx.fx.particles.burst(mx, my, C.yellow, { count: 4, speed: 140, size: 2.5, shape: Shape.Spark, life: 0.25 });
    if (this.grazeCombo >= 2) this.ctx.fx.floaters.add('+5', this.px + 16, this.py - 14, C.yellow, 15);
  }

  private die(hit: Hit): void {
    const { fx, audio } = this.ctx;
    this.phase = 'dead';
    this.killer = hit;
    this.deadT = 0;
    fx.time.hitStop(CFG.deathFreeze);
    fx.camera.shake(0.6);
    audio.shatter();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + this.rng.range(-0.2, 0.2), sp = this.rng.range(140, 320);
      fx.particles.spawn(this.px, this.py, Math.cos(a) * sp, Math.sin(a) * sp, 0.9, 3, 1, C.yellow, Shape.Spark, 0, 2.5);
    }
    fx.particles.burst(this.px, this.py, '#ffffff', { count: 10, speed: 120, size: 5 });
    if (this.demo) return;
    this.ctx.shell.gameOver({
      score: this.score,
      stats: [
        { label: 'time survived', value: `${this.t.toFixed(2)}s` },
        { label: 'grazes', value: String(this.grazes) },
        { label: 'killed by', value: KIND_NAME[hit.kind] },
      ],
    }, CFG.deathFreeze + 650);
  }

  /** Attract-mode autopilot: potential-field dodging. Good, not perfect. */
  private ai(dt: number): void {
    const hz = this.hz;
    let fx = (hz.W / 2 - this.px) * 0.004, fy = (hz.H / 2 - this.py) * 0.004;
    const push = (x: number, y: number, r: number, range: number, k: number) => {
      const dx = this.px - x, dy = this.py - y;
      const d = Math.hypot(dx, dy) - r;
      if (d > range) return;
      const s = k / Math.max(8, d) / Math.max(8, d);
      fx += (dx / (d + r + 0.01)) * s * 900; fy += (dy / (d + r + 0.01)) * s * 900;
    };
    for (const b of hz.bullets) if (b.alive) push(b.x + b.vx * 0.12, b.y + b.vy * 0.12, b.r, 110, 1);
    for (const s of hz.saws) if (s.alive) push(s.x + s.vx * 0.15, s.y + s.vy * 0.15, s.r, 140, 2);
    for (const m of hz.mines) if (m.alive) push(m.x, m.y, 50, 140, 3);
    for (const e of hz.emitters) if (e.alive) push(e.x, e.y, 20, 120, 2);
    for (const l of hz.lasers) {
      if (!l.alive) continue;
      const ang = l.span ? l.a0 + l.span / 2 : l.a0;
      const ex = l.x + Math.cos(ang) * l.len, ey = l.y + Math.sin(ang) * l.len;
      const d2 = pointSegDist2(this.px, this.py, l.x, l.y, ex, ey);
      const range = l.span ? 220 : 60;
      if (d2 < range * range) {
        // Move perpendicular to the beam, away from it.
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        const side = (this.px - l.x) * nx + (this.py - l.y) * ny >= 0 ? 1 : -1;
        fx += nx * side * 3; fy += ny * side * 3;
      }
    }
    for (const w of hz.walls) {
      if (!w.alive) continue;
      const mid = (w.gapA + w.gapB) / 2;
      if (w.vertical && Math.abs(w.pos - this.px) < 260) fy += (mid - this.py) * 0.05;
      if (!w.vertical && Math.abs(w.pos - this.py) < 260) fx += (mid - this.px) * 0.05;
    }
    const mag = Math.hypot(fx, fy);
    const max = 340;
    const tvx = mag > 0 ? (fx / mag) * Math.min(max, mag * 120) : 0;
    const tvy = mag > 0 ? (fy / mag) * Math.min(max, mag * 120) : 0;
    this.aiVx += (tvx - this.aiVx) * Math.min(1, dt * 12);
    this.aiVy += (tvy - this.aiVy) * Math.min(1, dt * 12);
    this.px = clamp(this.px + this.aiVx * dt, 6, hz.W - 6);
    this.py = clamp(this.py + this.aiVy * dt, 6, hz.H - 6);
  }

  render(): void {
    const { canvas, fx, audio } = this.ctx;
    const g = canvas.begin('#07080f');
    const W = this.hz.W, H = this.hz.H;
    fx.camera.begin(g, W, H);
    // Arena.
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 50; x < W; x += 50) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = 50; y < H; y += 50) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    const beat = audio.beatPhase();
    const pulse = Math.pow(1 - beat, 3);
    g.strokeStyle = rgba(C.yellow, 0.18 + 0.25 * pulse);
    g.lineWidth = 8;
    g.strokeRect(0, 0, W, H);
    g.strokeStyle = rgba(C.yellow, 0.55 + 0.35 * pulse);
    g.lineWidth = 2;
    g.strokeRect(1, 1, W - 2, H - 2);

    this.hz.render(g, this.clock);

    if (this.phase === 'wait') {
      const p = 0.5 + 0.5 * Math.sin(this.clock * 5);
      drawGlow(g, C.green, W / 2, H / 2, 70, 0.3 + 0.2 * p);
      g.strokeStyle = C.green;
      g.lineWidth = 3;
      g.beginPath(); g.arc(W / 2, H / 2, CFG.startR + p * 4, 0, TAU); g.stroke();
    }
    if (this.phase === 'dead' && this.killer) {
      const k = this.killer;
      g.strokeStyle = rgba(C.pink, 0.5 + 0.5 * Math.sin(this.deadT * 16));
      g.lineWidth = 3;
      g.beginPath(); g.arc(k.x, k.y, 26, 0, TAU); g.stroke();
    }
    if (this.phase !== 'dead' && this.placed) this.drawPlayer(g);
    fx.particles.render(g);
    fx.floaters.render(g);
    if (this.ctx.debug.enabled) this.drawColliders(g);
    fx.camera.end(g);
    this.hud(g, W, H);
  }

  /** F3 overlay: hit and graze radii. */
  private drawColliders(g: CanvasRenderingContext2D): void {
    g.lineWidth = 1;
    g.strokeStyle = '#00ff88';
    g.beginPath();
    for (const b of this.hz.bullets) if (b.alive) { g.moveTo(b.x + b.r, b.y); g.arc(b.x, b.y, b.r, 0, TAU); }
    for (const s of this.hz.saws) if (s.alive) { g.moveTo(s.x + s.r * 0.85, s.y); g.arc(s.x, s.y, s.r * 0.85, 0, TAU); }
    for (const m of this.hz.mines) if (m.alive) { g.moveTo(m.x + m.r, m.y); g.arc(m.x, m.y, m.r, 0, TAU); }
    g.moveTo(this.px + CFG.hitR, this.py); g.arc(this.px, this.py, CFG.hitR, 0, TAU);
    g.stroke();
    g.strokeStyle = 'rgba(0,255,136,0.4)';
    g.beginPath(); g.arc(this.px, this.py, CFG.grazeR, 0, TAU); g.stroke();
  }

  private drawPlayer(g: CanvasRenderingContext2D): void {
    const shield = this.phaseT > 0;
    const col = shield ? '#ffffff' : C.yellow;
    drawGlow(g, col, this.px, this.py, 34, shield ? 0.8 : 0.55);
    g.fillStyle = col;
    g.beginPath(); g.arc(this.px, this.py, CFG.visR, 0, TAU); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(this.px, this.py, CFG.visR * 0.45, 0, TAU); g.fill();
    if (this.shieldReady) {
      g.strokeStyle = rgba(C.cyan, 0.6 + 0.3 * Math.sin(this.clock * 8));
      g.lineWidth = 2;
      g.beginPath(); g.arc(this.px, this.py, CFG.visR + 6, 0, TAU); g.stroke();
    }
    if (shield) {
      g.strokeStyle = rgba('#ffffff', 0.5);
      g.lineWidth = 2;
      g.beginPath(); g.arc(this.px, this.py, CFG.visR + 10 + Math.sin(this.clock * 20) * 2, 0, TAU); g.stroke();
    }
  }

  private hud(g: CanvasRenderingContext2D, W: number, H: number): void {
    const preview = this.ctx.preview;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const big = preview ? 54 : W < 500 ? 34 : 40;
    g.font = `500 ${big}px ${FONT.mono}`;
    g.fillStyle = this.phase === 'dead' ? C.pink : C.text;
    g.fillText(`${this.t.toFixed(2)} s`, W / 2, preview ? 18 : 12);
    if (preview) return;
    g.font = `600 15px ${FONT.ui}`;
    g.fillStyle = C.muted;
    g.fillText(`${this.score} pts`, W / 2, 12 + big + 4);
    // Graze meter.
    const mw = 120, mx = W / 2 - mw / 2, my = 12 + big + 26;
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(mx, my, mw, 4);
    g.fillStyle = this.shieldReady ? C.cyan : C.yellow;
    g.fillRect(mx, my, mw * (this.shieldReady ? 1 : this.meter / CFG.grazeNeed), 4);

    g.textBaseline = 'middle';
    if (this.phase === 'wait') {
      g.font = `700 22px ${FONT.title}`;
      g.fillStyle = C.text;
      const touch = this.ctx.input.hover.type === 'touch' || matchMedia('(pointer: coarse)').matches;
      g.fillText(touch && !this.placed ? 'Touch, then drag the dot onto the circle' : 'Move onto the circle to start', W / 2, H / 2 + 70);
    } else if (this.phase === 'countdown') {
      g.font = `700 96px ${FONT.title}`;
      g.fillStyle = C.text;
      g.fillText(String(Math.ceil(this.countdown / 0.5)), W / 2, H / 2);
    } else if (this.phase === 'lifted') {
      g.fillStyle = 'rgba(14,15,26,0.55)';
      g.fillRect(0, 0, W, H);
      g.font = `700 26px ${FONT.title}`;
      g.fillStyle = C.text;
      g.fillText('Touch to continue', W / 2, H / 2);
    }
  }

  pause(): void {}
  resume(): void {
    if (this.phase === 'play') { this.phase = 'countdown'; this.countdown = 1.5; }
  }
  destroy(): void { this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number | string> {
    return {
      t: this.t, I: 1 + this.t / 30, bullets: this.hz.bulletCount, patterns: this.dir.active.map((p) => KIND_NAME[p.kind]).join(','),
      grazes: this.grazes, phase: this.phase,
    };
  }
}

export default (): Game => new CursorPanic();
