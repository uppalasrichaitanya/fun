import { stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { fly } from './autopilot';
import { designCost, LEVEL_SCHEMA, lintLevel, type RMission } from './logic';

export const verifier: Verifier<RMission> = {
  game: 'rocket-builder',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const r = fly(level.goal, level.solution, level.budget);
    const f = r.flight;
    return {
      solved: r.met[0], stars: r.stars,
      hash: stateHash({ x: Math.round(f.x), y: Math.round(f.y), t: Math.round(f.t * 100), steps: f.steps }),
      note: `${f.state} after ${Math.round(f.t)} s, $${designCost(level.solution)}/${level.budget}`,
    };
  },
};
