import { Particles } from '../engine/particles';
import { Rng } from '../engine/rng';
import { settings } from '../engine/settings';
import { C } from '../engine/theme';

const COLORS = [C.pink, C.orange, C.yellow, C.green, C.cyan, C.violet];

/** Full-screen confetti overlay used for NEW BEST bursts. Runs its own rAF only while alive. */
export class Confetti {
  private el: HTMLCanvasElement | null = null;
  private p = new Particles(new Rng());
  private raf = 0;
  private last = 0;

  fire(): void {
    if (!settings.motion) return;
    if (!this.el) {
      this.el = document.createElement('canvas');
      this.el.className = 'pa-confetti';
      document.body.append(this.el);
    }
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = innerWidth, h = innerHeight;
    this.el.width = w * dpr; this.el.height = h * dpr;
    this.p.confetti(0, h * 0.75, -Math.PI / 3, COLORS, 70, h * 1.3);
    this.p.confetti(w, h * 0.75, -Math.PI * 2 / 3, COLORS, 70, h * 1.3);
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); }
  }

  private tick = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.p.update(dt);
    const el = this.el!;
    const g = el.getContext('2d')!;
    const dpr = el.width / innerWidth;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, el.width, el.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.p.render(g);
    if (this.p.live > 0) this.raf = requestAnimationFrame(this.tick);
    else this.stop();
  };

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.p.clear();
    this.el?.remove();
    this.el = null;
  }
}
