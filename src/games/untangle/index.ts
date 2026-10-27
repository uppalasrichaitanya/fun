import { pent, type MusicSpec } from '../../engine/audio';
import { drawGlow } from '../../engine/glow';
import { clamp, TAU } from '../../engine/math';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { Crossings, makePuzzle, type Puzzle } from './logic';

const MUSIC: MusicSpec = {
  bpm: 70, root: 57, wave: 'sine', pad: true, gain: 0.6,
  chords: [[0, 4, 7, 11], [5, 9, 12, 16], [-3, 0, 4, 7], [2, 5, 9, 12]],
  arp: [0, 2, 3, 2],
};
const TOP = 92, BOTTOM = 92, PAD = 20;
const UNDO_MAX = 50;
type P = { x: number; y: number };

export function unlockedLevel(storage: { get<T>(k: string, f: T): T }): number {
  return storage.get<number>('untangle:unlocked', 1);
}

class Untangle implements Game {
  private ctx!: GameContext;
  private demo = false;
  private rng = new Rng();
  private level = 1;
  private pz!: Puzzle;
  private pos: P[] = [];
  private cross!: Crossings;
  private grab = -1;
  private grabId = -1;
  private target: P = { x: 0, y: 0 };
  private grabFrom: P = { x: 0, y: 0 };
  private undo: { v: number; from: P }[] = [];
  private hints = 3;
  private hintDot = -1;
  private hintT = 0;
  private moves = 0;
  private time = 0;
  private solved = false;
  private solveT = 0;
  private dist: number[] = [];
  private lastMoved = 0;
  private step = 5;
  private lastTotal = 0;
  private grow: number[] = [];
  // Layout (CSS px).
  private fx = 0; private fy = 0; private size = 1;
  private demoDot = -1; private demoT = 0; private demoFrom: P = { x: 0, y: 0 }; private demoWait = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => {
      if (this.demo || this.solved) return;
      if (this.hitButton(p.x, p.y, 'undo')) { this.doUndo(); return; }
      if (this.hitButton(p.x, p.y, 'hint')) { this.doHint(); return; }
      const v = this.pick(p.x, p.y, p.type === 'mouse' ? 18 : 26);
      if (v < 0) return;
      this.grab = v; this.grabId = p.id;
      this.grabFrom = { ...this.pos[v] };
      this.target = this.toField(p.x, p.y);
      this.ctx.audio.tick(1600, 0.04);
    });
    ctx.input.on('move', (p) => {
      if (this.grab < 0 || p.id !== this.grabId) return;
      this.target = this.toField(p.x, p.y);
    });
    ctx.input.on('up', (p) => {
      if (this.grab < 0 || p.id !== this.grabId) return;
      this.release();
    });
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      if (code === 'KeyZ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.doUndo(); }
      else if (code === 'KeyH') this.doHint();
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    const unlocked = unlockedLevel(this.ctx.storage);
    if (this.demo) this.level = this.rng.int(2, 6);
    else if (opts?.mode === 'endless') this.level = Math.max(16, unlocked);
    else this.level = clamp(Number(opts?.mode) || unlocked, 1, Math.max(1, unlocked));
    this.load();
    this.ctx.audio.music(MUSIC);
  }

  private load(): void {
    this.pz = makePuzzle(this.level);
    this.pos = this.pz.start.map((p) => ({ ...p }));
    this.cross = new Crossings(this.pos, this.pz.edges);
    this.grow = this.pos.map(() => 0);
    this.grab = -1; this.undo = []; this.hints = 3; this.hintDot = -1; this.moves = 0; this.time = 0;
    this.solved = false; this.solveT = 0; this.step = 5; this.lastTotal = this.cross.total;
    this.demoDot = -1; this.demoWait = 0.8;
  }

  // ---- layout & hit tests ---------------------------------------------------------

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const top = this.ctx.preview ? 8 : TOP, bottom = this.ctx.preview ? 8 : BOTTOM;
    this.size = Math.max(80, Math.min(w - PAD * 2, h - top - bottom - PAD));
    this.fx = (w - this.size) / 2;
    this.fy = top + (h - top - bottom - this.size) / 2;
  }
  private sx(p: P): number { return this.fx + p.x * this.size; }
  private sy(p: P): number { return this.fy + p.y * this.size; }
  private toField(x: number, y: number): P {
    // Dots can go anywhere on screen inside the safe area, not just the square.
    const { w, h } = this.ctx.canvas;
    const m = 14;
    return {
      x: (clamp(x, m, w - m) - this.fx) / this.size,
      y: (clamp(y, (this.ctx.preview ? 0 : TOP - 30) + m, h - (this.ctx.preview ? 0 : BOTTOM - 20) - m) - this.fy) / this.size,
    };
  }
  private pick(x: number, y: number, r: number): number {
    let best = -1, bd = r * r;
    this.pos.forEach((p, i) => {
      const dx = this.sx(p) - x, dy = this.sy(p) - y, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = i; }
    });
    return best;
  }
  private button(which: 'undo' | 'hint'): { x: number; y: number; r: number } {
    const { w, h } = this.ctx.canvas;
    return { x: which === 'undo' ? w / 2 - 64 : w / 2 + 64, y: h - BOTTOM / 2, r: 26 };
  }
  private hitButton(x: number, y: number, which: 'undo' | 'hint'): boolean {
    if (this.ctx.preview) return false;
    const b = this.button(which);
    return Math.hypot(x - b.x, y - b.y) <= b.r + 8;
  }

  // ---- actions -------------------------------------------------------------------

  private moveDot(v: number, p: P): void {
    const before = this.pos[v];
    this.pos[v] = p;
    this.cross.moved(v, before);
    const t = this.cross.total;
    // Solve by ear: a pluck one step up when crossings drop, down when they rise.
    if (t !== this.lastTotal) {
      this.step = clamp(this.step + (t < this.lastTotal ? 1 : -1), 0, 14);
      if (!this.demo || !this.ctx.preview) this.ctx.audio.pluck(pent(this.step, 392), 0.12, 0.02);
      this.lastTotal = t;
    }
  }

  private release(): void {
    const v = this.grab;
    this.grab = -1;
    const p = this.pos[v];
    if (Math.hypot(p.x - this.grabFrom.x, p.y - this.grabFrom.y) > 0.002) {
      this.undo.push({ v, from: this.grabFrom });
      if (this.undo.length > UNDO_MAX) this.undo.shift();
      this.moves++;
      this.lastMoved = v;
    }
    this.cross.recount();
    this.lastTotal = this.cross.total;
    if (this.cross.total === 0) this.solve();
  }

  private doUndo(): void {
    const u = this.undo.pop();
    if (!u || this.solved) return;
    this.moveDot(u.v, { ...u.from });
    this.cross.recount();
    this.lastTotal = this.cross.total;
    this.ctx.audio.tone({ f: 700, f2: 420, type: 'triangle', d: 0.12, g: 0.08 });
  }

  private doHint(): void {
    if (this.hints <= 0 || this.solved) return;
    this.hints--;
    this.hintDot = this.cross.worst();
    this.hintT = 1.8;
    this.ctx.audio.sparkle(1046);
  }

  private solve(): void {
    this.solved = true;
    this.solveT = 0;
    // Wave distance (in edges) from the last-moved dot.
    const n = this.pos.length;
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of this.pz.edges) { adj[a].push(b); adj[b].push(a); }
    this.dist = new Array(n).fill(99);
    this.dist[this.lastMoved] = 0;
    const q = [this.lastMoved];
    while (q.length) { const v = q.shift()!; for (const u of adj[v]) if (this.dist[u] > this.dist[v] + 1) { this.dist[u] = this.dist[v] + 1; q.push(u); } }
    const { audio, fx } = this.ctx;
    [0, 4, 7, 11].forEach((s, i) => audio.tone({ f: pent(s, 262), type: 'sine', a: 0.02, d: 1.6, g: 0.1, at: i * 0.06 }));
    fx.camera.shake(0.05);
    if (this.demo) return;
    const st = this.ctx.storage;
    if (unlockedLevel(st) <= this.level) st.set('untangle:unlocked', this.level + 1);
    const key = `untangle:lvl:${this.level}`;
    const prev = st.get<{ time: number; moves: number } | null>(key, null);
    st.set(key, { time: Math.min(prev?.time ?? Infinity, this.time), moves: Math.min(prev?.moves ?? Infinity, this.moves) });
    this.ctx.shell.gameOver({
      score: this.level, title: `Level ${this.level} solved!`, noScore: true,
      stats: [
        { label: 'time', value: fmtTime(this.time) },
        { label: 'moves', value: String(this.moves) },
        { label: 'best time', value: fmtTime(Math.min(prev?.time ?? Infinity, this.time)) },
      ],
      next: { label: 'Next level', mode: String(this.level + 1) },
      share: `Pocket Arcade - Untangle: level ${this.level} in ${fmtTime(this.time)}, ${this.moves} moves`,
    }, 1700);
  }

  update(dt: number): void {
    if (!this.solved) this.time += dt;
    if (this.grab >= 0) {
      // Light smoothing (0.85 per 60 Hz frame) so dots feel physical but precise.
      const p = this.pos[this.grab], k = 1 - Math.pow(0.15, dt * 60);
      this.moveDot(this.grab, { x: p.x + (this.target.x - p.x) * k, y: p.y + (this.target.y - p.y) * k });
    }
    for (let i = 0; i < this.grow.length; i++) {
      const want = i === this.grab ? 1 : 0;
      this.grow[i] += (want - this.grow[i]) * Math.min(1, dt * 14);
    }
    if (this.hintT > 0) this.hintT -= dt;
    if (this.solved) this.solveT += dt;
    if (this.demo) this.autopilot(dt);
  }

  /** Attract mode: carry each dot to its solved position, one at a time. */
  private autopilot(dt: number): void {
    if (this.solved) {
      if (this.solveT > 2.4) { this.level = this.rng.int(2, 6); this.load(); }
      return;
    }
    if (this.demoWait > 0) { this.demoWait -= dt; return; }
    if (this.demoDot < 0) {
      const order = this.pos.map((_, i) => i).filter((i) => Math.hypot(this.pos[i].x - this.pz.solution[i].x, this.pos[i].y - this.pz.solution[i].y) > 0.01);
      if (!order.length) { this.lastMoved = 0; this.cross.recount(); if (this.cross.total === 0) this.solve(); return; }
      this.demoDot = order[this.rng.int(0, order.length - 1)];
      this.demoFrom = { ...this.pos[this.demoDot] };
      this.demoT = 0;
      this.grab = -1;
    }
    this.demoT = Math.min(1, this.demoT + dt / 0.55);
    const k = ease.inOutSine(this.demoT), s = this.pz.solution[this.demoDot];
    this.moveDot(this.demoDot, { x: this.demoFrom.x + (s.x - this.demoFrom.x) * k, y: this.demoFrom.y + (s.y - this.demoFrom.y) * k });
    this.grow[this.demoDot] = Math.sin(this.demoT * Math.PI);
    if (this.demoT >= 1) { this.lastMoved = this.demoDot; this.demoDot = -1; this.demoWait = 0.15; this.cross.recount(); if (this.cross.total === 0) this.solve(); }
  }

  render(): void {
    const { canvas, fx } = this.ctx;
    this.layout();
    const g = canvas.begin('#0A1230');
    const { w, h } = canvas;
    // Faint dot grid.
    g.fillStyle = 'rgba(120,150,255,0.08)';
    for (let x = 12; x < w; x += 28) for (let y = 12; y < h; y += 28) g.fillRect(x, y, 2, 2);
    fx.camera.begin(g, w, h);
    const E = this.pz.edges;
    g.lineCap = 'round';
    for (let i = 0; i < E.length; i++) {
      const a = this.pos[E[i][0]], b = this.pos[E[i][1]];
      const hot = this.grab >= 0 && (E[i][0] === this.grab || E[i][1] === this.grab);
      let col: string = this.cross.per[i] > 0 ? C.pink : C.cyan;
      let alpha = this.cross.per[i] > 0 ? 0.95 : 0.55;
      let width = 3;
      if (this.solved) {
        const d = Math.min(this.dist[E[i][0]], this.dist[E[i][1]]);
        const k = clamp((this.solveT - d * 0.03) / 0.25, 0, 1);
        if (k > 0) { col = C.yellow; alpha = 0.6 + 0.4 * (1 - k); width = 3 + 2 * (1 - k); }
      }
      if (hot) { alpha = 1; width = 4; }
      g.strokeStyle = rgba(col, alpha);
      g.lineWidth = width;
      g.beginPath(); g.moveTo(this.sx(a), this.sy(a)); g.lineTo(this.sx(b), this.sy(b)); g.stroke();
    }
    const R = this.ctx.preview ? 7 : 11;
    this.pos.forEach((p, i) => {
      const x = this.sx(p), y = this.sy(p);
      let s = 1 + 0.35 * this.grow[i];
      if (this.solved) {
        const t = this.solveT - this.dist[i] * 0.03;
        if (t > 0 && t < 0.4) s *= 1 + 0.35 * Math.sin((t / 0.4) * Math.PI);
      }
      if (i === this.hintDot && this.hintT > 0) {
        const k = 0.5 + 0.5 * Math.sin(this.hintT * 12);
        drawGlow(g, C.yellow, x, y, R * 3.5, 0.5 * k);
        g.strokeStyle = rgba(C.yellow, k); g.lineWidth = 3;
        g.beginPath(); g.arc(x, y, R * (1.8 + k * 0.4), 0, TAU); g.stroke();
      }
      if (this.grow[i] > 0.05) drawGlow(g, C.cyan, x, y, R * 3, 0.5 * this.grow[i]);
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(x, y, R * s, 0, TAU); g.fill();
      g.strokeStyle = this.solved ? C.yellow : C.cyan; g.lineWidth = 3;
      g.stroke();
    });
    fx.particles.render(g);
    fx.camera.end(g);
    if (!this.ctx.preview) this.hud(g, w);
  }

  private hud(g: CanvasRenderingContext2D, w: number): void {
    const total = this.cross.total, startN = Math.max(1, this.pz.startCrossings);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = C.muted;
    g.font = `600 14px ${FONT.ui}`;
    g.fillText(`LEVEL ${this.level}${this.level >= 16 ? ' · ENDLESS' : ''}`, w / 2, 24);
    g.fillStyle = total ? C.text : C.yellow;
    g.font = `700 26px ${FONT.title}`;
    g.fillText(total ? `Crossings: ${total}` : 'Untangled!', w / 2, 52);
    const bw = Math.min(220, w - 160), k = clamp(1 - total / startN, 0, 1);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(w / 2 - bw / 2, 72, bw, 5);
    g.fillStyle = C.cyan;
    g.fillRect(w / 2 - bw / 2, 72, bw * k, 5);
    for (const which of ['undo', 'hint'] as const) {
      const b = this.button(which);
      const off = which === 'undo' ? !this.undo.length : this.hints <= 0;
      g.globalAlpha = off ? 0.35 : 1;
      g.fillStyle = C.surface2;
      g.beginPath(); g.arc(b.x, b.y, b.r, 0, TAU); g.fill();
      g.fillStyle = C.text;
      g.font = `700 13px ${FONT.ui}`;
      g.fillText(which === 'undo' ? 'Undo' : 'Hint', b.x, b.y - 3);
      g.font = `600 10px ${FONT.ui}`;
      g.fillStyle = C.muted;
      g.fillText(which === 'undo' ? 'Ctrl+Z' : `${this.hints} left`, b.x, b.y + 11);
      g.globalAlpha = 1;
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number> {
    return { level: this.level, dots: this.pos.length, edges: this.pz.edges.length, crossings: this.cross.total };
  }
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '-';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default (): Game => new Untangle();
