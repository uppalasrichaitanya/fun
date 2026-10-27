import { pent } from '../../engine/audio';
import { TAU } from '../../engine/math';
import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { CFG, DANGER_Y, H, HOLD_Y, JAR, MUSIC, TIERS, W } from './config';
import { MergeSim, type Ball } from './logic';

const NEXT = { x: 362, y: 78, r: 22 };
const sprites = new Map<number, HTMLCanvasElement>();

/** Glossy orb for a tier, rendered once at 2x. */
function orb(tier: number): HTMLCanvasElement {
  let c = sprites.get(tier);
  if (c) return c;
  const r = TIERS[tier].r, s = 2, size = Math.ceil(r * 2 * s) + 4;
  c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const m = size / 2;
  const col = TIERS[tier].color;
  const grad = g.createRadialGradient(m - r * s * 0.35, m - r * s * 0.4, r * s * 0.1, m, m, r * s);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.18, col);
  grad.addColorStop(1, shade(col, -0.35));
  g.fillStyle = grad;
  g.beginPath(); g.arc(m, m, r * s, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.beginPath(); g.ellipse(m - r * s * 0.35, m - r * s * 0.5, r * s * 0.32, r * s * 0.16, -0.5, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(14,15,26,0.35)';
  g.lineWidth = 2 * s;
  g.beginPath(); g.arc(m, m, r * s - s, 0, TAU); g.stroke();
  sprites.set(tier, c);
  return c;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

interface Ring { x: number; y: number; r: number; t: number; color: string }

class MergeDrop implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private vis = new Rng();
  private sim = new MergeSim(this.rng);
  private demo = false;
  private rings: Ring[] = [];
  private beatT = 0;
  private shimmer = 0;
  private overT = -1;
  private demoTarget = 200;
  private demoWait = 0;
  private landCool = 0;
  private dropAnim = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const toAim = (x: number) => { this.sim.aimX = this.sim.clampAim(x); };
    ctx.input.on('down', (p) => {
      if (this.demo) return;
      toAim(p.x);
    });
    ctx.input.on('move', (p) => {
      if (this.demo) return;
      if (p.type === 'mouse' || p.down) toAim(p.x);
    });
    ctx.input.on('up', () => {
      if (this.demo) return;
      this.drop();
    });
    ctx.input.onKey((code) => {
      if (this.demo) return;
      if (code === 'Space' || code === 'ArrowDown' || code === 'KeyS') this.drop();
    });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.rng.seed(seed);
    this.vis.seed(seed ^ 0x55);
    this.sim.reset();
    this.rings.length = 0;
    this.overT = -1;
    this.shimmer = 0;
    this.demoWait = 0.6;
    this.dropAnim = 1;
    this.ctx.audio.music(MUSIC);
    if (!this.demo) this.ctx.shell.setScore(0);
  }

  private drop(): void {
    const tier = this.sim.held;
    if (!this.sim.drop()) return;
    this.dropAnim = 0;
    this.ctx.audio.pluck(pent(Math.max(0, 6 - tier), 392), 0.16);
  }

  update(dt: number): void {
    const { sim, ctx } = this;
    const { input, fx, audio } = ctx;
    if (!this.demo && !sim.over) {
      let d = 0;
      if (input.isDown('ArrowLeft', 'KeyA')) d -= 1;
      if (input.isDown('ArrowRight', 'KeyD')) d += 1;
      if (d) sim.aimX = sim.clampAim(sim.aimX + d * CFG.aimSpeed * dt);
    }
    if (this.demo) this.autopilot(dt);
    if (!sim.over) sim.step(dt);
    this.dropAnim = Math.min(1, this.dropAnim + dt / 0.25);
    if (this.landCool > 0) this.landCool -= dt;
    for (const e of sim.events) {
      switch (e.type) {
        case 'land':
          if (this.landCool <= 0) {
            audio.thud(Math.min(1, e.speed / 900) * 0.7);
            this.landCool = 0.05;
          }
          break;
        case 'merge': {
          const col = TIERS[e.tier].color;
          fx.particles.burst(e.x, e.y, col, { count: 14, speed: 220 + e.tier * 12, size: 5, life: 0.6 });
          this.rings.push({ x: e.x, y: e.y, r: TIERS[e.tier].r, t: 0, color: col });
          fx.camera.shake(Math.min(0.6, 0.08 * (e.tier + 1) * 0.5));
          if (e.tier >= 6) fx.time.hitStop(50);
          audio.pop(pent(e.tier, 330), 0.22);
          audio.chime(e.tier, 0.08);
          fx.floaters.add(`+${e.pts}`, e.x, e.y - 10, col, 20);
          if (e.chain >= 2) {
            fx.floaters.add(`CHAIN x${e.mult}`, e.x, e.y - 40, col, 24);
            audio.sparkle(pent(e.chain + 3, 784));
          }
          if (!this.demo) ctx.shell.setScore(sim.score);
          break;
        }
        case 'supernova':
          fx.particles.burst(e.x, e.y, C.yellow, { count: 80, speed: 620, size: 7, life: 1.2, colors: [C.yellow, C.white, C.pink, C.cyan] });
          this.rings.push({ x: e.x, y: e.y, r: 160, t: 0, color: C.yellow });
          this.shimmer = 1;
          fx.camera.shake(0.8);
          fx.time.slowMo(0.3, 450);
          audio.fanfare();
          fx.floaters.add('SUPERNOVA +500', W / 2, 260, C.yellow, 30);
          if (!this.demo) ctx.shell.setScore(sim.score);
          break;
        case 'over':
          this.overT = 0;
          fx.time.hitStop(120);
          fx.camera.shake(0.5);
          audio.tone({ f: 330, f2: 82, type: 'triangle', d: 0.9, g: 0.2 });
          if (!this.demo) {
            ctx.shell.gameOver({
              score: sim.score,
              stats: [
                { label: 'biggest', value: `Tier ${sim.biggest + 1}` },
                { label: 'longest chain', value: `x${sim.bestChain}` },
                { label: 'balls dropped', value: String(sim.dropped) },
              ],
            }, 800);
          }
          break;
        default: break;
      }
    }
    sim.events.length = 0;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].t += dt / 0.45;
      if (this.rings[i].t >= 1) this.rings.splice(i, 1);
    }
    this.shimmer = Math.max(0, this.shimmer - dt * 1.5);
    // Danger heartbeat: 90 BPM rising to 130.
    if (sim.danger > CFG.dangerWarn && !sim.over) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        const k = Math.min(1, (sim.danger - CFG.dangerWarn) / (CFG.dangerOver - CFG.dangerWarn));
        audio.heartbeat(0.25 + 0.15 * k);
        this.beatT = 60 / (90 + 40 * k);
      }
    } else this.beatT = 0;
    if (this.overT >= 0) {
      this.overT += dt;
      if (this.demo && this.overT > 2.5) this.start(this.rng.int(1, 1e9), { demo: true });
    }
  }

  /** Attract mode: aim for a same-tier ball near the top, else the lowest surface. */
  private autopilot(dt: number): void {
    const sim = this.sim;
    if (sim.over) return;
    this.demoWait -= dt;
    const d = this.demoTarget - sim.aimX;
    sim.aimX = sim.clampAim(sim.aimX + Math.sign(d) * Math.min(Math.abs(d), CFG.aimSpeed * dt));
    if (this.demoWait > 0 || !sim.canDrop()) return;
    if (Math.abs(d) < 3) {
      this.drop();
      this.demoWait = this.vis.range(0.5, 1.1);
      this.pickTarget();
    } else if (this.demoWait < -2) this.pickTarget();
  }

  private pickTarget(): void {
    const sim = this.sim;
    let best = W / 2, bestScore = -Infinity;
    for (let x = JAR.l + 20; x <= JAR.r - 20; x += 16) {
      const y = sim.surfaceBelow(x);
      let s = y * 0.2 + this.vis.next() * 20;
      for (const b of sim.balls) if (b.tier === sim.held && Math.abs(b.x - x) < b.r * 0.6 && Math.abs(b.y - b.r - y) < 4) s += 200;
      if (s > bestScore) { bestScore = s; best = x; }
    }
    this.demoTarget = best;
  }

  render(alpha: number): void {
    void alpha;
    const { canvas, fx } = this.ctx;
    const g = canvas.begin('#0B0C17');
    const sim = this.sim;
    const t = sim.t;
    fx.camera.begin(g, W, H);
    // Backdrop glow.
    const bg = g.createRadialGradient(W / 2, H * 0.55, 40, W / 2, H * 0.55, 420);
    bg.addColorStop(0, rgba(C.pink, 0.1)); bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    this.drawJar(g);
    // Danger line: faint until threatened, then red and pulsing.
    const warn = sim.danger > CFG.dangerWarn;
    g.save();
    g.setLineDash([10, 9]);
    g.lineWidth = warn ? 3 : 2;
    g.strokeStyle = warn ? rgba(C.pink, 0.55 + 0.45 * Math.sin(t * 14)) : 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(JAR.l + 4, DANGER_Y); g.lineTo(JAR.r - 4, DANGER_Y); g.stroke();
    g.restore();
    // Guide line and held ball.
    if (!sim.over) {
      const x = sim.clampAim(sim.aimX), r = sim.heldR;
      const y0 = HOLD_Y + r, y1 = sim.surfaceBelow(x);
      g.save();
      g.setLineDash([4, 8]);
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y0 + 4); g.lineTo(x, y1); g.stroke();
      g.restore();
      const k = sim.cooldown > 0 ? 1 - sim.cooldown / CFG.cooldown : 1;
      g.globalAlpha = 0.35 + 0.65 * k;
      this.drawOrb(g, sim.held, x, HOLD_Y, r * (0.6 + 0.4 * ease.outBack(Math.min(1, this.dropAnim * 2))), 1, null, false, t);
      g.globalAlpha = 1;
    }
    for (const b of sim.balls) this.drawOrb(g, b.tier, b.x, b.y, b.r, b.sq, b, sim.isWorried(b) || sim.over, t);
    for (const r of this.rings) {
      g.globalAlpha = 1 - r.t;
      g.strokeStyle = r.color;
      g.lineWidth = 4 * (1 - r.t) + 1;
      g.beginPath(); g.arc(r.x, r.y, r.r * (1 + r.t * 0.9), 0, TAU); g.stroke();
    }
    g.globalAlpha = 1;
    fx.particles.render(g);
    fx.floaters.render(g);
    fx.camera.end(g);
    // Next bubble.
    g.fillStyle = 'rgba(24,26,43,0.85)';
    g.beginPath(); g.arc(NEXT.x, NEXT.y, NEXT.r + 6, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; g.stroke();
    this.drawOrb(g, sim.next, NEXT.x, NEXT.y, Math.min(NEXT.r - 2, TIERS[sim.next].r), 1, null, false, t);
    g.font = `700 11px ${FONT.title}`;
    g.fillStyle = C.muted;
    g.textAlign = 'center';
    g.fillText('NEXT', NEXT.x, NEXT.y + NEXT.r + 18);
    if (this.shimmer > 0) {
      g.globalAlpha = this.shimmer * 0.35;
      g.fillStyle = C.yellow;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
    if (this.ctx.preview) {
      g.font = `700 40px ${FONT.title}`;
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.textAlign = 'left';
      g.fillText(String(sim.score), 30, 60);
    }
  }

  private drawJar(g: CanvasRenderingContext2D): void {
    const { l, r, rim, bottom, corner } = JAR;
    g.fillStyle = 'rgba(255,79,139,0.05)';
    g.beginPath();
    g.moveTo(l, rim);
    g.lineTo(l, bottom - corner); g.arcTo(l, bottom, l + corner, bottom, corner);
    g.lineTo(r - corner, bottom); g.arcTo(r, bottom, r, bottom - corner, corner);
    g.lineTo(r, rim);
    g.fill();
    g.lineCap = 'round';
    g.strokeStyle = rgba(C.pink, 0.25); g.lineWidth = 12; g.stroke();
    g.strokeStyle = C.pink; g.lineWidth = 4; g.stroke();
  }

  private drawOrb(g: CanvasRenderingContext2D, tier: number, x: number, y: number, r: number, sq: number, b: Ball | null, worried: boolean, t: number): void {
    const img = orb(tier);
    const s = r / TIERS[tier].r;
    const sy = Math.max(0.7, Math.min(1.25, sq)), sx = 1 / sy;
    g.save();
    g.translate(x, y + r * (1 - sy));
    g.scale(s * sx, s * sy);
    const half = img.width / 4;
    g.drawImage(img, -half, -half, half * 2, half * 2);
    if (tier === TIERS.length - 1) {
      // Shimmering top tier.
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `hsla(${(t * 120) % 360},90%,70%,0.25)`;
      g.beginPath(); g.arc(0, 0, TIERS[tier].r, 0, TAU); g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    this.face(g, TIERS[tier].r, tier, b, worried);
    g.restore();
  }

  /** Two eyes and a mouth; eyes follow the held ball, faces get bigger with tier. */
  private face(g: CanvasRenderingContext2D, R: number, tier: number, b: Ball | null, worried: boolean): void {
    const sim = this.sim;
    let lx = 0, ly = 0;
    if (b) {
      const dx = sim.clampAim(sim.aimX) - b.x, dy = HOLD_Y - b.y, d = Math.hypot(dx, dy) || 1;
      lx = dx / d; ly = dy / d;
    } else ly = 1;
    const ex = R * 0.3, ey = -R * 0.08, er = R * (0.13 + tier * 0.004), pr = er * 0.55;
    const blink = b && b.blink < 0;
    for (const side of [-1, 1]) {
      const cx = side * ex;
      if (blink) {
        g.strokeStyle = '#1B1430'; g.lineWidth = Math.max(1.5, R * 0.05);
        g.beginPath(); g.moveTo(cx - er, ey); g.lineTo(cx + er, ey); g.stroke();
        continue;
      }
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(cx, ey, worried ? er * 1.25 : er, 0, TAU); g.fill();
      g.fillStyle = '#1B1430';
      g.beginPath(); g.arc(cx + lx * er * 0.4, ey + ly * er * 0.4, worried ? pr * 0.7 : pr, 0, TAU); g.fill();
    }
    g.strokeStyle = '#1B1430';
    g.lineWidth = Math.max(1.5, R * 0.06);
    g.lineCap = 'round';
    g.beginPath();
    if (worried) {
      g.arc(0, R * 0.32, R * 0.09, 0, TAU);
      // Worried brows.
      g.moveTo(-ex - er, ey - er * 1.7); g.lineTo(-ex + er, ey - er * 2.2);
      g.moveTo(ex + er, ey - er * 1.7); g.lineTo(ex - er, ey - er * 2.2);
    } else {
      const w = R * (0.12 + tier * 0.012);
      g.arc(0, R * 0.16, w, 0.15 * Math.PI, 0.85 * Math.PI);
    }
    g.stroke();
    if (tier >= 4 && !worried) {
      g.fillStyle = 'rgba(255,79,139,0.35)';
      for (const side of [-1, 1]) { g.beginPath(); g.ellipse(side * R * 0.5, R * 0.18, R * 0.1, R * 0.06, 0, 0, TAU); g.fill(); }
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number> {
    const s = this.sim;
    return { balls: s.balls.length, sleeping: s.balls.filter((b) => b.sleeping).length, danger: s.danger, chain: s.chain };
  }
}

export default (): Game => new MergeDrop();
