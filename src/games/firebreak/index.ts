import { midiHz } from '../../engine/audio';
import { History, undoKey } from '../../engine/editor/history';
import { drawBtn, fitGrid, fitText, hitBtn, InventoryBar, roundRect, titleRoom, type Btn, type InvItem } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import {
  canPlace, DIR_NAMES, DIRS, DT, emptyPlan, forecast, FORECAST_T, makeSim, outcome, starsMet, step, windAt,
  type FBLevel, type Plan, type Sim, type ToolKind,
} from './logic';
import { pack } from './pack';

const BG = '#0C120D';
const FIRE = C.orange;
const TOOLS: ToolKind[] = ['firebreak', 'water', 'backburn', 'rain'];
const TOOL_INFO: Record<ToolKind, { label: string; color: string }> = {
  firebreak: { label: 'Firebreak', color: '#B07A44' }, water: { label: 'Water', color: C.cyan },
  backburn: { label: 'Backburn', color: '#8A8A8A' }, rain: { label: 'Rain cloud', color: '#9FC8FF' },
};
const TERRAIN: Record<string, string> = {
  '.': '#59642A', b: '#3B6230', f: '#1E4B2C', H: '#59642A', '#': '#4A4D5C', '~': '#1D4C78', '=': '#55504A', ':': '#6A4C2E', a: '#3A3836',
};

type Phase = 'build' | 'burn' | 'end';

class Firebreak implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level!: Level<FBLevel>;
  private def!: FBLevel;
  private plan: Plan = emptyPlan();
  private hist = new History<Plan>(100);
  private tool: ToolKind = 'firebreak';
  private sim: Sim | null = null;
  private runPlan: Plan = emptyPlan();
  private phase: Phase = 'build';
  private phaseT = 0;
  private speed = 1;
  private acc = 0;
  private showForecast = false;
  private fc: Float32Array | null = null;
  private fcKey = '';
  private inv = new InventoryBar();
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private cell = 30;
  private ox = 0;
  private oy = 0;
  private stroke: { mode: 'add' | 'erase'; before: string; id: number; last: number; t: number; moved: boolean; start: number } | null = null;
  private denied: { i: number; t: number } | null = null;
  private banner: { text: string; t: number; color: string } | null = null;
  private clock = 0;
  private time = 0;
  private idle = 0;
  private demo = false;
  private demoT = 0;
  private seed = 1;
  private crackle: { set(f: number, g: number, glide?: number): void; stop(): void } | null = null;
  private won = false;
  private rainFx = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', () => { this.pressBtn = null; this.endStroke(); });
    ctx.input.on('alt', (p) => { const i = this.cellAt(p.x, p.y); if (i >= 0 && this.phase === 'build') this.toggle(i, 'erase', true); });
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      this.idle = 0;
      const u = undoKey(code, e);
      if (u && this.phase === 'build') { e.preventDefault(); this.button(u); return; }
      if (code === 'Space' || code === 'Enter') { e.preventDefault(); this.button(this.phase === 'burn' ? 'speed' : 'ignite'); }
      else if (code === 'KeyF' && this.phase === 'build') this.button('forecast');
      else if (code === 'KeyR' && this.phase === 'burn') this.button('reset');
      else if (/^Digit[1-4]$/.test(code)) { const sl = this.inv.slots[Number(code.slice(5)) - 1]; if (sl) this.tool = sl.item.kind as ToolKind; }
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 2); lv = pool[seed % pool.length] ?? lv; }
    this.load(lv);
  }

  private load(level: Level<FBLevel>): void {
    this.level = level;
    this.def = level.def;
    this.plan = emptyPlan();
    this.hist.clear();
    this.tool = 'firebreak';
    this.toBuild();
    this.time = 0; this.idle = 0; this.demoT = 0; this.showForecast = false; this.won = false;
  }

  private toBuild(): void {
    this.phase = 'build'; this.phaseT = 0;
    this.sim = null; this.speed = 1; this.acc = 0; this.rainFx = 0;
    this.crackle?.stop(); this.crackle = null;
  }

  // ---- plan editing -----------------------------------------------------------

  private left(k: ToolKind): number {
    const used = k === 'rain' ? this.runPlan.rain.length : this.plan[k].length;
    return (this.def.tools[k] ?? 0) - (k === 'rain' && this.phase !== 'burn' ? 0 : used);
  }

  private at(i: number): ToolKind | null {
    const c = i % this.w(), r = Math.floor(i / this.w());
    if (this.plan.firebreak.some((p) => p[0] === c && p[1] === r)) return 'firebreak';
    if (this.plan.backburn.some((p) => p[0] === c && p[1] === r)) return 'backburn';
    if (this.plan.water.some((p) => p[0] === c && p[1] === r)) return 'water';
    return null;
  }

  private w(): number { return this.def.rows[0].length; }
  private h(): number { return this.def.rows.length; }

  private cellAt(x: number, y: number): number {
    const c = Math.floor((x - this.ox) / this.cell), r = Math.floor((y - this.oy) / this.cell);
    return c >= 0 && r >= 0 && c < this.w() && r < this.h() ? r * this.w() + c : -1;
  }

  private down(p: Pointer): void {
    if (this.demo) return;
    this.idle = 0;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    const slot = this.inv.at(p.x, p.y);
    if (slot) { this.tool = slot.item.kind as ToolKind; this.ctx.audio.tick(1500, 0.05); return; }
    const i = this.cellAt(p.x, p.y);
    if (i < 0) return;
    if (this.phase === 'burn') { this.dropRain(i); return; }
    if (this.phase !== 'build' || this.tool === 'rain') { if (this.tool === 'rain') this.say('Rain clouds are used during the burn', C.muted); return; }
    const has = this.at(i);
    this.stroke = { mode: has ? 'erase' : 'add', before: JSON.stringify(this.plan), id: p.id, last: -1, t: 0, moved: false, start: i };
    this.strokeAt(i);
  }

  private move(p: Pointer): void {
    const s = this.stroke;
    if (!s || s.id !== p.id || !p.down) return;
    const i = this.cellAt(p.x, p.y);
    if (i >= 0 && i !== s.last) { s.moved = true; this.strokeAt(i); }
  }

  private strokeAt(i: number): void {
    const s = this.stroke!;
    s.last = i;
    this.toggle(i, s.mode, false);
  }

  private endStroke(): void {
    const s = this.stroke;
    this.stroke = null;
    if (s && JSON.stringify(this.plan) !== s.before) this.hist.push(s.before);
  }

  private toggle(i: number, mode: 'add' | 'erase', record: boolean): void {
    const before = JSON.stringify(this.plan);
    const c = i % this.w(), r = Math.floor(i / this.w());
    const a = this.ctx.audio;
    const has = this.at(i);
    if (mode === 'erase') {
      if (!has || has === 'rain') return;
      this.plan[has] = this.plan[has].filter((q) => q[0] !== c || q[1] !== r);
      a.pop(380, 0.12);
    } else {
      if (has) return;
      const k = this.tool;
      if (k === 'rain') return;
      if (this.left(k) <= 0) { this.deny(i, `No ${TOOL_INFO[k].label.toLowerCase()}s left`); return; }
      if (!canPlace(this.def.rows, k, c, r, this.def.starts)) { this.deny(i, k === 'firebreak' ? 'Only grass or bush can be cleared' : k === 'backburn' ? 'Backburn plants only' : null); return; }
      this.plan[k].push([c, r]);
      if (k === 'firebreak') { a.noise({ d: 0.08, g: 0.12, f: 900, type: 'lowpass' }); a.thud(0.3); }
      else if (k === 'water') a.noise({ d: 0.25, g: 0.12, f: 1800, f2: 600, type: 'bandpass', q: 1 });
      else a.noise({ d: 0.3, g: 0.08, f: 2500, f2: 800, type: 'bandpass', q: 0.8 });
    }
    if (record && JSON.stringify(this.plan) !== before) this.hist.push(before);
  }

  private deny(i: number, text: string | null): void {
    this.denied = { i, t: 0.4 };
    this.ctx.audio.buzz();
    if (text) this.say(text, C.pink);
  }

  private say(text: string, color: string): void { this.banner = { text, t: 1.6, color }; }

  private dropRain(i: number): void {
    if (!this.sim || this.left('rain') <= 0) { if ((this.def.tools.rain ?? 0) > 0) this.ctx.audio.buzz(); return; }
    const c = i % this.w(), r = Math.floor(i / this.w());
    // Recorded at the current sim time; applied on the next step (identical on replay).
    this.runPlan.rain.push([this.sim.t, c, r]);
    this.sim.rainQueue.push([this.sim.t, c, r]);
    this.ctx.audio.noise({ d: 1.4, g: 0.16, f: 3000, f2: 1200, type: 'bandpass', q: 0.6, a: 0.1 });
    this.rainFx = 1;
  }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'undo' || id === 'redo') {
      if (this.phase !== 'build') return;
      const s = id === 'undo' ? this.hist.undo(this.plan) : this.hist.redo(this.plan);
      if (!s) { a.buzz(); return; }
      this.plan = s; a.tick(1300, 0.06);
    } else if (id === 'clear') {
      if (this.phase !== 'build' || !(this.plan.firebreak.length + this.plan.water.length + this.plan.backburn.length)) return;
      this.hist.push(this.plan); this.plan = emptyPlan(); a.whoosh(0.12, 0.2);
    } else if (id === 'forecast') {
      this.showForecast = !this.showForecast; a.tick(this.showForecast ? 1700 : 1100, 0.06);
    } else if (id === 'ignite') {
      if (this.phase !== 'build') return;
      this.ignite();
    } else if (id === 'speed') {
      this.speed = this.speed === 1 ? 4 : 1; a.tick(this.speed === 4 ? 2000 : 1200, 0.06);
    } else if (id === 'reset') {
      this.toBuild(); a.whoosh(0.1, 0.2);
    }
  }

  private ignite(): void {
    this.runPlan = { ...structuredClone(this.plan), rain: [] };
    this.sim = makeSim(this.def, this.runPlan);
    this.phase = 'burn'; this.phaseT = 0; this.acc = 0;
    this.showForecast = false;
    const a = this.ctx.audio;
    a.noise({ d: 0.5, g: 0.25, f: 400, f2: 2400, type: 'bandpass', q: 0.8 });
    a.tone({ f: 90, f2: 60, type: 'sine', a: 0.01, d: 0.6, g: 0.25 });
    this.crackle = a.drone('noise', 1200);
    this.tool = (this.def.tools.rain ?? 0) > 0 ? 'rain' : this.tool;
  }

  // ---- loop -------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt; this.time += dt; this.idle += dt; this.phaseT += dt;
    this.rainFx = Math.max(0, this.rainFx - dt * 0.5);
    if (this.denied && (this.denied.t -= dt) <= 0) this.denied = null;
    if (this.banner && (this.banner.t -= dt) <= 0) this.banner = null;
    if (this.demo) this.demoTick(dt);
    if (this.phase === 'burn' && this.sim) this.burnTick(dt);
    if (this.phase === 'end' && this.phaseT > 2.2 && !this.won && !this.demo) this.toBuild();
  }

  private burnTick(dt: number): void {
    const s = this.sim!;
    this.acc += dt * this.speed;
    let n = 0;
    let fires = 0;
    while (this.acc >= DT && !s.done && n < 40) {
      step(this.def, s);
      this.acc -= DT; n++;
      for (const [from, to] of s.embers) this.emberFx(from, to);
    }
    for (let i = 0; i < s.state.length; i++) if (s.state[i] === 1) fires++;
    this.crackle?.set(900 + fires * 4, Math.min(0.08, fires * 0.004), 0.2);
    this.fireFx(s, dt);
    if (s.done) this.finishBurn();
  }

  private fireFx(s: Sim, dt: number): void {
    if (!this.ctx.settings.motion && this.rng.next() > 0.3) return;
    const p = this.ctx.fx.particles;
    const wind = windAt(this.def, s.t);
    const [wx, wy] = DIRS[wind.dir];
    const ws = wind.strength * 18;
    for (let i = 0; i < s.state.length; i++) {
      if (s.state[i] !== 1) continue;
      if (this.rng.next() > dt * 10) continue;
      const x = this.ox + ((i % s.w) + this.rng.range(0.2, 0.8)) * this.cell, y = this.oy + (Math.floor(i / s.w) + this.rng.range(0.3, 0.8)) * this.cell;
      p.spawn(x, y, wx * ws + this.rng.range(-8, 8), -30 + wy * ws, 0.5, this.cell * 0.22, 0, this.rng.chance(0.5) ? FIRE : C.yellow, Shape.Glow, -20, 1);
      if (this.rng.chance(0.25)) p.spawn(x, y - this.cell * 0.3, wx * (ws + 20), -18 + wy * (ws + 20), 2.2, this.cell * 0.25, this.cell * 0.9, 'rgba(90,86,80,0.35)', Shape.Dot, -4, 0.3);
    }
  }

  private emberFx(from: number, to: number): void {
    const s = this.sim!;
    const ax = this.ox + ((from % s.w) + 0.5) * this.cell, ay = this.oy + (Math.floor(from / s.w) + 0.5) * this.cell;
    const bx = this.ox + ((to % s.w) + 0.5) * this.cell, by = this.oy + (Math.floor(to / s.w) + 0.5) * this.cell;
    for (let k = 0; k < 6; k++) this.ctx.fx.particles.spawn(ax, ay, (bx - ax) / 0.6 + this.rng.range(-10, 10), (by - ay) / 0.6 - 60, 0.6, 2.5, 1, C.yellow, Shape.Spark, 200, 0);
    this.ctx.audio.tick(2600, 0.04);
  }

  private finishBurn(): void {
    const s = this.sim!;
    const o = outcome(this.def, s);
    const met = starsMet(this.def, o);
    this.phase = 'end'; this.phaseT = 0;
    this.crackle?.stop(); this.crackle = null;
    const a = this.ctx.audio;
    if (met[0]) {
      this.won = true;
      // Calm acoustic sting: a gentle plucked arpeggio.
      [0, 4, 7, 11, 14].forEach((n, i) => a.tone({ f: midiHz(62 + n), type: 'triangle', a: 0.004, d: 0.9, g: 0.1, at: i * 0.12 }));
      a.noise({ d: 2.4, g: 0.06, f: 4000, f2: 2000, type: 'bandpass', q: 0.5, a: 0.4 });
      if (this.demo) return;
      finishLevel(this.ctx, pack, this.level, 'Firebreak', {
        goals: [`Save ${this.def.target} houses`, 'Save every house', `…and keep ${this.def.forest}% of the forest`],
        met,
        stats: [
          { label: 'houses', value: `${o.saved} / ${o.houses}` },
          { label: 'forest kept', value: `${o.forestPct}%` },
          { label: 'burn time', value: `${Math.round(o.t)} s` },
        ],
        delayMs: 1800,
      });
    } else {
      // Sad trombone.
      [0, -1, -2, -3].forEach((n, i) => a.tone({ f: midiHz(55 + n), f2: midiHz(54 + n), type: 'sawtooth', a: 0.02, d: i === 3 ? 0.9 : 0.32, g: 0.07, lp: 900, at: i * 0.34 }));
      this.say(`${o.saved} of ${o.houses} houses saved. Your plan is still here.`, C.pink);
      this.banner!.t = 2.4;
    }
  }

  private demoTick(dt: number): void {
    this.demoT += dt;
    if (this.phase === 'build' && this.demoT > 1.2) {
      this.plan = structuredClone({ ...this.def.solution, rain: [] });
      this.ignite();
      this.speed = 4;
      for (const r of this.def.solution.rain) this.sim!.rainQueue.push([...r]);
      this.sim!.rainQueue.sort((x, y) => x[0] - y[0]);
    }
    if (this.phase === 'end' && this.phaseT > 2) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.start(this.seed, { demo: true });
    }
  }

  pause(): void { this.crackle?.set(0, 0, 0.05); }
  resume(): void {}
  destroy(): void { this.crackle?.stop(); }

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, phase: this.phase, t: this.sim?.t ?? 0, speed: this.speed };
  }

  // ---- render -------------------------------------------------------------------

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 6 : 70, bottom = small ? 6 : 96;
    const g = fitGrid(this.w(), this.h(), 10, top, w - 20, h - top - bottom, 46);
    this.cell = g.cell; this.ox = g.ox; this.oy = g.oy;
    if (small) { this.btns = []; this.inv.layout([], 0, 0, 0, 0); return; }
    const items: InvItem[] = TOOLS.filter((k) => this.def.tools[k]).map((k) => ({
      kind: k, count: this.left(k), label: TOOL_INFO[k].label,
      draw: (g2, cx, cy, s) => drawTool(g2, k, cx, cy, s),
    }));
    const barH = 80;
    const relW = Math.min(170, w * 0.3);
    this.inv.layout(items, 12, h - barH - 10, Math.min(w - relW - 40, items.length * (barH + 8)), barH);
    const bs = 44, gap = 8, right = w - 64;
    const build = this.phase === 'build';
    const ids: [string, Btn['icon'], boolean][] = build
      ? [['clear', 'trash', this.plan.firebreak.length + this.plan.water.length + this.plan.backburn.length > 0], ['redo', 'redo', this.hist.canRedo], ['undo', 'undo', this.hist.canUndo]]
      : [['reset', 'reset', true]];
    this.btns = ids.map(([id, icon, en], i) => ({ id, icon, x: right - (i + 1) * bs - i * gap, y: 12, w: bs, h: bs, enabled: en }));
    const by = h - barH / 2 - 10 - 27;
    if (build) {
      this.btns.push({ id: 'forecast', icon: 'eye', label: w > 520 ? 'Forecast' : undefined, x: w - relW - 12 - (w > 520 ? 132 : 60), y: by, w: w > 520 ? 124 : 52, h: 54, enabled: true, active: this.showForecast });
      this.btns.push({ id: 'ignite', icon: 'play', label: 'Ignite', x: w - relW - 12, y: by, w: relW, h: 54, enabled: true, primary: true });
    } else if (this.phase === 'burn') {
      this.btns.push({ id: 'speed', label: this.speed === 4 ? 'Speed ×4' : 'Speed ×1', x: w - relW - 12, y: by, w: relW, h: 54, enabled: true, active: this.speed === 4 });
    }
  }

  render(): void {
    const g = this.ctx.canvas.begin(BG);
    this.layout();
    const fx = this.ctx.fx;
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    this.drawMap(g);
    fx.particles.render(g);
    if (this.phase === 'end' && this.won) this.drawRain(g, this.phaseT);
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
  }

  private drawMap(g: CanvasRenderingContext2D): void {
    const { cell, ox, oy } = this;
    const W = this.w(), H = this.h();
    const s = this.sim;
    const ter = s ? s.ter : this.previewTerrain();
    if (this.showForecast && this.phase === 'build') {
      const key = JSON.stringify(this.plan);
      if (key !== this.fcKey) { this.fc = forecast(this.def, this.plan); this.fcKey = key; }
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c, ch = ter[r][c], x = ox + c * cell, y = oy + r * cell;
      const st = s ? s.state[i] : 0;
      g.fillStyle = st === 2 ? (ch === 'f' ? '#1E1B19' : '#2A2623') : TERRAIN[ch] ?? '#333';
      g.fillRect(x, y, cell + 0.5, cell + 0.5);
      if (st !== 2) this.drawCellDetail(g, ch, x, y, c, r);
      if (st === 2 && ch === 'H') this.drawHouse(g, x, y, true);
      if (s && st === 0 && s.heat[i] > 0) { g.fillStyle = rgba(FIRE, Math.min(0.5, s.heat[i] * 0.5)); g.fillRect(x, y, cell, cell); }
      if (st === 1) {
        const fl = 0.55 + 0.45 * Math.sin(this.clock * 18 + i * 1.7) * Math.sin(this.clock * 7 + i);
        g.fillStyle = rgba('#3A1408', 0.6); g.fillRect(x, y, cell, cell);
        drawGlow(g, FIRE, x + cell / 2, y + cell / 2, cell * 1.1, 0.55 * fl);
        g.fillStyle = rgba(C.yellow, 0.35 * fl); g.fillRect(x + cell * 0.25, y + cell * 0.3, cell * 0.5, cell * 0.5);
      }
      const soaked = s ? s.soaked[i] : this.plan.water.some(([wc, wr]) => c >= wc && c <= wc + 1 && r >= wr && r <= wr + 1);
      if (soaked && st !== 2) { g.fillStyle = 'rgba(80,160,255,0.22)'; g.fillRect(x, y, cell, cell); }
      if (s && s.rainUntil[i] > s.t) {
        g.strokeStyle = 'rgba(170,210,255,0.6)'; g.lineWidth = 1.2;
        for (let k = 0; k < 3; k++) {
          const ry = ((this.clock * 3 + k / 3 + c * 0.13) % 1) * cell;
          g.beginPath(); g.moveTo(x + (k + 0.5) * cell / 3, y + ry); g.lineTo(x + (k + 0.3) * cell / 3, y + ry + cell * 0.25); g.stroke();
        }
      }
      if (this.fc && this.showForecast && this.phase === 'build' && this.fc[i] >= 0) {
        const k = 1 - this.fc[i] / FORECAST_T;
        g.fillStyle = `rgba(255,${Math.round(200 - 160 * k)},60,${0.18 + 0.32 * k})`;
        g.fillRect(x, y, cell, cell);
      }
    }
    // Saved-house bubbles once the fire is out.
    if (this.phase === 'end' && s) {
      for (let i = 0; i < s.state.length; i++) {
        if (s.ter[Math.floor(i / W)][i % W] !== 'H' || s.litAt[i] >= 0) continue;
        const k = Math.min(1, this.phaseT * 3 - ((i * 7) % 5) * 0.1);
        if (k <= 0) continue;
        const bx = ox + ((i % W) + 0.5) * cell, by = oy + Math.floor(i / W) * cell - cell * 0.35 * k;
        g.globalAlpha = k;
        g.beginPath(); g.arc(bx, by, cell * 0.32, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill();
        g.fillStyle = '#2A2A2A';
        g.beginPath(); g.arc(bx - cell * 0.1, by - cell * 0.05, cell * 0.035, 0, Math.PI * 2); g.arc(bx + cell * 0.1, by - cell * 0.05, cell * 0.035, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#2A2A2A'; g.lineWidth = 1.5; g.beginPath(); g.arc(bx, by + cell * 0.02, cell * 0.12, 0.2, Math.PI - 0.2); g.stroke();
        g.globalAlpha = 1;
      }
    }
    // Fire starts.
    if (this.phase === 'build') for (const [c, r] of this.def.starts) {
      const x = ox + (c + 0.5) * cell, y = oy + (r + 0.5) * cell;
      drawGlow(g, FIRE, x, y, cell * (0.9 + 0.15 * Math.sin(this.clock * 5)), 0.6);
      g.fillStyle = C.yellow; g.font = `700 ${Math.round(cell * 0.6)}px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('✶', x, y + 1);
    }
    // Ghost of the selected tool under the mouse.
    const hv = this.ctx.input.hasHover && !this.demo ? this.ctx.input.hover : null;
    if (hv && (this.phase === 'build' || (this.phase === 'burn' && this.left('rain') > 0))) {
      const i = this.cellAt(hv.x, hv.y);
      if (i >= 0) {
        const c = i % W, r = Math.floor(i / W);
        const k = this.phase === 'burn' ? 'rain' : this.tool;
        const span = k === 'water' ? [0, 1] : k === 'rain' ? [-1, 1] : [0, 0];
        g.strokeStyle = rgba(TOOL_INFO[k].color, 0.8); g.lineWidth = 2;
        g.strokeRect(ox + (c + span[0]) * cell + 1, oy + (r + span[0]) * cell + 1, (span[1] - span[0] + 1) * cell - 2, (span[1] - span[0] + 1) * cell - 2);
      }
    }
    if (this.denied) {
      const c = this.denied.i % W, r = Math.floor(this.denied.i / W);
      g.fillStyle = rgba(C.pink, this.denied.t * 1.5); g.fillRect(ox + c * cell, oy + r * cell, cell, cell);
    }
    // Level 1 teaches without text: pulse where the firebreaks go.
    if (this.level.id === '1-1' && this.phase === 'build' && !this.plan.firebreak.length && this.idle > 3) {
      const k = (this.idle * 1.2) % 1;
      for (const [c, r] of this.def.solution.firebreak) {
        g.strokeStyle = rgba(C.yellow, 1 - k); g.lineWidth = 3;
        g.strokeRect(ox + c * cell - k * 6, oy + r * cell - k * 6, cell + k * 12, cell + k * 12);
      }
    }
  }

  /** Terrain with tools applied (build view). */
  private previewTerrain(): string[] {
    const rows = this.def.rows.map((r) => r.split(''));
    for (const [c, r] of this.plan.firebreak) rows[r][c] = ':';
    for (const [c, r] of this.plan.backburn) rows[r][c] = 'a';
    return rows.map((r) => r.join(''));
  }

  private drawCellDetail(g: CanvasRenderingContext2D, ch: string, x: number, y: number, c: number, r: number): void {
    const cell = this.cell;
    const j = (k: number) => (((Math.sin((c * 31 + r * 17 + k) * 12.9898) * 43758.5453) % 1) + 1) % 1;
    if (ch === 'f') {
      for (let k = 0; k < 2; k++) {
        const tx = x + cell * (0.25 + 0.5 * j(k)), ty = y + cell * (0.35 + 0.4 * j(k + 5));
        g.fillStyle = k ? '#2E6B3C' : '#275C33';
        g.beginPath(); g.moveTo(tx, ty - cell * 0.3); g.lineTo(tx + cell * 0.2, ty + cell * 0.1); g.lineTo(tx - cell * 0.2, ty + cell * 0.1); g.fill();
      }
    } else if (ch === 'b') {
      g.fillStyle = '#4C7A3A';
      for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(x + cell * (0.2 + 0.6 * j(k)), y + cell * (0.3 + 0.5 * j(k + 3)), cell * 0.14, 0, Math.PI * 2); g.fill(); }
    } else if (ch === '.') {
      g.strokeStyle = '#6E7A34'; g.lineWidth = 1;
      for (let k = 0; k < 3; k++) { const gx = x + cell * j(k), gy = y + cell * (0.4 + 0.5 * j(k + 7)); g.beginPath(); g.moveTo(gx, gy); g.lineTo(gx + 1, gy - cell * 0.2); g.stroke(); }
    } else if (ch === 'H') this.drawHouse(g, x, y, false);
    else if (ch === '~') {
      g.strokeStyle = 'rgba(150,200,255,0.3)'; g.lineWidth = 1.2;
      const ph = this.clock * 1.4 + c * 0.6 + r;
      g.beginPath(); g.moveTo(x + cell * 0.15, y + cell * (0.5 + 0.06 * Math.sin(ph))); g.lineTo(x + cell * 0.6, y + cell * (0.5 + 0.06 * Math.sin(ph + 1))); g.stroke();
    } else if (ch === '#') {
      g.fillStyle = '#5C6074'; g.beginPath(); g.ellipse(x + cell / 2, y + cell * 0.55, cell * 0.36, cell * 0.28, 0, 0, Math.PI * 2); g.fill();
    } else if (ch === '=') {
      g.strokeStyle = 'rgba(255,230,160,0.25)'; g.setLineDash([cell * 0.2, cell * 0.2]);
      g.beginPath(); g.moveTo(x, y + cell / 2); g.lineTo(x + cell, y + cell / 2); g.stroke(); g.setLineDash([]);
    } else if (ch === ':') {
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1.5;
      for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x + 2, y + (k * cell) / 4); g.lineTo(x + cell - 2, y + (k * cell) / 4); g.stroke(); }
    }
  }

  private drawHouse(g: CanvasRenderingContext2D, x: number, y: number, burnt: boolean): void {
    const s = this.cell;
    g.fillStyle = burnt ? '#2C2724' : '#E9DCC0';
    g.fillRect(x + s * 0.22, y + s * 0.45, s * 0.56, s * 0.42);
    g.fillStyle = burnt ? '#1A1716' : '#D9534F';
    g.beginPath(); g.moveTo(x + s * 0.14, y + s * 0.48); g.lineTo(x + s * 0.5, y + s * 0.16); g.lineTo(x + s * 0.86, y + s * 0.48); g.fill();
    if (!burnt) { g.fillStyle = '#7A5A3A'; g.fillRect(x + s * 0.44, y + s * 0.64, s * 0.13, s * 0.23); }
  }

  private drawRain(g: CanvasRenderingContext2D, t: number): void {
    const { w, h } = this.ctx.canvas;
    g.strokeStyle = `rgba(170,200,255,${Math.min(0.45, t * 0.4)})`; g.lineWidth = 1.2;
    for (let k = 0; k < 140; k++) {
      const x = ((k * 97.3) % w) + Math.sin(k) * 10;
      const y = ((k * 53.1 + t * 600) % (h + 40)) - 20;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - 4, y + 14); g.stroke();
    }
  }

  private drawUi(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const room = titleRoom(this.btns, w - 64) - 16;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    g.fillText(fitText(g, `${this.level.chapter} ${this.level.n} · ${this.def.name}`, room), 16, 30);
    // Wind and goal.
    const t = this.sim?.t ?? 0;
    const wind = windAt(this.def, t);
    const next = this.def.wind.find((s) => s[0] > t);
    const str = ['Calm', 'Breeze', 'Strong wind'][wind.strength];
    g.font = `600 13px ${FONT.ui}`; g.fillStyle = C.muted;
    const houses = this.def.rows.join('').split('H').length - 1;
    const info = `${str}${wind.strength ? ` → ${DIR_NAMES[wind.dir]}` : ''}${next ? ` · turns ${DIR_NAMES[next[1]]} at ${next[0]} s` : ''} · save ${this.def.target}/${houses} houses${this.sim ? ` · ${Math.floor(t)} s` : ''}`;
    g.fillText(fitText(g, info, room - 28), 44, 52);
    // Wind arrow.
    g.save(); g.translate(28, 48);
    if (wind.strength) {
      const [dx, dy] = DIRS[wind.dir];
      g.rotate(Math.atan2(dy, dx));
      g.strokeStyle = wind.strength === 2 ? C.pink : C.text; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(-9, 0); g.lineTo(9, 0); g.moveTo(3, -5); g.lineTo(9, 0); g.lineTo(3, 5); g.stroke();
    } else { g.beginPath(); g.arc(0, 0, 5, 0, Math.PI * 2); g.strokeStyle = C.muted; g.stroke(); }
    g.restore();
    for (const b of this.btns) drawBtn(g, b, FIRE, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    this.inv.draw(g, FIRE, this.phase === 'burn' ? 'rain' : this.tool, hov ? this.inv.at(hov.x, hov.y)?.item.kind ?? null : null, matchMedia('(pointer: fine)').matches);
    if (this.banner) {
      const b = this.banner;
      g.globalAlpha = Math.min(1, b.t * 3);
      g.font = `700 20px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(b.text).width + 36;
      const cy = this.oy + this.h() * this.cell / 2;
      roundRect(g, w / 2 - tw / 2, cy - 24, tw, 48, 24); g.fillStyle = 'rgba(12,14,12,0.9)'; g.fill();
      g.fillStyle = b.color; g.fillText(b.text, w / 2, cy + 1);
      g.globalAlpha = 1;
    }
  }
}

function drawTool(g: CanvasRenderingContext2D, k: ToolKind, cx: number, cy: number, s: number): void {
  const r = s * 0.42;
  if (k === 'firebreak') {
    g.fillStyle = TERRAIN[':']; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2;
    for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(cx - r + 3, cy + i * r * 0.5); g.lineTo(cx + r - 3, cy + i * r * 0.5); g.stroke(); }
  } else if (k === 'water') {
    g.fillStyle = 'rgba(80,160,255,0.35)'; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = C.cyan; g.beginPath(); g.moveTo(cx, cy - r * 0.8); g.quadraticCurveTo(cx + r * 0.6, cy + r * 0.1, cx, cy + r * 0.6); g.quadraticCurveTo(cx - r * 0.6, cy + r * 0.1, cx, cy - r * 0.8); g.fill();
  } else if (k === 'backburn') {
    g.fillStyle = TERRAIN.a; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = C.orange; g.beginPath(); g.moveTo(cx, cy - r * 0.7); g.quadraticCurveTo(cx + r * 0.5, cy, cx, cy + r * 0.5); g.quadraticCurveTo(cx - r * 0.5, cy, cx, cy - r * 0.7); g.fill();
  } else {
    g.fillStyle = '#C9DCF5';
    for (const [dx, dy, rr] of [[-0.35, 0, 0.35], [0.1, -0.15, 0.45], [0.45, 0.05, 0.3]]) { g.beginPath(); g.arc(cx + dx * r, cy + dy * r, rr * r, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = C.cyan; g.lineWidth = 2;
    for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(cx + i * r * 0.4, cy + r * 0.35); g.lineTo(cx + i * r * 0.4 - 3, cy + r * 0.8); g.stroke(); }
  }
}


export default (): Game => new Firebreak();
