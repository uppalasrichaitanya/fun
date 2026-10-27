import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { Board, LEVEL_SCHEMA, lintLevel, piecesFrom, trace, type LBLevel } from './logic';

export const verifier: Verifier<LBLevel> = {
  game: 'light-bender',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const t = trace(new Board(level), piecesFrom(level.solution));
    const stars = starsFrom([t.solved, level.solution.length <= level.par, t.gemLit]);
    return { solved: t.solved, stars, hash: stateHash({ lit: t.lit, steps: t.steps, ends: t.beams.map((b) => b.end + b.pts.join(',')) }) };
  },
};
