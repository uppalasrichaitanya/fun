import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { LEVEL_SCHEMA, lintLevel, replay, type SYLevel } from './logic';

export const verifier: Verifier<SYLevel> = {
  game: 'switchyard',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const sim = replay(level, level.solution);
    const all = !sim.fail && sim.delivered === level.trains.length;
    return {
      solved: all, stars: starsFrom([all, true, sim.flips <= level.par]),
      hash: stateHash({ t: sim.t, flips: sim.flips, fail: sim.fail, s: sim.trains.map((t) => Math.round(t.s * 1000)) }),
      note: sim.fail ? `${sim.fail.kind} at ${sim.t.toFixed(2)} s` : `${sim.delivered} delivered in ${sim.t.toFixed(1)} s`,
    };
  },
};
