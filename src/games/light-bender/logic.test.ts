import { describe, expect, it } from 'vitest';
import { Board, piecesFrom, trace, type LBLevel, type Placed } from './logic';
import { solve } from './solver';

const room = (rows: string[], things: LBLevel['things'], solution: Placed[] = []): LBLevel =>
  ({ name: 't', w: rows[0].length, h: rows.length, rows, things, inv: { mirror: 4, splitter: 2, oneway: 2, 'filter-r': 1, combiner: 1 }, par: 1, solution });

describe('Light Bender beam', () => {
  it('mirrors turn the beam 90 degrees both ways', () => {
    const l = room(['.....', '.....', '.....'], [['emit', 0, 1, 0, 7], ['crystal', 2, 0, 7]]);
    const b = new Board(l);
    expect(trace(b, []).solved).toBe(false);
    expect(trace(b, piecesFrom([['mirror', 2, 1, 0]])).solved).toBe(true);   // '/' sends right-moving beam up
    expect(trace(b, piecesFrom([['mirror', 2, 1, 1]])).solved).toBe(false);  // '\\' sends it down
  });

  it('one-way mirrors reflect from the front and block from the back', () => {
    const l = room(['.....', '.....', '.....'], [['emit', 0, 1, 0, 7], ['crystal', 2, 0, 7], ['crystal', 4, 1, 7]]);
    const b = new Board(l);
    const front = trace(b, piecesFrom([['oneway', 2, 1, 0]]));
    expect(front.lit[0]).toBe(true);
    const back = trace(b, piecesFrom([['oneway', 2, 1, 2]]));
    expect(back.lit).toEqual([false, false]);
    expect(back.beams[0].end).toBe('block');
  });

  it('splitters light both branches; filters and coloured crystals', () => {
    const l = room(['.....', '.....', '.....'], [['emit', 0, 1, 0, 7], ['crystal', 2, 0, 7], ['crystal', 4, 1, 1]]);
    const b = new Board(l);
    // White light does not light a red crystal.
    expect(trace(b, piecesFrom([['splitter', 2, 1, 0]])).lit).toEqual([true, false]);
    l.things[2] = ['crystal', 4, 1, 7];
    expect(trace(new Board(l), piecesFrom([['splitter', 2, 1, 0]])).lit).toEqual([true, true]);
    const red = room(['.....', '.....', '.....'], [['emit', 0, 1, 0, 7], ['crystal', 4, 1, 1]]);
    expect(trace(new Board(red), []).solved).toBe(false);
    expect(trace(new Board(red), piecesFrom([['filter-r', 2, 1, 0]])).solved).toBe(true);
  });

  it('combiners add colours and output one beam', () => {
    // Red from the left, blue from above into a combiner at (2,1) facing right -> magenta crystal at (4,1).
    const l = room(['.....', '.....', '.....'], [['emit', 0, 1, 0, 1], ['emit', 2, 0, 1, 4], ['crystal', 4, 1, 5]]);
    const t = trace(new Board(l), piecesFrom([['combiner', 2, 1, 0]]));
    expect(t.combined.get(1 * 5 + 2)).toBe(5);
    expect(t.solved).toBe(true);
  });

  it('loops and portals terminate', () => {
    const l = room(['.....', '.....', '.....', '.....'], [['emit', 0, 0, 0, 7], ['crystal', 4, 3, 7], ['portal', 2, 0, 0], ['portal', 0, 3, 0]]);
    const t = trace(new Board(l), []);
    expect(t.solved).toBe(true); // through the portal, out along row 3
    const loop = room(['....', '....', '....', '....'], [['emit', 0, 1, 0, 7], ['crystal', 3, 3, 7]]);
    const t2 = trace(new Board(loop), piecesFrom([['splitter', 1, 1, 1], ['mirror', 1, 2, 0], ['mirror', 2, 2, 1], ['mirror', 2, 1, 0]]));
    expect(t2.steps).toBeLessThan(400);
  });

  it('the solver finds the minimum piece count', () => {
    const l = room(['......', '......', '....#.', '......', '......', '......'], [['emit', 0, 2, 0, 7], ['crystal', 4, 4, 7]]);
    const r = solve(l, 3, { mirror: 3 });
    expect(Math.min(...r.solutions.map((s) => s.pieces.length))).toBe(2);
    for (const s of r.solutions) expect(trace(new Board(l), s.pieces).solved).toBe(true);
  });
});
