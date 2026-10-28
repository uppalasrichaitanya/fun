import { drawBtn, fitText, hitBtn, roundRect, titleRoom, type Btn } from '../../engine/editor/ui';
import { drawGlow } from '../../engine/glow';
import type { Pointer } from '../../engine/input';
import type { Level } from '../../engine/levels/pack';
import { finishLevel } from '../../engine/levels/session';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { buildLayout } from './build';
import {
  autopilot, COLOR_NAMES, COLORS, DT, Network, reachable, Sim, TRAIN_LEN,
  type Event, type SYLevel, type Train,
} from './logic';
import { pack } from './pack';

const BG = '#16301F';
const GROUND = '#1E3D28';
const RAIL = '#C9CED8';
const SLEEPER = '#6B4A2E';
const ACCENT = C.green;

type Phase = 'ready' | 'run' | 'fail' | 'won';

class Switchyard implements Game {
  private ctx!: GameContext;
  private rng = new Rng(1);
  private level: Level<SYLevel> | null = null;
  private def!: SYLevel;
  private net!: Network;
  private sim!: Sim;
  private rec: Event[] = [];
  private phase: Phase = 'ready';
  private phaseT = 0;
  private paused = false;
  private pausedTime = 0;
  private fast = false;
  private acc = 0;
  private s = 40;
  private ox = 0;
  private oy = 0;
  private btns: Btn[] = [];
  private pressBtn: string | null = null;
  private holding = new Map<number, number>();
  private flash = new Map<number, number>();
  private trees: { x: number; y: number; r: number }[] = [];
  private banner: { text: string; t: number; color: string } | null = null;
  private clock = 0;
  private demo = false;
  private demoEvents: Event[] = [];
  private seed = 1;
  private endless = false;
  private nextSpawn = 0;
  private reach: ReturnType<typeof reachable> | null = null;
  private wreck: { x: number; y: number; vx: number; vy: number; a: number; va: number; color: string }[] = [];
  private attempts = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', (p) => this.down(p));
    ctx.input.on('up', (p) => this.up(p));
    ctx.input.onKey((code, e) => {
      if (this.demo) return;
      const m = /^Digit([1-9])$/.exec(code);
      if (m) { const n = this.net.switches[Number(m[1]) - 1]; if (n !== undefined) { e.preventDefault(); this.press(n, 1000 + Number(m[1])); } return; }
      if (code === 'Space') { e.preventDefault(); this.button(this.phase === 'ready' ? 'start' : 'pause'); }
      else if (code === 'Enter' && this.phase === 'ready') this.button('start');
      else if (code === 'KeyF') this.button('fast');
    });
    ctx.input.onKeyUp((code) => {
      const m = /^Digit([1-9])$/.exec(code);
      if (m) this.release(1000 + Number(m[1]));
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.seed = seed;
    this.rng.seed(seed);
    this.endless = opts?.mode === 'endless';
    this.attempts = 0;
    if (this.endless) {
      this.level = null;
      let lay = null;
      for (let k = 0; !lay; k++) lay = buildLayout({ lanes: 4, tunnels: 3, connectors: 4, crossings: 1, xovers: 1, loop: this.rng.chance(0.5) }, this.rng);
      this.def = lay.level;
    } else {
      let lv = pack.get(opts?.mode) ?? pack.levels[0];
      if (this.demo) { const pool = pack.levels.filter((l) => l.index >= 3); lv = pool[seed % pool.length] ?? lv; }
      this.level = lv;
      this.def = lv.def;
    }
    this.net = new Network(this.def);
    this.reach = reachable(this.net);
    this.makeTrees();
    this.reset();
    if (this.demo) { this.demoEvents = autopilot(this.def, { rollout: false }).events; this.phase = 'run'; }
  }

  private reset(): void {
    this.sim = new Sim(this.net, this.demo ? this.demoEvents : []);
    this.sim.endless = this.endless;
    this.rec = [];
    this.phase = 'ready'; this.phaseT = 0;
    this.paused = false; this.acc = 0; this.wreck = [];
    this.holding.clear();
    this.nextSpawn = 2;
    if (this.endless) this.phase = 'ready';
  }

  private makeTrees(): void {
    const r = new Rng(this.seed ^ 0x9e3779b9);
    this.trees = [];
    for (let k = 0; k < 90 && this.trees.length < 26; k++) {
      const x = r.range(0.5, this.def.w - 0.5), y = r.range(0.4, this.def.h - 0.4);
      if (this.nearTrack(x, y) < 1.1) continue;
      this.trees.push({ x, y, r: r.range(0.25, 0.45) });
    }
  }

  private nearTrack(x: number, y: number): number {
    let best = Infinity;
    for (const e of this.net.edges) for (let i = 1; i < e.pts.length; i++) {
      const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L || 1)));
      best = Math.min(best, Math.hypot(x - ax - dx * k, y - ay - dy * k));
    }
    return best;
  }

  // ---- input ----------------------------------------------------------------

  private toScreen(x: number, y: number): { x: number; y: number } { return { x: this.ox + x * this.s, y: this.oy + y * this.s }; }

  private switchAt(x: number, y: number): number {
    let best = -1, bd = 0.85;
    for (const n of this.net.switches) {
      const p = this.def.nodes[n];
      const d = Math.hypot((x - this.ox) / this.s - p.x, (y - this.oy) / this.s - p.y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  private down(p: Pointer): void {
    if (this.demo) return;
    const b = hitBtn(this.btns, p.x, p.y);
    if (b) { this.pressBtn = b.id; this.button(b.id); return; }
    const n = this.switchAt(p.x, p.y);
    if (n >= 0) this.press(n, p.id);
  }

  private up(p: Pointer): void {
    this.pressBtn = null;
    this.release(p.id);
  }

  /** Flip a switch now (instant); timed switches are also held while pressed. */
  private press(n: number, holder: number): void {
    if (this.phase === 'fail' || this.phase === 'won') return;
    this.act(n, 'f');
    if (this.def.nodes[n].timed) { this.act(n, 'h'); this.holding.set(holder, n); }
  }

  private release(holder: number): void {
    const n = this.holding.get(holder);
    if (n === undefined) return;
    this.holding.delete(holder);
    if (![...this.holding.values()].includes(n)) this.act(n, 'r');
  }

  private act(n: number, a: 'f' | 'h' | 'r'): void {
    this.sim.act(n, a);
    this.rec.push([this.sim.t, n, a]);
    if (a === 'f') {
      this.flash.set(n, 1);
      const au = this.ctx.audio;
      au.noise({ d: 0.05, g: 0.18, f: 2200, type: 'highpass' });
      au.tone({ f: 260, f2: 180, type: 'square', a: 0.001, d: 0.05, g: 0.08, lp: 1500 });
    }
  }

  private button(id: string): void {
    const a = this.ctx.audio;
    if (id === 'start' && this.phase === 'ready') { this.phase = 'run'; this.phaseT = 0; a.tone({ f: 660, f2: 990, type: 'square', a: 0.01, d: 0.25, g: 0.07, lp: 2400 }); }
    else if (id === 'pause' && this.phase === 'run') { this.paused = !this.paused; a.tick(this.paused ? 900 : 1500, 0.07); }
    else if (id === 'fast') { this.fast = !this.fast; a.tick(this.fast ? 1800 : 1100, 0.06); }
  }

  // ---- loop -------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.phaseT += dt;
    for (const [n, v] of this.flash) { const nv = v - dt * 4; if (nv <= 0) this.flash.delete(n); else this.flash.set(n, nv); }
    if (this.banner && (this.banner.t -= dt) <= 0) this.banner = null;
    for (const w of this.wreck) { w.vy += 14 * dt; w.x += w.vx * dt; w.y += w.vy * dt; w.a += w.va * dt; }
    if (this.phase === 'run') {
      if (this.paused) { this.pausedTime += dt; return; }
      this.acc += dt * (this.fast ? 2 : 1);
      while (this.acc >= DT && !this.sim.done) {
        if (this.endless) this.spawnEndless();
        this.sim.step();
        this.acc -= DT;
        this.react();
      }
      if (this.sim.fail) this.failed();
      else if (this.sim.done) this.won();
    }
    if (this.phase === 'fail' && this.phaseT > 1.4) {
      if (this.endless && !this.demo) return;
      if (this.demo) { this.next(); return; }
      this.reset();
    }
    if (this.phase === 'won' && this.demo && this.phaseT > 1.5) this.next();
  }

  private next(): void {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    this.start(this.seed, { demo: true });
  }

  private spawnEndless(): void {
    const s = this.sim;
    if (s.t < this.nextSpawn || s.trains.filter((t) => t.state === 'run' || t.state === 'wait').length >= 6) return;
    const lay = this.def;
    const tunnels = lay.nodes.map((n, i) => (n.k === 'tunnel' ? i : -1)).filter((i) => i >= 0 && s.tunnelFree(i));
    const stations = lay.nodes.map((n) => (n.k === 'station' ? n.c! : -1)).filter((c) => c >= 0);
    if (!tunnels.length) return;
    for (let k = 0; k < 20; k++) {
      const tn = this.rng.pick(tunnels), c = this.rng.pick(stations);
      if (!this.reach!(tn, this.net.outs[tn][0], c, -1)) continue;
      s.addTrain([s.t, tn, c, this.rng.chance(Math.min(0.4, s.delivered * 0.02)) ? 1 : 0, -1]);
      break;
    }
    this.nextSpawn = s.t + Math.max(1.5, 4.6 - s.delivered * 0.09);
  }

  /** Sounds and effects for what happened this step. */
  private react(): void {
    const a = this.ctx.audio, fx = this.ctx.fx;
    for (const e of this.sim.events) {
      if (e.kind === 'home') {
        const tr = this.sim.trains[e.train!];
        const n = this.def.nodes[e.node!];
        const p = this.toScreen(n.x, n.y);
        a.chime(4 + (tr.color % 5), 0.18);
        a.tone({ f: 1760, type: 'sine', a: 0.002, d: 0.6, g: 0.06, at: 0.05 });
        fx.particles.burst(p.x, p.y, COLORS[tr.color], { count: 26, speed: 160, life: 0.9, size: 4, sizeEnd: 0, shape: Shape.Confetti, gravity: 220 });
      } else if (e.kind === 'auto') {
        this.flash.set(e.node!, 1);
        a.tick(1400, 0.05);
      } else if (e.kind === 'near') {
        fx.time.slowMo(0.35, 450);
        a.tone({ f: 880, type: 'square', a: 0.01, d: 0.22, g: 0.06, lp: 2500 });
        a.tone({ f: 1100, type: 'square', a: 0.01, d: 0.3, g: 0.05, lp: 2500, at: 0.12 });
      } else if (e.kind === 'spawn' && !this.demo) {
        a.tone({ f: 523, type: 'square', a: 0.01, d: 0.12, g: 0.04, lp: 1800 });
      }
    }
  }

  private failed(): void {
    const f = this.sim.fail!;
    this.phase = 'fail'; this.phaseT = 0; this.attempts++;
    const a = this.ctx.audio, fx = this.ctx.fx;
    const p = this.toScreen(f.x, f.y);
    fx.camera.shake(f.kind === 'crash' ? 0.5 : 0.25);
    if (f.kind === 'crash') {
      a.shatter(); a.thud(1);
      for (const id of f.trains) {
        const tr = this.sim.trains[id];
        for (let k = 0; k < 3; k++) this.wreck.push({ x: f.x, y: f.y, vx: this.rng.range(-4, 4), vy: this.rng.range(-7, -3), a: 0, va: this.rng.range(-8, 8), color: COLORS[tr.color] });
      }
      fx.particles.burst(p.x, p.y, '#FFD93D', { count: 30, speed: 220, life: 0.6, size: 3, sizeEnd: 0, shape: Shape.Spark });
    } else a.buzz();
    const text = { crash: 'Crash!', wrong: 'Wrong station!', dead: 'Dead end!', via: 'Missed its stop!' }[f.kind];
    this.banner = { text: this.endless ? `${text} ${this.sim.delivered} trains home` : text, t: 1.4, color: C.pink };
    if (this.endless && !this.demo) {
      this.ctx.shell.gameOver({
        score: this.sim.delivered, noScore: true, title: text, rank: `${this.sim.delivered} train${this.sim.delivered === 1 ? '' : 's'} home`,
        stats: [{ label: 'delivered', value: String(this.sim.delivered) }, { label: 'time', value: `${Math.floor(this.sim.t)} s` }, { label: 'flips', value: String(this.sim.flips) }],
        share: `Pocket Arcade - Switchyard Endless: ${this.sim.delivered} trains home`,
      }, 1200);
    }
  }

  private won(): void {
    this.phase = 'won'; this.phaseT = 0;
    this.ctx.audio.fanfare();
    if (this.demo || !this.level) return;
    const flips = this.rec.filter((e) => e[2] === 'f').length;
    finishLevel(this.ctx, pack, this.level, 'Switchyard', {
      goals: ['Every train home', 'No pausing', `${this.def.par} switch flips or fewer`],
      met: [true, this.pausedTime === 0, flips <= this.def.par],
      stats: [
        { label: 'trains', value: String(this.def.trains.length) },
        { label: 'flips', value: `${flips} / par ${this.def.par}` },
        { label: 'tries', value: String(this.attempts + 1) },
      ],
      delayMs: 700,
    });
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {}

  debugInfo(): Record<string, number | string> {
    return { level: this.level?.id ?? 'endless', t: this.sim.t, trains: this.sim.trains.length, flips: this.sim.flips };
  }

  // ---- render -------------------------------------------------------------------

  private layout(): void {
    const { w, h } = this.ctx.canvas;
    const small = this.demo || this.ctx.preview;
    const top = small ? 4 : 92, bottom = small ? 4 : 74;
    this.s = Math.min((w - 20) / this.def.w, (h - top - bottom) / this.def.h);
    this.ox = (w - this.def.w * this.s) / 2;
    this.oy = top + (h - top - bottom - this.def.h * this.s) / 2;
    if (small) { this.btns = []; return; }
    const bw = Math.min(170, w * 0.3);
    const by = h - 64;
    this.btns = [];
    if (this.phase === 'ready') this.btns.push({ id: 'start', icon: 'play', label: 'Start', x: w - bw - 12, y: by, w: bw, h: 54, enabled: true, primary: true });
    else {
      this.btns.push({ id: 'pause', icon: this.paused ? 'play' : 'stop', label: this.paused ? 'Resume' : 'Pause', x: w - bw - 12, y: by, w: bw, h: 54, enabled: this.phase === 'run', active: this.paused });
    }
    this.btns.push({ id: 'fast', label: this.fast ? '2× speed' : '1× speed', x: w - bw * 2 - 24, y: by, w: bw, h: 54, enabled: true, active: this.fast });
  }

  render(): void {
    const g = this.ctx.canvas.begin(BG);
    this.layout();
    const fx = this.ctx.fx;
    fx.camera.begin(g, this.ctx.canvas.w, this.ctx.canvas.h);
    this.drawGround(g);
    this.drawTrack(g);
    this.drawNodes(g);
    this.drawTrains(g);
    this.drawWreck(g);
    fx.particles.render(g);
    fx.camera.end(g);
    if (!this.demo && !this.ctx.preview) this.drawUi(g);
  }

  private drawGround(g: CanvasRenderingContext2D): void {
    const tl = this.toScreen(0, 0);
    roundRect(g, tl.x, tl.y, this.def.w * this.s, this.def.h * this.s, 18);
    g.fillStyle = GROUND; g.fill();
    for (const t of this.trees) {
      const p = this.toScreen(t.x, t.y), r = t.r * this.s;
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(p.x + r * 0.2, p.y + r * 0.6, r, r * 0.45, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2F7A44'; g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3E9A57'; g.beginPath(); g.arc(p.x - r * 0.25, p.y - r * 0.3, r * 0.55, 0, Math.PI * 2); g.fill();
    }
  }

  private drawTrack(g: CanvasRenderingContext2D): void {
    const s = this.s;
    const active = new Set<number>();
    this.net.switches.forEach((n) => active.add(this.net.outs[n][this.sim.sw[n]]));
    for (const pass of [0, 1]) for (const e of this.net.edges) {
      const fromSwitch = this.def.nodes[e.a].k === 'switch';
      const dim = fromSwitch && !active.has(e.id);
      if (pass === 0) {
        // Sleepers.
        g.fillStyle = dim ? 'rgba(107,74,46,0.5)' : SLEEPER;
        for (let d = 0.18; d < e.len; d += 0.36) {
          const p = this.net.at(e.id, d), q = this.toScreen(p.x, p.y);
          g.save(); g.translate(q.x, q.y); g.rotate(p.ang + Math.PI / 2);
          g.fillRect(-s * 0.22, -s * 0.05, s * 0.44, s * 0.1);
          g.restore();
        }
      } else {
        for (const off of [-0.12, 0.12]) {
          g.beginPath();
          for (let i = 0; i < e.pts.length; i++) {
            const [x, y] = e.pts[i];
            const a = i < e.pts.length - 1 ? Math.atan2(e.pts[i + 1][1] - y, e.pts[i + 1][0] - x) : Math.atan2(y - e.pts[i - 1][1], x - e.pts[i - 1][0]);
            const q = this.toScreen(x - Math.sin(a) * off, y + Math.cos(a) * off);
            if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y);
          }
          g.strokeStyle = dim ? 'rgba(201,206,216,0.35)' : RAIL; g.lineWidth = Math.max(1.5, s * 0.05); g.stroke();
        }
      }
    }
  }

  private drawNodes(g: CanvasRenderingContext2D): void {
    const s = this.s;
    this.def.nodes.forEach((n, i) => {
      const p = this.toScreen(n.x, n.y);
      if (n.k === 'tunnel') {
        g.fillStyle = '#3A3F52'; g.beginPath(); g.arc(p.x, p.y + s * 0.3, s * 0.7, Math.PI, 0); g.lineTo(p.x + s * 0.7, p.y + s * 0.5); g.lineTo(p.x - s * 0.7, p.y + s * 0.5); g.fill();
        g.fillStyle = '#0B0D14'; g.beginPath(); g.arc(p.x, p.y + s * 0.3, s * 0.48, Math.PI, 0); g.lineTo(p.x + s * 0.48, p.y + s * 0.5); g.lineTo(p.x - s * 0.48, p.y + s * 0.5); g.fill();
        const nxt = this.sim.trains.filter((t) => t.state === 'wait' && t.tunnel === i).sort((a, b) => a.spawn - b.spawn)[0];
        if (nxt && this.phase !== 'fail') {
          const left = nxt.spawn - this.sim.t;
          if (left < 3) { drawGlow(g, COLORS[nxt.color], p.x, p.y, s * 0.8, 0.4 + 0.3 * Math.sin(this.clock * 10)); }
        }
      } else if (n.k === 'station') {
        const col = COLORS[n.c!];
        roundRect(g, p.x - s * 0.15, p.y - s * 0.75, s * 0.85, s * 1.5, s * 0.15);
        g.fillStyle = '#E9E4D8'; g.fill();
        g.fillStyle = col; g.beginPath(); g.moveTo(p.x - s * 0.3, p.y - s * 0.7); g.lineTo(p.x + s * 0.28, p.y - s * 1.1); g.lineTo(p.x + s * 0.85, p.y - s * 0.7); g.fill();
        g.fillStyle = col; g.fillRect(p.x - s * 0.15, p.y + s * 0.35, s * 0.85, s * 0.18);
      } else if (n.k === 'end' || n.k === 'buffer') {
        g.fillStyle = '#C0392B'; g.fillRect(p.x - s * 0.08, p.y - s * 0.3, s * 0.16, s * 0.6);
      } else if (n.k === 'stop') {
        g.fillStyle = '#E9E4D8'; g.fillRect(p.x - s * 0.04, p.y - s * 0.9, s * 0.08, s * 0.6);
        g.fillStyle = COLORS[n.c!]; g.beginPath(); g.arc(p.x, p.y - s * 0.95, s * 0.2, 0, Math.PI * 2); g.fill();
      } else if (n.k === 'switch') {
        const fl = this.flash.get(i) ?? 0;
        const out = this.net.outs[i][this.sim.sw[i]];
        const tip = this.net.at(out, Math.min(0.9, this.net.edges[out].len * 0.6));
        const tq = this.toScreen(tip.x, tip.y);
        const held = this.sim.held[i];
        g.beginPath(); g.arc(p.x, p.y, s * (0.42 + fl * 0.1), 0, Math.PI * 2);
        g.fillStyle = held ? '#FFD93D' : '#F4F1FF'; g.fill();
        g.strokeStyle = n.timed ? C.orange : ACCENT; g.lineWidth = 3; g.stroke();
        if (n.timed) {
          const k = (this.sim.t % n.timed) / n.timed;
          g.beginPath(); g.arc(p.x, p.y, s * 0.55, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
          g.strokeStyle = held ? C.yellow : C.orange; g.lineWidth = 3; g.stroke();
        }
        // Arrow toward the current route.
        const ang = Math.atan2(tq.y - p.y, tq.x - p.x);
        g.save(); g.translate(p.x, p.y); g.rotate(ang);
        g.fillStyle = '#1E3D28';
        g.beginPath(); g.moveTo(s * 0.3, 0); g.lineTo(-s * 0.05, -s * 0.18); g.lineTo(-s * 0.05, s * 0.18); g.fill();
        g.restore();
        if (n.key && n.key <= 9 && !this.demo && !this.ctx.preview) {
          g.fillStyle = C.text; g.font = `700 ${Math.max(10, s * 0.32)}px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(n.key), p.x, p.y - s * 0.72);
        }
      } else if (n.k === 'cross') {
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.arc(p.x, p.y, s * 0.3, 0, Math.PI * 2); g.fill();
      }
    });
  }

  private drawTrains(g: CanvasRenderingContext2D): void {
    for (const tr of this.sim.trains) {
      if (tr.state !== 'run' && !(tr.state === 'crash' && this.phaseT < 0.05)) continue;
      this.drawTrain(g, tr);
    }
  }

  private drawTrain(g: CanvasRenderingContext2D, tr: Train): void {
    const s = this.s;
    const col = COLORS[tr.color];
    const pos = (back: number) => {
      const target = tr.s - back;
      for (let i = tr.path.length - 1; i >= 0; i--) {
        const p = tr.path[i];
        if (target >= p.s0 || i === 0) return this.net.at(p.e, Math.max(0, target - p.s0));
      }
      return this.net.at(tr.path[0].e, 0);
    };
    const cars = [{ a: 0.05, b: TRAIN_LEN * 0.5 - 0.05, loco: true }, { a: TRAIN_LEN * 0.5 + 0.05, b: TRAIN_LEN - 0.05, loco: false }];
    for (const car of cars.reverse()) {
      if (tr.s - car.b < 0) continue;
      const f = pos(car.a), b = pos(car.b);
      const fq = this.toScreen(f.x, f.y), bq = this.toScreen(b.x, b.y);
      const cx = (fq.x + bq.x) / 2, cy = (fq.y + bq.y) / 2, ang = Math.atan2(fq.y - bq.y, fq.x - bq.x);
      const len = Math.hypot(fq.x - bq.x, fq.y - bq.y);
      g.save(); g.translate(cx, cy); g.rotate(ang);
      g.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(g, -len / 2 + 2, -s * 0.26 + 3, len, s * 0.52, s * 0.14); g.fill();
      g.fillStyle = col; roundRect(g, -len / 2, -s * 0.27, len, s * 0.54, s * 0.16); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.25)'; roundRect(g, -len / 2 + 2, -s * 0.24, len - 4, s * 0.16, s * 0.08); g.fill();
      if (car.loco) {
        g.fillStyle = '#1A1C2E'; roundRect(g, -len * 0.05, -s * 0.18, len * 0.3, s * 0.36, s * 0.06); g.fill();
        g.fillStyle = '#2A2A2A'; g.beginPath(); g.arc(len * 0.36, 0, s * 0.1, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        for (let k = -1; k <= 1; k++) g.fillRect(k * len * 0.25 - s * 0.06, -s * 0.15, s * 0.12, s * 0.3);
      }
      if (tr.speed > 2.5) { g.fillStyle = '#FFFFFF'; g.fillRect(-len / 2 + 3, -s * 0.03, len - 6, s * 0.06); }
      g.restore();
      if (car.loco && this.ctx.settings.motion && this.rng.next() < 0.12) {
        const ch = pos(car.a + 0.15), q = this.toScreen(ch.x, ch.y);
        this.ctx.fx.particles.spawn(q.x, q.y, this.rng.range(-8, 8), -22, 0.9, s * 0.12, s * 0.32, 'rgba(240,240,240,0.5)', Shape.Dot, -10, 1);
      }
      if (tr.via >= 0 && !tr.visited && car.loco) {
        const q = this.toScreen(f.x, f.y - 0.55);
        g.fillStyle = COLORS[tr.via]; g.beginPath(); g.arc(q.x, q.y, s * 0.14, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#FFFFFF'; g.lineWidth = 1.5; g.stroke();
      }
    }
  }

  private drawWreck(g: CanvasRenderingContext2D): void {
    const s = this.s;
    for (const w of this.wreck) {
      const p = this.toScreen(w.x, w.y);
      g.save(); g.translate(p.x, p.y); g.rotate(w.a);
      g.fillStyle = w.color; roundRect(g, -s * 0.45, -s * 0.25, s * 0.9, s * 0.5, s * 0.12); g.fill();
      g.restore();
    }
  }

  private drawUi(g: CanvasRenderingContext2D): void {
    const { w } = this.ctx.canvas;
    const hov = this.ctx.input.hasHover ? this.ctx.input.hover : null;
    const room = titleRoom(this.btns, w - 64) - 16;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = C.text; g.font = `700 19px ${FONT.title}`;
    const title = this.level ? `${this.level.chapter} ${this.level.n} · ${this.def.name}` : `Endless · ${this.sim.delivered} home`;
    g.fillText(fitText(g, title, Math.min(room, w - 80)), 16, 30);
    g.fillStyle = C.muted; g.font = `600 13px ${FONT.ui}`;
    const flips = this.rec.filter((e) => e[2] === 'f').length;
    g.fillText(this.level ? `flips ${flips} / par ${this.def.par}${this.pausedTime > 0 ? ` · paused ${this.pausedTime.toFixed(1)} s` : ''}` : `next train in ${Math.max(0, this.nextSpawn - this.sim.t).toFixed(1)} s`, 16, 50);
    // Schedule strip: each train's colour and time, greyed once it has left the tunnel.
    if (this.level) {
      let x = 16;
      const y = 62;
      g.font = `700 12px ${FONT.ui}`;
      for (const tr of this.sim.trains) {
        const label = `${COLOR_NAMES[tr.color]} ${fmt(tr.spawn)}${tr.via >= 0 ? ` via ${COLOR_NAMES[tr.via]}` : ''}${tr.speed > 2.5 ? ' ⚡' : ''}`;
        const tw = g.measureText(label).width + 22;
        if (x + tw > w - 16) break;
        const gone = tr.state !== 'wait';
        g.globalAlpha = gone ? 0.35 : 1;
        roundRect(g, x, y, tw, 22, 11); g.fillStyle = rgba(COLORS[tr.color], 0.25); g.fill();
        g.fillStyle = COLORS[tr.color]; g.beginPath(); g.arc(x + 11, y + 11, 5, 0, Math.PI * 2); g.fill();
        g.fillStyle = C.text; g.textBaseline = 'middle'; g.fillText(label, x + 19, y + 12);
        g.globalAlpha = 1;
        x += tw + 6;
      }
      g.textBaseline = 'alphabetic';
    }
    for (const b of this.btns) drawBtn(g, b, ACCENT, !!hov && hitBtn([b], hov.x, hov.y) !== null, this.pressBtn === b.id ? 1 : 0);
    if (this.paused) {
      const p = this.toScreen(this.def.w / 2, this.def.h / 2);
      g.fillStyle = 'rgba(10,14,12,0.55)'; g.fillRect(0, 0, w, this.ctx.canvas.h);
      g.fillStyle = C.text; g.font = `700 30px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`⏱ paused ${this.pausedTime.toFixed(1)} s`, p.x, p.y);
    }
    if (this.phase === 'ready' && this.level?.id === '1-1') {
      // No text: pulse the switch that needs flipping.
      const n = this.net.switches[0];
      if (n !== undefined) {
        const p = this.toScreen(this.def.nodes[n].x, this.def.nodes[n].y);
        const k = (this.clock * 1.2) % 1;
        g.strokeStyle = rgba(C.yellow, 1 - k); g.lineWidth = 3;
        g.beginPath(); g.arc(p.x, p.y, this.s * (0.5 + k * 0.8), 0, Math.PI * 2); g.stroke();
      }
    }
    if (this.banner) {
      const b = this.banner;
      g.globalAlpha = Math.min(1, b.t * 3);
      g.font = `700 28px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(b.text).width + 40;
      const p = this.toScreen(this.def.w / 2, this.def.h / 2);
      roundRect(g, p.x - tw / 2, p.y - 28, tw, 56, 28); g.fillStyle = 'rgba(14,15,26,0.88)'; g.fill();
      g.fillStyle = b.color; g.fillText(b.text, p.x, p.y + 1);
      g.globalAlpha = 1;
    }
  }
}

function fmt(t: number): string { return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }


export default (): Game => new Switchyard();
