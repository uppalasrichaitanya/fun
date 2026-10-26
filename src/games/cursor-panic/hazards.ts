import { drawGlow } from '../../engine/glow';
import { circleRect, dist2, pointSegDist2, TAU } from '../../engine/math';
import { C, rgba } from '../../engine/theme';
import { Kind, KIND_COLOR } from './config';

export interface Bullet { alive: boolean; x: number; y: number; vx: number; vy: number; r: number; kind: Kind; grazed: boolean }
export interface Laser {
  alive: boolean; x: number; y: number; a0: number; angle: number; len: number; width: number;
  t: number; warn: number; fire: number; sweep: number; span: number; kind: Kind; grazed: boolean; hummed: boolean;
}
export interface Wall {
  alive: boolean; vertical: boolean; pos: number; vel: number; gapA: number; gapB: number;
  thick: number; t: number; warn: number; kind: Kind; grazed: boolean;
}
export interface Saw { alive: boolean; x: number; y: number; vx: number; vy: number; r: number; t: number; life: number; kind: Kind; grazed: boolean }
export interface Mine { alive: boolean; x: number; y: number; vx: number; vy: number; r: number; t: number; fuse: number; speed: number; kind: Kind; grazed: boolean }
export interface Emitter {
  alive: boolean; x: number; y: number; t: number; grow: number; dur: number; ang: number; spin: number;
  rate: number; acc: number; arms: number; speed: number; kind: Kind; grazed: boolean;
}
export interface Mark { alive: boolean; x: number; y: number; w: number; h: number; t: number; dur: number; color: string }

const pool = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

export interface Hit { kind: Kind; x: number; y: number }

/** Every hazard in Cursor Panic, pooled. */
export class Hazards {
  W = 800; H = 600;
  bullets = pool<Bullet>(520, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, r: 6, kind: Kind.Volley, grazed: false }));
  lasers = pool<Laser>(16, () => ({ alive: false, x: 0, y: 0, a0: 0, angle: 0, len: 0, width: 12, t: 0, warn: 0, fire: 0, sweep: 0, span: 0, kind: Kind.Grid, grazed: false, hummed: false }));
  walls = pool<Wall>(4, () => ({ alive: false, vertical: true, pos: 0, vel: 0, gapA: 0, gapB: 0, thick: 18, t: 0, warn: 0, kind: Kind.Walls, grazed: false }));
  saws = pool<Saw>(16, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, r: 15, t: 0, life: 0, kind: Kind.Bouncers, grazed: false }));
  mines = pool<Mine>(10, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, r: 11, t: 0, fuse: 4, speed: 60, kind: Kind.Mines, grazed: false }));
  emitters = pool<Emitter>(4, () => ({ alive: false, x: 0, y: 0, t: 0, grow: 0.6, dur: 5, ang: 0, spin: 2, rate: 6, acc: 0, arms: 3, speed: 150, kind: Kind.Spiral, grazed: false }));
  marks = pool<Mark>(64, () => ({ alive: false, x: 0, y: 0, w: 0, h: 0, t: 0, dur: 0, color: C.pink }));
  bulletCount = 0;
  /** Called when a laser starts charging or a mine explodes (for sound). */
  onEvent: (e: 'charge' | 'fire' | 'boom', x: number, y: number) => void = () => {};

  clear(): void {
    for (const list of [this.bullets, this.lasers, this.walls, this.saws, this.mines, this.emitters, this.marks] as { alive: boolean }[][]) {
      for (const o of list) o.alive = false;
    }
    this.bulletCount = 0;
  }

  private free<T extends { alive: boolean }>(list: T[]): T | null {
    for (const o of list) if (!o.alive) return o;
    return null;
  }

  bullet(x: number, y: number, vx: number, vy: number, r: number, kind: Kind): void {
    const b = this.free(this.bullets);
    if (!b) return;
    b.alive = true; b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.r = r; b.kind = kind; b.grazed = false;
  }

  laser(x: number, y: number, angle: number, len: number, warn: number, fire: number, sweep: number, span: number, kind: Kind, width = 12): void {
    const l = this.free(this.lasers);
    if (!l) return;
    l.alive = true; l.x = x; l.y = y; l.a0 = angle; l.angle = angle; l.len = len; l.width = width;
    l.t = 0; l.warn = warn; l.fire = fire; l.sweep = sweep; l.span = span; l.kind = kind; l.grazed = false; l.hummed = false;
  }

  wall(vertical: boolean, fromStart: boolean, gapA: number, gapB: number, speed: number, warn: number): void {
    const w = this.free(this.walls);
    if (!w) return;
    const extent = vertical ? this.W : this.H;
    w.alive = true; w.vertical = vertical; w.thick = 18;
    w.pos = fromStart ? -w.thick : extent + w.thick;
    w.vel = fromStart ? speed : -speed;
    w.gapA = gapA; w.gapB = gapB; w.t = 0; w.warn = warn; w.kind = Kind.Walls; w.grazed = false;
    // Telegraph: highlight the gap on the entry edge.
    if (vertical) this.mark(fromStart ? 0 : this.W - 10, gapA, 10, gapB - gapA, warn, C.green);
    else this.mark(gapA, fromStart ? 0 : this.H - 10, gapB - gapA, 10, warn, C.green);
  }

  saw(x: number, y: number, vx: number, vy: number, life: number): void {
    const s = this.free(this.saws);
    if (!s) return;
    s.alive = true; s.x = x; s.y = y; s.vx = vx; s.vy = vy; s.r = 15; s.t = 0; s.life = life; s.grazed = false;
  }

  mine(x: number, y: number, speed: number): void {
    const m = this.free(this.mines);
    if (!m) return;
    m.alive = true; m.x = x; m.y = y; m.vx = 0; m.vy = 0; m.speed = speed; m.t = 0; m.fuse = 4; m.grazed = false;
  }

  emitter(x: number, y: number, dur: number, rate: number, arms: number, speed: number, spin: number): void {
    const e = this.free(this.emitters);
    if (!e) return;
    e.alive = true; e.x = x; e.y = y; e.t = 0; e.grow = 0.6; e.dur = dur; e.ang = 0; e.spin = spin;
    e.rate = rate; e.acc = 0; e.arms = arms; e.speed = speed; e.grazed = false;
  }

  mark(x: number, y: number, w: number, h: number, dur: number, color: string): void {
    const m = this.free(this.marks);
    if (!m) return;
    m.alive = true; m.x = x; m.y = y; m.w = w; m.h = h; m.t = 0; m.dur = dur; m.color = color;
  }

  update(dt: number, px: number, py: number): void {
    const W = this.W, H = this.H, M = 80;
    let n = 0;
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -M || b.y < -M || b.x > W + M || b.y > H + M) { b.alive = false; continue; }
      n++;
    }
    this.bulletCount = n;
    for (const l of this.lasers) {
      if (!l.alive) continue;
      l.t += dt;
      if (!l.hummed) { l.hummed = true; this.onEvent('charge', l.x, l.y); }
      const ft = l.t - l.warn;
      if (ft >= 0 && ft - dt < 0) this.onEvent('fire', l.x, l.y);
      l.angle = l.a0 + l.sweep * Math.max(0, Math.min(l.fire, ft));
      if (ft > l.fire) l.alive = false;
    }
    for (const w of this.walls) {
      if (!w.alive) continue;
      w.t += dt;
      if (w.t < w.warn) continue;
      w.pos += w.vel * dt;
      const extent = w.vertical ? W : H;
      if (w.pos < -w.thick * 2 || w.pos > extent + w.thick * 2) w.alive = false;
    }
    for (const s of this.saws) {
      if (!s.alive) continue;
      s.t += dt;
      if (s.t < 0.5) continue;
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.x < s.r) { s.x = s.r; s.vx = Math.abs(s.vx); }
      if (s.x > W - s.r) { s.x = W - s.r; s.vx = -Math.abs(s.vx); }
      if (s.y < s.r) { s.y = s.r; s.vy = Math.abs(s.vy); }
      if (s.y > H - s.r) { s.y = H - s.r; s.vy = -Math.abs(s.vy); }
      if (s.t > s.life) s.alive = false;
    }
    for (const m of this.mines) {
      if (!m.alive) continue;
      m.t += dt;
      // Steer toward the player with a limited turn rate.
      const want = Math.atan2(py - m.y, px - m.x);
      const cur = m.vx === 0 && m.vy === 0 ? want : Math.atan2(m.vy, m.vx);
      let d = want - cur;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const a = cur + Math.max(-1.8 * dt, Math.min(1.8 * dt, d));
      m.vx = Math.cos(a) * m.speed; m.vy = Math.sin(a) * m.speed;
      m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.t >= m.fuse) {
        m.alive = false;
        this.onEvent('boom', m.x, m.y);
        const k = 10, sp = m.speed * 2.6;
        for (let i = 0; i < k; i++) {
          const ang = (i / k) * TAU + m.t;
          this.bullet(m.x, m.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 5, Kind.Mines);
        }
      }
    }
    for (const e of this.emitters) {
      if (!e.alive) continue;
      e.t += dt;
      if (e.t < e.grow) continue;
      e.ang += e.spin * dt;
      e.acc += dt * e.rate;
      while (e.acc >= 1) {
        e.acc -= 1;
        for (let i = 0; i < e.arms; i++) {
          const a = e.ang + (i / e.arms) * TAU;
          this.bullet(e.x + Math.cos(a) * 14, e.y + Math.sin(a) * 14, Math.cos(a) * e.speed, Math.sin(a) * e.speed, 6, Kind.Spiral);
        }
      }
      if (e.t > e.grow + e.dur) e.alive = false;
    }
    for (const m of this.marks) {
      if (!m.alive) continue;
      m.t += dt;
      if (m.t >= m.dur) m.alive = false;
    }
  }

  /**
   * Returns the hazard that hit (px, py), or null. Calls onGraze for each
   * hazard passing within grazeR of the centre for the first time.
   */
  collide(px: number, py: number, hitR: number, grazeR: number, onGraze: (x: number, y: number) => void): Hit | null {
    let hit: Hit | null = null;
    const check = (o: { grazed: boolean; kind: Kind }, d2: number, r: number, x: number, y: number): void => {
      if (hit) return;
      const hr = r + hitR;
      if (d2 < hr * hr) { hit = { kind: o.kind, x, y }; return; }
      const gr = r + grazeR;
      if (!o.grazed && d2 < gr * gr) { o.grazed = true; onGraze(x, y); }
    };
    for (const b of this.bullets) if (b.alive) check(b, dist2(px, py, b.x, b.y), b.r, b.x, b.y);
    for (const s of this.saws) if (s.alive && s.t >= 0.5) check(s, dist2(px, py, s.x, s.y), s.r * 0.85, s.x, s.y);
    for (const m of this.mines) if (m.alive) check(m, dist2(px, py, m.x, m.y), m.r, m.x, m.y);
    for (const e of this.emitters) if (e.alive && e.t >= e.grow) check(e, dist2(px, py, e.x, e.y), 14, e.x, e.y);
    for (const l of this.lasers) {
      if (!l.alive || l.t < l.warn) continue;
      const ex = l.x + Math.cos(l.angle) * l.len, ey = l.y + Math.sin(l.angle) * l.len;
      check(l, pointSegDist2(px, py, l.x, l.y, ex, ey), l.width / 2, px, py);
    }
    for (const w of this.walls) {
      if (!w.alive || w.t < w.warn || hit) continue;
      const half = w.thick / 2;
      let inside: boolean, near: boolean;
      if (w.vertical) {
        inside = circleRect(px, py, hitR, w.pos - half, 0, w.thick, w.gapA) || circleRect(px, py, hitR, w.pos - half, w.gapB, w.thick, this.H - w.gapB);
        near = Math.abs(px - w.pos) < half + grazeR;
      } else {
        inside = circleRect(px, py, hitR, 0, w.pos - half, w.gapA, w.thick) || circleRect(px, py, hitR, w.gapB, w.pos - half, this.W - w.gapB, w.thick);
        near = Math.abs(py - w.pos) < half + grazeR;
      }
      if (inside) hit = { kind: w.kind, x: px, y: py };
      else if (near && !w.grazed) { w.grazed = true; onGraze(px, py); }
    }
    return hit;
  }

  render(g: CanvasRenderingContext2D, time: number): void {
    const W = this.W, H = this.H;
    // Telegraph marks.
    for (const m of this.marks) {
      if (!m.alive) continue;
      const p = 0.5 + 0.5 * Math.sin(m.t * 30);
      g.fillStyle = rgba(m.color, 0.25 + 0.35 * p);
      g.fillRect(m.x, m.y, m.w, m.h);
    }
    // Lasers.
    for (const l of this.lasers) {
      if (!l.alive) continue;
      if (l.t < l.warn) {
        const k = l.t / l.warn;
        if (l.span !== 0) {
          g.fillStyle = rgba(C.pink, 0.07 + 0.06 * k);
          g.beginPath(); g.moveTo(l.x, l.y);
          g.arc(l.x, l.y, l.len, Math.min(l.a0, l.a0 + l.span), Math.max(l.a0, l.a0 + l.span));
          g.closePath(); g.fill();
        }
        g.strokeStyle = rgba(C.pink, 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(l.t * 40)) * k);
        g.lineWidth = 1.5 + k * 1.5;
        g.setLineDash([10, 8]);
        g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(l.x + Math.cos(l.a0) * l.len, l.y + Math.sin(l.a0) * l.len); g.stroke();
        g.setLineDash([]);
      } else {
        const ex = l.x + Math.cos(l.angle) * l.len, ey = l.y + Math.sin(l.angle) * l.len;
        const fade = Math.min(1, (l.warn + l.fire - l.t) / 0.08 + 0.2);
        g.lineCap = 'round';
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = rgba(C.pink, 0.35 * fade);
        g.lineWidth = l.width * 2.4;
        g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(ex, ey); g.stroke();
        g.globalCompositeOperation = 'source-over';
        g.strokeStyle = rgba('#FFFFFF', fade);
        g.lineWidth = l.width * 0.6;
        g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(ex, ey); g.stroke();
      }
    }
    // Walls.
    for (const w of this.walls) {
      if (!w.alive || w.t < w.warn) continue;
      const half = w.thick / 2;
      g.fillStyle = C.orange;
      g.beginPath();
      if (w.vertical) {
        g.roundRect(w.pos - half, -10, w.thick, w.gapA + 10, 8);
        g.roundRect(w.pos - half, w.gapB, w.thick, H - w.gapB + 10, 8);
      } else {
        g.roundRect(-10, w.pos - half, w.gapA + 10, w.thick, 8);
        g.roundRect(w.gapB, w.pos - half, W - w.gapB + 10, w.thick, 8);
      }
      g.fill();
      g.fillStyle = rgba(C.green, 0.12);
      if (w.vertical) g.fillRect(w.pos - half, w.gapA, w.thick, w.gapB - w.gapA);
      else g.fillRect(w.gapA, w.pos - half, w.gapB - w.gapA, w.thick);
    }
    // Emitters.
    for (const e of this.emitters) {
      if (!e.alive) continue;
      const k = Math.min(1, e.t / e.grow);
      const end = Math.min(1, (e.grow + e.dur - e.t) / 0.3);
      const r = 14 * k * Math.max(0.2, end);
      drawGlow(g, C.violet, e.x, e.y, 40 * k, 0.6);
      g.fillStyle = k < 1 ? rgba(C.violet, 0.5) : C.violet;
      g.beginPath(); g.arc(e.x, e.y, r, 0, TAU); g.fill();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(e.x, e.y, r * 0.4, 0, TAU); g.fill();
    }
    // Saws.
    for (const s of this.saws) {
      if (!s.alive) continue;
      if (s.t < 0.5) {
        const k = s.t / 0.5;
        g.strokeStyle = rgba(C.yellow, 0.4 + 0.5 * k);
        g.lineWidth = 2;
        g.beginPath(); g.arc(s.x, s.y, s.r * (2.6 - 1.6 * k), 0, TAU); g.stroke();
        continue;
      }
      const shrink = Math.min(1, (s.life - s.t) / 0.3);
      const r = s.r * shrink;
      drawGlow(g, C.yellow, s.x, s.y, r * 2.4, 0.35);
      g.fillStyle = C.yellow;
      g.beginPath();
      const teeth = 9, rot = time * 9;
      for (let i = 0; i < teeth * 2; i++) {
        const a = rot + (i / (teeth * 2)) * TAU;
        const rr = i % 2 === 0 ? r * 1.15 : r * 0.82;
        if (i === 0) g.moveTo(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
        else g.lineTo(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
      }
      g.closePath(); g.fill();
      g.fillStyle = C.bg;
      g.beginPath(); g.arc(s.x, s.y, r * 0.3, 0, TAU); g.fill();
    }
    // Mines.
    for (const m of this.mines) {
      if (!m.alive) continue;
      const left = 1 - m.t / m.fuse;
      const blink = Math.sin(m.t * (8 + (1 - left) * 30)) > 0;
      drawGlow(g, C.orange, m.x, m.y, 34, blink ? 0.6 : 0.3);
      g.fillStyle = blink ? '#fff' : C.orange;
      g.beginPath(); g.arc(m.x, m.y, m.r, 0, TAU); g.fill();
      g.strokeStyle = C.orange;
      g.lineWidth = 3;
      g.beginPath(); g.arc(m.x, m.y, m.r + 6, -Math.PI / 2, -Math.PI / 2 + TAU * left); g.stroke();
      g.strokeStyle = rgba(C.orange, 0.18);
      g.lineWidth = 1;
      g.beginPath(); g.arc(m.x, m.y, 46, 0, TAU); g.stroke();
    }
    // Bullets: pre-rendered glowing pills with trails, rotated along velocity.
    const M = g.getTransform();
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const spr = bulletSprite(KIND_COLOR[b.kind], b.r);
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const c = b.vx / sp, s = b.vy / sp;
      g.setTransform(M.a * c + M.c * s, M.b * c + M.d * s, M.a * -s + M.c * c, M.b * -s + M.d * c,
        M.a * b.x + M.c * b.y + M.e, M.b * b.x + M.d * b.y + M.f);
      g.drawImage(spr, -8 * b.r, -3 * b.r, 12 * b.r, 6 * b.r);
    }
    g.setTransform(M);
  }
}

const sprites = new Map<string, HTMLCanvasElement>();
/** Glow + trail + pill for a bullet of radius r, pointing +x, centre at (8r, 3r). */
function bulletSprite(color: string, r: number): HTMLCanvasElement {
  const key = color + r;
  let c = sprites.get(key);
  if (c) return c;
  const S = 3; // supersample for DPR 2 + zoom
  c = document.createElement('canvas');
  c.width = 12 * r * S; c.height = 6 * r * S;
  const g = c.getContext('2d')!;
  g.scale(S, S);
  const cx = 8 * r, cy = 3 * r;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, 3 * r);
  grad.addColorStop(0, rgba(color, 0.55));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 12 * r, 6 * r);
  const tg = g.createLinearGradient(cx - 6 * r, 0, cx, 0);
  tg.addColorStop(0, rgba(color, 0));
  tg.addColorStop(1, rgba(color, 0.5));
  g.strokeStyle = tg;
  g.lineCap = 'round';
  g.lineWidth = r * 1.2;
  g.beginPath(); g.moveTo(cx - 6 * r, cy); g.lineTo(cx, cy); g.stroke();
  g.strokeStyle = color;
  g.lineWidth = r * 2;
  g.beginPath(); g.moveTo(cx - r * 0.7, cy); g.lineTo(cx + r * 0.7, cy); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = r * 0.8;
  g.beginPath(); g.moveTo(cx - r * 0.45, cy); g.lineTo(cx + r * 0.45, cy); g.stroke();
  sprites.set(key, c);
  return c;
}
