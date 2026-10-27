import { describe, expect, it } from 'vitest';
import { Rng } from '../rng';
import { History } from './history';

interface Toy { cells: (string | null)[]; inv: Record<string, number> }

describe('History', () => {
  it('survives 500 random edits with undos and redos without corrupting the build', () => {
    const rng = new Rng(7);
    const h = new History<Toy>(100);
    let s: Toy = { cells: Array(16).fill(null), inv: { a: 4, b: 3 } };
    const timeline: string[] = [JSON.stringify(s)];
    let at = 0;
    const invariant = (t: Toy) => {
      const used = { a: 0, b: 0 } as Record<string, number>;
      for (const c of t.cells) if (c) used[c]++;
      expect(used.a + t.inv.a).toBe(4);
      expect(used.b + t.inv.b).toBe(3);
    };
    for (let step = 0; step < 500; step++) {
      const r = rng.next();
      if (r < 0.6) {
        const i = rng.int(0, 15), k = rng.pick(['a', 'b']);
        const changed = h.track(s, () => {
          const cur = s.cells[i];
          if (cur) { s.inv[cur]++; s.cells[i] = null; } else if (s.inv[k] > 0) { s.inv[k]--; s.cells[i] = k; }
        });
        if (changed) { timeline.length = at + 1; timeline.push(JSON.stringify(s)); at++; }
      } else if (r < 0.85) {
        const u = h.undo(s);
        if (u) { s = u; at--; }
      } else {
        const u = h.redo(s);
        if (u) { s = u; at++; }
      }
      invariant(s);
      expect(JSON.stringify(s)).toBe(timeline[at]);
    }
  });

  it('keeps at most 100 steps', () => {
    const h = new History<{ n: number }>();
    const s = { n: 0 };
    for (let i = 0; i < 150; i++) h.track(s, () => { s.n++; });
    expect(h.size).toBe(100);
    let cur = s;
    for (let i = 0; i < 100; i++) cur = h.undo(cur)!;
    expect(cur.n).toBe(50);
    expect(h.undo(cur)).toBeNull();
  });
});
