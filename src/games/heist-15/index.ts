import { drawBtn, fitText, hitBtn, InventoryBar, roundRect, titleRoom, type Btn, type InvItem } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import {
  BITS, camAngle, CAM_FOV, CAM_RANGE, expand, GUARD_FOV, GUARD_RANGE, H, Heist, laserOn, laserTiles, LIMIT, Patrol, Room, W,
  type HLevel, type ToolKind,
} from './logic';
import { pack } from './pack';

const BG = '#080B16';
const FLOOR = '#141A2E';
const WALL = '#2B3456';
const GOLD = C.yellow;
const TOOLS: ToolKind[] = ['smoke', 'coin', 'sprint'];
const TOOL_LABEL: Record<ToolKind, string> = { smoke: 'Smoke', coin: 'Coin', sprint: 'Sprint' };

type Phase = 'scout' | 'run' | 'caught' | 'escaped';
interface Rec { bits: number[]; tools: [number, ToolKind][] }

class Heist15 implements Game {
  private ctx!: GameContext;
  private level!: Level<HLevel>;
  private def!: HLevel;
  private room!: Room;
  private patrols: Patrol[] = [];
  private h!: Heist;
  private phase: Phase = 'scout';
  private phaseT = 0;
  private scrub = 0;
  private dragScrub = false;
  private rec: Rec = { bits: [], tools: [] };
  private ghost: { x: number; y: number }[] = [];
  private replay: { h: Heist; rec: Rec; i: number; acc: number } | null = null;
  private tool: ToolKind = 'smoke';
  private acc = 0;
  private s = 40;
  private ox = 0;
  private oy = 0;
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private inv = new InventoryBar();
  private stick: { id: number; x: number; y: number; dx: number; dy: number } | null = null;
  private clock = 0;
  private beatT = 0;
  private tickT = 0;
  private demo = false;
  private seed = 1;
  private attempts = 0;
  private lamps: { x: number; y: number }[] = [];
  private failAt: { x: number; y: number; by: { x: number; y: number } | null } | null = null;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('move', (p) => this.move(p));
    ctx.input.on('up', (p) => this.up(p));
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      if (code === 'Space' || code === 'Enter') {
        e.preventDefault();
        if (this.phase === 'scout') this.go();
        else if (this.phase === 'run' && code === 'Space') this.useTool(this.tool);
      } else if (/^Digit[1-3]$/.test(code)) { const t = TOOLS[Number(code.slice(5)) - 1]; if ((this.def.tools[t] ?? 0) > 0) this.tool = t; }
      else if (this.phase === 'scout' && (code === 'ArrowLeft' || code === 'ArrowRight')) { e.preventDefault(); this.scrub = clamp(this.scrub + (code === 'ArrowLeft' ? -0.25 : 0.25), 0, LIMIT); }
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.replay = null;
    this.trail = [];
    let lv = pack.get(opts?.mode) ?? pack.levels[0];
    if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 2); lv = pool[seed % pool.length] ?? lv; }
    this.level = lv;
    this.def = lv.def;
    this.room = new Room(this.def);
    this.patrols = this.def.guards.map((g) => new Patrol(g.path.map(([x, y]) => [x + 0.5, y + 0.5]), g.face ?? 0, g.phase ?? 0));
    this.tool = TOOLS.find((t) => (this.def.tools[t] ?? 0) > 0) ?? 'smoke';
    this.ghost = []; this.attempts = 0;
    this.lamps = [];
    for (let y = 1; y < H - 1; y += 3) for (let x = 2; x < W - 1; x += 5) if (this.def.rows[y][x] !== '#') this.lamps.push({ x: x + 0.5, y: y + 0.5 });
    this.toScout(0);
    if (this.demo) this.startReplay({ bits: expand(this.def.solution), tools: [] }, 1);
  }

  private toScout(at: number): void {
    this.phase = 'scout'; this.phaseT = 0; this.scrub = at;
    this.h = new Heist(this.room);
    this.rec = { bits: [], tools: [] };
    this.acc = 0; this.stick = null; this.failAt = null;
  }

  private go(): void {
    if (this.phase !== 'scout') return;
    this.phase = 'run'; this.phaseT = 0;
    this.h = new Heist(this.room);
    this.rec = { bits: [], tools: [] };
    this.acc = 0;
    const a = this.ctx.audio;
    a.tone({ f: 330, f2: 660, type: 'triangle', a: 0.01, d: 0.25, g: 0.1 });
  }

  // ---- input ----------------------------------------------------------------------

  private down(p: Pointer): void {
    if (this.demo) return;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; if (b.id === 'go') this.go(); return; }
    const slot = this.inv.at(p.x, p.y);
    if (slot) {
      const t = slot.item.kind as ToolKind;
      if (this.phase === 'run') this.useTool(t); else this.tool = t;
      return;
    }
    if (this.phase === 'scout' && this.onTimeline(p.x, p.y)) { this.dragScrub = true; this.setScrub(p.x); return; }
    if (this.phase === 'run' && p.type !== 'mouse') this.stick = { id: p.id, x: p.x, y: p.y, dx: 0, dy: 0 };
  }

  private move(p: Pointer): void {
    if (this.dragScrub && p.down) this.setScrub(p.x);
    if (this.stick && this.stick.id === p.id) { this.stick.dx = p.x - this.stick.x; this.stick.dy = p.y - this.stick.y; }
  }

  private up(p: Pointer): void {
    this.pressBtn = null;
    this.dragScrub = false;
    if (this.stick && this.stick.id === p.id) this.stick = null;
  }

  private tl(): { x: number; y: number; w: number } {
    const { w, h } = this.ctx.canvas;
    return { x: 24, y: h - 52, w: w - 24 - 200 };
  }
  private onTimeline(x: number, y: number): boolean { const t = this.tl(); return x >= t.x - 10 && x <= t.x + t.w + 10 && Math.abs(y - t.y) < 26; }
  private setScrub(x: number): void { const t = this.tl(); this.scrub = clamp(((x - t.x) / t.w) * LIMIT, 0, LIMIT); }

  private inputBits(): number {
    const k = this.ctx.input;
    let b = 0;
    if (k.isDown('ArrowUp', 'KeyW')) b |= BITS.up;
    if (k.isDown('ArrowDown', 'KeyS')) b |= BITS.down;
    if (k.isDown('ArrowLeft', 'KeyA')) b |= BITS.left;
    if (k.isDown('ArrowRight', 'KeyD')) b |= BITS.right;
    if (k.isDown('ShiftLeft', 'ShiftRight')) b |= BITS.sneak;
    const st = this.stick;
    if (st) {
      const d = Math.hypot(st.dx, st.dy);
      if (d > 12) {
        const a = Math.atan2(st.dy, st.dx);
        const oct = Math.round(a / (Math.PI / 4));
        const dirs: Record<number, number> = { 0: BITS.right, 1: BITS.right | BITS.down, 2: BITS.down, 3: BITS.down | BITS.left, 4: BITS.left, [-4]: BITS.left, [-3]: BITS.left | BITS.up, [-2]: BITS.up, [-1]: BITS.up | BITS.right };
        b |= dirs[oct] ?? 0;
        if (d < 38) b |= BITS.sneak;
      }
    }
    return b;
  }

  private useTool(t: ToolKind): void {
    if (this.phase !== 'run') return;
    if (this.h.use(t)) {
      this.rec.tools.push([this.h.frame, t]);
      this.toolFx(t);
    } else this.ctx.audio.buzz();
  }

  private toolFx(t: ToolKind): void {
    const a = this.ctx.audio;
    const p = this.px(this.h.x, this.h.y);
    if (t === 'smoke') { a.noise({ d: 0.8, g: 0.2, f: 900, f2: 300, type: 'lowpass' }); this.ctx.fx.particles.burst(p.x, p.y, 'rgba(200,200,220,0.6)', { count: 30, speed: 60, life: 1.4, size: this.s * 0.5, sizeEnd: this.s * 1.2, shape: Shape.Dot }); }
    else if (t === 'coin') { a.tone({ f: 2400, f2: 1800, type: 'sine', a: 0.002, d: 0.3, g: 0.12 }); a.tone({ f: 3000, type: 'sine', a: 0.002, d: 0.2, g: 0.08, at: 0.25 }); }
    else a.whoosh(0.2, 0.3);
  }

  // ---- loop -------------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.phaseT += dt;
    if (this.replay) { this.replayTick(dt); return; }
    // Caught -> back to scout quickly (under a second), at the moment it went wrong.
    if (this.phase === 'caught' && this.phaseT > 0.8) { this.toScout(Math.min(LIMIT, this.h.t)); return; }
    if (this.phase !== 'run') return;
    this.acc += dt;
    while (this.acc >= 1 / 60 && this.h.outcome === 'run') {
      const b = this.inputBits();
      this.rec.bits.push(b);
      this.h.step(b);
      this.acc -= 1 / 60;
      this.react(this.h);
      if (this.h.frame % 6 === 0) this.ghostTrail();
    }
    this.atmosphere(dt);
    if (this.h.outcome !== 'run') this.ended();
  }

  private ghostTrail(): void {
    this.trail.push({ x: this.h.x, y: this.h.y });
  }
  private trail: { x: number; y: number }[] = [];

  private react(h: Heist): void {
    const a = this.ctx.audio;
    for (const e of h.events) {
      if (e.kind === 'gem') { a.sparkle(1318.5); const p = this.px(h.x, h.y); this.ctx.fx.particles.burst(p.x, p.y, GOLD, { count: 24, speed: 120, life: 0.6, size: 3, sizeEnd: 0, shape: Shape.Spark }); }
      else if (e.kind === 'card') a.chime(7, 0.15);
      else if (e.kind === 'vent') a.noise({ d: 0.3, g: 0.12, f: 600, type: 'lowpass' });
      else if (e.kind === 'noise') a.tone({ f: 180, f2: 120, type: 'square', a: 0.002, d: 0.08, g: 0.08, lp: 900 });
      else if (e.kind === 'spotted') a.tone({ f: 600, f2: 900, type: 'sine', a: 0.005, d: 0.15, g: 0.08 });
    }
  }

  /** Heartbeat near cones, ticking clock in the last 5 seconds. */
  private atmosphere(dt: number): void {
    const h = this.h, a = this.ctx.audio;
    let near = false;
    for (const g of h.guards) if (Math.hypot(g.x - h.x, g.y - h.y) < GUARD_RANGE + 1.5) near = true;
    this.beatT -= dt;
    if ((near || h.suspicion > 0) && this.beatT <= 0) { a.heartbeat(0.2 + h.suspicion * 0.3); this.beatT = h.suspicion > 0 ? 0.45 : 0.8; }
    this.tickT -= dt;
    if (this.tickT <= 0) {
      const left = h.timeLeft;
      a.tick(left < 5 ? 2400 : 1600, left < 5 ? 0.12 * (1 + (5 - left) / 5) : 0.035);
      this.tickT = left < 5 ? 0.5 : 1;
    }
  }

  private ended(): void {
    const h = this.h, a = this.ctx.audio;
    this.phaseT = 0;
    this.ghost = this.trail; this.trail = [];
    if (h.outcome === 'escaped') {
      this.phase = 'escaped';
      a.thud(1); a.noise({ d: 0.3, g: 0.3, f: 200, type: 'lowpass' });
      a.fanfare();
      this.ctx.fx.camera.shake(0.3);
      this.startReplay(this.rec, 2);
      return;
    }
    this.phase = 'caught';
    this.attempts++;
    const w = h.seenBy;
    const by = w ? (w.kind === 'guard' ? { x: h.guards[w.i].x, y: h.guards[w.i].y } : { x: this.def.cameras[w.i][0] + 0.5, y: this.def.cameras[w.i][1] + 0.5 }) : null;
    this.failAt = { x: h.x, y: h.y, by };
    // Alarm sting.
    for (let k = 0; k < 3; k++) a.tone({ f: 880, f2: 660, type: 'square', a: 0.005, d: 0.18, g: 0.08, lp: 3000, at: k * 0.2 });
    if (h.outcome === 'timeout') a.buzz();
    this.ctx.fx.camera.shake(0.25);
  }

  private startReplay(rec: Rec, speed: number): void {
    this.replay = { h: new Heist(this.room), rec, i: 0, acc: 0 };
    this.replaySpeed = speed;
  }
  private replaySpeed = 2;

  private replayTick(dt: number): void {
    const r = this.replay!;
    r.acc += dt * this.replaySpeed;
    while (r.acc >= 1 / 60 && r.h.outcome === 'run') {
      for (const [f, t] of r.rec.tools) if (f === r.h.frame) r.h.use(t);
      r.h.step(r.rec.bits[r.i] ?? 0);
      r.i++;
      r.acc -= 1 / 60;
    }
    if (r.h.outcome !== 'run' && r.acc > 0.8) {
      this.replay = null;
      if (this.demo) { this.seed = (this.seed * 1103515245 + 12345) >>> 0; this.start(this.seed, { demo: true }); return; }
      const left = this.h.timeLeft;
      finishLevel(this.ctx, pack, this.level, 'Heist 15', {
        goals: ['Escape with the gem', 'With 4 seconds to spare', 'Without using any tools'],
        met: [true, left >= 4, this.h.usedTools === 0],
        stats: [
          { label: 'time left', value: `${left.toFixed(1)} s` },
          { label: 'tools used', value: String(this.h.usedTools) },
          { label: 'attempts', value: String(this.attempts + 1) },
        ],
        delayMs: 200,
      });
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {}

  debugInfo(): Record<string, number | string> {
    return { level: this.level.id, phase: this.phase, t: this.h.t, sus: this.h.suspicion };
  }

  // ---- render ---------------------------------------------------------------------------

  private px(x: number, y: number): { x: number; y: number } { return { x: this.ox + x * this.s, y: this.oy + y * this.s }; }

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 4 : 70, bottom = small ? 4 : (this.phase === 'run' ? 96 : 96);
    this.s = Math.min((w - 20) / W, (h - top - bottom) / H);
    this.ox = (w - W * this.s) / 2;
    this.oy = top + (h - top - bottom - H * this.s) / 2;
    if (small) { this.btns = []; this.inv.layout([], 0, 0, 0, 0); return; }
    const items: InvItem[] = TOOLS.filter((t) => (this.def.tools[t] ?? 0) > 0).map((t) => ({
      kind: t, count: this.phase === 'run' ? this.h.tools[t] : (this.def.tools[t] ?? 0), label: TOOL_LABEL[t],
      draw: (g, cx, cy, s) => drawTool(g, t, cx, cy, s),
    }));
    this.inv.layout(items, w - 66 - items.length * 70, 8, items.length * 70, 56);
    this.btns = this.phase === 'scout' ? [{ id: 'go', icon: 'play', label: 'Go', x: w - 172, y: h - 78, w: 160, h: 54, enabled: true, primary: true }] : [];
  }

  render(): void {
    const g = this.ctx.canvas.begin(BG);
    this.layout();
    const fx = this.ctx.fx;
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    const view = this.replay ? this.replay.h : this.h;
    const t = this.phase === 'scout' && !this.replay ? this.scrub : view.t;
    this.drawRoom(g, t, view);
    this.drawWatchers(g, t, view);
    if (this.phase === 'scout' && !this.replay) this.drawGhost(g, t);
    this.drawThief(g, view);
    fx.particles.render(g);
    if (this.phase === 'caught' && this.failAt) this.drawSpotlight(g);
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g, view);
  }

  private drawRoom(g: CanvasRenderingContext2D, t: number, h: Heist): void {
    const s = this.s;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = this.def.rows[y][x];
      const p = this.px(x, y);
      if (ch === '#') {
        g.fillStyle = WALL; g.fillRect(p.x, p.y, s + 0.5, s + 0.5);
        g.fillStyle = '#36406A'; g.fillRect(p.x, p.y, s + 0.5, s * 0.22);
        continue;
      }
      g.fillStyle = (x + y) % 2 ? FLOOR : '#161D33'; g.fillRect(p.x, p.y, s + 0.5, s + 0.5);
      if (ch === '~') {
        g.strokeStyle = 'rgba(180,150,110,0.25)'; g.lineWidth = 2;
        for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(p.x + k * s / 3, p.y + s); g.lineTo(p.x + (k + 1) * s / 3, p.y); g.stroke(); }
      } else if (ch === 'E') {
        g.fillStyle = rgba(C.green, 0.25); g.fillRect(p.x + 2, p.y + 2, s - 4, s - 4);
        g.strokeStyle = C.green; g.lineWidth = 2; g.strokeRect(p.x + 3, p.y + 3, s - 6, s - 6);
      } else if (ch === 'D' && !h.card) {
        g.fillStyle = '#3B2A55'; g.fillRect(p.x, p.y, s, s);
        g.fillStyle = C.violet; for (let k = 1; k < 4; k++) g.fillRect(p.x + (k * s) / 4 - 2, p.y + 2, 4, s - 4);
      } else if (ch === 'K' && !h.card) {
        roundRect(g, p.x + s * 0.25, p.y + s * 0.3, s * 0.5, s * 0.4, 4); g.fillStyle = C.violet; g.fill();
        g.fillStyle = '#FFFFFF'; g.fillRect(p.x + s * 0.32, p.y + s * 0.42, s * 0.2, s * 0.06);
      } else if (ch === 'V') {
        g.fillStyle = '#0B0E1A'; g.fillRect(p.x + 4, p.y + 4, s - 8, s - 8);
        g.strokeStyle = '#5A6488'; g.lineWidth = 2;
        for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(p.x + 4, p.y + (k * s) / 4); g.lineTo(p.x + s - 4, p.y + (k * s) / 4); g.stroke(); }
      } else if (ch === 'G' && !h.gem) {
        drawGlow(g, GOLD, p.x + s / 2, p.y + s / 2, s * 1.2, 0.5 + 0.2 * Math.sin(this.clock * 4));
        g.fillStyle = GOLD;
        g.beginPath(); g.moveTo(p.x + s / 2, p.y + s * 0.2); g.lineTo(p.x + s * 0.78, p.y + s * 0.45); g.lineTo(p.x + s / 2, p.y + s * 0.82); g.lineTo(p.x + s * 0.22, p.y + s * 0.45); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.moveTo(p.x + s / 2, p.y + s * 0.2); g.lineTo(p.x + s * 0.4, p.y + s * 0.45); g.lineTo(p.x + s / 2, p.y + s * 0.45); g.fill();
      }
    }
    // Warm lamp pools.
    g.save(); g.globalCompositeOperation = 'lighter';
    for (const l of this.lamps) { const p = this.px(l.x, l.y); drawGlow(g, '#FFB347', p.x, p.y, s * 2.2, 0.09); }
    g.restore();
    // Lasers.
    for (const l of this.def.lasers) {
      const on = laserOn(l, t);
      const tiles = laserTiles(l);
      const a = this.px(tiles[0][0] + 0.5, tiles[0][1] + 0.5), b = this.px(tiles[tiles.length - 1][0] + 0.5, tiles[tiles.length - 1][1] + 0.5);
      const horiz = l[1] === l[3];
      const pad = s * 0.5;
      g.beginPath();
      g.moveTo(a.x - (horiz ? pad : 0), a.y - (horiz ? 0 : pad)); g.lineTo(b.x + (horiz ? pad : 0), b.y + (horiz ? 0 : pad));
      if (on) {
        g.strokeStyle = 'rgba(255,60,80,0.25)'; g.lineWidth = s * 0.25; g.stroke();
        g.strokeStyle = '#FF4F6D'; g.lineWidth = 2; g.stroke();
      } else { g.setLineDash([4, 6]); g.strokeStyle = 'rgba(255,79,109,0.3)'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
    }
    // Smoke clouds and coins.
    for (const sm of h.smokes) {
      const p = this.px(sm.x + 0.5, sm.y + 0.5);
      g.fillStyle = `rgba(190,195,215,${0.55 * Math.min(1, sm.t)})`;
      for (let k = 0; k < 7; k++) { const a = k * 0.9 + this.clock * 0.4; g.beginPath(); g.arc(p.x + Math.cos(a) * s * 0.8, p.y + Math.sin(a) * s * 0.8, s * 0.75, 0, Math.PI * 2); g.fill(); }
    }
    for (const c of h.coins) { const p = this.px(c.x, c.y); g.fillStyle = GOLD; g.beginPath(); g.arc(p.x, p.y, s * 0.12, 0, Math.PI * 2); g.fill(); }
  }

  /** Guard and camera cones, clipped by walls, at time t. */
  private drawWatchers(g: CanvasRenderingContext2D, t: number, h: Heist): void {
    const scout = this.phase === 'scout' && !this.replay;
    const guards = scout ? this.patrols.map((p) => p.at(t)) : h.guards.map((q) => ({ x: q.x, y: q.y, ang: q.ang }));
    const sus = !scout && h.seenBy ? h.seenBy : null;
    guards.forEach((q, i) => {
      const hot = sus?.kind === 'guard' && sus.i === i ? h.suspicion : 0;
      this.cone(g, q.x, q.y, q.ang, GUARD_FOV, GUARD_RANGE, hot, h);
      const p = this.px(q.x, q.y);
      g.fillStyle = '#C9B7A0'; g.beginPath(); g.arc(p.x, p.y, this.s * 0.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#26324F'; g.beginPath(); g.arc(p.x, p.y, this.s * 0.22, q.ang - 2.2, q.ang + 2.2, true); g.fill();
      g.fillStyle = GOLD; g.beginPath(); g.arc(p.x + Math.cos(q.ang) * this.s * 0.28, p.y + Math.sin(q.ang) * this.s * 0.28, this.s * 0.07, 0, Math.PI * 2); g.fill();
      if (this.phase === 'caught' && this.failAt?.by && Math.abs(this.failAt.by.x - q.x) < 0.01 && Math.abs(this.failAt.by.y - q.y) < 0.01) this.exclaim(g, p.x, p.y);
    });
    this.def.cameras.forEach((c, i) => {
      const a = camAngle(c, t);
      const hot = sus?.kind === 'camera' && sus.i === i ? h.suspicion : 0;
      this.cone(g, c[0] + 0.5, c[1] + 0.5, a, CAM_FOV, CAM_RANGE, hot, h);
      const p = this.px(c[0] + 0.5, c[1] + 0.5);
      g.save(); g.translate(p.x, p.y); g.rotate(a);
      roundRect(g, -this.s * 0.2, -this.s * 0.15, this.s * 0.45, this.s * 0.3, 4); g.fillStyle = '#9AA4C8'; g.fill();
      g.fillStyle = '#FF4F6D'; g.beginPath(); g.arc(this.s * 0.18, 0, this.s * 0.06, 0, Math.PI * 2); g.fill();
      g.restore();
      if (this.phase === 'caught' && this.failAt?.by && Math.abs(this.failAt.by.x - (c[0] + 0.5)) < 0.01 && Math.abs(this.failAt.by.y - (c[1] + 0.5)) < 0.01) this.exclaim(g, p.x, p.y);
    });
  }

  private cone(g: CanvasRenderingContext2D, x: number, y: number, ang: number, fov: number, range: number, hot: number, h: Heist): void {
    const half = (fov / 2) * Math.PI / 180;
    const rays = 28;
    const o = this.px(x, y);
    const smoke = h.smokes.length ? h.smokes : null;
    g.beginPath(); g.moveTo(o.x, o.y);
    for (let k = 0; k <= rays; k++) {
      const a = ang - half + (2 * half * k) / rays;
      let d = 0;
      for (; d < range; d += 0.08) {
        const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
        const tx = Math.floor(px), ty = Math.floor(py);
        if (this.room.wall(tx, ty, h.card) || this.room.door[ty * W + tx]) break;
        if (smoke && smoke.some((sm) => Math.abs(tx - sm.x) <= 1 && Math.abs(ty - sm.y) <= 1)) break;
      }
      const p = this.px(x + Math.cos(a) * d, y + Math.sin(a) * d);
      g.lineTo(p.x, p.y);
    }
    g.closePath();
    const col = hot > 0.5 ? C.pink : hot > 0 ? C.orange : GOLD;
    const grad = g.createRadialGradient(o.x, o.y, 0, o.x, o.y, range * this.s);
    grad.addColorStop(0, rgba(col, 0.3 + hot * 0.25)); grad.addColorStop(1, rgba(col, 0.05));
    g.fillStyle = grad; g.fill();
  }

  private exclaim(g: CanvasRenderingContext2D, x: number, y: number): void {
    const k = Math.min(1, this.phaseT * 5);
    g.fillStyle = C.pink; g.font = `800 ${Math.round(this.s * 0.9 * k)}px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText('!', x, y - this.s * 0.35);
  }

  private drawGhost(g: CanvasRenderingContext2D, t: number): void {
    if (!this.ghost.length) return;
    g.setLineDash([3, 5]); g.strokeStyle = 'rgba(160,190,255,0.45)'; g.lineWidth = 2;
    g.beginPath();
    this.ghost.forEach((p, i) => { const q = this.px(p.x, p.y); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
    g.stroke(); g.setLineDash([]);
    const i = Math.min(this.ghost.length - 1, Math.floor((t * 60) / 6));
    if (i >= 0) { const q = this.px(this.ghost[i].x, this.ghost[i].y); g.fillStyle = 'rgba(160,190,255,0.45)'; g.beginPath(); g.arc(q.x, q.y, this.s * 0.28, 0, Math.PI * 2); g.fill(); }
  }

  private drawThief(g: CanvasRenderingContext2D, h: Heist): void {
    if (h.vent) return;
    const p = this.px(h.x, h.y), s = this.s;
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.beginPath(); g.ellipse(p.x, p.y + s * 0.22, s * 0.3, s * 0.12, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#20263D'; g.beginPath(); g.arc(p.x, p.y, s * 0.3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = h.gem ? GOLD : '#7C88B8'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#E8E4F0'; g.fillRect(p.x - s * 0.22, p.y - s * 0.08, s * 0.44, s * 0.12);
    g.fillStyle = '#20263D'; g.fillRect(p.x - s * 0.14, p.y - s * 0.06, s * 0.08, s * 0.08); g.fillRect(p.x + s * 0.06, p.y - s * 0.06, s * 0.08, s * 0.08);
    if (h.sprintT > 0) drawGlow(g, C.cyan, p.x, p.y, s * 0.8, 0.4);
  }

  private drawSpotlight(g: CanvasRenderingContext2D): void {
    const { w, h } = this.ctx.canvas;
    const p = this.px(this.failAt!.x, this.failAt!.y);
    const k = Math.min(1, this.phaseT * 6);
    g.save();
    g.fillStyle = `rgba(0,0,0,${0.65 * k})`;
    g.beginPath(); g.rect(0, 0, w, h); g.arc(p.x, p.y, this.s * (3 - 2 * k), 0, Math.PI * 2, true); g.fill('evenodd');
    g.restore();
  }

  private drawUi(g: CanvasRenderingContext2D, view: Heist): void {
    const { w, h } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const room = Math.min(titleRoom(this.btns, w - 64), this.inv.slots.length ? this.inv.slots[0].x : w) - 140;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    g.fillText(fitText(g, `${this.level.chapter} ${this.level.n} · ${this.def.name}`, Math.max(80, room)), 16, 30);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`;
    const hint = this.phase === 'scout' ? 'Scout: drag the timeline. Space = Go' : this.phase === 'run' ? (view.gem ? 'Got it. Back to the exit!' : 'Grab the gem') : '';
    g.fillText(fitText(g, hint, Math.max(80, room)), 16, 50);
    // Clock.
    const left = this.phase === 'scout' && !this.replay ? LIMIT - this.scrub : view.timeLeft;
    g.textAlign = 'center';
    g.fillStyle = left < 5 && this.phase === 'run' ? C.pink : GOLD;
    g.font = `700 34px ${FONT.mono}`;
    g.fillText(left.toFixed(1), w / 2, 44);
    // Suspicion meter.
    if (this.phase === 'run' && view.suspicion > 0) {
      roundRect(g, w / 2 - 60, 52, 120, 8, 4); g.fillStyle = C.surface; g.fill();
      roundRect(g, w / 2 - 60, 52, 120 * view.suspicion, 8, 4); g.fillStyle = view.suspicion > 0.5 ? C.pink : C.orange; g.fill();
    }
    this.inv.draw(g, GOLD, this.phase === 'run' ? null : this.tool, null, matchMedia('(pointer: fine)').matches);
    for (const b of this.btns) drawBtn(g, b, GOLD, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    if (this.phase === 'scout' && !this.replay) {
      const t = this.tl();
      roundRect(g, t.x, t.y - 4, t.w, 8, 4); g.fillStyle = C.surface2; g.fill();
      for (let k = 0; k <= LIMIT; k++) { const x = t.x + (k / LIMIT) * t.w; g.fillStyle = k % 5 === 0 ? C.muted : 'rgba(255,255,255,0.2)'; g.fillRect(x - 1, t.y + 8, 2, k % 5 === 0 ? 8 : 4); }
      const x = t.x + (this.scrub / LIMIT) * t.w;
      g.beginPath(); g.arc(x, t.y, 11, 0, Math.PI * 2); g.fillStyle = GOLD; g.fill();
      g.fillStyle = C.muted; g.font = `600 12px ${FONT.ui}`; g.textAlign = 'left';
      g.fillText(`${this.scrub.toFixed(1)} s`, t.x, t.y - 14);
    }
    if (this.phase === 'escaped' || this.replay) {
      const k = Math.min(1, this.phaseT * 3);
      g.save(); g.translate(w / 2, h * 0.42); g.rotate(-0.12); g.scale(2 - k, 2 - k);
      g.globalAlpha = k;
      g.strokeStyle = C.green; g.lineWidth = 5; g.font = `800 44px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText('CLEAN GETAWAY').width + 30;
      g.strokeRect(-tw / 2, -32, tw, 64);
      g.fillStyle = C.green; g.fillText('CLEAN GETAWAY', 0, 2);
      g.restore();
      g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`; g.textAlign = 'center';
      g.fillText('replay ×2', w / 2, h - 20);
    }
    if (this.phase === 'caught') {
      g.fillStyle = C.pink; g.font = `800 34px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.h.outcome === 'alarm' ? 'Laser alarm!' : this.h.outcome === 'timeout' ? 'Out of time!' : 'Spotted!', w / 2, h * 0.5);
    }
    if (this.stick) {
      g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 2;
      g.beginPath(); g.arc(this.stick.x, this.stick.y, 44, 0, Math.PI * 2); g.stroke();
      const d = Math.min(44, Math.hypot(this.stick.dx, this.stick.dy)), a = Math.atan2(this.stick.dy, this.stick.dx);
      g.fillStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.arc(this.stick.x + Math.cos(a) * d, this.stick.y + Math.sin(a) * d, 18, 0, Math.PI * 2); g.fill();
    }
  }
}

function drawTool(g: CanvasRenderingContext2D, t: ToolKind, cx: number, cy: number, s: number): void {
  const r = s * 0.4;
  if (t === 'smoke') { g.fillStyle = '#B9BED6'; for (const [dx, dy] of [[-0.4, 0.1], [0.1, -0.2], [0.4, 0.15]]) { g.beginPath(); g.arc(cx + dx * r, cy + dy * r, r * 0.45, 0, Math.PI * 2); g.fill(); } }
  else if (t === 'coin') { g.fillStyle = GOLD; g.beginPath(); g.arc(cx, cy, r * 0.6, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#B8941F'; g.lineWidth = 2; g.stroke(); }
  else { g.strokeStyle = C.cyan; g.lineWidth = 3; g.beginPath(); g.moveTo(cx - r * 0.6, cy + r * 0.3); g.lineTo(cx, cy - r * 0.3); g.lineTo(cx + r * 0.6, cy + r * 0.3); g.stroke(); g.beginPath(); g.moveTo(cx - r * 0.6, cy - r * 0.2); g.lineTo(cx, cy - r * 0.8); g.lineTo(cx + r * 0.6, cy - r * 0.2); g.stroke(); }
}

function clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)); }

export default (): Game => new Heist15();
