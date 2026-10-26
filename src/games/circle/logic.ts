import { CFG } from './config';

export type FailReason = 'small' | 'around' | 'close' | 'reverse' | 'slow';
export const FAIL_TEXT: Record<FailReason, string> = {
  small: 'Too small. Go bigger.',
  around: 'Go all the way around the dot.',
  close: 'Too close to the dot.',
  reverse: 'Keep going one way.',
  slow: 'Too slow.',
};

export interface Scored {
  score: number;      // 0..100, one decimal
  R: number;          // mean radius
  E: number;          // roundness error
  G: number;          // closure gap / R
  /** Resampled points (x, y interleaved) and indices of the worst 10%. */
  rx: Float32Array; ry: Float32Array;
  worst: Uint16Array;
}

/** Incremental stroke tracker: running radius stats and swept angle. */
export class Stroke {
  xs = new Float32Array(CFG.maxPoints);
  ys = new Float32Array(CFG.maxPoints);
  n = 0;
  cx = 0; cy = 0;
  sumR = 0; sumR2 = 0;
  swept = 0; maxSwept = 0; minSwept = 0;
  private lastAng = 0;
  minR = Infinity;
  reversed = false;
  private dir = 0;

  begin(cx: number, cy: number): void {
    this.cx = cx; this.cy = cy;
    this.n = 0; this.sumR = 0; this.sumR2 = 0;
    this.swept = this.maxSwept = this.minSwept = 0;
    this.minR = Infinity; this.reversed = false; this.dir = 0;
  }

  /** Adds a point; returns false when the buffer is full. */
  add(x: number, y: number): boolean {
    if (this.n >= CFG.maxPoints) return false;
    if (this.n > 0) {
      const px = this.xs[this.n - 1], py = this.ys[this.n - 1];
      if ((x - px) * (x - px) + (y - py) * (y - py) < 1) return true; // ignore sub-pixel jitter
    }
    const dx = x - this.cx, dy = y - this.cy;
    const r = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    if (this.n > 0) {
      let d = ang - this.lastAng;
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      this.swept += d;
      this.maxSwept = Math.max(this.maxSwept, this.swept);
      this.minSwept = Math.min(this.minSwept, this.swept);
      // Direction locks once the stroke has clearly committed (45 deg); before that, wiggles are free.
      if (this.dir === 0 && Math.abs(this.swept) > Math.PI / 4) this.dir = Math.sign(this.swept);
      const lim = (CFG.reverseLimit * Math.PI) / 180;
      if (this.dir > 0 && this.swept < this.maxSwept - lim) this.reversed = true;
      if (this.dir < 0 && this.swept > this.minSwept + lim) this.reversed = true;
    }
    this.lastAng = ang;
    this.xs[this.n] = x; this.ys[this.n] = y; this.n++;
    this.sumR += r; this.sumR2 += r * r;
    this.minR = Math.min(this.minR, r);
    return true;
  }

  get meanR(): number { return this.n ? this.sumR / this.n : 0; }

  /** Live (non-resampled) estimate used while drawing. */
  live(): number {
    if (this.n < 3) return 100;
    const m = this.meanR;
    const v = Math.max(0, this.sumR2 / this.n - m * m);
    const E = Math.sqrt(v) / m;
    return 100 * (1 - Math.min(1, Math.max(0, CFG.roundnessK * E)));
  }

  validate(minRadius: number): FailReason | null {
    if (this.reversed) return 'reverse';
    const R = this.meanR;
    if (R < minRadius) return 'small';
    if (Math.abs(this.swept) * 180 / Math.PI < CFG.minSweep) return 'around';
    if (this.minR < CFG.tooClose * R) return 'close';
    return null;
  }
}

/**
 * Score a stroke against the fixed centre (cx, cy). Deterministic and
 * independent of drawing speed (points are resampled by arc length).
 */
export function scoreStroke(xs: Float32Array, ys: Float32Array, n: number, cx: number, cy: number): Scored {
  const M = CFG.resample;
  const rx = new Float32Array(M), ry = new Float32Array(M);
  // Cumulative arc length.
  let total = 0;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) { total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); cum[i] = total; }
  let seg = 1;
  for (let k = 0; k < M; k++) {
    const target = (total * k) / (M - 1);
    while (seg < n - 1 && cum[seg] < target) seg++;
    const a = cum[seg - 1], b = cum[seg];
    const t = b > a ? (target - a) / (b - a) : 0;
    rx[k] = xs[seg - 1] + (xs[seg] - xs[seg - 1]) * t;
    ry[k] = ys[seg - 1] + (ys[seg] - ys[seg - 1]) * t;
  }
  const r = new Float64Array(M);
  let R = 0;
  for (let k = 0; k < M; k++) { r[k] = Math.hypot(rx[k] - cx, ry[k] - cy); R += r[k]; }
  R /= M;
  let v = 0;
  for (let k = 0; k < M; k++) v += (r[k] - R) * (r[k] - R);
  const E = Math.sqrt(v / M) / R;
  const G = Math.hypot(rx[M - 1] - rx[0], ry[M - 1] - ry[0]) / R;
  const pen = CFG.roundnessK * E + CFG.closureK * Math.max(0, G - CFG.closureFree);
  const raw = 100 * (1 - Math.min(1, Math.max(0, pen)));
  const score = Math.round(raw * 10) / 10;
  const order = Array.from({ length: M }, (_, i) => i).sort((a, b) => Math.abs(r[b] - R) - Math.abs(r[a] - R));
  const worst = Uint16Array.from(order.slice(0, Math.round(M * CFG.worstFrac)));
  return { score, R, E, G, rx, ry, worst };
}
