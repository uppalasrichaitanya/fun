import type { Drone, MusicSpec } from '../../engine/audio';
import { drawGlow } from '../../engine/glow';
import { clamp, damp, TAU } from '../../engine/math';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { Autopilot } from './autopilot';
import { LEVELS } from './levels';
import { BODY, heightAt, LanderSim, LEGS, PHYS, type Input, type LevelDef, type Pt } from './sim';

const MUSIC: MusicSpec = {
  bpm: 84, root: 50, wave: 'triangle', pad: true, bass: true, gain: 0.6,
  chords: [[0, 7, 12, 15], [-2, 5, 10, 14], [-4, 3, 8, 12], [-5, 2, 7, 11]],
  arp: [0, 1, 2, 3, 2, 1],
};

const SKY: Record<LevelDef['world'], [string, string, string]> = {
  Moon: ['#141833', '#0B0C17', '#5C6385'],
  Mars: ['#3A1620', '#140A12', '#B5523B'],
  'Ice moon': ['#0F2A3A', '#08121C', '#7FC8D8'],
};

export const starsKey = 'rocket-lander:stars';
export const unlockKey = 'rocket-lander:unlocked';

interface Debris { x: number; y: number; vx: number; vy: number; a: number; va: number; s: number; color: string; life: number }
interface Streak { x: number; y: number; len: number; a: number }

class RocketLander implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private vis = new Rng();
  private demo = false;
  private li = 0;
  private sim!: LanderSim;
  private pilot!: Autopilot;
  private inp: Input = { left: false, right: false, thrust: false };
  private debris: Debris[] = [];
  private streaks: Streak[] = [];
  private stars: { x: number; y: number }[] = [];
  private zoom = 1; private camX = 0; private camY = 0; private scale = 1;
  private legSq = 0; private legSqV = 0;
  private endT = -1;
  private touchUI = false;
  private rumble: Drone | null = null;
  private whistle: Drone | null = null;
  private beepT = 0;
  private flicker = 0;
  private starShow = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.touchUI = matchMedia('(pointer: coarse)').matches;
    ctx.input.on('down', (p) => { if (p.type === 'touch') this.touchUI = true; });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    this.vis.seed(seed ^ 0x77);
    const unlocked = this.ctx.storage.get<number>(unlockKey, 1);
    this.li = this.demo ? this.rng.int(0, 9) : clamp((Number(opts?.mode) || unlocked) - 1, 0, Math.min(LEVELS.length, unlocked) - 1);
    this.load();
    this.ctx.audio.music(MUSIC);
  }

  private load(): void {
    const lv = LEVELS[this.li];
    this.sim = new LanderSim(lv);
    this.pilot = new Autopilot(this.sim);
    this.debris.length = 0;
    this.endT = -1;
    this.legSq = 0; this.legSqV = 0; this.starShow = 0;
    this.zoom = 1;
    this.camX = lv.w / 2; this.camY = lv.h / 2;
    this.stars = Array.from({ length: 70 }, () => ({ x: this.vis.range(0, lv.w), y: this.vis.range(0, lv.h * 0.7) }));
    this.streaks = Array.from({ length: lv.wind ? 40 : 0 }, () => ({ x: this.vis.range(0, lv.w), y: this.vis.range(lv.h * 0.2, lv.h), len: this.vis.range(10, 40), a: this.vis.range(0.2, 0.6) }));
  }

  // ---- input ---------------------------------------------------------------------

  private buttons(): { id: 'left' | 'right' | 'thrust'; x: number; y: number; r: number }[] {
    const { w, h } = this.ctx.canvas;
    const r = 44;
    return [
      { id: 'left', x: 20 + r, y: h - 20 - r, r },
      { id: 'right', x: 20 + r * 3 + 16, y: h - 20 - r, r },
      { id: 'thrust', x: w - 24 - r * 1.3, y: h - 24 - r * 1.3, r: r * 1.3 },
    ];
  }

  private readInput(): void {
    const i = this.ctx.input, o = this.inp;
    o.thrust = i.isDown('ArrowUp', 'KeyW', 'Space');
    o.left = i.isDown('ArrowLeft', 'KeyA');
    o.right = i.isDown('ArrowRight', 'KeyD');
    if (!this.touchUI) return;
    for (const p of i.pointers.values()) {
      if (!p.down) continue;
      for (const b of this.buttons()) if (Math.hypot(p.x - b.x, p.y - b.y) < b.r * 1.15) o[b.id] = true;
    }
  }

  // ---- update ------------------------------------------------------------------------

  update(dt: number): void {
    const sim = this.sim, { fx } = this.ctx;
    if (this.demo) this.inp = { ...this.pilot.update() };
    else if (this.ctx.input.enabled) this.readInput();
    else this.inp = { left: false, right: false, thrust: false };
    sim.step(dt, this.inp);
    this.handle(sim.events.splice(0));
    // Flame particles.
    if (sim.thrusting && sim.state === 'flying') {
      const [nx, ny] = sim.world([0, 22]);
      const dx = -Math.sin(sim.angle), dy = Math.cos(sim.angle);
      for (let k = 0; k < 3; k++) {
        const sp = this.vis.range(160, 260), spread = this.vis.range(-0.25, 0.25);
        const vx = (dx + spread * dy) * sp + sim.vx * 0.5, vy = (dy - spread * dx) * sp + sim.vy * 0.5;
        const col = k === 0 ? '#ffffff' : k === 1 ? C.yellow : C.orange;
        fx.particles.spawn(nx, ny, vx, vy, 0.18 + k * 0.12, 5 - k, 1, col, Shape.Glow, 0, 2);
      }
      if (sim.clearance() < 60 && this.vis.chance(0.5)) {
        const gx = sim.x, gy = sim.groundAt(sim.x);
        fx.particles.spawn(gx, gy - 2, this.vis.range(-120, 120), this.vis.range(-40, -5), 0.6, 6, 10, 'rgba(200,190,180,0.35)', Shape.Dot, 0, 2);
      }
    }
    // Legs spring (visual).
    this.legSqV += (-300 * this.legSq - 18 * this.legSqV) * dt;
    this.legSq += this.legSqV * dt;
    for (const d of this.debris) {
      d.vy += sim.level.gravity * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.a += d.va * dt; d.life -= dt;
      const gy = heightAt(sim.level.terrain, d.x);
      if (d.y > gy) { d.y = gy; d.vy *= -0.4; d.vx *= 0.7; d.va *= 0.6; }
    }
    // Wind streaks drift with the wind.
    const wind = sim.windAt();
    for (const s of this.streaks) {
      s.x += (wind * 6 + Math.sign(wind) * 40) * dt;
      if (s.x > sim.level.w + 50) s.x = -50;
      if (s.x < -50) s.x = sim.level.w + 50;
    }
    this.camera(dt);
    this.sound(dt);
    if (this.endT >= 0) {
      this.endT += dt;
      if (sim.state === 'landed') this.starShow += dt;
      if (this.demo && this.endT > 2.4) { this.li = this.rng.int(0, 9); this.load(); }
    }
    this.flicker += dt;
  }

  private handle(events: LanderSim['events']): void {
    const sim = this.sim, { fx, audio } = this.ctx;
    for (const e of events) {
      if (e.type === 'pickup') {
        fx.particles.burst(e.x, e.y, C.green, { count: 18, speed: 160, size: 4 });
        fx.floaters.add('+FUEL', e.x, e.y - 20, C.green, 18);
        audio.sparkle(880);
      } else if (e.type === 'empty') {
        audio.tone({ f: 220, f2: 110, type: 'square', d: 0.3, g: 0.06, lp: 900 });
      } else if (e.type === 'checkpoint') {
        this.touchdown(e.info.butter);
        fx.floaters.add('PAD A ✓  Take off for pad B', sim.x, sim.y - 60, C.green, 18);
      } else if (e.type === 'land') {
        this.touchdown(e.info.butter);
        this.endT = 0;
        if (!this.demo) this.finish(true);
      } else if (e.type === 'crash') {
        this.endT = 0;
        fx.time.hitStop(80);
        fx.camera.shake(0.7);
        audio.shatter();
        audio.tone({ f: 90, f2: 30, type: 'sine', d: 0.9, g: 0.5 });
        fx.particles.burst(e.x, e.y, C.orange, { count: 40, speed: 380, size: 7, life: 0.9, colors: [C.yellow, C.orange, '#fff'] });
        for (let k = 0; k < 30; k++) {
          const a = this.vis.range(0, TAU), sp = this.vis.range(60, 320);
          this.debris.push({
            x: e.x, y: e.y, vx: Math.cos(a) * sp + e.vx * 0.3, vy: Math.sin(a) * sp - 120, a: 0, va: this.vis.range(-12, 12),
            s: this.vis.range(3, 9), color: this.vis.pick(['#E8E8F0', C.orange, '#9AA0B8', C.pink]), life: 6,
          });
        }
        if (!this.demo) this.finish(false, e.reason);
      }
    }
  }

  private touchdown(butter: boolean): void {
    const sim = this.sim, { fx, audio } = this.ctx;
    this.legSqV = 4;
    audio.thud(0.7);
    const [lx, ly] = sim.world(LEGS[0]), [rx, ry] = sim.world(LEGS[1]);
    for (const [x, y] of [[lx, ly], [rx, ry]]) fx.particles.burst(x, y, 'rgba(220,210,200,0.6)', { count: 10, speed: 90, size: 5, sizeEnd: 9, life: 0.7, shape: Shape.Dot, angle: -Math.PI / 2, spread: 2.4 });
    if (butter) {
      audio.chime(7, 0.18);
      fx.particles.sparkle(sim.x, sim.y + 20, C.yellow, 16, 40);
      fx.floaters.add('BUTTER!', sim.x, sim.y - 50, C.yellow, 24);
    }
  }

  private finish(landed: boolean, reason = ''): void {
    const sim = this.sim, lv = sim.level, st = this.ctx.storage;
    const L = sim.landing;
    if (landed && L) {
      const stars = st.get<Record<string, number>>(starsKey, {});
      stars[lv.id] = Math.max(stars[lv.id] ?? 0, L.stars);
      st.set(starsKey, stars);
      st.set(unlockKey, Math.max(st.get<number>(unlockKey, 1), Math.min(LEVELS.length, lv.id + 1)));
      [0, 1, 2].slice(0, L.stars).forEach((k) => this.ctx.audio.chime(4 + k * 2, 0.16 + k * 0.02));
    }
    const fuel = `${Math.round(sim.fuel)}%`;
    this.ctx.shell.gameOver(landed && L ? {
      score: L.score, title: L.butter ? 'Butter landing!' : 'Touchdown!',
      rank: '★'.repeat(L.stars) + '☆'.repeat(3 - L.stars),
      stats: [
        { label: 'landing speed', value: `${L.vy.toFixed(1)} u/s` },
        { label: 'tilt', value: `${((L.tilt * 180) / Math.PI).toFixed(1)}°` },
        { label: 'fuel left', value: fuel },
      ],
      next: lv.id < LEVELS.length ? { label: 'Next level', mode: String(lv.id + 1) } : undefined,
      share: `Pocket Arcade - Rocket Lander level ${lv.id}: ${'★'.repeat(L.stars)} ${L.score} pts`,
    } : {
      score: 0, title: 'Crashed!', rank: reason, noScore: true,
      stats: [
        { label: 'impact speed', value: `${Math.hypot(sim.vx, sim.vy).toFixed(0)} u/s` },
        { label: 'tilt', value: `${((Math.abs(sim.angle) * 180) / Math.PI).toFixed(0)}°` },
        { label: 'fuel left', value: fuel },
      ],
    }, landed ? 1500 : 900);
  }

  private camera(dt: number): void {
    const sim = this.sim, lv = sim.level, { w, h } = this.ctx.canvas;
    const base = Math.min(w / lv.w, h / lv.h);
    // Fit the level when high, zoom toward the rocket near the ground (up to 1.8x within 120 u).
    const c = clamp(sim.clearance(), 0, 400);
    const want = sim.state === 'crashed' ? 1.3 : 1 + 0.8 * ease.inOutSine(clamp((120 - c) / 120, 0, 1));
    this.zoom = damp(this.zoom, want, 3, dt);
    this.scale = base * this.zoom;
    const k = (this.zoom - 1) / 0.8;
    let cx = lv.w / 2 + (sim.x - lv.w / 2) * k, cy = lv.h / 2 + (sim.y - lv.h / 2) * k;
    const vw = w / this.scale, vh = h / this.scale;
    if (vw < lv.w) cx = clamp(cx, vw / 2, lv.w - vw / 2); else cx = lv.w / 2;
    if (vh < lv.h) cy = clamp(cy, vh / 2, lv.h - vh / 2); else cy = lv.h / 2;
    this.camX = damp(this.camX, cx, 6, dt);
    this.camY = damp(this.camY, cy, 6, dt);
  }

  private sound(dt: number): void {
    const { audio } = this.ctx, sim = this.sim;
    if (this.ctx.preview) return;
    if (!this.rumble) this.rumble = audio.drone('noise', 160);
    const on = sim.thrusting && sim.state === 'flying';
    this.rumble.set(on ? 200 : 140, on ? 0.22 : 0, on ? 0.04 : 0.12);
    if (sim.level.wind) {
      if (!this.whistle) this.whistle = audio.drone('noise', 2200);
      const w = Math.abs(sim.windAt());
      this.whistle.set(1600 + w * 40, Math.min(0.06, w * 0.0015), 0.3);
    }
    if (sim.fuel < 15 && sim.fuel > 0 && sim.state === 'flying') {
      this.beepT -= dt;
      if (this.beepT <= 0) { audio.tone({ f: 1320, type: 'square', d: 0.06, g: 0.05, lp: 3000 }); this.beepT = 0.5; }
    }
  }

  // ---- render --------------------------------------------------------------------

  render(): void {
    const { canvas, fx } = this.ctx;
    const sim = this.sim, lv = sim.level;
    const sky = SKY[lv.world];
    const g = canvas.begin(sky[1]);
    const { w, h } = canvas;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, sky[1]); grad.addColorStop(1, sky[0]);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    fx.camera.begin(g, w, h);
    g.save();
    g.translate(w / 2, h / 2);
    g.scale(this.scale, this.scale);
    g.translate(-this.camX, -this.camY);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    for (const s of this.stars) g.fillRect(s.x, s.y, 1.5, 1.5);
    // Wind streaks: denser and brighter in gusts, so gusts are telegraphed.
    const wind = sim.windAt();
    if (this.streaks.length) {
      g.strokeStyle = rgba('#E0A080', Math.min(0.5, Math.abs(wind) / 60));
      g.lineWidth = 1.5;
      g.beginPath();
      for (const s of this.streaks) { g.moveTo(s.x, s.y); g.lineTo(s.x - Math.sign(wind) * s.len * (0.5 + Math.abs(wind) / 30), s.y); }
      g.stroke();
    }
    this.terrain(g, lv.terrain, sky[2], false, lv);
    if (lv.ceiling) this.terrain(g, lv.ceiling, sky[2], true, lv);
    lv.pads.forEach((_, i) => this.pad(g, i));
    (lv.pickups ?? []).forEach(([x, y], i) => {
      if (sim.taken[i]) return;
      const b = Math.sin(this.flicker * 3 + i) * 3;
      drawGlow(g, C.green, x, y + b, 26, 0.6);
      g.fillStyle = C.green;
      g.fillRect(x - 6, y - 9 + b, 12, 18);
      g.fillStyle = C.bg;
      g.font = `700 10px ${FONT.title}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('F', x, y + b + 1);
    });
    // Flame light on nearby terrain.
    if (sim.thrusting && sim.state === 'flying' && sim.clearance() < 100) {
      drawGlow(g, C.orange, sim.x, sim.groundAt(sim.x), 90 - sim.clearance() * 0.6, 0.5);
    }
    fx.particles.render(g);
    if (sim.state !== 'crashed') this.rocket(g);
    for (const d of this.debris) {
      if (d.life <= 0) continue;
      g.save(); g.translate(d.x, d.y); g.rotate(d.a);
      g.fillStyle = d.color; g.globalAlpha = Math.min(1, d.life);
      g.fillRect(-d.s / 2, -d.s / 3, d.s, d.s * 0.66);
      g.restore();
    }
    fx.floaters.render(g);
    g.restore();
    fx.camera.end(g);
    if (!this.ctx.preview && !this.demo) {
      this.hud(g);
      if (this.touchUI && this.endT < 0) this.drawButtons(g);
      if (sim.state === 'landed' && sim.landing) this.drawStars(g, w, h, sim.landing.stars);
      if (sim.t < 2.5 && lv.hint && !this.demo) {
        g.globalAlpha = clamp(2.5 - sim.t, 0, 1);
        g.font = `600 17px ${FONT.ui}`; g.fillStyle = C.text; g.textAlign = 'center';
        g.fillText(lv.hint, w / 2, h - (this.touchUI ? 130 : 40));
        g.globalAlpha = 1;
      }
    }
  }

  private terrain(g: CanvasRenderingContext2D, line: Pt[], col: string, ceiling: boolean, lv: LevelDef): void {
    g.beginPath();
    g.moveTo(-200, ceiling ? -400 : lv.h + 400);
    g.lineTo(-200, line[0][1]);
    for (const [x, y] of line) g.lineTo(x, y);
    g.lineTo(lv.w + 200, line[line.length - 1][1]);
    g.lineTo(lv.w + 200, ceiling ? -400 : lv.h + 400);
    g.closePath();
    const grad = g.createLinearGradient(0, ceiling ? 0 : lv.h * 0.4, 0, ceiling ? lv.h * 0.5 : lv.h);
    grad.addColorStop(0, ceiling ? rgba(col, 0.2) : rgba(col, 0.75));
    grad.addColorStop(1, ceiling ? rgba(col, 0.7) : rgba(col, 0.35));
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = col; g.lineWidth = 2.5 / this.zoom; g.lineJoin = 'round';
    g.beginPath();
    line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }

  private pad(g: CanvasRenderingContext2D, i: number): void {
    const sim = this.sim, q = sim.padAt(i), def = sim.level.pads[i];
    const route = sim.route;
    const target = route.length ? route[Math.min(sim.routeStep, route.length - 1)] === i : true;
    const done = route.length > 0 && route.indexOf(i) >= 0 && route.indexOf(i) < sim.routeStep;
    const col = done ? C.green : target ? C.cyan : C.muted;
    if (def.move) {
      g.fillStyle = '#2A3352';
      g.fillRect(q.x1, q.y, q.x2 - q.x1, 10);
    }
    drawGlow(g, col, (q.x1 + q.x2) / 2, q.y, (q.x2 - q.x1) * 0.7, target ? 0.35 : 0.15);
    g.fillStyle = col;
    g.fillRect(q.x1, q.y - 3, q.x2 - q.x1, 4);
    const blink = Math.sin(this.flicker * 5 + i) > 0;
    g.fillStyle = blink ? C.yellow : rgba(C.yellow, 0.3);
    g.beginPath(); g.arc(q.x1 + 3, q.y - 6, 3, 0, TAU); g.arc(q.x2 - 3, q.y - 6, 3, 0, TAU); g.fill();
    g.font = `700 ${Math.round(14 / Math.max(1, this.zoom * 0.8))}px ${FONT.title}`;
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = col;
    const label = route.length ? `${String.fromCharCode(65 + route.indexOf(i))} x${def.mult}` : `x${def.mult}`;
    g.fillText(label, (q.x1 + q.x2) / 2, q.y + 6);
  }

  private rocket(g: CanvasRenderingContext2D): void {
    const sim = this.sim;
    g.save();
    g.translate(sim.x, sim.y);
    g.rotate(sim.angle);
    const sq = clamp(this.legSq, -0.3, 0.4) * 6;
    // Legs.
    g.strokeStyle = '#B9BED6'; g.lineWidth = 3; g.lineCap = 'round';
    for (const [lx, ly] of LEGS) {
      g.beginPath(); g.moveTo(lx * 0.6, 12); g.lineTo(lx, ly - sq); g.stroke();
      g.beginPath(); g.moveTo(lx - 4, ly - sq); g.lineTo(lx + 4, ly - sq); g.stroke();
    }
    // Body.
    const { w, h } = BODY;
    g.fillStyle = '#EDEFF7';
    g.beginPath();
    g.moveTo(0, -h / 2 - 8);
    g.quadraticCurveTo(w / 2, -h / 2 + 2, w / 2, -h / 2 + 10);
    g.lineTo(w / 2, h / 2 - 2); g.lineTo(-w / 2, h / 2 - 2); g.lineTo(-w / 2, -h / 2 + 10);
    g.quadraticCurveTo(-w / 2, -h / 2 + 2, 0, -h / 2 - 8);
    g.fill();
    g.fillStyle = C.orange;
    g.fillRect(-w / 2, h / 2 - 12, w, 6);
    g.fillStyle = '#2A3B6E';
    g.beginPath(); g.arc(0, -6, 5.5, 0, TAU); g.fill();
    g.fillStyle = C.cyan;
    g.beginPath(); g.arc(-1.5, -7.5, 2, 0, TAU); g.fill();
    g.fillStyle = '#7A809C';
    g.fillRect(-7, h / 2 - 2, 14, 5);
    g.restore();
  }

  private hud(g: CanvasRenderingContext2D): void {
    const sim = this.sim, lv = sim.level;
    const x = 14, y = 12;
    g.fillStyle = 'rgba(14,15,26,0.72)';
    roundRect(g, x, y, 236, 118, 14); g.fill();
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = C.muted;
    g.font = `600 12px ${FONT.ui}`;
    g.fillText(`${lv.world.toUpperCase()} · LEVEL ${lv.id}`, x + 12, y + 10);
    g.fillStyle = C.text;
    g.font = `700 17px ${FONT.title}`;
    g.fillText(lv.name, x + 12, y + 26);
    // Fuel bar.
    const f = sim.fuel / PHYS.fuel;
    const fc = f < 0.15 ? (Math.sin(this.flicker * 12) > 0 ? C.pink : rgba(C.pink, 0.3)) : f < 0.3 ? C.orange : C.green;
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x + 12, y + 52, 140, 8);
    g.fillStyle = fc; g.fillRect(x + 12, y + 52, 140 * f, 8);
    g.font = `500 12px ${FONT.mono}`; g.fillStyle = C.muted;
    g.fillText(`FUEL ${Math.round(sim.fuel)}`, x + 160, y + 50);
    // Speeds: green when within safe limits, gold when butter-soft.
    const vy = sim.vy, vx = sim.vx - (sim.lastPad >= 0 ? sim.padAt(sim.lastPad).vx : 0);
    const vCol = vy < PHYS.butterVy ? C.yellow : vy < PHYS.safeVy ? C.green : C.pink;
    const hCol = Math.abs(vx) < PHYS.safeVx ? C.green : C.pink;
    g.font = `500 14px ${FONT.mono}`;
    g.fillStyle = vCol; g.fillText(`V ${vy.toFixed(0).padStart(4)}`, x + 12, y + 68);
    g.fillStyle = hCol; g.fillText(`H ${vx.toFixed(0).padStart(4)}`, x + 12, y + 88);
    g.fillStyle = C.muted; g.fillText(`ALT ${Math.max(0, sim.altitude()).toFixed(0).padStart(4)}`, x + 96, y + 68);
    // Tilt arc.
    const cx = x + 200, cy = y + 92, r = 18;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, r, -Math.PI, 0); g.stroke();
    g.strokeStyle = rgba(C.green, 0.45);
    g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2 - PHYS.safeTilt, -Math.PI / 2 + PHYS.safeTilt); g.stroke();
    const ok = Math.abs(sim.angle) <= PHYS.safeTilt;
    g.strokeStyle = ok ? C.green : C.pink; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(sim.angle) * (r + 4), cy - Math.cos(sim.angle) * (r + 4)); g.stroke();
    // Wind arrow.
    if (lv.wind) {
      const wv = sim.windAt();
      const ax = x + 120, ay = y + 96, len = clamp(wv, -40, 40);
      g.strokeStyle = '#E0A080'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(ax - len / 2, ay); g.lineTo(ax + len / 2, ay);
      g.lineTo(ax + len / 2 - Math.sign(len) * 6, ay - 5); g.moveTo(ax + len / 2, ay); g.lineTo(ax + len / 2 - Math.sign(len) * 6, ay + 5);
      g.stroke();
      g.font = `500 10px ${FONT.mono}`; g.fillStyle = C.muted; g.textAlign = 'center';
      g.fillText('WIND', ax, ay + 8);
    }
  }

  private drawButtons(g: CanvasRenderingContext2D): void {
    for (const b of this.buttons()) {
      const on = this.inp[b.id];
      g.fillStyle = on ? 'rgba(255,159,67,0.45)' : 'rgba(255,255,255,0.10)';
      g.beginPath(); g.arc(b.x, b.y, b.r, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 2; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = `700 ${b.id === 'thrust' ? 18 : 26}px ${FONT.title}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(b.id === 'left' ? '⟲' : b.id === 'right' ? '⟳' : 'THRUST', b.x, b.y);
    }
  }

  /** Stars fly in one by one before the panel. */
  private drawStars(g: CanvasRenderingContext2D, w: number, h: number, n: number): void {
    for (let k = 0; k < 3; k++) {
      const t = clamp((this.starShow - 0.15 - k * 0.25) / 0.35, 0, 1);
      if (t <= 0) continue;
      const s = ease.outBack(t);
      const x = w / 2 + (k - 1) * 70, y = h * 0.3;
      g.save(); g.translate(x, y); g.scale(s, s);
      star(g, 26, k < n ? C.yellow : 'rgba(255,255,255,0.18)');
      g.restore();
    }
  }

  pause(): void { this.rumble?.set(140, 0, 0.05); this.whistle?.set(1600, 0, 0.05); }
  resume(): void {}
  destroy(): void {
    this.rumble?.stop(); this.whistle?.stop();
    this.ctx.audio.stopMusic();
  }
  debugInfo(): Record<string, number | string> {
    const s = this.sim;
    return { level: s.level.id, vx: s.vx, vy: s.vy, tilt: (s.angle * 180) / Math.PI, fuel: s.fuel, state: s.state };
  }
}

function star(g: CanvasRenderingContext2D, r: number, col: string): void {
  g.fillStyle = col;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export default (): Game => new RocketLander();
