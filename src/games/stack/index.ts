import { Rng } from '../../engine/rng';
import { ease } from '../../engine/tween';
import { FONT } from '../../engine/theme';
import { Shape } from '../../engine/particles';
import type { Game, GameContext, StartOpts } from '../../engine/types';
import { CFG, MUSIC } from './config';
import { StackSim, type Slab } from './logic';
import { StackView } from './render';

class StackGame implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private sim = new StackSim(this.rng);
  private view = new StackView();
  private demo = false;
  private camFrom = 0;
  private camTo = 0;
  private camT = 1;
  private overT = -1;
  private zoomFrom = 1; private zoomTo = 1;
  private anchorFrom: number = CFG.topFrac; private anchorTo: number = CFG.topFrac;
  private camOverFrom = 0; private camOverTo = 0;
  private ripples: { t: number; slab: Slab }[] = [];
  private demoTarget = 0;
  private demoMissAt = 0;
  private streakPop = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.input.on('down', () => this.tap());
    ctx.input.onKey((code) => { if (code === 'Space' || code === 'ArrowDown' || code === 'Enter') this.tap(); });
  }

  start(seed: number, opts?: StartOpts): void {
    this.demo = !!opts?.demo;
    this.sim.reset(seed);
    this.camFrom = this.camTo = this.view.camY = 0;
    this.camT = 1;
    this.overT = -1;
    this.view.zoom = 1;
    this.view.anchorFrac = CFG.topFrac;
    this.ripples.length = 0;
    this.streakPop = 0;
    this.pickDemoTarget();
    this.demoMissAt = this.rng.int(12, 26);
    this.ctx.audio.music(MUSIC);
    if (!this.demo) this.ctx.shell.setScore(0);
  }

  private tap(): void {
    if (this.demo || this.sim.over || !this.sim.moving) return;
    this.resolve();
  }

  private resolve(): void {
    const { audio, fx } = this.ctx;
    const r = this.sim.drop();
    const top = this.sim.top;
    if (r.kind === 'miss') {
      audio.thud(1);
      audio.tone({ f: 300, f2: 70, type: 'triangle', d: 0.6, g: 0.18 });
      fx.camera.shake(0.4);
      fx.time.hitStop(60);
      this.overT = 0;
      if (!this.demo) {
        const s = this.sim;
        this.ctx.shell.gameOver({
          score: s.score,
          stats: [
            { label: 'floors', value: String(s.score) },
            { label: 'best streak', value: String(s.bestStreak) },
            { label: 'perfects', value: String(s.perfects) },
          ],
        }, (CFG.overZoomDelay + CFG.overZoomDur) * 1000 + 150);
      }
      return;
    }
    // Camera rises to keep the top at 40% from the top of the screen.
    this.camFrom = this.view.camY;
    this.camTo = top.y + CFG.height;
    this.camT = 0;
    const p = this.view.project(top.x, top.y + CFG.height, top.z);
    if (r.kind === 'perfect') {
      audio.chime(Math.min(14, r.streak - 1));
      this.ripples.push({ t: 0, slab: top });
      fx.floaters.add(r.streak > 1 ? `PERFECT x${r.streak}` : 'PERFECT', p.x, p.y - 30 * this.view.k - 10, '#ffffff', 22);
      fx.particles.sparkle(p.x, p.y, '#ffffff', 10, top.w * 0.5 * this.view.k);
      fx.camera.shake(0.05);
      this.streakPop = 1;
      if (r.grew) { audio.sparkle(); fx.particles.burst(p.x, p.y, top.top, { count: 16, speed: 180, size: 4, gravity: 300 }); }
    } else {
      audio.tone({ f: 190, f2: 95, type: 'triangle', d: 0.12, g: 0.3, vary: 0.08 });
      audio.noise({ d: 0.05, g: 0.12, f: 900, q: 2 });
      audio.whoosh(0.08 + Math.min(0.12, r.cut / 400), 0.22);
      const e = this.view.project(r.edgeX, top.y + CFG.height, r.edgeZ);
      fx.particles.burst(e.x, e.y, top.top, { count: 12, speed: 160, size: 4, gravity: 900, shape: Shape.Dot, life: 0.7 });
      fx.camera.shake(0.12);
    }
    if (!this.demo) this.ctx.shell.setScore(this.sim.score);
    this.pickDemoTarget();
  }

  private pickDemoTarget(): void {
    const m = this.sim.moving;
    if (!m) return;
    const size = this.sim.axis === 'x' ? m.w : m.d;
    if (this.demo && this.sim.score >= this.demoMissAt) this.demoTarget = this.rng.sign() * size * 1.15;
    else if (this.rng.chance(0.7)) this.demoTarget = 0;
    else this.demoTarget = this.rng.sign() * this.rng.range(6, 22);
  }

  update(dt: number): void {
    const sim = this.sim;
    sim.update(dt);
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].t += dt / 0.45;
      if (this.ripples[i].t >= 1) this.ripples.splice(i, 1);
    }
    if (this.streakPop > 0) this.streakPop = Math.max(0, this.streakPop - dt * 4);

    if (this.camT < 1) {
      this.camT = Math.min(1, this.camT + dt / CFG.camTween);
      this.view.camY = this.camFrom + (this.camTo - this.camFrom) * ease.outCubic(this.camT);
    }

    if (this.demo && sim.moving && !sim.over) {
      const t = this.demoTarget;
      if ((sim.prevOff - t) * (sim.off - t) <= 0 && sim.prevOff !== sim.off) this.resolve();
    }

    if (this.overT >= 0) {
      const before = this.overT;
      this.overT += dt;
      if (before < CFG.overZoomDelay && this.overT >= CFG.overZoomDelay) this.beginZoomOut();
      if (this.overT >= CFG.overZoomDelay) {
        const k = ease.inOutSine(Math.min(1, (this.overT - CFG.overZoomDelay) / CFG.overZoomDur));
        this.view.zoom = this.zoomFrom + (this.zoomTo - this.zoomFrom) * k;
        this.view.anchorFrac = this.anchorFrom + (this.anchorTo - this.anchorFrom) * k;
        this.view.camY = this.camOverFrom + (this.camOverTo - this.camOverFrom) * k;
      }
      if (this.demo && this.overT > 3.2) this.start(this.rng.int(0, 1e9), { demo: true });
    }
  }

  private beginZoomOut(): void {
    const v = this.view;
    const towerH = this.sim.top.y + CFG.height;
    // Frame the whole tower in the area the game-over panel leaves visible:
    // roughly the top 46% of the screen (all of it in demos).
    const top = 0.07, bottom = this.demo ? 0.93 : 0.47;
    const t = this.sim.top;
    const below = CFG.base * 0.5;               // base top face extends this far below its centre
    const above = (t.w + t.d) * 0.25;           // top slab's face extends this far above its centre
    const needH = (towerH + below + above + 16) * v.s;
    const needW = 2 * CFG.base * Math.cos(Math.PI / 6) * v.s;
    this.zoomFrom = v.zoom;
    this.zoomTo = Math.min(1.1, (v.H * (bottom - top)) / needH, (v.W * 0.85) / needW);
    const k = v.s * this.zoomTo;
    this.anchorFrom = v.anchorFrac;
    this.camOverFrom = v.camY;
    this.camOverTo = towerH / 2;
    this.anchorTo = (top + bottom) / 2 - ((below - above) / 2) * k / v.H;
  }

  render(): void {
    const { canvas, fx } = this.ctx;
    const g = canvas.begin();
    const v = this.view;
    if (v.W !== canvas.w || v.H !== canvas.h) v.layout(canvas.w, canvas.h);
    const hue = (this.sim.moving ?? this.sim.top).hue;
    v.background(g, hue);
    fx.camera.begin(g, v.W, v.H);
    v.scene(g, this.sim, this.ripples);
    fx.particles.render(g);
    fx.floaters.render(g);
    fx.camera.end(g);

    // Streak label under the HUD floor count.
    if (!this.demo && this.sim.streak >= 2 && !this.sim.over) {
      const s = 1 + 0.25 * ease.outBack(this.streakPop);
      g.save();
      g.translate(v.W / 2, 112);
      g.scale(s, s);
      g.font = `700 18px ${FONT.title}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#fff';
      g.globalAlpha = 0.9;
      g.fillText(`PERFECT x${this.sim.streak}`, 0, 0);
      g.restore();
    }
    if (this.demo && this.ctx.preview) {
      g.font = `700 ${Math.round(v.H * 0.16)}px ${FONT.title}`;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillText(String(this.sim.score), v.W / 2, v.H * 0.06);
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void { this.ctx.audio.stopMusic(); }
  debugInfo(): Record<string, number> {
    return { floor: this.sim.score, speed: this.sim.speed, streak: this.sim.streak, pieces: this.sim.pieces.filter((p) => p.alive).length };
  }
}

export default (): Game => new StackGame();
