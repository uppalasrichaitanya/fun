export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  outBack: (t: number) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
} satisfies Record<string, Ease>;

interface TweenItem {
  t: number; dur: number; delay: number;
  from: number; to: number; ease: Ease;
  set: (v: number) => void; done?: () => void;
}

/** Minimal tween runner for UI-ish values. Allocates on add, never in update. */
export class Tweens {
  private items: TweenItem[] = [];
  add(from: number, to: number, dur: number, set: (v: number) => void, e: Ease = ease.outCubic, delay = 0, done?: () => void): void {
    this.items.push({ t: 0, dur, delay, from, to, ease: e, set, done });
    if (delay <= 0) set(from);
  }
  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.delay > 0) { it.delay -= dt; if (it.delay > 0) continue; }
      it.t += dt;
      const k = Math.min(1, it.t / it.dur);
      it.set(it.from + (it.to - it.from) * it.ease(k));
      if (k >= 1) { this.items.splice(i, 1); it.done?.(); }
    }
  }
  clear(): void { this.items.length = 0; }
  get count(): number { return this.items.length; }
}
