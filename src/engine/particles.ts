import { glowSprite } from './glow';
import { TAU } from './math';
import type { Rng } from './rng';

export const MAX_PARTICLES = 600;

/** Shapes: 0 glowing dot, 1 confetti rectangle, 2 spark streak, 3 hard dot (no glow). */
export const enum Shape { Glow = 0, Confetti = 1, Spark = 2, Dot = 3 }

export interface BurstOpts {
  count?: number; speed?: number; speedVar?: number; size?: number; sizeEnd?: number;
  life?: number; lifeVar?: number; gravity?: number; drag?: number; shape?: Shape;
  angle?: number; spread?: number; colors?: readonly string[];
}

/**
 * Struct-of-arrays particle pool. No allocations after construction except the
 * colour intern table, which only grows with new distinct colours.
 */
export class Particles {
  private x = new Float32Array(MAX_PARTICLES);
  private y = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private max = new Float32Array(MAX_PARTICLES);
  private s0 = new Float32Array(MAX_PARTICLES);
  private s1 = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private rot = new Float32Array(MAX_PARTICLES);
  private vr = new Float32Array(MAX_PARTICLES);
  private shape = new Uint8Array(MAX_PARTICLES);
  private col = new Uint16Array(MAX_PARTICLES);
  private colors: string[] = [];
  private colorIdx = new Map<string, number>();
  private cursor = 0;
  live = 0;

  constructor(private rng: Rng) {}

  private intern(c: string): number {
    let i = this.colorIdx.get(c);
    if (i === undefined) { i = this.colors.length; this.colors.push(c); this.colorIdx.set(c, i); }
    return i;
  }

  /** Spawn one particle. Overwrites the oldest slot when full. */
  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, sizeEnd: number,
    color: string, shape: Shape = Shape.Glow, gravity = 0, drag = 0): void {
    let i = -1;
    for (let k = 0; k < MAX_PARTICLES; k++) {
      const j = (this.cursor + k) % MAX_PARTICLES;
      if (this.life[j] <= 0) { i = j; break; }
    }
    if (i < 0) i = this.cursor; else this.live++;
    this.cursor = (i + 1) % MAX_PARTICLES;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.s0[i] = size; this.s1[i] = sizeEnd;
    this.grav[i] = gravity; this.drag[i] = drag; this.shape[i] = shape;
    this.rot[i] = this.rng.next() * TAU; this.vr[i] = (this.rng.next() - 0.5) * 14;
    this.col[i] = this.intern(color);
  }

  burst(x: number, y: number, color: string, o: BurstOpts = {}): void {
    const n = o.count ?? 14, sp = o.speed ?? 220, sv = o.speedVar ?? 0.6;
    const angle = o.angle ?? 0, spread = o.spread ?? TAU;
    for (let k = 0; k < n; k++) {
      const a = angle + (this.rng.next() - 0.5) * spread;
      const s = sp * (1 - sv + this.rng.next() * sv * 2);
      const c = o.colors ? o.colors[k % o.colors.length] : color;
      const life = (o.life ?? 0.6) * (1 - (o.lifeVar ?? 0.4) * this.rng.next());
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, life, o.size ?? 5, o.sizeEnd ?? 0,
        c, o.shape ?? Shape.Glow, o.gravity ?? 0, o.drag ?? 3);
    }
  }

  sparkle(x: number, y: number, color: string, count = 8, radius = 30): void {
    for (let k = 0; k < count; k++) {
      const a = this.rng.next() * TAU, r = this.rng.next() * radius;
      this.spawn(x + Math.cos(a) * r, y + Math.sin(a) * r, 0, -20 - this.rng.next() * 30,
        0.4 + this.rng.next() * 0.5, 3 + this.rng.next() * 3, 0, color, Shape.Glow, 0, 1);
    }
  }

  confetti(x: number, y: number, angle: number, colors: readonly string[], count = 40, speed = 700): void {
    this.burst(x, y, colors[0], {
      count, speed, speedVar: 0.5, angle, spread: 0.9, size: 7, sizeEnd: 6, life: 2.2, lifeVar: 0.3,
      gravity: 900, drag: 2.2, shape: Shape.Confetti, colors,
    });
  }

  update(dt: number): void {
    if (this.live === 0) return;
    let live = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      live++;
      const d = 1 / (1 + this.drag[i] * dt);
      this.vx[i] *= d;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.vr[i] * dt;
    }
    this.live = live;
  }

  render(g: CanvasRenderingContext2D): void {
    if (this.live === 0) return;
    const prevOp = g.globalCompositeOperation;
    const prevA = g.globalAlpha;
    const M = g.getTransform();
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const t = 1 - life / this.max[i];
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const color = this.colors[this.col[i]];
      const shape = this.shape[i];
      if (shape === Shape.Glow) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = prevA * Math.min(1, life * 4);
        const r = size * 2.6;
        g.drawImage(glowSprite(color), this.x[i] - r, this.y[i] - r, r * 2, r * 2);
      } else if (shape === Shape.Confetti) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = prevA * Math.min(1, life * 2);
        g.fillStyle = color;
        // M * translate(x,y) * rotate(rot) * scale(1, 0.6), composed by hand to avoid save/restore.
        const c = Math.cos(this.rot[i]), s = Math.sin(this.rot[i]);
        const la = c, lb = s, lc = -s * 0.6, ld = c * 0.6, le = this.x[i], lf = this.y[i];
        g.setTransform(M.a * la + M.c * lb, M.b * la + M.d * lb, M.a * lc + M.c * ld, M.b * lc + M.d * ld,
          M.a * le + M.c * lf + M.e, M.b * le + M.d * lf + M.f);
        g.fillRect(-size / 2, -size / 4, size, size / 2);
        g.setTransform(M);
      } else if (shape === Shape.Spark) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = prevA * Math.min(1, life * 4);
        g.strokeStyle = color;
        g.lineWidth = size;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(this.x[i], this.y[i]);
        g.lineTo(this.x[i] - this.vx[i] * 0.04, this.y[i] - this.vy[i] * 0.04);
        g.stroke();
      } else {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = prevA * Math.min(1, life * 3);
        g.fillStyle = color;
        g.beginPath();
        g.arc(this.x[i], this.y[i], Math.max(0.1, size), 0, TAU);
        g.fill();
      }
    }
    g.globalCompositeOperation = prevOp;
    g.globalAlpha = prevA;
  }

  clear(): void { this.life.fill(0); this.live = 0; }
}
