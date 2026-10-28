import { describe, expect, it } from 'vitest';
import { fly, FlightComputer } from './autopilot';
import { Flight, IDLE, R_M, type Control, type Design, type FailId, type Goal } from './logic';

/** "chute,pod,tankL:booster,engineS:fins" — side parts mirror unless given twice ("tankL:booster:"). */
export const D = (rows: string): Design => ({
  rows: rows.split(',').map((r) => { const [c, l = '', rr = l] = r.split(':'); return [c, l, rr] as Design['rows'][number]; }),
});

/** Fly with a control script; `ap` gives the flight computer's suggestion to tweak. */
function run(design: string, goal: Goal, script: (f: Flight, ap: Control, phase: string) => Control, tMax = 30_000): Flight {
  const f = new Flight(D(design), goal);
  const fc = new FlightComputer(goal);
  while (!f.over && f.t < tMax) {
    f.step(script(f, fc.control(f), fc.phase));
    f.events.length = 0;
    if (f.state === 'landed' && f.t > 5 && fc.done) break;
  }
  return f;
}

const manual = (rest: Partial<Control> = {}) => (f: Flight): Control => ({ ...IDLE, stage: !f.launched, throttle: 1, maxDt: 1 / 60, ...rest });
const SPACE: Goal = { kind: 'alt', alt: 100_000 };

describe('Rocket Builder flight', () => {
  it('is deterministic: same design and inputs, same flight', () => {
    const a = fly({ kind: 'orbit' }, D('chute,pod,tankM,engineS,decoupler,tankL,tankL,engineB:fins'), 999);
    const b = fly({ kind: 'orbit' }, D('chute,pod,tankM,engineS,decoupler,tankL,tankL,engineB:fins'), 999);
    expect([a.flight.x, a.flight.y, a.flight.t]).toEqual([b.flight.x, b.flight.y, b.flight.t]);
    expect(a.met).toEqual([true, true, true]);
  });

  it('the flight computer reaches orbit and brings Bob home gently', () => {
    const r = fly({ kind: 'orbitReturn' }, D('chute,pod,tankM,engineS,decoupler,tankL,tankL,engineB:fins'), 999);
    expect(r.stars).toBe(3);
  });
});

describe('Fail Album: every entry triggers from a test design', () => {
  const cases: [FailId, () => Flight][] = [
    ['ballerina', () => run('pod,tankL,tankL,engineB', SPACE, manual())],
    ['hop', () => run('chute,pod,tankS,engineS:fins', SPACE, (f) => manual({ throttle: f.t < 0.6 ? 1 : 0 })(f))],
    ['drill', () => run('engineS,pod,tankS', SPACE, manual())],
    ['spaghetti', () => run('pod,tankS,tankS,tankS,tankS,tankS,tankS,tankS,tankS,tankS,tankS,tankS,tankS,tankS,engineB:fins', SPACE, manual())],
    ['sideways', () => run('pod,tankS:booster:,tankL,tankL,engineB:fins', SPACE, manual())],
    ['soclose', () => {
      // Aim 5% above what this rocket can reach: it burns everything and falls just short.
      const peak = run('chute,pod,tankL,engineB:fins', { kind: 'alt', alt: 1e7 }, (_f, ap) => ap).maxAlt;
      return run('chute,pod,tankL,engineB:fins', { kind: 'alt', alt: peak * 1.05 }, (_f, ap) => ap);
    }],
    ['statue', () => run('pod,tankS', SPACE, manual())],
    ['clingy', () => run('pod,tankM,tankL:booster,engineS:fins', SPACE, manual())],
    ['torn', () => run('chute,pod,tankL,engineB:fins', SPACE, (f) => manual({ chute: f.speed > 320 })(f))],
    ['crater', () => run('chute,pod,tankL,engineS:legs,decoupler,tankL,tankL:booster,tankL,engineB:fins', { kind: 'moonLand' }, (_f, ap, ph) => (ph === 'land' ? { ...ap, throttle: 0 } : ap))],
    ['postcard', () => run('chute,pod,tankL,engineS:legs,decoupler,tankL,tankL:booster,tankL,engineB:fins', { kind: 'moonLand' }, (f, ap, ph) => (ph === 'cruise' || ph === 'correct' || ph === 'approach' || ph === 'capture' ? { ...ap, throttle: 1, target: Math.atan2(f.vy, f.vx) } : ap), 60_000)],
    ['dry', () => run('pod,tankM,decoupler,engineS', SPACE, manual())],
    ['pancake', () => run('pod,tankM,engineS:fins', { kind: 'alt', alt: 5000 }, (_f, ap) => ap)],
    ['bounce', () => run('chute,pod,tankL,engineS:fins,decoupler,tankL,tankL:booster,tankL,engineB:fins', { kind: 'moonLand' }, (f, ap, ph) => {
      if (ph !== 'land') return ap;
      const [rx, ry] = f.moonRel();
      return Math.hypot(rx, ry) - R_M < 15 ? { ...ap, throttle: 0 } : ap;
    })],
  ];
  for (const [id, make] of cases) it(id, () => expect([...make().fails]).toContain(id));
});
