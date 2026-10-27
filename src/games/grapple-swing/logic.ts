import { Rng } from '../../engine/rng';

export const CFG = {
  gravity: 1500,
  drag: 0.0008,          // quadratic air drag coefficient
  minVx: 120,
  maxSpeed: 1400,
  reach: 280,
  behind: 40,
  aimAngle: (55 * Math.PI) / 180,
  reel: 0.04,
  minRope: 40,
  hookTime: 0.07,
  perfectLo: (20 * Math.PI) / 180,
  perfectHi: (50 * Math.PI) / 180,
  perfectFrac: 0.85,
  perfectBoost: 0.08,
  perfectMax: 3,
  crumbleAfter: 0.8,
  chunk: 600,
  seg: 50,
  r: 12,
  star: 25,
  unitsPerMeter: 10,
} as const;

export type AnchorKind = 'fixed' | 'moving' | 'crumble';
export interface Anchor {
  x0: number; y0: number;
  kind: AnchorKind;
  rail: number;          // moving: amplitude along x
  phase: number;
  broken: boolean;
  /** Time attached (crumbling anchors break at 0.8 s). */
  held: number;
}
export interface Spike { x: number; y: number; up: boolean }
export interface Star { x: number; y: number; taken: boolean }

export interface Chunk {
  i: number;
  x: number;
  ceil: number[];        // y at x + k * seg, k = 0..12
  floor: number[];
  anchors: Anchor[];
  spikes: Spike[];
  stars: Star[];
}

/** Difficulty band by distance in metres. */
export function band(m: number): { gap: [number, number]; vary: number; spikes: boolean; moving: boolean; crumble: boolean; narrow: boolean } {
  if (m < 100) return { gap: [160, 220], vary: 30, spikes: false, moving: false, crumble: false, narrow: false };
  if (m < 400) return { gap: [200, 280], vary: 60, spikes: true, moving: false, crumble: false, narrow: false };
  if (m < 800) return { gap: [220, 300], vary: 90, spikes: true, moving: true, crumble: false, narrow: false };
  return { gap: [240, 320], vary: 90, spikes: true, moving: true, crumble: true, narrow: true };
}

export function anchorPos(a: Anchor, t: number): { x: number; y: number } {
  if (a.kind !== 'moving') return { x: a.x0, y: a.y0 };
  return { x: a.x0 + Math.sin(t * 1.6 + a.phase) * a.rail, y: a.y0 };
}

/** Endless seeded cave, generated in 600 u chunks. */
export class Cave {
  chunks: Chunk[] = [];
  private rng: Rng;
  private lastAnchorX = 260;
  constructor(readonly seed: number) { this.rng = new Rng(seed); }

  reset(): void {
    this.rng = new Rng(this.seed);
    this.chunks = [];
    this.lastAnchorX = 260;
  }

  /** Make sure chunks exist up to x. */
  ensure(x: number): void {
    while (!this.chunks.length || this.chunks[this.chunks.length - 1].x + CFG.chunk < x + 1400) this.addChunk();
    // Forget chunks far behind.
    while (this.chunks.length > 2 && this.chunks[1].x + CFG.chunk < x - 900) this.chunks.shift();
  }

  private addChunk(): void {
    const prev = this.chunks[this.chunks.length - 1];
    const i = prev ? prev.i + 1 : 0;
    const x = i * CFG.chunk;
    // Try generating until the validation bot clears it.
    let c: Chunk | null = null;
    const startAnchor = this.lastAnchorX;
    for (let attempt = 0; attempt < 12; attempt++) {
      const seedAt = this.rng.int(0, 2 ** 31);
      c = this.makeChunk(i, x, prev, new Rng(seedAt), startAnchor, attempt > 8);
      if (i === 0 || validate(c, prev)) break;
    }
    this.lastAnchorX = c!.anchors.length ? c!.anchors[c!.anchors.length - 1].x0 : startAnchor;
    this.chunks.push(c!);
  }

  private makeChunk(i: number, x: number, prev: Chunk | undefined, rng: Rng, lastX: number, easy: boolean): Chunk {
    const m = x / CFG.unitsPerMeter;
    const b = band(m);
    const n = CFG.chunk / CFG.seg;
    const ceil: number[] = [], floor: number[] = [];
    const top0 = prev ? prev.ceil[n] : 60, bot0 = prev ? prev.floor[n] : 560;
    const narrow = b.narrow ? 50 : 0;
    for (let k = 0; k <= n; k++) {
      if (k === 0) { ceil.push(top0); floor.push(bot0); continue; }
      ceil.push(clamp(ceil[k - 1] + rng.range(-22, 22), 20, 110));
      floor.push(clamp(floor[k - 1] + rng.range(-30, 30), 500 - narrow, 590 - narrow * 0.5));
    }
    const at = (arr: number[], xx: number) => {
      const f = (xx - x) / CFG.seg, k = Math.max(0, Math.min(n - 1, Math.floor(f)));
      return arr[k] + (arr[k + 1] - arr[k]) * (f - k);
    };
    const anchors: Anchor[] = [];
    let ax = Math.max(lastX + rng.range(b.gap[0], b.gap[1]), x + 20);
    if (i === 0) ax = 260;
    let ay = 0;
    while (ax < x + CFG.chunk) {
      const gap = easy ? b.gap[0] : rng.range(b.gap[0], b.gap[1]);
      const c = at(ceil, ax);
      ay = clamp(c + 60 + rng.range(0, b.vary) + (easy ? 0 : rng.range(-10, 30)), c + 40, c + 170);
      let kind: AnchorKind = 'fixed';
      if (!easy && i > 0) {
        if (b.crumble && rng.chance(0.25)) kind = 'crumble';
        else if (b.moving && rng.chance(0.3)) kind = 'moving';
      }
      anchors.push({ x0: ax, y0: ay, kind, rail: kind === 'moving' ? rng.range(25, 45) : 0, phase: rng.range(0, 6.28), broken: false, held: 0 });
      ax += gap;
    }
    const spikes: Spike[] = [];
    if (b.spikes && !easy) {
      for (let k = 1; k < n; k++) {
        if (!rng.chance(0.18)) continue;
        const sx = x + k * CFG.seg + rng.range(-10, 10);
        // Ceiling spikes never right next to an anchor (anchors must stay reachable).
        if (anchors.some((a) => Math.abs(a.x0 - sx) < 70)) continue;
        spikes.push({ x: sx, y: at(ceil, sx), up: false });
      }
    }
    // Floor spikes are scenery on the deadly floor.
    for (let k = 1; k < n; k += 3) spikes.push({ x: x + k * CFG.seg, y: at(floor, x + k * CFG.seg), up: true });
    // Stars: high, where a perfect release flies (above and between anchors).
    const stars: Star[] = [];
    for (let k = 1; k < anchors.length; k++) {
      if (!rng.chance(0.45)) continue;
      const a = anchors[k - 1], b2 = anchors[k];
      stars.push({ x: (a.x0 + b2.x0) / 2 + 30, y: Math.max(at(ceil, (a.x0 + b2.x0) / 2) + 40, Math.min(a.y0, b2.y0) + 10), taken: false });
    }
    return { i, x, ceil, floor, anchors, spikes, stars };
  }

  chunkAt(x: number): Chunk | undefined {
    for (const c of this.chunks) if (x >= c.x && x < c.x + CFG.chunk) return c;
    return undefined;
  }

  ceilAt(x: number): number { return this.sample(x, 'ceil'); }
  floorAt(x: number): number { return this.sample(x, 'floor'); }
  private sample(x: number, key: 'ceil' | 'floor'): number {
    const c = this.chunkAt(x) ?? this.chunks[this.chunks.length - 1];
    if (!c) return key === 'ceil' ? 60 : 560;
    const arr = c[key], n = arr.length - 1;
    const f = (x - c.x) / CFG.seg, k = Math.max(0, Math.min(n - 1, Math.floor(f)));
    return arr[k] + (arr[k + 1] - arr[k]) * Math.min(1, Math.max(0, f - k));
  }

  *anchors(): Generator<Anchor> { for (const c of this.chunks) for (const a of c.anchors) yield a; }
  *spikes(): Generator<Spike> { for (const c of this.chunks) for (const s of c.spikes) yield s; }
  *stars(): Generator<Star> { for (const c of this.chunks) for (const s of c.stars) yield s; }
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export type SwingEvent =
  | { type: 'fire'; hit: boolean; x: number; y: number }
  | { type: 'attach'; x: number; y: number }
  | { type: 'release'; perfect: boolean; streak: number; speed: number }
  | { type: 'crumble'; x: number; y: number }
  | { type: 'star'; x: number; y: number }
  | { type: 'dead'; x: number; y: number; cause: 'void' | 'spike' };

/** The player and the rope. */
export class Swinger {
  x = 120; y = 300; vx = 380; vy = -120;
  t = 0;
  anchor: Anchor | null = null;
  hookT = 0;               // >0 while the hook is in flight
  rope = 0;
  attached = false;
  missT = 0; missX = 0; missY = 0;
  peak = 0;
  streak = 0;
  boost = 0;
  perfects = 0;
  topSpeed = 0;
  stars = 0;
  dead = false;
  events: SwingEvent[] = [];
  private holding = false;
  /** Ghost copies (bot lookahead) never change the world. */
  ghost = false;
  private ghostHeld = 0;

  constructor(readonly cave: Cave) {}

  /** A ghost copy for lookahead simulation. */
  fork(): Swinger {
    const g = new Swinger(this.cave);
    g.ghost = true;
    g.x = this.x; g.y = this.y; g.vx = this.vx; g.vy = this.vy; g.t = this.t;
    g.anchor = this.anchor; g.hookT = this.hookT; g.rope = this.rope; g.attached = this.attached;
    g.peak = this.peak; g.holding = this.holding; g.ghostHeld = this.anchor?.held ?? 0;
    return g;
  }

  reset(): void {
    this.x = 120; this.y = 300; this.vx = 380; this.vy = -120; this.t = 0;
    this.anchor = null; this.hookT = 0; this.rope = 0; this.attached = false; this.missT = 0;
    this.peak = 0; this.streak = 0; this.boost = 0; this.perfects = 0; this.topSpeed = 0; this.stars = 0;
    this.dead = false; this.events = []; this.holding = false;
  }

  get distance(): number { return Math.max(0, (this.x - 120) / CFG.unitsPerMeter); }

  /** The anchor a press would grab right now (the highlighted one). */
  select(): Anchor | null {
    let best: Anchor | null = null, bestErr = Infinity;
    for (const a of this.cave.anchors()) {
      if (a.broken) continue;
      const p = anchorPos(a, this.t);
      const dx = p.x - this.x, dy = this.y - p.y;
      if (dx < -CFG.behind || dy <= 0) continue;
      const d = Math.hypot(dx, dy);
      if (d > CFG.reach) continue;
      const err = Math.abs(Math.atan2(dy, dx) - CFG.aimAngle);
      if (err < bestErr) { bestErr = err; best = a; }
    }
    return best;
  }

  step(dt: number, hold: boolean): void {
    if (this.dead) return;
    this.t += dt;
    this.cave.ensure(this.x);
    if (hold && !this.holding) this.press();
    if (!hold && this.holding) this.release();
    this.holding = hold;
    // Hook flight, then the rope engages.
    if (this.anchor && !this.attached) {
      this.hookT -= dt;
      if (this.hookT <= 0) {
        const p = anchorPos(this.anchor, this.t);
        this.rope = Math.max(CFG.minRope, Math.hypot(this.x - p.x, this.y - p.y));
        this.attached = true;
        this.peak = Math.hypot(this.vx, this.vy);
        this.events.push({ type: 'attach', x: p.x, y: p.y });
      }
    }
    if (this.missT > 0) this.missT -= dt;
    // Integrate.
    this.vy += CFG.gravity * dt;
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 0) {
      const k = Math.min(0.5, CFG.drag * sp * dt);
      this.vx -= this.vx * k; this.vy -= this.vy * k;
    }
    if (!this.attached && this.vx < CFG.minVx) this.vx = CFG.minVx;
    this.x += this.vx * dt; this.y += this.vy * dt;
    // Rope: inextensible, reeling in slowly.
    if (this.attached && this.anchor) {
      const a = this.anchor;
      const held = this.ghost ? (this.ghostHeld += dt) : (a.held += dt);
      if (a.kind === 'crumble' && held >= CFG.crumbleAfter) {
        if (!this.ghost) a.broken = true;
        const p = anchorPos(a, this.t);
        this.events.push({ type: 'crumble', x: p.x, y: p.y });
        this.detach();
      } else {
        this.rope = Math.max(CFG.minRope, this.rope - this.rope * CFG.reel * dt);
        const p = anchorPos(a, this.t);
        const dx = this.x - p.x, dy = this.y - p.y, d = Math.hypot(dx, dy);
        if (d > this.rope) {
          const nx = dx / d, ny = dy / d;
          this.x = p.x + nx * this.rope; this.y = p.y + ny * this.rope;
          const out = this.vx * nx + this.vy * ny;
          if (out > 0) { this.vx -= out * nx; this.vy -= out * ny; }
        }
        this.peak = Math.max(this.peak, Math.hypot(this.vx, this.vy));
      }
    }
    const s2 = Math.hypot(this.vx, this.vy);
    if (s2 > CFG.maxSpeed) { this.vx *= CFG.maxSpeed / s2; this.vy *= CFG.maxSpeed / s2; }
    this.topSpeed = Math.max(this.topSpeed, Math.min(CFG.maxSpeed, s2));
    this.collide();
  }

  private press(): void {
    const a = this.select();
    if (!a) {
      this.missT = 0.18;
      this.missX = this.x + Math.cos(CFG.aimAngle) * CFG.reach;
      this.missY = this.y - Math.sin(CFG.aimAngle) * CFG.reach;
      this.events.push({ type: 'fire', hit: false, x: this.missX, y: this.missY });
      return;
    }
    this.anchor = a;
    if (this.ghost) this.ghostHeld = 0; else a.held = 0;
    this.attached = false;
    this.hookT = CFG.hookTime;
    const p = anchorPos(a, this.t);
    this.events.push({ type: 'fire', hit: true, x: p.x, y: p.y });
  }

  private release(): void {
    if (!this.anchor) return;
    const wasAttached = this.attached;
    this.detach();
    if (!wasAttached) return;
    // Perfect release: 20-50 degrees above horizontal, moving forward, near the swing's peak speed.
    const sp = Math.hypot(this.vx, this.vy), ang = Math.atan2(-this.vy, this.vx);
    const perfect = this.vx > 0 && ang >= CFG.perfectLo && ang <= CFG.perfectHi && sp >= this.peak * CFG.perfectFrac;
    if (perfect) {
      this.streak = Math.min(CFG.perfectMax, this.streak + 1);
      const k = 1 + CFG.perfectBoost;
      this.vx *= k; this.vy *= k;
      this.perfects++;
    } else this.streak = 0;
    this.events.push({ type: 'release', perfect, streak: this.streak, speed: sp });
  }

  private detach(): void { this.anchor = null; this.attached = false; this.hookT = 0; }

  private collide(): void {
    const r = CFG.r, c = this.cave;
    const top = c.ceilAt(this.x);
    if (this.y - r < top) {
      this.y = top + r;
      if (this.vy < 0) this.vy *= -0.3;
    }
    if (this.y + r > c.floorAt(this.x)) { this.die('void'); return; }
    for (const s of c.spikes()) {
      if (Math.abs(s.x - this.x) > 30) continue;
      const tipY = s.up ? s.y - 26 : s.y + 26;
      if (Math.hypot(this.x - s.x, this.y - (s.y + tipY) / 2) < r + 12) { this.die('spike'); return; }
    }
    for (const st of c.stars()) {
      if (this.ghost) break;
      if (st.taken || Math.abs(st.x - this.x) > 30) continue;
      if (Math.hypot(st.x - this.x, st.y - this.y) < r + 16) {
        st.taken = true; this.stars++;
        this.events.push({ type: 'star', x: st.x, y: st.y });
      }
    }
  }

  private die(cause: 'void' | 'spike'): void {
    this.dead = true;
    this.detach();
    this.events.push({ type: 'dead', x: this.x, y: this.y, cause });
  }
}

/**
 * Simple swing bot: grabs the highlighted anchor when it is ahead, releases on
 * the perfect window (or once well past the anchor). Used by the attract demo
 * and to validate generated chunks.
 */
export class SwingBot {
  private releasedT = 0;
  private think = 0;
  hold = false;
  constructor(private s: Swinger, private lookahead = true) {}

  /** Would letting go now lead to a safe grab further on? (ghost simulation) */
  private safeRelease(s: Swinger): boolean {
    if (!this.lookahead) return true;
    const from = s.anchor;
    const g = s.fork();
    const bot = new SwingBot(g, false);
    bot.hold = false;
    let grabbed = false;
    for (let k = 0; k < 150 && !g.dead; k++) {
      const h = bot.update(1 / 120);
      g.step(1 / 120, h);
      if (g.attached && g.anchor && g.anchor !== from) {
        if (!grabbed) { grabbed = true; k = Math.max(k, 110); }
      }
    }
    return grabbed && !g.dead;
  }

  update(dt: number): boolean {
    const s = this.s;
    this.releasedT += dt;
    if (!this.hold) {
      const a = s.select();
      if (a && this.releasedT > 0.12) {
        const p = anchorPos(a, s.t);
        const elev = Math.atan2(s.y - p.y, p.x - s.x), d = Math.hypot(p.x - s.x, s.y - p.y);
        const low = s.y > s.cave.floorAt(s.x) - 230;
        // Fall until the anchor sits near the 55 degree aim (long rope, fast swing), unless getting low.
        if ((elev < CFG.aimAngle + 0.1 && d > 170 && s.vy > -100 && p.x > s.x + 40) || low) this.hold = true;
      }
      return this.hold;
    }
    if (!s.anchor) { this.hold = false; this.releasedT = 0; return false; }
    if (!s.attached) return true;
    const ang = Math.atan2(-s.vy, s.vx), sp = Math.hypot(s.vx, s.vy);
    const inWindow = s.vx > 0 && ang >= CFG.perfectLo + 0.02 && ang <= CFG.perfectHi - 0.04 && sp >= s.peak * (CFG.perfectFrac + 0.01);
    const late = (s.vx > 0 && ang > 0.5) || s.vx < 0 || (s.anchor.kind === 'crumble' && s.anchor.held > CFG.crumbleAfter - 0.1);
    this.think -= dt;
    if ((inWindow || late) && this.think <= 0) {
      this.think = 0.03;
      if (this.safeRelease(s)) { this.hold = false; this.releasedT = 0; }
    }
    return this.hold;
  }
}

/** Can the bot fly through this chunk, entering from the previous one? */
function validate(c: Chunk, prev: Chunk | undefined): boolean {
  const cave = new Cave(0);
  cave.chunks = [...(prev ? [cloneChunk(prev)] : []), cloneChunk(c)];
  // Freeze generation: the validator only sees these chunks.
  cave.ensure = () => {};
  const s = new Swinger(cave);
  const start = prev?.anchors[prev.anchors.length - 1];
  if (start) {
    s.x = start.x0 - 60; s.y = start.y0 + 120; s.vx = 420; s.vy = -60;
  } else { s.x = c.x; s.y = 300; }
  // The fast bot (no lookahead) keeps generation cheap enough to run mid-game.
  const bot = new SwingBot(s, false);
  for (let k = 0; k < 120 * 6 && !s.dead; k++) {
    s.step(1 / 120, bot.update(1 / 120));
    if (s.x > c.x + CFG.chunk + 40) return true;
    if (s.x > c.x + CFG.chunk - 1 && !c.anchors.length) return true;
  }
  return false;
}

function cloneChunk(c: Chunk): Chunk {
  return { ...c, anchors: c.anchors.map((a) => ({ ...a })), spikes: c.spikes, stars: c.stars.map((s) => ({ ...s })), ceil: c.ceil, floor: c.floor };
}
