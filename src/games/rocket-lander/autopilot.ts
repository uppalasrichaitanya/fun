import type { Input, LanderSim } from './sim';

/**
 * A flight computer for the attract demo and the level verifier. It flies the
 * level's waypoints, then descends on a braking curve onto the target pad.
 */
export class Autopilot {
  private wp = 0;
  private leg = 0;
  /** Lined up over the pad and committed to descend. */
  private committed = false;
  readonly out: Input = { left: false, right: false, thrust: false };
  /** Fraction of the spare thrust used for braking (lower = earlier, safer, thirstier). */
  constructor(private sim: LanderSim, private brake = 0.62) {}

  reset(): void { this.wp = 0; this.leg = 0; this.committed = false; }

  private targetPad(): number {
    const s = this.sim, r = s.route;
    if (r.length) return r[Math.min(s.routeStep, r.length - 1)];
    // Highest multiplier the level offers.
    let best = 0;
    s.level.pads.forEach((p, i) => { if (p.mult > s.level.pads[best].mult) best = i; });
    return best;
  }

  update(): Input {
    const s = this.sim, o = this.out;
    o.left = o.right = o.thrust = false;
    if (s.state === 'crashed' || s.state === 'landed') return o;
    const g = s.level.gravity, A = s.accel, wind = s.windAt();
    if (s.routeStep !== this.leg) { this.leg = s.routeStep; this.wp = 0; this.committed = false; }
    const path = s.level.path?.[this.leg] ?? [];
    let tx: number, ty: number, landing = false;
    const pad = this.targetPad();
    const q = s.padAt(pad);
    // Lead a moving pad by where it will be shortly.
    const padX = (q.x1 + q.x2) / 2 + q.vx * 0.4;
    while (this.wp < path.length && this.reached(path[this.wp])) this.wp++;
    if (s.state === 'checkpoint') {
      o.thrust = s.checkpointT > 0.6;
      return o;
    }
    if (this.wp < path.length) {
      [tx, ty] = path[this.wp];
    } else {
      tx = padX; ty = q.y; landing = true;
    }
    let vdx: number, vdy: number;
    const h = q.y - (s.y + 26);
    if (!landing) {
      const dx = tx - s.x, dy = ty - s.y, d = Math.hypot(dx, dy) || 1;
      const sp = Math.min(140, d * 1.4);
      vdx = (dx / d) * sp; vdy = (dy / d) * sp;
    } else {
      // Horizontal: brake on a curve so we arrive over the pad already stopped.
      const ex = padX - s.x, rvx = s.vx - q.vx;
      vdx = q.vx + Math.sign(ex) * Math.min(110, Math.sqrt(2 * A * 0.25 * Math.abs(ex)), Math.abs(ex) * 1.2);
      const slack = Math.max(4, (q.x2 - q.x1 - 34) / 2);
      if (!this.committed && Math.abs(ex) < slack * 0.6 && Math.abs(rvx) < 8) this.committed = true;
      if (this.committed && Math.abs(ex) > slack) this.committed = false;
      // Vertical: braking curve v^2 = 2 a h with a share of the spare thrust; hover high until lined up.
      const aBrake = (A - g) * this.brake;
      vdy = Math.max(6, Math.min(220, Math.sqrt(Math.max(0, 2 * aBrake * Math.max(0, h - 4)))));
      if (!this.committed) vdy = Math.min(vdy, h > 70 ? (h - 70) * 1.5 : 0);
      if (h < 25) vdy = Math.min(vdy, 7);
    }
    const kx = landing && this.committed ? 1.5 : 2.4, ky = 5;
    const axDes = (vdx - s.vx) * kx, ayDes = (vdy - s.vy) * ky;
    // Required thrust vector: desired accel minus gravity and wind.
    const Tx = axDes - wind, Ty = ayDes - g;
    let ang = Math.atan2(Tx, -Ty);
    // Near the pad only small tilts (wind correction); flat for the touchdown itself.
    const low = landing && this.committed;
    const lim = low && h < 10 ? 0.025 : low && h < 30 ? 0.14 : 0.6;
    ang = Math.max(-lim, Math.min(lim, ang));
    const err = ang - s.angle;
    if (err > 0.02) o.right = true;
    else if (err < -0.02) o.left = true;
    const up = -Ty * Math.cos(s.angle) + Tx * Math.sin(s.angle);
    o.thrust = up > A * 0.42 && s.fuel > 0;
    return o;
  }

  private reached([x, y]: [number, number]): boolean {
    return Math.hypot(x - this.sim.x, y - this.sim.y) < 40;
  }
}
