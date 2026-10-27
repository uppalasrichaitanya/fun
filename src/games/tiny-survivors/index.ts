import { pent, type MusicSpec } from '../../engine/audio';
import { drawGlow, glowSprite } from '../../engine/glow';
import { clamp, damp, TAU } from '../../engine/math';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { ENEMIES, PASSIVES, PLAYER, RUN_TIME, WEAPONS, xpFor, type EnemyType } from './data';
import { Survivors, SurvivorBot, type Enemy } from './logic';

const MUSIC: MusicSpec = {
  bpm: 104, root: 52, wave: 'square', bass: true, kick: true, hats: true, gain: 0.5,
  chords: [[0, 3, 7], [-4, 0, 3], [-2, 2, 5], [-5, -2, 2]],
  arp: [0, 1, 2, 1, 2, 1, 0, 2],
};
const JOY_MAX = 56, JOY_DEAD = 8;

/** Pre-rendered enemy sprites: [type][elite][flash]. */
const sprites = new Map<string, HTMLCanvasElement>();
function enemySprite(type: EnemyType, elite: boolean, flash: boolean): HTMLCanvasElement {
  const key = `${type}${elite ? 'e' : ''}${flash ? 'f' : ''}`;
  let c = sprites.get(key);
  if (c) return c;
  const d = ENEMIES[type], r = d.r * (elite ? 1.25 : 1), s = 2, pad = 8;
  const size = Math.ceil((r + pad) * 2 * s);
  c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.scale(s, s);
  const m = size / s / 2;
  if (elite) g.drawImage(glowSprite(C.yellow), m - r - pad, m - r - pad, (r + pad) * 2, (r + pad) * 2);
  g.fillStyle = flash ? '#ffffff' : d.color;
  g.beginPath();
  if (type === 'bat') {
    g.moveTo(m - r * 1.6, m - r * 0.2); g.quadraticCurveTo(m - r * 0.8, m - r * 1.2, m, m - r * 0.3);
    g.quadraticCurveTo(m + r * 0.8, m - r * 1.2, m + r * 1.6, m - r * 0.2); g.quadraticCurveTo(m, m + r * 1.1, m - r * 1.6, m - r * 0.2);
  } else g.arc(m, m, r, 0, TAU);
  g.fill();
  if (elite) { g.strokeStyle = C.yellow; g.lineWidth = 2; g.stroke(); }
  if (!flash) {
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(m - r * 0.32, m - r * 0.15, r * 0.24, 0, TAU); g.arc(m + r * 0.32, m - r * 0.15, r * 0.24, 0, TAU); g.fill();
    g.fillStyle = '#1B1430';
    g.beginPath(); g.arc(m - r * 0.28, m - r * 0.1, r * 0.12, 0, TAU); g.arc(m + r * 0.36, m - r * 0.1, r * 0.12, 0, TAU); g.fill();
    if (type === 'boss') {
      g.fillStyle = C.yellow;
      g.beginPath(); g.moveTo(m - r * 0.5, m - r * 0.8); g.lineTo(m - r * 0.5, m - r * 1.25); g.lineTo(m - r * 0.2, m - r * 1.0);
      g.lineTo(m, m - r * 1.35); g.lineTo(m + r * 0.2, m - r * 1.0); g.lineTo(m + r * 0.5, m - r * 1.25); g.lineTo(m + r * 0.5, m - r * 0.8); g.fill();
    }
  }
  sprites.set(key, c);
  return c;
}

let tile: HTMLCanvasElement | null = null;
function grassTile(): HTMLCanvasElement {
  if (tile) return tile;
  tile = document.createElement('canvas');
  tile.width = tile.height = 128;
  const g = tile.getContext('2d')!;
  g.fillStyle = '#0F1A1A'; g.fillRect(0, 0, 128, 128);
  const r = new Rng(9);
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = `rgba(74,222,128,${r.range(0.05, 0.14)})`; g.lineWidth = 1.5;
    const x = r.range(0, 128), y = r.range(0, 128);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + r.range(-3, 3), y - r.range(4, 9)); g.stroke();
  }
  for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(155,123,255,0.18)'; g.fillRect(r.range(0, 128), r.range(0, 128), 2, 2); }
  return tile;
}

class TinySurvivors implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private s = new Survivors(this.rng);
  private bot = new SurvivorBot(this.s);
  private demo = false;
  private camX = 0; private camY = 0;
  private joy: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private cardFocus = 0;
  private levelFx = 0;
  private hurtFx = 0;
  private beatT = 0;
  private gemTick = 0; private gemPitch = 0;
  private hitTick = 0;
  private banner = ''; private bannerT = 0;
  private overT = -1;
  private cardRects: { x: number; y: number; w: number; h: number }[] = [];
  private scale = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => {
      if (this.demo) return;
      if (this.s.choosing) { this.tapCard(p.x, p.y); return; }
      if (p.type !== 'mouse' && !this.joy) this.joy = { id: p.id, ox: p.x, oy: p.y, x: p.x, y: p.y };
    });
    ctx.input.on('move', (p) => { if (this.joy && p.id === this.joy.id) { this.joy.x = p.x; this.joy.y = p.y; } });
    ctx.input.on('up', (p) => { if (this.joy && p.id === this.joy.id) this.joy = null; });
    ctx.input.onKey((code) => {
      if (this.demo || !this.s.choosing) return;
      const n = this.s.choosing.length;
      if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3') { const i = Number(code.slice(-1)) - 1; if (i < n) this.pickCard(i); }
      else if (code === 'ArrowLeft' || code === 'ArrowUp') this.cardFocus = (this.cardFocus + n - 1) % n;
      else if (code === 'ArrowRight' || code === 'ArrowDown') this.cardFocus = (this.cardFocus + 1) % n;
      else if (code === 'Enter' || code === 'Space') this.pickCard(this.cardFocus);
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    this.s = new Survivors(this.rng);
    this.s.reset();
    this.bot = new SurvivorBot(this.s, 1);
    this.camX = 0; this.camY = 0; this.joy = null; this.cardFocus = 0;
    this.levelFx = 0; this.hurtFx = 0; this.banner = ''; this.bannerT = 0; this.overT = -1;
    this.ctx.audio.music(MUSIC);
  }

  private pickCard(i: number): void {
    this.s.choose(i);
    this.cardFocus = 0;
    this.ctx.audio.chime(9, 0.16);
  }

  private tapCard(x: number, y: number): void {
    this.cardRects.forEach((r, i) => { if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) this.pickCard(i); });
  }

  private moveInput(): [number, number] {
    const k = this.ctx.input;
    let x = 0, y = 0;
    if (k.isDown('KeyA', 'ArrowLeft')) x -= 1; if (k.isDown('KeyD', 'ArrowRight')) x += 1;
    if (k.isDown('KeyW', 'ArrowUp')) y -= 1; if (k.isDown('KeyS', 'ArrowDown')) y += 1;
    const l = Math.hypot(x, y);
    if (l > 0) return [x / l, y / l];
    if (this.joy) {
      const dx = this.joy.x - this.joy.ox, dy = this.joy.y - this.joy.oy, d = Math.hypot(dx, dy);
      if (d > JOY_DEAD) { const m = Math.min(1, (d - JOY_DEAD) / (JOY_MAX - JOY_DEAD)); return [(dx / d) * m, (dy / d) * m]; }
    }
    return [0, 0];
  }

  update(dt: number): void {
    const s = this.s, { fx, audio, canvas } = this.ctx;
    this.scale = Math.min(canvas.w, canvas.h) / 360;
    s.viewW = canvas.w / this.scale; s.viewH = canvas.h / this.scale;
    if (this.demo && s.choosing) s.choose(this.bot.pick());
    const [mx, my] = this.demo ? this.bot.move(dt) : this.moveInput();
    s.step(dt, mx, my);
    for (const e of s.events) {
      switch (e.type) {
        case 'hit':
          fx.floaters.add(String(e.dmg), e.x, e.y, e.crit ? C.yellow : '#fff', e.crit ? 16 : 12);
          if (this.hitTick <= 0) { audio.tick(1400 + this.rng.range(-200, 200), 0.025); this.hitTick = 0.04; }
          break;
        case 'kill':
          fx.particles.burst(e.x, e.y, e.color, { count: 6, speed: 120, size: 3, life: 0.4 });
          if (e.elite) audio.pop(500, 0.2);
          break;
        case 'hurt':
          this.hurtFx = 0.3; fx.camera.shake(0.25); audio.thud(0.8);
          break;
        case 'gem':
          this.gemPitch = this.gemTick > 0 ? Math.min(14, this.gemPitch + 1) : 0;
          this.gemTick = 0.25;
          audio.tone({ f: pent(this.gemPitch, 880), type: 'sine', d: 0.05, g: 0.04 });
          break;
        case 'level':
          this.levelFx = 1; fx.time.slowMo(0.3, 400);
          [0, 2, 4, 7].forEach((st, i) => audio.tone({ f: pent(st, 523), type: 'triangle', d: 0.25, g: 0.1, at: i * 0.06 }));
          break;
        case 'nova': audio.noise({ d: 0.4, g: 0.08, f: 3000, f2: 800, q: 1 }); break;
        case 'boss':
          this.banner = 'KING SLIME'; this.bannerT = 2.4;
          audio.tone({ f: 70, f2: 40, type: 'sawtooth', d: 1.2, g: 0.2, lp: 500 });
          fx.camera.shake(0.6);
          break;
        case 'bossLand':
          fx.camera.shake(0.5); audio.thud(1);
          fx.particles.burst(e.x, e.y, C.green, { count: 20, speed: 220, size: 5, shape: Shape.Dot, life: 0.6 });
          break;
        case 'split': fx.floaters.add('SPLIT!', e.x, e.y - 50, C.green, 22); break;
        case 'wave': this.banner = e.name; this.bannerT = 1.8; audio.whoosh(0.2, 0.4); break;
        case 'win':
          audio.fanfare(); fx.time.slowMo(0.3, 600);
          fx.particles.confetti(s.x, s.y, -Math.PI / 2, [C.yellow, C.violet, C.cyan], 60, 600);
          this.overT = 0;
          if (!this.demo) this.finish(true);
          break;
        case 'dead':
          fx.time.hitStop(120); fx.camera.shake(0.6);
          audio.tone({ f: 300, f2: 60, type: 'triangle', d: 0.9, g: 0.2 });
          fx.particles.burst(s.x, s.y, C.violet, { count: 30, speed: 260, size: 5 });
          this.overT = 0;
          if (!this.demo) this.finish(false);
          break;
      }
    }
    s.events.length = 0;
    this.hitTick -= dt; this.gemTick -= dt;
    this.levelFx = Math.max(0, this.levelFx - dt * 1.5);
    this.hurtFx = Math.max(0, this.hurtFx - dt);
    this.bannerT = Math.max(0, this.bannerT - dt);
    // Low HP heartbeat.
    if (s.hp / s.maxHp < 0.3 && !s.dead) {
      this.beatT -= dt;
      if (this.beatT <= 0) { audio.heartbeat(0.25); this.beatT = 0.8; }
    }
    // Camera: 0.12 s smoothing with a 40 u lead.
    const l = Math.hypot(mx, my);
    const tx = s.x + (l ? (mx / l) * 40 : 0), ty = s.y + (l ? (my / l) * 40 : 0);
    this.camX = damp(this.camX, tx, 1 / 0.12, dt);
    this.camY = damp(this.camY, ty, 1 / 0.12, dt);
    if (this.overT >= 0) {
      this.overT += dt;
      if (this.demo && this.overT > 2.5) this.start(this.rng.int(1, 1e9), { demo: true });
    }
  }

  private finish(won: boolean): void {
    const s = this.s;
    const build = [...s.weapons].map(([id, L]) => `${WEAPONS[id].icon}${L}`).concat([...s.passives].map(([id, L]) => `${PASSIVES[id].icon}${L}`)).join(' ');
    this.ctx.shell.gameOver({
      score: s.score(), title: won ? 'SURVIVED!' : 'Overwhelmed', rank: build,
      stats: [
        { label: 'time survived', value: fmt(s.t) },
        { label: 'kills', value: String(s.kills) },
        { label: 'level', value: String(s.level) },
      ],
    }, won ? 1400 : 800);
  }

  // ---- render -----------------------------------------------------------------------

  render(): void {
    const { canvas, fx } = this.ctx;
    const g = canvas.begin('#0F1A1A');
    const { w, h } = canvas, s = this.s, k = this.scale;
    fx.camera.begin(g, w, h);
    g.save();
    g.translate(w / 2, h / 2); g.scale(k, k); g.translate(-this.camX, -this.camY);
    // Tiled grass.
    const t = grassTile();
    const vw = w / k, vh = h / k;
    const x0 = Math.floor((this.camX - vw / 2) / 128) * 128, y0 = Math.floor((this.camY - vh / 2) / 128) * 128;
    for (let x = x0; x < this.camX + vw / 2 + 128; x += 128) for (let y = y0; y < this.camY + vh / 2 + 128; y += 128) g.drawImage(t, x, y);
    // Aura.
    if (s.wl('aura')) {
      const r = s.auraR();
      g.fillStyle = rgba(C.orange, 0.1 + 0.04 * Math.sin(s.t * 6));
      g.beginPath(); g.arc(s.x, s.y, r, 0, TAU); g.fill();
      g.strokeStyle = rgba(C.orange, 0.35); g.lineWidth = 2; g.stroke();
    }
    for (const n of s.novas) {
      g.strokeStyle = rgba('#A5F3FC', 1 - n.t / 0.6); g.lineWidth = 4;
      g.beginPath(); g.arc(n.x, n.y, n.r * Math.min(1, n.t / 0.4), 0, TAU); g.stroke();
    }
    // Gems.
    for (const gm of s.gems) {
      if (!gm.alive) continue;
      const col = gm.value >= 25 ? C.violet : gm.value >= 5 ? C.cyan : C.green;
      g.fillStyle = col;
      g.beginPath(); g.moveTo(gm.x, gm.y - 5); g.lineTo(gm.x + 4, gm.y); g.lineTo(gm.x, gm.y + 5); g.lineTo(gm.x - 4, gm.y); g.fill();
    }
    // Boss telegraph.
    const boss = s.boss;
    if (boss?.alive && boss.jumpT <= 0.8 && boss.jumpT > 0) {
      g.fillStyle = rgba('#000', 0.35 + 0.3 * (1 - boss.jumpT / 0.8));
      g.beginPath(); g.ellipse(boss.jumpX, boss.jumpY, 70, 30, 0, 0, TAU); g.fill();
      g.strokeStyle = rgba(C.pink, 0.7); g.lineWidth = 2; g.stroke();
    }
    // Enemies (batched by sprite).
    for (const e of s.enemies) {
      if (!e.alive) continue;
      this.enemy(g, e);
    }
    // Shots.
    for (const sh of s.shots) {
      if (!sh.alive) continue;
      if (sh.kind === 'bolt') { drawGlow(g, C.cyan, sh.x, sh.y, 10, 0.8); g.fillStyle = '#fff'; g.beginPath(); g.arc(sh.x, sh.y, 2.5, 0, TAU); g.fill(); }
      else if (sh.kind === 'orb') { drawGlow(g, C.pink, sh.x, sh.y, 12, 0.7); g.fillStyle = C.pink; g.beginPath(); g.arc(sh.x, sh.y, 4, 0, TAU); g.fill(); }
      else {
        g.save(); g.translate(sh.x, sh.y); g.rotate(sh.t * 18);
        g.strokeStyle = C.green; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath(); g.arc(0, 0, 8, 0, Math.PI * 1.2); g.stroke(); g.restore();
      }
    }
    // Orbit blades.
    if (s.wl('orbit')) {
      const { count, r } = s.orbitInfo();
      for (let i = 0; i < count; i++) {
        const a = s.orbitA + (i / count) * TAU;
        const bx = s.x + Math.cos(a) * r, by = s.y + Math.sin(a) * r;
        drawGlow(g, C.violet, bx, by, 14, 0.6);
        g.save(); g.translate(bx, by); g.rotate(a + Math.PI / 2);
        g.fillStyle = '#E4DCFF'; g.beginPath(); g.moveTo(0, -9); g.lineTo(4, 0); g.lineTo(0, 9); g.lineTo(-4, 0); g.fill();
        g.restore();
      }
    }
    for (const z of s.zaps) {
      g.strokeStyle = rgba(C.yellow, z.t / 0.2); g.lineWidth = 3;
      g.beginPath();
      for (let i = 0; i < z.pts.length; i += 2) {
        const jx = i ? (Math.random() - 0.5) * 8 : 0, jy = i ? (Math.random() - 0.5) * 8 : 0;
        if (i === 0) g.moveTo(z.pts[0], z.pts[1]); else g.lineTo(z.pts[i] + jx, z.pts[i + 1] + jy);
      }
      g.stroke();
    }
    if (!s.dead) this.hero(g);
    fx.particles.render(g);
    fx.floaters.render(g);
    g.restore();
    fx.camera.end(g);
    // Low HP red vignette.
    const low = s.hp / s.maxHp < 0.3 && !s.dead;
    if (low || this.hurtFx > 0) {
      const a = (low ? 0.25 + 0.15 * Math.sin(s.t * 7) : 0) + this.hurtFx;
      const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
      v.addColorStop(0, 'rgba(255,0,60,0)'); v.addColorStop(1, `rgba(255,0,60,${clamp(a, 0, 0.6)})`);
      g.fillStyle = v; g.fillRect(0, 0, w, h);
    }
    if (!this.ctx.preview) this.hud(g, w, h);
    if (this.joy && !this.demo) {
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 3;
      g.beginPath(); g.arc(this.joy.ox, this.joy.oy, JOY_MAX, 0, TAU); g.stroke();
      const dx = this.joy.x - this.joy.ox, dy = this.joy.y - this.joy.oy, d = Math.min(JOY_MAX, Math.hypot(dx, dy)), a = Math.atan2(dy, dx);
      g.fillStyle = rgba(C.violet, 0.6);
      g.beginPath(); g.arc(this.joy.ox + Math.cos(a) * d, this.joy.oy + Math.sin(a) * d, 22, 0, TAU); g.fill();
    }
    if (s.choosing && !this.ctx.preview) this.cards(g, w, h);
  }

  private enemy(g: CanvasRenderingContext2D, e: Enemy): void {
    const img = enemySprite(e.type, e.elite, e.flash > 0);
    let sz = img.width / 2;
    let y = e.y;
    if (e.type === 'boss' && e.jumpT <= 0.8 && e.jumpT > 0) { const k = Math.sin((1 - e.jumpT / 0.8) * Math.PI); y -= k * 60; sz *= 1 + k * 0.2; }
    if (e.slow > 0) { g.globalAlpha = 0.85; }
    g.drawImage(img, e.x - sz / 2, y - sz / 2, sz, sz);
    if (e.slow > 0) { g.fillStyle = 'rgba(165,243,252,0.35)'; g.beginPath(); g.arc(e.x, y, e.r, 0, TAU); g.fill(); g.globalAlpha = 1; }
    if (e.type === 'boss') {
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(e.x - 40, y - e.r - 26, 80, 6);
      g.fillStyle = C.green; g.fillRect(e.x - 40, y - e.r - 26, 80 * (e.hp / e.maxHp), 6);
    }
  }

  private hero(g: CanvasRenderingContext2D): void {
    const s = this.s, r = PLAYER.r;
    if (s.invuln > 0 && Math.floor(s.invuln * 20) % 2 === 0) return;
    // Cape flows opposite the facing direction.
    const bx = -s.fx, by = -s.fy;
    g.fillStyle = C.pink;
    g.beginPath();
    g.moveTo(s.x - by * r * 0.8, s.y + bx * r * 0.8);
    g.quadraticCurveTo(s.x + bx * r * 2.2 + Math.sin(s.t * 12) * 2, s.y + by * r * 2.2, s.x + by * r * 0.8, s.y - bx * r * 0.8);
    g.fill();
    drawGlow(g, C.violet, s.x, s.y, 20, 0.5);
    g.fillStyle = '#EDE7FF'; g.beginPath(); g.arc(s.x, s.y, r, 0, TAU); g.fill();
    g.fillStyle = '#1B1430';
    g.beginPath(); g.arc(s.x + s.fx * 3 - 2.5, s.y + s.fy * 3 - 1, 1.6, 0, TAU); g.arc(s.x + s.fx * 3 + 2.5, s.y + s.fy * 3 - 1, 1.6, 0, TAU); g.fill();
    // HP bar under the hero.
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(s.x - 14, s.y + r + 5, 28, 4);
    g.fillStyle = s.hp / s.maxHp < 0.3 ? C.pink : C.green; g.fillRect(s.x - 14, s.y + r + 5, 28 * clamp(s.hp / s.maxHp, 0, 1), 4);
  }

  private hud(g: CanvasRenderingContext2D, w: number, h: number): void {
    const s = this.s;
    // XP bar.
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, w, 8);
    g.fillStyle = C.cyan; g.fillRect(0, 0, w * clamp(s.xp / xpFor(s.level), 0, 1), 8);
    g.textBaseline = 'top';
    g.font = `700 22px ${FONT.mono}`; g.textAlign = 'center';
    const left = Math.max(0, RUN_TIME - s.t);
    g.fillStyle = s.t >= RUN_TIME ? C.pink : C.text;
    g.fillText(s.t >= RUN_TIME ? 'BOSS' : fmt(left), w / 2, 16);
    g.font = `700 16px ${FONT.title}`; g.textAlign = 'left'; g.fillStyle = C.yellow;
    g.fillText(`LV ${s.level}`, 14, 16);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`;
    g.fillText(`${s.kills} kills`, 14, 38);
    let x = 14;
    for (const [id, L] of s.weapons) { this.icon(g, x, 58, WEAPONS[id].icon, WEAPONS[id].color, L); x += 30; }
    x = 14;
    for (const [id, L] of s.passives) { this.icon(g, x, 88, PASSIVES[id].icon, PASSIVES[id].color, L); x += 30; }
    if (this.bannerT > 0) {
      g.globalAlpha = Math.min(1, this.bannerT * 2);
      g.font = `700 40px ${FONT.title}`; g.textAlign = 'center'; g.fillStyle = C.yellow;
      g.fillText(this.banner, w / 2, h * 0.2);
      g.globalAlpha = 1;
    }
    if (this.levelFx > 0) {
      g.strokeStyle = rgba(C.yellow, this.levelFx); g.lineWidth = 6;
      g.beginPath(); g.arc(w / 2, h / 2, (1 - this.levelFx) * Math.max(w, h) * 0.6, 0, TAU); g.stroke();
    }
  }

  private icon(g: CanvasRenderingContext2D, x: number, y: number, ch: string, col: string, L: number): void {
    g.fillStyle = 'rgba(14,15,26,0.7)'; g.fillRect(x, y, 26, 26);
    g.strokeStyle = col; g.lineWidth = 1.5; g.strokeRect(x, y, 26, 26);
    g.fillStyle = col; g.font = `700 15px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(ch, x + 13, y + 12);
    g.font = `700 9px ${FONT.mono}`; g.fillStyle = '#fff'; g.fillText(String(L), x + 21, y + 21);
    g.textBaseline = 'top'; g.textAlign = 'left';
  }

  private cards(g: CanvasRenderingContext2D, w: number, h: number): void {
    const cards = this.s.choosing!;
    g.fillStyle = 'rgba(7,7,15,0.7)'; g.fillRect(0, 0, w, h);
    g.font = `700 32px ${FONT.title}`; g.fillStyle = C.yellow; g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText('LEVEL UP!', w / 2, h * 0.08);
    const portrait = h > w;
    const cw = portrait ? Math.min(320, w - 40) : Math.min(220, (w - 80) / 3), ch = portrait ? 110 : 250;
    this.cardRects = [];
    cards.forEach((c, i) => {
      const x = portrait ? (w - cw) / 2 : w / 2 + (i - (cards.length - 1) / 2) * (cw + 20) - cw / 2;
      const y = portrait ? h * 0.2 + i * (ch + 16) : h / 2 - ch / 2 + 20;
      const k = ease.outBack(clamp(this.levelFx > 0 ? 1 - this.levelFx + 0.2 - i * 0.08 : 1, 0, 1));
      this.cardRects.push({ x, y, w: cw, h: ch });
      g.save();
      g.translate(x + cw / 2, y + ch / 2); g.scale(k, k); g.translate(-cw / 2, -ch / 2);
      g.fillStyle = C.surface; g.fillRect(0, 0, cw, ch);
      g.strokeStyle = i === this.cardFocus ? C.yellow : rgba(c.color, 0.6); g.lineWidth = i === this.cardFocus ? 4 : 2; g.strokeRect(0, 0, cw, ch);
      g.fillStyle = c.color; g.font = `700 ${portrait ? 34 : 48}px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.icon, portrait ? 44 : cw / 2, portrait ? ch / 2 : 64);
      g.textAlign = portrait ? 'left' : 'center';
      const tx = portrait ? 86 : cw / 2;
      g.fillStyle = C.text; g.font = `700 18px ${FONT.title}`;
      g.fillText(c.name, tx, portrait ? 30 : 130);
      g.fillStyle = C.yellow; g.font = `700 13px ${FONT.title}`;
      g.fillText(c.kind === 'weapon' || c.kind === 'passive' ? (c.level === 1 ? 'NEW!' : `Lv ${c.level}`) : '', tx, portrait ? 52 : 154);
      g.fillStyle = C.muted; g.font = `500 13px ${FONT.ui}`;
      g.fillText(c.text, tx, portrait ? 76 : 184);
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = `600 12px ${FONT.mono}`;
      g.fillText(String(i + 1), portrait ? cw - 18 : cw / 2, portrait ? 18 : ch - 20);
      g.restore();
    });
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number> {
    const s = this.s;
    return { enemies: s.live, shots: s.shots.filter((q) => q.alive).length, gems: s.gems.filter((q) => q.alive).length, t: s.t, level: s.level };
  }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default (): Game => new TinySurvivors();
