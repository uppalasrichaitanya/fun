import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { DefenceSim, Field, LEVEL_SCHEMA, lintLevel, pathLength, puzzleGoals, shortestPath, wallMask, type MMLevel } from './logic';

export const verifier: Verifier<MMLevel> = {
  game: 'maze-maker',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const f = new Field(level);
    const walls = wallMask(level.solution.walls);
    const budgetOk = level.solution.walls.length <= level.walls;
    if (level.mode === 'puzzle') {
      const len = pathLength(f, walls);
      const [a, b, c] = puzzleGoals(level);
      const stars = budgetOk ? starsFrom([len >= a, len >= b, len >= c]) : 0;
      return { solved: budgetOk && len >= a, stars, hash: stateHash(shortestPath(f, walls)), note: `path ${len}, best ${level.best}` };
    }
    const sim = new DefenceSim(f, walls, level.solution.traps ?? []);
    const r = sim.run();
    const survived = r.hearts > 0 && budgetOk;
    return {
      solved: survived, stars: starsFrom([survived, r.leaked <= 2, r.leaked === 0]),
      hash: stateHash({ hearts: r.hearts, t: Math.round(r.t * 1000), hp: sim.monsters.map((m) => m.hp) }), note: `leaked ${r.leaked}`,
    };
  },
};
