// Rocket Builder: parts, designs and the flight sim. Pure and deterministic:
// the same design and the same control inputs always give the same flight.
// Units are SI (m, kg, N, s). The world is a small solar system: a 600 km
// Earth with a 70 km atmosphere and a 100 km Moon 6,000 km away.
import type { Schema } from '../../engine/levels/schema';

export type PartKind = 'pod' | 'cone' | 'chute' | 'tankS' | 'tankM' | 'tankL' | 'engineS' | 'engineB' | 'decoupler' | 'booster' | 'fins' | 'legs';

export interface PartDef {
  name: string; cost: number;
  /** Dry mass and fuel (kg). */
  mass: number; fuel: number;
  /** Thrust (N) and specific impulse at sea level / in vacuum (s). */
  thrust: number; isp: [number, number];
  /** Size (m). */
  h: number; w: number;
  side: boolean;
}

export const PARTS: Record<PartKind, PartDef> = {
  pod: { name: 'Command pod', cost: 20, mass: 800, fuel: 0, thrust: 0, isp: [0, 0], h: 1.6, w: 1.25, side: false },
  cone: { name: 'Nose cone', cost: 5, mass: 100, fuel: 0, thrust: 0, isp: [0, 0], h: 0.9, w: 1.25, side: false },
  chute: { name: 'Parachute', cost: 7, mass: 100, fuel: 0, thrust: 0, isp: [0, 0], h: 0.4, w: 0.9, side: false },
  tankS: { name: 'Fuel tank S', cost: 8, mass: 100, fuel: 500, thrust: 0, isp: [0, 0], h: 1.0, w: 1.25, side: false },
  tankM: { name: 'Fuel tank M', cost: 14, mass: 200, fuel: 1400, thrust: 0, isp: [0, 0], h: 1.9, w: 1.25, side: false },
  tankL: { name: 'Fuel tank L', cost: 24, mass: 400, fuel: 3200, thrust: 0, isp: [0, 0], h: 3.6, w: 1.25, side: false },
  engineS: { name: 'Small engine', cost: 15, mass: 500, fuel: 0, thrust: 60e3, isp: [280, 320], h: 0.9, w: 1.1, side: false },
  engineB: { name: 'Big engine', cost: 30, mass: 1500, fuel: 0, thrust: 220e3, isp: [250, 290], h: 1.3, w: 1.25, side: false },
  decoupler: { name: 'Decoupler', cost: 4, mass: 50, fuel: 0, thrust: 0, isp: [0, 0], h: 0.3, w: 1.25, side: false },
  booster: { name: 'Side booster', cost: 18, mass: 300, fuel: 1500, thrust: 160e3, isp: [210, 230], h: 3.2, w: 0.7, side: true },
  fins: { name: 'Fins', cost: 6, mass: 50, fuel: 0, thrust: 0, isp: [0, 0], h: 1.0, w: 0.6, side: true },
  legs: { name: 'Landing legs', cost: 10, mass: 150, fuel: 0, thrust: 0, isp: [0, 0], h: 1.0, w: 0.5, side: true },
};
export const PART_KINDS = Object.keys(PARTS) as PartKind[];
export const MAX_ROWS = 18;

/** Rows top to bottom: [centre part, left side part, right side part] ('' = empty). */
export interface Design { rows: [PartKind, PartKind | '', PartKind | ''][] }

export type Goal =
  | { kind: 'alt'; alt: number }
  | { kind: 'return'; alt: number }
  | { kind: 'orbit'; stages?: number }
  | { kind: 'orbitReturn' }
  | { kind: 'moonFlyby' } | { kind: 'moonOrbit' } | { kind: 'moonLand' } | { kind: 'moonReturn' };

export interface RMission {
  name: string;
  goal: Goal;
  budget: number;
  parts: PartKind[];
  solution: Design;
}

const KIND_ENUM = { enum: [...PART_KINDS] } as const;
export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', budget: 'int', parts: { arr: KIND_ENUM, min: 1 },
    goal: { obj: { kind: { enum: ['alt', 'return', 'orbit', 'orbitReturn', 'moonFlyby', 'moonOrbit', 'moonLand', 'moonReturn'] }, alt: 'number', stages: 'int' }, opt: ['alt', 'stages'] },
    solution: { obj: { rows: { arr: { tuple: [KIND_ENUM, { enum: ['', ...PART_KINDS] }, { enum: ['', ...PART_KINDS] }] }, min: 1 } } },
  },
};

// ---- world -----------------------------------------------------------------------------

export const G0 = 9.81;
export const R_E = 600_000;
export const GM_E = G0 * R_E * R_E;
export const ATMO = 70_000;
export const R_M = 100_000;
export const GM_M = 1.6 * R_M * R_M;
export const A_M = 6_000_000;
export const W_M = Math.sqrt(GM_E / (A_M * A_M * A_M));
export const SOI_M = 700_000;
const MOON0 = 0.4;

export function moonAt(t: number): [number, number, number, number] {
  const a = MOON0 + W_M * t, v = W_M * A_M;
  return [A_M * Math.cos(a), A_M * Math.sin(a), -v * Math.sin(a), v * Math.cos(a)];
}

export function density(alt: number): number {
  if (alt >= ATMO || alt < -1000) return 0;
  return 1.2 * Math.exp(-alt / 5800) * Math.min(1, (ATMO - alt) / 6000);
}

/** Gravity at (x, y) and time t from the Earth (at the origin) and the Moon. */
export function gravity(x: number, y: number, t: number): [number, number] {
  const r2 = x * x + y * y, r = Math.sqrt(r2);
  let ax = (-GM_E * x) / (r2 * r), ay = (-GM_E * y) / (r2 * r);
  const [mx, my] = moonAt(t);
  const dx = x - mx, dy = y - my, d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
  ax -= (GM_M * dx) / (d2 * d); ay -= (GM_M * dy) / (d2 * d);
  return [ax, ay];
}

export interface Orbit { energy: number; peri: number; apo: number; e: number; a: number; h: number }

/** Two-body orbit of a point (relative position/velocity) around a body. */
export function orbitOf(rx: number, ry: number, vx: number, vy: number, GM: number): Orbit {
  const r = Math.hypot(rx, ry), v2 = vx * vx + vy * vy;
  const energy = v2 / 2 - GM / r;
  const h = rx * vy - ry * vx;
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM * GM)));
  const p = (h * h) / GM;
  const a = -GM / (2 * energy);
  // a(1 ± e) also covers straight up-and-down paths (e = 1, h = 0).
  return { energy, e, a, h, peri: energy < 0 ? a * (1 - e) : p / (1 + e), apo: energy < 0 ? a * (1 + e) : Infinity };
}

/** Seconds until apoapsis (bound orbits); Infinity otherwise. */
export function timeToApo(rx: number, ry: number, vx: number, vy: number, GM: number): number {
  const o = orbitOf(rx, ry, vx, vy, GM);
  if (o.e >= 1 || o.e < 1e-6) return o.e < 1e-6 ? 0 : Infinity;
  const r = Math.hypot(rx, ry);
  const rv = rx * vx + ry * vy;
  const cosE = (1 - r / o.a) / o.e;
  let E = Math.acos(Math.max(-1, Math.min(1, cosE)));
  if (rv < 0) E = 2 * Math.PI - E;
  const M = E - o.e * Math.sin(E);
  const n = Math.sqrt(GM / (o.a * o.a * o.a));
  return (Math.PI - M + 2 * Math.PI) % (2 * Math.PI) / n;
}

// ---- design helpers --------------------------------------------------------------------

export function designCost(d: Design): number {
  let c = 0;
  for (const [m, l, r] of d.rows) c += PARTS[m].cost + (l ? PARTS[l].cost : 0) + (r ? PARTS[r].cost : 0);
  return c;
}

/** Side parts allowed next to a centre part. */
export function sideOk(center: PartKind, side: PartKind): boolean {
  if (!PARTS[side].side) return false;
  if (side === 'booster') return center === 'tankS' || center === 'tankM' || center === 'tankL';
  return center !== 'chute' && center !== 'cone' && center !== 'decoupler';
}

/** Problems that stop a launch (shown in the hangar). */
export function designErrors(d: Design): string[] {
  const e: string[] = [];
  const pods = d.rows.filter((r) => r[0] === 'pod').length;
  if (pods === 0) e.push('Needs a command pod for Bob');
  if (pods > 1) e.push('Only one command pod');
  if (d.rows.length > MAX_ROWS) e.push(`At most ${MAX_ROWS} parts tall`);
  for (const [c, l, r] of d.rows) {
    if (PARTS[c].side) e.push(`${PARTS[c].name} goes on the side`);
    for (const s of [l, r]) if (s && !sideOk(c, s)) e.push(`${PARTS[s].name} can't attach to ${PARTS[c].name.toLowerCase()}`);
  }
  return e;
}

export interface LaidPart { kind: PartKind; row: number; side: -1 | 0 | 1; x: number; y: number; h: number; w: number; sec: number }

/** Part positions in rocket coordinates (x right, y up, top of the stack at 0) and stage sections. */
export function layout(d: Design): LaidPart[] {
  const out: LaidPart[] = [];
  let y = 0, sec = 0;
  const core = PARTS.pod.w;
  d.rows.forEach(([c, l, r], row) => {
    const P = PARTS[c];
    if (c === 'decoupler') sec++;
    const cy = y - P.h / 2;
    out.push({ kind: c, row, side: 0, x: 0, y: cy, h: P.h, w: P.w, sec });
    const bottom = y - P.h;
    for (const [s, k] of [[-1, l], [1, r]] as const) {
      if (!k) continue;
      const S = PARTS[k];
      // Boosters centre on their tank; fins and legs hang from the row's bottom edge.
      const sy = k === 'booster' ? cy : bottom + S.h / 2 - (k === 'legs' ? 0.35 : 0);
      out.push({ kind: k, row, side: s, x: s * (core / 2 + S.w / 2), y: sy, h: S.h, w: S.w, sec });
    }
    y = bottom;
  });
  return out;
}

export interface StageInfo { sec: number; mass: number; thrust: number; burn: number; dv: number; twr: number }

/** Per-stage numbers for the hangar panel, bottom stage first (boosters fold into their stage). */
export function stageInfo(d: Design): StageInfo[] {
  const parts = layout(d);
  const secs = [...new Set(parts.map((p) => p.sec))].sort((a, b) => b - a);
  const out: StageInfo[] = [];
  for (const s of secs) {
    const live = parts.filter((p) => p.sec <= s);
    const mass = live.reduce((m, p) => m + PARTS[p.kind].mass + PARTS[p.kind].fuel, 0);
    const mine = parts.filter((p) => p.sec === s);
    const pod = parts.find((p) => p.kind === 'pod');
    const eng = mine.filter((p) => (p.kind === 'engineS' || p.kind === 'engineB') && (!pod || p.y < pod.y || p.sec !== pod.sec));
    const boost = mine.filter((p) => p.kind === 'booster');
    const fuel = mine.filter((p) => p.kind.startsWith('tank')).reduce((f, p) => f + PARTS[p.kind].fuel, 0);
    const thrust = [...eng, ...boost].reduce((t, p) => t + PARTS[p.kind].thrust, 0);
    const flow = eng.reduce((f, p) => f + PARTS[p.kind].thrust / (G0 * PARTS[p.kind].isp[1]), 0);
    const burn = flow > 0 && fuel > 0 ? fuel / flow : 0;
    const bFuel = boost.reduce((f, p) => f + PARTS[p.kind].fuel, 0);
    const used = (flow > 0 ? fuel : 0) + bFuel;
    const isp = thrust > 0 ? thrust / (G0 * (flow + boost.reduce((f, p) => f + PARTS[p.kind].thrust / (G0 * PARTS[p.kind].isp[1]), 0))) : 0;
    const dv = used > 0 && isp > 0 ? isp * G0 * Math.log(mass / (mass - used)) : 0;
    out.push({ sec: s, mass, thrust, burn, dv, twr: thrust / (mass * G0) });
  }
  return out;
}

// ---- flight ------------------------------------------------------------------------------

export type FailId =
  | 'ballerina' | 'hop' | 'drill' | 'spaghetti' | 'sideways' | 'soclose' | 'statue'
  | 'clingy' | 'torn' | 'crater' | 'postcard' | 'dry' | 'pancake' | 'bounce';

export const FAILS: { id: FailId; name: string; caption: string; hint: string }[] = [
  { id: 'ballerina', name: 'Ballerina', caption: 'Pirouette achieved. Orbit not.', hint: 'Who needs fins anyway?' },
  { id: 'hop', name: 'The Hop', caption: "That wasn't a launch. That was a hop.", hint: 'Up, down. Barely.' },
  { id: 'drill', name: 'The Drill', caption: 'Congratulations, you invented a drill.', hint: 'Engines point the other way, right?' },
  { id: 'spaghetti', name: 'Spaghetti', caption: 'Plenty of power. Not enough rocket.', hint: 'Taller is better. Until it isn\'t.' },
  { id: 'sideways', name: 'Sideways Express', caption: 'Wrong orbit. Right vibes.', hint: 'Symmetry is overrated.' },
  { id: 'soclose', name: 'So Close', caption: 'Space was right there. Right. There.', hint: 'Just a little more fuel...' },
  { id: 'statue', name: 'Expensive Statue', caption: 'Beautiful. Doesn\'t move. Very modern art.', hint: 'Forget something important?' },
  { id: 'clingy', name: 'Clingy Boosters', caption: 'Your boosters have separation anxiety.', hint: 'Empty boosters, never let go.' },
  { id: 'torn', name: 'Torn Chute', caption: 'The parachute has filed a complaint.', hint: 'Open it while you\'re really fast.' },
  { id: 'crater', name: 'New Crater', caption: 'A new crater, named after you.', hint: 'The Moon is harder than it looks.' },
  { id: 'postcard', name: 'Postcard from the Sun', caption: "Bob says hi from deep space. He's fine. Probably.", hint: 'Way, way too much fuel.' },
  { id: 'dry', name: 'Dry Engine', caption: 'The engine was thirsty. Nobody brought it a drink.', hint: 'Mind the gap between tank and engine.' },
  { id: 'pancake', name: 'Pancake', caption: 'Bob would like to speak to the manager.', hint: 'What goes up, without a parachute...' },
  { id: 'bounce', name: 'Bounce House', caption: 'Moon: 1. Your rocket: 0.', hint: 'Legs are for landing.' },
];

export interface Control {
  /** Manual rotation (-1 left .. 1 right), or null to hold / follow `target`. */
  turn: number | null;
  /** Attitude to hold (world angle of the nose), or null. */
  target: number | null;
  throttle: number;
  stage: boolean;
  chute: boolean;
  /** Longest step the controller allows while coasting (s). */
  maxDt: number;
}

export const IDLE: Control = { turn: null, target: null, throttle: 0, stage: false, chute: false, maxDt: 10 };

export interface LivePart extends LaidPart { fuel: number }

export type FlightEvent =
  | { kind: 'ignite' } | { kind: 'sonic' } | { kind: 'chute' } | { kind: 'torn' } | { kind: 'bounce'; speed: number }
  | { kind: 'stage'; parts: LivePart[]; x: number; y: number; vx: number; vy: number; ang: number; w: number; cx: number; cy: number }
  | { kind: 'boom'; x: number; y: number } | { kind: 'land'; body: 'earth' | 'moon'; speed: number; gentle: boolean }
  | { kind: 'fail'; id: FailId } | { kind: 'dry' };

export type FlightState = 'pad' | 'flight' | 'landed' | 'destroyed' | 'escaped' | 'stuck';

export class Flight {
  parts: LivePart[];
  x: number; y: number; vx = 0; vy = 0;
  ang = Math.PI / 2; w = 0;
  t = 0; steps = 0;
  state: FlightState = 'pad';
  throttle = 0;
  launched = false;
  decoupled = 0;
  chute: 'none' | 'packed' | 'open' | 'torn' = 'none';
  chuteK = 0;
  body: 'earth' | 'moon' = 'earth';
  /** Offset from the body centre while landed. */
  private rest: [number, number] = [0, 0];
  events: FlightEvent[] = [];
  fails = new Set<FailId>();
  // Mission tracking.
  maxAlt = 0;
  orbitE = false;
  orbitStaged = false;
  soi = false;
  moonOrbit = false;
  moonLanded = false;
  earthAfterMoon = false;
  earthAfterOrbit = false;
  gentle = false;
  landings = 0;
  // Fail bookkeeping.
  readonly noFins: boolean;
  tower: number;
  private spin = 0;
  private emptyBoostT = 0;
  private spinSinceEmpty = 0;
  private padT = 0;
  private drillT = 0;
  bounces = 0;
  private sonicDone = false;
  readonly cost: number;
  readonly target: number;
  // Cached each step.
  mass = 0; cx = 0; cy = 0; inertia = 1;
  thrustNow = 0;
  dt = 1 / 60;

  /** `thrustScale` weakens every engine (the level generator checks stored designs keep a margin). */
  constructor(readonly design: Design, readonly goal: Goal, readonly thrustScale = 1) {
    this.parts = layout(design).map((p) => ({ ...p, fuel: PARTS[p.kind].fuel }));
    this.cost = designCost(design);
    this.noFins = !this.parts.some((p) => p.kind === 'fins');
    this.tower = design.rows.length;
    if (this.parts.some((p) => p.kind === 'chute')) this.chute = 'packed';
    this.target = goal.kind === 'alt' || goal.kind === 'return' ? goal.alt : ATMO;
    this.massProps();
    // Standing on the pad at the top of the Earth.
    const bottom = Math.min(...this.parts.map((p) => p.y - p.h / 2));
    this.x = 0; this.y = R_E + (this.cy - bottom);
    this.rest = [this.x, this.y];
  }

  // ---- queries --------------------------------------------------------------------------

  get alt(): number { return Math.hypot(this.x, this.y) - R_E; }
  moonRel(): [number, number, number, number] {
    const [mx, my, mvx, mvy] = moonAt(this.t);
    return [this.x - mx, this.y - my, this.vx - mvx, this.vy - mvy];
  }
  get moonAlt(): number { const [rx, ry] = this.moonRel(); return Math.hypot(rx, ry) - R_M; }
  earthOrbit(): Orbit { return orbitOf(this.x, this.y, this.vx, this.vy, GM_E); }
  moonOrbitNow(): Orbit { const [rx, ry, vx, vy] = this.moonRel(); return orbitOf(rx, ry, vx, vy, GM_M); }
  get speed(): number { return Math.hypot(this.vx, this.vy); }
  get over(): boolean { return this.state === 'destroyed' || this.state === 'escaped' || this.state === 'stuck'; }
  /** Bottom section index (the stage that fires now). */
  get bottomSec(): number { return Math.max(...this.parts.map((p) => p.sec)); }
  private pod(): LivePart | undefined { return this.parts.find((p) => p.kind === 'pod'); }
  private isEngine(p: LivePart): boolean { return p.kind === 'engineS' || p.kind === 'engineB'; }
  /** Engines of the bottom section (they fire); boosters fire with them. */
  activeEngines(): LivePart[] {
    if (!this.launched) return [];
    const s = this.bottomSec;
    return this.parts.filter((p) => p.sec === s && (this.isEngine(p) || p.kind === 'booster'));
  }
  secFuel(sec: number): number { return this.parts.reduce((f, p) => f + (p.sec === sec && p.kind.startsWith('tank') ? p.fuel : 0), 0); }
  /** Can the current stage still push? */
  hasThrust(): boolean {
    const s = this.bottomSec;
    return this.activeEngines().some((p) => (p.kind === 'booster' ? p.fuel > 0 : this.secFuel(s) > 0));
  }
  boostersAttached(): LivePart[] { return this.parts.filter((p) => p.kind === 'booster'); }
  hasDecoupler(): boolean { return this.parts.some((p) => p.kind === 'decoupler'); }
  hasLegs(): boolean { return this.parts.some((p) => p.kind === 'legs'); }
  /** Max thrust available right now and the resulting acceleration. */
  maxAccel(): number {
    const s = this.bottomSec;
    let f = 0;
    for (const p of this.activeEngines()) if (p.kind === 'booster' ? p.fuel > 0 : this.secFuel(s) > 0) f += PARTS[p.kind].thrust * this.thrustScale;
    return f / this.mass;
  }
  /** Thrust direction of an engine part along the rocket axis: away from the pod. */
  private thrustDir(p: LivePart): number {
    const pod = this.pod();
    return pod && this.isEngine(p) && p.y > pod.y ? -1 : 1;
  }

  /** Drag area (Cd x frontal area), side area and its centre (rocket coords), fin area. */
  aero(): { cdA: number; side: number; ycp: number; fins: number } {
    // Nose first: the top part's shape matters. Tail first: a blunt 1.0.
    let front = (PARTS.pod.w * PARTS.pod.w * Math.PI) / 4, side = 0, ycp = 0, fins = 0;
    const topY = Math.max(...this.parts.map((p) => p.y));
    for (const p of this.parts) {
      const k = p.kind;
      if (p.side) front += k === 'booster' ? 0.4 : 0.12;
      // The nose carries most of a body's lift (so bare rockets are unstable); fins pull it back down.
      const a = p.h * p.w * (k === 'fins' ? 8 : p.side === 0 && p.y === topY ? 4 : 1);
      side += a; ycp += a * p.y;
      if (k === 'fins') fins += a;
    }
    const top = this.parts.reduce((t, p) => (p.side === 0 && p.y > t.y ? p : t), this.parts[0]);
    const nose = top.kind === 'cone' ? 0.35 : top.kind === 'pod' ? 0.55 : top.kind === 'chute' ? 0.6 : 0.9;
    const v = this.speed;
    const along = v > 1 ? (this.vx * Math.cos(this.ang) + this.vy * Math.sin(this.ang)) / v : 1;
    const cd = nose + (1.0 - nose) * (1 - along) / 2;
    return { cdA: cd * front + fins * 0.05, side, ycp: ycp / side, fins };
  }

  /** Distance from the centre of mass down to the lowest point. */
  bottomOffset(): number { return this.cy - Math.min(...this.parts.map((p) => p.y - p.h / 2)); }

  // ---- physics ---------------------------------------------------------------------------

  private massProps(): void {
    let m = 0, mx = 0, my = 0;
    for (const p of this.parts) { const pm = PARTS[p.kind].mass + p.fuel; m += pm; mx += pm * p.x; my += pm * p.y; }
    this.mass = m; this.cx = mx / m; this.cy = my / m;
    let I = 0;
    for (const p of this.parts) {
      const pm = PARTS[p.kind].mass + p.fuel;
      I += pm * ((p.x - this.cx) ** 2 + (p.y - this.cy) ** 2 + (p.h * p.h) / 12);
    }
    this.inertia = Math.max(1, I);
  }

  private chooseDt(c: Control): number {
    if (this.state !== 'flight' || this.thrustNow > 0 || c.throttle > 0) return 1 / 60;
    // Hanging under a full canopy is calm: bigger steps until close to the ground.
    if (this.chute === 'open') return this.chuteK >= 1 && this.alt > 300 && Math.abs(this.w) < 0.05 ? Math.min(0.25, c.maxDt) : 1 / 60;
    if (density(this.alt) > 0 || this.alt < 3000 || this.moonAlt < 3000) return 1 / 60;
    const [rx, ry, rvx, rvy] = this.moonRel();
    const kE = Math.hypot(this.x, this.y) / Math.max(1, this.speed);
    const kM = Math.hypot(rx, ry) / Math.max(1, Math.hypot(rvx, rvy));
    return Math.max(1 / 60, Math.min(c.maxDt, 0.004 * Math.min(kE, kM)));
  }

  step(c: Control): void {
    if (this.over) return;
    if (c.stage) this.stage();
    if (c.chute) this.openChute();
    this.throttle = Math.max(0, Math.min(1, c.throttle));
    const dt = (this.dt = this.chooseDt(c));
    this.steps++;
    this.t += dt;
    if (this.state === 'landed' || this.state === 'pad') this.groundStep(c, dt);
    else this.flightStep(c, dt);
    this.watch(dt);
  }

  /** Engines: fuel use, force along the axis and torque. Returns [axial force, torque]. */
  private engines(dt: number): [number, number] {
    let F = 0, tau = 0;
    const s = this.bottomSec;
    const alt = this.body === 'earth' ? this.alt : 1e6;
    const pAtm = Math.min(1, density(alt) / 1.2);
    let flow = 0, liquid = 0, tauL = 0;
    const tanks = this.parts.filter((p) => p.sec === s && p.kind.startsWith('tank'));
    let pool = tanks.reduce((f, p) => f + p.fuel, 0);
    for (const p of this.activeEngines()) {
      const D = PARTS[p.kind];
      const isp = D.isp[1] + (D.isp[0] - D.isp[1]) * pAtm;
      let f = 0;
      if (p.kind === 'booster') {
        if (p.fuel <= 0) continue;
        f = D.thrust * this.thrustScale;
        p.fuel = Math.max(0, p.fuel - (f / (G0 * isp)) * dt);
      } else {
        if (pool <= 0 || this.throttle <= 0) continue;
        f = D.thrust * this.throttle * this.thrustScale;
        flow += (f / (G0 * isp)) * dt;
      }
      const dir = this.thrustDir(p);
      if (p.kind !== 'booster') { liquid += f * dir; tauL += (p.x - this.cx) * f * dir; }
      F += f * dir;
      // Boosters are canted toward the middle: a lone one still pushes the rocket round, just slower.
      tau += (p.x - this.cx) * (p.kind === 'booster' ? 0.4 : 1) * f * dir;
    }
    if (flow > 0) {
      // The last drops: only part of a step's worth of thrust.
      if (flow > pool) { const k = pool / flow; F -= liquid * (1 - k); tau -= tauL * (1 - k); }
      const k = Math.min(1, flow / pool);
      for (const t of tanks) t.fuel = Math.max(0, t.fuel * (1 - k));
      pool = Math.max(0, pool - flow);
    }
    this.thrustNow = Math.abs(F);
    return [F, tau];
  }

  private groundStep(c: Control, dt: number): void {
    const [F] = this.engines(dt);
    this.massProps();
    const [bx, by] = this.body === 'earth' ? [0, 0] : moonAt(this.t);
    const [, , bvx, bvy] = this.body === 'earth' ? [0, 0, 0, 0] : moonAt(this.t);
    const g = this.body === 'earth' ? G0 : GM_M / (R_M * R_M);
    if (this.state === 'pad' && this.launched) this.padT += dt;
    if (F < 0 && this.state === 'pad') {
      // Pushing into the pad: drill.
      this.drillT += dt;
      this.y -= 0.6 * dt;
      if (this.drillT > 1.6) this.fail('drill', true);
      return;
    }
    if (F > this.mass * g * 1.001) {
      this.state = 'flight';
      const n = [this.rest[0] / Math.hypot(...this.rest), this.rest[1] / Math.hypot(...this.rest)];
      this.vx = bvx + n[0] * 0.5; this.vy = bvy + n[1] * 0.5;
      this.flightStep(c, dt);
      return;
    }
    this.x = bx + this.rest[0]; this.y = by + this.rest[1];
    this.vx = bvx; this.vy = bvy; this.w = 0;
    if (this.state === 'pad' && this.launched && this.padT > 3) {
      if (!this.parts.some((p) => this.isEngine(p) || p.kind === 'booster')) this.fail('statue', true);
      else if (this.activeEngines().some((p) => this.isEngine(p)) && this.secFuel(this.bottomSec) <= 0 && !this.boostersAttached().some((b) => b.fuel > 0)) this.fail('dry', true);
      else if ((!this.hasThrust() && !this.hasDecoupler()) || this.padT > 8) this.state = 'stuck';
    }
  }

  private flightStep(c: Control, dt: number): void {
    const [F, tauT] = this.engines(dt);
    this.massProps();
    const m = this.mass;
    const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
    // Local frame: u = nose, r = right side.
    const ux = ca, uy = sa, rx = sa, ry = -ca;
    let fx = ux * F, fy = uy * F;
    let tau = tauT;
    const alt = this.alt;
    const rho = density(alt);
    let kDrag = 0;
    if (rho > 0) {
      const v = this.speed;
      const vr = this.vx * rx + this.vy * ry;
      const { cdA, side, ycp, fins } = this.aero();
      kDrag += (0.5 * rho * cdA) / m;
      const fn = -1.2 * rho * v * vr * side;
      fx += rx * fn; fy += ry * fn;
      tau += -(ycp - this.cy) * fn;
      const L = this.tower;
      tau += -0.02 * rho * v * this.w * (side + fins * 3) * L * L;
      // A little gusty air: fins shrug it off, finless rockets wobble into it.
      tau += 0.5 * rho * v * v * side * 0.05 * Math.sin(this.t * 0.9 + 0.5);
      // Empty boosters still attached flap about and drag the rocket round.
      const empty = this.boostersAttached().filter((b) => b.fuel <= 0).length;
      if (empty) {
        const q = 0.5 * rho * v * v;
        tau += empty * 25e3 * Math.min(1, q / 3000) * (1.2 + Math.sin(this.t * 2.3));
      }
      if (this.chute === 'open') {
        this.chuteK = Math.min(1, this.chuteK + dt / 2);
        kDrag += (0.5 * rho * 900 * this.chuteK * this.chuteK) / m;
      } else if (this.chute === 'torn') kDrag += (0.5 * rho * 20) / m;
    }
    // Attitude: reaction wheel + engine gimbal, rate-limited.
    const s = this.bottomSec;
    let ctrl = 15e3;
    for (const p of this.activeEngines()) if (this.isEngine(p) && this.secFuel(s) > 0) ctrl += PARTS[p.kind].thrust * this.throttle * 0.025 * Math.abs(p.y - this.cy);
    let wCmd = 0;
    if (c.turn !== null && c.turn !== 0) wCmd = c.turn * -0.9;
    else if (c.target !== null) {
      const err = angDiff(c.target, this.ang);
      // Never ask for more turn than reaches the target this step (long coasting steps).
      wCmd = Math.max(-0.7, Math.min(0.7, err * Math.min(1.4, 0.9 / dt)));
    }
    const dwMax = (ctrl / this.inertia) * dt;
    this.w += Math.max(-dwMax, Math.min(dwMax, wCmd - this.w));
    this.w += (tau / this.inertia) * dt;
    if (this.chute === 'open' && rho > 0 && this.speed > 1) {
      // Hanging under the canopy: the nose swings to face back along the motion.
      const tgt = Math.atan2(-this.vy, -this.vx);
      this.ang += angDiff(tgt, this.ang) * Math.min(1, dt * 1.5 * this.chuteK);
      this.w *= 0.9;
    }
    this.ang = angDiff(this.ang + this.w * dt, 0);
    // Translation: symplectic Euler with implicit quadratic drag.
    const [gx, gy] = gravity(this.x, this.y, this.t);
    this.vx += (gx + fx / m) * dt; this.vy += (gy + fy / m) * dt;
    if (kDrag > 0) { const k = 1 / (1 + kDrag * this.speed * dt); this.vx *= k; this.vy *= k; }
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.contacts();
  }

  /** Ground contact with the Earth or the Moon: landing, bouncing or exploding. */
  private contacts(): void {
    const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
    for (const body of ['earth', 'moon'] as const) {
      const [bx, by, bvx, bvy] = body === 'earth' ? [0, 0, 0, 0] : moonAt(this.t);
      const R = body === 'earth' ? R_E : R_M;
      if (Math.hypot(this.x - bx, this.y - by) - R > 40) continue;
      let worst = 0;
      for (const p of this.parts) for (const [dx, dy] of [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [-p.w / 2, p.h / 2], [p.w / 2, p.h / 2]]) {
        const lx = p.x + dx - this.cx, ly = p.y + dy - this.cy;
        const wx = this.x + lx * sa + ly * ca, wy = this.y - lx * ca + ly * sa;
        worst = Math.min(worst, Math.hypot(wx - bx, wy - by) - R);
      }
      if (worst >= 0) continue;
      const dx = this.x - bx, dy = this.y - by, d = Math.hypot(dx, dy);
      const nx = dx / d, ny = dy / d;
      this.x -= nx * worst; this.y -= ny * worst;
      const rvx = this.vx - bvx, rvy = this.vy - bvy;
      const vn = rvx * nx + rvy * ny;
      if (vn > 0.5) continue;
      const speed = Math.hypot(rvx, rvy);
      const tilt = Math.abs(angDiff(this.ang, Math.atan2(ny, nx)));
      this.touch(body, speed, vn, tilt, nx, ny, bvx, bvy);
      return;
    }
  }

  private touch(body: 'earth' | 'moon', speed: number, vn: number, tilt: number, nx: number, ny: number, bvx: number, bvy: number): void {
    const settle = (gentle: boolean) => {
      this.state = 'landed'; this.body = body; this.w = 0;
      this.ang = Math.atan2(ny, nx) + Math.max(-0.3, Math.min(0.3, angDiff(this.ang, Math.atan2(ny, nx))));
      const [bx, by] = body === 'earth' ? [0, 0] : moonAt(this.t);
      this.rest = [this.x - bx, this.y - by];
      this.vx = bvx; this.vy = bvy;
      this.landings++;
      this.gentle = gentle;
      if (body === 'moon') this.moonLanded = true;
      if (body === 'earth' && this.moonLanded) this.earthAfterMoon = true;
      if (body === 'earth' && this.orbitE) this.earthAfterOrbit = true;
      this.events.push({ kind: 'land', body, speed, gentle });
    };
    if (body === 'earth') {
      const chuteOpen = this.chute === 'open' && this.chuteK > 0.5;
      if (this.maxAlt < 20 && this.landings === 0) this.fail('hop');
      if (speed > 20 || (speed > 12 && !chuteOpen)) {
        if (!chuteOpen && this.maxAlt >= 20) this.fail('pancake');
        this.explode();
        return;
      }
      settle(speed <= 8 && tilt < 0.5);
      return;
    }
    if (speed > 30) { this.fail('crater'); this.explode(); return; }
    if (this.hasLegs()) { settle(speed <= 5 && tilt < 0.35); return; }
    // No legs: bounce.
    if (-vn > 1.5) {
      const rvx = this.vx - bvx, rvy = this.vy - bvy;
      const tx = rvx - vn * nx, ty = rvy - vn * ny;
      this.vx = bvx + tx * 0.6 - vn * nx * 0.5; this.vy = bvy + ty * 0.6 - vn * ny * 0.5;
      this.w += (this.bounces % 2 ? 1 : -1) * 0.6;
      this.bounces++;
      this.events.push({ kind: 'bounce', speed: -vn });
      if (this.bounces >= 3) this.fail('bounce');
      return;
    }
    settle(false);
  }

  private explode(): void {
    this.state = 'destroyed';
    this.events.push({ kind: 'boom', x: this.x, y: this.y });
  }

  private fail(id: FailId, terminal = false): void {
    if (!this.fails.has(id)) { this.fails.add(id); this.events.push({ kind: 'fail', id }); }
    if (terminal && !this.over) this.state = 'stuck';
  }

  // ---- staging and parachute -------------------------------------------------------------

  stage(): void {
    if (this.over) return;
    if (!this.launched) {
      this.launched = true;
      this.events.push({ kind: 'ignite' });
      this.checkDry();
      return;
    }
    const s = this.bottomSec;
    const boosters = this.parts.filter((p) => p.kind === 'booster' && p.sec === s);
    let drop: LivePart[];
    if (boosters.length) drop = boosters;
    else if (this.hasDecoupler()) {
      const cut = Math.max(...this.parts.filter((p) => p.kind === 'decoupler').map((p) => p.row));
      drop = this.parts.filter((p) => p.row >= cut);
      this.decoupled++;
    } else return;
    const before = { cx: this.cx, cy: this.cy };
    this.parts = this.parts.filter((p) => !drop.includes(p));
    if (!this.parts.length) return;
    const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
    // Debris carries the old frame; the kept rocket's centre of mass moves.
    this.events.push({ kind: 'stage', parts: drop.map((p) => ({ ...p })), x: this.x, y: this.y, vx: this.vx, vy: this.vy, ang: this.ang, w: this.w, cx: before.cx, cy: before.cy });
    this.massProps();
    const lx = this.cx - before.cx, ly = this.cy - before.cy;
    this.x += lx * sa + ly * ca; this.y += -lx * ca + ly * sa;
    this.tower = Math.min(this.tower, new Set(this.parts.map((p) => p.row)).size);
    if (this.state === 'landed' || this.state === 'pad') {
      const [bx, by] = this.body === 'earth' ? [0, 0] : moonAt(this.t);
      this.rest = [this.x - bx, this.y - by];
    }
    this.checkDry();
  }

  private checkDry(): void {
    const s = this.bottomSec;
    const eng = this.activeEngines().filter((p) => this.isEngine(p));
    if (eng.length && this.secFuel(s) <= 0) { this.events.push({ kind: 'dry' }); this.fail('dry'); }
  }

  openChute(): void {
    if (this.chute !== 'packed') return;
    this.chute = 'open'; this.chuteK = 0;
    this.events.push({ kind: 'chute' });
  }

  // ---- watching for goals and fails ------------------------------------------------------

  private watch(dt: number): void {
    if (this.state === 'flight' || this.state === 'landed') {
      const alt = this.alt;
      this.maxAlt = Math.max(this.maxAlt, alt);
      const rho = density(alt);
      const v = this.speed;
      if (this.state === 'flight') {
        if (rho > 0) this.spin += Math.abs(this.w) * dt;
        if (this.noFins && this.spin > 4 * Math.PI) this.fail('ballerina');
        // Tall towers bend and snap under load.
        if (this.tower > 14 && v > 60 && rho > 0.05) { this.fail('spaghetti'); this.explode(); return; }
        if (!this.sonicDone && v > 340 && rho > 0.2) { this.sonicDone = true; this.events.push({ kind: 'sonic' }); }
        if (this.chute === 'open' && v > 300 && rho > 1e-3) { this.chute = 'torn'; this.events.push({ kind: 'torn' }); this.fail('torn'); }
        // Sideways Express: low and fast across the ground.
        if (alt < 3000) {
          const range = Math.abs(Math.atan2(this.x, this.y)) * R_E;
          const r = Math.hypot(this.x, this.y), vr = (this.x * this.vx + this.y * this.vy) / r;
          const vt = Math.sqrt(Math.max(0, v * v - vr * vr));
          if (range > 2000 && vt > 2 * Math.abs(vr)) this.fail('sideways');
        }
        // Boosters burnt out but never let go.
        const bs = this.boostersAttached();
        if (bs.length && bs.every((b) => b.fuel <= 0)) {
          this.emptyBoostT += dt;
          if (rho > 0) this.spinSinceEmpty += Math.abs(this.w) * dt;
          if (this.emptyBoostT > 3 && this.spinSinceEmpty > 2 * Math.PI) this.fail('clingy');
        }
        // So close: falling back with nothing left to burn, just short of the target.
        const r = Math.hypot(this.x, this.y), vr = (this.x * this.vx + this.y * this.vy) / r;
        if (vr < 0 && !this.hasThrust() && !this.hasDecoupler() && this.maxAlt >= this.target * 0.9 && this.maxAlt < this.target && !this.goalMet()) this.fail('soclose');
        // Orbits.
        if (alt > ATMO && !this.orbitE) {
          const o = this.earthOrbit();
          if (o.peri > R_E + ATMO && o.apo < A_M * 0.6) { this.orbitE = true; this.orbitStaged = this.decoupled > 0; }
        }
        const [mrx, mry] = this.moonRel();
        if (Math.hypot(mrx, mry) < SOI_M) {
          this.soi = true;
          const mo = this.moonOrbitNow();
          if (mo.energy < 0 && mo.peri > R_M + 3000 && mo.apo < R_M + 600_000) this.moonOrbit = true;
        }
        const o = this.earthOrbit();
        if (o.energy > 0 && Math.hypot(this.x, this.y) > 2.2 * A_M) { this.fail('postcard'); this.state = 'escaped'; }
      }
    }
  }

  /** Has the mission's objective been reached (so far)? */
  goalMet(): boolean {
    const g = this.goal;
    switch (g.kind) {
      case 'alt': return this.maxAlt >= g.alt;
      case 'return': return this.maxAlt >= g.alt && this.state === 'landed' && this.body === 'earth' && this.landings > 0;
      case 'orbit': return this.orbitE && (!g.stages || this.orbitStaged);
      case 'orbitReturn': return this.earthAfterOrbit;
      case 'moonFlyby': return this.soi;
      case 'moonOrbit': return this.moonOrbit;
      case 'moonLand': return this.moonLanded;
      case 'moonReturn': return this.earthAfterMoon;
    }
  }
}

/** Shortest signed angle from b to a. */
export function angDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ---- prediction (point mass, same integrator as coasting) ------------------------------------

export interface Prediction { peakAlt: number; moonMin: number; moonMinT: number; earthMin: number; earthMinT: number; impact: boolean }

/**
 * Coast forward from a state with no thrust. `drag` = drag factor (0.5 rho Cd A / m at rho = 1)
 * for suborbital peaks. Stops at an impact, at tMax, or once well past the Moon on the way back.
 */
export function predict(x: number, y: number, vx: number, vy: number, t: number, tMax: number, drag = 0, stopPeak = false): Prediction {
  const out: Prediction = { peakAlt: Math.hypot(x, y) - R_E, moonMin: Infinity, moonMinT: 0, earthMin: Infinity, earthMinT: 0, impact: false };
  const t0 = t;
  let leftEarth = false;
  while (t - t0 < tMax) {
    const r = Math.hypot(x, y), alt = r - R_E;
    const [mx, my, mvx, mvy] = moonAt(t);
    const dmx = x - mx, dmy = y - my, dm = Math.hypot(dmx, dmy);
    const v = Math.hypot(vx, vy);
    const rho = density(alt);
    let dt: number;
    if (rho > 0 || alt < 3000 || dm - R_M < 3000) dt = drag > 0 && rho > 0 ? 0.25 : 1;
    else dt = Math.max(1 / 60, Math.min(10, 0.004 * Math.min(r / Math.max(1, v), dm / Math.max(1, Math.hypot(vx - mvx, vy - mvy)))));
    const [gx, gy] = gravity(x, y, t);
    vx += gx * dt; vy += gy * dt;
    if (drag > 0 && rho > 0) { const k = 1 / (1 + drag * rho * v * dt); vx *= k; vy *= k; }
    x += vx * dt; y += vy * dt; t += dt;
    const nalt = Math.hypot(x, y) - R_E;
    if (nalt > out.peakAlt) out.peakAlt = nalt;
    else if (stopPeak) return out;
    if (nalt > 1000) leftEarth = true;
    const ma = dm - R_M;
    if (ma < out.moonMin) { out.moonMin = ma; out.moonMinT = t - t0; }
    if (leftEarth && nalt < out.earthMin) { out.earthMin = nalt; out.earthMinT = t - t0; }
    if (nalt < 0 || ma < 0) { out.impact = true; return out; }
  }
  return out;
}

/** Points along the coasting path (for the minimap), every `every` seconds of flight. */
export function predictPath(x: number, y: number, vx: number, vy: number, t: number, tMax: number, maxPts = 160): [number, number][] {
  const pts: [number, number][] = [[x, y]];
  const t0 = t, every = tMax / maxPts;
  let next = t + every;
  while (t - t0 < tMax && pts.length < maxPts) {
    const r = Math.hypot(x, y);
    const [mx, my, mvx, mvy] = moonAt(t);
    const dm = Math.hypot(x - mx, y - my);
    if (r < R_E || dm < R_M) break;
    const dt = Math.max(0.5, Math.min(30, 0.01 * Math.min(r / Math.max(1, Math.hypot(vx, vy)), dm / Math.max(1, Math.hypot(vx - mvx, vy - mvy)))));
    const [gx, gy] = gravity(x, y, t);
    vx += gx * dt; vy += gy * dt; x += vx * dt; y += vy * dt; t += dt;
    if (t >= next) { pts.push([x, y]); next += every; }
  }
  return pts;
}

/** Level problems: the stored design must be legal, use unlocked parts and earn the budget star. */
export function lintLevel(m: RMission): string[] {
  const e = designErrors(m.solution);
  for (const [c, l, r] of m.solution.rows) for (const k of [c, l, r]) if (k && !m.parts.includes(k)) e.push(`solution uses ${k}, not unlocked here`);
  if (designCost(m.solution) > m.budget * 0.8) e.push('solution costs more than 80% of the budget');
  return e;
}
