import type { Rng } from '../../engine/rng';
import { CFG, DANGER_Y, HOLD_Y, JAR, SPAWN_WEIGHTS, TIERS } from './config';

export interface Ball {
  id: number;
  tier: number;          // 0-based
  x: number; y: number;
  px: number; py: number; // position at substep start (PBD)
  vx: number; vy: number;
  r: number;              // current radius (tweens on merge)
  r0: number;             // radius at merge start
  grow: number;           // 0..1 merge grow-in progress
  age: number;            // seconds since dropped / created
  still: number;          // seconds below the sleep speed
  sleeping: boolean;
  dead: boolean;
  merged: boolean;        // merged this tick
  // Visual state.
  sq: number; sqv: number; // squash spring (1 = round)
  blink: number;
  impact: number;          // last big impact speed, for sound/squash
}

export type SimEvent =
  | { type: 'merge'; tier: number; x: number; y: number; pts: number; chain: number; mult: number }
  | { type: 'supernova'; x: number; y: number; pts: number }
  | { type: 'land'; x: number; y: number; speed: number; tier: number }
  | { type: 'drop'; tier: number; x: number }
  | { type: 'over' };

/**
 * Merge Drop simulation: position-based circle solver (4 substeps x 6
 * iterations per 120 Hz tick) inside a rounded jar, plus the merge rules.
 */
export class MergeSim {
  balls: Ball[] = [];
  held = 0;
  next = 0;
  aimX = (JAR.l + JAR.r) / 2;
  cooldown = 0;
  score = 0;
  dropped = 0;
  biggest = 0;
  chain = 0;            // merges in the current chain
  bestChain = 0;
  lastMerge = -10;
  t = 0;
  danger = 0;           // seconds the pile has stayed above the line
  over = false;
  private ids = 0;
  private order: Ball[] = [];
  events: SimEvent[] = [];

  constructor(private rng: Rng) {}

  reset(): void {
    this.balls = [];
    this.held = this.roll();
    this.next = this.roll();
    this.aimX = (JAR.l + JAR.r) / 2;
    this.cooldown = 0; this.score = 0; this.dropped = 0; this.biggest = this.held;
    this.chain = 0; this.bestChain = 0; this.lastMerge = -10; this.t = 0; this.danger = 0; this.over = false;
    this.events = [];
  }

  private roll(): number { return this.rng.weighted(SPAWN_WEIGHTS); }

  get heldR(): number { return TIERS[this.held].r; }

  clampAim(x: number): number {
    const r = this.heldR;
    return Math.max(JAR.l + r + 1, Math.min(JAR.r - r - 1, x));
  }

  canDrop(): boolean { return !this.over && this.cooldown <= 0; }

  drop(): boolean {
    if (!this.canDrop() || this.balls.length >= CFG.maxBalls) return false;
    const x = this.clampAim(this.aimX);
    this.spawn(this.held, x, HOLD_Y, 0, 60);
    this.events.push({ type: 'drop', tier: this.held, x });
    this.held = this.next;
    this.next = this.roll();
    this.cooldown = CFG.cooldown;
    this.dropped++;
    // A fresh drop resets the danger timer, unless the pile is already over the rim.
    if (!this.aboveRim()) this.danger = 0;
    return true;
  }

  private spawn(tier: number, x: number, y: number, vx: number, vy: number, growFrom = 0): Ball {
    const r = TIERS[tier].r;
    const h = 1 / 120 / CFG.substeps;
    const b: Ball = {
      id: ++this.ids, tier, x, y, px: x - vx * h, py: y - vy * h, vx, vy,
      r: growFrom || r, r0: growFrom || r, grow: growFrom ? 0 : 1, age: 0, still: 0, sleeping: false, dead: false, merged: false,
      sq: 1, sqv: 0, blink: 1.5 + this.rng.next() * 4, impact: 0,
    };
    this.balls.push(b);
    if (tier > this.biggest) this.biggest = tier;
    return b;
  }

  private aboveRim(): boolean {
    return this.balls.some((b) => b.age >= CFG.settleAge && b.y - b.r < JAR.rim);
  }

  step(dt: number): void {
    this.t += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    // Grow merged balls before solving so the solver always sees the real radius.
    for (const b of this.balls) {
      if (b.grow >= 1) continue;
      b.grow = Math.min(1, b.grow + dt / CFG.growTime);
      const k = b.grow, c1 = 1.70158, c3 = c1 + 1;
      const e = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
      b.r = b.r0 + (TIERS[b.tier].r - b.r0) * e;
      b.sleeping = false;
    }
    const n = CFG.substeps, h = dt / n;
    // Merge on contact both before and after solving, so overlapping balls never get pushed apart unmerged.
    this.merges();
    for (let s = 0; s < n; s++) this.substep(h);
    this.merges();
    for (const b of this.balls) {
      b.age += dt;
      b.merged = false;
      // Sleep after staying slow; wakes on contact.
      const sp = Math.hypot(b.vx, b.vy);
      if (!b.sleeping) {
        b.still = sp < CFG.sleepSpeed && b.grow >= 1 ? b.still + dt : 0;
        if (b.still >= CFG.sleepTime) { b.sleeping = true; b.vx = b.vy = 0; }
      }
      // Squash spring (k=300, d=18).
      b.sqv += (-300 * (b.sq - 1) - 18 * b.sqv) * dt;
      b.sq += b.sqv * dt;
      b.blink -= dt;
      if (b.blink < -0.12) b.blink = 3 + this.rng.next() * 3;
    }
    this.checkDanger(dt);
  }

  private substep(h: number): void {
    const g = CFG.gravity;
    for (const b of this.balls) {
      b.px = b.x; b.py = b.y;
      if (b.sleeping) continue;
      b.vy += g * h;
      b.vx *= CFG.damping; b.vy *= CFG.damping;
      b.x += b.vx * h; b.y += b.vy * h;
    }
    const order = this.sortBalls();
    for (let it = 0; it < CFG.iterations; it++) {
      this.solvePairs(order);
      for (const b of this.balls) this.solveWalls(b);
    }
    for (const b of this.balls) {
      if (b.sleeping) { b.x = b.px; b.y = b.py; continue; }
      let vx = (b.x - b.px) / h, vy = (b.y - b.py) / h;
      // Deep overlaps are pushed out over several substeps instead of launching balls.
      const dvx = vx - b.vx, dvy = vy - b.vy, dv = Math.hypot(dvx, dvy);
      if (dv > CFG.maxPush) {
        const k = CFG.maxPush / dv;
        vx = b.vx + dvx * k; vy = b.vy + dvy * k;
        if (dvy < 0 && vy > 0) vy = 0;
      }
      // Landing: a sudden stop after falling.
      const before = Math.hypot(b.vx, b.vy), after = Math.hypot(vx, vy);
      if (before - after > 260 && before > 300) {
        b.impact = before;
        b.sqv -= Math.min(6, before / 120);
        this.events.push({ type: 'land', x: b.x, y: b.y + b.r, speed: before, tier: b.tier });
      }
      b.vx = vx; b.vy = vy;
    }
  }

  /** Sweep-and-prune order by left edge (insertion sort: nearly sorted every substep). */
  private sortBalls(): Ball[] {
    const o = this.order;
    o.length = 0;
    for (const b of this.balls) o.push(b);
    for (let i = 1; i < o.length; i++) {
      const v = o[i], k = v.x - v.r;
      let j = i - 1;
      while (j >= 0 && o[j].x - o[j].r > k) { o[j + 1] = o[j]; j--; }
      o[j + 1] = v;
    }
    return o;
  }

  private solvePairs(o: Ball[]): void {
    for (let i = 0; i < o.length; i++) {
      const a = o[i];
      const ar = a.x + a.r;
      for (let j = i + 1; j < o.length; j++) {
        const b = o[j];
        if (b.x - b.r > ar) break;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const pen = rr - d;
        // Sleepers act as static until pushed hard.
        if (a.sleeping && b.sleeping) continue;
        if (a.sleeping && pen > 1.2) this.wake(a);
        if (b.sleeping && pen > 1.2) this.wake(b);
        const wa = a.sleeping ? 0 : 1 / (a.r * a.r), wb = b.sleeping ? 0 : 1 / (b.r * b.r);
        const w = wa + wb;
        if (w === 0) continue;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * pen * wa / w; a.y -= ny * pen * wa / w;
        b.x += nx * pen * wb / w; b.y += ny * pen * wb / w;
        // Position-based friction: cancel part of the relative sliding since the substep began.
        const rvx = (b.x - b.px) - (a.x - a.px), rvy = (b.y - b.py) - (a.y - a.py);
        const tx = -ny, ty = nx;
        const slide = (rvx * tx + rvy * ty) * CFG.friction / CFG.iterations;
        a.x += tx * slide * wa / w; a.y += ty * slide * wa / w;
        b.x -= tx * slide * wb / w; b.y -= ty * slide * wb / w;
      }
    }
  }

  /** The valid centres for radius r: the jar shrunk by r, corners rounded by max(0, 24 - r). */
  private solveWalls(b: Ball): void {
    if (b.sleeping) return;
    const r = b.r, c = JAR.corner;
    const minX = JAR.l + r, maxX = JAR.r - r, maxY = JAR.bottom - r;
    if (b.x < minX) { b.x = minX; this.wallFriction(b, false); }
    if (b.x > maxX) { b.x = maxX; this.wallFriction(b, false); }
    if (b.y > maxY) { b.y = maxY; this.wallFriction(b, true); }
    if (r < c) {
      const cy = JAR.bottom - c;
      for (const cx of [JAR.l + c, JAR.r - c]) {
        const inX = cx < 200 ? b.x < cx : b.x > cx;
        if (!inX || b.y < cy) continue;
        const dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy), lim = c - r;
        if (d > lim) { b.x = cx + dx / d * lim; b.y = cy + dy / d * lim; }
      }
    }
    // Final safety: never above the screen.
    if (b.y < r) b.y = r;
  }

  private wallFriction(b: Ball, floor: boolean): void {
    const k = CFG.friction / CFG.iterations;
    if (floor) b.x -= (b.x - b.px) * k;
    else b.y -= (b.y - b.py) * k * 0.5;
  }

  private wake(b: Ball): void { b.sleeping = false; b.still = 0; }

  /** First contact between two same-tier balls merges them. One merge per ball per tick. */
  private merges(): void {
    const o = this.sortBalls();
    for (let i = 0; i < o.length; i++) {
      const a = o[i];
      if (a.dead || a.merged) continue;
      for (let j = i + 1; j < o.length; j++) {
        const b = o[j];
        if (b.x - b.r > a.x + a.r + 1) break;
        if (b.dead || b.merged || b.tier !== a.tier || a.grow < 1 || b.grow < 1) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r + 0.75;
        if (dx * dx + dy * dy > rr * rr) continue;
        this.merge(a, b);
        break;
      }
    }
    if (this.balls.some((b) => b.dead)) this.balls = this.balls.filter((b) => !b.dead);
  }

  private merge(a: Ball, b: Ball): void {
    a.dead = b.dead = true;
    a.merged = b.merged = true;
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    // Chain multiplier: merges within 0.8 s of the previous one.
    this.chain = this.t - this.lastMerge <= CFG.chainWindow ? this.chain + 1 : 1;
    this.lastMerge = this.t;
    this.bestChain = Math.max(this.bestChain, this.chain);
    const mult = CFG.chainMults[Math.min(CFG.chainMults.length - 1, this.chain - 1)];
    for (const n of this.balls) if (!n.dead && Math.hypot(n.x - x, n.y - y) < a.r * 2 + n.r + 40) this.wake(n);
    if (a.tier === TIERS.length - 1) {
      this.score += CFG.supernova;
      this.events.push({ type: 'supernova', x, y, pts: CFG.supernova });
      return;
    }
    const tier = a.tier + 1;
    const nb = this.spawn(tier, x, y, (a.vx + b.vx) / 2, -CFG.mergeKick, (a.r + b.r) / 2);
    nb.merged = true;
    const pts = Math.round(TIERS[tier].pts * mult);
    this.score += pts;
    this.events.push({ type: 'merge', tier, x, y, pts, chain: this.chain, mult });
  }

  private checkDanger(dt: number): void {
    if (this.over) return;
    let above = false;
    for (const b of this.balls) if (b.age >= CFG.settleAge && b.y - b.r < DANGER_Y) { above = true; break; }
    this.danger = above ? this.danger + dt : 0;
    if (this.danger >= CFG.dangerOver) { this.over = true; this.events.push({ type: 'over' }); }
  }

  /** Balls whose tops are over the line (for worried faces). */
  isWorried(b: Ball): boolean { return this.danger > CFG.dangerWarn && b.y - b.r < DANGER_Y + 30; }

  /** y where a vertical line at x first meets a ball top or the jar floor. */
  surfaceBelow(x: number): number {
    let y: number = JAR.bottom;
    for (const b of this.balls) {
      const dx = Math.abs(b.x - x);
      if (dx >= b.r) continue;
      const top = b.y - Math.sqrt(b.r * b.r - dx * dx);
      if (top < y && top > HOLD_Y) y = top;
    }
    return y;
  }
}
