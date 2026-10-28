import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { LEVEL_SCHEMA, lintLevel, play, type HLevel } from './logic';

export const verifier: Verifier<HLevel> = {
  game: 'heist-15',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const h = play(level, level.solution);
    const ok = h.outcome === 'escaped';
    return {
      solved: ok, stars: starsFrom([ok, h.timeLeft >= 4, h.usedTools === 0]),
      hash: stateHash({ o: h.outcome, f: h.frame, x: h.x.toFixed(6), y: h.y.toFixed(6), g: h.guards.map((g) => [g.x.toFixed(4), g.y.toFixed(4)]) }),
      note: `${h.outcome} with ${h.timeLeft.toFixed(2)} s left`,
    };
  },
};
