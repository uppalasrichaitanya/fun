import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { beamCost, Bridge, LEVEL_SCHEMA, lintLevel, starsMet, type BLevel } from './logic';

export const verifier: Verifier<BLevel> = {
  game: 'bridge-it',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const sim = new Bridge(level, level.solution).run();
    const met = starsMet(level, level.solution, sim.outcome === 'crossed');
    return {
      solved: met[0], stars: starsFrom(met),
      hash: stateHash({ x: Array.from(sim.x).map((v) => Math.round(v * 100)), t: sim.steps }),
      note: `${sim.outcome} at ${sim.t.toFixed(1)} s, $${beamCost(level, level.solution)}/${level.budget}, peak stress ${Math.round(sim.maxStress * 100)}%`,
    };
  },
};
