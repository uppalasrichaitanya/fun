import { C } from '../../engine/theme';
import type { Piece, Slab, StackSim } from './logic';
import { CFG } from './config';

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

/** Isometric 2.5D view of the tower: three shaded faces per slab. */
export class StackView {
  /** px per world unit at zoom 1. */
  s = 1;
  zoom = 1;
  camY = 0;
  anchorFrac: number = CFG.topFrac;
  W = 1; H = 1;
  private bgKey = '';
  private bg: CanvasGradient | null = null;
  readonly out = { x: 0, y: 0 };

  layout(W: number, H: number): void {
    this.W = W; this.H = H;
    this.s = Math.min(W * 0.62, H * 0.44) / (2 * CFG.base * COS);
  }

  get k(): number { return this.s * this.zoom; }

  project(x: number, y: number, z: number): { x: number; y: number } {
    const k = this.k;
    this.out.x = this.W / 2 + (x - z) * COS * k;
    this.out.y = this.H * this.anchorFrac + ((x + z) * SIN - (y - this.camY)) * k;
    return this.out;
  }

  background(g: CanvasRenderingContext2D, hue: number): void {
    const key = `${Math.round(hue)}|${this.H}`;
    if (key !== this.bgKey) {
      const grad = g.createLinearGradient(0, 0, 0, this.H);
      grad.addColorStop(0, `hsl(${Math.round(hue)},45%,24%)`);
      grad.addColorStop(0.55, `hsl(${Math.round(hue + 25)},40%,13%)`);
      grad.addColorStop(1, C.bg);
      this.bg = grad; this.bgKey = key;
    }
    g.fillStyle = this.bg!;
    g.fillRect(0, 0, this.W, this.H);
  }

  /** Draw a box whose bottom-centre projects to (sx, sy). */
  box(g: CanvasRenderingContext2D, sx: number, sy: number, w: number, d: number, h: number,
    top: string, left: string, right: string, flash = 0): void {
    const k = this.k;
    const hw = w / 2, hd = d / 2;
    // Corner screen offsets (dx - dz) * COS, (dx + dz) * SIN
    const ax = (-hw + hd) * COS * k, ay = (-hw - hd) * SIN * k;  // back
    const bx = (hw + hd) * COS * k, by = (hw - hd) * SIN * k;    // right
    const cx = (hw - hd) * COS * k, cy = (hw + hd) * SIN * k;    // front
    const dx = (-hw - hd) * COS * k, dy = (-hw + hd) * SIN * k;  // left
    const hh = h * k;
    g.lineWidth = 1;
    g.lineJoin = 'round';
    // left face (+z)
    g.fillStyle = left; g.strokeStyle = left;
    g.beginPath();
    g.moveTo(sx + dx, sy + dy - hh); g.lineTo(sx + cx, sy + cy - hh); g.lineTo(sx + cx, sy + cy); g.lineTo(sx + dx, sy + dy);
    g.closePath(); g.fill(); g.stroke();
    // right face (+x)
    g.fillStyle = right; g.strokeStyle = right;
    g.beginPath();
    g.moveTo(sx + cx, sy + cy - hh); g.lineTo(sx + bx, sy + by - hh); g.lineTo(sx + bx, sy + by); g.lineTo(sx + cx, sy + cy);
    g.closePath(); g.fill(); g.stroke();
    // top
    g.fillStyle = top; g.strokeStyle = top;
    g.beginPath();
    g.moveTo(sx + ax, sy + ay - hh); g.lineTo(sx + bx, sy + by - hh); g.lineTo(sx + cx, sy + cy - hh); g.lineTo(sx + dx, sy + dy - hh);
    g.closePath(); g.fill(); g.stroke();
    if (flash > 0) {
      g.globalAlpha = flash;
      g.fillStyle = '#fff';
      g.fill();
      g.globalAlpha = 1;
    }
  }

  slab(g: CanvasRenderingContext2D, s: Slab, lift = 0): void {
    const p = this.project(s.x, s.y + lift, s.z);
    let w = s.w, d = s.d, h = CFG.height;
    if (s.grow > 0) { const k = Math.sin(s.grow * Math.PI) * 0.06; w *= 1 + k; d *= 1 + k; h *= 1 - k; }
    this.box(g, p.x, p.y, w, d, h, s.top, s.left, s.right, s.flash / 0.15 * 0.55);
  }

  piece(g: CanvasRenderingContext2D, p: Piece): void {
    const c = this.project(p.x, p.y + CFG.height / 2, p.z);
    const a = Math.min(1, p.life / 0.4);
    g.save();
    g.globalAlpha = a;
    g.translate(c.x, c.y);
    g.rotate(p.rot);
    this.box(g, 0, CFG.height / 2 * this.k, p.w, p.d, CFG.height, p.top, p.left, p.right);
    g.restore();
  }

  /** Perfect ripple: an expanding outline of the slab's top face. */
  ripple(g: CanvasRenderingContext2D, s: Slab, t: number): void {
    const k = this.k, grow = 1 + t * 0.7;
    const p = this.project(s.x, s.y + CFG.height, s.z);
    const hw = s.w / 2 * grow, hd = s.d / 2 * grow;
    g.globalAlpha = Math.max(0, 1 - t);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(p.x + (-hw + hd) * COS * k, p.y + (-hw - hd) * SIN * k);
    g.lineTo(p.x + (hw + hd) * COS * k, p.y + (hw - hd) * SIN * k);
    g.lineTo(p.x + (hw - hd) * COS * k, p.y + (hw + hd) * SIN * k);
    g.lineTo(p.x + (-hw - hd) * COS * k, p.y + (-hw + hd) * SIN * k);
    g.closePath();
    g.stroke();
    g.globalAlpha = 1;
  }

  scene(g: CanvasRenderingContext2D, sim: StackSim, ripples: { t: number; slab: Slab }[]): void {
    const top = sim.top;
    // Base column fading into the background.
    const base = sim.floors[0];
    const bp = this.project(base.x, base.y - 520, base.z);
    this.box(g, bp.x, bp.y, base.w, base.d, 520 + CFG.height, base.top, base.left, base.right);
    const fadeTop = this.project(0, base.y - 40, 0).y;
    const fade = g.createLinearGradient(0, fadeTop, 0, fadeTop + 420 * this.k);
    fade.addColorStop(0, 'rgba(14,15,26,0)');
    fade.addColorStop(1, 'rgba(14,15,26,1)');
    g.fillStyle = fade;
    g.fillRect(0, fadeTop, this.W, this.H - fadeTop + 10);

    const ref = top.x + top.z;
    for (const p of sim.pieces) if (p.alive && p.x + p.z < ref) this.piece(g, p);
    for (let i = 1; i < sim.floors.length; i++) {
      const f = sim.floors[i];
      // Skip floors far below the screen.
      if (this.project(f.x, f.y + CFG.height, f.z).y - CFG.base * this.k > this.H) continue;
      this.slab(g, f);
    }
    for (const r of ripples) this.ripple(g, r.slab, r.t);
    if (sim.moving) this.slab(g, sim.moving);
    for (const p of sim.pieces) if (p.alive && p.x + p.z >= ref) this.piece(g, p);
  }
}
