// Pre-rendered additive glow sprites. Never use per-frame shadowBlur on canvas.
const cache = new Map<string, HTMLCanvasElement>();
const SIZE = 64;

export function glowSprite(color: string): HTMLCanvasElement {
  let c = cache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(0.25, withAlpha(color, 0.55));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, SIZE, SIZE);
  cache.set(color, c);
  return c;
}

/** Draw an additive glow of radius r at (x, y). Caller sets globalAlpha if needed. */
export function drawGlow(g: CanvasRenderingContext2D, color: string, x: number, y: number, r: number, alpha = 0.4): void {
  const prevOp = g.globalCompositeOperation, prevA = g.globalAlpha;
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = prevA * alpha;
  g.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  g.globalCompositeOperation = prevOp;
  g.globalAlpha = prevA;
}

function withAlpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `,${a})`);
  return color;
}
