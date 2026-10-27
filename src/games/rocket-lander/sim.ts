/**
 * Rocket Lander simulation: deterministic, no rendering. World units, y down.
 */

export type Pt = [number, number];

export interface PadDef {
  x1: number; x2: number; y: number;
  mult: 1 | 2 | 3;
  /** Floating pad that slides between x1..x2 + range. */
  move?: { range: number; speed: number };
}

export interface LevelDef {
  id: number;
  name: string;
  world: 'Moon' | 'Mars' | 'Ice moon';
  gravity: number;
  w: number; h: number;
  start: { x: number; y: number; vx: number; vy: number };
  terrain: Pt[];
  ceiling?: Pt[];
  pads: PadDef[];
  /** Pads that must be landed on, in order. Default: any one pad ends the level. */
  route?: number[];
  wind?: { base: number; gust: number; period: number };
  pickups?: Pt[];
  /** Waypoints the autopilot (demo and verifier) flies through, one list per landing on the route. */
  path?: Pt[][];
  hint?: string;
}

export interface Input { left: boolean; right: boolean; thrust: boolean }

export const PHYS = {
  thrustG: 2.6,
  rotSpeed: (170 * Math.PI) / 180,
  rotSmooth: 12,
  fuel: 100,
  burn: 14,
  safeVy: 45, safeVx: 22, safeTilt: (10 * Math.PI) / 180,
  butterVy: 15, butterTilt: (3 * Math.PI) / 180,
  pickupFuel: 35,
  pickupR: 16,
  maxSpeed: 600,
} as const;

/** Rocket geometry, local coords (y down, origin = body centre). */
export const BODY = { w: 24, h: 40 };
export const HULL: Pt[] = [[-12, -20], [12, -20], [-12, 18], [12, 18], [0, -26]];
export const LEGS: Pt[] = [[-17, 26], [17, 26]];

export type SimState = 'flying' | 'landed' | 'checkpoint' | 'crashed';

export interface LandingInfo { vy: number; vx: number; tilt: number; fuel: number; butter: boolean; pad: number; stars: number; score: number }

export type SimEvent =
  | { type: 'touch'; pad: number; info: LandingInfo }
  | { type: 'checkpoint'; pad: number; info: LandingInfo }
  | { type: 'land'; info: LandingInfo }
  | { type: 'crash'; x: number; y: number; vx: number; vy: number; reason: string }
  | { type: 'pickup'; x: number; y: number }
  | { type: 'empty' };

export function heightAt(line: Pt[], x: number): number {
  if (x <= line[0][0]) return line[0][1];
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i];
    if (x <= x1) {
      const [x0, y0] = line[i - 1];
      return x1 === x0 ? Math.min(y0, y1) : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return line[line.length - 1][1];
}

export class LanderSim {
  x = 0; y = 0; vx = 0; vy = 0;
  angle = 0;          // radians, 0 = upright, + = tilted right (nose right)
  av = 0;
  fuel: number = PHYS.fuel;
  t = 0;
  state: SimState = 'flying';
  thrusting = false;
  /** Index into the route (or the pad landed on last). */
  routeStep = 0;
  lastPad = -1;
  checkpointT = 0;
  taken: boolean[] = [];
  landing: LandingInfo | null = null;
  events: SimEvent[] = [];
  peakVy = 0;
  constructor(readonly level: LevelDef) { this.reset(); }

  reset(): void {
    const s = this.level.start;
    this.x = s.x; this.y = s.y; this.vx = s.vx; this.vy = s.vy;
    this.angle = 0; this.av = 0; this.fuel = PHYS.fuel; this.t = 0;
    this.state = 'flying'; this.thrusting = false; this.routeStep = 0; this.lastPad = -1; this.checkpointT = 0;
    this.taken = (this.level.pickups ?? []).map(() => false);
    this.landing = null; this.events = []; this.peakVy = 0;
  }

  get route(): number[] { return this.level.route ?? []; }
  get accel(): number { return this.level.gravity * PHYS.thrustG; }

  /** Pad position at the current time (moving pads slide back and forth). */
  padAt(i: number, t = this.t): { x1: number; x2: number; y: number; vx: number } {
    const p = this.level.pads[i];
    if (!p.move) return { x1: p.x1, x2: p.x2, y: p.y, vx: 0 };
    const span = p.move.range, period = (2 * span) / p.move.speed;
    const ph = (t % period) / period;
    const off = ph < 0.5 ? ph * 2 * span : (1 - ph) * 2 * span;
    const vx = ph < 0.5 ? p.move.speed : -p.move.speed;
    return { x1: p.x1 + off, x2: p.x2 + off, y: p.y, vx };
  }

  windAt(t = this.t): number {
    const w = this.level.wind;
    if (!w) return 0;
    return w.base + w.gust * Math.sin((t * 2 * Math.PI) / w.period) * (0.6 + 0.4 * Math.sin((t * 2 * Math.PI) / (w.period * 2.7)));
  }

  /** World position of a local point. */
  world(p: Pt): Pt {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return [this.x + p[0] * c - p[1] * s, this.y + p[0] * s + p[1] * c];
  }

  /** Ground height under x, including floating pads. */
  groundAt(x: number): number {
    let y = heightAt(this.level.terrain, x);
    this.level.pads.forEach((p, i) => {
      if (!p.move) return;
      const q = this.padAt(i);
      if (x >= q.x1 && x <= q.x2) y = Math.min(y, q.y);
    });
    return y;
  }

  /** Which pad (if any) a ground point at x, y is resting on. */
  padUnder(x: number, y: number): number {
    for (let i = 0; i < this.level.pads.length; i++) {
      const q = this.padAt(i);
      if (x >= q.x1 - 0.5 && x <= q.x2 + 0.5 && Math.abs(y - q.y) < 4) return i;
    }
    return -1;
  }

  step(dt: number, inp: Input): void {
    this.t += dt;
    if (this.state === 'crashed' || this.state === 'landed') return;
    if (this.state === 'checkpoint') {
      this.checkpointT += dt;
      // Ride the pad until the player lifts off.
      const q = this.padAt(this.lastPad);
      this.x += q.vx * dt;
      if (!(inp.thrust && this.fuel > 0 && this.checkpointT > 0.4)) return;
      this.state = 'flying';
      this.y -= 1.5;
      this.vy = -20;
    }
    // Rotation: a little heavy.
    const want = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    this.av += (want * PHYS.rotSpeed - this.av) * Math.min(1, dt * PHYS.rotSmooth);
    this.angle += this.av * dt;
    if (this.angle > Math.PI) this.angle -= Math.PI * 2;
    if (this.angle < -Math.PI) this.angle += Math.PI * 2;
    const g = this.level.gravity;
    let ax = this.windAt(), ay = g;
    this.thrusting = inp.thrust && this.fuel > 0;
    if (this.thrusting) {
      const a = this.accel;
      ax += Math.sin(this.angle) * a;
      ay -= Math.cos(this.angle) * a;
      this.fuel = Math.max(0, this.fuel - PHYS.burn * dt);
      if (this.fuel === 0) this.events.push({ type: 'empty' });
    }
    this.vx += ax * dt; this.vy += ay * dt;
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > PHYS.maxSpeed) { this.vx *= PHYS.maxSpeed / sp; this.vy *= PHYS.maxSpeed / sp; }
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.peakVy = Math.max(this.peakVy, this.vy);
    this.collide();
    this.pickups();
  }

  private pickups(): void {
    (this.level.pickups ?? []).forEach(([px, py], i) => {
      if (this.taken[i] || Math.hypot(px - this.x, py - this.y) > PHYS.pickupR + 16) return;
      this.taken[i] = true;
      this.fuel = Math.min(PHYS.fuel, this.fuel + PHYS.pickupFuel);
      this.events.push({ type: 'pickup', x: px, y: py });
    });
  }

  private crash(reason: string): void {
    this.state = 'crashed';
    this.events.push({ type: 'crash', x: this.x, y: this.y, vx: this.vx, vy: this.vy, reason });
  }

  private collide(): void {
    const L = this.level;
    // Out of the world sideways or above = lost.
    if (this.x < -40 || this.x > L.w + 40) { this.crash('Lost in space'); return; }
    // Ceiling.
    if (L.ceiling) {
      for (const p of [...HULL, ...LEGS]) {
        const [wx, wy] = this.world(p);
        if (wy <= heightAt(L.ceiling, wx)) { this.crash('Hit the ceiling'); return; }
      }
    }
    // Hull touching ground or a pad edge = crash.
    for (const p of HULL) {
      const [wx, wy] = this.world(p);
      if (wy >= this.groundAt(wx)) { this.crash('Hull hit the ground'); return; }
    }
    const legs = LEGS.map((p) => this.world(p));
    const touching = legs.map(([wx, wy]) => wy >= this.groundAt(wx));
    if (!touching[0] && !touching[1]) return;
    // First contact: judge the landing.
    const padsUnder = legs.map(([wx]) => this.padUnder(wx, this.groundAt(wx)));
    const pad = padsUnder[0];
    const q = pad >= 0 ? this.padAt(pad) : null;
    const rvx = this.vx - (q?.vx ?? 0);
    const tilt = Math.abs(this.angle);
    const info: LandingInfo = {
      vy: this.vy, vx: rvx, tilt, fuel: this.fuel, pad,
      butter: this.vy < PHYS.butterVy && tilt < PHYS.butterTilt, stars: 0, score: 0,
    };
    if (pad < 0 || padsUnder[1] !== pad) { this.crash(pad < 0 ? 'Missed the pad' : 'One leg off the pad'); return; }
    if (this.vy >= PHYS.safeVy) { this.crash('Too fast'); return; }
    if (Math.abs(rvx) >= PHYS.safeVx) { this.crash('Sideways too fast'); return; }
    if (tilt > PHYS.safeTilt) { this.crash('Tipped over'); return; }
    // Safe: settle on the pad.
    this.y = q!.y - 26 * Math.cos(this.angle) - 0.01;
    this.vx = q!.vx; this.vy = 0; this.av = 0;
    const route = this.route;
    if (route.length && this.routeStep < route.length - 1) {
      if (route[this.routeStep] !== pad) { this.crash('Wrong pad first'); return; }
      this.routeStep++;
      this.lastPad = pad;
      this.state = 'checkpoint';
      this.checkpointT = 0;
      this.angle = 0;
      this.events.push({ type: 'checkpoint', pad, info });
      return;
    }
    if (route.length && route[route.length - 1] !== pad) { this.crash('Wrong pad'); return; }
    const mult = L.pads[pad].mult;
    info.score = Math.round((500 + Math.round(this.fuel) * 10 + (info.butter ? 300 : 0)) * mult);
    info.stars = 1 + (this.fuel > 30 ? 1 : 0) + (this.fuel > 30 && info.butter ? 1 : 0);
    this.landing = info;
    this.state = 'landed';
    this.lastPad = pad;
    this.events.push({ type: 'land', info });
  }

  /** Altitude of the leg tips above the nearest pad surface. */
  altitude(): number {
    let best = Infinity, alt = 0;
    this.level.pads.forEach((_, i) => {
      const q = this.padAt(i);
      const d = Math.abs((q.x1 + q.x2) / 2 - this.x);
      if (d < best) { best = d; alt = q.y - (this.y + 26); }
    });
    return alt;
  }

  /** Clearance from the leg tips to whatever is below. */
  clearance(): number {
    return this.groundAt(this.x) - (this.y + 26);
  }
}
