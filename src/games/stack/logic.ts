import type { Rng } from '../../engine/rng';
import { CFG } from './config';

export type Axis = 'x' | 'z';

export interface Slab {
  x: number; z: number;        // centre
  w: number; d: number;        // extent along x / z
  y: number;                   // bottom height
  hue: number;
  top: string; left: string; right: string;   // cached face colours
  flash: number;               // seconds of white flash left
  grow: number;                // 0..1 grow-back stretch animation
}

export interface Piece {
  alive: boolean;
  x: number; y: number; z: number; w: number; d: number;
  vx: number; vy: number; vz: number;
  rot: number; vr: number; life: number;
  top: string; left: string; right: string;
}

export type DropResult =
  | { kind: 'perfect'; streak: number; grew: boolean }
  | { kind: 'slice'; cut: number; edgeX: number; edgeZ: number }
  | { kind: 'miss' };

export function faceColors(hue: number): { top: string; left: string; right: string } {
  const h = Math.round(hue);
  return { top: `hsl(${h},70%,68%)`, left: `hsl(${h},70%,56%)`, right: `hsl(${h},62%,43%)` };
}

export class StackSim {
  floors: Slab[] = [];
  moving: Slab | null = null;
  axis: Axis = 'x';
  /** Offset of the moving slab along its axis, relative to the slab below. */
  off = 0;
  prevOff = 0;
  dir = 1;
  speed: number = CFG.speed0;
  pieces: Piece[] = Array.from({ length: CFG.maxPieces }, () => ({
    alive: false, x: 0, y: 0, z: 0, w: 0, d: 0, vx: 0, vy: 0, vz: 0, rot: 0, vr: 0, life: 0, top: '', left: '', right: '',
  }));
  streak = 0;
  bestStreak = 0;
  perfects = 0;
  baseHue = 0;
  over = false;

  constructor(private rng: Rng) {}

  reset(seed: number): void {
    this.rng.seed(seed);
    this.baseHue = this.rng.range(0, 360);
    this.floors.length = 0;
    this.floors.push(this.makeSlab(0, 0, CFG.base, CFG.base, -CFG.height, 0));
    for (const p of this.pieces) p.alive = false;
    this.streak = 0; this.bestStreak = 0; this.perfects = 0;
    this.over = false;
    this.spawnNext();
  }

  /** Floors placed (excludes the base). */
  get score(): number { return this.floors.length - 1; }
  get top(): Slab { return this.floors[this.floors.length - 1]; }

  private makeSlab(x: number, z: number, w: number, d: number, y: number, floor: number): Slab {
    const hue = (this.baseHue + floor * 4) % 360;
    return { x, z, w, d, y, hue, ...faceColors(hue), flash: 0, grow: 0 };
  }

  private spawnNext(): void {
    const prev = this.top;
    const n = this.floors.length;  // floor number of the new slab
    this.axis = n % 2 === 1 ? 'x' : 'z';
    const size = this.axis === 'x' ? prev.w : prev.d;
    this.dir = 1;
    this.off = -CFG.swing * size;
    this.prevOff = this.off;
    this.moving = this.makeSlab(prev.x, prev.z, prev.w, prev.d, prev.y + CFG.height, n);
    let sp = Math.min(CFG.speedMax, CFG.speed0 * Math.pow(CFG.speedGrow, n - 1));
    if (n >= CFG.breatherEvery && n % CFG.breatherEvery < CFG.breatherLen) sp *= CFG.breatherMul;
    this.speed = sp;
    this.applyOffset();
  }

  private applyOffset(): void {
    const m = this.moving!, prev = this.top;
    if (this.axis === 'x') { m.x = prev.x + this.off; m.z = prev.z; } else { m.z = prev.z + this.off; m.x = prev.x; }
  }

  update(dt: number): void {
    for (const f of this.floors) {
      if (f.flash > 0) f.flash = Math.max(0, f.flash - dt);
      if (f.grow > 0) f.grow = Math.max(0, f.grow - dt * 3);
    }
    if (this.moving && !this.over) {
      const m = this.moving;
      const size = this.axis === 'x' ? m.w : m.d;
      const lim = CFG.swing * size;
      this.prevOff = this.off;
      this.off += this.dir * this.speed * dt;
      if (this.off > lim) { this.off = lim - (this.off - lim); this.dir = -1; }
      else if (this.off < -lim) { this.off = -lim + (-lim - this.off); this.dir = 1; }
      this.applyOffset();
    }
    for (const p of this.pieces) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy -= CFG.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.vr * dt;
    }
  }

  /** Resolve a tap. */
  drop(): DropResult {
    const m = this.moving!, prev = this.top;
    const onX = this.axis === 'x';
    const size = onX ? m.w : m.d;
    const delta = onX ? m.x - prev.x : m.z - prev.z;
    const tol = Math.max(CFG.perfectAbs, CFG.perfectRel * size);
    let result: DropResult;

    if (Math.abs(delta) <= tol) {
      if (onX) m.x = prev.x; else m.z = prev.z;
      this.streak++; this.perfects++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      let grew = false;
      if (this.streak >= CFG.growAfter) {
        const nw = Math.min(CFG.base, m.w + CFG.grow), nd = Math.min(CFG.base, m.d + CFG.grow);
        grew = nw !== m.w || nd !== m.d;
        m.w = nw; m.d = nd;
        if (grew) m.grow = 1;
      }
      result = { kind: 'perfect', streak: this.streak, grew };
    } else {
      const overlap = size - Math.abs(delta);
      if (overlap <= 0) {
        this.spawnPiece(m.x, m.y, m.z, m.w, m.d, m, onX ? this.dir * this.speed * 0.4 : 0, onX ? 0 : this.dir * this.speed * 0.4);
        this.moving = null;
        this.over = true;
        this.streak = 0;
        return { kind: 'miss' };
      }
      this.streak = 0;
      const s = Math.sign(delta), cut = Math.abs(delta);
      const pc = (onX ? prev.x : prev.z) + s * (size / 2 + cut / 2);
      const nc = (onX ? prev.x : prev.z) + delta / 2;
      const edge = (onX ? prev.x : prev.z) + s * size / 2;
      if (onX) {
        this.spawnPiece(pc, m.y, m.z, cut, m.d, m, s * 60, 0);
        m.x = nc; m.w = overlap;
        result = { kind: 'slice', cut, edgeX: edge, edgeZ: m.z };
      } else {
        this.spawnPiece(m.x, m.y, pc, m.w, cut, m, 0, s * 60);
        m.z = nc; m.d = overlap;
        result = { kind: 'slice', cut, edgeX: m.x, edgeZ: edge };
      }
    }
    m.flash = 0.15;
    this.floors.push(m);
    this.moving = null;
    this.spawnNext();
    return result;
  }

  private spawnPiece(x: number, y: number, z: number, w: number, d: number, c: Slab, vx: number, vz: number): void {
    let p = this.pieces.find((q) => !q.alive);
    if (!p) p = this.pieces.reduce((a, b) => (a.life < b.life ? a : b));
    p.alive = true;
    p.x = x; p.y = y; p.z = z; p.w = w; p.d = d;
    p.vx = vx; p.vz = vz; p.vy = 120;
    p.rot = 0;
    p.vr = this.rng.sign() * this.rng.range(60, 180) * Math.PI / 180;
    p.life = CFG.pieceLife;
    p.top = c.top; p.left = c.left; p.right = c.right;
  }
}
