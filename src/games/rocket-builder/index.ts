import { midiHz, type Drone } from '../../engine/audio';
import { History, undoKey } from '../../engine/editor/history';
import { drawBtn, drawBudget, fitText, hitBtn, roundRect, titleRoom, type Btn } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { storage } from '../../engine/storage';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { FlightComputer } from './autopilot';
import { drawFailScene, drawPart, drawRocket, miniRocket } from './draw';
import {
  A_M, ATMO, density, designCost, designErrors, FAILS, Flight, gravity, IDLE, layout, MAX_ROWS, moonAt, PARTS, predictPath, R_E, R_M, sideOk, stageInfo,
  type Control, type Design, type FailId, type FlightEvent, type LivePart, type PartKind, type RMission,
} from './logic';
import { pack } from './pack';

const ACCENT = C.orange;
const FAIL_KEY = 'rocket-builder:fails';

type Phase = 'hangar' | 'flight' | 'result';
type Row = Design['rows'][number];

interface Drag { kind: PartKind; id: number; x: number; y: number; moved: boolean; before: string; fromRocket: boolean; sx: number; sy: number }
interface Debris { parts: LivePart[]; x: number; y: number; vx: number; vy: number; ang: number; w: number; cx: number; cy: number; t: number }
type Target = { kind: 'center'; index: number } | { kind: 'side'; row: number; side: -1 | 1 };

function goalText(m: RMission): string {
  const g = m.goal;
  switch (g.kind) {
    case 'alt': return `Reach ${g.alt >= 1000 ? `${g.alt / 1000} km` : `${g.alt} m`}`;
    case 'return': return `Reach ${g.alt / 1000} km and land safely`;
    case 'orbit': return g.stages ? 'Reach orbit using 2 stages' : 'Reach orbit';
    case 'orbitReturn': return 'Reach orbit, then come home';
    case 'moonFlyby': return 'Fly past the Moon';
    case 'moonOrbit': return 'Orbit the Moon';
    case 'moonLand': return 'Land on the Moon';
    case 'moonReturn': return 'Land on the Moon and come home';
  }
}

function fmtDist(m: number): string {
  const a = Math.abs(m);
  return a < 1000 ? `${Math.round(m)} m` : a < 100_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString()} km`;
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > maxW && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

class RocketBuilder implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level!: Level<RMission>;
  private def!: RMission;
  private design: Design = { rows: [['pod', '', '']] };
  private hist = new History<Design>(100);
  private sym = true;
  private phase: Phase = 'hangar';
  private phaseT = 0;
  private clock = 0;
  private idle = 0;
  private demo = false;
  private seed = 1;
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private banner: { text: string; t: number; color: string } | null = null;
  // Hangar.
  private cat: { kind: PartKind; x: number; y: number; w: number; h: number }[] = [];
  private rs = 20;
  private rox = 0;
  private roy = 0;
  private drag: Drag | null = null;
  private sel: PartKind | null = null;
  private albumOpen = false;
  private discovered = new Set<FailId>();
  // Flight.
  private flight: Flight | null = null;
  private ap: FlightComputer | null = null;
  private auto = true;
  private manThrottle = 1;
  private pendStage = false;
  private pendChute = false;
  private countdown = 0;
  private simLag = 0;
  private warp = 1;
  private cam = { x: 0, y: 0, half: 30 };
  private debris: Debris[] = [];
  private path: [number, number][] = [];
  private pathT = 0;
  private rings: { t: number }[] = [];
  private boom: { x: number; y: number; t: number } | null = null;
  private engine: Drone | null = null;
  private ended = false;
  private endT = 0;
  private cards: { id: FailId; fresh: boolean; t: number }[] = [];
  private stars: { x: number; y: number; r: number }[] = [];
  private shake = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.discovered = new Set(storage.get<FailId[]>(FAIL_KEY, []));
    for (let i = 0; i < 160; i++) this.stars.push({ x: this.rng.next(), y: this.rng.next(), r: this.rng.range(0.4, 1.6) });
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', (p) => this.up(p));
    ctx.input.on('alt', (p) => { if (this.phase === 'hangar' && !this.albumOpen) this.removeAt(p.x, p.y); });
    ctx.input.onKey((code, e) => this.key(code, e));
  }

  captureKey(code: string): boolean { return code === 'Escape' && (this.albumOpen || this.cards.length > 0); }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 1 && l.index <= 9); lv = pool[seed % pool.length] ?? lv; }
    this.level = lv;
    this.def = lv.def;
    this.hist.clear();
    const saved = storage.get<Design | null>(`rocket-builder:design:${lv.id}`, null);
    this.design = this.demo ? structuredClone(this.def.solution) : saved && designErrors(saved).length === 0 ? saved : { rows: [['pod', '', '']] };
    this.albumOpen = false; this.cards = []; this.sel = null; this.drag = null;
    this.toHangar();
    this.idle = 0;
    if (this.demo) this.launch();
  }

  private toHangar(): void {
    this.phase = 'hangar'; this.phaseT = 0;
    this.flight = null; this.ap = null; this.debris = []; this.boom = null; this.rings = [];
    this.engine?.stop(); this.engine = null;
  }

  private save(): void { if (!this.demo) storage.set(`rocket-builder:design:${this.level.id}`, this.design); }

  // ---- input ---------------------------------------------------------------------------

  private key(code: string, e: KeyboardEvent): void {
    if (this.demo) return;
    this.idle = 0;
    if (this.cards.length) { if (code === 'Space' || code === 'Enter' || code === 'Escape') { e.preventDefault(); this.dismissCard(); } return; }
    if (this.albumOpen) { if (code === 'Escape' || code === 'KeyF') this.albumOpen = false; return; }
    if (this.phase === 'hangar') {
      const u = undoKey(code, e);
      if (u) { e.preventDefault(); this.button(u); return; }
      if ((e.ctrlKey || e.metaKey) && code === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
      if (code === 'Space' || code === 'Enter') { e.preventDefault(); this.button('launch'); }
      else if (code === 'KeyM') this.button('sym');
      else if (code === 'KeyF') this.button('album');
      return;
    }
    if (this.phase !== 'flight') return;
    const manual = () => { if (this.auto) { this.auto = false; this.say('Manual control. T hands back to the autopilot.', C.yellow); } };
    if (code === 'Space') { e.preventDefault(); this.pendStage = true; }
    else if (code === 'KeyP') this.pendChute = true;
    else if (code === 'KeyT') { this.auto = !this.auto; this.say(this.auto ? 'Autopilot on' : 'Manual control', C.cyan); }
    else if (code === 'KeyX') { manual(); this.manThrottle = 0; }
    else if (code === 'KeyZ') { manual(); this.manThrottle = 1; }
    else if (code === 'KeyW' || code === 'ShiftLeft') { manual(); this.manThrottle = Math.min(1, this.manThrottle + 0.1); }
    else if (code === 'KeyS' || code === 'ControlLeft') { manual(); this.manThrottle = Math.max(0, this.manThrottle - 0.1); }
    else if (code === 'KeyA' || code === 'KeyD' || code === 'ArrowLeft' || code === 'ArrowRight') manual();
    else if (code === 'KeyR') this.button('hangar');
  }

  private down(p: Pointer): void {
    if (this.demo) return;
    this.idle = 0;
    if (this.cards.length) { this.dismissCard(); return; }
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    if (this.albumOpen) { this.albumOpen = false; return; }
    if (this.phase !== 'hangar') return;
    const c = this.cat.find((t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h);
    if (c) {
      this.drag = { kind: c.kind, id: p.id, x: p.x, y: p.y, moved: false, before: JSON.stringify(this.design), fromRocket: false, sx: p.x, sy: p.y };
      return;
    }
    const hit = this.partAt(p.x, p.y);
    if (hit) {
      // Pick the part up off the rocket.
      const before = JSON.stringify(this.design);
      const kind = this.takePart(hit);
      this.drag = { kind, id: p.id, x: p.x, y: p.y, moved: false, before, fromRocket: true, sx: p.x, sy: p.y };
      this.ctx.audio.tick(900, 0.05);
      return;
    }
    if (this.sel) { this.place(this.sel, p.x, p.y, JSON.stringify(this.design)); }
  }

  private move(p: Pointer): void {
    const d = this.drag;
    if (!d || d.id !== p.id || !p.down) return;
    d.x = p.x; d.y = p.y;
    if (Math.hypot(p.x - d.sx, p.y - d.sy) > 8) d.moved = true;
  }

  private up(p: Pointer): void {
    this.pressBtn = null;
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    this.drag = null;
    if (!d.fromRocket && !d.moved) {
      // Tap a catalogue part: select it, then tap the rocket to place.
      this.sel = this.sel === d.kind ? null : d.kind;
      this.ctx.audio.tick(1500, 0.05);
      return;
    }
    if (d.fromRocket && !d.moved) {
      // A tap on a placed part removes it.
      this.commit(d.before);
      this.ctx.audio.pop(260, 0.14);
      return;
    }
    if (!this.place(d.kind, d.x, d.y, d.before)) {
      if (d.fromRocket) { this.commit(d.before); this.ctx.audio.whoosh(0.1, 0.18); }
    }
  }

  private commit(before: string): void {
    if (JSON.stringify(this.design) === before) return;
    this.hist.push(before);
    this.save();
  }

  // ---- building ----------------------------------------------------------------------------

  /** Rocket parts on screen (hangar). */
  private partRects(): { row: number; side: -1 | 0 | 1; kind: PartKind; x: number; y: number; w: number; h: number }[] {
    return layout(this.design).map((p) => ({ row: p.row, side: p.side, kind: p.kind, x: this.rox + (p.x - p.w / 2) * this.rs, y: this.roy - (p.y + p.h / 2) * this.rs, w: p.w * this.rs, h: p.h * this.rs }));
  }

  private partAt(x: number, y: number): { row: number; side: -1 | 0 | 1 } | null {
    const rects = this.partRects();
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { row: r.row, side: r.side };
    }
    return null;
  }

  private takePart(h: { row: number; side: -1 | 0 | 1 }): PartKind {
    const row = this.design.rows[h.row];
    if (h.side === 0) {
      this.design.rows.splice(h.row, 1);
      return row[0];
    }
    const kind = row[h.side < 0 ? 1 : 2] as PartKind;
    if (this.sym && row[1] === row[2]) { row[1] = ''; row[2] = ''; } else row[h.side < 0 ? 1 : 2] = '';
    return kind;
  }

  private target(kind: PartKind, x: number, y: number): Target | null {
    const rects = this.partRects().filter((r) => r.side === 0);
    const axis = this.rox;
    if (Math.abs(x - axis) > this.rs * 4 + 40) return null;
    if (PARTS[kind].side) {
      let best: Target | null = null, bd = Infinity;
      for (const r of rects) {
        if (!sideOk(r.kind, kind)) continue;
        const d = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0;
        if (d < bd && d < 30) { bd = d; best = { kind: 'side', row: r.row, side: x < axis ? -1 : 1 }; }
      }
      return best;
    }
    if (this.design.rows.length >= MAX_ROWS) return null;
    if (!rects.length) return { kind: 'center', index: 0 };
    let index = rects.length;
    for (let i = 0; i < rects.length; i++) if (y < rects[i].y + rects[i].h / 2) { index = i; break; }
    if (y < rects[0].y - this.rs * 4 - 30 || y > rects[rects.length - 1].y + rects[rects.length - 1].h + this.rs * 8 + 60) return null;
    return { kind: 'center', index };
  }

  private place(kind: PartKind, x: number, y: number, before: string): boolean {
    if (!this.def.parts.includes(kind)) return false;
    const t = this.target(kind, x, y);
    if (!t) return false;
    if (t.kind === 'center') this.design.rows.splice(t.index, 0, [kind, '', ''] as Row);
    else {
      const row = this.design.rows[t.row];
      row[t.side < 0 ? 1 : 2] = kind;
      if (this.sym) row[t.side < 0 ? 2 : 1] = kind;
    }
    this.commit(before);
    const a = this.ctx.audio;
    a.thud(0.25); a.tone({ f: 1100, f2: 900, type: 'square', a: 0.001, d: 0.05, g: 0.04, lp: 2500 });
    return true;
  }

  private removeAt(x: number, y: number): void {
    const h = this.partAt(x, y);
    if (!h) return;
    const before = JSON.stringify(this.design);
    this.takePart(h);
    this.commit(before);
    this.ctx.audio.pop(260, 0.14);
  }

  private duplicate(): void {
    const hv = this.ctx.input.hover;
    const h = this.partAt(hv.x, hv.y);
    if (!h || this.design.rows.length >= MAX_ROWS) return;
    const before = JSON.stringify(this.design);
    const row = this.design.rows[h.row];
    if (row[0] === 'pod') { this.say('Only one Bob per rocket', C.pink); return; }
    this.design.rows.splice(h.row + 1, 0, [...row] as Row);
    this.commit(before);
    this.ctx.audio.tick(1300, 0.06);
  }

  private say(text: string, color: string, t = 2): void { this.banner = { text, t, color }; }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'undo' || id === 'redo') {
      if (this.phase !== 'hangar') return;
      const s = id === 'undo' ? this.hist.undo(this.design) : this.hist.redo(this.design);
      if (!s) { a.buzz(); return; }
      this.design = s; this.save(); a.tick(1300, 0.06);
    } else if (id === 'clear') {
      if (this.phase !== 'hangar' || this.design.rows.length <= 1) return;
      this.hist.push(this.design); this.design = { rows: [['pod', '', '']] }; this.save(); a.whoosh(0.12, 0.2);
    } else if (id === 'sym') {
      this.sym = !this.sym; a.tick(this.sym ? 1700 : 1100, 0.06);
    } else if (id === 'album') {
      this.albumOpen = !this.albumOpen; a.ui();
    } else if (id === 'launch') {
      if (this.phase !== 'hangar') return;
      const errs = designErrors(this.design);
      if (errs.length) { this.say(errs[0], C.pink); a.buzz(); return; }
      if (designCost(this.design) > this.def.budget) this.say('Over budget: this flight won\'t count for the mission', C.yellow, 2.4);
      this.launch();
    } else if (id === 'hangar') {
      if (this.phase === 'flight') this.endFlight(true);
    } else if (id === 'stage') this.pendStage = true;
    else if (id === 'chute') this.pendChute = true;
    else if (id === 'auto') { this.auto = !this.auto; a.tick(this.auto ? 1700 : 1100, 0.06); }
  }

  // ---- flight ------------------------------------------------------------------------------

  private launch(): void {
    this.flight = new Flight(this.design, this.def.goal);
    this.ap = new FlightComputer(this.def.goal);
    this.auto = true; this.manThrottle = 1;
    this.pendStage = false; this.pendChute = false;
    this.phase = 'flight'; this.phaseT = 0;
    this.countdown = this.demo ? 0.6 : 2.4;
    this.simLag = 0; this.warp = 1; this.ended = false; this.endT = 0;
    this.debris = []; this.rings = []; this.boom = null; this.path = [];
    this.cam = { x: this.flight.x, y: this.flight.y, half: this.closeHalf(this.flight) };
    if (!this.demo) [0, 0.8, 1.6].forEach((t, i) => this.ctx.audio.tone({ f: i === 2 ? 1320 : 880, type: 'sine', a: 0.002, d: 0.12, g: 0.08, at: t }));
  }

  private manualControl(f: Flight): Control {
    const k = this.ctx.input;
    const left = k.isDown('KeyA', 'ArrowLeft') || this.pressBtn === 'left', right = k.isDown('KeyD', 'ArrowRight') || this.pressBtn === 'right';
    return { ...IDLE, turn: left === right ? null : left ? -1 : 1, throttle: f.launched ? this.manThrottle : 0, maxDt: this.manThrottle > 0 ? 1 / 60 : 10 };
  }

  update(dt: number): void {
    this.clock += dt; this.idle += dt; this.phaseT += dt;
    if (this.banner && (this.banner.t -= dt) <= 0) this.banner = null;
    for (const c of this.cards) c.t += dt;
    if (this.phase === 'flight' && this.flight) this.flightTick(dt);
    this.debrisTick(dt);
    if (this.flight && this.phase !== 'hangar') this.flightFx(this.flight, dt);
    if (this.returnAt !== Infinity && this.phase === 'result' && this.phaseT > this.returnAt && !this.cards.length) { this.returnAt = Infinity; this.toHangar(); }
    if (this.demo && this.phase === 'result' && this.phaseT > 1.5) {
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.start(this.seed, { demo: true });
    }
  }

  /** Real seconds per sim second: real time when it matters, fast while coasting. */
  private warpFor(f: Flight): number {
    if (f.state !== 'flight') return 1;
    if (f.thrustNow > 0) return 1;
    if (f.chute === 'open') return f.dt > 0.1 ? 12 : 2;
    if (density(f.alt) > 0) return f.alt > 3000 ? 4 : 1;
    if (f.moonAlt < 3000 || f.alt < 3000) return 1;
    const [rx, ry, vx, vy] = f.moonRel();
    const k = Math.min(Math.hypot(f.x, f.y) / Math.max(1, f.speed), Math.hypot(rx, ry) / Math.max(1, Math.hypot(vx, vy)));
    return Math.max(8, Math.min(400, k * 0.15));
  }

  private flightTick(dt: number): void {
    const f = this.flight!;
    if (this.countdown > 0) { this.countdown -= dt; if (this.countdown > 0) return; }
    this.warp = this.warpFor(f);
    this.simLag += dt * this.warp;
    const t0 = f.t;
    let n = 0;
    while (!f.over && !this.ended && f.t - t0 < this.simLag && n < 600) {
      let c = this.auto ? this.ap!.control(f) : this.manualControl(f);
      if (this.pendStage || this.pendChute) { c = { ...c, stage: c.stage || this.pendStage, chute: c.chute || this.pendChute }; this.pendStage = false; this.pendChute = false; }
      f.step(c);
      n++;
      for (const e of f.events) this.onEvent(f, e);
      f.events.length = 0;
      if (this.auto && this.ap!.done && (f.state === 'landed' || f.t - this.ap!.since > 3)) { this.endFlight(false); break; }
      if (!this.auto && f.state === 'landed' && f.landings > 0 && f.thrustNow === 0 && f.t > 5) { this.endT += f.dt; if (this.endT > 2) { this.endFlight(false); break; } }
    }
    this.simLag = Math.max(0, this.simLag - (f.t - t0));
    if (this.simLag > 1) this.simLag = 1;
    if (f.over && !this.ended) this.endFlight(false);
  }

  private onEvent(f: Flight, e: FlightEvent): void {
    const a = this.ctx.audio;
    const fx = this.ctx.fx;
    switch (e.kind) {
      case 'ignite':
        if (!this.engine && !this.ctx.preview) this.engine = a.drone('noise', 300);
        fx.camera.shake(0.5);
        a.tone({ f: 60, f2: 40, type: 'sawtooth', a: 0.05, d: 1.2, g: 0.2, lp: 300 });
        break;
      case 'stage':
        this.debris.push({ parts: e.parts, x: e.x, y: e.y, vx: e.vx, vy: e.vy, ang: e.ang, w: e.w + this.rng.range(-0.4, 0.4), cx: e.cx, cy: e.cy, t: 0 });
        a.thud(0.6); a.tone({ f: 420, f2: 260, type: 'square', a: 0.001, d: 0.12, g: 0.08, lp: 1800 });
        break;
      case 'sonic':
        this.rings.push({ t: 0 });
        a.noise({ d: 0.5, g: 0.3, f: 300, f2: 60, type: 'lowpass' }); fx.camera.shake(0.35);
        break;
      case 'chute': a.whoosh(0.2, 0.4); a.pop(500, 0.15); break;
      case 'torn': a.noise({ d: 0.35, g: 0.25, f: 4000, f2: 1500, type: 'bandpass', q: 1.2 }); break;
      case 'bounce': a.tone({ f: 160, f2: 420, type: 'sine', a: 0.005, d: 0.25, g: Math.min(0.25, e.speed / 40) }); fx.camera.shake(Math.min(0.4, e.speed / 40)); break;
      case 'boom': {
        this.boom = { x: e.x, y: e.y, t: 0 };
        a.shatter(); a.thud(1); a.noise({ d: 1.4, g: 0.35, f: 900, f2: 80, type: 'lowpass' });
        fx.camera.shake(0.9);
        if (this.ctx.settings.motion) fx.time.slowMo(0.4, 500);
        // Every part flies off.
        const groups = new Map<number, LivePart[]>();
        for (const p of f.parts) groups.set(p.row, [...(groups.get(p.row) ?? []), p]);
        for (const parts of groups.values()) {
          const ang = this.rng.range(0, Math.PI * 2), sp = this.rng.range(8, 30);
          this.debris.push({ parts, x: f.x, y: f.y, vx: (f.body === 'moon' ? moonAt(f.t)[2] : 0) + Math.cos(ang) * sp, vy: (f.body === 'moon' ? moonAt(f.t)[3] : 0) + Math.abs(Math.sin(ang)) * sp, ang: f.ang, w: this.rng.range(-4, 4), cx: f.cx, cy: f.cy, t: 0 });
        }
        f.parts = [];
        break;
      }
      case 'land':
        a.thud(0.7);
        if (e.gentle) a.chime(4, 0.15);
        fx.camera.shake(Math.min(0.5, e.speed / 20));
        break;
      case 'dry': [0, 0.15, 0.3].forEach((t) => a.tone({ f: 180, f2: 90, type: 'sawtooth', a: 0.005, d: 0.08, g: 0.08, lp: 900, at: t })); break;
      case 'fail': {
        const fresh = !this.discovered.has(e.id);
        if (fresh && !this.demo) { this.discovered.add(e.id); storage.set(FAIL_KEY, [...this.discovered]); }
        if (!this.demo) this.cards.push({ id: e.id, fresh, t: -0.8 });
        break;
      }
    }
  }

  private endFlight(abort: boolean): void {
    const f = this.flight!;
    this.ended = true;
    this.phase = 'result'; this.phaseT = 0;
    this.engine?.stop(); this.engine = null;
    if (this.demo) return;
    const ok = f.goalMet() && f.cost <= this.def.budget && !abort;
    const met: [boolean, boolean, boolean] = [ok, ok && f.cost <= this.def.budget * 0.8, ok && f.cost <= this.def.budget * 0.8 && f.state === 'landed' && f.gentle];
    if (ok) {
      const a = this.ctx.audio;
      [0, 4, 7, 12, 16].forEach((n, i) => a.tone({ f: midiHz(67 + n), type: 'triangle', a: 0.004, d: 0.6, g: 0.09, at: 0.2 + i * 0.1 }));
      const where = f.state === 'landed' ? (f.body === 'moon' ? 'Moon' : 'Earth') : f.state === 'destroyed' ? 'parachuting home' : 'still up there';
      this.pendingFinish = () => finishLevel(this.ctx, pack, this.level, 'Rocket Builder', {
        goals: [goalText(this.def), `Spend at most $${Math.floor(this.def.budget * 0.8)}`, 'Bob lands gently'],
        met,
        stats: [
          { label: 'cost', value: `$${f.cost} / $${this.def.budget}` },
          { label: 'max altitude', value: fmtDist(f.maxAlt) },
          { label: 'Bob is', value: where },
        ],
        delayMs: 600,
      });
      if (!this.cards.length) { this.pendingFinish(); this.pendingFinish = null; }
    } else if (!abort) {
      const why = f.state === 'destroyed' ? 'Kaboom. Bob is fine - he popped out with his tiny parachute.' : f.state === 'stuck' ? "It didn't go anywhere." : f.state === 'escaped' ? 'Bob is on a very long trip.' : f.cost > this.def.budget ? 'Over budget - trim some parts.' : 'Mission not complete yet.';
      this.say(why, C.pink, 3);
    }
    this.returnAt = ok ? Infinity : abort ? 0.01 : 2.6;
  }
  private pendingFinish: (() => void) | null = null;
  private returnAt = Infinity;

  private dismissCard(): void {
    this.cards.shift();
    this.ctx.audio.tick(1200, 0.05);
    if (!this.cards.length && this.pendingFinish) { this.pendingFinish(); this.pendingFinish = null; }
  }

  private flightFx(f: Flight, dt: number): void {
    // Engine sound follows thrust and air.
    const rho = density(f.alt);
    this.engine?.set(200 + f.thrustNow / 2000, f.thrustNow > 0 ? Math.min(0.12, 0.03 + f.thrustNow / 2e6) * (0.3 + 0.7 * Math.min(1, rho / 0.3 + 0.2)) : 0, 0.08);
    if (f.thrustNow > 0 && f.alt < 3000) this.shake = Math.max(this.shake, 0.06 * (1 - f.alt / 3000));
    if (this.shake > 0) { this.ctx.fx.camera.shake(this.shake * dt * 6); this.shake *= 0.97; }
    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < 1);
    if (this.boom) this.boom.t += dt;
    // Camera: follow, zoom with altitude/speed.
    const near = Math.min(f.alt, f.moonAlt);
    const close = this.closeHalf(f);
    // Stay close while low (to watch the chute and the landing), pull right back in space.
    const zoomK = 0.3 + 0.8 * Math.min(1, near / 60_000);
    const wantHalf = Math.max(close, Math.min(4e6, close + near * zoomK + (f.state === 'flight' ? f.speed * 0.2 : 0)));
    const k = Math.min(1, dt * 2.5);
    this.cam.half = Math.exp(Math.log(this.cam.half) + (Math.log(wantHalf) - Math.log(this.cam.half)) * k);
    const tx = this.boom ? this.boom.x : f.x, ty = this.boom ? this.boom.y : f.y;
    this.cam.x += (tx - this.cam.x) * Math.min(1, dt * 8); this.cam.y += (ty - this.cam.y) * Math.min(1, dt * 8);
    if (Math.hypot(tx - this.cam.x, ty - this.cam.y) > this.cam.half) { this.cam.x = tx; this.cam.y = ty; }
    // Minimap path.
    this.pathT -= dt;
    if (this.pathT <= 0 && f.state === 'flight' && f.alt > 20_000) {
      this.pathT = 0.5;
      const far = Math.hypot(f.x, f.y) > 3 * R_E || f.goal.kind.startsWith('moon');
      this.path = predictPath(f.x, f.y, f.vx, f.vy, f.t, far ? 40_000 : 8_000);
    }
    // Flames and smoke.
    if (f.thrustNow > 0 && this.warp < 5 && !this.ctx.preview) this.flames(f);
  }

  private flames(f: Flight): void {
    const s = this.scale();
    const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
    const rho = density(f.alt);
    const pt = this.ctx.fx.particles;
    for (const p of f.activeEngines()) {
      if (p.kind === 'booster' ? p.fuel <= 0 : f.secFuel(f.bottomSec) <= 0 || f.throttle <= 0) continue;
      const lx = p.x - f.cx, ly = p.y - p.h / 2 - f.cy;
      const wx = f.x + lx * sa + ly * ca, wy = f.y - lx * ca + ly * sa;
      const [px, py] = this.toScreen(wx, wy);
      // Exhaust leaves along -nose; in screen space y flips.
      const ex = -ca, ey = sa;
      const big = PARTS[p.kind].thrust > 100e3 ? 1.5 : 1;
      const sz = Math.max(3, Math.min(14, s * 0.9 * big));
      for (let k = 0; k < 3; k++) {
        const sp = this.rng.range(160, 260);
        pt.spawn(px, py, ex * sp + this.rng.range(-25, 25), ey * sp + this.rng.range(-25, 25), 0.25, sz, sz * 0.3, k ? C.yellow : '#FFF4C0', Shape.Glow, 0, 2);
      }
      if (rho > 0.02 && this.rng.chance(0.7)) pt.spawn(px, py, ex * 60 + this.rng.range(-30, 30), ey * 60 + this.rng.range(-30, 30), 2.4, sz * 1.2, sz * 4, rgba('#B9B4AE', Math.min(0.5, rho)), Shape.Dot, -10, 0.8);
    }
  }

  private debrisTick(dt: number): void {
    if (!this.flight) return;
    const f = this.flight;
    const sim = Math.min(this.warp, 50) * dt;
    for (const d of this.debris) {
      d.t += dt;
      const [gx, gy] = gravity(d.x, d.y, f.t);
      d.vx += gx * sim; d.vy += gy * sim;
      const rho = density(Math.hypot(d.x, d.y) - R_E);
      if (rho > 0) { const k = 1 / (1 + 0.004 * rho * Math.hypot(d.vx, d.vy) * sim); d.vx *= k; d.vy *= k; }
      d.x += d.vx * sim; d.y += d.vy * sim; d.ang += d.w * sim;
      const r = Math.hypot(d.x, d.y);
      if (r < R_E) { d.x *= R_E / r; d.y *= R_E / r; d.vx = 0; d.vy = 0; d.w *= 0.5; }
      const [mx, my, mvx, mvy] = moonAt(f.t);
      const dm = Math.hypot(d.x - mx, d.y - my);
      if (dm < R_M) { d.x = mx + ((d.x - mx) * R_M) / dm; d.y = my + ((d.y - my) * R_M) / dm; d.vx = mvx; d.vy = mvy; d.w *= 0.5; }
    }
    this.debris = this.debris.filter((d) => d.t < 40);
  }

  pause(): void { this.engine?.set(0, 0, 0.05); }
  resume(): void {}
  destroy(): void { this.engine?.stop(); }

  debugInfo(): Record<string, number | string> {
    const f = this.flight;
    return { level: this.level.id, phase: this.phase, ap: this.ap?.phase ?? '-', alt: f ? Math.round(f.alt) : 0, t: f ? Math.round(f.t) : 0, warp: Math.round(this.warp), cost: designCost(this.design) };
  }

  // ---- render --------------------------------------------------------------------------------

  /** Camera half-height (m) that frames the rocket on the pad. */
  private closeHalf(f: Flight): number {
    if (!f.parts.length) return 14;
    return Math.max(9, (Math.max(...f.parts.map((p) => p.y + p.h / 2)) - Math.min(...f.parts.map((p) => p.y - p.h / 2))) * 0.9);
  }

  private scale(): number { return this.ctx.canvas.h / 2 / this.cam.half; }
  private toScreen(x: number, y: number): [number, number] {
    const s = this.scale();
    return [this.ctx.canvas.w / 2 + (x - this.cam.x) * s, this.ctx.canvas.h / 2 - (y - this.cam.y) * s];
  }

  render(): void {
    const g = this.ctx.canvas.begin('#0E0F1A');
    if (this.phase === 'hangar') this.renderHangar(g);
    else this.renderFlight(g);
    if (this.albumOpen) this.renderAlbum(g);
    if (this.cards.length && !this.demo) this.renderCard(g);
  }

  // ---- hangar ----

  private layoutHangar(): void {
    const { w, h } = this.ctx.canvas;
    const portrait = w < 720;
    const kinds = this.def.parts;
    if (portrait) {
      const cols = Math.ceil(kinds.length / 2), tw = Math.min(64, (w - 24 - (cols - 1) * 6) / cols);
      this.cat = kinds.map((k, i) => ({ kind: k, x: 12 + (i % cols) * (tw + 6), y: h - 2 * (tw + 6) - 6 + Math.floor(i / cols) * (tw + 6), w: tw, h: tw }));
    } else {
      const tw = 72;
      this.cat = kinds.map((k, i) => ({ kind: k, x: 14 + (i % 2) * (tw + 8), y: 70 + Math.floor(i / 2) * (tw + 8), w: tw, h: tw }));
    }
    // Rocket area.
    const parts = layout(this.design);
    const top = Math.max(0, ...parts.map((p) => p.y + p.h / 2)), bottom = Math.min(0, ...parts.map((p) => p.y - p.h / 2));
    const height = Math.max(6, top - bottom + 4);
    const areaTop = portrait ? 150 : 70, areaBottom = portrait ? h - 2 * 70 - 80 : h - 30;
    this.rs = Math.min(30, (areaBottom - areaTop) / height);
    this.rox = portrait ? w / 2 : 14 + 2 * 80 + (w - 14 - 2 * 80 - 260) / 2;
    this.roy = areaTop + ((areaBottom - areaTop) - (top - bottom) * this.rs) / 2 + top * this.rs;
    // Buttons.
    const bs = 44, gap = 8, right = w - 64;
    this.btns = [
      { id: 'undo', icon: 'undo', x: right - 3 * bs - 2 * gap, y: 12, w: bs, h: bs, enabled: this.hist.canUndo },
      { id: 'redo', icon: 'redo', x: right - 2 * bs - gap, y: 12, w: bs, h: bs, enabled: this.hist.canRedo },
      { id: 'clear', icon: 'trash', x: right - bs, y: 12, w: bs, h: bs, enabled: this.design.rows.length > 1 },
    ];
    const lw = portrait ? (w - 36) / 3 : 240;
    const ly = portrait ? h - 2 * 70 - 64 : h - 76;
    const lx = portrait ? 12 : w - 252;
    this.btns.push({ id: 'album', label: `Fails ${this.discovered.size}/14`, x: lx, y: portrait ? ly : ly - 104, w: portrait ? lw : 116, h: 46, enabled: true, hint: 'F' });
    this.btns.push({ id: 'sym', label: this.sym ? 'Mirror: on' : 'Mirror: off', x: portrait ? lx + lw + 6 : lx + 124, y: portrait ? ly : ly - 104, w: portrait ? lw : 116, h: 46, enabled: true, active: this.sym, hint: 'M' });
    this.btns.push({ id: 'launch', icon: 'play', label: 'Launch', x: portrait ? lx + 2 * (lw + 6) : lx, y: ly, w: portrait ? lw : 240, h: portrait ? 46 : 60, enabled: true, primary: true, hint: 'Space' });
  }

  private renderHangar(g: CanvasRenderingContext2D): void {
    const { w, h } = this.ctx.canvas;
    this.layoutHangar();
    // Hangar backdrop: blueprint grid.
    g.fillStyle = '#121A2E'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(120,160,255,0.07)'; g.lineWidth = 1;
    g.beginPath();
    for (let x = this.rox % this.rs; x < w; x += this.rs) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = this.roy % this.rs; y < h; y += this.rs) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    // Rocket.
    const parts = layout(this.design);
    const bottom = Math.min(0, ...parts.map((p) => p.y - p.h / 2));
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(this.rox - this.rs * 3, this.roy - bottom * this.rs, this.rs * 6, 4);
    drawRocket(g, parts, this.rox, this.roy, this.rs);
    // Hover highlight / drop target.
    const hv = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const d = this.drag;
    const placing = d && (d.moved || d.fromRocket) ? d.kind : this.sel;
    const px = d ? d.x : hv?.x ?? -1, py = d ? d.y : hv?.y ?? -1;
    if (placing && px >= 0) {
      const t = this.target(placing, px, py);
      const rects = this.partRects().filter((r) => r.side === 0);
      if (t?.kind === 'center') {
        const y = rects.length === 0 ? this.roy : t.index < rects.length ? rects[t.index].y : rects[rects.length - 1].y + rects[rects.length - 1].h;
        g.fillStyle = ACCENT; g.fillRect(this.rox - this.rs * 1.2, y - 2, this.rs * 2.4, 4);
      } else if (t?.kind === 'side') {
        const r = rects.find((q) => q.row === t.row)!;
        for (const sd of this.sym ? [-1, 1] : [t.side]) {
          const P = PARTS[placing];
          const x = this.rox + sd * (PARTS.pod.w / 2 + P.w / 2) * this.rs;
          g.strokeStyle = ACCENT; g.lineWidth = 2; g.setLineDash([4, 4]);
          g.strokeRect(x - (P.w * this.rs) / 2, r.y, P.w * this.rs, r.h); g.setLineDash([]);
        }
      }
    } else if (hv && !d) {
      const hit = this.partAt(hv.x, hv.y);
      if (hit) {
        const r = this.partRects().find((q) => q.row === hit.row && q.side === hit.side)!;
        g.strokeStyle = rgba(C.text, 0.5); g.lineWidth = 1.5; g.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
      }
    }
    // Level 1 hint: ghost tank + engine under the pod when it's all alone.
    if (this.level.id === '1-1' && this.design.rows.length === 1 && this.idle > 3) {
      g.globalAlpha = 0.25 + 0.2 * Math.sin(this.clock * 4);
      const podBottom = this.roy + PARTS.pod.h * this.rs;
      drawPart(g, 'tankS', this.rox, podBottom + (PARTS.tankS.h * this.rs) / 2, this.rs);
      drawPart(g, 'engineS', this.rox, podBottom + PARTS.tankS.h * this.rs + (PARTS.engineS.h * this.rs) / 2, this.rs);
      g.globalAlpha = 1;
    }
    // Catalogue.
    for (const c of this.cat) {
      const on = this.sel === c.kind;
      roundRect(g, c.x, c.y, c.w, c.h, 10); g.fillStyle = on ? rgba(ACCENT, 0.22) : C.surface; g.fill();
      if (on) { g.strokeStyle = ACCENT; g.lineWidth = 2; g.stroke(); }
      const P = PARTS[c.kind];
      const s = Math.min((c.w * 0.62) / Math.max(P.w, 1.25), (c.h * 0.5) / P.h);
      drawPart(g, c.kind, c.x + c.w / 2, c.y + c.h * 0.4, s, c.kind === 'fins' || c.kind === 'legs' ? 1 : 0);
      g.fillStyle = C.muted; g.font = `600 ${c.w < 66 ? 9 : 10}px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.fillText(fitText(g, P.name.replace('Fuel tank', 'Tank'), c.w - 6), c.x + c.w / 2, c.y + c.h - 15);
      g.fillStyle = C.text; g.font = `700 ${c.w < 66 ? 10 : 11}px ${FONT.ui}`;
      g.fillText(`$${P.cost}`, c.x + c.w / 2, c.y + c.h - 4);
    }
    // Dragged part follows the pointer.
    if (d && (d.moved || d.fromRocket)) drawPart(g, d.kind, d.x, d.y, this.rs, PARTS[d.kind].side ? (d.x < this.rox ? -1 : 1) : 0, true);
    this.drawStats(g);
    this.drawTop(g);
  }

  private drawTop(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const room = titleRoom(this.btns.filter((b) => b.y < 60), w - 64) - 16;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    g.fillText(fitText(g, `${this.level.chapter} ${this.level.n} · ${this.def.name}`, room), 16, 30);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`;
    g.fillText(fitText(g, `${goalText(this.def)} · budget $${this.def.budget}`, room), 16, 50);
    for (const b of this.btns) drawBtn(g, b, ACCENT, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    if (this.banner) {
      const b = this.banner;
      g.globalAlpha = Math.min(1, b.t * 3);
      g.font = `700 18px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = Math.min(w - 20, g.measureText(b.text).width + 36);
      roundRect(g, w / 2 - tw / 2, 74, tw, 44, 22); g.fillStyle = 'rgba(14,15,26,0.92)'; g.fill();
      g.fillStyle = b.color; g.fillText(fitText(g, b.text, tw - 24), w / 2, 97);
      g.globalAlpha = 1;
    }
  }

  private drawStats(g: CanvasRenderingContext2D): void {
    const { w, h } = this.ctx.canvas;
    const portrait = w < 720;
    const cost = designCost(this.design);
    const st = stageInfo(this.design);
    const mass = st.length ? st[0].mass : 0;
    const twr = st.length ? st[0].twr : 0;
    const dv = st.reduce((s, x) => s + x.dv, 0);
    const x = portrait ? 12 : w - 252, y = portrait ? 64 : 70, sw = portrait ? w - 24 : 240;
    if (!portrait) { roundRect(g, x - 8, y - 8, sw + 16, h - y - 190, 14); g.fillStyle = 'rgba(24,26,43,0.85)'; g.fill(); }
    drawBudget(g, x, y, sw, 22, cost, this.def.budget, `$${cost} / $${this.def.budget}`, cost <= this.def.budget * 0.8 ? C.green : ACCENT);
    g.fillStyle = rgba(C.text, 0.7); g.fillRect(x + sw * 0.8 - 1, y - 3, 2, 28);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    const line = (label: string, value: string, ly: number, col: string = C.text) => {
      g.fillStyle = C.muted; g.font = `600 12px ${FONT.ui}`; g.fillText(label, x, ly);
      g.fillStyle = col; g.font = `700 14px ${FONT.mono}`; g.textAlign = 'right'; g.fillText(value, x + sw, ly); g.textAlign = 'left';
    };
    if (portrait) {
      g.fillStyle = C.muted; g.font = `600 12px ${FONT.ui}`;
      g.fillText(`${(mass / 1000).toFixed(1)} t · Δv ${Math.round(dv)} m/s`, x, y + 42);
      g.fillStyle = twr > 1.2 ? C.green : C.pink; g.textAlign = 'right'; g.font = `700 13px ${FONT.mono}`;
      g.fillText(`TWR ${twr.toFixed(2)}`, x + sw, y + 42); g.textAlign = 'left';
      const errs = designErrors(this.design);
      if (errs.length) { g.fillStyle = C.pink; g.font = `600 12px ${FONT.ui}`; g.fillText(fitText(g, errs[0], sw), x, y + 62); }
      return;
    }
    line('Mass', `${(mass / 1000).toFixed(2)} t`, y + 50);
    line('Thrust / weight', twr.toFixed(2), y + 72, twr > 1.2 ? C.green : C.pink);
    line('Total Δv', `${Math.round(dv)} m/s`, y + 94);
    let ly = y + 122;
    g.fillStyle = C.muted; g.font = `700 11px ${FONT.ui}`; g.fillText('STAGES (first to fire on top)', x, ly); ly += 20;
    st.forEach((s, i) => {
      if (ly > h - 300) return;
      line(`${i + 1}. ${s.thrust ? `${Math.round(s.thrust / 1000)} kN` : 'no engine'}`, s.burn || s.dv ? `${Math.round(s.dv)} m/s · ${Math.round(s.burn)} s` : '—', ly, s.twr > 1.2 || i > 0 ? C.text : C.pink);
      ly += 20;
    });
    const errs = designErrors(this.design);
    g.font = `600 12px ${FONT.ui}`;
    for (const e of errs.slice(0, 2)) { g.fillStyle = C.pink; g.fillText(fitText(g, `• ${e}`, sw), x, ly + 8); ly += 18; }
  }

  // ---- flight ----

  private renderFlight(g: CanvasRenderingContext2D): void {
    const f = this.flight;
    if (!f) return;
    const { w, h } = this.ctx.canvas;
    const s = this.scale();
    const alt = Math.hypot(this.cam.x, this.cam.y) - R_E;
    // Sky: blue to black with altitude; stars come out.
    const k = Math.min(1, Math.max(0, alt / 45_000));
    const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
    const top = `rgb(${mix(70, 5)},${mix(150, 7)},${mix(230, 18)})`, bot = `rgb(${mix(150, 8)},${mix(210, 10)},${mix(250, 26)})`;
    const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, top); grad.addColorStop(1, bot);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const starA = Math.min(1, Math.max(0, (alt - 15_000) / 30_000));
    if (starA > 0) {
      g.fillStyle = `rgba(255,255,255,${starA})`;
      const ox = (Math.atan2(this.cam.y, this.cam.x) * 300) % w;
      for (const st of this.stars) g.fillRect(((st.x * w + ox) % w + w) % w, st.y * h, st.r, st.r);
    }
    const fx = this.ctx.fx;
    fx.camera.begin(g, w, h);
    this.drawBody(g, 0, 0, R_E, '#3E8E4C', '#2F6B3A', true);
    const [mx, my] = moonAt(f.t);
    this.drawBody(g, mx, my, R_M, '#9A9AA6', '#6E6E7A', false);
    // Launch pad.
    const [padX, padY] = this.toScreen(0, R_E);
    if (s > 0.5) {
      g.fillStyle = '#5A5F6E'; g.fillRect(padX - 8 * s, padY - 0.6 * s, 16 * s, 0.8 * s);
      g.strokeStyle = '#B04A3A'; g.lineWidth = Math.max(1, 0.25 * s);
      const tx = padX + 4 * s;
      g.beginPath(); g.moveTo(tx, padY); g.lineTo(tx, padY - 18 * s); g.moveTo(tx + 1.4 * s, padY); g.lineTo(tx + 1.4 * s, padY - 18 * s);
      for (let yy = 0; yy < 18; yy += 2) { g.moveTo(tx, padY - yy * s); g.lineTo(tx + 1.4 * s, padY - (yy + 2) * s); }
      g.stroke();
    }
    // Debris.
    for (const d of this.debris) this.drawParts(g, d.parts, d.x, d.y, d.ang, d.cx, d.cy);
    // Sonic boom rings.
    for (const r of this.rings) {
      const [rx, ry] = this.toScreen(f.x, f.y);
      g.strokeStyle = `rgba(255,255,255,${0.6 * (1 - r.t)})`; g.lineWidth = 3;
      g.beginPath(); g.ellipse(rx, ry, 20 + r.t * 160, 8 + r.t * 50, -(f.ang - Math.PI / 2), 0, Math.PI * 2); g.stroke();
    }
    // The rocket.
    if (f.parts.length) this.drawRocketFlight(g, f);
    fx.particles.render(g);
    if (this.boom) this.drawBoom(g);
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawFlightUi(g, f);
    if (this.countdown > 0 && !this.demo) {
      g.fillStyle = C.text; g.font = `800 72px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(Math.ceil(this.countdown / 0.8)), w / 2, h * 0.3);
    }
  }

  /** A planet or moon: a full disc when small on screen, else the visible arc as a polygon. */
  private drawBody(g: CanvasRenderingContext2D, bx: number, by: number, R: number, col: string, deep: string, earth: boolean): void {
    const { w, h } = this.ctx.canvas;
    const s = this.scale();
    const [cx, cy] = this.toScreen(bx, by);
    const dist = Math.hypot(this.cam.x - bx, this.cam.y - by);
    if (dist - R > this.cam.half * 3 + w / s) {
      if (R * s < 2) { g.fillStyle = col; g.beginPath(); g.arc(cx, cy, 2, 0, Math.PI * 2); g.fill(); return; }
    }
    if (earth && s * R < 4000) {
      // Atmosphere glow.
      const glow = g.createRadialGradient(cx, cy, R * s, cx, cy, (R + ATMO * 1.4) * s);
      glow.addColorStop(0, 'rgba(110,193,245,0.55)'); glow.addColorStop(1, 'rgba(110,193,245,0)');
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, (R + ATMO * 1.4) * s, 0, Math.PI * 2); g.fill();
    }
    if (R * s < 20000) {
      g.fillStyle = earth ? '#2F6FB5' : col; g.beginPath(); g.arc(cx, cy, R * s, 0, Math.PI * 2); g.fill();
      if (earth) { g.fillStyle = col; for (const [a, r] of [[1.3, 0.45], [2.6, 0.3], [4.2, 0.5], [5.5, 0.25]]) { g.beginPath(); g.arc(cx + Math.cos(a) * R * s * 0.5, cy - Math.sin(a) * R * s * 0.5, R * s * r, 0, Math.PI * 2); g.fill(); } }
      else { g.fillStyle = deep; for (const [a, r, d] of [[0.5, 0.18, 0.5], [2.2, 0.12, 0.6], [3.9, 0.22, 0.4], [5.1, 0.1, 0.7]]) { g.beginPath(); g.arc(cx + Math.cos(a) * R * s * d, cy - Math.sin(a) * R * s * d, R * s * r, 0, Math.PI * 2); g.fill(); } }
      return;
    }
    // Close up: sample the visible arc.
    const a0 = Math.atan2(this.cam.y - by, this.cam.x - bx);
    const span = Math.min(Math.PI, ((Math.hypot(w, h) / s) / R) * 1.2);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 48; i++) {
      const a = a0 - span + (2 * span * i) / 48;
      // A little terrain roughness near the surface.
      const bump = earth ? Math.sin(a * 900) * 6 + Math.sin(a * 2300) * 3 : Math.sin(a * 700) * 40 + Math.sin(a * 3100) * 12;
      pts.push(this.toScreen(bx + Math.cos(a) * (R + (Math.abs(a - Math.PI / 2) < 0.0002 && earth ? 0 : bump * 0)), by + Math.sin(a) * R));
    }
    const depth = Math.hypot(w, h) / s * 2;
    const inner: [number, number][] = [];
    for (let i = 48; i >= 0; i -= 6) { const a = a0 - span + (2 * span * i) / 48; inner.push(this.toScreen(bx + Math.cos(a) * (R - depth), by + Math.sin(a) * (R - depth))); }
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) g.lineTo(p[0], p[1]);
    for (const p of inner) g.lineTo(p[0], p[1]);
    g.closePath();
    // Green fields by the pad fade to ocean blue as the view widens.
    const kz = earth ? Math.min(1, Math.max(0, (this.cam.half - 3000) / 12000)) : 0;
    g.fillStyle = kz > 0 ? `rgb(${Math.round(62 - 15 * kz)},${Math.round(142 - 31 * kz)},${Math.round(76 + 105 * kz)})` : col; g.fill();
    g.strokeStyle = deep; g.lineWidth = Math.max(2, 1.2 * s); g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts) g.lineTo(p[0], p[1]); g.stroke();
  }

  private drawParts(g: CanvasRenderingContext2D, parts: readonly LivePart[], x: number, y: number, ang: number, cx: number, cy: number): void {
    const s = this.scale();
    const [sx, sy] = this.toScreen(x, y);
    if (s < 0.6) return;
    g.save(); g.translate(sx, sy); g.rotate(-(ang - Math.PI / 2));
    drawRocket(g, parts, -cx * s, cy * s, s);
    g.restore();
  }

  private drawRocketFlight(g: CanvasRenderingContext2D, f: Flight): void {
    const s = this.scale();
    const [sx, sy] = this.toScreen(f.x, f.y);
    const tall = Math.max(...f.parts.map((p) => p.y + p.h / 2)) - Math.min(...f.parts.map((p) => p.y - p.h / 2));
    if (tall * s < 34) {
      // Too small to see: an icon with a glow.
      drawGlow(g, f.thrustNow > 0 ? C.orange : C.cyan, sx, sy, 22, 0.5);
      miniRocket(g, sx, sy, 12, -f.ang);
      if (f.chute === 'open') {
        g.fillStyle = C.orange; g.beginPath(); g.arc(sx, sy - 18, 9, Math.PI, 0); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(sx - 8, sy - 18); g.lineTo(sx, sy - 6); g.lineTo(sx + 8, sy - 18); g.stroke();
      }
      return;
    }
    // Flame cone under each burning engine.
    g.save(); g.translate(sx, sy); g.rotate(-(f.ang - Math.PI / 2));
    for (const p of f.activeEngines()) {
      const burning = p.kind === 'booster' ? p.fuel > 0 : f.secFuel(f.bottomSec) > 0 && f.throttle > 0;
      if (!burning) continue;
      const ex = (p.x - f.cx) * s, ey = -(p.y - p.h / 2 - f.cy) * s;
      const len = (PARTS[p.kind].thrust > 100e3 ? 3.6 : 2.4) * s * (p.kind === 'booster' ? 1 : f.throttle) * (0.85 + 0.15 * Math.sin(this.clock * 40 + p.row));
      const vac = 1 - Math.min(1, density(f.alt) / 0.4);
      const wd = p.w * s * (0.3 + vac * 0.5);
      const gr = g.createLinearGradient(ex, ey, ex, ey + len);
      gr.addColorStop(0, '#FFFBE0'); gr.addColorStop(0.3, C.yellow); gr.addColorStop(1, 'rgba(255,120,40,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(ex - (p.w * s) / 3, ey); g.lineTo(ex + (p.w * s) / 3, ey); g.lineTo(ex + wd, ey + len); g.lineTo(ex - wd, ey + len); g.closePath(); g.fill();
    }
    // Parachute canopy above the top.
    if (f.chute === 'open' || f.chute === 'torn') {
      const topY = Math.max(...f.parts.map((p) => p.y + p.h / 2));
      const k = f.chute === 'open' ? Math.max(0.15, f.chuteK) : 0.5;
      const ty = -(topY - f.cy) * s, cyy = ty - 7 * k * s, rw = 6 * k * s;
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, ty); g.lineTo(-rw, cyy); g.moveTo(0, ty); g.lineTo(rw, cyy); g.moveTo(0, ty); g.lineTo(0, cyy - rw * 0.5); g.stroke();
      if (f.chute === 'open') {
        for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#FFFFFF' : C.orange; g.beginPath(); g.moveTo(0, cyy); g.arc(0, cyy, rw, Math.PI + (i * Math.PI) / 6, Math.PI + ((i + 1) * Math.PI) / 6); g.closePath(); g.fill(); }
      } else {
        g.fillStyle = C.orange;
        for (let i = 0; i < 4; i++) { const a = Math.PI + 0.3 + i * 0.7; g.beginPath(); g.moveTo(Math.cos(a) * rw * 0.3, cyy + Math.sin(a) * rw * 0.3); g.lineTo(Math.cos(a) * rw, cyy + Math.sin(a) * rw + Math.sin(this.clock * 20 + i) * 3); g.lineTo(Math.cos(a + 0.2) * rw, cyy + Math.sin(a + 0.2) * rw); g.fill(); }
      }
    }
    drawRocket(g, f.parts, -f.cx * s, f.cy * s, s);
    g.restore();
  }

  private drawBoom(g: CanvasRenderingContext2D): void {
    const b = this.boom!;
    const [sx, sy] = this.toScreen(b.x, b.y);
    const k = Math.min(1, b.t * 4);
    if (b.t < 2.2) {
      drawGlow(g, C.orange, sx, sy, 120 * k, Math.max(0, 0.9 - b.t * 0.4));
      g.save(); g.translate(sx, sy - 40); g.rotate(-0.12); g.scale(k * (1 + Math.sin(b.t * 12) * 0.03), k);
      g.font = `900 64px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 8; g.strokeStyle = '#3A1A0A'; g.strokeText('BOOM', 0, 0);
      g.fillStyle = C.yellow; g.fillText('BOOM', 0, 0);
      g.restore();
    }
    if (b.t > 0.5) {
      // Bob pops out with a tiny parachute and a thumbs-up.
      const t = b.t - 0.5;
      const bx = sx + 40, by = sy - 70 - Math.min(40, t * 80) + Math.max(0, t - 1) * 12;
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(bx - 9, by - 4); g.lineTo(bx - 12, by - 26); g.moveTo(bx + 9, by - 4); g.lineTo(bx + 12, by - 26); g.stroke();
      g.fillStyle = C.orange; g.beginPath(); g.arc(bx, by - 26, 14, Math.PI, 0); g.fill();
      drawPart(g, 'pod', bx, by + 6, 14);
      if (t > 0.6) {
        roundRect(g, bx + 18, by - 24, 86, 24, 10); g.fillStyle = '#FFFFFF'; g.fill();
        g.fillStyle = '#222'; g.font = `700 12px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText("I'm OK! 👍", bx + 61, by - 12);
      }
    }
  }

  private flightButtons(): void {
    const { w, h } = this.ctx.canvas;
    const bw = Math.min(110, (w - 40) / 4), bh = 48, y = h - bh - 12;
    this.btns = [
      { id: 'hangar', icon: 'build', label: w > 520 ? 'Hangar' : undefined, x: 12, y, w: bw, h: bh, enabled: true, hint: 'R' },
      { id: 'auto', label: this.auto ? 'Auto: on' : 'Auto: off', x: 12 + (bw + 8), y, w: bw, h: bh, enabled: true, active: this.auto, hint: 'T' },
      { id: 'chute', label: 'Chute', x: 12 + 2 * (bw + 8), y, w: bw, h: bh, enabled: this.flight?.chute === 'packed', hint: 'P' },
      { id: 'stage', label: 'Stage', x: 12 + 3 * (bw + 8), y, w: bw, h: bh, enabled: true, primary: true, hint: 'Space' },
    ];
  }

  private drawFlightUi(g: CanvasRenderingContext2D, f: Flight): void {
    const { w, h } = this.ctx.canvas;
    this.flightButtons();
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 18px ${FONT.title}`;
    g.fillText(fitText(g, this.def.name, w - 260), 16, 28);
    const met = f.goalMet();
    g.fillStyle = met ? C.green : C.muted; g.font = `600 13px ${FONT.ui}`;
    g.fillText(`${met ? '✓' : '○'} ${goalText(this.def)}`, 16, 48);
    // Readouts.
    const r = Math.hypot(f.x, f.y), vr = (f.x * f.vx + f.y * f.vy) / r;
    const rows: [string, string][] = [['ALT', fmtDist(f.alt)], ['SPEED', `${Math.round(f.speed)} m/s`], ['V-SPEED', `${vr >= 0 ? '+' : ''}${Math.round(vr)} m/s`]];
    if (f.alt > 2000 && f.state === 'flight') {
      const o = f.earthOrbit();
      rows.push(['APOAPSIS', o.apo === Infinity ? 'escape' : fmtDist(o.apo - R_E)], ['PERIAPSIS', fmtDist(o.peri - R_E)]);
    }
    if (f.moonAlt < 700_000) rows.push(['MOON ALT', fmtDist(f.moonAlt)]);
    rows.forEach(([k, v], i) => {
      g.fillStyle = C.muted; g.font = `700 10px ${FONT.ui}`; g.fillText(k, 16, 74 + i * 30);
      g.fillStyle = C.text; g.font = `700 16px ${FONT.mono}`; g.fillText(v, 16, 90 + i * 30);
    });
    // Fuel + throttle.
    const s = f.bottomSec;
    const tanks = f.parts.filter((p) => p.sec === s && p.kind.startsWith('tank'));
    const cap = tanks.reduce((a, p) => a + PARTS[p.kind].fuel, 0), fuel = f.secFuel(s);
    const bars: [string, number, string][] = [['FUEL', cap ? fuel / cap : 0, C.orange], ['THROTTLE', f.throttle, C.cyan]];
    const bs = f.boostersAttached();
    if (bs.length) bars.push(['BOOSTERS', bs.reduce((a, b) => a + b.fuel, 0) / (bs.length * PARTS.booster.fuel), C.yellow]);
    bars.forEach(([k, v, col], i) => {
      const y = 74 + rows.length * 30 + 10 + i * 26;
      g.fillStyle = C.muted; g.font = `700 10px ${FONT.ui}`; g.fillText(k, 16, y);
      roundRect(g, 16, y + 4, 120, 8, 4); g.fillStyle = C.surface2; g.fill();
      if (v > 0) { roundRect(g, 16, y + 4, Math.max(8, 120 * v), 8, 4); g.fillStyle = col; g.fill(); }
    });
    // Autopilot + warp.
    g.textAlign = 'center'; g.font = `700 13px ${FONT.ui}`;
    g.fillStyle = this.auto ? C.cyan : C.yellow;
    g.fillText(this.auto ? `Autopilot · ${this.ap!.label}` : 'Manual · A/D steer · W/S throttle · X cut', w / 2, h - 76);
    if (this.warp > 1.5) { g.fillStyle = C.muted; g.fillText(`time ×${Math.round(this.warp)}`, w / 2, h - 94); }
    this.drawMinimap(g, f);
    for (const b of this.btns) drawBtn(g, b, ACCENT, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    if (this.banner) {
      const b = this.banner;
      g.globalAlpha = Math.min(1, b.t * 3);
      g.font = `700 18px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = Math.min(w - 20, g.measureText(b.text).width + 36);
      roundRect(g, w / 2 - tw / 2, h * 0.18 - 22, tw, 44, 22); g.fillStyle = 'rgba(14,15,26,0.9)'; g.fill();
      g.fillStyle = b.color; g.fillText(fitText(g, b.text, tw - 24), w / 2, h * 0.18 + 1);
      g.globalAlpha = 1;
    }
  }

  private drawMinimap(g: CanvasRenderingContext2D, f: Flight): void {
    const { w } = this.ctx.canvas;
    const size = Math.min(170, w * 0.3), x0 = w - size - 12, y0 = 64;
    roundRect(g, x0, y0, size, size, 14); g.fillStyle = 'rgba(8,10,22,0.82)'; g.fill();
    g.save(); roundRect(g, x0, y0, size, size, 14); g.clip();
    const r = Math.hypot(f.x, f.y);
    const far = r > 4 * R_E || f.goal.kind.startsWith('moon');
    const view = far ? A_M * 1.15 : Math.max(1.5 * R_E, r * 1.25);
    const k = size / 2 / view, cx = x0 + size / 2, cy = y0 + size / 2;
    const P = (x: number, y: number): [number, number] => [cx + x * k, cy - y * k];
    g.fillStyle = '#2F6FB5'; g.beginPath(); g.arc(cx, cy, Math.max(2, R_E * k), 0, Math.PI * 2); g.fill();
    if (!far) { g.strokeStyle = 'rgba(110,193,245,0.4)'; g.beginPath(); g.arc(cx, cy, (R_E + ATMO) * k, 0, Math.PI * 2); g.stroke(); }
    const [mx, my] = moonAt(f.t);
    if (far) {
      g.strokeStyle = 'rgba(255,255,255,0.1)'; g.beginPath(); g.arc(cx, cy, A_M * k, 0, Math.PI * 2); g.stroke();
      const [px, py] = P(mx, my); g.fillStyle = '#B0B0BC'; g.beginPath(); g.arc(px, py, Math.max(2.5, R_M * k), 0, Math.PI * 2); g.fill();
    }
    if (this.path.length > 1) {
      g.strokeStyle = rgba(C.cyan, 0.8); g.lineWidth = 1.5; g.setLineDash([3, 3]);
      g.beginPath(); this.path.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke(); g.setLineDash([]);
    }
    const [sx, sy] = P(f.x, f.y);
    g.fillStyle = C.yellow; g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  // ---- album + cards ----

  private renderAlbum(g: CanvasRenderingContext2D): void {
    const { w, h } = this.ctx.canvas;
    g.fillStyle = 'rgba(8,9,18,0.94)'; g.fillRect(0, 0, w, h);
    g.fillStyle = C.text; g.font = `700 22px ${FONT.title}`; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(`Fail Album · ${this.discovered.size} / 14`, 16, 34);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`; g.fillText('Crash on purpose. Collect them all. Tap anywhere to close.', 16, 54);
    let best = { cols: 2, cw: 0, ch: 0, score: 0 };
    for (let cols = 2; cols <= 7; cols++) {
      const rows = Math.ceil(14 / cols);
      const cw = (w - 24 - (cols - 1) * 8) / cols, ch = (h - 76 - (rows - 1) * 8) / rows;
      const score = Math.min(cw, ch * 1.15);
      if (score > best.score) best = { cols, cw, ch: Math.min(ch, cw * 1.25), score };
    }
    FAILS.forEach((fl, i) => {
      const x = 12 + (i % best.cols) * (best.cw + 8), y = 68 + Math.floor(i / best.cols) * (best.ch + 8);
      const got = this.discovered.has(fl.id);
      roundRect(g, x, y, best.cw, best.ch, 12); g.fillStyle = C.surface; g.fill();
      const sceneH = best.ch * 0.58;
      g.save(); roundRect(g, x + 6, y + 6, best.cw - 12, sceneH, 8); g.clip();
      if (got) drawFailScene(g, fl.id, x + 6, y + 6, best.cw - 12, sceneH, this.clock);
      else { g.fillStyle = '#1C1F33'; g.fillRect(x + 6, y + 6, best.cw - 12, sceneH); g.fillStyle = C.muted; g.font = `800 ${Math.round(sceneH * 0.45)}px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', x + best.cw / 2, y + 6 + sceneH / 2); }
      g.restore();
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillStyle = got ? C.text : C.muted; g.font = `700 ${best.cw < 140 ? 12 : 14}px ${FONT.title}`;
      g.fillText(fitText(g, got ? fl.name : '???', best.cw - 16), x + 8, y + sceneH + 24);
      g.fillStyle = C.muted; g.font = `600 ${best.cw < 140 ? 10 : 11}px ${FONT.ui}`;
      wrap(g, got ? fl.caption : fl.hint, best.cw - 16).slice(0, 3).forEach((ln, j) => g.fillText(ln, x + 8, y + sceneH + 40 + j * 13));
    });
  }

  private renderCard(g: CanvasRenderingContext2D): void {
    const c = this.cards[0];
    if (c.t < 0) return;
    const { w, h } = this.ctx.canvas;
    const fl = FAILS.find((q) => q.id === c.id)!;
    const k = Math.min(1, c.t * 3);
    const cw = Math.min(380, w - 40), ch = Math.min(360, h - 80);
    const x = w / 2 - cw / 2, y = h / 2 - ch / 2 + (1 - k) * h * 0.6;
    g.fillStyle = `rgba(0,0,0,${0.5 * k})`; g.fillRect(0, 0, w, h);
    roundRect(g, x, y, cw, ch, 18); g.fillStyle = '#FFF8EC'; g.fill();
    g.save(); roundRect(g, x + 14, y + 14, cw - 28, ch * 0.5, 10); g.clip();
    drawFailScene(g, c.id, x + 14, y + 14, cw - 28, ch * 0.5, this.clock);
    g.restore();
    g.fillStyle = '#7A5A30'; g.font = `700 12px ${FONT.ui}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText('FAIL ALBUM', w / 2, y + ch * 0.5 + 38);
    g.fillStyle = '#2A1E10'; g.font = `800 24px ${FONT.title}`; g.fillText(fl.name, w / 2, y + ch * 0.5 + 66);
    g.fillStyle = '#4A3A28'; g.font = `600 15px ${FONT.ui}`;
    wrap(g, `"${fl.caption}"`, cw - 40).forEach((ln, i) => g.fillText(ln, w / 2, y + ch * 0.5 + 94 + i * 20));
    g.fillStyle = '#9A8A70'; g.font = `600 11px ${FONT.ui}`; g.fillText('tap to continue', w / 2, y + ch - 14);
    if (c.fresh && c.t > 0.35) {
      // NEW stamp thumps down.
      const sk = Math.max(1, 2.2 - (c.t - 0.35) * 8);
      if (c.t - 0.35 < 0.05) { this.ctx.audio.thud(0.6); this.ctx.audio.sparkle(); }
      g.save(); g.translate(x + cw - 70, y + 54); g.rotate(-0.25); g.scale(sk, sk);
      g.strokeStyle = C.pink; g.lineWidth = 4; roundRect(g, -48, -20, 96, 40, 8); g.stroke();
      g.fillStyle = C.pink; g.font = `900 22px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('NEW!', 0, 1);
      g.restore();
    }
  }
}

export default (): Game => new RocketBuilder();
