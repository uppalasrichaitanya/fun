import type { Drone, MusicSpec } from '../../engine/audio';
import { drawGlow } from '../../engine/glow';
import { clamp, damp, TAU } from '../../engine/math';
import { Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { ARENA, CFG, CpuBrain, SumoSim, type Blob, type BlobInput, type Difficulty } from './logic';

const MUSIC: MusicSpec = {
  bpm: 112, root: 62, wave: 'square', bass: true, kick: true, gain: 0.45,
  chords: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [5, 9, 12]],
  arp: [0, 1, 2, 1, 0, 2, 1, 2],
};
const W = 960, H = 640;
const N = 16;
const COL = [C.pink, C.cyan] as const;
const JOY_R = 56;

interface Soft { o: Float32Array; v: Float32Array }
interface Joy { id: number; ox: number; oy: number; x: number; y: number }
interface Chunk { a0: number; a1: number; r0: number; r1: number; t: number; rot: number }

class SumoBlobs implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private vis = new Rng();
  private sim = new SumoSim(this.rng);
  private demo = false;
  private cpu: [CpuBrain | null, CpuBrain | null] = [null, null];
  private soft: [Soft, Soft] = [this.makeSoft(), this.makeSoft()];
  private joys: [Joy | null, Joy | null] = [null, null];
  private dashPtr: [number, number] = [-1, -1];
  private touch = false;
  private betweenT = -1;
  private overT = -1;
  private camZoom = 1; private camX = W / 2; private camY = H / 2;
  private chunks: Chunk[] = [];
  private lastR: number = ARENA.r0;
  private crumble: Drone | null = null;
  private mode = '2p';
  private winPose = 0;

  private makeSoft(): Soft { return { o: new Float32Array(N), v: new Float32Array(N) }; }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.touch = matchMedia('(pointer: coarse)').matches;
    ctx.input.on('down', (p) => {
      if (p.type !== 'touch' || this.demo) return;
      this.touch = true;
      const vsCpu = this.mode !== '2p';
      // Dash buttons in each half's outer corner (bottom-right only vs CPU).
      for (const i of [0, 1] as const) {
        const b = this.dashBtn(i);
        if (b && Math.hypot(p.x - b.x, p.y - b.y) < b.r * 1.2) { this.dashPtr[i] = p.id; return; }
      }
      const side: 0 | 1 = vsCpu ? 0 : p.x < W / 2 ? 0 : 1;
      if (!this.joys[side]) this.joys[side] = { id: p.id, ox: p.x, oy: p.y, x: p.x, y: p.y };
    });
    ctx.input.on('move', (p) => {
      for (const j of this.joys) if (j && j.id === p.id) { j.x = p.x; j.y = p.y; }
    });
    ctx.input.on('up', (p) => {
      this.joys = this.joys.map((j) => (j && j.id === p.id ? null : j)) as [Joy | null, Joy | null];
      this.dashPtr = this.dashPtr.map((id) => (id === p.id ? -1 : id)) as [number, number];
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    this.vis.seed(seed ^ 0x3131);
    const [mode, ...flags] = (opts?.mode ?? '2p').split('+');
    this.mode = this.demo ? 'demo' : mode || '2p';
    this.sim = new SumoSim(this.rng);
    this.sim.chaos = flags.includes('chaos') || this.demo;
    this.sim.reset();
    const lv = (m: string): Difficulty => (m === 'easy' || m === 'hard' ? m : 'normal');
    this.cpu = this.demo
      ? [new CpuBrain(0, 'normal', new Rng(seed + 1)), new CpuBrain(1, 'hard', new Rng(seed + 2))]
      : this.mode === '2p' ? [null, null] : [null, new CpuBrain(1, lv(this.mode), new Rng(seed + 3))];
    this.soft = [this.makeSoft(), this.makeSoft()];
    this.joys = [null, null]; this.dashPtr = [-1, -1];
    this.betweenT = -1; this.overT = -1; this.camZoom = 1; this.camX = W / 2; this.camY = H / 2;
    this.chunks = []; this.lastR = ARENA.r0; this.winPose = 0;
    this.ctx.audio.music(MUSIC);
  }

  private dashBtn(i: 0 | 1): { x: number; y: number; r: number } | null {
    if (!this.touch) return null;
    const vsCpu = this.mode !== '2p';
    if (vsCpu) return i === 0 ? { x: W - 80, y: H - 80, r: 50 } : null;
    return i === 0 ? { x: 70, y: H - 70, r: 46 } : { x: W - 70, y: H - 70, r: 46 };
  }

  private readHuman(i: 0 | 1): BlobInput {
    const k = this.ctx.input;
    const vsCpu = this.mode !== '2p';
    let x = 0, y = 0, dash = false;
    const p1 = { u: 'KeyW', d: 'KeyS', l: 'KeyA', r: 'KeyD' }, p2 = { u: 'ArrowUp', d: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight' };
    const sets = vsCpu ? [p1, p2] : [i === 0 ? p1 : p2];
    for (const s of sets) {
      if (k.isDown(s.l)) x -= 1; if (k.isDown(s.r)) x += 1;
      if (k.isDown(s.u)) y -= 1; if (k.isDown(s.d)) y += 1;
    }
    const dashKeys = vsCpu ? ['Space', 'ShiftLeft', 'ShiftRight', 'Enter'] : i === 0 ? ['Space', 'ShiftLeft'] : ['Enter', 'ShiftRight', 'NumpadEnter'];
    dash = k.isDown(...dashKeys) || this.dashPtr[i] >= 0;
    const j = this.joys[i];
    if (j) {
      const dx = j.x - j.ox, dy = j.y - j.oy, d = Math.hypot(dx, dy);
      if (d > 8) { const m = Math.min(1, d / JOY_R); x = (dx / d) * m; y = (dy / d) * m; }
    }
    return { x, y, dash };
  }

  update(dt: number): void {
    const sim = this.sim, { fx, audio } = this.ctx;
    if (this.touch && this.ctx.canvas.portrait && !this.demo) return; // waiting for landscape
    const inputs = [0, 1].map((i) => {
      const brain = this.cpu[i];
      return brain ? brain.think(sim, dt) : this.demo ? { x: 0, y: 0, dash: false } : this.readHuman(i as 0 | 1);
    }) as [BlobInput, BlobInput];
    const prevCount = Math.ceil(sim.countdown);
    sim.step(dt, inputs);
    if (sim.countdown > 0 && Math.ceil(sim.countdown) !== prevCount) audio.tick(1200, 0.08);
    for (const e of sim.events) {
      switch (e.type) {
        case 'go': audio.tone({ f: 880, f2: 1320, type: 'square', d: 0.25, g: 0.1, lp: 3000 }); break;
        case 'dash': audio.whoosh(0.16, 0.18); this.squishDash(e.i); break;
        case 'bump': {
          const f = Math.min(1, e.force / 700);
          audio.tone({ f: 220 + f * 260, f2: 110 + f * 60, type: 'sine', a: 0.003, d: 0.22, g: 0.12 + f * 0.2 });
          this.impact(e.nx, e.ny, f);
          if (f > 0.4) { fx.camera.shake(0.15 + f * 0.25); fx.particles.burst(e.x, e.y, '#fff', { count: 8, speed: 200 * f, size: 3 }); }
          break;
        }
        case 'clash':
          fx.time.hitStop(90);
          fx.camera.shake(0.5);
          fx.particles.burst(e.x, e.y, C.yellow, { count: 26, speed: 420, size: 5, shape: Shape.Spark, colors: [C.yellow, '#fff', C.orange] });
          fx.floaters.add('CLASH!', e.x, e.y - 40, C.yellow, 30);
          audio.noise({ d: 0.9, a: 0.12, g: 0.15, f: 420, f2: 750, q: 5 });
          audio.thud(1);
          this.impact(1, 0, 1);
          break;
        case 'fall':
          audio.tone({ f: 1200, f2: 180, type: 'sine', a: 0.01, d: 0.7, g: 0.14 });
          break;
        case 'power':
          audio.sparkle(1046);
          fx.floaters.add(e.kind === 'mega' ? 'MEGA!' : e.kind === 'zoom' ? 'ZOOM!' : 'BOUNCY!', sim.blobs[e.i].x, sim.blobs[e.i].y - 50, COL[e.i], 22);
          break;
        case 'round':
          fx.time.slowMo(0.3, 500);
          this.betweenT = 0;
          if (e.winner === null) fx.floaters.add('DRAW - replay!', W / 2, 140, C.text, 30);
          else audio.chime(e.winner === 0 ? 4 : 7, 0.15);
          if (sim.matchOver) this.overT = 0;
          break;
      }
    }
    sim.events.length = 0;
    this.stepSoft(dt);
    // Crumbling edge: chunks break off as the platform shrinks.
    if (sim.radius < this.lastR - 6) {
      const a0 = this.vis.range(0, TAU);
      this.chunks.push({ a0, a1: a0 + this.vis.range(0.3, 0.7), r0: sim.radius, r1: this.lastR + 2, t: 0, rot: this.vis.range(-2, 2) });
      this.lastR = sim.radius;
    }
    for (const c of this.chunks) c.t += dt;
    this.chunks = this.chunks.filter((c) => c.t < 1.4);
    if (!this.ctx.preview) {
      if (!this.crumble) this.crumble = audio.drone('noise', 300);
      const shrinking = sim.t > ARENA.grace && sim.radius > ARENA.rMin && !sim.roundOver && sim.countdown <= 0;
      this.crumble.set(300, shrinking ? 0.04 : 0, 0.2);
    }
    // Camera: zoom toward the winner at round end.
    const w = sim.winner ?? null;
    if (this.betweenT >= 0) {
      this.betweenT += dt;
      const last = sim.blobs.find((b) => b.falling < 0) ?? sim.blobs[0];
      this.camZoom = damp(this.camZoom, 1.35, 3, dt);
      this.camX = damp(this.camX, last.x, 3, dt);
      this.camY = damp(this.camY, last.y, 3, dt);
      if (!sim.matchOver && this.betweenT > 1.8) { sim.newRound(); this.betweenT = -1; this.chunks = []; this.lastR = ARENA.r0; }
    } else {
      this.camZoom = damp(this.camZoom, 1, 4, dt);
      this.camX = damp(this.camX, W / 2, 4, dt);
      this.camY = damp(this.camY, H / 2, 4, dt);
    }
    if (this.overT >= 0) {
      this.overT += dt;
      this.winPose += dt;
      if (this.overT > 0.6 && this.overT - dt <= 0.6 && w !== null) {
        fx.particles.confetti(sim.blobs[w].x, sim.blobs[w].y, -Math.PI / 2, [COL[w], C.yellow, '#fff'], 60, 700);
        audio.fanfare();
        if (!this.demo) this.finish();
      }
      if (this.demo && this.overT > 3) this.start(this.rng.int(1, 1e9), { demo: true });
    }
  }

  private finish(): void {
    const s = this.sim, vsCpu = this.mode !== '2p';
    const names = vsCpu ? ['You', 'CPU'] : ['Pink', 'Cyan'];
    const w = s.winner ?? 0;
    this.ctx.shell.gameOver({
      score: vsCpu ? s.score[0] : Math.max(...s.score),
      title: vsCpu ? (w === 0 ? 'You win!' : 'CPU wins') : `${names[w]} wins!`,
      noScore: !vsCpu,
      rank: `${s.score[0]} - ${s.score[1]}`,
      stats: [
        { label: `${names[0]} rounds`, value: String(s.score[0]) },
        { label: `${names[1]} rounds`, value: String(s.score[1]) },
        { label: 'clashes', value: String(s.clashes) },
        { label: 'longest round', value: `${s.longest.toFixed(0)} s` },
      ],
      share: `Pocket Arcade - Sumo Blobs: ${names[w]} won ${s.score[w]}-${s.score[w ? 0 : 1]}`,
      dailyLabel: `${s.score[0]}-${s.score[1]}`,
    }, 1600);
  }

  // ---- soft body ----------------------------------------------------------------------

  private impact(nx: number, ny: number, f: number): void {
    for (const i of [0, 1] as const) {
      const sgn = i === 0 ? 1 : -1;
      for (let k = 0; k < N; k++) {
        const a = (k / N) * TAU, d = Math.cos(a) * nx * sgn + Math.sin(a) * ny * sgn;
        if (d > 0) this.soft[i].v[k] -= d * 260 * f;
      }
    }
  }

  private squishDash(i: number): void {
    const b = this.sim.blobs[i];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * TAU, d = Math.cos(a) * b.fx + Math.sin(a) * b.fy;
      this.soft[i].v[k] += (d * d - 0.5) * 220;
    }
  }

  private stepSoft(dt: number): void {
    for (const s of this.soft) {
      for (let k = 0; k < N; k++) {
        const l = s.o[(k + N - 1) % N], r = s.o[(k + 1) % N];
        const a = -200 * s.o[k] - 12 * s.v[k] + 60 * (l + r - 2 * s.o[k]);
        s.v[k] += a * dt; s.o[k] += s.v[k] * dt;
        s.o[k] = clamp(s.o[k], -14, 14);
      }
    }
  }

  // ---- render --------------------------------------------------------------------------

  render(): void {
    const { canvas, fx } = this.ctx;
    const g = canvas.begin('#0A0B16');
    const sim = this.sim;
    const bg = g.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, 600);
    bg.addColorStop(0, '#1A1638'); bg.addColorStop(1, '#07070F');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    fx.camera.begin(g, W, H);
    g.save();
    g.translate(W / 2, H / 2); g.scale(this.camZoom, this.camZoom); g.translate(-this.camX, -this.camY);
    // Glow under the platform, then the platform.
    drawGlow(g, C.violet, ARENA.x, ARENA.y + 30, sim.radius * 1.6, 0.35);
    g.fillStyle = '#2B2550';
    g.beginPath(); g.ellipse(ARENA.x, ARENA.y + 18, sim.radius, sim.radius * 0.96, 0, 0, TAU); g.fill();
    const pg = g.createRadialGradient(ARENA.x - 60, ARENA.y - 80, 20, ARENA.x, ARENA.y, sim.radius);
    pg.addColorStop(0, '#4A4384'); pg.addColorStop(1, '#2F2A5C');
    g.fillStyle = pg;
    g.beginPath(); g.arc(ARENA.x, ARENA.y, sim.radius, 0, TAU); g.fill();
    g.strokeStyle = rgba('#ffffff', 0.12); g.lineWidth = 3;
    g.beginPath(); g.arc(ARENA.x, ARENA.y, sim.radius * 0.5, 0, TAU); g.stroke();
    // Where the edge will be in 2 s.
    const future = sim.radiusAt(sim.t + 2);
    if (future < sim.radius - 1 && sim.countdown <= 0) {
      g.setLineDash([8, 8]); g.strokeStyle = rgba(C.pink, 0.35); g.lineWidth = 2;
      g.beginPath(); g.arc(ARENA.x, ARENA.y, future, 0, TAU); g.stroke(); g.setLineDash([]);
    }
    for (const c of this.chunks) {
      g.save();
      const mid = (c.a0 + c.a1) / 2, rm = (c.r0 + c.r1) / 2;
      g.translate(ARENA.x + Math.cos(mid) * rm, ARENA.y + Math.sin(mid) * rm + 400 * c.t * c.t);
      g.rotate(c.rot * c.t);
      g.globalAlpha = 1 - c.t / 1.4;
      g.fillStyle = '#3A3470';
      g.beginPath(); g.arc(-Math.cos(mid) * rm, -Math.sin(mid) * rm, c.r1, c.a0, c.a1); g.arc(-Math.cos(mid) * rm, -Math.sin(mid) * rm, c.r0, c.a1, c.a0, true); g.fill();
      g.restore();
    }
    if (sim.power) {
      const p = sim.power, col = p.kind === 'mega' ? C.orange : p.kind === 'zoom' ? C.green : C.violet;
      drawGlow(g, col, p.x, p.y, 34, 0.6);
      g.fillStyle = col; g.beginPath(); g.arc(p.x, p.y + Math.sin(p.t * 5) * 3, 13, 0, TAU); g.fill();
      g.fillStyle = C.bg; g.font = `700 13px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(p.kind === 'mega' ? 'M' : p.kind === 'zoom' ? 'Z' : 'B', p.x, p.y + Math.sin(p.t * 5) * 3 + 1);
    }
    // Dash recharge rings, then blobs (the falling one first, under the other).
    for (const b of [...sim.blobs].sort((a, c) => (c.falling >= 0 ? 1 : 0) - (a.falling >= 0 ? 1 : 0))) this.blob(g, b);
    fx.particles.render(g);
    fx.floaters.render(g);
    g.restore();
    fx.camera.end(g);
    this.hud(g);
    if (this.touch && !this.demo) this.touchUI(g);
    if (this.touch && this.ctx.canvas.portrait && !this.demo) {
      g.fillStyle = 'rgba(7,7,15,0.92)'; g.fillRect(0, 0, W, H);
      g.fillStyle = C.text; g.font = `700 40px ${FONT.title}`; g.textAlign = 'center';
      g.fillText('Rotate your phone', W / 2, H / 2);
      g.font = `500 20px ${FONT.ui}`; g.fillStyle = C.muted;
      g.fillText('Sumo Blobs plays in landscape', W / 2, H / 2 + 40);
    }
  }

  private blob(g: CanvasRenderingContext2D, b: Blob): void {
    const sim = this.sim, s = this.soft[b.i];
    const fall = b.falling >= 0 ? clamp(b.falling / CFG.fallTime, 0, 1) : 0;
    const r = sim.blobR(b) * (1 - fall * 0.6);
    const col = COL[b.i];
    if (b.falling < 0) {
      g.strokeStyle = rgba(col, 0.25); g.lineWidth = 4;
      g.beginPath(); g.arc(b.x, b.y + 4, r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - b.cool / CFG.dashCooldown)); g.stroke();
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.ellipse(b.x, b.y + r * 0.8, r * 0.9, r * 0.3, 0, 0, TAU); g.fill();
    }
    // Smooth closed curve through the soft-body ring.
    const pts: [number, number][] = [];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * TAU, rr = r + s.o[k] * (r / CFG.r);
      pts.push([b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr]);
    }
    g.globalAlpha = 1 - fall * 0.7;
    g.fillStyle = fall > 0 ? shade(col, -0.5 * fall) : col;
    g.beginPath();
    for (let k = 0; k <= N; k++) {
      const p = pts[k % N], q = pts[(k + 1) % N];
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      if (k === 0) g.moveTo(mx, my); else g.quadraticCurveTo(p[0], p[1], mx, my);
    }
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.ellipse(b.x - r * 0.35, b.y - r * 0.45, r * 0.28, r * 0.14, -0.5, 0, TAU); g.fill();
    if (b.bouncy) { g.strokeStyle = rgba(C.violet, 0.8); g.lineWidth = 3; g.beginPath(); g.arc(b.x, b.y, r + 5, 0, TAU); g.stroke(); }
    this.face(g, b, r);
    g.globalAlpha = 1;
  }

  /** Eyes look at the opponent; panicked near the edge, squinty when dashing, smug after winning. */
  private face(g: CanvasRenderingContext2D, b: Blob, r: number): void {
    const sim = this.sim, foe = sim.blobs[b.i ? 0 : 1];
    const dx = foe.x - b.x, dy = foe.y - b.y, d = Math.hypot(dx, dy) || 1;
    const lx = dx / d, ly = dy / d;
    const edge = Math.hypot(b.x - ARENA.x, b.y - ARENA.y) > sim.radius - r * 0.6;
    const won = sim.matchOver && sim.winner === b.i;
    const bounce = won ? Math.abs(Math.sin(this.winPose * 8)) * 10 : 0;
    const cx = b.x + lx * r * 0.18, cy = b.y - r * 0.12 - bounce;
    const er = r * (edge ? 0.26 : 0.2);
    for (const side of [-1, 1]) {
      const ex = cx + side * r * 0.32;
      if (b.dashT > 0 || won) {
        g.strokeStyle = '#1B1430'; g.lineWidth = 3; g.lineCap = 'round';
        g.beginPath(); g.moveTo(ex - er, cy - (won ? 2 : 0)); g.lineTo(ex + er, cy + (won ? 2 : 0) * side); g.stroke();
        continue;
      }
      g.fillStyle = '#fff'; g.beginPath(); g.arc(ex, cy, er, 0, TAU); g.fill();
      g.fillStyle = '#1B1430'; g.beginPath(); g.arc(ex + lx * er * 0.45, cy + ly * er * 0.45, er * (edge ? 0.35 : 0.5), 0, TAU); g.fill();
    }
    g.strokeStyle = '#1B1430'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath();
    if (won) g.arc(cx, cy + r * 0.28, r * 0.25, 0.1 * Math.PI, 0.9 * Math.PI);
    else if (edge) g.arc(cx, cy + r * 0.4, r * 0.12, 0, TAU);
    else g.arc(cx, cy + r * 0.3, r * 0.14, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
    if (edge && b.falling < 0) {
      // Sweat drop.
      g.fillStyle = C.cyan;
      g.beginPath(); g.moveTo(b.x + r * 0.7, b.y - r * 0.7); g.quadraticCurveTo(b.x + r * 0.95, b.y - r * 0.35, b.x + r * 0.7, b.y - r * 0.3);
      g.quadraticCurveTo(b.x + r * 0.45, b.y - r * 0.35, b.x + r * 0.7, b.y - r * 0.7); g.fill();
    }
  }

  private hud(g: CanvasRenderingContext2D): void {
    const sim = this.sim, vsCpu = this.mode !== '2p' && this.mode !== 'demo';
    const names = vsCpu ? ['YOU', 'CPU'] : ['P1', 'P2'];
    g.textBaseline = 'middle';
    for (const i of [0, 1] as const) {
      const x = i === 0 ? 40 : W - 40;
      g.textAlign = i === 0 ? 'left' : 'right';
      g.fillStyle = COL[i]; g.font = `700 22px ${FONT.title}`;
      g.fillText(names[i], x, 36);
      for (let k = 0; k < CFG.winRounds; k++) {
        const px = i === 0 ? x + 8 + k * 26 : x - 8 - k * 26;
        g.beginPath(); g.arc(px, 66, 9, 0, TAU);
        g.fillStyle = k < sim.score[i] ? COL[i] : 'rgba(255,255,255,0.12)';
        g.fill();
      }
    }
    if (sim.countdown > 0 && !sim.matchOver && !this.demo) {
      const n = Math.ceil(sim.countdown * 1.5);
      const k = (sim.countdown * 1.5) % 1;
      g.textAlign = 'center';
      g.font = `700 ${Math.round(110 * ease.outBack(clamp(1 - k, 0, 1)))}px ${FONT.title}`;
      g.fillStyle = '#fff';
      g.fillText(n >= 1 ? String(Math.min(3, n)) : '', W / 2, H / 2 - 20);
    } else if (sim.t < 0.6 && !sim.roundOver) {
      g.textAlign = 'center';
      g.globalAlpha = 1 - sim.t / 0.6;
      g.font = `700 120px ${FONT.title}`; g.fillStyle = C.yellow;
      g.fillText('GO!', W / 2, H / 2 - 20);
      g.globalAlpha = 1;
    }
  }

  private touchUI(g: CanvasRenderingContext2D): void {
    for (const i of [0, 1] as const) {
      const j = this.joys[i];
      if (j) {
        g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 3;
        g.beginPath(); g.arc(j.ox, j.oy, JOY_R, 0, TAU); g.stroke();
        const dx = j.x - j.ox, dy = j.y - j.oy, d = Math.min(JOY_R, Math.hypot(dx, dy)), a = Math.atan2(dy, dx);
        g.fillStyle = rgba(COL[i], 0.6);
        g.beginPath(); g.arc(j.ox + Math.cos(a) * d, j.oy + Math.sin(a) * d, 24, 0, TAU); g.fill();
      }
      const b = this.dashBtn(i);
      if (b) {
        g.fillStyle = this.dashPtr[i] >= 0 ? rgba(COL[i], 0.6) : 'rgba(255,255,255,0.12)';
        g.beginPath(); g.arc(b.x, b.y, b.r, 0, TAU); g.fill();
        g.fillStyle = '#fff'; g.font = `700 18px ${FONT.title}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('DASH', b.x, b.y);
      }
    }
  }

  pause(): void { this.crumble?.set(300, 0, 0.05); }
  resume(): void {}
  destroy(): void { this.crumble?.stop(); this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number | string> {
    const s = this.sim;
    return { t: s.t, radius: s.radius, score: s.score.join('-'), clashes: s.clashes, mode: this.mode };
  }
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * (1 + k));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export default (): Game => new SumoBlobs();
