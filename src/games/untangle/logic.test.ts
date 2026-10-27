import { describe, expect, it } from 'vitest';
import { Rng } from '../../engine/rng';
import { countCrossings, Crossings, linesFor, makePuzzle, segCross } from './logic';

describe('Untangle', () => {
  it('every level is solvable and starts genuinely tangled', () => {
    for (let level = 1; level <= 30; level++) {
      const p = makePuzzle(level);
      const L = linesFor(level);
      expect(p.solution).toHaveLength((L * (L - 1)) / 2);
      expect(countCrossings(p.solution, p.edges)).toBe(0);
      expect(p.startCrossings).toBeGreaterThanOrEqual(L * 2);
      expect(countCrossings(p.start, p.edges)).toBe(p.startCrossings);
    }
  });

  it('the same level always makes the same puzzle', () => {
    expect(makePuzzle(7)).toEqual(makePuzzle(7));
  });

  it('crossing test: shared endpoints, collinear overlap, T-junctions', () => {
    expect(segCross(0, 0, 2, 2, 0, 2, 2, 0)).toBe(true);           // X
    expect(segCross(0, 0, 1, 0, 2, 0, 3, 0)).toBe(false);          // collinear, apart
    expect(segCross(0, 0, 2, 0, 1, 0, 3, 0)).toBe(true);           // collinear overlap
    expect(segCross(0, 0, 2, 0, 1, 0, 1, 2)).toBe(true);           // endpoint on segment
    expect(segCross(0, 0, 1, 0, 0, 1, 1, 1)).toBe(false);          // parallel
    expect(segCross(0, 0, 1, 1, 1, 1, 2, 0)).toBe(true);           // touching at an endpoint (no shared vertex id)
  });

  it('incremental updates always match a full recount', () => {
    const rng = new Rng(3);
    for (const level of [1, 5, 12, 16]) {
      const p = makePuzzle(level);
      const pos = p.start.map((q) => ({ ...q }));
      const c = new Crossings(pos, p.edges);
      for (let i = 0; i < 200; i++) {
        const v = rng.int(0, pos.length - 1);
        const before = { ...pos[v] };
        // Sometimes drop a dot exactly onto another dot's line or position.
        pos[v] = rng.chance(0.1) ? { ...pos[rng.int(0, pos.length - 1)] } : { x: rng.next(), y: rng.next() };
        c.moved(v, before);
        expect(c.total).toBe(countCrossings(pos, p.edges));
      }
    }
  });
});
