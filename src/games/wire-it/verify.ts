import { starsFrom, stateHash } from '../../engine/levels/session';
import type { Verifier } from '../../engine/levels/verify';
import { check, gateCount, LEVEL_SCHEMA, lintLevel, par, solutionNet, truthTable, wireCount, type WILevel } from './logic';

export const verifier: Verifier<WILevel> = {
  game: 'wire-it',
  schema: LEVEL_SCHEMA,
  lint: lintLevel,
  run(level) {
    const net = solutionNet(level);
    const rows = truthTable(level);
    const ok = check(level, net, rows);
    const solved = ok.every(Boolean);
    const p = par(level);
    const bad = ok.findIndex((x) => !x);
    return {
      solved,
      stars: starsFrom([solved, gateCount(net) <= p.gates, wireCount(net) <= p.wires]),
      hash: stateHash({ ok, gates: net.gates.map((g) => g.type), wires: net.wires }),
      note: solved ? `${p.gates} parts, ${p.wires} wires` : `row ${bad} fails`,
    };
  },
};
