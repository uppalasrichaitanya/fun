import { FONT } from './theme';
import { ease } from './tween';

const MAX = 40;
const DUR = 0.6;
const RISE = 40;

interface Floater { text: string; x: number; y: number; t: number; color: string; size: number; alive: boolean }

/** Pooled floating text: rises 40 px over 600 ms with ease-out and fades. */
export class Floaters {
  private pool: Floater[] = Array.from({ length: MAX }, () => ({ text: '', x: 0, y: 0, t: 0, color: '#fff', size: 20, alive: false }));
  private next = 0;
  live = 0;

  add(text: string, x: number, y: number, color: string, size = 22): void {
    const f = this.pool[this.next];
    this.next = (this.next + 1) % MAX;
    if (!f.alive) this.live++;
    f.text = text; f.x = x; f.y = y; f.t = 0; f.color = color; f.size = size; f.alive = true;
  }

  update(dt: number): void {
    for (const f of this.pool) {
      if (!f.alive) continue;
      f.t += dt;
      if (f.t >= DUR) { f.alive = false; this.live--; }
    }
  }

  render(g: CanvasRenderingContext2D): void {
    if (this.live === 0) return;
    const prevA = g.globalAlpha;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const f of this.pool) {
      if (!f.alive) continue;
      const k = f.t / DUR;
      const pop = ease.outBack(Math.min(1, k * 4));
      g.globalAlpha = prevA * (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      g.font = `700 ${Math.round(f.size * (0.6 + 0.4 * pop))}px ${FONT.title}`;
      const y = f.y - RISE * ease.outCubic(k);
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(14,15,26,0.75)';
      g.strokeText(f.text, f.x, y);
      g.fillStyle = f.color;
      g.fillText(f.text, f.x, y);
    }
    g.globalAlpha = prevA;
  }

  clear(): void { for (const f of this.pool) f.alive = false; this.live = 0; }
}
