import { midiHz, type Drone } from '../../engine/audio';
import { GridPlacer, type EditKind, type GridModel } from '../../engine/editor/grid';
import { History, undoKey } from '../../engine/editor/history';
import { EditorPanel, exportJson } from '../../engine/editor/panel';
import { drawBtn, fitGrid, hitBtn, InventoryBar, roundRect, type Btn, type InvItem } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Level } from '../../engine/levels/pack';
import { editorMode } from '../../engine/levels/progress';
import { finishLevel, pickLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import {
  Board, COLOR_HEX, DX, DY, FILTER_COLOR, KINDS, piecesFrom, trace, TURNS, WHITE,
  type Kind, type LBLevel, type Placed, type Thing, type Trace,
} from './logic';
import { pack } from './pack';
import { solve } from './solver';

const BG = '#06070D';
const GOLD = '#FFD93D';
const ACCENT = C.cyan;
/** Crystal notes: a major-9 chord spread upward, one note per crystal. */
const CHORD = [0, 4, 7, 11, 14, 16, 19, 23];
const PORTAL_COLORS = [C.violet, C.orange, C.pink];
const TEACH = new Set(['1-1', '1-2', '1-3']);

interface Build { pieces: Placed[] }
type Phase = 'build' | 'solved' | 'done';

class LightBender implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level!: Level<LBLevel>;
  private def!: LBLevel;
  private board!: Board;
  private build: Build = { pieces: [] };
  private t!: Trace;
  private lit: boolean[] = [];
  private hist = new History<Build>(100);
  private inv = new InventoryBar();
  private placer!: GridPlacer;
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private demo = false;
  private phase: Phase = 'build';
  private phaseT = 0;
  private time = 0;
  private clock = 0;
  private idle = 0;
  private demoStep = 0;
  private demoT = 0;
  private hum: Drone | null = null;
  private litFlash: number[] = [];
  private cell = 40;
  private ox = 0;
  private oy = 0;
  private editor: EditorPanel | null = null;
  private editTool: string | null = null;
  private seed = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const model: GridModel = {
      cols: 0, rows: 0,
      pieceAt: (c, r) => this.pieceAt(c, r)?.[0] ?? null,
      canPlace: (_k, c, r) => this.board.open(c, r),
      left: (k) => this.left(k as Kind),
      place: (k, c, r) => { this.build.pieces.push([k as Kind, c, r, 0]); },
      move: (fc, fr, tc, tr) => { const p = this.pieceAt(fc, fr); if (p) { p[1] = tc; p[2] = tr; } },
      rotate: (c, r) => { const p = this.pieceAt(c, r); if (p) p[3] = (p[3] + 1) % TURNS[p[0]]; },
      remove: (c, r) => { this.build.pieces = this.build.pieces.filter((p) => p[1] !== c || p[2] !== r); },
    };
    Object.defineProperty(model, 'cols', { get: () => this.def.w });
    Object.defineProperty(model, 'rows', { get: () => this.def.h });
    this.placer = new GridPlacer(model, this.inv, (fn, kind) => this.edit(fn, kind));
    const input = ctx.input;
    input.on('down', (p) => {
      if (this.demo) return;
      this.idle = 0;
      const b = hitBtn(this.btns, p.x, p.y);
      if (b) { this.pressBtn = b.id; this.button(b.id); return; }
      if (this.editTool && this.editCell(p.x, p.y)) return;
      if (this.phase === 'build') this.placer.down(p);
    });
    input.on('move', (p) => { if (!this.demo) this.placer.move(p); });
    input.on('up', (p) => { this.pressBtn = null; if (!this.demo) this.placer.up(p); });
    input.on('alt', (p) => { if (!this.demo && this.phase === 'build') this.placer.alt(p); });
    input.onKey((code, e) => {
      if (this.demo || this.phase !== 'build') return;
      this.idle = 0;
      const u = undoKey(code, e);
      if (u) { e.preventDefault(); this.button(u); return; }
      if (this.placer.key(code)) e.preventDefault();
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    this.load(pickLevel(pack, opts?.mode, this.demo, seed));
  }

  private load(level: Level<LBLevel>): void {
    this.level = level;
    this.def = structuredClone(level.def);
    this.board = new Board(this.def);
    this.build = { pieces: [] };
    this.hist.clear();
    this.phase = 'build'; this.phaseT = 0;
    this.time = 0; this.idle = 0;
    this.demoStep = 0; this.demoT = 0;
    this.placer.selected = null; this.placer.drag = null; this.placer.cursor.show = false;
    this.placer.enabled = !this.demo;
    this.lit = this.board.crystals.map(() => false);
    this.litFlash = this.board.crystals.map(() => 0);
    this.retrace(true);
    this.hum?.stop();
    this.hum = this.demo ? null : this.ctx.audio.drone('sine', midiHz(43));
    this.setupEditor();
  }

  // ---- build model ----------------------------------------------------------

  private pieceAt(c: number, r: number): Placed | undefined {
    return this.build.pieces.find((p) => p[1] === c && p[2] === r);
  }

  private left(k: Kind): number | null {
    if (this.editTool !== null || editorMode()) return null;
    const used = this.build.pieces.filter((p) => p[0] === k).length;
    return (this.def.inv[k] ?? 0) - used;
  }

  private edit(fn: () => void, kind: EditKind): void {
    const a = this.ctx.audio;
    if (kind === 'deny') { a.buzz(); return; }
    if (kind === 'pick') { a.tick(1500, 0.05); return; }
    if (!this.hist.track(this.build, fn)) return;
    if (kind === 'place') { a.pluck(660, 0.16); this.ctx.input.hover && this.burstAtLast(); }
    else if (kind === 'rotate') a.tick(2200, 0.07);
    else if (kind === 'move') a.pluck(520, 0.12);
    else if (kind === 'remove') a.pop(380, 0.16);
    this.retrace();
  }

  private burstAtLast(): void {
    const p = this.build.pieces[this.build.pieces.length - 1];
    if (!p) return;
    const { x, y } = this.px(p[1] + 0.5, p[2] + 0.5);
    this.ctx.fx.particles.burst(x, y, ACCENT, { count: 8, speed: 70, life: 0.35, size: 3, sizeEnd: 0, shape: Shape.Spark });
  }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'undo' || id === 'redo') {
      const s = id === 'undo' ? this.hist.undo(this.build) : this.hist.redo(this.build);
      if (!s) { a.buzz(); return; }
      this.build = s; a.tick(1300, 0.06); this.retrace();
    } else if (id === 'reset') {
      if (!this.build.pieces.length) return;
      this.hist.push(this.build);
      this.build = { pieces: [] };
      a.whoosh(0.12, 0.2); this.retrace();
    }
  }

  /** Recompute the beam (every change, same frame) and react to crystals lighting. */
  private retrace(silent = false): void {
    this.t = trace(this.board, [...piecesFrom(this.build.pieces)]);
    let k = 0;
    this.board.crystals.forEach((cr, i) => {
      const now = this.t.lit[i];
      if (now && !this.lit[i]) {
        this.litFlash[i] = 1;
        if (!silent) {
          const note = cr.gem ? 84 : 60 + CHORD[k % CHORD.length];
          this.ctx.audio.tone({ f: midiHz(note), type: 'sine', a: 0.005, d: 1.1, g: 0.16 });
          this.ctx.audio.tone({ f: midiHz(note + 12), type: 'triangle', a: 0.005, d: 0.4, g: 0.05 });
          const { x, y } = this.px(cr.c + 0.5, cr.r + 0.5);
          this.ctx.fx.particles.burst(x, y, cr.gem ? GOLD : COLOR_HEX[cr.color], { count: 14, speed: 120, life: 0.5, size: 3, sizeEnd: 0, shape: Shape.Spark });
        }
      }
      if (!cr.gem) k++;
    });
    this.lit = [...this.t.lit];
    if (this.t.solved && this.phase === 'build' && !this.editTool) this.solved();
  }

  private solved(): void {
    this.phase = 'solved';
    this.phaseT = 0;
    this.placer.enabled = false;
    this.placer.drag = null;
    this.hum?.set(0, 0, 0.2);
    const a = this.ctx.audio;
    const notes = this.board.crystals.filter((c) => !c.gem).map((_, i) => 60 + CHORD[i % CHORD.length]);
    for (const n of [48, ...notes]) {
      a.tone({ f: midiHz(n), type: 'sine', a: 0.04, d: 2.2, g: 0.09, at: 0.12 });
      a.tone({ f: midiHz(n + 12), type: 'triangle', a: 0.06, d: 1.6, g: 0.03, at: 0.12 });
    }
    a.sparkle(1318.5);
    for (const cr of this.board.crystals) {
      if (cr.gem && !this.t.gemLit) continue;
      const { x, y } = this.px(cr.c + 0.5, cr.r + 0.5);
      this.ctx.fx.particles.burst(x, y, GOLD, { count: 22, speed: 160, life: 0.8, size: 4, sizeEnd: 0, shape: Shape.Spark });
    }
    if (!this.demo) this.ctx.fx.camera.shake(0.15);
  }

  // ---- loop -----------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.time += dt;
    this.idle += dt;
    this.placer.update(dt);
    for (let i = 0; i < this.litFlash.length; i++) this.litFlash[i] = Math.max(0, this.litFlash[i] - dt * 1.6);
    const unlit = this.board.crystals.filter((c, i) => !c.gem && !this.lit[i]).length;
    if (this.phase === 'build') this.hum?.set(midiHz(43), Math.min(0.02, unlit * 0.006), 0.3);
    // Sparks where beams hit walls.
    if (this.t.hits.length && this.ctx.settings.motion) {
      for (const h of this.t.hits) {
        if (this.rng.next() > dt * 14) continue;
        const { x, y } = this.px(h.x, h.y);
        const a = this.rng.range(0, Math.PI * 2), s = this.rng.range(30, 90);
        this.ctx.fx.particles.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.25, 2.2, 0, this.phase === 'build' ? COLOR_HEX[h.color] : GOLD, Shape.Spark, 0, 2);
      }
    }
    if (this.demo) this.demoTick(dt);
    if (this.phase !== 'build') {
      this.phaseT += dt;
      if (this.phase === 'solved' && this.phaseT > 1.1 && !this.demo) {
        this.phase = 'done';
        const used = this.build.pieces.length, par = this.def.par;
        finishLevel(this.ctx, pack, this.level, 'Light Bender', {
          goals: ['Light every crystal', `Use ${par} piece${par === 1 ? '' : 's'} or fewer`, 'Light the prism gem'],
          met: [true, used <= par, this.t.gemLit],
          stats: [
            { label: 'pieces', value: `${used} / par ${par}` },
            { label: 'beam', value: `${this.t.steps} tiles` },
            { label: 'time', value: fmtTime(this.time) },
          ],
          delayMs: 300,
        });
      }
    }
  }

  private demoTick(dt: number): void {
    this.demoT += dt;
    const sol = this.def.solution;
    if (this.phase === 'build' && this.demoT > (this.demoStep === 0 ? 1.0 : 0.75)) {
      this.demoT = 0;
      const p = sol[this.demoStep++];
      if (p) { this.build.pieces.push([...p]); this.burstAtLast(); this.retrace(true); }
    }
    if (this.phase === 'solved' && this.phaseT > 2.6) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.load(pickLevel(pack, undefined, true, this.seed));
    }
  }

  pause(): void { this.hum?.set(0, 0, 0.05); }
  resume(): void {}
  destroy(): void { this.hum?.stop(); this.hum = null; this.editor?.destroy(); }

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, pieces: this.build.pieces.length, beams: this.t.beams.length, steps: this.t.steps, undo: this.hist.size };
  }

  // ---- layout ---------------------------------------------------------------

  private px(x: number, y: number): { x: number; y: number } { return { x: this.ox + x * this.cell, y: this.oy + y * this.cell }; }

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.ctx.preview || this.demo;
    const top = small ? 10 : 66;
    const invH = small ? 0 : Math.max(64, Math.min(92, h * 0.12));
    const g = fitGrid(this.def.w, this.def.h, 12, top, w - 24 - (this.editor ? 220 : 0), h - top - invH - (small ? 10 : 22), small ? 80 : 72);
    this.cell = g.cell; this.ox = g.ox; this.oy = g.oy;
    this.placer.setView(this.ox, this.oy, this.cell);
    if (small) { this.inv.layout([], 0, 0, 0, 0); this.btns = []; return; }
    const items: InvItem[] = KINDS.filter((k) => this.def.inv[k] || this.editTool !== null || editorMode())
      .map((k) => ({ kind: k, count: this.left(k), draw: (g2, cx, cy, s) => drawPiece(g2, k, 0, cx, cy, s * 1.3, false, this.clock) }));
    const iw = Math.min(w - 24, Math.max(220, items.length * (invH + 8)));
    this.inv.layout(items, (w - iw) / 2, h - invH - 12, iw, invH);
    const bs = 44, gap = 8;
    const right = w - 64;
    const ids: [string, Btn['icon'], boolean][] = [['reset', 'reset', this.build.pieces.length > 0], ['redo', 'redo', this.hist.canRedo], ['undo', 'undo', this.hist.canUndo]];
    this.btns = ids.map(([id, icon, en], i) => ({ id, icon, x: right - (i + 1) * bs - i * gap, y: 12, w: bs, h: bs, enabled: en && this.phase === 'build' }));
  }

  // ---- render ---------------------------------------------------------------

  render(): void {
    const { g } = { g: this.ctx.canvas.begin(BG) };
    const fx = this.ctx.fx;
    this.layout();
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    this.drawBoard(g);
    this.drawBeams(g);
    this.drawThings(g, true);
    this.drawPieces(g);
    g.save(); g.globalCompositeOperation = 'lighter'; fx.particles.render(g); g.restore();
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
  }

  private drawBoard(g: CanvasRenderingContext2D): void {
    const { cell, ox, oy } = this;
    const d = this.def, solvedK = this.phase === 'build' ? 0 : Math.min(1, this.phaseT * 2);
    roundRect(g, ox - 6, oy - 6, d.w * cell + 12, d.h * cell + 12, 14);
    g.fillStyle = '#0B0D18'; g.fill();
    if (solvedK) { g.strokeStyle = rgba(GOLD, 0.5 * solvedK); g.lineWidth = 2; g.stroke(); }
    const hover = this.ctx.input.hasHover && !this.demo ? this.placer.cellAt(this.ctx.input.hover.x, this.ctx.input.hover.y) : null;
    for (let r = 0; r < d.h; r++) for (let c = 0; c < d.w; c++) {
      const x = ox + c * cell, y = oy + r * cell, t = this.board.terrain[r * d.w + c];
      if (t === 1) {
        roundRect(g, x + 1, y + 1, cell - 2, cell - 2, cell * 0.14);
        g.fillStyle = '#1D2036'; g.fill();
        roundRect(g, x + 1, y + 1, cell - 2, cell * 0.3, cell * 0.14);
        g.fillStyle = solvedK ? rgba(GOLD, 0.12 + 0.25 * solvedK) : '#262A46'; g.fill();
        if (solvedK) { g.strokeStyle = rgba(GOLD, 0.35 * solvedK); g.lineWidth = 1.5; roundRect(g, x + 1, y + 1, cell - 2, cell - 2, cell * 0.14); g.stroke(); }
        continue;
      }
      roundRect(g, x + 2, y + 2, cell - 4, cell - 4, cell * 0.12);
      g.fillStyle = hover && hover.c === c && hover.r === r && this.phase === 'build' && this.board.open(c, r) ? '#171A2E' : '#10121F';
      g.fill();
      if (t === 2) {
        roundRect(g, x + 3, y + 3, cell - 6, cell - 6, cell * 0.1);
        g.fillStyle = 'rgba(160,220,255,0.10)'; g.fill();
        g.strokeStyle = 'rgba(180,230,255,0.35)'; g.lineWidth = 1.5; g.stroke();
        g.beginPath(); g.moveTo(x + cell * 0.25, y + cell * 0.7); g.lineTo(x + cell * 0.6, y + cell * 0.25);
        g.strokeStyle = 'rgba(220,245,255,0.3)'; g.lineWidth = 2; g.stroke();
      }
    }
    // Denied cell flash.
    const dn = this.placer.denied;
    if (dn) {
      const x = ox + dn.c * cell, y = oy + dn.r * cell;
      roundRect(g, x + 2, y + 2, cell - 4, cell - 4, cell * 0.12);
      g.fillStyle = rgba(C.pink, dn.t * 1.2); g.fill();
    }
  }

  private beamColor(color: number): string { return this.phase === 'build' ? COLOR_HEX[color] ?? COLOR_HEX[WHITE] : GOLD; }

  private drawBeams(g: CanvasRenderingContext2D): void {
    const { cell } = this;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round'; g.lineJoin = 'round';
    const flick = 0.9 + 0.1 * Math.sin(this.clock * 37) * Math.sin(this.clock * 23);
    for (const b of this.t.beams) {
      if (b.pts.length < 4) continue;
      const col = this.beamColor(b.color);
      g.beginPath();
      for (let i = 0; i < b.pts.length; i += 2) {
        const { x, y } = this.px(b.pts[i], b.pts[i + 1]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = rgba(col, 0.13 * flick); g.lineWidth = cell * 0.42; g.stroke();
      g.strokeStyle = rgba(col, 0.38 * flick); g.lineWidth = cell * 0.16; g.stroke();
      g.strokeStyle = rgba('#FFFFFF', 0.85); g.lineWidth = Math.max(1.5, cell * 0.045); g.stroke();
      // Pulses travelling along the beam.
      g.setLineDash([cell * 0.1, cell * 0.85]);
      g.lineDashOffset = -this.clock * cell * 5;
      g.strokeStyle = rgba('#FFFFFF', 0.7); g.lineWidth = Math.max(2, cell * 0.08); g.stroke();
      g.setLineDash([]);
    }
    for (const h of this.t.hits) {
      const { x, y } = this.px(h.x, h.y);
      drawGlow(g, this.beamColor(h.color), x, y, cell * 0.35, 0.5 * flick);
    }
    g.restore();
  }

  private drawThings(g: CanvasRenderingContext2D, _top: boolean): void {
    const { cell } = this;
    for (const e of this.board.emitters) {
      const { x, y } = this.px(e.c + 0.5, e.r + 0.5);
      const s = cell * 0.36;
      roundRect(g, x - s, y - s, s * 2, s * 2, s * 0.35);
      g.fillStyle = '#2A2E4E'; g.fill();
      g.strokeStyle = '#3B4170'; g.lineWidth = 2; g.stroke();
      const col = COLOR_HEX[e.color];
      const lx = x + DX[e.d] * s * 0.75, ly = y + DY[e.d] * s * 0.75;
      drawGlow(g, col, lx, ly, cell * 0.5, 0.55);
      g.beginPath(); g.arc(lx, ly, s * 0.38, 0, Math.PI * 2); g.fillStyle = col; g.fill();
      g.beginPath(); g.arc(lx, ly, s * 0.18, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill();
    }
    let k = 0;
    this.board.portals.forEach((to, i) => {
      if (to < i) return;
      const pair = PORTAL_COLORS[k++ % PORTAL_COLORS.length];
      for (const j of [i, to]) {
        const { x, y } = this.px((j % this.def.w) + 0.5, Math.floor(j / this.def.w) + 0.5);
        drawGlow(g, pair, x, y, cell * 0.55, 0.35);
        g.save(); g.translate(x, y); g.rotate(this.clock * (j === i ? 1.6 : -1.6));
        g.setLineDash([cell * 0.12, cell * 0.08]);
        g.beginPath(); g.arc(0, 0, cell * 0.32, 0, Math.PI * 2); g.strokeStyle = pair; g.lineWidth = cell * 0.07; g.stroke();
        g.setLineDash([]);
        g.beginPath(); g.arc(0, 0, cell * 0.18, 0, Math.PI * 2); g.fillStyle = rgba(pair, 0.35); g.fill();
        g.restore();
      }
    });
    this.board.crystals.forEach((cr, i) => {
      const { x, y } = this.px(cr.c + 0.5, cr.r + 0.5);
      const on = this.lit[i];
      const col = this.phase !== 'build' && on ? GOLD : cr.gem ? '#FFFFFF' : COLOR_HEX[cr.color];
      const flash = this.litFlash[i];
      if (cr.gem) drawGem(g, x, y, cell * 0.24 * (1 + flash * 0.4), on, this.clock);
      else drawCrystal(g, x, y, cell * 0.27 * (1 + flash * 0.35), col, on, this.clock + i);
      if (flash > 0) {
        g.beginPath(); g.arc(x, y, cell * (0.3 + (1 - flash) * 0.6), 0, Math.PI * 2);
        g.strokeStyle = rgba(col, flash * 0.8); g.lineWidth = 2; g.stroke();
      }
    });
  }

  private drawPieces(g: CanvasRenderingContext2D): void {
    const { cell } = this;
    for (const p of this.board.fixed) {
      const { x, y } = this.px(p.c + 0.5, p.r + 0.5);
      drawPiece(g, p.kind, p.o, x, y, cell, true, this.clock, this.t.combined.get(p.r * this.def.w + p.c));
    }
    const lifted = this.placer.lifted();
    const hold = this.placer.holdProgress();
    for (const p of this.build.pieces) {
      if (lifted && lifted.c === p[1] && lifted.r === p[2]) continue;
      const { x, y } = this.px(p[1] + 0.5, p[2] + 0.5);
      let s = cell;
      if (hold && hold.c === p[1] && hold.r === p[2]) s *= 1 - 0.18 * Math.min(1, hold.k);
      drawPiece(g, p[0], p[3], x, y, s, false, this.clock, this.t.combined.get(p[2] * this.def.w + p[1]));
      if (hold && hold.c === p[1] && hold.r === p[2]) {
        g.beginPath(); g.arc(x, y, cell * 0.48, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hold.k));
        g.strokeStyle = C.pink; g.lineWidth = 3; g.stroke();
      }
    }
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const ghost = this.phase === 'build' ? this.placer.ghost(hov) : null;
    if (ghost) {
      const { x, y } = this.px(ghost.c + 0.5, ghost.r + 0.5);
      g.save(); g.globalAlpha = ghost.ok ? 0.45 : 0.25;
      const o = lifted ? this.pieceAt(lifted.c, lifted.r)?.[3] ?? 0 : 0;
      drawPiece(g, ghost.kind as Kind, o, x, y, cell, false, this.clock);
      if (!ghost.ok) { g.strokeStyle = C.pink; g.lineWidth = 3; roundRect(g, x - cell * 0.45, y - cell * 0.45, cell * 0.9, cell * 0.9, cell * 0.14); g.stroke(); }
      g.restore();
    }
    if (lifted) {
      const p = this.pieceAt(lifted.c, lifted.r);
      if (p) { g.save(); g.globalAlpha = 0.9; drawPiece(g, p[0], p[3], lifted.x, lifted.y, cell * 1.08, false, this.clock); g.restore(); }
    }
    const carried = this.placer.carried();
    if (carried) { g.save(); g.globalAlpha = 0.9; drawPiece(g, carried.kind as Kind, 0, carried.x, carried.y, cell * 1.08, false, this.clock); g.restore(); }
    const cur = this.placer.cursor;
    if (cur.show && this.phase === 'build') {
      const x = this.ox + cur.c * cell, y = this.oy + cur.r * cell;
      roundRect(g, x + 1, y + 1, cell - 2, cell - 2, cell * 0.14);
      g.strokeStyle = rgba(ACCENT, 0.6 + 0.4 * Math.sin(this.clock * 6)); g.lineWidth = 2.5; g.stroke();
    }
  }

  private drawUi(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 20px ${FONT.title}`;
    const title = `${this.level.chapter} ${this.level.n} · ${this.def.name}`;
    g.fillText(fitText(g, title, Math.max(80, w - 260)), 16, 34);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`;
    const crystals = this.board.crystals.filter((c) => !c.gem);
    const litN = crystals.filter((c) => this.lit[this.board.crystals.indexOf(c)]).length;
    g.fillText(`${litN}/${crystals.length} crystals · ${this.build.pieces.length} piece${this.build.pieces.length === 1 ? '' : 's'} · par ${this.def.par}`, 16, 54);
    for (const b of this.btns) drawBtn(g, b, ACCENT, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    const hk = hov && this.inv.at(hov.x, hov.y);
    this.inv.draw(g, ACCENT, this.placer.selected, hk ? hk.item.kind : null, matchMedia('(pointer: fine)').matches);
    if (TEACH.has(this.level.id) && this.phase === 'build') this.drawHint(g);
  }

  /** Levels 1-3: a ghost hand shows drag-to-place, then tap-to-rotate. No text. */
  private drawHint(g: CanvasRenderingContext2D): void {
    if (this.idle < 2.6 || this.placer.drag) return;
    const sol = this.def.solution;
    const wrongTurn = sol.find(([k, c, r, o]) => { const p = this.pieceAt(c, r); return p && p[0] === k && p[3] !== o; });
    const missing = sol.find(([k, c, r]) => { const p = this.pieceAt(c, r); return !p || p[0] !== k; });
    const t = (this.idle - 2.6) % 1.8;
    if (wrongTurn) {
      const { x, y } = this.px(wrongTurn[1] + 0.5, wrongTurn[2] + 0.5);
      const k = t < 0.5 ? t / 0.5 : 1;
      drawHand(g, x + this.cell * 0.2, y + this.cell * 0.25 - (t < 0.3 ? 0 : 4), this.cell, 0.8);
      if (t > 0.3 && t < 1.0) { g.beginPath(); g.arc(x, y, this.cell * (0.2 + k * 0.35), 0, Math.PI * 2); g.strokeStyle = rgba('#FFFFFF', 0.6 * (1 - (t - 0.3) / 0.7)); g.lineWidth = 2; g.stroke(); }
      return;
    }
    if (!missing || this.build.pieces.length >= sol.length + 1) return;
    const slot = this.inv.slots.find((s) => s.item.kind === missing[0]);
    if (!slot) return;
    const from = { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 };
    const to = this.px(missing[1] + 0.5, missing[2] + 0.5);
    const k = Math.min(1, Math.max(0, (t - 0.25) / 1.0));
    const e = k * k * (3 - 2 * k);
    const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
    g.save(); g.globalAlpha = 0.35 * (t < 1.5 ? 1 : (1.8 - t) / 0.3);
    drawPiece(g, missing[0], 0, x, y, this.cell, false, this.clock);
    g.restore();
    drawHand(g, x + this.cell * 0.2, y + this.cell * 0.25, this.cell, t < 1.5 ? 0.85 : 0.85 * (1.8 - t) / 0.3);
  }

  // ---- dev editor (?editor) -------------------------------------------------

  private setupEditor(): void {
    if (!editorMode() || this.demo || this.ctx.preview) return;
    if (this.editor) { this.editor.destroy(); this.editor = null; }
    const parent = this.ctx.canvas.el.parentElement;
    if (!parent) return;
    const tools = [
      ['wall', 'Wall'], ['glass', 'Glass'], ['empty', 'Clear'], ['emit', 'Emitter'], ['crystal', 'Crystal'],
      ['crystal-1', 'Red'], ['crystal-2', 'Green'], ['crystal-4', 'Blue'], ['crystal-5', 'Magenta'], ['crystal-3', 'Yellow'], ['crystal-6', 'Cyan'],
      ['gem', 'Gem'], ['portal', 'Portal'], ['fixed-mirror', 'Fixed mirror'], ['fixed-combiner', 'Fixed combiner'],
    ].map(([id, label]) => ({ id, label }));
    this.editor = new EditorPanel(parent, {
      title: 'Light Bender', tools,
      onTool: (id) => { this.editTool = id; },
      fields: [
        { id: 'name', label: 'Name', value: this.def.name, onChange: (v) => { this.def.name = v; } },
        { id: 'w', label: 'Width', value: this.def.w, onChange: (v) => this.resize(Number(v), this.def.h) },
        { id: 'h', label: 'Height', value: this.def.h, onChange: (v) => this.resize(this.def.w, Number(v)) },
      ],
      actions: [
        { label: 'Build = solution', run: () => {
          this.def.solution = this.build.pieces.map((p) => [...p] as Placed);
          this.def.par = this.def.solution.length;
          const inv: Partial<Record<Kind, number>> = {};
          for (const [k] of this.def.solution) inv[k] = (inv[k] ?? 0) + 1;
          this.def.inv = inv;
        } },
        { label: 'Solve', run: () => {
          const r = solve(this.def, Math.max(1, this.def.par), this.def.inv, 300_000);
          const min = r.solutions.length ? Math.min(...r.solutions.map((s) => s.pieces.length)) : 0;
          alert(r.capped ? 'Search capped' : `${r.solutions.length} minimal solution(s); fewest pieces ${min}; gem in ${r.solutions.filter((s) => s.gem).length}`);
        } },
        { label: 'Export JSON', run: () => exportJson(`light-bender-${this.level.id}`, this.def) },
      ],
    });
  }

  private resize(w: number, h: number): void {
    if (!(w >= 4 && w <= 12 && h >= 4 && h <= 12)) return;
    const rows = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => this.def.rows[r]?.[c] ?? '.').join(''));
    this.def = { ...this.def, w, h, rows, things: this.def.things.filter((t) => t[1] < w && t[2] < h) };
    this.board = new Board(this.def);
    this.lit = this.board.crystals.map(() => false);
    this.litFlash = this.board.crystals.map(() => 0);
    this.build.pieces = this.build.pieces.filter((p) => p[1] < w && p[2] < h);
    this.retrace(true);
  }

  private editCell(x: number, y: number): boolean {
    const cell = this.placer.cellAt(x, y);
    const tool = this.editTool;
    if (!cell || !tool) return false;
    const { c, r } = cell;
    const d = this.def;
    const setTerrain = (ch: string) => { d.rows[r] = d.rows[r].slice(0, c) + ch + d.rows[r].slice(c + 1); };
    const at = d.things.findIndex((t) => t[1] === c && t[2] === r);
    const existing = at >= 0 ? d.things[at] : null;
    if (existing && existing[0] === 'emit' && tool === 'emit') existing[3] = (existing[3] + 1) % 4;
    else if (existing && existing[0] === 'fixed' && tool.startsWith('fixed-')) existing[4] = (existing[4] + 1) % TURNS[existing[3]];
    else if (existing && existing[0] === 'emit' && tool.startsWith('crystal-')) existing[4] = Number(tool.slice(8));
    else {
      if (at >= 0) d.things.splice(at, 1);
      setTerrain('.');
      this.build.pieces = this.build.pieces.filter((p) => p[1] !== c || p[2] !== r);
      const add = (t: Thing) => d.things.push(t);
      if (tool === 'wall') setTerrain('#');
      else if (tool === 'glass') setTerrain('o');
      else if (tool === 'emit') add(['emit', c, r, 0, WHITE]);
      else if (tool === 'crystal') add(['crystal', c, r, WHITE]);
      else if (tool.startsWith('crystal-')) add(['crystal', c, r, Number(tool.slice(8))]);
      else if (tool === 'gem') add(['gem', c, r]);
      else if (tool === 'portal') add(['portal', c, r, Math.floor(d.things.filter((t) => t[0] === 'portal').length / 2)]);
      else if (tool === 'fixed-mirror') add(['fixed', c, r, 'mirror', 0]);
      else if (tool === 'fixed-combiner') add(['fixed', c, r, 'combiner', 0]);
    }
    this.board = new Board(d);
    this.lit = this.board.crystals.map(() => false);
    this.litFlash = this.board.crystals.map(() => 0);
    this.retrace(true);
    return true;
  }
}

// ---- drawing helpers ----------------------------------------------------------

function fmtTime(s: number): string { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

function fitText(g: CanvasRenderingContext2D, s: string, max: number): string {
  if (g.measureText(s).width <= max) return s;
  while (s.length > 4 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/** A piece centred on (x, y) in a tile of `size`. Player pieces sit on a lit plate; fixed ones are bolted. */
export function drawPiece(g: CanvasRenderingContext2D, kind: Kind, o: number, x: number, y: number, size: number, fixed: boolean, clock: number, combined?: number): void {
  const s = size * 0.42;
  g.save();
  g.translate(x, y);
  roundRect(g, -s, -s, s * 2, s * 2, s * 0.3);
  g.fillStyle = fixed ? '#191B2E' : 'rgba(56,225,245,0.07)'; g.fill();
  g.strokeStyle = fixed ? '#2C2F4C' : 'rgba(56,225,245,0.45)'; g.lineWidth = Math.max(1, size * 0.03); g.stroke();
  if (fixed) {
    g.fillStyle = '#3A3E62';
    for (const [bx, by] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.arc(bx * s * 0.72, by * s * 0.72, size * 0.03, 0, Math.PI * 2); g.fill(); }
  }
  const diag = (k: number) => {
    g.beginPath();
    if ((o & 1) === 0) { g.moveTo(-s * k, s * k); g.lineTo(s * k, -s * k); } else { g.moveTo(-s * k, -s * k); g.lineTo(s * k, s * k); }
  };
  g.lineCap = 'round';
  if (kind === 'mirror') {
    diag(0.8);
    g.strokeStyle = '#8FA3C8'; g.lineWidth = size * 0.13; g.stroke();
    diag(0.78);
    g.strokeStyle = '#E8F4FF'; g.lineWidth = size * 0.05; g.stroke();
  } else if (kind === 'oneway') {
    const n = [[-1, -1], [1, -1], [1, 1], [-1, 1]][o & 3];
    const off = size * 0.035;
    g.save(); g.translate(-n[0] * off, -n[1] * off); diag(0.78);
    g.strokeStyle = '#3A2A3E'; g.lineWidth = size * 0.1; g.stroke(); g.restore();
    g.save(); g.translate(n[0] * off, n[1] * off); diag(0.8);
    g.strokeStyle = '#E8F4FF'; g.lineWidth = size * 0.07; g.stroke(); g.restore();
    // Little arrow on the reflective side.
    g.beginPath(); g.arc(n[0] * s * 0.42, n[1] * s * 0.42, size * 0.045, 0, Math.PI * 2); g.fillStyle = ACCENT; g.fill();
  } else if (kind === 'splitter') {
    diag(0.8);
    g.strokeStyle = 'rgba(160,230,255,0.35)'; g.lineWidth = size * 0.14; g.stroke();
    g.setLineDash([size * 0.07, size * 0.06]);
    diag(0.8); g.strokeStyle = '#CFF6FF'; g.lineWidth = size * 0.05; g.stroke();
    g.setLineDash([]);
  } else if (kind === 'combiner') {
    const dir = o & 3;
    g.beginPath(); g.arc(0, 0, s * 0.62, 0, Math.PI * 2);
    g.fillStyle = combined ? rgba(COLOR_HEX[combined], 0.35) : '#232745'; g.fill();
    g.strokeStyle = combined ? COLOR_HEX[combined] : '#9AA4D8'; g.lineWidth = size * 0.05; g.stroke();
    g.rotate(dir * Math.PI / 2);
    g.beginPath(); g.moveTo(s * 0.2, -s * 0.3); g.lineTo(s * 0.85, 0); g.lineTo(s * 0.2, s * 0.3); g.closePath();
    g.fillStyle = '#E8F4FF'; g.fill();
    for (const a of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      g.beginPath(); g.arc(Math.cos(a) * s * 0.62, Math.sin(a) * s * 0.62, size * 0.035, 0, Math.PI * 2); g.fillStyle = '#9AA4D8'; g.fill();
    }
  } else {
    const col = COLOR_HEX[FILTER_COLOR[kind]!];
    roundRect(g, -s * 0.62, -s * 0.62, s * 1.24, s * 1.24, s * 0.22);
    g.fillStyle = rgba(col, 0.28 + 0.06 * Math.sin(clock * 3)); g.fill();
    g.strokeStyle = col; g.lineWidth = size * 0.06; g.stroke();
  }
  g.restore();
}

function drawCrystal(g: CanvasRenderingContext2D, x: number, y: number, s: number, col: string, on: boolean, t: number): void {
  if (on) drawGlow(g, col, x, y, s * 3.2, 0.55);
  const hum = on ? 1 : 0.55 + 0.15 * Math.sin(t * 2.4);
  g.beginPath();
  g.moveTo(x, y - s * 1.25); g.lineTo(x + s, y); g.lineTo(x, y + s * 1.25); g.lineTo(x - s, y); g.closePath();
  g.fillStyle = on ? col : rgba(col, 0.16 * hum); g.fill();
  g.strokeStyle = on ? '#FFFFFF' : rgba(col, 0.75 * hum); g.lineWidth = 2; g.stroke();
  g.beginPath(); g.moveTo(x, y - s * 1.25); g.lineTo(x - s, y); g.lineTo(x - s * 0.15, y);
  g.closePath(); g.fillStyle = on ? 'rgba(255,255,255,0.55)' : rgba(col, 0.12 * hum); g.fill();
}

function drawGem(g: CanvasRenderingContext2D, x: number, y: number, s: number, on: boolean, t: number): void {
  if (on) {
    const hue = (t * 90) % 360;
    drawGlow(g, '#FFFFFF', x, y, s * 3.4, 0.5);
    g.save(); g.translate(x, y); g.rotate(t * 0.8);
    for (let i = 0; i < 6; i++) {
      g.rotate(Math.PI / 3);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(s * 2.2, -s * 0.25); g.lineTo(s * 2.2, s * 0.25); g.closePath();
      g.fillStyle = `hsla(${(hue + i * 60) % 360},100%,70%,0.35)`; g.fill();
    }
    g.restore();
  }
  g.beginPath();
  g.moveTo(x, y - s * 1.1); g.lineTo(x + s * 1.05, y + s * 0.75); g.lineTo(x - s * 1.05, y + s * 0.75); g.closePath();
  g.fillStyle = on ? '#FFFFFF' : `rgba(255,255,255,${0.08 + 0.05 * Math.sin(t * 3)})`; g.fill();
  g.strokeStyle = on ? '#FFFFFF' : 'rgba(255,255,255,0.4)'; g.lineWidth = 1.5; g.stroke();
}

function drawHand(g: CanvasRenderingContext2D, x: number, y: number, cell: number, alpha: number): void {
  if (alpha <= 0) return;
  const s = cell * 0.22;
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  g.rotate(-0.35);
  roundRect(g, -s * 0.32, -s * 1.3, s * 0.64, s * 1.5, s * 0.32);
  g.fillStyle = '#FFFFFF'; g.fill();
  roundRect(g, -s * 0.75, -s * 0.15, s * 1.5, s * 1.25, s * 0.5);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.5; g.stroke();
  g.restore();
}

export default (): Game => new LightBender();
