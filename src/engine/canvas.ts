import { C } from './theme';

export type CanvasMode = 'fit' | 'fill';

/**
 * DPR-aware canvas. In 'fit' mode the game draws in a fixed logical resolution
 * that is letterboxed (never stretched). In 'fill' mode logical units are CSS px.
 */
export class GameCanvas {
  readonly el: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  dpr = 1;
  cssW = 1; cssH = 1;
  /** Logical size the game draws in. */
  w = 1; h = 1;
  /** CSS px per logical unit, and letterbox offset in CSS px. */
  scale = 1; offX = 0; offY = 0;
  private ro: ResizeObserver;
  private listeners = new Set<() => void>();

  constructor(private container: HTMLElement, readonly mode: CanvasMode, private maxDpr = 2, logical?: { w: number; h: number }) {
    this.el = document.createElement('canvas');
    this.el.className = 'pa-canvas';
    container.appendChild(this.el);
    this.g = this.el.getContext('2d', { alpha: false })!;
    if (logical) { this.w = logical.w; this.h = logical.h; }
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  /** Aspect of the available area, for games that pick a landscape/portrait resolution. */
  get portrait(): boolean { return this.cssH > this.cssW * 1.05; }

  setLogicalSize(w: number, h: number): void {
    if (this.mode !== 'fit') return;
    this.w = w; this.h = h;
    this.resize();
  }

  onResize(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  resize(): void {
    const r = this.container.getBoundingClientRect();
    this.cssW = Math.max(1, Math.round(r.width));
    this.cssH = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    const pw = Math.round(this.cssW * this.dpr), ph = Math.round(this.cssH * this.dpr);
    if (this.el.width !== pw || this.el.height !== ph) { this.el.width = pw; this.el.height = ph; }
    this.el.style.width = this.cssW + 'px';
    this.el.style.height = this.cssH + 'px';
    if (this.mode === 'fill') {
      this.w = this.cssW; this.h = this.cssH; this.scale = 1; this.offX = 0; this.offY = 0;
    } else {
      this.scale = Math.min(this.cssW / this.w, this.cssH / this.h);
      this.offX = (this.cssW - this.w * this.scale) / 2;
      this.offY = (this.cssH - this.h * this.scale) / 2;
    }
    for (const l of this.listeners) l();
  }

  /** Clear the whole surface (letterbox included) and set the logical transform. */
  begin(bg: string = C.bg): CanvasRenderingContext2D {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = bg;
    g.fillRect(0, 0, this.el.width, this.el.height);
    const s = this.scale * this.dpr;
    g.setTransform(s, 0, 0, s, this.offX * this.dpr, this.offY * this.dpr);
    return g;
  }

  /** Client (viewport) coordinates -> logical coordinates. */
  toLogical(clientX: number, clientY: number, out: { x: number; y: number }): void {
    const r = this.el.getBoundingClientRect();
    out.x = (clientX - r.left - this.offX) / this.scale;
    out.y = (clientY - r.top - this.offY) / this.scale;
  }

  destroy(): void {
    this.ro.disconnect();
    this.listeners.clear();
    this.el.remove();
  }
}
