import type { Rng } from '../../engine/rng';

export const ARENA = { x: 480, y: 330, r0: 300, rMin: 110, grace: 6, shrinkTime: 40 } as const;

export const CFG = {
  r: 34,
  accel: 1300,
  maxSpeed: 290,
  friction: 3.5,
  dashSpeed: 640,
  dashTime: 0.18,
  dashCooldown: 1.4,
  dashMass: 2.5,
  restitution: 0.9,
  knockback: 1.6,
  knockScale: 0.1,
  outFrac: 0.3,
  fallTime: 0.6,
  drawWindow: 0.2,
  winRounds: 3,
  countdown: 2,
  powerEvery: 12,
} as const;

export type PowerKind = 'mega' | 'bouncy' | 'zoom';
export interface Power { kind: PowerKind; x: number; y: number; t: number }

export interface Blob {
  i: 0 | 1;
  x: number; y: number; vx: number; vy: number;
  fx: number; fy: number;          // facing (unit)
  dashT: number;                   // > 0 while dashing
  cool: number;                    // dash cooldown left
  falling: number;                 // < 0 alive, else seconds since falling
  mega: number; zoom: number; bouncy: boolean;
  /** Last input move vector, for faces. */
  ix: number; iy: number;
}

export interface BlobInput { x: number; y: number; dash: boolean }

export type SumoEvent =
  | { type: 'bump'; x: number; y: number; force: number; nx: number; ny: number }
  | { type: 'clash'; x: number; y: number }
  | { type: 'dash'; i: number }
  | { type: 'fall'; i: number }
  | { type: 'round'; winner: 0 | 1 | null }
  | { type: 'power'; i: number; kind: PowerKind }
  | { type: 'go' };

/** Deterministic arena simulation. Inputs come from keys, touch or the CPU. */
export class SumoSim {
  blobs: [Blob, Blob];
  score: [number, number] = [0, 0];
  t = 0;                 // round time (after GO)
  countdown: number = CFG.countdown;
  radius: number = ARENA.r0;
  roundOver = false;
  matchOver = false;
  winner: 0 | 1 | null = null;
  clashes = 0;
  longest = 0;
  power: Power | null = null;
  powerT = 0;
  chaos = false;
  events: SumoEvent[] = [];
  private fallAt: [number, number] = [-1, -1];
  private dashedPrev: [boolean, boolean] = [false, false];

  constructor(private rng: Rng) {
    this.blobs = [this.blob(0), this.blob(1)];
  }

  private blob(i: 0 | 1): Blob {
    const side = i === 0 ? -1 : 1;
    return {
      i, x: ARENA.x + side * 170, y: ARENA.y, vx: 0, vy: 0, fx: -side, fy: 0,
      dashT: 0, cool: 0, falling: -1, mega: 0, zoom: 0, bouncy: false, ix: 0, iy: 0,
    };
  }

  newRound(): void {
    this.blobs = [this.blob(0), this.blob(1)];
    this.t = 0; this.countdown = CFG.countdown; this.radius = ARENA.r0;
    this.roundOver = false; this.fallAt = [-1, -1]; this.power = null; this.powerT = 0;
    this.dashedPrev = [false, false];
  }

  reset(): void {
    this.score = [0, 0]; this.matchOver = false; this.winner = null; this.clashes = 0; this.longest = 0;
    this.newRound();
  }

  /** Edge radius at a given round time. */
  radiusAt(t: number): number {
    if (t <= ARENA.grace) return ARENA.r0;
    const k = Math.min(1, (t - ARENA.grace) / ARENA.shrinkTime);
    return ARENA.r0 + (ARENA.rMin - ARENA.r0) * k;
  }

  blobR(b: Blob): number { return CFG.r * (b.mega > 0 ? 1.4 : 1); }
  mass(b: Blob): number { return (b.mega > 0 ? 2 : 1) * (b.dashT > 0 ? CFG.dashMass : 1); }

  step(dt: number, inputs: [BlobInput, BlobInput]): void {
    if (this.matchOver) return;
    if (this.countdown > 0) {
      const before = this.countdown;
      this.countdown -= dt;
      if (before > 0 && this.countdown <= 0) this.events.push({ type: 'go' });
      return;
    }
    if (!this.roundOver) this.t += dt;
    this.radius = this.radiusAt(this.t);
    for (const b of this.blobs) this.move(b, inputs[b.i], dt);
    this.collide();
    this.powers(dt);
    this.checkOut();
  }

  private move(b: Blob, inp: BlobInput, dt: number): void {
    if (b.falling >= 0) { b.falling += dt; b.x += b.vx * dt * 0.5; b.y += b.vy * dt * 0.5; return; }
    if (this.roundOver) { b.vx *= Math.exp(-6 * dt); b.vy *= Math.exp(-6 * dt); b.x += b.vx * dt; b.y += b.vy * dt; return; }
    const len = Math.hypot(inp.x, inp.y);
    const ix = len > 1 ? inp.x / len : inp.x, iy = len > 1 ? inp.y / len : inp.y;
    b.ix = ix; b.iy = iy;
    if (len > 0.1) { b.fx = ix / Math.max(1e-6, Math.hypot(ix, iy)); b.fy = iy / Math.max(1e-6, Math.hypot(ix, iy)); }
    b.cool = Math.max(0, b.cool - dt);
    b.mega = Math.max(0, b.mega - dt);
    b.zoom = Math.max(0, b.zoom - dt);
    const pressed = inp.dash && !this.dashedPrev[b.i];
    this.dashedPrev[b.i] = inp.dash;
    if (pressed && b.cool <= 0 && b.dashT <= 0) {
      b.dashT = CFG.dashTime;
      b.cool = CFG.dashCooldown;
      b.vx = b.fx * CFG.dashSpeed * (b.zoom > 0 ? 1.4 : 1);
      b.vy = b.fy * CFG.dashSpeed * (b.zoom > 0 ? 1.4 : 1);
      this.events.push({ type: 'dash', i: b.i });
    }
    const zoom = b.zoom > 0 ? 1.4 : 1;
    if (b.dashT > 0) {
      b.dashT -= dt;
    } else {
      // Max speed limits self-propulsion only; knockback is never clipped.
      const max = CFG.maxSpeed * zoom, along = b.vx * ix + b.vy * iy;
      if (along < max) {
        const add = Math.min(CFG.accel * zoom * dt, max - along);
        b.vx += ix * add; b.vy += iy * add;
      }
      const d = Math.exp(-CFG.friction * dt);
      b.vx *= d; b.vy *= d;
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
  }

  private collide(): void {
    const [a, b] = this.blobs;
    if (a.falling >= 0 || b.falling >= 0) return;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), rr = this.blobR(a) + this.blobR(b);
    if (d >= rr || d === 0) return;
    const nx = dx / d, ny = dy / d;
    const ma = this.mass(a), mb = this.mass(b);
    // Separate.
    const pen = rr - d;
    a.x -= nx * pen * mb / (ma + mb); a.y -= ny * pen * mb / (ma + mb);
    b.x += nx * pen * ma / (ma + mb); b.y += ny * pen * ma / (ma + mb);
    const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rv >= 0) return;
    const clash = a.dashT > 0 && b.dashT > 0 && (a.vx * nx + a.vy * ny) > 0 && (b.vx * nx + b.vy * ny) < 0;
    const j = (-(1 + CFG.restitution) * rv) / (1 / ma + 1 / mb);
    a.vx -= (j / ma) * nx; a.vy -= (j / ma) * ny;
    b.vx += (j / mb) * nx; b.vy += (j / mb) * ny;
    const speed = -rv;
    if (clash) {
      // Head-on dashes: both bounce back hard.
      a.vx -= nx * 260; a.vy -= ny * 260; b.vx += nx * 260; b.vy += ny * 260;
      a.dashT = 0; b.dashT = 0;
      this.clashes++;
      this.events.push({ type: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return;
    }
    // A dash hit sends the target flying: bonus of 1.6x the dasher's relative speed.
    for (const [hit, by, sign] of [[b, a, 1], [a, b, -1]] as [Blob, Blob, number][]) {
      if (by.dashT <= 0) continue;
      // The spec's 1.6x, scaled so a clean hit sends a blob sliding about a platform radius, not off-screen.
      let k = CFG.knockback * speed * CFG.knockScale;
      let tx = nx * sign, ty = ny * sign;
      if (hit.bouncy) {
        hit.bouncy = false;
        // Reflected back at the dasher, doubled.
        by.vx -= tx * k * 2; by.vy -= ty * k * 2;
        k = 0; tx = 0; ty = 0;
      }
      hit.vx += tx * k; hit.vy += ty * k;
      by.dashT = 0;
    }
    this.events.push({ type: 'bump', x: a.x + nx * this.blobR(a), y: a.y + ny * this.blobR(a), force: speed, nx, ny });
  }

  private powers(dt: number): void {
    if (!this.chaos || this.roundOver) return;
    this.powerT += dt;
    if (!this.power && this.powerT >= CFG.powerEvery) {
      this.powerT = 0;
      const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(0, this.radius * 0.5);
      this.power = { kind: this.rng.pick(['mega', 'bouncy', 'zoom'] as const), x: ARENA.x + Math.cos(a) * r, y: ARENA.y + Math.sin(a) * r, t: 0 };
    }
    if (!this.power) return;
    this.power.t += dt;
    for (const b of this.blobs) {
      if (b.falling >= 0 || Math.hypot(b.x - this.power.x, b.y - this.power.y) > this.blobR(b) + 16) continue;
      if (this.power.kind === 'mega') b.mega = 6;
      else if (this.power.kind === 'zoom') b.zoom = 5;
      else b.bouncy = true;
      this.events.push({ type: 'power', i: b.i, kind: this.power.kind });
      this.power = null;
      break;
    }
  }

  isOut(b: Blob): boolean {
    return Math.hypot(b.x - ARENA.x, b.y - ARENA.y) > this.radius + this.blobR(b) * CFG.outFrac;
  }

  private checkOut(): void {
    if (this.roundOver) return;
    for (const b of this.blobs) {
      if (b.falling < 0 && this.isOut(b)) {
        b.falling = 0;
        this.fallAt[b.i] = this.t;
        this.events.push({ type: 'fall', i: b.i });
      }
    }
    const [f0, f1] = this.fallAt;
    const first = f0 >= 0 && f1 >= 0 ? Math.min(f0, f1) : Math.max(f0, f1);
    if (first < 0) return;
    // Wait out the draw window before calling it.
    if (this.t - first < CFG.drawWindow && !(f0 >= 0 && f1 >= 0)) return;
    this.roundOver = true;
    this.longest = Math.max(this.longest, this.t);
    let winner: 0 | 1 | null;
    if (f0 >= 0 && f1 >= 0 && Math.abs(f0 - f1) <= CFG.drawWindow) winner = null;
    else winner = f0 >= 0 ? 1 : 0;
    if (winner !== null) {
      this.score[winner]++;
      if (this.score[winner] >= CFG.winRounds) { this.matchOver = true; this.winner = winner; }
    }
    this.events.push({ type: 'round', winner });
  }
}

/** CPU opponent. Difficulty from the spec table. */
export const CPU = {
  easy: { react: 0.45, aim: 25, dashChance: 0.25, wander: 0.35 },
  normal: { react: 0.28, aim: 12, dashChance: 0.7, wander: 0.1 },
  hard: { react: 0.16, aim: 5, dashChance: 1, wander: 0 },
} as const;
export type Difficulty = keyof typeof CPU;

export class CpuBrain {
  private seen: { x: number; y: number; vx: number; vy: number; dashing: boolean }[] = [];
  private wanderA = 0;
  private wanderT = 0;
  private contact = 0;
  constructor(private me: 0 | 1, private level: Difficulty, private rng: Rng) {}

  think(sim: SumoSim, dt: number): BlobInput {
    const p = CPU[this.level];
    const me = sim.blobs[this.me], foe = sim.blobs[this.me === 0 ? 1 : 0];
    // React to a delayed view of the opponent.
    this.seen.push({ x: foe.x, y: foe.y, vx: foe.vx, vy: foe.vy, dashing: foe.dashT > 0 });
    const lag = Math.round(p.react / dt);
    while (this.seen.length > lag + 1) this.seen.shift();
    const f = this.seen[0];
    const R = sim.radius;
    const cx = ARENA.x, cy = ARENA.y;
    const myD = Math.hypot(me.x - cx, me.y - cy), foeD = Math.hypot(f.x - cx, f.y - cy);
    // Hold the inside line: from between the opponent and the centre, push outward; else work around to it.
    let tx: number, ty: number;
    const fux = (f.x - cx) / (foeD || 1), fuy = (f.y - cy) / (foeD || 1);
    if (myD > R * 0.6) { tx = cx; ty = cy; }
    else if (myD < foeD) { tx = f.x + fux * 80; ty = f.y + fuy * 80; }
    else { tx = cx + fux * foeD * 0.4 - fuy * 60; ty = cy + fuy * foeD * 0.4 + fux * 60; }
    this.contact = Math.hypot(f.x - me.x, f.y - me.y) < 80 ? this.contact + dt : 0;
    this.wanderT -= dt;
    if (p.wander > 0 && this.wanderT <= 0) { this.wanderT = 1.5; this.wanderA = this.rng.range(0, Math.PI * 2); }
    if (p.wander > 0 && this.rng.chance(p.wander * dt)) { tx = me.x + Math.cos(this.wanderA) * 200; ty = me.y + Math.sin(this.wanderA) * 200; }
    // Side-step an incoming dash.
    if (f.dashing) {
      const dx = me.x - f.x, dy = me.y - f.y, d = Math.hypot(dx, dy) || 1;
      const along = (f.vx * dx + f.vy * dy) / (Math.hypot(f.vx, f.vy) * d || 1);
      if (along > 0.8 && d < 260) { tx = me.x - dy / d * 100; ty = me.y + dx / d * 100; }
    }
    let ix = tx - me.x, iy = ty - me.y;
    const il = Math.hypot(ix, iy);
    if (il > 1) { ix /= il; iy /= il; } else { ix = 0; iy = 0; }
    // Dash when aligned, close, and the opponent is nearer the edge.
    const dx = f.x - me.x, dy = f.y - me.y, d = Math.hypot(dx, dy);
    let dash = false;
    // Spec rule: aligned, within 170 u, and the opponent is closer to the edge than we are.
    const edgeShot = foeD > myD + 10 && foeD > R * 0.3;
    const stalemate = this.contact > 2.5;
    if (d < 170 && (edgeShot || stalemate) && me.cool <= 0 && this.rng.chance(p.dashChance * dt * (edgeShot ? 1.2 : 0.5))) {
      const err = ((this.rng.next() * 2 - 1) * p.aim * Math.PI) / 180;
      const a = Math.atan2(dy, dx) + err;
      ix = Math.cos(a); iy = Math.sin(a);
      dash = true;
    }
    return { x: ix, y: iy, dash };
  }
}
