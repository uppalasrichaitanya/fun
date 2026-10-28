import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { LEVEL_SCHEMA, lintLevel, run, starsMet, type FBLevel } from './logic';

export const verifier: Verifier<FBLevel> = {
  game: 'firebreak',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const { sim, out } = run(level, level.solution);
    const met = starsMet(level, out);
    return {
      solved: met[0], stars: starsFrom(met),
      hash: stateHash({ lit: Array.from(sim.litAt).map((v) => Math.round(v * 1000)), t: out.t }),
      note: `saved ${out.saved}/${out.houses}, forest ${out.forestPct}%`,
    };
  },
};
