import { Board, KINDS, TURNS, trace, type Kind, type LBLevel, type Piece } from './logic';

export interface Solution { pieces: Piece[]; gem: boolean }

/**
 * Exhaustive search for solutions using at most `max` pieces from `inv`.
 * A piece only matters where a beam passes, and placing a piece only changes
 * the trace after the moment the beam first reaches it, so pieces are tried
 * in the order the beam meets them: every set of pieces is generated once.
 * Solutions are minimal (no solved state is extended).
 */
export function solve(level: LBLevel, max: number, inv: Partial<Record<Kind, number>> = level.inv, nodeCap = 3_000_000): { solutions: Solution[]; nodes: number; capped: boolean } {
  const b = new Board(level);
  const solutions: Solution[] = [];
  const left = { ...inv };
  const placed: Piece[] = [];
  let nodes = 0, capped = false;
  const kinds = KINDS.filter((k) => (left[k] ?? 0) > 0);
  const occupied = new Set<number>();

  const dfs = (after: number) => {
    if (++nodes > nodeCap) { capped = true; return; }
    const t = trace(b, placed, true);
    if (t.solved) { solutions.push({ pieces: placed.map((p) => ({ ...p })), gem: t.gemLit }); return; }
    if (placed.length >= max) return;
    const cells: number[] = [];
    for (let i = 0; i < t.visit.length; i++) if (t.visit[i] > after && !b.blocked[i] && !occupied.has(i)) cells.push(i);
    cells.sort((x, y) => t.visit[x] - t.visit[y]);
    for (const i of cells) {
      const c = i % b.w, r = Math.floor(i / b.w);
      for (const k of kinds) {
        if (!left[k]) continue;
        left[k]!--; occupied.add(i);
        for (let o = 0; o < TURNS[k]; o++) {
          placed.push({ kind: k, c, r, o, fixed: false });
          dfs(t.visit[i]);
          placed.pop();
          if (capped) break;
        }
        left[k]!++; occupied.delete(i);
        if (capped) return;
      }
    }
  };
  dfs(0);
  return { solutions, nodes, capped };
}
