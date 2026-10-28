// The flight computer: flies any design through its mission profile. Ascent
// (straight up for altitude missions, gravity turn for orbits), circularise,
// Moon transfer timed by phase angle and trimmed by prediction, capture, a
// suicide-burn landing, the return burn planned by sampling a lunar orbit, and
// a parachute descent. Deterministic: it only reads the flight's state.
import {
  angDiff, ATMO, density, Flight, GM_E, GM_M, gravity, IDLE, moonAt, orbitOf, predict, R_E, R_M, SOI_M, timeToApo, W_M, A_M,
  type Control, type Goal,
} from './logic';

type Phase =
  | 'pad' | 'ascent' | 'ballistic' | 'coast' | 'circ' | 'orbit' | 'deorbit' | 'reentry' | 'descent'
  | 'tliWait' | 'tli' | 'cruise' | 'correct' | 'approach' | 'capture' | 'moonOrbit' | 'brake' | 'land'
  | 'moonWait' | 'moonAscent' | 'moonCoast' | 'moonCirc' | 'retWait' | 'retBurn' | 'retCruise' | 'done';

export const PHASE_LABEL: Record<Phase, string> = {
  pad: 'Ready', ascent: 'Climbing', ballistic: 'Coasting up', coast: 'Coasting to apoapsis', circ: 'Circularising', orbit: 'In orbit',
  deorbit: 'De-orbit burn', reentry: 'Falling home', descent: 'Descent', tliWait: 'Waiting for the Moon', tli: 'Moon transfer burn',
  cruise: 'Cruising to the Moon', correct: 'Course correction', approach: 'Moon approach', capture: 'Capture burn', moonOrbit: 'Moon orbit',
  brake: 'Braking', land: 'Landing', moonWait: 'On the Moon', moonAscent: 'Lifting off the Moon', moonCoast: 'Coasting', moonCirc: 'Circularising',
  retWait: 'Waiting for the return window', retBurn: 'Return burn', retCruise: 'Heading home', done: 'Flight complete',
};

const ORBIT_ALT = 85_000;
const RETURN_PERI = 30_000;

/** Coast a point mass (same stepping as the flight's coasting) for `dur` seconds. */
function coast(s: [number, number, number, number, number], dur: number): [number, number, number, number, number] {
  let [x, y, vx, vy, t] = s;
  const end = t + dur;
  while (t < end - 1e-9) {
    const [mx, my, mvx, mvy] = moonAt(t);
    const r = Math.hypot(x, y), dm = Math.hypot(x - mx, y - my);
    const dt = Math.min(end - t, Math.max(1 / 60, Math.min(10, 0.004 * Math.min(r / Math.max(1, Math.hypot(vx, vy)), dm / Math.max(1, Math.hypot(vx - mvx, vy - mvy))))));
    const [gx, gy] = gravity(x, y, t);
    vx += gx * dt; vy += gy * dt; x += vx * dt; y += vy * dt; t += dt;
  }
  return [x, y, vx, vy, t];
}

export class FlightComputer {
  phase: Phase = 'pad';
  /** Sim time the current phase began. */
  since = 0;
  private stageAt = -1;
  private lastPred = -1;
  private burnAt = 0;
  private landedAt = 0;

  constructor(readonly goal: Goal) {}

  get label(): string { return PHASE_LABEL[this.phase]; }
  get done(): boolean { return this.phase === 'done'; }

  private go(p: Phase, f: Flight): void { this.phase = p; this.since = f.t; this.lastPred = -1; }

  private moonMission(): boolean { return this.goal.kind.startsWith('moon'); }
  private orbital(): boolean { return this.goal.kind !== 'alt' && this.goal.kind !== 'return'; }

  /** Drop empty boosters / spent stages (never the pod's own section). */
  private autoStage(f: Flight, c: Control): void {
    if (!f.launched) { c.stage = true; return; }
    if (f.t - this.stageAt < 0.6) return;
    const bs = f.boostersAttached().filter((b) => b.sec === f.bottomSec);
    if (bs.length && bs.every((b) => b.fuel <= 0)) { c.stage = true; this.stageAt = f.t; return; }
    if (!f.hasThrust() && this.canDecouple(f)) { c.stage = true; this.stageAt = f.t; }
  }

  private canDecouple(f: Flight): boolean {
    const pod = f.parts.find((p) => p.kind === 'pod');
    const cut = Math.max(-1, ...f.parts.filter((p) => p.kind === 'decoupler').map((p) => p.row));
    return cut >= 0 && !!pod && pod.row < cut;
  }

  /** Point at `target`; fire once roughly aligned. */
  private burn(f: Flight, c: Control, target: number, throttle = 1, tol = 0.15): void {
    c.target = target;
    c.throttle = Math.abs(angDiff(target, f.ang)) < tol ? throttle : 0;
    if (c.throttle > 0 || !f.hasThrust()) this.autoStage(f, c);
  }

  control(f: Flight): Control {
    const c: Control = { ...IDLE };
    if (f.over) return c;
    const up = Math.atan2(f.y, f.x);
    const pro = Math.atan2(f.vy, f.vx), retro = pro + Math.PI;
    const [mrx, mry, mvx, mvy] = f.moonRel();
    const mUp = Math.atan2(mry, mrx), mPro = Math.atan2(mvy, mvx), mRetro = mPro + Math.PI;
    const alt = f.alt;
    const rE = Math.hypot(f.x, f.y);
    const vr = (f.x * f.vx + f.y * f.vy) / rE;
    const acc = f.maxAccel();
    switch (this.phase) {
      case 'pad':
        c.stage = true; c.throttle = 1; c.target = up;
        this.go('ascent', f);
        break;

      case 'ascent': {
        c.throttle = 1;
        if (!this.orbital()) {
          c.target = up;
          if (f.t - this.lastPred > 0.5) {
            this.lastPred = f.t;
            const p = predict(f.x, f.y, f.vx, f.vy, f.t, 3000, (0.5 * f.aero().cdA) / f.mass, true);
            const tgt = this.goal.kind === 'alt' || this.goal.kind === 'return' ? this.goal.alt : 0;
            if (p.peakAlt >= tgt * 1.04 + 30) { c.throttle = 0; this.go('ballistic', f); break; }
          }
        } else {
          const theta = alt < 800 || f.speed < 50 ? 0 : Math.min(1.53, (Math.PI / 2) * Math.pow((alt - 800) / 42_000, 0.55));
          c.target = up + theta;
          const o = f.earthOrbit();
          if (o.apo >= R_E + ORBIT_ALT) { c.throttle = 0; this.go('coast', f); break; }
        }
        this.autoStage(f, c);
        if (!f.hasThrust() && !this.canDecouple(f) && f.launched && f.t - this.since > 1 && f.state === 'flight') this.go(this.orbital() ? 'coast' : 'ballistic', f);
        break;
      }

      case 'ballistic':
        c.target = f.speed > 5 ? pro : up;
        if (vr < 0) this.go('descent', f);
        break;

      case 'coast': {
        c.target = alt < ATMO ? pro : up + Math.PI / 2;
        const tA = timeToApo(f.x, f.y, f.vx, f.vy, GM_E);
        const o = f.earthOrbit();
        if (o.apo < R_E + ATMO && vr < 0) { this.go('descent', f); break; }
        const vApo = o.h / o.apo, vCirc = Math.sqrt(GM_E / o.apo);
        const burnT = acc > 0 ? (vCirc - vApo) / acc : 60;
        c.maxDt = Math.max(1 / 60, (tA - burnT / 2) / 15);
        if (!f.hasThrust() && this.canDecouple(f) && alt > ATMO) this.autoStage(f, c);
        if (tA < burnT / 2 + 1 || vr < 0) this.go('circ', f);
        break;
      }

      case 'circ': {
        const o = f.earthOrbit();
        const left = R_E + ATMO + 6000 - o.peri;
        this.burn(f, c, up + Math.PI / 2, left < 20_000 ? 0.4 : 1, 0.25);
        if (o.peri >= R_E + ATMO + 6000) { c.throttle = 0; this.go('orbit', f); }
        else if (!f.hasThrust() && !this.canDecouple(f)) this.go(o.peri < R_E + ATMO ? 'descent' : 'orbit', f);
        break;
      }

      case 'orbit':
        c.target = up + Math.PI / 2;
        if (f.t - this.since < 3) break;
        if (this.moonMission() && (f.hasThrust() || this.canDecouple(f))) this.go('tliWait', f);
        else if (f.chute === 'packed' && (f.hasThrust() || this.canDecouple(f))) this.go('deorbit', f);
        else this.go('done', f);
        break;

      case 'deorbit': {
        const o = f.earthOrbit();
        this.burn(f, c, retro);
        if (o.peri < R_E + 25_000) { c.throttle = 0; this.go('reentry', f); }
        else if (!f.hasThrust() && !this.canDecouple(f)) this.go('done', f);
        break;
      }

      case 'reentry':
        c.target = retro;
        if (alt < ATMO + 10_000) this.go('descent', f);
        break;

      case 'descent': {
        c.target = f.speed > 5 ? retro : up;
        // Lighten up for the parachute: everything below the pod goes.
        if (f.t - this.stageAt > 0.8 && alt > 3000 && vr < 0) {
          const bs = f.boostersAttached();
          if (bs.length || this.canDecouple(f)) { c.stage = true; this.stageAt = f.t; }
        }
        if (f.chute === 'packed' && vr < 0 && density(alt) > 0.003 && f.speed < (alt < 4000 ? 285 : 240)) c.chute = true;
        if (f.state === 'landed') this.go('done', f);
        break;
      }

      case 'tliWait': {
        c.target = pro;
        const psiS = up, psiM = Math.atan2(f.y - mry, f.x - mrx);
        const aT = (rE + A_M) / 2;
        const tH = Math.PI * Math.sqrt((aT * aT * aT) / GM_E);
        const want = Math.PI - W_M * tH;
        const dv = Math.sqrt(GM_E * (2 / rE - 1 / aT)) - f.speed;
        const burnT = acc > 0 ? dv / acc : 120;
        const wS = f.speed / rE;
        let err = angDiff(psiM - psiS, want);
        if (err < -0.05) err += 2 * Math.PI;
        const lead = (wS - W_M) * (burnT / 2);
        c.maxDt = Math.max(1 / 60, Math.min(10, (err - lead) / (wS - W_M) / 12));
        if (err <= lead) this.go('tli', f);
        break;
      }

      case 'tli': {
        this.burn(f, c, pro);
        if (c.throttle > 0 && f.t - this.lastPred > 0.25) {
          this.lastPred = f.t;
          const p = predict(f.x, f.y, f.vx, f.vy, f.t, 40_000);
          const o = f.earthOrbit();
          if ((p.moonMin <= 60_000 && p.moonMin > -R_M) || p.moonMin < 0 || o.apo > A_M * 1.25) { c.throttle = 0; this.go('cruise', f); }
        }
        if (!f.hasThrust() && !this.canDecouple(f)) this.go('cruise', f);
        break;
      }

      case 'cruise': {
        c.target = pro;
        const dm = Math.hypot(mrx, mry);
        if (dm < SOI_M) {
          const p = predict(f.x, f.y, f.vx, f.vy, f.t, 30_000);
          this.go(p.moonMin < 15_000 && (f.hasThrust() || this.canDecouple(f)) ? 'correct' : 'approach', f);
        } else if (alt < 200_000 && vr < 0) this.go('descent', f);
        break;
      }

      case 'correct': {
        // Push sideways (away from the Moon, square to the motion) to raise the flyby height.
        const v = Math.hypot(mvx, mvy), rM = Math.hypot(mrx, mry);
        const dot = (mrx * mvx + mry * mvy) / (rM * v);
        const ox = mrx / rM - dot * (mvx / v), oy = mry / rM - dot * (mvy / v);
        this.burn(f, c, Math.atan2(oy, ox), 0.5);
        if (f.t - this.lastPred > 0.25) {
          this.lastPred = f.t;
          const p = predict(f.x, f.y, f.vx, f.vy, f.t, 30_000);
          if (p.moonMin >= 30_000) { c.throttle = 0; this.go('approach', f); }
        }
        if (!f.hasThrust() && !this.canDecouple(f)) this.go('approach', f);
        break;
      }

      case 'approach': {
        c.target = mRetro;
        const rM = Math.hypot(mrx, mry), vM = Math.hypot(mvx, mvy);
        const mvr = (mrx * mvx + mry * mvy) / rM;
        if (f.t - this.lastPred > Math.max(1, c.maxDt)) {
          this.lastPred = f.t;
          const p = predict(f.x, f.y, f.vx, f.vy, f.t, 30_000);
          const rp = R_M + Math.max(0, p.moonMin);
          const vp = Math.sqrt(vM * vM + 2 * GM_M * (1 / rp - 1 / rM));
          const burnT = acc > 0 ? (vp - Math.sqrt(GM_M / rp)) / acc : 60;
          this.burnAt = f.t + p.moonMinT - burnT / 2;
        }
        c.maxDt = Math.max(1 / 60, Math.min(10, (this.burnAt - f.t) / 10));
        if (f.t >= this.burnAt || (mvr > 0 && rM < R_M + 400_000)) this.go('capture', f);
        if (rM > SOI_M * 1.2) this.go('cruise', f);
        break;
      }

      case 'capture': {
        this.burn(f, c, mRetro);
        const mo = f.moonOrbitNow();
        if (mo.energy < 0 && mo.apo < R_M + 150_000) { c.throttle = 0; this.go('moonOrbit', f); }
        else if (!f.hasThrust() && !this.canDecouple(f)) this.go('moonOrbit', f);
        break;
      }

      case 'moonOrbit': {
        c.target = mRetro;
        if (f.t - this.since < 2) break;
        const land = this.goal.kind === 'moonLand' || this.goal.kind === 'moonReturn' || f.hasLegs();
        this.go(land && (f.hasThrust() || this.canDecouple(f)) ? 'brake' : 'done', f);
        break;
      }

      case 'brake': {
        this.burn(f, c, mRetro);
        const rM = Math.hypot(mrx, mry);
        const mvr = (mrx * mvx + mry * mvy) / rM;
        const vt = Math.sqrt(Math.max(0, mvx * mvx + mvy * mvy - mvr * mvr));
        if (vt < 15) { c.throttle = 0; this.go('land', f); }
        else if (!f.hasThrust() && !this.canDecouple(f)) this.go('land', f);
        break;
      }

      case 'land': {
        if (f.state === 'landed') { this.landedAt = f.t; this.go('moonWait', f); break; }
        const rM = Math.hypot(mrx, mry);
        const mvr = (mrx * mvx + mry * mvy) / rM;
        const sp = Math.hypot(mvx, mvy);
        const g = GM_M / (rM * rM);
        const h = rM - R_M - f.bottomOffset();
        const tgt = sp > 2.5 ? mRetro : mUp;
        c.target = tgt;
        const a = Math.max(acc, 1e-3);
        // Follow a stopping curve that uses 60% of the engine, with feed-forward for the braking it implies.
        const brake = Math.max(0.1, a * 0.6 - g);
        const vDes = -Math.max(1.5, Math.min(Math.sqrt(2 * brake * Math.max(0, h - 3)), 600));
        const cosE = Math.max(0.3, Math.cos(angDiff(tgt, f.ang)));
        const ff = vDes < -1.6 && mvr < vDes + 20 ? brake : 0;
        const want = (g + ff + (vDes - mvr) * 3) / (a * cosE);
        c.throttle = Math.max(0, Math.min(1, want));
        if (Math.abs(angDiff(tgt, f.ang)) > 0.5) c.throttle = 0;
        if (c.throttle > 0 || !f.hasThrust()) this.autoStage(f, c);
        c.maxDt = h > 20_000 ? 2 : 1 / 60;
        break;
      }

      case 'moonWait':
        c.target = mUp;
        if (this.goal.kind === 'moonReturn' && f.t - this.landedAt > 2 && (f.hasThrust() || this.canDecouple(f))) this.go('moonAscent', f);
        else if (this.goal.kind !== 'moonReturn' && f.t - this.landedAt > 1.5) this.go('done', f);
        break;

      case 'moonAscent': {
        const h = Math.hypot(mrx, mry) - R_M;
        const theta = h < 400 ? 0 : Math.min(1.45, ((h - 400) / 9000) * 1.45);
        c.target = mUp + theta; c.throttle = 1;
        this.autoStage(f, c);
        const mo = f.moonOrbitNow();
        if (mo.apo >= R_M + 25_000) { c.throttle = 0; this.go('moonCoast', f); }
        break;
      }

      case 'moonCoast': {
        c.target = mUp + Math.PI / 2;
        const tA = timeToApo(mrx, mry, mvx, mvy, GM_M);
        const mo = f.moonOrbitNow();
        const vApo = mo.h / mo.apo, vCirc = Math.sqrt(GM_M / mo.apo);
        const burnT = acc > 0 ? (vCirc - vApo) / acc : 30;
        c.maxDt = Math.max(1 / 60, (tA - burnT / 2) / 15);
        if (tA < burnT / 2 + 1) this.go('moonCirc', f);
        break;
      }

      case 'moonCirc': {
        const mo = f.moonOrbitNow();
        this.burn(f, c, mUp + Math.PI / 2, 1, 0.25);
        if (mo.peri >= R_M + 12_000) { c.throttle = 0; this.planReturn(f); this.go('retWait', f); }
        else if (!f.hasThrust() && !this.canDecouple(f)) this.go('done', f);
        break;
      }

      case 'retWait':
        c.target = mPro;
        c.maxDt = Math.max(1 / 60, Math.min(10, (this.burnAt - f.t) / 8));
        if (f.t >= this.burnAt) this.go('retBurn', f);
        break;

      case 'retBurn': {
        this.burn(f, c, mPro, 1, 0.2);
        if (c.throttle > 0 && f.t - this.lastPred > 0.25) {
          this.lastPred = f.t;
          const p = predict(f.x, f.y, f.vx, f.vy, f.t, 40_000);
          if (p.earthMin <= RETURN_PERI && !(p.moonMin < 0)) { c.throttle = 0; this.go('retCruise', f); }
        }
        if (!f.hasThrust() && !this.canDecouple(f)) this.go('retCruise', f);
        break;
      }

      case 'retCruise':
        c.target = pro;
        if (alt < 200_000) this.go('descent', f);
        break;

      case 'done':
        c.target = f.state === 'landed' ? null : pro;
        break;
    }
    return c;
  }

  /** Sample one lunar orbit for the burn start that sends Bob closest to a 30 km Earth periapsis. */
  private planReturn(f: Flight): void {
    const [mrx, mry, mvx, mvy] = f.moonRel();
    const o = orbitOf(mrx, mry, mvx, mvy, GM_M);
    const T = 2 * Math.PI * Math.sqrt(Math.max(1, o.a) ** 3 / GM_M);
    const acc = Math.max(0.5, f.maxAccel());
    let best = Infinity, bestK = 0, bestDv = 0;
    const N = 48;
    let s: [number, number, number, number, number] = [f.x, f.y, f.vx, f.vy, f.t];
    for (let k = 0; k < N; k++) {
      if (k) s = coast(s, T / N);
      const [x, y, vx, vy, t] = s;
      const [mx, my, mvx2, mvy2] = moonAt(t);
      const rvx = vx - mvx2, rvy = vy - mvy2, v = Math.hypot(rvx, rvy), r = Math.hypot(x - mx, y - my);
      const dv = Math.sqrt(450 * 450 + (2 * GM_M) / r) - v;
      const p = predict(x, y, vx + (rvx / v) * dv, vy + (rvy / v) * dv, t, 40_000);
      if (p.moonMin < 0) continue;
      const score = Math.abs(p.earthMin - RETURN_PERI);
      if (score < best) { best = score; bestK = k; bestDv = dv; }
    }
    const burnT = bestDv / acc;
    this.burnAt = f.t + (bestK * T) / N - burnT / 2;
    if (this.burnAt < f.t + 1) this.burnAt += T;
  }
}

export interface FlightResult { flight: Flight; met: [boolean, boolean, boolean]; stars: number }

/** Fly a design with the flight computer until it lands, crashes or runs out of things to do. */
export function fly(goal: Goal, design: Flight['design'], budget: number, opts: { tMax?: number; thrustScale?: number; onStep?: (f: Flight) => void } = {}): FlightResult {
  const f = new Flight(design, goal, opts.thrustScale);
  const ap = new FlightComputer(goal);
  const tMax = opts.tMax ?? 120_000;
  let doneAt = -1;
  while (!f.over && f.t < tMax) {
    f.step(ap.control(f));
    f.events.length = 0;
    opts.onStep?.(f);
    if (ap.done) { if (doneAt < 0) doneAt = f.t; if (f.t - doneAt > 2) break; }
  }
  const ok = f.goalMet() && f.cost <= budget;
  const met: [boolean, boolean, boolean] = [ok, ok && f.cost <= budget * 0.8, ok && f.cost <= budget * 0.8 && f.state === 'landed' && f.gentle];
  let stars = 0;
  for (const m of met) { if (!m) break; stars++; }
  return { flight: f, met, stars };
}

