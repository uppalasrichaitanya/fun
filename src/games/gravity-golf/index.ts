import { History, undoKey } from '../../engine/editor/history';
import { drawBtn, fitText, hitBtn, InventoryBar, titleRoom, type Btn, type InvItem } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import {
  COMET_R, DT, DUST_R, HOLE_CAPTURE, invTotal, MAX_PULL, moonPos, PLANET, placeOk, PREVIEW, shotFromPull, simulate, WORLD,
  type GGLevel, type Placed, type SimResult, type Size,
} from './logic';
import { pack } from './pack';

const BG = '#0B0820';
const SPACE = '#120D33';
const ACCENT = C.violet;
const COMET = C.yellow;
const MUSIC = { bpm: 46, root: 45, chords: [[0, 7, 16], [5, 12, 19], [3, 10, 17], [-2, 7, 14]], pad: true, wave: 'sine' as OscillatorType, gain: 0.05 };

type Phase = 'build' | 'aim' | 'fly' | 'ended' | 'won';
interface Build { planets: Placed[] }

class GravityGolf implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level!: Level<GGLevel>;
  private def!: GGLevel;
  private build: Build = { planets: [] };
  private hist = new History<Build>(100);
  private inv = new InventoryBar();
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private phase: Phase = 'build';
  private phaseT = 0;
  private s = 1;
  private ox = 0;
  private oy = 0;
  private zoom = 1;
  private focus = { x: WORLD.w / 2, y: WORLD.h / 2 };
  private aim: { x: number; y: number; id: number } | null = null;
  private shot: [number, number] = [0, 0];
  private preview: { key: string; pts: number[] } = { key: '', pts: [] };
  private flight: { r: SimResult; k: number; dust: number; slow: boolean } | null = null;
  private tail: { x: number; y: number; v: number }[] = [];
  private drag: { kind: 'new' | 'move'; size: Size; idx: number; x: number; y: number; sx: number; sy: number; moved: boolean; t: number; id: number; before: string } | null = null;
  private stars: { x: number; y: number; z: number; tw: number }[] = [];
  private message: { text: string; t: number; color: string } | null = null;
  private demo = false;
  private demoT = 0;
  private demoStep = 0;
  private seed = 1;
  private clock = 0;
  private time = 0;
  private idle = 0;
  private shots = 0;
  private ring = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const r = new Rng(77);
    this.stars = Array.from({ length: 160 }, () => ({ x: r.range(0, 1), y: r.range(0, 1), z: r.range(0.2, 1), tw: r.range(0, 6) }));
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', (p) => this.up(p));
    ctx.input.on('alt', (p) => { if (this.editable()) { const i = this.planetAt(p.x, p.y); if (i >= 0) this.removePlanet(i); } });
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      this.idle = 0;
      const u = undoKey(code, e);
      if (u && this.editable()) { e.preventDefault(); this.button(u); return; }
      if (code === 'Space') { e.preventDefault(); this.retry(); }
      else if (code === 'Escape' && this.phase !== 'build') this.toBuild();
    });
    ctx.canvas.el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  captureKey(code: string): boolean { return code === 'Escape' && this.phase !== 'build' && this.phase !== 'won'; }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 3); lv = pool[seed % pool.length] ?? lv; }
    this.load(lv);
    if (!this.demo) this.ctx.audio.music(MUSIC);
  }

  private load(level: Level<GGLevel>): void {
    this.level = level;
    this.def = level.def;
    this.build = { planets: [] };
    this.hist.clear();
    this.phase = 'build'; this.phaseT = 0;
    this.flight = null; this.tail = []; this.aim = null; this.drag = null; this.message = null;
    this.time = 0; this.idle = 0; this.shots = 0; this.demoT = 0; this.demoStep = 0;
    this.zoom = 1; this.focus = { x: WORLD.w / 2, y: WORLD.h / 2 };
  }

  // ---- build ----------------------------------------------------------------

  private editable(): boolean { return !this.demo && (this.phase === 'build' || this.phase === 'ended'); }

  private left(size: Size): number { return (this.def.inv[size] ?? 0) - this.build.planets.filter((p) => p[0] === size).length; }

  private edit(fn: () => void, sound: 'place' | 'pop' | 'move' | 'swap'): boolean {
    if (!this.hist.track(this.build, fn)) return false;
    const a = this.ctx.audio;
    if (sound === 'place') { a.thud(0.6); a.pluck(330, 0.1); }
    else if (sound === 'pop') a.pop(300, 0.16);
    else if (sound === 'move') a.tick(900, 0.05);
    else a.tone({ f: 220, f2: 330, type: 'sine', a: 0.01, d: 0.2, g: 0.12 });
    this.toBuild(true);
    return true;
  }

  private removePlanet(i: number): void { this.edit(() => { this.build.planets.splice(i, 1); }, 'pop'); }

  private planetAt(x: number, y: number): number {
    const w = this.toWorld(x, y);
    for (let i = this.build.planets.length - 1; i >= 0; i--) {
      const [s, px, py] = this.build.planets[i];
      if (Math.hypot(w.x - px, w.y - py) < PLANET[s].r + 10) return i;
    }
    return -1;
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.editable()) return;
    const r = this.ctx.canvas.el.getBoundingClientRect();
    const i = this.planetAt(e.clientX - r.left, e.clientY - r.top);
    if (i < 0) return;
    e.preventDefault();
    this.swapSize(i);
  };

  private swapSize(i: number): void {
    const p = this.build.planets[i];
    const other: Size = p[0] === 'small' ? 'large' : 'small';
    if (this.left(other) <= 0) { this.ctx.audio.buzz(); return; }
    if (!placeOk(this.def, this.build.planets, other, p[1], p[2], i)) { this.say('No room to grow here', C.pink); return; }
    this.edit(() => { this.build.planets[i] = [other, p[1], p[2]]; }, 'swap');
  }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'undo' || id === 'redo') {
      if (!this.editable()) return;
      const s = id === 'undo' ? this.hist.undo(this.build) : this.hist.redo(this.build);
      if (!s) { a.buzz(); return; }
      this.build = s; a.tick(1300, 0.06); this.toBuild(true);
    } else if (id === 'reset') {
      if (!this.editable() || !this.build.planets.length) return;
      this.hist.push(this.build); this.build = { planets: [] }; a.whoosh(0.12, 0.2); this.toBuild(true);
    } else if (id === 'retry') this.retry();
    else if (id === 'build') this.toBuild();
  }

  /** Space: comet back to the start, planets stay. */
  private retry(): void {
    if (this.phase === 'won' || this.demo) return;
    if (this.phase === 'fly' || this.phase === 'ended') { this.toBuild(); this.ctx.audio.whoosh(0.08, 0.15); }
  }

  private toBuild(quiet = false): void {
    if (this.phase === 'won') return;
    this.phase = 'build'; this.phaseT = 0;
    this.flight = null; this.tail = [];
    this.ctx.fx.time.reset();
    if (!quiet) this.message = null;
  }

  // ---- input ----------------------------------------------------------------

  private toWorld(x: number, y: number): { x: number; y: number } { return { x: (x - this.ox) / this.s, y: (y - this.oy) / this.s }; }
  private toScreen(x: number, y: number): { x: number; y: number } { return { x: this.ox + x * this.s, y: this.oy + y * this.s }; }

  private down(p: Pointer): void {
    if (this.demo) return;
    this.idle = 0;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    if (this.phase === 'won') return;
    if (this.phase === 'fly') { this.retry(); return; }
    const slot = this.inv.at(p.x, p.y);
    if (slot) {
      const size = slot.item.kind as Size;
      if (this.left(size) <= 0) { this.ctx.audio.buzz(); return; }
      this.drag = { kind: 'new', size, idx: -1, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, t: 0, id: p.id, before: '' };
      return;
    }
    const c = this.toScreen(this.def.comet[0], this.def.comet[1]);
    if (Math.hypot(p.x - c.x, p.y - c.y) < Math.max(34, 30 * this.s)) {
      if (this.phase === 'ended') this.toBuild(true);
      this.aim = { x: p.x, y: p.y, id: p.id };
      this.phase = 'aim';
      this.ctx.audio.tick(1600, 0.05);
      return;
    }
    const i = this.planetAt(p.x, p.y);
    if (i >= 0 && this.editable()) {
      this.drag = { kind: 'move', size: this.build.planets[i][0], idx: i, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, t: 0, id: p.id, before: JSON.stringify(this.build) };
    }
  }

  private move(p: Pointer): void {
    if (this.aim && this.aim.id === p.id) { this.aim.x = p.x; this.aim.y = p.y; return; }
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    d.x = p.x; d.y = p.y;
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 6) d.moved = true;
    if (d.kind === 'move' && d.moved) {
      const w = this.toWorld(p.x, p.y);
      const pl = this.build.planets[d.idx];
      if (pl && placeOk(this.def, this.build.planets, pl[0], Math.round(w.x), Math.round(w.y), d.idx)) { pl[1] = Math.round(w.x); pl[2] = Math.round(w.y); }
    }
  }

  private up(p: Pointer): void {
    this.pressBtn = null;
    if (this.aim && this.aim.id === p.id) {
      const c = this.toScreen(this.def.comet[0], this.def.comet[1]);
      const pull = Math.hypot(c.x - this.aim.x, c.y - this.aim.y) / this.s;
      this.aim = null;
      if (pull < 12) { this.phase = 'build'; return; }
      this.launch();
      return;
    }
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    this.drag = null;
    const w = this.toWorld(p.x, p.y);
    if (d.kind === 'new') {
      if (!d.moved) { this.say('Drag a planet into space', C.muted); return; }
      const x = Math.round(w.x), y = Math.round(w.y);
      if (!placeOk(this.def, this.build.planets, d.size, x, y)) { this.ctx.audio.buzz(); this.say('Too close to something', C.pink); return; }
      this.edit(() => { this.build.planets.push([d.size, x, y]); }, 'place');
      const s = this.toScreen(x, y);
      this.ctx.fx.particles.burst(s.x, s.y, ACCENT, { count: 14, speed: 90, life: 0.4, size: 3, sizeEnd: 0 });
      return;
    }
    if (!d.moved) {
      // Tap: swap size when both sizes are allowed.
      if ((this.def.inv.small ?? 0) && (this.def.inv.large ?? 0)) this.swapSize(d.idx);
      return;
    }
    if (this.inv.at(p.x, p.y) || w.x < -20 || w.y < -20 || w.x > WORLD.w + 20 || w.y > WORLD.h + 20) {
      this.build = JSON.parse(d.before);
      this.removePlanet(d.idx);
      return;
    }
    if (JSON.stringify(this.build) !== d.before) { this.hist.push(d.before); this.ctx.audio.tick(900, 0.05); this.toBuild(true); }
  }

  private launch(): void {
    if (!this.aimShot()) return;
    const r = simulate(this.def, this.build.planets, this.shot, 1);
    this.flight = { r, k: 0, dust: 0, slow: false };
    this.tail = [];
    this.phase = 'fly'; this.phaseT = 0;
    this.shots++;
    const a = this.ctx.audio;
    a.whoosh(0.22, 0.35);
    a.tone({ f: 140, f2: 420, type: 'triangle', a: 0.005, d: 0.25, g: 0.12 });
  }

  /** Current slingshot shot from the drag, rounded like stored shots. */
  private aimShot(): boolean {
    const p = this.aim ?? this.ctx.input.hover;
    const c = this.toScreen(this.def.comet[0], this.def.comet[1]);
    const dx = (c.x - p.x) / this.s, dy = (c.y - p.y) / this.s;
    if (this.aim) this.shot = shotFromPull(dx, dy);
    return this.shot[1] > 0;
  }

  private say(text: string, color: string): void { this.message = { text, t: 1.6, color }; }

  // ---- loop -----------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.time += dt;
    this.idle += dt;
    this.phaseT += dt;
    this.ring = Math.max(0, this.ring - dt);
    if (this.message && (this.message.t -= dt) <= 0) this.message = null;
    if (this.drag && !this.drag.moved && this.drag.kind === 'move') {
      this.drag.t += dt;
      if (this.drag.t > 0.5) { const i = this.drag.idx; this.drag = null; this.removePlanet(i); }
    }
    if (this.aim) this.aimShot();
    if (this.phase === 'fly') this.flyTick(dt);
    if (this.phase === 'ended' && this.phaseT > 0.9) this.toBuild(true);
    if (this.phase === 'won' && this.phaseT > 1.4 && this.phaseT - dt <= 1.4) this.finish();
    if (this.demo) this.demoTick(dt);
    // Camera: ease in near bodies while flying.
    let tz = 1, fx = WORLD.w / 2, fy = WORLD.h / 2;
    if (this.flight && this.phase !== 'build') {
      const pos = this.cometPos();
      let near = Infinity;
      for (const b of this.def.planets) near = Math.min(near, Math.hypot(b[0] - pos.x, b[1] - pos.y) - b[2]);
      for (const b of this.build.planets) near = Math.min(near, Math.hypot(b[1] - pos.x, b[2] - pos.y) - PLANET[b[0]].r);
      near = Math.min(near, Math.hypot(this.def.hole[0] - pos.x, this.def.hole[1] - pos.y) - 20);
      if (near < 90) { tz = 1.1; fx = pos.x; fy = pos.y; }
    }
    const k = 1 - Math.exp(-dt * 2.5);
    this.zoom += (tz - this.zoom) * k;
    this.focus.x += (fx - this.focus.x) * k; this.focus.y += (fy - this.focus.y) * k;
  }

  private cometPos(): { x: number; y: number; v: number } {
    const f = this.flight;
    if (!f) return { x: this.def.comet[0], y: this.def.comet[1], v: 0 };
    const i = Math.min(f.r.path.length / 3 - 1, Math.floor(f.k)) * 3;
    return { x: f.r.path[i], y: f.r.path[i + 1], v: f.r.path[i + 2] };
  }

  private flyTick(dt: number): void {
    const f = this.flight!;
    const total = f.r.path.length / 3 - 1;
    const prev = Math.floor(f.k);
    f.k = Math.min(total, f.k + dt / DT);
    // Slow-mo for the final spiral into the black hole.
    if (f.r.outcome === 'capture' && !f.slow && (total - f.k) * DT < 0.45) { f.slow = true; this.ctx.fx.time.slowMo(0.3, 600); }
    for (let k = prev + 1; k <= Math.floor(f.k); k++) {
      if (k % 2 === 0) { const i = k * 3; this.tail.push({ x: f.r.path[i], y: f.r.path[i + 1], v: f.r.path[i + 2] }); }
      if (f.r.jumps.includes(k * 3)) { this.tail = []; this.ctx.audio.tone({ f: 880, f2: 220, type: 'sine', a: 0.005, d: 0.3, g: 0.12 }); }
      const x = f.r.path[k * 3], y = f.r.path[k * 3 + 1];
      this.def.dust.forEach(([dx, dy], i) => {
        if (!(f.dust & (1 << i)) && (x - dx) ** 2 + (y - dy) ** 2 < DUST_R * DUST_R) {
          f.dust |= 1 << i;
          this.ctx.audio.chime(6 + i * 2, 0.16);
          const s = this.toScreen(dx, dy);
          this.ctx.fx.particles.burst(s.x, s.y, COMET, { count: 16, speed: 100, life: 0.5, size: 3, sizeEnd: 0, shape: Shape.Spark });
        }
      });
    }
    if (this.tail.length > 70) this.tail.splice(0, this.tail.length - 70);
    if (f.k >= total) this.endFlight();
  }

  private endFlight(): void {
    const r = this.flight!.r;
    const a = this.ctx.audio, fx = this.ctx.fx;
    const s = this.toScreen(r.end.x, r.end.y);
    this.phaseT = 0;
    if (r.outcome === 'capture') {
      this.phase = 'won';
      this.ring = 1;
      a.tone({ f: 70, f2: 38, type: 'sine', a: 0.02, d: 1.4, g: 0.4 });
      a.noise({ d: 0.9, g: 0.12, f: 300, f2: 80, type: 'lowpass' });
      a.sparkle(784);
      fx.particles.burst(s.x, s.y, ACCENT, { count: 40, speed: 160, life: 0.9, size: 4, sizeEnd: 0 });
      return;
    }
    this.phase = 'ended';
    if (r.outcome === 'crash') {
      a.noise({ d: 0.18, g: 0.25, f: 2200, f2: 400, type: 'bandpass', q: 0.8 });
      a.pop(160, 0.3);
      fx.camera.shake(0.3);
      fx.particles.burst(s.x, s.y, COMET, { count: 26, speed: 180, life: 0.5, size: 3, sizeEnd: 0, shape: Shape.Spark });
      fx.particles.burst(s.x, s.y, C.orange, { count: 10, speed: 90, life: 0.4, size: 4, sizeEnd: 0 });
      this.say(r.hit === 'rock' ? 'Asteroid!' : r.hit === 'moon' ? 'Hit a moon' : r.hit === 'star' ? 'Too close to the star' : 'Crashed', C.pink);
    } else {
      a.tone({ f: 300, f2: 120, type: 'sine', a: 0.01, d: 0.5, g: 0.08 });
      this.say(r.outcome === 'lost' ? 'Lost in space' : 'Fizzled out', C.muted);
    }
  }

  private finish(): void {
    if (this.demo) return;
    const f = this.flight!;
    const used = this.build.planets.length, allowed = invTotal(this.def);
    finishLevel(this.ctx, pack, this.level, 'Gravity Golf', {
      goals: ['Sink it', 'Collect all 3 stardust', `Use fewer than ${allowed} planet${allowed === 1 ? '' : 's'}`],
      met: [true, f.dust === 7, used < allowed],
      stats: [
        { label: 'shots', value: String(this.shots) },
        { label: 'stardust', value: `${popcount(f.dust)} / 3` },
        { label: 'planets', value: `${used} / ${allowed}` },
      ],
      delayMs: 250,
    });
  }

  private demoTick(dt: number): void {
    this.demoT += dt;
    const sol = this.def.solution;
    if (this.phase === 'build') {
      if (this.demoStep < sol.planets.length && this.demoT > 0.8) {
        this.build.planets.push([...sol.planets[this.demoStep++]] as Placed); this.demoT = 0;
      } else if (this.demoStep >= sol.planets.length && this.demoT > 1.2) {
        this.shot = sol.shot;
        this.launch();
      }
    } else if ((this.phase === 'won' && this.phaseT > 1.6) || (this.phase === 'ended' && this.phaseT > 0.8)) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.start(this.seed, { demo: true });
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.ctx.canvas.el.removeEventListener('wheel', this.onWheel); this.ctx.audio.stopMusic(); }

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, planets: this.build.planets.length, phase: this.phase, shot: this.shot.join(',') };
  }

  // ---- render ---------------------------------------------------------------

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 4 : 66, bottom = small ? 4 : 92;
    const base = Math.min((w - 20) / WORLD.w, (h - top - bottom) / WORLD.h);
    this.s = base * this.zoom;
    const cx = 10 + (w - 20) / 2, cy = top + (h - top - bottom) / 2;
    // Zoom about the focus point, clamped so the world stays mostly in view.
    this.ox = cx - WORLD.w / 2 * base - (this.focus.x) * (this.s - base);
    this.oy = cy - WORLD.h / 2 * base - (this.focus.y) * (this.s - base);
    if (small) { this.btns = []; this.inv.layout([], 0, 0, 0, 0); return; }
    const items: InvItem[] = (['small', 'large'] as Size[]).filter((s) => this.def.inv[s]).map((s) => ({
      kind: s, count: this.left(s), label: s === 'small' ? 'small · 1' : 'large · 2.5',
      draw: (g, x, y, size) => drawPlanet(g, x, y, size * (s === 'small' ? 0.32 : 0.45), ACCENT, this.clock, true),
    }));
    this.inv.layout(items, (w - Math.max(100, items.length * 92)) / 2, h - 84, Math.max(100, items.length * 92), 76);
    const bs = 44, gap = 8, right = w - 64;
    const ed = this.editable();
    const ids: [string, Btn['icon'], boolean, string?][] = [
      ['reset', 'reset', ed && this.build.planets.length > 0], ['redo', 'redo', ed && this.hist.canRedo], ['undo', 'undo', ed && this.hist.canUndo],
    ];
    this.btns = ids.map(([id, icon, en], i) => ({ id, icon, x: right - (i + 1) * bs - i * gap, y: 12, w: bs, h: bs, enabled: en }));
    if (this.phase === 'fly' || this.phase === 'ended') this.btns.push({ id: 'retry', label: 'Retry', icon: 'reset', x: right - 3 * (bs + gap) - 130, y: 12, w: 122, h: bs, enabled: true, primary: true, hint: 'Space' });
  }

  render(): void {
    const g = this.ctx.canvas.begin(BG);
    this.layout();
    const fx = this.ctx.fx;
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    this.drawSpace(g);
    this.drawField(g);
    this.drawPreview(g);
    this.drawComet(g);
    g.save(); g.globalCompositeOperation = 'lighter'; fx.particles.render(g); g.restore();
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
  }

  private drawSpace(g: CanvasRenderingContext2D): void {
    const { w, h } = this.ctx.canvas;
    const tl = this.toScreen(0, 0), br = this.toScreen(WORLD.w, WORLD.h);
    const grad = g.createRadialGradient(w * 0.6, h * 0.4, 0, w * 0.6, h * 0.4, Math.max(w, h));
    grad.addColorStop(0, '#22185A'); grad.addColorStop(1, BG);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    for (const st of this.stars) {
      const px = ((st.x * w + this.clock * 4 * st.z - (this.focus.x - WORLD.w / 2) * 0.05 * st.z) % w + w) % w;
      const py = st.y * h;
      g.globalAlpha = 0.25 + 0.5 * st.z * (0.7 + 0.3 * Math.sin(this.clock * 2 + st.tw));
      g.fillStyle = '#FFFFFF';
      g.fillRect(px, py, st.z * 1.8, st.z * 1.8);
    }
    g.globalAlpha = 1;
    g.fillStyle = rgba(SPACE, 0.35); g.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    g.strokeStyle = rgba(ACCENT, 0.18); g.lineWidth = 1; g.setLineDash([4, 6]);
    g.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    g.setLineDash([]);
  }

  private drawField(g: CanvasRenderingContext2D): void {
    const s = this.s, d = this.def;
    const t = this.flight && this.phase !== 'build' ? Math.min(this.flight.k, this.flight.r.path.length / 3 - 1) * DT : 0;
    // Wormholes.
    d.holes.forEach(([ax, ay, bx, by]) => {
      for (const [x, y, dir] of [[ax, ay, 1], [bx, by, -1]] as const) {
        const p = this.toScreen(x, y);
        drawGlow(g, C.cyan, p.x, p.y, 34 * s, 0.4);
        g.save(); g.translate(p.x, p.y); g.rotate(this.clock * 2 * dir);
        for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(0, 0, (8 + k * 5) * s, k, k + 4); g.strokeStyle = rgba(C.cyan, 0.8 - k * 0.2); g.lineWidth = 2; g.stroke(); }
        g.restore();
      }
    });
    // Moons with their orbits.
    for (const m of d.moons) {
      const c = this.toScreen(m[0], m[1]);
      g.beginPath(); g.arc(c.x, c.y, m[2] * s, 0, Math.PI * 2); g.strokeStyle = rgba('#B8B0E8', 0.18); g.setLineDash([3, 6]); g.stroke(); g.setLineDash([]);
      const p0 = moonPos(m, t), p = this.toScreen(p0.x, p0.y);
      drawPlanet(g, p.x, p.y, m[5] * s, '#B8B0E8', this.clock, false);
      if (this.phase === 'build' || this.phase === 'aim') {
        const ahead = moonPos(m, t + 0.4), q = this.toScreen(ahead.x, ahead.y);
        g.strokeStyle = rgba('#B8B0E8', 0.5); g.lineWidth = 2;
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
      }
    }
    for (const [x, y, r] of d.rocks) {
      const p = this.toScreen(x, y);
      drawRock(g, p.x, p.y, r * s, x * 7 + y);
    }
    for (const [x, y, r, m] of d.planets) {
      const p = this.toScreen(x, y);
      if (m < 0) drawStar(g, p.x, p.y, r * s, this.clock);
      else drawPlanet(g, p.x, p.y, r * s, '#7A6CF0', this.clock + x, false);
    }
    const hold = this.drag && this.drag.kind === 'move' && !this.drag.moved && this.drag.t > 0.12 ? this.drag : null;
    this.build.planets.forEach(([sz, x, y], i) => {
      const p = this.toScreen(x, y);
      const r = PLANET[sz].r * s;
      for (let k = 1; k <= 3; k++) {
        g.beginPath(); g.arc(p.x, p.y, r + k * 16 * s * (sz === 'large' ? 1.4 : 1), 0, Math.PI * 2);
        g.strokeStyle = rgba(ACCENT, 0.14 / k); g.lineWidth = 1.5; g.stroke();
      }
      drawPlanet(g, p.x, p.y, r, ACCENT, this.clock + i, true);
      if (hold && hold.idx === i) {
        g.beginPath(); g.arc(p.x, p.y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hold.t / 0.5));
        g.strokeStyle = C.pink; g.lineWidth = 3; g.stroke();
      }
    });
    // Stardust.
    const got = this.flight?.dust ?? 0;
    d.dust.forEach(([x, y], i) => {
      if (got & (1 << i)) return;
      const p = this.toScreen(x, y);
      drawGlow(g, COMET, p.x, p.y, 16 * s, 0.4);
      g.save(); g.translate(p.x, p.y); g.rotate(this.clock * 1.5 + i);
      g.fillStyle = COMET;
      for (let k = 0; k < 4; k++) { g.rotate(Math.PI / 2); g.beginPath(); g.moveTo(0, 0); g.lineTo(2 * s, -2 * s); g.lineTo(0, -8 * s); g.lineTo(-2 * s, -2 * s); g.fill(); }
      g.restore();
    });
    // Black hole.
    const hp = this.toScreen(d.hole[0], d.hole[1]);
    const hr = HOLE_CAPTURE * s;
    drawGlow(g, ACCENT, hp.x, hp.y, hr * 3.4, 0.5);
    g.save(); g.translate(hp.x, hp.y); g.rotate(-this.clock * 1.2);
    for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(0, 0, hr * (1.9 - k * 0.15), hr * (0.75 - k * 0.08), k * 0.8, 0, Math.PI * 2); g.strokeStyle = rgba(k % 2 ? C.orange : C.pink, 0.55 - k * 0.1); g.lineWidth = 2; g.stroke(); }
    g.restore();
    g.beginPath(); g.arc(hp.x, hp.y, hr, 0, Math.PI * 2); g.fillStyle = '#000000'; g.fill();
    g.strokeStyle = rgba('#FFFFFF', 0.25); g.lineWidth = 1.5; g.stroke();
    if (this.ring > 0) {
      g.beginPath(); g.arc(hp.x, hp.y, hr + (1 - this.ring) * 140 * s, 0, Math.PI * 2);
      g.strokeStyle = rgba('#FFFFFF', this.ring); g.lineWidth = 4 * this.ring; g.stroke();
    }
    // Planet being dragged from the inventory.
    const d0 = this.drag;
    if (d0?.kind === 'new' && d0.moved) {
      const w = this.toWorld(d0.x, d0.y);
      const ok = placeOk(this.def, this.build.planets, d0.size, Math.round(w.x), Math.round(w.y));
      g.globalAlpha = ok ? 0.85 : 0.4;
      drawPlanet(g, d0.x, d0.y, PLANET[d0.size].r * s, ok ? ACCENT : C.pink, this.clock, true);
      g.globalAlpha = 1;
    }
  }

  private drawPreview(g: CanvasRenderingContext2D): void {
    if (this.phase !== 'aim' || !this.aim) return;
    const key = JSON.stringify([this.build.planets, this.shot]);
    if (key !== this.preview.key) {
      const r = simulate(this.def, this.build.planets, this.shot, 2);
      const n = Math.max(2, Math.floor((r.path.length / 3) * PREVIEW));
      this.preview = { key, pts: r.path.slice(0, n * 3) };
    }
    const c = this.toScreen(this.def.comet[0], this.def.comet[1]);
    // Slingshot band.
    g.strokeStyle = rgba(COMET, 0.6); g.lineWidth = 3;
    g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(this.aim.x, this.aim.y); g.stroke();
    const pts = this.preview.pts;
    for (let i = 0; i < pts.length; i += 3 * 4) {
      const p = this.toScreen(pts[i], pts[i + 1]);
      const k = 1 - i / pts.length;
      g.beginPath(); g.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      g.fillStyle = rgba('#FFFFFF', 0.25 + 0.6 * k); g.fill();
    }
    g.fillStyle = C.text; g.font = `700 13px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(`${Math.round(this.shot[1] * 100)}%`, this.aim.x, this.aim.y - 14);
  }

  private drawComet(g: CanvasRenderingContext2D): void {
    const s = this.s;
    if (this.tail.length > 1) {
      g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
      for (let i = 1; i < this.tail.length; i++) {
        const a = this.toScreen(this.tail[i - 1].x, this.tail[i - 1].y), b = this.toScreen(this.tail[i].x, this.tail[i].y);
        const k = i / this.tail.length;
        g.strokeStyle = speedColor(this.tail[i].v, k * 0.8);
        g.lineWidth = (2 + k * 6) * s;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
      g.restore();
    }
    if (this.phase === 'won' && this.phaseT > 0.2) return;
    const crashed = this.phase === 'ended' && this.flight?.r.outcome === 'crash';
    if (crashed) return;
    const pos = this.flight && this.phase !== 'build' && this.phase !== 'aim' ? this.cometPos() : { x: this.def.comet[0], y: this.def.comet[1], v: 0 };
    const p = this.toScreen(pos.x, pos.y);
    drawGlow(g, COMET, p.x, p.y, 26 * s, 0.6);
    g.beginPath(); g.arc(p.x, p.y, COMET_R * s, 0, Math.PI * 2); g.fillStyle = '#FFF6D0'; g.fill();
    if (this.phase === 'build' && !this.demo) {
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 4);
      g.beginPath(); g.arc(p.x, p.y, (COMET_R + 8 + pulse * 4) * s, 0, Math.PI * 2);
      g.strokeStyle = rgba(COMET, 0.35); g.lineWidth = 2; g.stroke();
    }
  }

  private drawUi(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    const room = titleRoom(this.btns, w - 64) - 16;
    g.fillText(fitText(g, `${this.level.chapter} ${this.level.n} · ${this.def.name}`, room), 16, 30);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`;
    const got = popcount(this.flight?.dust ?? 0);
    g.fillText(fitText(g, `stardust ${got}/3 · planets ${this.build.planets.length}/${invTotal(this.def)} · shots ${this.shots}`, room), 16, 50);
    for (const b of this.btns) drawBtn(g, b, ACCENT, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    this.inv.draw(g, ACCENT, null, hov ? this.inv.at(hov.x, hov.y)?.item.kind ?? null : null);
    if (this.message) {
      const m = this.message;
      g.globalAlpha = Math.min(1, m.t * 3);
      g.font = `700 24px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = m.color; g.fillText(m.text, w / 2, 96);
      g.globalAlpha = 1;
    }
    // Teach the slingshot without text: a ghost hand pulls back from the comet.
    if (this.level.n <= 2 && this.level.ch === 1 && this.phase === 'build' && this.idle > 2.5 && !this.shots) {
      const c = this.toScreen(this.def.comet[0], this.def.comet[1]);
      const sol = this.def.solution.shot;
      const a = (sol[0] * Math.PI) / 180, pull = sol[1] * MAX_PULL * this.s;
      const t = ((this.idle - 2.5) % 1.8) / 1.8;
      const k = Math.min(1, t / 0.6);
      const x = c.x - Math.cos(a) * pull * k, y = c.y - Math.sin(a) * pull * k;
      g.globalAlpha = t < 0.85 ? 0.8 : (1 - t) / 0.15 * 0.8;
      g.strokeStyle = rgba(COMET, 0.6); g.lineWidth = 3; g.setLineDash([5, 5]);
      g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#FFFFFF';
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  }
}

function popcount(n: number): number { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; }

function speedColor(v: number, a: number): string {
  const k = Math.min(1, v / 420);
  const r = Math.round(255 - k * 199), gg = Math.round(217 + k * 8), b = Math.round(61 + k * 184);
  return `rgba(${r},${gg},${b},${a})`;
}

function drawPlanet(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, t: number, placed: boolean): void {
  const grad = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  grad.addColorStop(0, placed ? '#D9CCFF' : '#B8B0E8');
  grad.addColorStop(0.55, col);
  grad.addColorStop(1, '#1B1240');
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
  g.save(); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = Math.max(1, r * 0.12);
  for (let k = -1; k <= 1; k++) { g.beginPath(); g.ellipse(x, y + k * r * 0.45 + Math.sin(t * 0.5) * r * 0.05, r * 1.2, r * 0.18, -0.25, 0, Math.PI * 2); g.stroke(); }
  g.restore();
  if (placed) { g.beginPath(); g.arc(x, y, r + 2, 0, Math.PI * 2); g.strokeStyle = rgba('#FFFFFF', 0.35); g.lineWidth = 1.5; g.stroke(); }
}

function drawStar(g: CanvasRenderingContext2D, x: number, y: number, r: number, t: number): void {
  drawGlow(g, C.pink, x, y, r * 3.5, 0.6);
  for (let k = 0; k < 3; k++) {
    const ph = (t * 0.8 + k / 3) % 1;
    g.beginPath(); g.arc(x, y, r * (1.2 + ph * 2.5), 0, Math.PI * 2);
    g.strokeStyle = rgba(C.pink, 0.4 * (1 - ph)); g.lineWidth = 2; g.stroke();
  }
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = '#FFD0E2'; g.fill();
}

function drawRock(g: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number): void {
  g.beginPath();
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2, rr = r * (0.8 + 0.25 * Math.abs(Math.sin(seed * 3.1 + k * 1.7)));
    if (k) g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath(); g.fillStyle = '#5A5470'; g.fill(); g.strokeStyle = '#7C7698'; g.lineWidth = 1; g.stroke();
}

export default (): Game => new GravityGolf();
