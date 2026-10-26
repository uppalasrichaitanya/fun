import { settings } from './settings';
import { clamp } from './math';

// 1D gradient noise for smooth (non-jittery) shake.
const PERM = new Uint8Array(512);
const GRAD = new Float32Array(256);
{
  let s = 1337;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 256; i++) { PERM[i] = i; GRAD[i] = r() * 2 - 1; }
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = PERM[i]; PERM[i] = PERM[j]; PERM[j] = t; }
  for (let i = 0; i < 256; i++) PERM[i + 256] = PERM[i];
}
export function noise1(x: number): number {
  const i = Math.floor(x), f = x - i;
  const g0 = GRAD[PERM[i & 255]], g1 = GRAD[PERM[(i + 1) & 255]];
  const u = f * f * (3 - 2 * f);
  return (g0 * f + (g1 * (f - 1) - g0 * f) * u) * 2;
}

/** Trauma-based screen shake + zoom. Update with real (unscaled) dt so shake runs through hit-stop. */
export class Camera {
  trauma = 0;
  x = 0; y = 0; angle = 0;
  zoom = 1;
  private t = Math.random() * 100;
  static MAX_OFFSET = 12;
  static MAX_ANGLE = 0.03;

  shake(amount: number): void { this.trauma = clamp(this.trauma + amount, 0, 1); }

  update(realDt: number): void {
    this.trauma = Math.max(0, this.trauma - 1.5 * realDt);
    this.t += realDt * 28;
    const k = this.trauma * this.trauma * settings.shakeScale;
    this.x = Camera.MAX_OFFSET * k * noise1(this.t);
    this.y = Camera.MAX_OFFSET * k * noise1(this.t + 57.3);
    this.angle = Camera.MAX_ANGLE * k * noise1(this.t + 113.1);
  }

  /** Apply shake around the centre of a w x h logical view. Pair with g.restore(). */
  begin(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.save();
    if (this.x === 0 && this.y === 0 && this.angle === 0 && this.zoom === 1) return;
    g.translate(w / 2 + this.x, h / 2 + this.y);
    g.rotate(this.angle);
    g.scale(this.zoom, this.zoom);
    g.translate(-w / 2, -h / 2);
  }
  end(g: CanvasRenderingContext2D): void { g.restore(); }
  reset(): void { this.trauma = 0; this.x = this.y = this.angle = 0; this.zoom = 1; }
}

/** Global simulation time scale: hit-stop (freeze) and slow-mo. */
export class TimeCtl {
  private stop = 0;
  private slowLeft = 0;
  private slowScale = 1;
  private recover = 0;
  private static RECOVER = 0.2;

  /** Freeze the simulation for ms (rendering continues). */
  hitStop(ms: number): void { this.stop = Math.max(this.stop, ms / 1000); }

  /** Time scale to `scale` for ms, then ease back. Disabled under reduced motion. */
  slowMo(scale = 0.3, ms = 400): void {
    if (!settings.motion) return;
    this.slowScale = scale;
    this.slowLeft = ms / 1000;
    this.recover = TimeCtl.RECOVER;
  }

  /** Advance with real dt and return the scale to apply to it. */
  scale(realDt: number): number {
    if (this.stop > 0) { this.stop -= realDt; return 0; }
    if (this.slowLeft > 0) { this.slowLeft -= realDt; return this.slowScale; }
    if (this.recover > 0) {
      this.recover -= realDt;
      const k = 1 - Math.max(0, this.recover) / TimeCtl.RECOVER;
      return this.slowScale + (1 - this.slowScale) * k;
    }
    return 1;
  }
  get frozen(): boolean { return this.stop > 0; }
  reset(): void { this.stop = 0; this.slowLeft = 0; this.recover = 0; }
}
