import { midiHz } from '../../engine/audio';
import { History, undoKey } from '../../engine/editor/history';
import { EditorPanel, exportJson } from '../../engine/editor/panel';
import { drawBtn, fitGrid, fitText, hitBtn, InventoryBar, roundRect, titleRoom, type Btn, type InvItem } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { editorMode } from '../../engine/levels/progress';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import {
  DefenceSim, Field, H, HEARTS, idx, monsterXY, pathLength, puzzleGoals, shortestPath, SIM_DT, TRAPS, W, xy,
  type MMLevel, type TrapKind,
} from './logic';
import { pack } from './pack';

const BG = '#0A0C16';
const PATH = C.yellow;
const MON = C.violet;
const TOOLS: ('wall' | TrapKind)[] = ['wall', 'spikes', 'goo', 'cannon', 'bounce'];

interface Build { walls: number[]; traps: [TrapKind, number, number][] }
type Phase = 'build' | 'walk' | 'waves' | 'done';

class MazeMaker implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level!: Level<MMLevel>;
  private def!: MMLevel;
  private f!: Field;
  private build: Build = { walls: [], traps: [] };
  private mask = new Uint8Array(W * H);
  private path: number[] = [];
  private len = 0;
  private shown = 0;
  private drawK = 1;
  private oldPath: number[] = [];
  private hist = new History<Build>(100);
  private btns: Btn[] = [];
  private inv = new InventoryBar();
  private tool: 'wall' | TrapKind = 'wall';
  private phase: Phase = 'build';
  private phaseT = 0;
  private demo = false;
  private demoStep = 0;
  private demoT = 0;
  private seed = 1;
  private time = 0;
  private clock = 0;
  private cell = 40;
  private ox = 0;
  private oy = 0;
  private stroke: { mode: 'add' | 'erase'; before: string; id: number; last: number } | null = null;
  private denied: { i: number; t: number } | null = null;
  private plucks: number[] = [];
  private pluckN = 0;
  private reachedBest = false;
  private glow = 0;
  // Release walk (puzzle).
  private walker = { pos: 0, speed: 4, prints: [] as { x: number; y: number; a: number }[] };
  // Waves (defence).
  private sim: DefenceSim | null = null;
  private acc = 0;
  private fast = false;
  private banner: { text: string; t: number; color: string } | null = null;
  private editor: EditorPanel | null = null;
  private editTool: string | null = null;
  private pressBtn: string | null = null;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', () => { this.pressBtn = null; this.endStroke(); });
    ctx.input.on('alt', (p) => {
      if (this.phase !== 'build' || this.demo) return;
      const i = this.cellAt(p.x, p.y);
      if (i >= 0) this.toggleAt(i, 'erase', true);
    });
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      const u = undoKey(code, e);
      if (u && this.phase === 'build') { e.preventDefault(); this.button(u); return; }
      if ((code === 'Enter' || code === 'Space') && this.phase === 'build') { e.preventDefault(); this.button('release'); }
      else if (code === 'KeyF' && this.phase === 'waves') this.fast = !this.fast;
      else if (/^Digit[1-5]$/.test(code) && this.def.mode === 'defence') { const t = TOOLS[Number(code.slice(5)) - 1]; if (t) this.tool = t; }
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) {
      const pool = pack.levels.filter((l) => l.def.mode === 'puzzle' && l.index >= 3);
      lv = pool[seed % pool.length] ?? pack.levels[0];
    }
    this.load(lv);
  }

  private load(level: Level<MMLevel>): void {
    this.level = level;
    this.def = structuredClone(level.def);
    this.f = new Field(this.def);
    this.build = { walls: [], traps: [] };
    this.hist.clear();
    this.phase = 'build'; this.phaseT = 0;
    this.time = 0; this.demoStep = 0; this.demoT = 0;
    this.tool = 'wall'; this.sim = null; this.banner = null;
    this.reachedBest = false; this.glow = 0;
    this.recompute(true);
    this.shown = this.len;
    this.setupEditor();
  }

  // ---- build ----------------------------------------------------------------

  private recompute(silent = false): void {
    this.mask.fill(0);
    for (const i of this.build.walls) this.mask[i] = 1;
    const prev = this.len;
    const p = shortestPath(this.f, this.mask);
    this.oldPath = this.path;
    this.path = p ?? [];
    this.len = p ? p.length - 1 : 0;
    if (this.path.join() !== this.oldPath.join()) this.drawK = silent ? 1 : 0;
    if (!silent && this.len !== prev) {
      // Rising pluck per extra tile: a big jump is a little melody.
      const n = Math.min(24, Math.abs(this.len - prev));
      for (let k = 0; k < n; k++) this.plucks.push(k * 0.035);
      this.pluckN = this.len > prev ? 0 : -1;
    }
    const best = this.def.best ?? Infinity;
    if (this.def.mode === 'puzzle' && this.len >= best && !this.reachedBest && !silent) {
      this.reachedBest = true; this.glow = 1;
      this.ctx.audio.fanfare();
    }
  }

  private wallsLeft(): number { return this.def.walls - this.build.walls.length; }
  private moneyLeft(): number { return (this.def.money ?? 0) - this.build.traps.reduce((a, [k]) => a + TRAPS[k].cost, 0); }

  private cellAt(x: number, y: number): number {
    const c = Math.floor((x - this.ox) / this.cell), r = Math.floor((y - this.oy) / this.cell);
    return c >= 0 && r >= 0 && c < W && r < H ? idx(c, r) : -1;
  }

  private down(p: Pointer): void {
    if (this.demo) return;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    const slot = this.inv.at(p.x, p.y);
    if (slot && this.phase === 'build') { this.tool = slot.item.kind as Build['traps'][0][0] | 'wall'; this.ctx.audio.tick(1500, 0.05); return; }
    if (this.phase !== 'build') return;
    const i = this.cellAt(p.x, p.y);
    if (i < 0) return;
    if (this.editTool) { this.editCell(i); return; }
    const has = this.tool === 'wall' ? this.build.walls.includes(i) : this.build.traps.some(([, c, r]) => idx(c, r) === i);
    this.stroke = { mode: has ? 'erase' : 'add', before: JSON.stringify(this.build), id: p.id, last: -1 };
    this.strokeAt(i);
  }

  private move(p: Pointer): void {
    if (!this.stroke || this.stroke.id !== p.id || !p.down) return;
    const i = this.cellAt(p.x, p.y);
    if (i >= 0 && i !== this.stroke.last) this.strokeAt(i);
  }

  private strokeAt(i: number): void {
    if (!this.stroke) return;
    this.stroke.last = i;
    this.toggleAt(i, this.stroke.mode, false);
  }

  private endStroke(): void {
    const s = this.stroke;
    this.stroke = null;
    if (s && JSON.stringify(this.build) !== s.before) this.hist.push(s.before);
  }

  /** Place or remove the current tool on a cell. `record` = its own undo step (right-click). */
  private toggleAt(i: number, mode: 'add' | 'erase', record: boolean): void {
    const before = JSON.stringify(this.build);
    const a = this.ctx.audio;
    const [c, r] = xy(i);
    const trapIdx = this.build.traps.findIndex(([, tc, tr]) => tc === c && tr === r);
    if (mode === 'erase') {
      if (this.build.walls.includes(i)) { this.build.walls = this.build.walls.filter((w) => w !== i); a.pop(420, 0.14); }
      else if (trapIdx >= 0) { this.build.traps.splice(trapIdx, 1); a.pop(520, 0.12); }
      else return;
    } else if (this.tool === 'wall') {
      if (this.build.walls.includes(i) || trapIdx >= 0) return;
      if (!this.f.buildable[i]) { this.deny(i, null); return; }
      if (this.wallsLeft() <= 0) { this.deny(i, 'no walls left'); return; }
      this.mask[i] = 1;
      const ok = pathLength(this.f, this.mask) >= 0;
      this.mask[i] = 0;
      if (!ok) { this.deny(i, 'blocked!'); return; }
      this.build.walls.push(i);
      a.thud(0.5); a.tick(900, 0.05);
      const { x, y } = this.px(c + 0.5, r + 0.5);
      this.ctx.fx.particles.burst(x, y, '#8A90C0', { count: 6, speed: 60, life: 0.3, size: 3, sizeEnd: 0, shape: Shape.Dot });
    } else {
      if (this.build.walls.includes(i) || trapIdx >= 0) return;
      if (!this.f.buildable[i]) { this.deny(i, null); return; }
      if (this.moneyLeft() < TRAPS[this.tool].cost) { this.deny(i, 'not enough $'); return; }
      this.build.traps.push([this.tool, c, r]);
      a.pluck(740, 0.14);
    }
    if (record && JSON.stringify(this.build) !== before) this.hist.push(before);
    this.recompute();
  }

  private deny(i: number, text: string | null): void {
    this.denied = { i, t: 0.45 };
    this.ctx.audio.buzz();
    if (text) {
      const [c, r] = xy(i);
      const { x, y } = this.px(c + 0.5, r);
      this.ctx.fx.floaters.add(text, x, y, C.pink, 18);
      this.ctx.fx.camera.shake(0.12);
    }
  }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'undo' || id === 'redo') {
      const s = id === 'undo' ? this.hist.undo(this.build) : this.hist.redo(this.build);
      if (!s) { a.buzz(); return; }
      this.build = s; a.tick(1300, 0.06); this.recompute();
    } else if (id === 'reset') {
      if (!this.build.walls.length && !this.build.traps.length) return;
      this.hist.push(this.build);
      this.build = { walls: [], traps: [] };
      a.whoosh(0.12, 0.2); this.recompute();
    } else if (id === 'release') this.release();
    else if (id === 'fast') this.fast = !this.fast;
  }

  private canRelease(): boolean {
    return this.def.mode === 'defence' || this.len >= (this.def.target ?? 0);
  }

  private release(): void {
    if (this.phase !== 'build') return;
    if (!this.canRelease()) { this.ctx.audio.buzz(); this.banner = { text: `Needs ${this.def.target} tiles`, t: 1.4, color: C.pink }; return; }
    this.ctx.audio.whoosh(0.2, 0.3);
    this.phaseT = 0;
    if (this.def.mode === 'puzzle') {
      this.phase = 'walk';
      this.walker = { pos: 0, speed: Math.max(4, this.len / 7), prints: [] };
    } else {
      this.phase = 'waves';
      this.sim = new DefenceSim(this.f, this.mask.slice(), this.build.traps);
      this.acc = 0;
    }
  }

  // ---- loop -----------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.time += dt;
    this.phaseT += dt;
    this.drawK = Math.min(1, this.drawK + dt * 4);
    this.glow = Math.max(0, this.glow - dt * 0.4);
    if (this.denied && (this.denied.t -= dt) <= 0) this.denied = null;
    if (this.banner && (this.banner.t -= dt) <= 0) this.banner = null;
    // Counter ticks toward the real length, with plucks.
    if (this.shown !== this.len) {
      const step = Math.max(1, Math.round(Math.abs(this.len - this.shown) * dt * 10));
      this.shown += Math.sign(this.len - this.shown) * Math.min(step, Math.abs(this.len - this.shown));
    }
    for (let k = 0; k < this.plucks.length; k++) {
      this.plucks[k] -= dt;
      if (this.plucks[k] <= 0) {
        this.plucks.splice(k--, 1);
        const n = this.pluckN >= 0 ? this.pluckN++ : 0;
        this.ctx.audio.pluck(midiHz(this.pluckN >= 0 ? 60 + [0, 2, 4, 7, 9][n % 5] + 12 * Math.floor(n / 5) : 55), 0.1, 0);
      }
    }
    if (this.demo) this.demoTick(dt);
    if (this.phase === 'walk') this.walkTick(dt);
    if (this.phase === 'waves') this.wavesTick(dt);
  }

  private walkTick(dt: number): void {
    const w = this.walker;
    const before = Math.floor(w.pos);
    w.pos = Math.min(this.len, w.pos + w.speed * dt);
    if (Math.floor(w.pos) !== before) {
      const p = this.posAt(w.pos);
      w.prints.push({ x: p.x, y: p.y + 0.25, a: 1 });
      if (Math.floor(w.pos) % 3 === 0) this.ctx.audio.tone({ f: 120 + this.rng.range(-15, 15), f2: 90, type: 'sawtooth', a: 0.01, d: 0.12, g: 0.04, lp: 500 });
    }
    for (const fp of w.prints) fp.a -= dt * 0.25;
    w.prints = w.prints.filter((fp) => fp.a > 0);
    if (w.pos >= this.len && this.phase === 'walk') {
      this.phase = 'done';
      const g = this.path[this.path.length - 1];
      const [c, r] = xy(g);
      const { x, y } = this.px(c + 0.5, r + 0.5);
      this.ctx.fx.particles.burst(x, y, MON, { count: 24, speed: 140, life: 0.6, size: 4, sizeEnd: 0 });
      this.ctx.audio.thud(0.8);
      if (this.demo) return;
      const [t1, t2, t3] = puzzleGoals(this.def);
      finishLevel(this.ctx, pack, this.level, 'Maze Maker', {
        goals: [`Path of ${t1} tiles`, `Path of ${t2} tiles`, `Best known: ${t3} tiles`],
        met: [this.len >= t1, this.len >= t2, this.len >= t3],
        stats: [
          { label: 'path', value: `${this.len} tiles` },
          { label: 'walls', value: `${this.build.walls.length} / ${this.def.walls}` },
          { label: 'time', value: fmtTime(this.time) },
        ],
        delayMs: 500,
      });
    }
  }

  private wavesTick(dt: number): void {
    const sim = this.sim!;
    this.acc += dt * (this.fast ? 3 : 1);
    while (this.acc >= SIM_DT && !sim.done) { sim.step(); this.acc -= SIM_DT; }
    const a = this.ctx.audio, fx = this.ctx.fx;
    for (const e of sim.events) {
      const p = this.px(e.x + 0.5, e.y + 0.5);
      if (e.type === 'hit') { a.pop(700 + this.rng.range(-80, 80), 0.06); fx.particles.burst(p.x, p.y, '#FFFFFF', { count: 3, speed: 60, life: 0.2, size: 2, sizeEnd: 0, shape: Shape.Spark }); }
      else if (e.type === 'die') { a.pluck(midiHz(72 + this.rng.int(0, 4) * 2), 0.1); fx.particles.burst(p.x, p.y, MON, { count: 14, speed: 110, life: 0.45, size: 4, sizeEnd: 0 }); }
      else if (e.type === 'leak') { a.heartbeat(0.35); fx.camera.shake(0.3); fx.floaters.add('-1 ♥', p.x, p.y - 10, C.pink, 22); }
      else if (e.type === 'shot') a.thud(0.4);
      else if (e.type === 'bounce') a.tone({ f: 220, f2: 660, type: 'sine', a: 0.005, d: 0.18, g: 0.12 });
      else if (e.type === 'goo') a.noise({ d: 0.12, g: 0.06, f: 500, type: 'lowpass' });
      else if (e.type === 'wave') { a.chime(5, 0.14); this.banner = { text: `Wave ${sim.wave + 1} / 5`, t: 1.3, color: C.text }; }
    }
    sim.events.length = 0;
    if (sim.hearts <= 0 && this.phase === 'waves') {
      // Overrun: back to the exact build so the player can fix it.
      this.phase = 'build';
      this.sim = null;
      this.banner = { text: 'Overrun! Your maze is still here.', t: 2.2, color: C.pink };
      a.shatter();
      return;
    }
    if (sim.done && this.phase === 'waves') {
      this.phase = 'done';
      a.fanfare();
      if (this.demo) return;
      const lost = sim.leaked;
      finishLevel(this.ctx, pack, this.level, 'Maze Maker', {
        goals: ['Survive all 5 waves', 'Lose at most 2 hearts', 'Lose no hearts'],
        met: [true, lost <= 2, lost === 0],
        stats: [
          { label: 'hearts', value: `${sim.hearts} / ${HEARTS}` },
          { label: 'path', value: `${this.len} tiles` },
          { label: 'spent', value: `$${(this.def.money ?? 0) - this.moneyLeft()}` },
        ],
        delayMs: 700,
      });
    }
  }

  private demoTick(dt: number): void {
    this.demoT += dt;
    const sol = this.def.solution.walls;
    if (this.phase === 'build') {
      if (this.demoStep < sol.length && this.demoT > (this.demoStep === 0 ? 1 : 0.35)) {
        this.demoT = 0;
        const [c, r] = sol[this.demoStep++];
        this.build.walls.push(idx(c, r));
        this.recompute(true);
      } else if (this.demoStep >= sol.length && this.demoT > 1.2) {
        this.phase = 'walk'; this.phaseT = 0;
        this.walker = { pos: 0, speed: Math.max(5, this.len / 5), prints: [] };
      }
    } else if (this.phase === 'done' && this.phaseT > 1.8) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.start(this.seed, { demo: true });
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.editor?.destroy(); }

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, path: this.len, walls: this.build.walls.length, monsters: this.sim?.monsters.filter((m) => m.alive).length ?? 0 };
  }

  // ---- layout & render ------------------------------------------------------

  private px(x: number, y: number): { x: number; y: number } { return { x: this.ox + x * this.cell, y: this.oy + y * this.cell }; }

  private posAt(pos: number): { x: number; y: number } {
    const i = Math.min(this.path.length - 1, Math.floor(pos));
    const k = pos - i;
    const [ax, ay] = xy(this.path[i]), [bx, by] = xy(this.path[Math.min(this.path.length - 1, i + 1)]);
    return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k };
  }

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 8 : 70;
    const bottom = small ? 8 : Math.max(70, Math.min(92, h * 0.12)) + 16;
    const g = fitGrid(W, H, 10, top, w - 20 - (this.editor ? 220 : 0), h - top - bottom, 64);
    this.cell = g.cell; this.ox = g.ox; this.oy = g.oy;
    if (small) { this.btns = []; this.inv.layout([], 0, 0, 0, 0); return; }
    const build = this.phase === 'build';
    const bs = 44, gap = 8, right = w - 64;
    const ids: [string, Btn['icon'], boolean][] = [['reset', 'reset', build && (this.build.walls.length + this.build.traps.length) > 0], ['redo', 'redo', build && this.hist.canRedo], ['undo', 'undo', build && this.hist.canUndo]];
    this.btns = ids.map(([id, icon, en], i) => ({ id, icon, x: right - (i + 1) * bs - i * gap, y: 12, w: bs, h: bs, enabled: en }));
    const barH = bottom - 16, by = h - barH - 8;
    const relW = Math.min(170, w * 0.32);
    const items: InvItem[] = this.def.mode === 'defence'
      ? TOOLS.map((t) => ({
        kind: t, count: t === 'wall' ? this.wallsLeft() : null, label: t === 'wall' ? 'Wall' : `$${TRAPS[t].cost}`,
        draw: (g2, cx, cy, s) => t === 'wall' ? drawWall(g2, cx - s * 0.5, cy - s * 0.5, s) : drawTrap(g2, t, cx, cy, s, this.clock),
      }))
      : [{ kind: 'wall', count: this.wallsLeft(), label: 'Walls', draw: (g2, cx, cy, s) => drawWall(g2, cx - s * 0.5, cy - s * 0.5, s) }];
    const iw = Math.min(w - relW - 40, items.length * (barH + 8));
    this.inv.layout(items, 12, by, iw, barH);
    const relLabel = this.phase === 'waves' ? (this.fast ? 'Fast ×3' : 'Speed ×1') : 'Release';
    this.btns.push({ id: this.phase === 'waves' ? 'fast' : 'release', label: relLabel, icon: this.phase === 'waves' ? undefined : 'play', x: w - relW - 12, y: by + (barH - 54) / 2, w: relW, h: 54, enabled: (build && this.canRelease()) || this.phase === 'waves', primary: build });
  }

  render(): void {
    const g = this.ctx.canvas.begin(BG);
    const fx = this.ctx.fx;
    this.layout();
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    this.drawField(g);
    this.drawBuild(g);
    g.globalAlpha = this.phase === 'waves' ? 0.3 : 1;
    this.drawPath(g);
    g.globalAlpha = 1;
    this.drawEnds(g);
    if (this.phase === 'walk' || (this.phase === 'done' && this.def.mode === 'puzzle')) this.drawWalker(g);
    if (this.sim) this.drawSim(g, this.sim);
    fx.particles.render(g);
    fx.camera.end(g);
    fx.floaters.render(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
    else this.drawMiniCounter(g);
  }

  private drawField(g: CanvasRenderingContext2D): void {
    const { cell, ox, oy } = this;
    roundRect(g, ox - 6, oy - 6, W * cell + 12, H * cell + 12, 14);
    g.fillStyle = '#10142A'; g.fill();
    if (this.glow > 0 || this.reachedBest) {
      g.strokeStyle = rgba(PATH, 0.35 + 0.5 * this.glow); g.lineWidth = 3; g.stroke();
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const x = ox + c * cell, y = oy + r * cell, t = this.f.terrain(c, r);
      if (t === 'w' || t === '~') {
        g.fillStyle = t === 'w' ? '#173563' : '#1F4C7E';
        g.fillRect(x, y, cell + 0.5, cell + 0.5);
        g.strokeStyle = rgba('#9FD4FF', t === 'w' ? 0.18 : 0.3); g.lineWidth = 1.5;
        const ph = this.clock * 1.5 + c * 0.7 + r;
        g.beginPath(); g.moveTo(x + cell * 0.2, y + cell * (0.4 + 0.05 * Math.sin(ph))); g.lineTo(x + cell * 0.55, y + cell * (0.4 + 0.05 * Math.sin(ph + 1)));
        g.moveTo(x + cell * 0.45, y + cell * (0.7 + 0.05 * Math.sin(ph + 2))); g.lineTo(x + cell * 0.8, y + cell * (0.7 + 0.05 * Math.sin(ph + 3)));
        g.stroke();
        continue;
      }
      if (t === '=') {
        g.fillStyle = '#173563'; g.fillRect(x, y, cell + 0.5, cell + 0.5);
        g.fillStyle = '#7A5A3A';
        for (let k = 0; k < 4; k++) g.fillRect(x + 2, y + 2 + k * (cell - 4) / 4, cell - 4, (cell - 4) / 4 - 2);
        continue;
      }
      g.fillStyle = (c + r) % 2 ? '#151A31' : '#171D36';
      g.fillRect(x, y, cell + 0.5, cell + 0.5);
      if (t === '#') drawRock(g, x, y, cell, c * 7 + r * 13);
    }
    const d = this.denied;
    if (d) {
      const [c, r] = xy(d.i);
      const sx = Math.sin(this.clock * 60) * 3 * d.t;
      g.fillStyle = rgba(C.pink, Math.min(0.7, d.t * 1.5));
      roundRect(g, ox + c * cell + 2 + sx, oy + r * cell + 2, cell - 4, cell - 4, cell * 0.15); g.fill();
    }
  }

  private drawBuild(g: CanvasRenderingContext2D): void {
    const { cell, ox, oy } = this;
    for (const i of this.build.walls) {
      const [c, r] = xy(i);
      drawWall(g, ox + c * cell, oy + r * cell, cell);
    }
    for (const [k, c, r] of this.build.traps) {
      const { x, y } = this.px(c + 0.5, r + 0.5);
      drawTrap(g, k, x, y, cell, this.clock, this.sim?.traps.find((t) => t.c === c && t.r === r)?.cd);
    }
  }

  private drawPath(g: CanvasRenderingContext2D): void {
    const p = this.path;
    if (p.length < 2) return;
    const { cell } = this;
    const n = Math.max(2, Math.ceil(p.length * this.drawK));
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    for (let k = 0; k < n; k++) {
      const [c, r] = xy(p[k]);
      const { x, y } = this.px(c + 0.5, r + 0.5);
      if (k) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = rgba(PATH, 0.13); g.lineWidth = cell * 0.36; g.stroke();
    g.setLineDash([2, cell * 0.36]);
    g.lineDashOffset = -this.clock * cell * 1.6;
    g.strokeStyle = PATH; g.lineWidth = Math.max(3, cell * 0.14); g.stroke();
    g.restore();
  }

  private drawEnds(g: CanvasRenderingContext2D): void {
    const { cell } = this;
    const s = this.px(this.def.start[0] + 0.5, this.def.start[1] + 0.5);
    drawGlow(g, MON, s.x, s.y, cell * 0.9, 0.35);
    g.beginPath(); g.ellipse(s.x, s.y + cell * 0.08, cell * 0.38, cell * 0.3, 0, Math.PI, 0); g.lineTo(s.x + cell * 0.38, s.y + cell * 0.3); g.lineTo(s.x - cell * 0.38, s.y + cell * 0.3); g.closePath();
    g.fillStyle = '#05060C'; g.fill();
    g.strokeStyle = rgba(MON, 0.8); g.lineWidth = 2; g.stroke();
    const e = this.px(this.def.goal[0] + 0.5, this.def.goal[1] + 0.5);
    drawCastle(g, e.x, e.y, cell, this.sim ? this.sim.hearts : HEARTS);
  }

  private drawWalker(g: CanvasRenderingContext2D): void {
    const w = this.walker;
    for (const fp of w.prints) {
      const p = this.px(fp.x + 0.5, fp.y + 0.5);
      g.fillStyle = rgba(MON, fp.a * 0.35);
      g.beginPath(); g.arc(p.x - 3, p.y, this.cell * 0.05, 0, Math.PI * 2); g.arc(p.x + 3, p.y + 2, this.cell * 0.05, 0, Math.PI * 2); g.fill();
    }
    const p = this.posAt(w.pos);
    const at = this.px(p.x + 0.5, p.y + 0.5);
    // Annoyance grows with how far beyond the straight line it has walked.
    const base = Math.abs(this.def.goal[0] - this.def.start[0]) + Math.abs(this.def.goal[1] - this.def.start[1]);
    const annoyed = Math.min(1, Math.max(0, (w.pos - base) / Math.max(8, base)));
    drawMonster(g, at.x, at.y - Math.abs(Math.sin(this.clock * 12)) * this.cell * 0.08, this.cell * 0.36, MON, annoyed, this.clock, 0);
  }

  private drawSim(g: CanvasRenderingContext2D, sim: DefenceSim): void {
    const { cell } = this;
    for (const s of sim.shots) {
      const [ac, ar] = xy(s.from), [bc, br] = xy(s.to);
      const a = this.px(ac + 0.5, ar + 0.5), b = this.px(bc + 0.5, br + 0.5);
      g.strokeStyle = rgba(C.orange, s.t * 5); g.lineWidth = 3;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    for (const m of sim.monsters) {
      if (!m.alive) continue;
      const p = monsterXY(m);
      const at = this.px(p.x + 0.5, p.y + 0.5);
      const size = cell * (m.kind === 'tank' ? 0.42 : m.kind === 'runner' ? 0.26 : 0.32);
      const col = m.kind === 'runner' ? C.cyan : m.kind === 'tank' ? '#7A5CFF' : m.kind === 'hopper' ? C.green : MON;
      const bob = m.kind === 'hopper' ? Math.abs(Math.sin(this.clock * 8 + m.id)) * cell * 0.2 : Math.abs(Math.sin(this.clock * 12 + m.id)) * cell * 0.05;
      drawMonster(g, at.x, at.y - bob, size, col, m.slow > 0 ? 0.3 : 0.6, this.clock + m.id, m.hit);
      if (m.hp < m.max) {
        const wbar = cell * 0.6;
        g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(at.x - wbar / 2, at.y - size - 9, wbar, 4);
        g.fillStyle = C.green; g.fillRect(at.x - wbar / 2, at.y - size - 9, wbar * Math.max(0, m.hp / m.max), 4);
      }
      if (m.slow > 0) { g.fillStyle = rgba(C.green, 0.35); g.beginPath(); g.ellipse(at.x, at.y + size * 0.8, size, size * 0.3, 0, 0, Math.PI * 2); g.fill(); }
    }
  }

  private drawMiniCounter(g: CanvasRenderingContext2D): void {
    g.fillStyle = PATH; g.font = `700 ${Math.max(14, this.cell * 0.9)}px ${FONT.title}`;
    g.textAlign = 'right'; g.textBaseline = 'top';
    g.fillText(String(this.shown), this.ox + W * this.cell - 6, this.oy + 4);
  }

  private drawUi(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    g.fillText(fitText(g, `${this.level.chapter} ${this.level.n} · ${this.def.name}`, titleRoom(this.btns, w - 64) - 16), 16, 30);
    // Path counter with target markers.
    const barX = 16, barY = 44, barW = Math.min(300, w - 280), barH = 14;
    g.fillStyle = PATH; g.font = `700 20px ${FONT.title}`;
    g.fillText(`Path: ${this.shown} tiles`, barX, barY + 9 + (barW < 120 ? 0 : 0));
    if (this.def.mode === 'puzzle' && barW > 120) {
      const goals = puzzleGoals(this.def);
      const tx = barX + 150, tw = Math.min(220, barW - 150 + 16);
      if (tw > 60) {
        const max = goals[2] * 1.05;
        roundRect(g, tx, barY - 4, tw, barH, barH / 2); g.fillStyle = C.surface; g.fill();
        roundRect(g, tx, barY - 4, Math.max(barH, tw * Math.min(1, this.shown / max)), barH, barH / 2);
        g.fillStyle = this.shown >= goals[0] ? PATH : rgba(PATH, 0.45); g.fill();
        for (const v of goals) {
          const x = tx + tw * (v / max);
          g.fillStyle = this.shown >= v ? C.bg : rgba(C.text, 0.6);
          g.fillRect(x - 1, barY - 4, 2, barH);
        }
        const next = goals.findIndex((v) => this.shown < v);
        g.font = `600 13px ${FONT.ui}`; g.textAlign = 'left';
        g.fillStyle = next < 0 ? PATH : C.muted;
        g.fillText(next < 0 ? '★★★ best known!' : `${'★'.repeat(next + 1)} at ${goals[next]}`, tx + tw + 10, barY + 7);
      }
    } else if (this.def.mode === 'defence') {
      g.fillStyle = C.text; g.font = `600 14px ${FONT.ui}`;
      const hearts = this.sim ? this.sim.hearts : HEARTS;
      g.fillText(`${'♥'.repeat(hearts)}${'♡'.repeat(HEARTS - hearts)}   $${this.moneyLeft()} left${this.sim ? `   wave ${Math.max(1, this.sim.wave + 1)}/5` : ''}`, barX + 170, barY + 9);
    }
    for (const b of this.btns) drawBtn(g, b, PATH, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    if (this.phase === 'build') this.inv.draw(g, PATH, this.def.mode === 'defence' ? this.tool : null, null, this.def.mode === 'defence' && matchMedia('(pointer: fine)').matches);
    if (this.banner) {
      const a = Math.min(1, this.banner.t * 3);
      g.globalAlpha = a;
      g.font = `700 26px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(this.banner.text).width + 40;
      const cy = this.oy + H * this.cell / 2;
      roundRect(g, w / 2 - tw / 2, cy - 26, tw, 52, 26); g.fillStyle = 'rgba(14,15,26,0.88)'; g.fill();
      g.fillStyle = this.banner.color; g.fillText(this.banner.text, w / 2, cy + 1);
      g.globalAlpha = 1;
    }
    // Level 1 teaches without text: pulse the gap in the fence until a wall goes down.
    if (this.level.id === '1-1' && this.phase === 'build' && !this.build.walls.length && this.time > 2) {
      const [c, r] = this.def.solution.walls[0];
      const { x, y } = this.px(c + 0.5, r + 0.5);
      const k = (this.time * 1.2) % 1;
      g.strokeStyle = rgba(PATH, 1 - k); g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, this.cell * (0.3 + k * 0.5), 0, Math.PI * 2); g.stroke();
    }
  }

  // ---- dev editor -----------------------------------------------------------

  private setupEditor(): void {
    if (!editorMode() || this.demo || this.ctx.preview) return;
    this.editor?.destroy();
    const parent = this.ctx.canvas.el.parentElement;
    if (!parent) return;
    this.editor = new EditorPanel(parent, {
      title: 'Maze Maker',
      tools: [['.', 'Grass'], ['#', 'Rock'], ['w', 'Deep water'], ['~', 'Shallows'], ['=', 'Bridge'], ['start', 'Spawn'], ['goal', 'Castle']].map(([id, label]) => ({ id, label })),
      onTool: (id) => { this.editTool = id; },
      fields: [
        { id: 'name', label: 'Name', value: this.def.name, onChange: (v) => { this.def.name = v; } },
        { id: 'walls', label: 'Walls', value: this.def.walls, onChange: (v) => { this.def.walls = Math.max(0, Number(v) | 0); } },
        { id: 'target', label: 'Target', value: this.def.target ?? 0, onChange: (v) => { this.def.target = Number(v) | 0; } },
      ],
      actions: [
        { label: 'Build = solution', run: () => {
          this.def.solution = { walls: this.build.walls.map((i) => xy(i)), traps: this.build.traps.map((t) => [...t] as [TrapKind, number, number]) };
          if (this.def.mode === 'puzzle') this.def.best = Math.max(this.def.best ?? 0, this.len);
        } },
        { label: 'Export JSON', run: () => exportJson(`maze-maker-${this.level.id}`, this.def) },
      ],
    });
  }

  private editCell(i: number): void {
    const [c, r] = xy(i);
    const t = this.editTool!;
    if (t === 'start') this.def.start = [c, r];
    else if (t === 'goal') this.def.goal = [c, r];
    else this.def.rows[r] = this.def.rows[r].slice(0, c) + t + this.def.rows[r].slice(c + 1);
    this.f = new Field(this.def);
    this.build.walls = this.build.walls.filter((w) => this.f.buildable[w]);
    this.recompute(true);
  }
}

// ---- drawing helpers ----------------------------------------------------------

function fmtTime(s: number): string { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

function drawRock(g: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const j = (k: number) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  g.beginPath();
  const n = 7;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const rr = s * (0.38 + j(k) * 0.08);
    const px = x + s / 2 + Math.cos(a) * rr, py = y + s / 2 + Math.sin(a) * rr * 0.9;
    if (k) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.closePath();
  g.fillStyle = '#2C3150'; g.fill();
  g.strokeStyle = '#3B4166'; g.lineWidth = 1.5; g.stroke();
  g.beginPath(); g.ellipse(x + s * 0.42, y + s * 0.38, s * 0.14, s * 0.08, -0.4, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fill();
}

function drawWall(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  roundRect(g, x + s * 0.06, y + s * 0.06, s * 0.88, s * 0.88, s * 0.14);
  g.fillStyle = '#4A4F7E'; g.fill();
  roundRect(g, x + s * 0.06, y + s * 0.06, s * 0.88, s * 0.3, s * 0.14);
  g.fillStyle = '#6A70A8'; g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x + s * 0.5, y + s * 0.36); g.lineTo(x + s * 0.5, y + s * 0.94); g.stroke();
}

function drawTrap(g: CanvasRenderingContext2D, k: TrapKind, x: number, y: number, s: number, t: number, cd?: number): void {
  g.save(); g.translate(x, y);
  if (k === 'spikes') {
    g.fillStyle = '#C9CFEA';
    for (const [dx, dy] of [[-0.2, -0.15], [0.2, -0.15], [0, 0.18], [-0.25, 0.22], [0.25, 0.22]]) {
      g.beginPath(); g.moveTo((dx - 0.09) * s, (dy + 0.08) * s); g.lineTo(dx * s, (dy - 0.14) * s); g.lineTo((dx + 0.09) * s, (dy + 0.08) * s); g.fill();
    }
  } else if (k === 'goo') {
    g.fillStyle = rgba(C.green, 0.55);
    g.beginPath(); g.ellipse(0, s * 0.05, s * 0.36, s * 0.26, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = rgba('#FFFFFF', 0.3);
    g.beginPath(); g.arc(-s * 0.1 + Math.sin(t * 2) * 2, -s * 0.02, s * 0.06, 0, Math.PI * 2); g.fill();
  } else if (k === 'cannon') {
    g.fillStyle = '#2A2E4E'; g.beginPath(); g.arc(0, 0, s * 0.3, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.orange; g.fillRect(-s * 0.42, -s * 0.07, s * 0.84, s * 0.14);
    g.fillStyle = cd !== undefined && cd > 1.2 ? C.yellow : '#4A4F7E';
    g.beginPath(); g.arc(0, 0, s * 0.14, 0, Math.PI * 2); g.fill();
  } else {
    g.strokeStyle = C.yellow; g.lineWidth = s * 0.06;
    g.beginPath();
    for (let i = 0; i <= 12; i++) { const yy = -s * 0.2 + (i / 12) * s * 0.4; const xx = Math.sin(i * Math.PI / 2) * s * 0.2; if (i) g.lineTo(xx, yy); else g.moveTo(xx, yy); }
    g.stroke();
    g.fillStyle = C.yellow; g.fillRect(-s * 0.3, -s * 0.28, s * 0.6, s * 0.08);
  }
  g.restore();
}

function drawCastle(g: CanvasRenderingContext2D, x: number, y: number, s: number, hearts: number): void {
  drawGlow(g, C.pink, x, y, s * 0.9, 0.25);
  const w = s * 0.7, h = s * 0.55;
  g.fillStyle = '#E8E4FF';
  g.fillRect(x - w / 2, y - h / 2 + s * 0.08, w, h);
  for (let k = 0; k < 3; k++) g.fillRect(x - w / 2 + k * w * 0.4, y - h / 2 - s * 0.04, w * 0.2, s * 0.13);
  g.fillStyle = '#1A1C2E'; g.beginPath(); g.arc(x, y + h / 2 + s * 0.08, s * 0.12, Math.PI, 0); g.fill();
  g.fillStyle = C.pink; g.beginPath(); g.moveTo(x, y - h / 2 - s * 0.32); g.lineTo(x + s * 0.18, y - h / 2 - s * 0.25); g.lineTo(x, y - h / 2 - s * 0.18); g.fill();
  if (hearts < HEARTS) { g.fillStyle = rgba(C.pink, 0.15 * (HEARTS - hearts)); g.fillRect(x - w / 2, y - h / 2 + s * 0.08, w, h); }
}

function drawMonster(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, annoyed: number, t: number, hit: number): void {
  g.save();
  g.translate(x, y);
  const sq = 1 + Math.sin(t * 12) * 0.05;
  g.scale(1 / sq, sq);
  g.fillStyle = hit > 0 ? '#FFFFFF' : col;
  g.beginPath(); g.ellipse(0, 0, r, r * 0.92, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.beginPath(); g.ellipse(-r * 0.35, -r * 0.4, r * 0.25, r * 0.15, -0.5, 0, Math.PI * 2); g.fill();
  // Eyes and grumpy brows.
  g.fillStyle = '#FFFFFF';
  g.beginPath(); g.arc(-r * 0.32, -r * 0.08, r * 0.22, 0, Math.PI * 2); g.arc(r * 0.32, -r * 0.08, r * 0.22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1A1030';
  g.beginPath(); g.arc(-r * 0.27, -r * 0.03, r * 0.1, 0, Math.PI * 2); g.arc(r * 0.37, -r * 0.03, r * 0.1, 0, Math.PI * 2); g.fill();
  if (annoyed > 0.05) {
    g.strokeStyle = '#1A1030'; g.lineWidth = Math.max(1.5, r * 0.1); g.lineCap = 'round';
    const a = annoyed * 0.5;
    g.beginPath();
    g.moveTo(-r * 0.52, -r * (0.38 + a * 0.2)); g.lineTo(-r * 0.12, -r * (0.3 - a * 0.1));
    g.moveTo(r * 0.52, -r * (0.38 + a * 0.2)); g.lineTo(r * 0.12, -r * (0.3 - a * 0.1));
    g.stroke();
    g.beginPath(); g.arc(0, r * 0.45, r * 0.18, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  }
  g.restore();
}

export default (): Game => new MazeMaker();
