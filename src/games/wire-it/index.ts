import { midiHz } from '../../engine/audio';
import { History, undoKey } from '../../engine/editor/history';
import { drawBtn, fitText, hitBtn, InventoryBar, roundRect, titleRoom, type Btn, type InvItem } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { editorMode } from '../../engine/levels/progress';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { storage } from '../../engine/storage';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { h } from '../../shell/dom';
import {
  boardSize, buildNet, check, codeLines, currentAsts, evaluate, gateCount, makesLoop, par, parse, ParseError,
  PART_W, partH, PARTS, partOf, sinkRef, solutionNet, srcName, srcRef, truthTable, wireCount,
  type Eval, type Gate, type Net, type WILevel,
} from './logic';
import { pack } from './pack';

const BG = '#07100D';
const BOARD = '#0B1713';
const LIVE = C.green;
const OFF = '#33423C';
const BULB = C.yellow;

type Drag =
  | { kind: 'new'; part: string; x: number; y: number; id: number }
  | { kind: 'move'; gate: string; dx: number; dy: number; sx: number; sy: number; moved: boolean; t: number; id: number; before: string }
  | { kind: 'wire'; from: string; reverse: boolean; x: number; y: number; id: number };

interface Pin { kind: 'src' | 'sink'; ref: string; x: number; y: number }

const INTROS: Record<string, { title: string; text: string; demo: 'wire' | 'gate' | 'fanout' | 'numbers' | 'chip'; part?: string }> = {
  wire: { title: 'Wires carry ON and OFF', text: 'Drag from a switch dot to the bulb dot to connect them. Click a switch to flip it.', demo: 'wire' },
  BOTH: { title: 'BOTH', text: 'BOTH is ON only when both inputs are ON. Flip the switches below.', demo: 'gate', part: 'BOTH' },
  EITHER: { title: 'EITHER', text: 'EITHER is ON when at least one input is ON.', demo: 'gate', part: 'EITHER' },
  FLIP: { title: 'FLIP', text: 'FLIP turns ON into OFF and OFF into ON.', demo: 'gate', part: 'FLIP' },
  ONLYONE: { title: 'You built ONLY ONE', text: 'Your circuit from the last level is now one part in your box. ON when exactly one input is ON.', demo: 'gate', part: 'ONLYONE' },
  fanout: { title: 'One output, many wires', text: 'Any output can feed as many inputs as you like.', demo: 'fanout' },
  numbers: { title: 'Bulbs can count', text: 'Each bulb is worth double the one before it: 1, 2, 4. Click the bulbs.', demo: 'numbers' },
  chips: { title: 'Your half adder is a chip', text: 'Chips are circuits you made, packed into one part. This one has two outputs.', demo: 'chip', part: 'HALFADD' },
};

class WireIt implements Game {
  private ctx!: GameContext;
  private level!: Level<WILevel>;
  private def!: WILevel;
  private net: Net = { gates: [], wires: [] };
  private hist = new History<Net>(100);
  private sw: Record<string, number> = {};
  private ev!: Eval;
  private rows: { ins: number[]; outs: number[] }[] = [];
  private results: (boolean | null)[] = [];
  private par = { gates: 0, wires: 0 };
  private board: { w: number; h: number; inputs: readonly string[] } = { w: 16, h: 6, inputs: [] };
  private s = 40;
  private bx = 0;
  private by = 0;
  private panel = { x: 0, y: 0, w: 0, h: 0 };
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private inv = new InventoryBar();
  private drag: Drag | null = null;
  private selected: string | null = null;
  private hoverGate: string | null = null;
  private testing: { row: number; t: number; acc: number } | null = null;
  private solvedT = -1;
  private stamp: { part: string; t: number } | null = null;
  private demo = false;
  private demoQueue: (() => void)[] = [];
  private demoT = 0;
  private seed = 1;
  private clock = 0;
  private time = 0;
  private nextId = 1;
  private bulbOn: Record<string, number> = {};
  private flash: { x: number; y: number; t: number; text: string } | null = null;
  private dom: { code: HTMLElement; lines: HTMLElement; input: HTMLInputElement; msg: HTMLElement } | null = null;
  private intro: HTMLElement | null = null;
  private codeKey = '';

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', (p) => this.up(p));
    ctx.input.on('alt', (p) => this.alt(p));
    ctx.input.onKey((code, e) => {
      if (this.demo || this.intro || this.solvedT >= 0) return;
      const u = undoKey(code, e);
      if (u) { e.preventDefault(); this.button(u); return; }
      if ((code === 'Delete' || code === 'Backspace') && this.selected) { e.preventDefault(); this.removeGate(this.selected); }
      else if (code === 'KeyT') this.button('test');
      else if (/^Digit[1-9]$/.test(code)) { const sl = this.inv.slots[Number(code.slice(5)) - 1]; if (sl) this.addPart(sl.item.kind, this.board.w / 2, this.board.h / 2); }
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 1); lv = pool[seed % pool.length]; }
    this.load(lv);
  }

  private load(level: Level<WILevel>): void {
    this.level = level;
    this.def = level.def;
    this.board = boardSize(this.def);
    this.net = { gates: [], wires: [] };
    this.hist.clear();
    this.rows = truthTable(this.def);
    this.results = this.rows.map(() => null);
    this.par = par(this.def);
    this.sw = Object.fromEntries(this.def.inputs.map((n) => [n, 0]));
    this.bulbOn = {};
    this.selected = null; this.drag = null; this.testing = null; this.solvedT = -1; this.stamp = null;
    this.time = 0; this.nextId = 1;
    this.demoQueue = []; this.demoT = 0;
    this.evalNow(true);
    this.mountDom();
    if (this.demo) this.queueDemo();
    else this.maybeIntro();
  }

  // ---- circuit --------------------------------------------------------------

  private evalNow(silent = false): void {
    this.ev = evaluate(this.net, this.sw, this.def.outputs);
    for (const o of this.def.outputs) {
      const v = this.ev.out[o];
      if (v && !this.bulbOn[o] && !silent && !this.testing) this.ctx.audio.tone({ f: midiHz(84 + this.def.outputs.indexOf(o) * 4), type: 'sine', a: 0.003, d: 0.35, g: 0.08 });
      this.bulbOn[o] = v;
    }
    this.syncCode();
  }

  private edit(fn: () => void, sound: 'snap' | 'pop' | 'place' | null = 'snap'): void {
    if (!this.hist.track(this.net, fn)) return;
    this.results = this.rows.map(() => null);
    const a = this.ctx.audio;
    if (sound === 'snap') a.tick(2400, 0.07);
    else if (sound === 'pop') a.pop(420, 0.14);
    else if (sound === 'place') a.pluck(620, 0.12);
    this.evalNow();
  }

  private addPart(type: string, x: number, y: number): string {
    const id = `g${this.nextId++}`;
    while (partOf(this.net, id)) this.nextId++;
    const p = this.clampPart(type, x, y);
    this.edit(() => { this.net.gates.push({ id, type, x: p.x, y: p.y }); }, 'place');
    this.selected = id;
    return id;
  }

  private clampPart(type: string, x: number, y: number): { x: number; y: number } {
    const hh = partH(type) / 2;
    return {
      x: Math.round(Math.max(3.2, Math.min(this.board.w - 3.2, x)) * 2) / 2,
      y: Math.round(Math.max(hh + 0.2, Math.min(this.board.h - hh - 0.2, y)) * 2) / 2,
    };
  }

  private removeGate(id: string): void {
    this.edit(() => {
      this.net.gates = this.net.gates.filter((g) => g.id !== id);
      this.net.wires = this.net.wires.filter(([s, d]) => s.split('.')[0] !== id && d.split('.')[0] !== id);
    }, 'pop');
    if (this.selected === id) this.selected = null;
  }

  private connect(src: string, dst: string): void {
    if (makesLoop(this.net, src, dst)) { this.deny('That would make a loop'); return; }
    this.edit(() => {
      this.net.wires = this.net.wires.filter((w) => w[1] !== dst);
      this.net.wires.push([src, dst]);
    });
    const p = this.pinPos(dst);
    if (p) this.ctx.fx.particles.burst(p.x, p.y, LIVE, { count: 8, speed: 70, life: 0.3, size: 2.5, sizeEnd: 0, shape: Shape.Spark });
  }

  private deny(text: string): void {
    this.ctx.audio.buzz();
    const hv = this.ctx.input.hover;
    this.flash = { x: hv.x, y: hv.y, t: 1.2, text };
  }

  // ---- geometry -------------------------------------------------------------

  private toScreen(x: number, y: number): { x: number; y: number } { return { x: this.bx + x * this.s, y: this.by + y * this.s }; }
  private toBoard(x: number, y: number): { x: number; y: number } { return { x: (x - this.bx) / this.s, y: (y - this.by) / this.s }; }

  private ioY(i: number, n: number): number { return ((i + 0.5) / n) * this.board.h; }

  private pins(): Pin[] {
    const out: Pin[] = [];
    this.def.inputs.forEach((n, i) => out.push({ kind: 'src', ref: n, x: 1.9, y: this.ioY(i, this.def.inputs.length) }));
    this.def.outputs.forEach((n, i) => out.push({ kind: 'sink', ref: n, x: this.board.w - 1.6, y: this.ioY(i, this.def.outputs.length) }));
    for (const g of this.net.gates) {
      const d = PARTS[g.type];
      d.ins.forEach((_, i) => out.push({ kind: 'sink', ref: `${g.id}.${i}`, x: g.x - PART_W / 2, y: g.y + (i - (d.ins.length - 1) / 2) * 0.8 }));
      d.outs.forEach((_, k) => out.push({ kind: 'src', ref: srcName(g, k), x: g.x + PART_W / 2, y: g.y + (k - (d.outs.length - 1) / 2) * 0.8 }));
    }
    return out;
  }

  private pinPos(ref: string): { x: number; y: number } | null {
    const p = this.pins().find((q) => q.ref === ref);
    return p ? this.toScreen(p.x, p.y) : null;
  }

  private pinAt(x: number, y: number, kind?: 'src' | 'sink'): Pin | null {
    const b = this.toBoard(x, y);
    let best: Pin | null = null, bd = 0.45;
    for (const p of this.pins()) {
      if (kind && p.kind !== kind) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private gateAt(x: number, y: number): Gate | null {
    const b = this.toBoard(x, y);
    for (let i = this.net.gates.length - 1; i >= 0; i--) {
      const g = this.net.gates[i];
      if (Math.abs(b.x - g.x) <= PART_W / 2 && Math.abs(b.y - g.y) <= partH(g.type) / 2) return g;
    }
    return null;
  }

  private switchAt(x: number, y: number): string | null {
    const b = this.toBoard(x, y);
    if (b.x < -0.2 || b.x > 1.6) return null;
    const n = this.def.inputs.length;
    for (let i = 0; i < n; i++) if (Math.abs(b.y - this.ioY(i, n)) < 0.5) return this.def.inputs[i];
    return null;
  }

  private wireCurve(a: { x: number; y: number }, b: { x: number; y: number }): [number, number, number, number, number, number, number, number] {
    const dx = Math.max(this.s * 1.2, Math.abs(b.x - a.x) * 0.5);
    return [a.x, a.y, a.x + dx, a.y, b.x - dx, b.y, b.x, b.y];
  }

  private wireAt(x: number, y: number): number {
    for (let i = 0; i < this.net.wires.length; i++) {
      const [s, d] = this.net.wires[i];
      const a = this.pinPos(s), b = this.pinPos(d);
      if (!a || !b) continue;
      const c = this.wireCurve(a, b);
      for (let k = 0; k <= 24; k++) {
        const t = k / 24, u = 1 - t;
        const px = u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6];
        const py = u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7];
        if (Math.hypot(px - x, py - y) < Math.max(7, this.s * 0.2)) return i;
      }
    }
    return -1;
  }

  // ---- input ----------------------------------------------------------------

  private locked(): boolean { return this.demo || !!this.intro || this.solvedT >= 0 || !!this.testing; }

  private down(p: Pointer): void {
    if (this.demo || this.intro) return;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    if (this.inTable(p.x, p.y)) { this.pickRow(p.y); return; }
    if (this.locked()) return;
    const slot = this.inv.at(p.x, p.y);
    if (slot) { this.drag = { kind: 'new', part: slot.item.kind, x: p.x, y: p.y, id: p.id }; return; }
    const pin = this.pinAt(p.x, p.y);
    if (pin) { this.drag = { kind: 'wire', from: pin.ref, reverse: pin.kind === 'sink', x: p.x, y: p.y, id: p.id }; this.ctx.audio.tick(1800, 0.05); return; }
    const g = this.gateAt(p.x, p.y);
    if (g) {
      this.selected = g.id;
      const bp = this.toBoard(p.x, p.y);
      this.drag = { kind: 'move', gate: g.id, dx: g.x - bp.x, dy: g.y - bp.y, sx: p.x, sy: p.y, moved: false, t: 0, id: p.id, before: JSON.stringify(this.net) };
      return;
    }
    const s = this.switchAt(p.x, p.y);
    if (s) { this.flip(s); return; }
    const w = this.wireAt(p.x, p.y);
    if (w >= 0) { this.edit(() => { this.net.wires.splice(w, 1); }, 'pop'); return; }
    this.selected = null;
  }

  private move(p: Pointer): void {
    const d = this.drag;
    if (!d || d.id !== p.id) { this.hoverAt(p.x, p.y); return; }
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 6) d.moved = true;
      if (d.moved) {
        const g = partOf(this.net, d.gate);
        if (g) { const bp = this.toBoard(p.x, p.y); const c = this.clampPart(g.type, bp.x + d.dx, bp.y + d.dy); g.x = c.x; g.y = c.y; }
      }
    } else { d.x = p.x; d.y = p.y; }
  }

  private up(p: Pointer): void {
    this.pressBtn = null;
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    this.drag = null;
    if (d.kind === 'new') {
      const bp = this.toBoard(p.x, p.y);
      if (bp.x > 1 && bp.x < this.board.w - 1 && bp.y > 0 && bp.y < this.board.h) this.addPart(d.part, bp.x, bp.y);
      else if (this.inv.at(p.x, p.y)) this.addPart(d.part, this.board.w / 2, this.board.h / 2);
    } else if (d.kind === 'move') {
      if (d.moved) {
        const after = JSON.stringify(this.net);
        if (after !== d.before) { this.hist.push(d.before); this.ctx.audio.tick(1600, 0.04); }
        // Dropped on the palette = put it back.
        if (this.inv.at(p.x, p.y)) this.removeGate(d.gate);
      }
    } else {
      const target = this.pinAt(p.x, p.y, d.reverse ? 'src' : 'sink');
      if (!target) return;
      const src = d.reverse ? target.ref : d.from, dst = d.reverse ? d.from : target.ref;
      if (srcRef(this.net, src).gate?.id === sinkRef(this.net, dst).gate?.id && srcRef(this.net, src).gate) { this.deny('That would make a loop'); return; }
      this.connect(src, dst);
    }
  }

  private alt(p: Pointer): void {
    if (this.locked()) return;
    const g = this.gateAt(p.x, p.y);
    if (g) { this.removeGate(g.id); return; }
    const w = this.wireAt(p.x, p.y);
    if (w >= 0) this.edit(() => { this.net.wires.splice(w, 1); }, 'pop');
  }

  private hoverAt(x: number, y: number): void {
    const g = this.drag ? null : this.gateAt(x, y);
    this.setHover(g?.id ?? null);
  }

  private setHover(id: string | null): void {
    if (id === this.hoverGate) return;
    this.hoverGate = id;
    this.dom?.lines.querySelectorAll<HTMLElement>('[data-gate]').forEach((el) => el.classList.toggle('hot', el.dataset.gate === id));
  }

  private flip(name: string): void {
    this.sw[name] ^= 1;
    this.ctx.audio.tick(this.sw[name] ? 1900 : 1200, 0.07);
    this.evalNow();
  }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (this.locked() && id !== 'test') return;
    if (id === 'undo' || id === 'redo') {
      const s = id === 'undo' ? this.hist.undo(this.net) : this.hist.redo(this.net);
      if (!s) { a.buzz(); return; }
      this.net = s; this.results = this.rows.map(() => null); a.tick(1300, 0.06); this.evalNow();
    } else if (id === 'reset') {
      if (!this.net.gates.length && !this.net.wires.length) return;
      this.hist.push(this.net);
      this.net = { gates: [], wires: [] }; this.results = this.rows.map(() => null);
      a.whoosh(0.12, 0.2); this.evalNow();
    } else if (id === 'test') {
      if (this.testing || this.solvedT >= 0) return;
      this.results = this.rows.map(() => null);
      this.testing = { row: 0, t: 0, acc: 0 };
      a.whoosh(0.1, 0.2);
    }
  }

  // ---- truth table ----------------------------------------------------------

  private rowH(): number { return Math.max(14, Math.min(26, (this.panel.h - 56) / Math.max(1, this.rows.length))); }
  private visibleRows(): { from: number; count: number } {
    const count = Math.max(1, Math.floor((this.panel.h - 56) / this.rowH()));
    const cur = this.testing ? this.testing.row : this.currentRow();
    const from = Math.max(0, Math.min(this.rows.length - count, cur - Math.floor(count / 2)));
    return { from, count: Math.min(count, this.rows.length) };
  }
  private currentRow(): number {
    const ins = this.def.inputs.map((n) => this.sw[n]);
    return this.rows.findIndex((r) => r.ins.every((v, i) => v === ins[i]));
  }
  private inTable(x: number, y: number): boolean {
    const p = this.panel;
    return p.w > 0 && x >= p.x && x <= p.x + p.w && y >= p.y + 44 && y <= p.y + p.h;
  }
  private pickRow(y: number): void {
    if (this.testing) return;
    const { from, count } = this.visibleRows();
    const k = Math.floor((y - this.panel.y - 44) / this.rowH());
    if (k < 0 || k >= count) return;
    const row = this.rows[from + k];
    this.def.inputs.forEach((n, i) => { this.sw[n] = row.ins[i]; });
    this.ctx.audio.tick(1500, 0.05);
    this.evalNow();
  }

  // ---- loop -----------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    if (!this.intro) this.time += dt;
    if (this.flash && (this.flash.t -= dt) <= 0) this.flash = null;
    const d = this.drag;
    if (d?.kind === 'move' && !d.moved) {
      d.t += dt;
      if (d.t > 0.55) { this.drag = null; this.removeGate(d.gate); }
    }
    if (this.testing) this.testTick(dt);
    if (this.solvedT >= 0) this.solvedTick(dt);
    if (this.demo) this.demoTick(dt);
  }

  private testTick(dt: number): void {
    const t = this.testing!;
    const per = this.rows.length <= 16 ? 0.32 : Math.max(0.012, 3 / this.rows.length);
    t.acc += dt;
    while (t.acc >= per && t.row < this.rows.length) {
      t.acc -= per;
      const row = this.rows[t.row];
      this.def.inputs.forEach((n, i) => { this.sw[n] = row.ins[i]; });
      this.evalNow(true);
      const ok = check(this.def, this.net, [row])[0];
      this.results[t.row] = ok;
      if (this.rows.length <= 64 || !ok || t.row % 8 === 0) this.ctx.audio.tone({ f: ok ? midiHz(72 + (t.row % 8)) : 140, type: ok ? 'sine' : 'square', a: 0.003, d: ok ? 0.12 : 0.18, g: ok ? 0.06 : 0.05, lp: ok ? undefined : 900 });
      t.row++;
    }
    if (t.row >= this.rows.length && t.acc > 0.25) {
      this.testing = null;
      const pass = this.results.every((r) => r);
      if (pass) this.startSolved();
      else {
        this.ctx.audio.buzz();
        const bad = this.results.findIndex((r) => r === false);
        const row = this.rows[bad];
        this.def.inputs.forEach((n, i) => { this.sw[n] = row.ins[i]; });
        this.evalNow(true);
        const fails = this.results.filter((r) => r === false).length;
        this.flash = { x: this.ctx.canvas.w / 2, y: this.by - 6, t: 2, text: `${fails} case${fails === 1 ? '' : 's'} wrong. The switches show the first one.` };
      }
    }
  }

  private startSolved(): void {
    this.solvedT = 0;
    this.selected = null;
    const a = this.ctx.audio;
    [0, 4, 7, 12].forEach((n, i) => a.tone({ f: midiHz(72 + n), type: 'triangle', a: 0.005, d: 0.5, g: 0.1, at: i * 0.08 }));
    a.sparkle(1568);
    const make = this.def.makes;
    if (make && !this.demo) {
      const chips = storage.get<Record<string, { parts: number; net: Net }>>('wire-it:chips', {});
      chips[make] = { parts: gateCount(this.net), net: this.net };
      storage.set('wire-it:chips', chips);
      this.stamp = { part: make, t: 0 };
    }
  }

  private solvedTick(dt: number): void {
    this.solvedT += dt;
    if (this.stamp) {
      const before = this.stamp.t;
      this.stamp.t += dt;
      if (before < 0.55 && this.stamp.t >= 0.55) { this.ctx.audio.thud(0.9); this.ctx.fx.camera.shake(0.2); }
    }
    const done = this.stamp ? 1.9 : 1.2;
    if (this.solvedT > done && this.solvedT - dt <= done) {
      if (this.demo) return;
      const g = gateCount(this.net), w = wireCount(this.net);
      finishLevel(this.ctx, pack, this.level, 'Wire It', {
        goals: ['Pass every case', `Use ${this.par.gates} part${this.par.gates === 1 ? '' : 's'} or fewer`, `…and ${this.par.wires} wires or fewer`],
        met: [true, g <= this.par.gates, w <= this.par.wires],
        stats: [
          { label: 'parts', value: `${g} / par ${this.par.gates}` },
          { label: 'wires', value: `${w} / par ${this.par.wires}` },
          { label: 'cases', value: String(this.rows.length) },
        ],
        delayMs: 200,
      });
    }
  }

  private queueDemo(): void {
    const sol = solutionNet(this.def);
    const q: (() => void)[] = [];
    for (const g of sol.gates) q.push(() => { this.net.gates.push({ ...g }); this.evalNow(true); });
    for (const w of sol.wires) q.push(() => { this.net.wires.push([...w] as [string, string]); this.evalNow(true); });
    q.push(() => { this.testing = { row: 0, t: 0, acc: 0 }; });
    this.demoQueue = q;
  }

  private demoTick(dt: number): void {
    this.demoT += dt;
    if (this.demoQueue.length && !this.testing && this.demoT > 0.22) { this.demoT = 0; this.demoQueue.shift()!(); }
    if (this.solvedT > 2.2 || (!this.demoQueue.length && !this.testing && this.solvedT < 0 && this.demoT > 3)) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.start(this.seed, { demo: true });
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.dom?.code.remove(); this.intro?.remove(); this.dom = null; this.intro = null; }

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, parts: this.net.gates.length, wires: this.net.wires.length, rows: this.rows.length };
  }

  // ---- DOM: code strip, type mode, intro --------------------------------------

  private mountDom(): void {
    this.dom?.code.remove(); this.dom = null;
    this.intro?.remove(); this.intro = null;
    if (this.demo || this.ctx.preview) return;
    const parent = this.ctx.canvas.el.parentElement;
    if (!parent) return;
    const lines = h('div.wi-lines');
    const msg = h('div.wi-msg', { role: 'status' });
    const input = h('input.wi-type', {
      type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Type a circuit',
      placeholder: `Type a circuit: ${this.def.outputs[0]} = BOTH(${this.def.inputs[0]}, ${this.def.inputs[1] ?? this.def.inputs[0]})`,
      onkeydown: (e: Event) => { const k = e as KeyboardEvent; k.stopPropagation(); if (k.key === 'Enter') this.typed(input.value); if (k.key === 'Escape') input.blur(); },
    }) as HTMLInputElement;
    const code = h('div.wi-code', { onpointerdown: (e: Event) => e.stopPropagation() }, lines, h('div.wi-typerow', {}, input, msg));
    lines.addEventListener('pointerover', (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-gate]'); this.setHover(t?.dataset.gate ?? null); });
    lines.addEventListener('pointerleave', () => this.setHover(null));
    parent.append(code);
    this.dom = { code, lines, input, msg };
    this.codeKey = '';
    this.syncCode();
  }

  private syncCode(): void {
    if (!this.dom) return;
    const ls = codeLines(this.def, this.net);
    const key = JSON.stringify(ls);
    if (key === this.codeKey) return;
    this.codeKey = key;
    this.dom.lines.replaceChildren(...ls.map((line) => h('div.wi-line', {}, ...line.map((t) =>
      t.gate ? h('span', { 'data-gate': t.gate, class: t.gate === this.hoverGate ? 'hot' : '' }, t.text) : h('span', {}, t.text)))));
  }

  /** Type mode: "bulb = EITHER(BOTH(a, b), c)" rebuilds the circuit and lays it out. */
  private typed(text: string): void {
    const dom = this.dom!;
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(text);
    let bulb = this.def.outputs[0], body = text;
    if (m && this.def.outputs.some((o) => o.toLowerCase() === m[1].toLowerCase())) { bulb = this.def.outputs.find((o) => o.toLowerCase() === m[1].toLowerCase())!; body = m[2]; }
    else if (m && !this.def.inputs.includes(m[1])) { this.say(`There's no bulb called "${m[1]}". Bulbs: ${this.def.outputs.join(', ')}.`, true); return; }
    try {
      const ast = parse(body, this.def.inputs, this.def.parts);
      const asts = currentAsts(this.def, this.net);
      asts[bulb] = ast;
      const next = buildNet(asts, this.board);
      this.edit(() => { this.net.gates = next.gates; this.net.wires = next.wires; }, 'place');
      this.nextId = next.gates.length + 1;
      dom.input.value = '';
      this.say(`Built ${bulb}. Flip the switches to try it.`, false);
    } catch (e) {
      if (e instanceof ParseError) this.say(e.message, true);
      else throw e;
    }
  }

  private say(text: string, bad: boolean): void {
    if (!this.dom) return;
    this.dom.msg.textContent = text;
    this.dom.msg.classList.toggle('bad', bad);
    if (bad) this.ctx.audio.buzz();
  }

  private maybeIntro(): void {
    const key = this.def.intro;
    if (!key || this.ctx.preview || editorMode()) return;
    const seen = storage.get<string[]>('wire-it:intros', []);
    if (seen.includes(key)) return;
    const info = INTROS[key];
    if (!info) return;
    const parent = this.ctx.canvas.el.parentElement;
    if (!parent) return;
    const cv = h('canvas.wi-demo', { width: 300, height: 130 }) as HTMLCanvasElement;
    const mini = new MiniDemo(cv, info.demo, info.part, (f) => this.ctx.audio.tick(f, 0.06));
    const close = () => {
      mini.stop();
      this.intro?.remove(); this.intro = null;
      storage.set('wire-it:intros', [...seen, key]);
      this.ctx.audio.ui();
    };
    const btn = h('button.btn.primary', { type: 'button', onclick: close }, 'Got it');
    this.intro = h('div.wi-intro', { onpointerdown: (e: Event) => e.stopPropagation() },
      h('div.card', {}, h('h2', {}, info.title), h('p', {}, info.text), cv, btn));
    this.intro.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); close(); } });
    parent.append(this.intro);
    btn.focus({ preventScroll: true });
  }

  // ---- render ---------------------------------------------------------------

  private layout(): void {
    const { w, h: H } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 8 : 74 + (this.numbersOn() ? 36 : 0) + (w < 560 ? 32 : 0);
    const codeH = small ? 0 : 30 + this.def.outputs.length * 22 + 10;
    const invH = small ? 0 : 74;
    const wide = w > 820 && !small;
    const tableW = wide ? Math.min(300, Math.max(230, w * 0.24)) : 0;
    const narrowTable = !wide && !small ? Math.min(150, H * 0.2) : 0;
    const areaW = w - 20 - tableW - (wide ? 12 : 0);
    const areaH = H - top - codeH - invH - narrowTable - (small ? 8 : 20);
    this.s = Math.max(10, Math.min(areaW / this.board.w, areaH / this.board.h, 56));
    this.bx = 10 + (areaW - this.board.w * this.s) / 2;
    this.by = top + (areaH - this.board.h * this.s) / 2;
    this.panel = wide ? { x: w - tableW - 10, y: 74, w: tableW, h: H - 74 - invH - 16 }
      : narrowTable ? { x: 10, y: top + areaH + 6, w: w - 20, h: narrowTable } : { x: 0, y: 0, w: 0, h: 0 };
    if (this.dom) {
      const st = this.dom.code.style;
      st.left = `${10}px`; st.width = `${(wide ? areaW : w - 20)}px`;
      st.bottom = `${invH + 12}px`;
    }
    if (small) { this.btns = []; this.inv.layout([], 0, 0, 0, 0); return; }
    const chips = storage.get<Record<string, { parts: number }>>('wire-it:chips', {});
    const items: InvItem[] = this.def.parts.map((t) => ({
      kind: t, count: null, label: chips[t] ? `yours · ${chips[t].parts}` : PARTS[t].real,
      draw: (g, cx, cy, size) => drawPartIcon(g, t, cx, cy, size),
    }));
    this.inv.layout(items, 10, H - invH - 8, Math.min(w - 20, Math.max(80, items.length * (invH + 8))), invH);
    const bs = 44, gap = 8, right = w - 64;
    const busy = this.locked();
    const ids: [string, Btn['icon'], boolean][] = [['reset', 'reset', !busy && this.net.gates.length + this.net.wires.length > 0], ['redo', 'redo', !busy && this.hist.canRedo], ['undo', 'undo', !busy && this.hist.canUndo]];
    const testW = w < 560 ? bs : 112;
    this.btns = ids.map(([id, icon, en], i) => ({ id, icon, x: right - (i + 1) * bs - i * gap - testW - gap, y: 12, w: bs, h: bs, enabled: en }));
    this.btns.push({ id: 'test', icon: 'test', label: testW > bs ? 'Test' : undefined, x: right - testW, y: 12, w: testW, h: bs, enabled: !this.testing && this.solvedT < 0, primary: true });
  }

  render(): void {
    const g = this.ctx.canvas.begin(BG);
    this.layout();
    const fx = this.ctx.fx;
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    this.drawBoard(g);
    this.drawWires(g);
    this.drawIO(g);
    for (const gate of this.net.gates) this.drawGate(g, gate);
    this.drawDrag(g);
    g.save(); g.globalCompositeOperation = 'lighter'; fx.particles.render(g); g.restore();
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
    if (this.panel.w) this.drawTable(g);
    if (this.stamp) this.drawStamp(g);
  }

  private drawBoard(g: CanvasRenderingContext2D): void {
    const { s, bx, by } = this;
    const W = this.board.w * s, H = this.board.h * s;
    roundRect(g, bx - 8, by - 8, W + 16, H + 16, 16);
    g.fillStyle = BOARD; g.fill();
    const sweep = this.solvedT >= 0 ? Math.min(1, this.solvedT / 0.8) : 0;
    if (sweep) {
      const grad = g.createLinearGradient(bx + W * sweep - 120, 0, bx + W * sweep, 0);
      grad.addColorStop(0, rgba(LIVE, 0)); grad.addColorStop(1, rgba(LIVE, 0.25 * (1 - Math.max(0, this.solvedT - 1))));
      g.fillStyle = grad; g.fillRect(bx - 8, by - 8, W * sweep + 8, H + 16);
    }
    g.fillStyle = 'rgba(74,222,128,0.07)';
    for (let x = 1; x < this.board.w; x++) for (let y = 1; y < this.board.h; y++) g.fillRect(bx + x * s - 1, by + y * s - 1, 2, 2);
    if (this.numbersOn()) this.drawNumbers(g);
  }

  private numbersOn(): boolean { return !!this.def.numbers?.length; }

  private drawNumbers(g: CanvasRenderingContext2D): void {
    const groups = this.def.numbers!;
    const val = (bits: string[]) => bits.reduce((a, b, i) => a + ((this.sw[b] ?? this.ev.out[b] ?? 0) << i), 0);
    const text = groups.map((gr) => `${gr.label} = ${val(gr.bits)}`).join('    ');
    g.font = `700 ${Math.max(13, Math.min(20, this.s * 0.45))}px ${FONT.mono}`;
    const tw = g.measureText(text).width + 24;
    const x = this.bx + (this.board.w * this.s - tw) / 2, y = this.by - 6 - 30;
    roundRect(g, x, y, tw, 28, 8);
    g.fillStyle = '#04110B'; g.fill(); g.strokeStyle = rgba(LIVE, 0.35); g.lineWidth = 1; g.stroke();
    g.fillStyle = LIVE; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x + tw / 2, y + 15);
  }

  private srcValue(ref: string): number { return this.ev.src.get(ref) ?? 0; }

  private drawWires(g: CanvasRenderingContext2D): void {
    const s = this.s;
    g.lineCap = 'round';
    for (const [src, dst] of this.net.wires) {
      const a = this.pinPos(src), b = this.pinPos(dst);
      if (!a || !b) continue;
      const on = this.srcValue(src) === 1;
      const c = this.wireCurve(a, b);
      const hot = this.hoverGate && (src.split('.')[0] === this.hoverGate || dst.split('.')[0] === this.hoverGate);
      g.beginPath(); g.moveTo(c[0], c[1]); g.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
      if (on) {
        g.strokeStyle = rgba(LIVE, 0.18); g.lineWidth = s * 0.32; g.stroke();
        g.strokeStyle = LIVE; g.lineWidth = Math.max(2, s * 0.09); g.stroke();
        g.setLineDash([s * 0.12, s * 0.7]); g.lineDashOffset = -this.clock * s * 3;
        g.strokeStyle = '#E8FFE8'; g.lineWidth = Math.max(2.5, s * 0.12); g.stroke();
        g.setLineDash([]);
      } else {
        g.strokeStyle = hot ? '#5E7A6E' : OFF; g.lineWidth = Math.max(2, s * 0.08); g.stroke();
      }
    }
  }

  private drawIO(g: CanvasRenderingContext2D): void {
    const s = this.s;
    const ni = this.def.inputs.length, no = this.def.outputs.length;
    g.textBaseline = 'middle';
    this.def.inputs.forEach((n, i) => {
      const y = this.by + this.ioY(i, ni) * s, x = this.bx + 0.7 * s;
      const on = this.sw[n] === 1;
      roundRect(g, x - s * 0.45, y - s * 0.25, s * 0.9, s * 0.5, s * 0.25);
      g.fillStyle = on ? LIVE : '#1F2C27'; g.fill();
      g.beginPath(); g.arc(x + (on ? s * 0.2 : -s * 0.2), y, s * 0.19, 0, Math.PI * 2); g.fillStyle = '#F4F1FF'; g.fill();
      g.fillStyle = C.text; g.font = `700 ${Math.max(11, s * 0.34)}px ${FONT.mono}`; g.textAlign = 'center';
      g.fillText(n, x, y - s * 0.5);
      this.drawPin(g, 1.9, this.ioY(i, ni), on);
      g.strokeStyle = on ? LIVE : OFF; g.lineWidth = Math.max(2, s * 0.08);
      g.beginPath(); g.moveTo(x + s * 0.45, y); g.lineTo(this.bx + 1.9 * s, y); g.stroke();
    });
    this.def.outputs.forEach((n, i) => {
      const yy = this.ioY(i, no);
      const y = this.by + yy * s, x = this.bx + (this.board.w - 0.75) * s;
      const on = this.ev.out[n] === 1;
      const row = this.currentRow();
      const want = row >= 0 ? this.rows[row].outs[i] : -1;
      if (on) drawGlow(g, BULB, x, y, s * 1.3, 0.6);
      g.beginPath(); g.arc(x, y, s * 0.36, 0, Math.PI * 2);
      g.fillStyle = on ? BULB : '#2A2A22'; g.fill();
      g.strokeStyle = on ? '#FFF6C8' : '#4A4A3A'; g.lineWidth = 2; g.stroke();
      if (this.testing === null && this.results.some((r) => r !== null) && want >= 0 && want !== this.ev.out[n]) {
        g.beginPath(); g.arc(x, y, s * 0.5, 0, Math.PI * 2); g.strokeStyle = C.pink; g.lineWidth = 3; g.stroke();
      }
      g.fillStyle = C.text; g.font = `700 ${Math.max(11, s * 0.3)}px ${FONT.mono}`; g.textAlign = 'center';
      g.fillText(n, x, y - s * 0.62);
      this.drawPin(g, this.board.w - 1.6, yy, on);
      g.strokeStyle = on ? LIVE : OFF; g.lineWidth = Math.max(2, s * 0.08);
      g.beginPath(); g.moveTo(this.bx + (this.board.w - 1.6) * s, y); g.lineTo(x - s * 0.36, y); g.stroke();
    });
  }

  private drawPin(g: CanvasRenderingContext2D, bxu: number, byu: number, on: boolean): void {
    const p = this.toScreen(bxu, byu);
    g.beginPath(); g.arc(p.x, p.y, Math.max(4, this.s * 0.14), 0, Math.PI * 2);
    g.fillStyle = on ? LIVE : '#56685F'; g.fill();
    g.strokeStyle = '#0B1713'; g.lineWidth = 2; g.stroke();
  }

  private drawGate(g: CanvasRenderingContext2D, gate: Gate): void {
    const s = this.s, d = PARTS[gate.type];
    const hh = partH(gate.type);
    const p = this.toScreen(gate.x - PART_W / 2, gate.y - hh / 2);
    const w = PART_W * s, hgt = hh * s;
    const hot = this.hoverGate === gate.id;
    if (hot) drawGlow(g, d.color, p.x + w / 2, p.y + hgt / 2, w, 0.35);
    roundRect(g, p.x, p.y, w, hgt, s * 0.25);
    g.fillStyle = '#12221C'; g.fill();
    g.strokeStyle = this.selected === gate.id ? '#FFFFFF' : d.color; g.lineWidth = this.selected === gate.id || hot ? 3 : 2; g.stroke();
    g.fillStyle = d.color; g.textAlign = 'center'; g.textBaseline = 'middle';
    const big = Math.max(10, Math.min(s * 0.44, (w - 10) / Math.max(4, d.name.length) * 1.7));
    g.font = `700 ${big}px ${FONT.title}`;
    g.fillText(d.name, p.x + w / 2, p.y + hgt / 2 - s * 0.12);
    g.fillStyle = C.muted; g.font = `600 ${Math.max(8, s * 0.22)}px ${FONT.ui}`;
    g.fillText(d.real, p.x + w / 2, p.y + hgt / 2 + s * 0.3);
    const feed = new Map(this.net.wires.map(([a, b]) => [b, a]));
    d.ins.forEach((name, i) => {
      const yy = gate.y + (i - (d.ins.length - 1) / 2) * 0.8;
      const src = feed.get(`${gate.id}.${i}`);
      this.drawPin(g, gate.x - PART_W / 2, yy, !!src && this.srcValue(src) === 1);
      if (d.ins.length > 2 || PARTS[gate.type].outs.length > 1) {
        const q = this.toScreen(gate.x - PART_W / 2 + 0.25, yy);
        g.fillStyle = C.muted; g.font = `600 ${Math.max(7, s * 0.18)}px ${FONT.mono}`; g.textAlign = 'left';
        g.fillText(name, q.x, q.y);
      }
    });
    d.outs.forEach((name, k) => {
      const yy = gate.y + (k - (d.outs.length - 1) / 2) * 0.8;
      this.drawPin(g, gate.x + PART_W / 2, yy, this.srcValue(srcName(gate, k)) === 1);
      if (d.outs.length > 1) {
        const q = this.toScreen(gate.x + PART_W / 2 - 0.25, yy);
        g.fillStyle = C.muted; g.font = `600 ${Math.max(7, s * 0.18)}px ${FONT.mono}`; g.textAlign = 'right';
        g.fillText(name, q.x, q.y);
      }
    });
    const dr = this.drag;
    if (dr?.kind === 'move' && dr.gate === gate.id && !dr.moved && dr.t > 0.15) {
      g.beginPath(); g.arc(p.x + w / 2, p.y + hgt / 2, Math.max(w, hgt) * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, dr.t / 0.55));
      g.strokeStyle = C.pink; g.lineWidth = 3; g.stroke();
    }
  }

  private drawDrag(g: CanvasRenderingContext2D): void {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'wire') {
      const a = this.pinPos(d.from);
      if (!a) return;
      const target = this.pinAt(d.x, d.y, d.reverse ? 'src' : 'sink');
      const b = target ? this.toScreen(target.x, target.y) : { x: d.x, y: d.y };
      const c = d.reverse ? this.wireCurve(b, a) : this.wireCurve(a, b);
      g.beginPath(); g.moveTo(c[0], c[1]); g.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
      g.strokeStyle = target ? LIVE : '#9AB8AA'; g.lineWidth = Math.max(2, this.s * 0.09);
      g.setLineDash(target ? [] : [6, 6]); g.stroke(); g.setLineDash([]);
      if (target) { g.beginPath(); g.arc(b.x, b.y, this.s * 0.3, 0, Math.PI * 2); g.strokeStyle = LIVE; g.lineWidth = 2; g.stroke(); }
    } else if (d.kind === 'new') {
      g.save(); g.globalAlpha = 0.85;
      const hh = partH(d.part);
      roundRect(g, d.x - PART_W * this.s / 2, d.y - hh * this.s / 2, PART_W * this.s, hh * this.s, this.s * 0.25);
      g.fillStyle = '#12221C'; g.fill(); g.strokeStyle = PARTS[d.part].color; g.lineWidth = 2; g.stroke();
      g.fillStyle = PARTS[d.part].color; g.font = `700 ${Math.max(10, this.s * 0.4)}px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(PARTS[d.part].name, d.x, d.y);
      g.restore();
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
    const narrow = w < 560;
    g.fillText(fitText(g, this.def.goal, narrow ? w - 32 : room), 16, narrow ? 78 : 50);
    g.fillText(fitText(g, `parts ${gateCount(this.net)}/${this.par.gates} · wires ${wireCount(this.net)}/${this.par.wires}`, narrow ? w - 32 : room), 16, narrow ? 96 : 68);
    for (const b of this.btns) drawBtn(g, b, LIVE, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    this.inv.draw(g, LIVE, null, hov ? this.inv.at(hov.x, hov.y)?.item.kind ?? null : null, matchMedia('(pointer: fine)').matches);
    // Part rule on hover (plain English).
    const hk = hov && (this.inv.at(hov.x, hov.y)?.item.kind ?? this.gateAt(hov.x, hov.y)?.type);
    if (hk && !this.drag) {
      const d = PARTS[hk];
      const text = `${d.name}: ${d.rule}`;
      g.font = `600 14px ${FONT.ui}`;
      const tw = g.measureText(text).width + 20;
      const x = Math.min(w - tw - 8, hov!.x + 14), y = hov!.y - 40;
      roundRect(g, x, y, tw, 28, 8); g.fillStyle = 'rgba(10,20,16,0.95)'; g.fill();
      g.strokeStyle = d.color; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.text; g.textBaseline = 'middle'; g.fillText(text, x + 10, y + 14);
    }
    if (this.flash) {
      const f = this.flash;
      g.globalAlpha = Math.min(1, f.t * 3);
      g.font = `700 16px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(f.text).width + 24;
      const x = Math.max(tw / 2 + 8, Math.min(w - tw / 2 - 8, f.x));
      roundRect(g, x - tw / 2, f.y - 40, tw, 30, 15); g.fillStyle = 'rgba(14,15,26,0.92)'; g.fill();
      g.fillStyle = C.pink; g.fillText(f.text, x, f.y - 25);
      g.globalAlpha = 1;
    }
  }

  private drawTable(g: CanvasRenderingContext2D): void {
    const p = this.panel;
    roundRect(g, p.x, p.y, p.w, p.h, 14);
    g.fillStyle = '#0D1A15'; g.fill();
    const ni = this.def.inputs.length, no = this.def.outputs.length;
    const colW = Math.min(30, (p.w - 50) / (ni + no + 0.6));
    const x0 = p.x + 14;
    const outX = x0 + (ni + 0.6) * colW;
    g.font = `700 11px ${FONT.mono}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    this.def.inputs.forEach((n, i) => { g.fillStyle = C.muted; g.fillText(short(n), x0 + (i + 0.5) * colW, p.y + 18); });
    this.def.outputs.forEach((n, i) => { g.fillStyle = BULB; g.fillText(short(n), outX + (i + 0.5) * colW, p.y + 18); });
    const pass = this.results.filter((r) => r === true).length, fail = this.results.filter((r) => r === false).length;
    g.textAlign = 'left'; g.fillStyle = fail ? C.pink : pass ? LIVE : C.muted; g.font = `600 11px ${FONT.ui}`;
    g.fillText(this.results.some((r) => r !== null) ? `${pass} passed${fail ? ` · ${fail} wrong` : ''} of ${this.rows.length}` : `${this.rows.length} cases · click a row to try it`, x0, p.y + 34);
    const rh = this.rowH();
    const { from, count } = this.visibleRows();
    const cur = this.testing ? this.testing.row - 1 : this.currentRow();
    for (let k = 0; k < count; k++) {
      const r = from + k, row = this.rows[r];
      const y = p.y + 44 + k * rh;
      const res = this.results[r];
      if (res !== null || r === cur) {
        roundRect(g, p.x + 6, y + 1, p.w - 12, rh - 2, 6);
        g.fillStyle = res === true ? rgba(LIVE, 0.16) : res === false ? rgba(C.pink, 0.2) : 'rgba(255,255,255,0.06)';
        g.fill();
        if (r === cur) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.stroke(); }
      }
      const dot = (x: number, on: number, col: string) => {
        g.beginPath(); g.arc(x, y + rh / 2, Math.min(5, rh * 0.28), 0, Math.PI * 2);
        g.fillStyle = on ? col : 'rgba(255,255,255,0.1)'; g.fill();
      };
      row.ins.forEach((v, i) => dot(x0 + (i + 0.5) * colW, v, LIVE));
      row.outs.forEach((v, i) => dot(outX + (i + 0.5) * colW, v, BULB));
      if (res !== null) {
        g.fillStyle = res ? LIVE : C.pink; g.font = `700 12px ${FONT.ui}`; g.textAlign = 'right';
        g.fillText(res ? '✓' : '✗', p.x + p.w - 14, y + rh / 2 + 1);
      }
    }
  }

  private drawStamp(g: CanvasRenderingContext2D): void {
    const st = this.stamp!;
    const { w, h: H } = this.ctx.canvas;
    const k = Math.min(1, st.t / 0.55);
    const scale = 2.6 - 1.6 * (k * k);
    const alpha = Math.min(1, st.t * 4) * (st.t > 1.6 ? Math.max(0, 1 - (st.t - 1.6) * 4) : 1);
    const cx = w / 2, cy = H * 0.45;
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx, cy); g.scale(scale, scale); g.rotate((1 - k) * -0.25);
    const d = PARTS[st.part];
    roundRect(g, -90, -48, 180, 96, 16);
    g.fillStyle = '#12221C'; g.fill(); g.strokeStyle = d.color; g.lineWidth = 4; g.stroke();
    g.fillStyle = d.color; g.font = `700 28px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(d.name, 0, -8);
    g.fillStyle = C.text; g.font = `600 12px ${FONT.ui}`;
    g.fillText('NEW PART · your design', 0, 24);
    g.restore();
  }
}

/** Tiny interactive circuit for the intro cards. */
class MiniDemo {
  private sw = [0, 0];
  private raf = 0;
  constructor(private cv: HTMLCanvasElement, private kind: 'wire' | 'gate' | 'fanout' | 'numbers' | 'chip', private part: string | undefined, private tick: (f: number) => void) {
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) * (cv.width / r.width), y = (e.clientY - r.top) * (cv.height / r.height);
      const n = this.kind === 'numbers' ? 3 : this.inputs();
      for (let i = 0; i < n; i++) {
        const [sx, sy] = this.kind === 'numbers' ? [230, 25 + i * 40] : [40, this.ioY(i, n)];
        if (Math.hypot(x - sx, y - sy) < 24) { this.sw[i] ^= 1; this.tick(this.sw[i] ? 1900 : 1200); }
      }
    });
    if (kind === 'numbers') this.sw = [1, 0, 1];
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  private inputs(): number { return this.kind === 'wire' || this.kind === 'fanout' || this.part === 'FLIP' ? 1 : 2; }
  private ioY(i: number, n: number): number { return 65 + (i - (n - 1) / 2) * 44; }
  stop(): void { cancelAnimationFrame(this.raf); }
  private draw(): void {
    const g = this.cv.getContext('2d')!;
    g.fillStyle = BOARD; g.fillRect(0, 0, this.cv.width, this.cv.height);
    const wire = (x1: number, y1: number, x2: number, y2: number, on: number) => {
      g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo(x1 + 40, y1, x2 - 40, y2, x2, y2);
      g.strokeStyle = on ? LIVE : OFF; g.lineWidth = on ? 4 : 3; g.stroke();
    };
    const sw = (x: number, y: number, on: number, label: string) => {
      roundRect(g, x - 18, y - 10, 36, 20, 10); g.fillStyle = on ? LIVE : '#1F2C27'; g.fill();
      g.beginPath(); g.arc(x + (on ? 8 : -8), y, 8, 0, Math.PI * 2); g.fillStyle = '#F4F1FF'; g.fill();
      g.fillStyle = C.muted; g.font = `700 12px ${FONT.mono}`; g.textAlign = 'center'; g.fillText(label, x, y - 16);
    };
    const bulb = (x: number, y: number, on: number) => {
      if (on) drawGlow(g, BULB, x, y, 34, 0.6);
      g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fillStyle = on ? BULB : '#2A2A22'; g.fill();
    };
    if (this.kind === 'numbers') {
      const v = this.sw[0] + this.sw[1] * 2 + this.sw[2] * 4;
      [1, 2, 4].forEach((w, i) => {
        bulb(230, 25 + i * 40, this.sw[i]);
        g.fillStyle = C.muted; g.font = `600 12px ${FONT.mono}`; g.textAlign = 'right'; g.fillText(`worth ${w}`, 205, 29 + i * 40);
      });
      g.fillStyle = LIVE; g.font = `700 44px ${FONT.mono}`; g.textAlign = 'center'; g.fillText(String(v), 70, 80);
      return;
    }
    const n = this.inputs();
    for (let i = 0; i < n; i++) sw(40, this.ioY(i, n), this.sw[i], 'ab'[i]);
    if (this.kind === 'wire') { wire(58, 65, 247, 65, this.sw[0]); bulb(260, 65, this.sw[0]); return; }
    if (this.kind === 'fanout') { wire(58, 65, 247, 40, this.sw[0]); wire(58, 65, 247, 90, this.sw[0]); bulb(260, 40, this.sw[0]); bulb(260, 90, this.sw[0]); return; }
    const def = PARTS[this.part ?? 'BOTH'];
    const out = def.fn(def.ins.map((_, i) => this.sw[i] ?? 0));
    def.ins.forEach((_, i) => wire(58, this.ioY(i, n), 120, 65 + (i - (def.ins.length - 1) / 2) * 20, this.sw[i] ?? 0));
    roundRect(g, 120, 35, 80, 60, 10); g.fillStyle = '#12221C'; g.fill(); g.strokeStyle = def.color; g.lineWidth = 2; g.stroke();
    g.fillStyle = def.color; g.font = `700 ${def.name.length > 6 ? 13 : 16}px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(def.name, 160, 60);
    g.fillStyle = C.muted; g.font = `600 10px ${FONT.ui}`; g.fillText(def.real, 160, 80);
    out.forEach((v, k) => { const y = 65 + (k - (out.length - 1) / 2) * 40; wire(200, 65 + (k - (out.length - 1) / 2) * 16, 247, y, v); bulb(260, y, v); });
    g.textBaseline = 'alphabetic';
  }
}

function drawPartIcon(g: CanvasRenderingContext2D, type: string, cx: number, cy: number, size: number): void {
  const d = PARTS[type];
  const w = size * 1.5, hh = size * 0.9;
  roundRect(g, cx - w / 2, cy - hh / 2, w, hh, 8);
  g.fillStyle = '#12221C'; g.fill(); g.strokeStyle = d.color; g.lineWidth = 2; g.stroke();
  g.fillStyle = d.color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.min(size * 0.38, (w - 6) / d.name.length * 1.75)}px ${FONT.title}`;
  g.fillText(d.name, cx, cy + 1);
  g.textBaseline = 'alphabetic';
}


const short = (n: string): string => (n.length > 4 ? n.slice(0, 4) : n);


export default (): Game => new WireIt();
