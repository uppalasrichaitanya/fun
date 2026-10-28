import { midiHz } from '../../engine/audio';
import { History, undoKey } from '../../engine/editor/history';
import { drawBtn, drawBudget, fitText, hitBtn, InventoryBar, roundRect, titleRoom, type Btn, type InvItem } from '../../engine/editor/ui';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import {
  addBeam, beamCost, boatClash, Bridge, compact, DT, GRAVITY, GRID, MATS, mirror, pointAt, pointXY, starsMet, VEHICLES,
  type BLevel, type Design, type Mat,
} from './logic';
import { pack } from './pack';

const ACCENT = C.orange;
const BLUEPRINT = '#1B4F8F';
const CHAPTER_ROCK = ['#6B4F3A', '#B5603A', '#5D6273'];
const CHAPTER_TOP = ['#5FA04A', '#D98A4E', '#E8EEF5'];

type Phase = 'build' | 'test' | 'end';

interface Debris { x: number; y: number; vx: number; vy: number; a: number; va: number; len: number; mat: Mat; wet: boolean; life: number }

/** Green (0) → yellow (0.6) → red (0.9+). */
function stressColor(s: number): string {
  const lerp = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const G = [74, 222, 128], Y = [255, 217, 61], R = [255, 64, 80];
  const c = s < 0.6 ? lerp(G, Y, s / 0.6) : lerp(Y, R, Math.min(1, (s - 0.6) / 0.3));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

class BridgeIt implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level!: Level<BLevel>;
  private def!: BLevel;
  private design: Design = { joints: [], beams: [] };
  private hist = new History<Design>(100);
  private mat: Mat = 'road';
  private phase: Phase = 'build';
  private phaseT = 0;
  private sim: Bridge | null = null;
  private acc = 0;
  private seen = 0;
  private wet: Uint8Array = new Uint8Array(0);
  private debris: Debris[] = [];
  private inv = new InventoryBar();
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  // View: world → screen.
  private sc = 1;
  private ox = 0;
  private oy = 0;
  private zoom = 1;
  private view = { x0: 0, x1: 0, y0: 0, y1: 0 };
  // Building.
  private drag: { from: number; id: number; x: number; y: number; moved: boolean } | null = null;
  private sel: number | null = null;
  private denied: { x: number; y: number; t: number } | null = null;
  private weak: [number, number, number, number] | null = null;
  private banner: { text: string; t: number; color: string } | null = null;
  private clock = 0;
  private idle = 0;
  private demo = false;
  private demoT = 0;
  private seed = 1;
  private won = false;
  private creakT = 0;
  private groanT = 0;
  private slowed = false;
  private boatX = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', (p) => this.up(p));
    ctx.input.on('alt', (p) => { if (this.phase === 'build') { this.sel = null; this.deleteAt(p.x, p.y); } });
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      this.idle = 0;
      const u = undoKey(code, e);
      if (u && this.phase === 'build') { e.preventDefault(); this.button(u); return; }
      if (code === 'Space' || code === 'Enter') { e.preventDefault(); this.button(this.phase === 'build' ? 'test' : 'stop'); }
      else if (code === 'Escape') this.sel = null;
      else if (code === 'KeyM' && this.phase === 'build') this.button('mirror');
      else if (/^Digit[1-5]$/.test(code)) { const sl = this.inv.slots[Number(code.slice(5)) - 1]; if (sl) this.pick(sl.item.kind as Mat); }
    });
  }

  captureKey(code: string): boolean { return code === 'Escape' && this.sel !== null; }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 2); lv = pool[seed % pool.length] ?? lv; }
    this.load(lv);
  }

  private load(level: Level<BLevel>): void {
    this.level = level;
    this.def = level.def;
    this.design = { joints: [], beams: [] };
    this.hist.clear();
    this.mat = this.def.mats.find((m) => MATS[m].road) ?? this.def.mats[0];
    this.weak = null; this.sel = null; this.drag = null;
    this.idle = 0; this.demoT = 0; this.won = false;
    const anchorsY = this.def.anchors.map((a) => a[1]);
    this.view = { x0: this.def.gap[0] - 170, x1: this.def.gap[1] + 150, y0: Math.min(-70, Math.min(...anchorsY) - 50), y1: this.def.water + 60 };
    this.toBuild();
  }

  private toBuild(): void {
    this.phase = 'build'; this.phaseT = 0;
    this.sim = null; this.acc = 0; this.debris = []; this.zoom = 1;
  }

  // ---- coordinates ----------------------------------------------------------------

  private sx(x: number): number { return this.ox + x * this.sc; }
  private sy(y: number): number { return this.oy + y * this.sc; }
  private world(px: number, py: number): [number, number] { return [(px - this.ox) / this.sc, (py - this.oy) / this.sc]; }
  private snap(px: number, py: number): [number, number] {
    const [x, y] = this.world(px, py);
    return [Math.round(x / GRID) * GRID, Math.round(y / GRID) * GRID];
  }

  /** The anchor or joint under the pointer, if any. */
  private pointNear(px: number, py: number): number {
    const n = this.def.anchors.length + this.design.joints.length;
    let best = -1, bd = Math.max(16, this.sc * 10);
    for (let i = 0; i < n; i++) {
      const [x, y] = pointXY(this.def, this.design, i);
      const d = Math.hypot(this.sx(x) - px, this.sy(y) - py);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  private beamNear(px: number, py: number): number {
    let best = -1, bd = 10;
    this.design.beams.forEach(([a, b], i) => {
      const [ax, ay] = pointXY(this.def, this.design, a), [bx, by] = pointXY(this.def, this.design, b);
      const x0 = this.sx(ax), y0 = this.sy(ay), x1 = this.sx(bx), y1 = this.sy(by);
      const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L2));
      const d = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Where a new joint may go: open air over the gap or above the cliffs, never inside rock or water. */
  private spotOk(x: number, y: number): boolean {
    if (pointAt(this.def, this.design, x, y) >= 0) return true;
    const { x0, x1, y0 } = this.view;
    if (x < x0 + 10 || x > x1 - 10 || y < y0 + 10 || y > this.def.water - 20) return false;
    if ((x <= this.def.gap[0] || x >= this.def.gap[1]) && y >= 0) return false;
    const r = this.def.rock;
    if (r && Math.abs(x - r[0]) <= r[2] && y >= r[1]) return false;
    return true;
  }

  // ---- building -------------------------------------------------------------------

  private down(p: Pointer): void {
    if (this.demo) return;
    this.idle = 0;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    const slot = this.inv.at(p.x, p.y);
    if (slot) { this.pick(slot.item.kind as Mat); return; }
    if (this.phase !== 'build') return;
    const pt = this.pointNear(p.x, p.y);
    if (pt >= 0) {
      if (this.sel !== null && this.sel !== pt) { const [x, y] = pointXY(this.def, this.design, pt); this.build(this.sel, x, y); this.sel = null; return; }
      const [x, y] = pointXY(this.def, this.design, pt);
      this.drag = { from: pt, id: p.id, x, y, moved: false };
      return;
    }
    if (this.sel !== null) { const [x, y] = this.snap(p.x, p.y); this.build(this.sel, x, y); this.sel = null; return; }
    this.deleteAt(p.x, p.y);
  }

  private move(p: Pointer): void {
    const d = this.drag;
    if (!d || d.id !== p.id || !p.down) return;
    const [x, y] = this.snap(p.x, p.y);
    const [fx, fy] = pointXY(this.def, this.design, d.from);
    if (x !== d.x || y !== d.y) { d.x = x; d.y = y; if (x !== fx || y !== fy) { d.moved = true; this.ctx.audio.tick(2400, 0.02); } }
  }

  private up(p: Pointer): void {
    this.pressBtn = null;
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    this.drag = null;
    const [fx, fy] = pointXY(this.def, this.design, d.from);
    if (d.moved && (d.x !== fx || d.y !== fy)) this.build(d.from, d.x, d.y);
    else this.sel = this.sel === d.from ? null : d.from;
  }

  private pick(m: Mat): void {
    if (this.mat !== m) this.ctx.audio.tick(1500, 0.05);
    this.mat = m;
  }

  private build(from: number, x: number, y: number): void {
    const [fx, fy] = pointXY(this.def, this.design, from);
    if (fx === x && fy === y) return;
    const next = structuredClone(this.design);
    const added = addBeam(this.def, next, fx, fy, x, y, this.mat);
    const bad = next.joints.find(([jx, jy]) => !this.spotOk(jx, jy));
    if (bad) { this.deny(bad[0], bad[1], bad[1] >= 0 && (bad[0] <= this.def.gap[0] || bad[0] >= this.def.gap[1]) ? 'That is solid rock' : null); return; }
    if (boatClash(this.def, next)) { this.deny(x, y, 'Leave the channel clear for the boat'); return; }
    if (!added && JSON.stringify(next) === JSON.stringify(this.design)) return;
    this.hist.push(this.design);
    this.design = next;
    this.weak = null;
    const a = this.ctx.audio;
    const M = MATS[this.mat];
    if (this.mat === 'cable') a.tone({ f: 520, f2: 760, type: 'triangle', a: 0.002, d: 0.12, g: 0.07 });
    else if (this.mat === 'steel') { a.tone({ f: 1300, f2: 1250, type: 'square', a: 0.001, d: 0.12, g: 0.04, lp: 3000 }); a.thud(0.25); }
    else { a.pop(this.mat === 'wood' ? 420 : 300, 0.16); a.noise({ d: 0.05, g: 0.06, f: 1600, type: 'bandpass', q: 2 }); }
    const ex = this.sx(x), ey = this.sy(y);
    this.ctx.fx.particles.burst(ex, ey, M.color, { count: 6, speed: 60, life: 0.35, size: 2.5, sizeEnd: 0, shape: Shape.Dot, gravity: 200 });
  }

  private deleteAt(px: number, py: number): void {
    const bi = this.beamNear(px, py);
    if (bi < 0) return;
    this.hist.push(this.design);
    const next = structuredClone(this.design);
    next.beams.splice(bi, 1);
    this.design = compact(this.def, next);
    this.ctx.audio.pop(220, 0.14);
    this.ctx.fx.particles.burst(px, py, C.muted, { count: 8, speed: 80, life: 0.4, size: 2.5, sizeEnd: 0, shape: Shape.Dot, gravity: 300 });
  }

  private deny(x: number, y: number, text: string | null): void {
    this.denied = { x, y, t: 0.5 };
    this.ctx.audio.buzz();
    if (text) this.say(text, C.pink);
  }

  private say(text: string, color: string, t = 1.8): void { this.banner = { text, t, color }; }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'undo' || id === 'redo') {
      if (this.phase !== 'build') return;
      const s = id === 'undo' ? this.hist.undo(this.design) : this.hist.redo(this.design);
      if (!s) { a.buzz(); return; }
      this.design = s; this.sel = null; a.tick(1300, 0.06);
    } else if (id === 'clear') {
      if (this.phase !== 'build' || !this.design.beams.length) return;
      this.hist.push(this.design); this.design = { joints: [], beams: [] }; this.sel = null; a.whoosh(0.12, 0.2);
    } else if (id === 'mirror') {
      if (this.phase !== 'build' || !this.design.beams.length) return;
      const next = mirror(this.def, this.design);
      const bad = next.joints.find(([x, y]) => !this.spotOk(x, y));
      if (bad || boatClash(this.def, next)) { this.deny(bad?.[0] ?? 0, bad?.[1] ?? 0, 'The mirror image would not fit'); return; }
      if (JSON.stringify(next) === JSON.stringify(this.design)) { this.say('Already symmetrical', C.muted, 1.2); return; }
      this.hist.push(this.design); this.design = next; a.whoosh(0.1, 0.25); a.sparkle(880);
    } else if (id === 'test') {
      if (this.phase !== 'build') return;
      if (!this.design.beams.some(([, , m]) => MATS[m].road)) { this.say('Build some road first', C.pink); a.buzz(); return; }
      this.test();
    } else if (id === 'stop') {
      if (this.phase === 'build') return;
      if (this.phase === 'end' && this.won) return;
      this.toBuild(); a.whoosh(0.1, 0.2);
    }
  }

  private test(): void {
    this.sel = null; this.drag = null;
    this.sim = new Bridge(this.def, this.design);
    this.phase = 'test'; this.phaseT = 0; this.acc = 0; this.seen = 0;
    this.wet = new Uint8Array(this.sim.x.length);
    this.debris = []; this.slowed = false; this.weak = null;
    this.boatX = this.view.x0 - 60;
    const a = this.ctx.audio;
    // Engine start.
    a.tone({ f: 70, f2: 110, type: 'sawtooth', a: 0.02, d: 0.5, g: 0.08, lp: 500 });
  }

  // ---- loop ---------------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt; this.idle += dt; this.phaseT += dt;
    if (this.denied && (this.denied.t -= dt) <= 0) this.denied = null;
    if (this.banner && (this.banner.t -= dt) <= 0) this.banner = null;
    if (this.demo) this.demoTick();
    if (this.phase === 'test' && this.sim) this.testTick(dt);
    this.debrisTick(dt);
    if (this.phase === 'end' && this.won) this.zoom += (0.86 - this.zoom) * Math.min(1, dt * 2);
    if (this.phase === 'end' && !this.won && this.phaseT > 2.6 && !this.demo) this.toBuild();
    if (this.def.boat && this.phase !== 'build') this.boatX += dt * 40;
  }

  private testTick(dt: number): void {
    const s = this.sim!;
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && s.outcome === 'run' && n < 8) { s.step(); this.acc -= DT; n++; }
    // Breaks since last frame.
    while (this.seen < s.broke.length) this.breakFx(s.broke[this.seen++]);
    // Pieces hitting the river.
    for (let i = s.nAnchor; i < s.x.length; i++) {
      if (!this.wet[i] && s.y[i] > this.def.water) { this.wet[i] = 1; this.splash(s.x[i], i >= s.x.length - s.vehicles.length * 4 ? 1 : 0.4); }
    }
    this.stressFx(s, dt);
    if (s.outcome !== 'run') this.finishTest();
  }

  private stressFx(s: Bridge, dt: number): void {
    this.creakT -= dt; this.groanT -= dt;
    let wood = 0, steel = 0, top = 0, topBeam = -1;
    s.beams.forEach((b, i) => {
      if (!b.alive) return;
      if (b.mat === 'steel' || b.mat === 'cable') steel = Math.max(steel, b.stress); else wood = Math.max(wood, b.stress);
      if (b.stress > top) { top = b.stress; topBeam = i; }
    });
    const a = this.ctx.audio;
    if (wood > 0.45 && this.creakT <= 0) {
      a.tone({ f: 110 + wood * 90 + this.rng.range(-10, 10), f2: 95 + wood * 70, type: 'triangle', a: 0.03, d: 0.22, g: 0.03 + wood * 0.07, lp: 700 });
      this.creakT = 0.5 - wood * 0.3 + this.rng.range(0, 0.2);
    }
    if (steel > 0.5 && this.groanT <= 0) {
      a.tone({ f: 55 + steel * 30, f2: 48 + steel * 20, type: 'sawtooth', a: 0.08, d: 0.6, g: 0.03 + steel * 0.05, lp: 380 });
      this.groanT = 0.8 + this.rng.range(0, 0.3);
    }
    if (top > 0.9 && topBeam >= 0) {
      if (this.rng.next() < dt * 6) a.tone({ f: 880, f2: 860, type: 'sine', a: 0.01, d: 0.15, g: 0.03 });
      // A short slow-mo when the vehicle is right on the strained beam.
      const b = s.beams[topBeam];
      const lo = Math.min(s.x[b.a], s.x[b.b]) - 10, hi = Math.max(s.x[b.a], s.x[b.b]) + 10;
      const on = s.vehicles.some((v) => v.wheels.some((w) => s.x[w] > lo && s.x[w] < hi));
      if (on && !this.slowed && this.ctx.settings.motion) { this.slowed = true; this.ctx.fx.time.slowMo(0.35, 500); }
    }
  }

  private breakFx(b: Bridge['beams'][number]): void {
    const s = this.sim!;
    const ax = s.x[b.a], ay = s.y[b.a], bx = s.x[b.b], by = s.y[b.b];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const ang = Math.atan2(by - ay, bx - ax), len = b.rest;
    const vx = (s.vx[b.a] + s.vx[b.b]) / 2, vy = (s.vy[b.a] + s.vy[b.b]) / 2;
    // Two halves tumble away; the sim drops the beam itself.
    for (const k of [-1, 1]) {
      this.debris.push({
        x: mx + Math.cos(ang) * len * 0.25 * k, y: my + Math.sin(ang) * len * 0.25 * k,
        vx: vx * 0.6 + k * this.rng.range(10, 40), vy: vy * 0.6 - this.rng.range(0, 40),
        a: ang, va: k * this.rng.range(2, 6), len: len * 0.48, mat: b.mat, wet: false, life: 6,
      });
    }
    if (!this.weak) {
      const [p, q] = [pointXY(this.def, this.design, b.a), pointXY(this.def, this.design, b.b)];
      this.weak = [p[0], p[1], q[0], q[1]];
    }
    const a = this.ctx.audio;
    if (b.mat === 'cable') a.tone({ f: 1400, f2: 300, type: 'sawtooth', a: 0.001, d: 0.25, g: 0.1, lp: 4000 });
    else if (b.mat === 'steel') { a.tone({ f: 260, f2: 120, type: 'square', a: 0.001, d: 0.3, g: 0.12, lp: 2000 }); a.noise({ d: 0.18, g: 0.2, f: 3000, type: 'highpass' }); }
    else { a.noise({ d: 0.09, g: 0.32, f: 2400, type: 'bandpass', q: 0.7 }); a.thud(0.5); }
    this.ctx.fx.camera.shake(b.mat === 'steel' ? 0.35 : 0.25);
    const col = MATS[b.mat].color;
    this.ctx.fx.particles.burst(this.sx(mx), this.sy(my), col, { count: b.mat === 'cable' ? 6 : 16, speed: 160, life: 0.8, size: 3, sizeEnd: 1, shape: Shape.Spark, gravity: 500 });
  }

  private debrisTick(dt: number): void {
    for (const d of this.debris) {
      d.life -= dt;
      if (d.wet) { d.vy = Math.min(d.vy, 25); d.vx *= 0.96; d.va *= 0.95; }
      else d.vy += GRAVITY * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.a += d.va * dt;
      if (!d.wet && d.y > this.def.water) { d.wet = true; this.splash(d.x, 0.5); }
    }
    this.debris = this.debris.filter((d) => d.life > 0);
  }

  private splash(x: number, size: number): void {
    const px = this.sx(x), py = this.sy(this.def.water);
    const p = this.ctx.fx.particles;
    for (let k = 0; k < 10 * size + 4; k++) p.spawn(px, py, this.rng.range(-60, 60) * size, -this.rng.range(80, 220) * size, 0.8, 3, 1, '#BFE3FF', Shape.Dot, 500, 0.5);
    this.ctx.audio.noise({ d: 0.3 + size * 0.3, g: 0.08 + size * 0.14, f: 1200, f2: 300, type: 'lowpass' });
  }

  private finishTest(): void {
    const s = this.sim!;
    this.phase = 'end'; this.phaseT = 0;
    const a = this.ctx.audio;
    const crossed = s.outcome === 'crossed';
    const met = starsMet(this.def, this.design, crossed);
    const cost = beamCost(this.def, this.design);
    if (crossed && met[0]) {
      this.won = true;
      // Honk honk, then a little fanfare.
      [0, 0.24].forEach((t) => { a.tone({ f: 440, type: 'square', a: 0.005, d: 0.16, g: 0.06, lp: 1800, at: t }); a.tone({ f: 554, type: 'square', a: 0.005, d: 0.16, g: 0.05, lp: 1800, at: t }); });
      [0, 4, 7, 12].forEach((n, i) => a.tone({ f: midiHz(67 + n), type: 'triangle', a: 0.004, d: 0.5, g: 0.09, at: 0.6 + i * 0.1 }));
      this.ctx.fx.particles.burst(this.sx(s.flagX), this.sy(-60), C.yellow, { count: 26, speed: 200, life: 1, size: 4, sizeEnd: 0, shape: Shape.Confetti, colors: [C.yellow, C.pink, C.cyan, C.green], gravity: 200 });
      if (this.demo) return;
      finishLevel(this.ctx, pack, this.level, 'Bridge It', {
        goals: ['Get across within budget', `Spend at most $${Math.floor(this.def.budget * 0.8)}`, `Spend at most $${Math.floor(this.def.budget * 0.6)}`],
        met,
        stats: [
          { label: 'cost', value: `$${cost} / $${this.def.budget}` },
          { label: 'peak stress', value: `${Math.round(s.maxStress * 100)}%` },
          { label: 'beams', value: String(this.design.beams.length) },
        ],
        delayMs: 2400,
      });
    } else {
      [0, -1, -2, -3].forEach((n, i) => a.tone({ f: midiHz(55 + n), f2: midiHz(54 + n), type: 'sawtooth', a: 0.02, d: i === 3 ? 0.9 : 0.32, g: 0.06, lp: 900, at: i * 0.3 }));
      const veh = this.def.vehicle === 'convoy' ? 'convoy' : this.def.vehicle;
      const msg = crossed ? `Made it, but $${cost - this.def.budget} over budget`
        : s.outcome === 'fell' ? `Into the river. ${this.weak ? 'The weak link is marked.' : 'Your design is still here.'}`
        : s.outcome === 'stuck' ? `The ${veh} got stuck. Smooth out the road.` : 'Too slow. Try again.';
      this.say(msg, C.pink, 2.6);
    }
  }

  private demoTick(): void {
    this.demoT += 1 / 60;
    if (this.phase === 'build' && this.phaseT > 1) { this.design = structuredClone(this.def.solution); this.test(); }
    if (this.phase === 'end' && this.phaseT > 2.4) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.start(this.seed, { demo: true });
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {}

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, phase: this.phase, t: this.sim?.t ?? 0, cost: beamCost(this.def, this.design), beams: this.design.beams.length };
  }

  // ---- render -------------------------------------------------------------------------

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 6 : w < 520 ? 96 : 76, bottom = small ? 6 : 104;
    const { x0, x1, y0, y1 } = this.view;
    const aw = w - 20, ah = h - top - bottom;
    this.sc = Math.min(aw / (x1 - x0), ah / (y1 - y0)) * this.zoom;
    this.ox = w / 2 - ((x0 + x1) / 2) * this.sc;
    this.oy = top + ah / 2 - ((y0 + y1) / 2) * this.sc;
    if (small) { this.btns = []; this.inv.layout([], 0, 0, 0, 0); return; }
    const items: InvItem[] = this.def.mats.map((m) => ({ kind: m, count: null, label: w < 600 ? MATS[m].name.split(' ')[0].replace('Reinforced', 'Strong') : MATS[m].name.replace('Reinforced', 'Strong'), draw: (g2, cx, cy, s) => drawMat(g2, m, cx, cy, s) }));
    const barH = 84;
    const relW = Math.min(150, w * 0.26);
    this.inv.layout(items, 12, h - barH - 10, Math.min(w - relW - 40, items.length * (barH + 8)), barH);
    const bs = 44, gap = 8, right = w - 64;
    const build = this.phase === 'build';
    const ids: [string, Btn['icon'] | undefined, boolean, string?][] = build
      ? [['clear', 'trash', this.design.beams.length > 0], ['redo', 'redo', this.hist.canRedo], ['undo', 'undo', this.hist.canUndo]]
      : [];
    this.btns = ids.map(([id, icon, en], i) => ({ id, icon, x: right - (i + 1) * bs - i * gap, y: 12, w: bs, h: bs, enabled: en }));
    if (build) this.btns.push({ id: 'mirror', label: 'Mirror', x: right - 3 * bs - 3 * gap - 84, y: 12, w: 76, h: bs, enabled: this.design.beams.length > 0, hint: 'M' });
    const by = h - barH / 2 - 10 - 27;
    if (build) this.btns.push({ id: 'test', icon: 'test', label: 'Test', x: w - relW - 12, y: by, w: relW, h: 54, enabled: true, primary: true, hint: 'Space' });
    else if (!(this.phase === 'end' && this.won)) this.btns.push({ id: 'stop', icon: 'stop', label: 'Stop', x: w - relW - 12, y: by, w: relW, h: 54, enabled: true, hint: 'Space' });
  }

  render(): void {
    const g = this.ctx.canvas.begin('#1A1230');
    this.layout();
    const { w, h } = this.ctx.canvas;
    const bp = this.phase === 'end' && this.won ? Math.min(1, Math.max(0, (this.phaseT - 0.9) / 1.2)) : 0;
    this.drawSky(g, w, h, bp);
    const fx = this.ctx.fx;
    fx.camera.begin(g, w, h);
    this.drawTerrain(g, w, h, bp);
    this.drawStructure(g, bp);
    this.drawVehicles(g);
    this.drawDebris(g);
    this.drawWater(g, h, bp);
    fx.particles.render(g);
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
  }

  private drawSky(g: CanvasRenderingContext2D, w: number, h: number, bp: number): void {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#22163F'); grad.addColorStop(0.45, '#7A3B63'); grad.addColorStop(0.75, '#E8705A'); grad.addColorStop(1, '#F6B26B');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    // Low sun behind the far cliff.
    const sunX = this.sx(this.def.gap[1] - 40), sunY = this.sy(-30);
    const sg = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, 140 * this.sc);
    sg.addColorStop(0, 'rgba(255,220,150,0.85)'); sg.addColorStop(0.2, 'rgba(255,190,120,0.35)'); sg.addColorStop(1, 'rgba(255,160,100,0)');
    g.fillStyle = sg; g.fillRect(0, 0, w, h);
    // Far hills.
    g.fillStyle = 'rgba(70,30,70,0.55)';
    g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 20) g.lineTo(x, this.sy(-40) + Math.sin(x * 0.012 + this.level.index) * 22 * this.sc + Math.sin(x * 0.031) * 10 * this.sc);
    g.lineTo(w, h); g.fill();
    if (bp > 0) {
      g.fillStyle = rgba(BLUEPRINT, bp * 0.92); g.fillRect(0, 0, w, h);
      g.strokeStyle = `rgba(200,225,255,${bp * 0.12})`; g.lineWidth = 1;
      const step = GRID * this.sc;
      g.beginPath();
      for (let x = this.ox % step; x < w; x += step) { g.moveTo(x, 0); g.lineTo(x, h); }
      for (let y = this.oy % step; y < h; y += step) { g.moveTo(0, y); g.lineTo(w, y); }
      g.stroke();
    }
  }

  private drawTerrain(g: CanvasRenderingContext2D, w: number, h: number, bp: number): void {
    const ch = Math.min(2, this.level.ch - 1);
    const [gl, gr] = this.def.gap;
    const top = this.sy(0), bot = h + 20;
    const rock = bp ? 'rgba(200,225,255,0.12)' : CHAPTER_ROCK[ch];
    const face = (x: number, dir: number) => {
      g.beginPath();
      g.moveTo(dir < 0 ? -20 : w + 20, top); g.lineTo(this.sx(x), top);
      for (let y = 0; y <= this.def.water + 80; y += 20) g.lineTo(this.sx(x) + dir * Math.max(0, Math.sin(y * 0.11 + x) * 4 * this.sc), this.sy(y));
      g.lineTo(this.sx(x), bot); g.lineTo(dir < 0 ? -20 : w + 20, bot); g.closePath();
      g.fillStyle = rock; g.fill();
      if (bp) { g.strokeStyle = 'rgba(220,235,255,0.6)'; g.lineWidth = 1.5; g.stroke(); }
    };
    face(gl, -1); face(gr, 1);
    if (!bp) {
      // Strata and the cliff-top road.
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
      for (let y = 40; y < this.def.water; y += 46) {
        g.beginPath(); g.moveTo(0, this.sy(y)); g.lineTo(this.sx(gl) - 6, this.sy(y + 6)); g.stroke();
        g.beginPath(); g.moveTo(this.sx(gr) + 6, this.sy(y + 4)); g.lineTo(w, this.sy(y)); g.stroke();
      }
      g.fillStyle = CHAPTER_TOP[ch];
      g.fillRect(0, top, this.sx(gl), 6 * this.sc); g.fillRect(this.sx(gr), top, w - this.sx(gr), 6 * this.sc);
      g.fillStyle = '#3A3A44';
      g.fillRect(0, top - 2, this.sx(gl), 4); g.fillRect(this.sx(gr), top - 2, w - this.sx(gr), 4);
    }
    // River rock.
    const r = this.def.rock;
    if (r) {
      g.beginPath();
      g.moveTo(this.sx(r[0] - r[2] - 30), this.sy(this.def.water + 80));
      g.lineTo(this.sx(r[0] - r[2]), this.sy(r[1] + 8)); g.lineTo(this.sx(r[0] - r[2] + 10), this.sy(r[1]));
      g.lineTo(this.sx(r[0] + r[2] - 10), this.sy(r[1])); g.lineTo(this.sx(r[0] + r[2]), this.sy(r[1] + 8));
      g.lineTo(this.sx(r[0] + r[2] + 30), this.sy(this.def.water + 80)); g.closePath();
      g.fillStyle = rock; g.fill();
      if (bp) { g.strokeStyle = 'rgba(220,235,255,0.6)'; g.lineWidth = 1.5; g.stroke(); }
    }
    // Towers behind high anchors.
    for (const [ax, ay] of this.def.anchors) {
      if (ay >= 0) continue;
      const dir = ax <= gl ? -1 : 1;
      const x0 = this.sx(ax + (dir < 0 ? -18 : -2)), x1 = this.sx(ax + (dir < 0 ? 2 : 18));
      g.fillStyle = bp ? 'rgba(200,225,255,0.15)' : '#4A4552';
      g.fillRect(x0, this.sy(ay - 6), x1 - x0, top - this.sy(ay - 6));
      g.fillStyle = bp ? 'transparent' : 'rgba(255,255,255,0.08)';
      for (let y = ay; y < 0; y += 16) g.fillRect(x0, this.sy(y), x1 - x0, 1.5);
    }
    // Boat channel.
    const boat = this.def.boat;
    if (boat && this.phase === 'build') {
      const [b0, b1, cy] = boat;
      g.fillStyle = 'rgba(255,79,139,0.12)';
      g.fillRect(this.sx(b0), this.sy(cy), (b1 - b0) * this.sc, this.sy(this.def.water) - this.sy(cy));
      g.setLineDash([6, 6]); g.strokeStyle = rgba(C.pink, 0.6); g.lineWidth = 1.5;
      g.strokeRect(this.sx(b0), this.sy(cy), (b1 - b0) * this.sc, this.sy(this.def.water) - this.sy(cy));
      g.setLineDash([]);
    }
    if (boat) this.drawBoat(g, this.phase === 'build' ? (boat[0] + boat[1]) / 2 : this.boatX);
    // Flag.
    const fxw = this.def.gap[1] + 110;
    const px = this.sx(fxw), py = top;
    g.strokeStyle = bp ? '#DDE8FF' : '#EEE'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, py - 46 * this.sc); g.stroke();
    const wave = this.won ? 3 : 1;
    g.fillStyle = bp ? '#DDE8FF' : C.pink;
    g.beginPath(); g.moveTo(px, py - 46 * this.sc);
    for (let k = 0; k <= 6; k++) g.lineTo(px + k * 4 * this.sc, py - 46 * this.sc + Math.sin(this.clock * 6 * wave - k) * 2 * this.sc * wave);
    for (let k = 6; k >= 0; k--) g.lineTo(px + k * 4 * this.sc, py - 32 * this.sc + Math.sin(this.clock * 6 * wave - k) * 2 * this.sc * wave);
    g.fill();
  }

  private drawBoat(g: CanvasRenderingContext2D, x: number): void {
    const wy = this.sy(this.def.water), s = this.sc;
    const bx = this.sx(x) + Math.sin(this.clock * 1.5) * 1.5;
    g.fillStyle = '#E9DCC0';
    g.beginPath(); g.moveTo(bx - 26 * s, wy - 8 * s); g.lineTo(bx + 26 * s, wy - 8 * s); g.lineTo(bx + 18 * s, wy + 2 * s); g.lineTo(bx - 20 * s, wy + 2 * s); g.fill();
    g.fillStyle = '#C0392B'; g.fillRect(bx - 8 * s, wy - 18 * s, 14 * s, 10 * s);
    g.fillStyle = '#333'; g.fillRect(bx - 2 * s, wy - 26 * s, 4 * s, 8 * s);
  }

  private drawWater(g: CanvasRenderingContext2D, h: number, bp: number): void {
    const wy = this.sy(this.def.water);
    const [gl, gr] = this.def.gap;
    g.fillStyle = bp ? 'rgba(200,225,255,0.1)' : 'rgba(30,78,122,0.88)';
    g.beginPath(); g.moveTo(this.sx(gl - 10), h + 10); g.lineTo(this.sx(gl - 10), wy);
    for (let x = gl - 10; x <= gr + 10; x += 10) g.lineTo(this.sx(x), wy + Math.sin(this.clock * 2 + x * 0.08) * 1.5 * this.sc);
    g.lineTo(this.sx(gr + 10), h + 10); g.fill();
    g.strokeStyle = bp ? 'rgba(220,235,255,0.5)' : 'rgba(190,225,255,0.45)'; g.lineWidth = 1.5;
    g.beginPath();
    for (let x = gl - 10; x <= gr + 10; x += 10) { const y = wy + Math.sin(this.clock * 2 + x * 0.08) * 1.5 * this.sc; if (x === gl - 10) g.moveTo(this.sx(x), y); else g.lineTo(this.sx(x), y); }
    g.stroke();
  }

  /** Beams and joints: blueprint colours while building, live stress while testing. */
  private drawStructure(g: CanvasRenderingContext2D, bp: number): void {
    const s = this.sim;
    const d = this.design;
    const pos = (i: number): [number, number] => s ? [s.x[i], s.y[i]] : pointXY(this.def, d, i);
    const hv = this.ctx.input.hasHover && !this.demo && this.phase === 'build' ? this.ctx.input.hover : null;
    const hoverBeam = hv && !this.drag && this.pointNear(hv.x, hv.y) < 0 && this.sel === null ? this.beamNear(hv.x, hv.y) : -1;
    const order = d.beams.map((_, i) => i).sort((a, b) => Number(MATS[d.beams[a][2]].road) - Number(MATS[d.beams[b][2]].road));
    g.lineCap = 'round';
    for (const i of order) {
      const [a, b, m] = d.beams[i];
      const sb = s?.beams[i];
      if (sb && !sb.alive) continue;
      let [ax, ay] = pos(a), [bx, by] = pos(b);
      const M = MATS[m];
      let col = M.color;
      if (sb && !bp) {
        col = stressColor(sb.stress);
        if (sb.stress > 0.9 && this.ctx.settings.motion) {
          const j = Math.sin(this.clock * 70 + i) * 1.4 / this.sc, nx = -(by - ay), ny = bx - ax, L = Math.hypot(nx, ny) || 1;
          ax += (nx / L) * j; ay += (ny / L) * j; bx += (nx / L) * j; by += (ny / L) * j;
        }
      }
      if (bp) col = '#E8F1FF';
      const wpx = Math.max(m === 'cable' ? 1.5 : 2.5, M.width * this.sc);
      if (M.road && !bp) {
        g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = wpx + 3;
        g.beginPath(); g.moveTo(this.sx(ax), this.sy(ay)); g.lineTo(this.sx(bx), this.sy(by)); g.stroke();
      }
      g.strokeStyle = i === hoverBeam ? C.pink : col;
      g.lineWidth = bp ? Math.max(1.5, wpx * 0.5) : wpx;
      g.beginPath(); g.moveTo(this.sx(ax), this.sy(ay)); g.lineTo(this.sx(bx), this.sy(by)); g.stroke();
      if (M.road && !s) {
        g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.setLineDash([4, 5]);
        g.beginPath(); g.moveTo(this.sx(ax), this.sy(ay)); g.lineTo(this.sx(bx), this.sy(by)); g.stroke(); g.setLineDash([]);
      }
    }
    // Joints and anchors.
    const n = this.def.anchors.length + d.joints.length;
    for (let i = 0; i < n; i++) {
      const [x, y] = pos(i);
      const anchor = i < this.def.anchors.length;
      const r = anchor ? Math.max(4.5, 5 * this.sc) : Math.max(3, 3.2 * this.sc);
      g.beginPath(); g.arc(this.sx(x), this.sy(y), r, 0, Math.PI * 2);
      g.fillStyle = bp ? '#E8F1FF' : anchor ? '#2A2A33' : '#F4F1FF'; g.fill();
      if (anchor && !bp) { g.strokeStyle = ACCENT; g.lineWidth = 2; g.stroke(); }
      if (this.sel === i || (this.drag?.from === i)) {
        g.beginPath(); g.arc(this.sx(x), this.sy(y), r + 5 + Math.sin(this.clock * 8) * 1.5, 0, Math.PI * 2);
        g.strokeStyle = C.yellow; g.lineWidth = 2; g.stroke();
      }
    }
    if (this.phase !== 'build') return;
    // Hovered point.
    if (hv) {
      const pt = this.pointNear(hv.x, hv.y);
      if (pt >= 0) {
        const [x, y] = pointXY(this.def, d, pt);
        g.beginPath(); g.arc(this.sx(x), this.sy(y), 10, 0, Math.PI * 2); g.strokeStyle = rgba(C.text, 0.6); g.lineWidth = 1.5; g.stroke();
      }
    }
    // Ghost of the beam being placed.
    let ghost: [number, number, number, number] | null = null;
    if (this.drag?.moved) { const [fx, fy] = pointXY(this.def, d, this.drag.from); ghost = [fx, fy, this.drag.x, this.drag.y]; }
    else if (this.sel !== null && hv) { const [fx, fy] = pointXY(this.def, d, this.sel); const pt = this.pointNear(hv.x, hv.y); const [ex, ey] = pt >= 0 ? pointXY(this.def, d, pt) : this.snap(hv.x, hv.y); ghost = [fx, fy, ex, ey]; }
    if (ghost) this.drawGhost(g, ...ghost);
    // Weak link from the last failed test.
    if (this.weak) {
      const [ax, ay, bx, by] = this.weak;
      g.strokeStyle = rgba(C.pink, 0.6 + 0.3 * Math.sin(this.clock * 6)); g.lineWidth = 10; g.lineCap = 'round';
      g.beginPath(); g.moveTo(this.sx(ax), this.sy(ay)); g.lineTo(this.sx(bx), this.sy(by)); g.stroke();
    }
    if (this.denied) {
      g.fillStyle = rgba(C.pink, this.denied.t * 1.4);
      g.beginPath(); g.arc(this.sx(this.denied.x), this.sy(this.denied.y), 10, 0, Math.PI * 2); g.fill();
    }
    // Level 1 teaches without text: pulse the stored deck when the canvas is empty.
    if (this.level.id === '1-1' && !d.beams.length && this.idle > 3) {
      const k = (this.idle * 0.8) % 1;
      g.strokeStyle = rgba(C.yellow, 0.6 * (1 - k)); g.lineWidth = 3; g.setLineDash([6, 6]);
      for (const [a, b, m] of this.def.solution.beams) {
        if (!MATS[m].road) continue;
        const [ax, ay] = pointXY(this.def, this.def.solution, a), [bx, by] = pointXY(this.def, this.def.solution, b);
        g.beginPath(); g.moveTo(this.sx(ax), this.sy(ay)); g.lineTo(this.sx(bx), this.sy(by)); g.stroke();
      }
      g.setLineDash([]);
    }
  }

  private drawGhost(g: CanvasRenderingContext2D, fx: number, fy: number, ex: number, ey: number): void {
    const trial = structuredClone(this.design);
    addBeam(this.def, trial, fx, fy, ex, ey, this.mat);
    const ok = trial.joints.every(([x, y]) => this.spotOk(x, y)) && !boatClash(this.def, trial);
    const M = MATS[this.mat];
    g.strokeStyle = ok ? rgba(M.color === '#2A2A33' ? '#DDDDEE' : M.color, 0.75) : rgba(C.pink, 0.8);
    g.lineWidth = Math.max(2, M.width * this.sc); g.setLineDash([8, 6]);
    g.beginPath(); g.moveTo(this.sx(fx), this.sy(fy)); g.lineTo(this.sx(ex), this.sy(ey)); g.stroke(); g.setLineDash([]);
    // Split points where a long drag is cut into several beams.
    const len = Math.hypot(ex - fx, ey - fy), n = Math.ceil(len / M.max - 1e-9);
    g.fillStyle = C.text;
    for (let k = 1; k < n; k++) {
      const x = Math.round((fx + ((ex - fx) * k) / n) / GRID) * GRID, y = Math.round((fy + ((ey - fy) * k) / n) / GRID) * GRID;
      g.beginPath(); g.arc(this.sx(x), this.sy(y), 3, 0, Math.PI * 2); g.fill();
    }
    const cost = beamCost(this.def, trial) - beamCost(this.def, this.design);
    g.font = `700 13px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillStyle = ok ? C.text : C.pink;
    g.fillText(ok ? `+$${cost}` : '✕', this.sx(ex), this.sy(ey) - 10);
  }

  private drawVehicles(g: CanvasRenderingContext2D): void {
    const s = this.sim;
    const V = VEHICLES[this.def.vehicle];
    if (!s) {
      // Parked at the start, waiting.
      for (let k = 0; k < V.count; k++) {
        const front = this.def.gap[0] - 70 - k * (V.base + V.gap + 20);
        this.drawVehicle(g, front, -V.wheel, front - V.base, -V.wheel, 0, k);
      }
      return;
    }
    s.vehicles.forEach((v, k) => {
      const [f, r] = v.wheels;
      const spin = s.wheels.find((w) => w.p === f)?.spin ?? 0;
      this.drawVehicle(g, s.x[f], s.y[f], s.x[r], s.y[r], spin, k);
    });
  }

  private drawVehicle(g: CanvasRenderingContext2D, fx: number, fy: number, rx: number, ry: number, spin: number, k: number): void {
    const V = VEHICLES[this.def.vehicle];
    const ang = Math.atan2(fy - ry, fx - rx);
    const s = this.sc;
    g.save();
    g.translate(this.sx((fx + rx) / 2), this.sy((fy + ry) / 2));
    g.rotate(ang);
    const L = V.base + V.wheel * 2 + 8, H = V.h;
    const kind = this.def.vehicle;
    const col = kind === 'convoy' ? [C.green, C.cyan, C.yellow][k % 3] : V.color;
    g.fillStyle = col;
    if (kind === 'truck') {
      roundRect(g, (-L / 2) * s, (-H - 4) * s, L * 0.62 * s, H * s, 3 * s); g.fill();
      g.fillStyle = '#E8E8F0'; roundRect(g, (L * 0.15) * s, (-H * 0.8 - 4) * s, L * 0.35 * s, H * 0.8 * s, 5 * s); g.fill();
      g.fillStyle = '#5BC0EB'; g.fillRect(L * 0.32 * s, (-H * 0.72) * s, L * 0.13 * s, H * 0.3 * s);
    } else if (kind === 'train') {
      roundRect(g, (-L / 2) * s, (-H - 4) * s, L * s, H * s, 4 * s); g.fill();
      g.fillStyle = '#2A2A33'; g.fillRect((L / 2 - 16) * s, (-H - 12) * s, 8 * s, 10 * s);
      g.fillStyle = '#FFF4B0';
      for (let x = -L / 2 + 10; x < L / 2 - 26; x += 18) g.fillRect(x * s, (-H + 2) * s, 10 * s, 8 * s);
    } else if (kind === 'bus') {
      roundRect(g, (-L / 2) * s, (-H - 4) * s, L * s, H * s, 6 * s); g.fill();
      g.fillStyle = '#E3F7FF';
      for (let x = -L / 2 + 8; x < L / 2 - 10; x += 16) g.fillRect(x * s, (-H) * s, 11 * s, 9 * s);
    } else {
      roundRect(g, (-L / 2) * s, (-H * 0.6 - 4) * s, L * s, H * 0.6 * s, 4 * s); g.fill();
      roundRect(g, (-L * 0.25) * s, (-H - 4) * s, L * 0.5 * s, H * 0.55 * s, 5 * s); g.fill();
      g.fillStyle = '#CDEFFF'; g.fillRect((-L * 0.18) * s, (-H + 0) * s, L * 0.36 * s, H * 0.3 * s);
    }
    g.restore();
    for (const [x, y] of [[fx, fy], [rx, ry]]) {
      const cx = this.sx(x), cy = this.sy(y), r = V.wheel * s;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#1D1D24'; g.fill();
      g.strokeStyle = '#8A8AA0'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx + Math.cos(spin) * r * 0.7, cy + Math.sin(spin) * r * 0.7); g.lineTo(cx - Math.cos(spin) * r * 0.7, cy - Math.sin(spin) * r * 0.7); g.stroke();
    }
  }

  private drawDebris(g: CanvasRenderingContext2D): void {
    for (const d of this.debris) {
      g.save();
      g.globalAlpha = Math.min(1, d.life / 1.5) * (d.wet ? 0.6 : 1);
      g.translate(this.sx(d.x), this.sy(d.y)); g.rotate(d.a);
      g.strokeStyle = MATS[d.mat].color; g.lineWidth = Math.max(2, MATS[d.mat].width * this.sc); g.lineCap = 'butt';
      g.beginPath(); g.moveTo((-d.len / 2) * this.sc, 0); g.lineTo((d.len / 2) * this.sc, 0); g.stroke();
      g.restore();
    }
  }

  private drawUi(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const room = titleRoom(this.btns, w - 64) - 16;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    g.fillText(fitText(g, `${this.level.chapter} ${this.level.n} · ${this.def.name}`, room), 16, 30);
    // Budget meter with the 2- and 3-star marks.
    const cost = beamCost(this.def, this.design);
    // Narrow screens: the meter gets its own full-width row under the buttons.
    const narrow = room < 300;
    const bw = narrow ? w - 32 : Math.min(260, room - 10), bx = 16, by = narrow ? 64 : 42, bh = 22;
    drawBudget(g, bx, by, bw, bh, cost, this.def.budget, `$${cost} / $${this.def.budget}`, cost <= this.def.budget * 0.6 ? C.green : cost <= this.def.budget * 0.8 ? C.yellow : ACCENT);
    g.fillStyle = rgba(C.text, 0.7);
    for (const k of [0.6, 0.8]) g.fillRect(bx + bw * k - 1, by - 3, 2, bh + 6);
    g.font = `600 12px ${FONT.ui}`; g.fillStyle = C.muted;
    const V = this.def.vehicle;
    const what = V === 'convoy' ? 'a convoy of 3 cars' : `a ${V}`;
    if (!narrow && bw + 30 < room) g.fillText(fitText(g, `Get ${what} to the flag`, room - bw - 24), bx + bw + 12, by + 15);
    for (const b of this.btns) drawBtn(g, b, ACCENT, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    this.inv.draw(g, ACCENT, this.mat, hov ? this.inv.at(hov.x, hov.y)?.item.kind ?? null : null, matchMedia('(pointer: fine)').matches);
    if (this.phase === 'test' && this.sim) {
      g.font = `600 13px ${FONT.ui}`; g.fillStyle = C.muted; g.textAlign = 'right';
      g.fillText(`peak stress ${Math.round(this.sim.maxStress * 100)}%`, w - 16, 64);
    }
    if (this.banner) {
      const b = this.banner;
      g.globalAlpha = Math.min(1, b.t * 3);
      g.font = `700 20px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = Math.min(w - 20, g.measureText(b.text).width + 36);
      const cy = this.sy(-110);
      roundRect(g, w / 2 - tw / 2, cy - 24, tw, 48, 24); g.fillStyle = 'rgba(14,12,26,0.9)'; g.fill();
      g.fillStyle = b.color; g.fillText(fitText(g, b.text, tw - 24), w / 2, cy + 1);
      g.globalAlpha = 1;
    }
  }
}

function drawMat(g: CanvasRenderingContext2D, m: Mat, cx: number, cy: number, s: number): void {
  const M = MATS[m];
  const r = s * 0.42;
  g.lineCap = 'round';
  if (M.road) {
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = M.width + 4;
    g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.stroke();
    g.strokeStyle = M.color; g.lineWidth = M.width + 1;
    g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.stroke();
    if (m === 'road2') { g.strokeStyle = '#8FA3C8'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - r, cy + 6); g.lineTo(cx, cy - 2); g.lineTo(cx + r, cy + 6); g.stroke(); }
  } else if (m === 'cable') {
    g.strokeStyle = '#DDDDEE'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - r, cy - r * 0.6); g.quadraticCurveTo(cx, cy + r * 0.6, cx + r, cy - r * 0.6); g.stroke();
  } else {
    g.strokeStyle = M.color; g.lineWidth = M.width + 1;
    g.beginPath(); g.moveTo(cx - r, cy + r * 0.5); g.lineTo(cx, cy - r * 0.5); g.lineTo(cx + r, cy + r * 0.5); g.closePath(); g.stroke();
  }
  g.fillStyle = C.muted; g.font = `600 10px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'top';
  g.fillText(`$${M.cost}`, cx, cy + r * 0.75);
}

export default (): Game => new BridgeIt();
