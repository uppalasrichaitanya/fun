// Colour helpers and the incremental stroke layer for Draw a Perfect Circle.

const GREEN = [74, 222, 128], YELLOW = [255, 217, 61], RED = [255, 79, 139];

function mix(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t), g = Math.round(a[1] + (b[1] - a[1]) * t), bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

/** Local deviation (fraction of mean radius) -> green (<2%), yellow (2-6%), red (>6%), blended. */
export function deviationColor(dev: number): string {
  if (dev <= 0.015) return mix(GREEN, GREEN, 0);
  if (dev <= 0.03) return mix(GREEN, YELLOW, (dev - 0.015) / 0.015);
  if (dev <= 0.05) return mix(YELLOW, YELLOW, 0);
  if (dev <= 0.07) return mix(YELLOW, RED, (dev - 0.05) / 0.02);
  return mix(RED, RED, 0);
}

/** Offscreen canvas the stroke is painted onto incrementally (glow underlay + core line). */
export class StrokeLayer {
  readonly el = document.createElement('canvas');
  private g = this.el.getContext('2d')!;
  private dpr = 1;

  resize(pw: number, ph: number, dpr: number): void {
    if (this.el.width !== pw || this.el.height !== ph) { this.el.width = pw; this.el.height = ph; }
    this.dpr = dpr;
    this.clear();
  }

  clear(): void {
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.el.width, this.el.height);
  }

  segment(x0: number, y0: number, x1: number, y1: number, color: string, width = 6): void {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.lineCap = 'round';
    g.strokeStyle = color;
    g.globalAlpha = 0.18;
    g.lineWidth = width * 3;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.globalAlpha = 1;
    g.lineWidth = width;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
}
