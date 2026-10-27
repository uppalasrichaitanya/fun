import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { invTotal, LEVEL_SCHEMA, lintLevel, simulate, type GGLevel } from './logic';

export const verifier: Verifier<GGLevel> = {
  game: 'gravity-golf',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const r = simulate(level, level.solution.planets, level.solution.shot, 1);
    const sunk = r.outcome === 'capture';
    return {
      solved: sunk,
      stars: starsFrom([sunk, r.dust === 7, level.solution.planets.length < invTotal(level)]),
      hash: stateHash({ o: r.outcome, t: r.t, dust: r.dust, end: [r.end.x.toFixed(6), r.end.y.toFixed(6)], n: r.path.length }),
      note: `${r.outcome} after ${r.t.toFixed(2)} s, dust ${r.dust}`,
    };
  },
};
