import { describe, expect, it } from 'vitest';
import { Rng } from '../../engine/rng';
import { History } from '../../engine/editor/history';
import { buildNet, check, codeLines, currentAsts, evaluate, makesLoop, parse, ParseError, type Net, type WILevel } from './logic';

const lv = (spec: Record<string, string>, inputs = ['a', 'b'], outputs = Object.keys(spec)): WILevel =>
  ({ name: 't', inputs, outputs, spec, solution: spec, parts: ['BOTH', 'EITHER', 'FLIP', 'ONLYONE', 'HALFADD'], goal: '' });
const board = { w: 16, h: 6, inputs: ['a', 'b', 'c'] };

describe('Wire It expressions', () => {
  it('parses friendly and real names in any case', () => {
    for (const s of ['BOTH(a, FLIP(b))', 'and(a,not(b))', 'Both ( a , Flip(b) )']) {
      const net = buildNet({ bulb: parse(s, ['a', 'b']) }, board);
      expect(check(lv({ bulb: 'AND(a,NOT(b))' }), net).every(Boolean)).toBe(true);
    }
    expect(() => parse('ONLY ONE(a, b)', ['a', 'b'])).not.toThrow();
  });

  it('gives friendly messages for mistakes', () => {
    const msg = (s: string, allowed?: string[]) => { try { parse(s, ['a', 'b'], allowed); return ''; } catch (e) { expect(e).toBeInstanceOf(ParseError); return (e as Error).message; } };
    expect(msg('BOTHH(a,b)')).toMatch(/don't know a part/);
    expect(msg('BOTH(a)')).toMatch(/needs 2 inputs/);
    expect(msg('BOTH(a, b')).toMatch(/Missing "\)"/);
    expect(msg('BOTH(a, d)')).toMatch(/no switch called "d"/);
    expect(msg('FLIP(a)', ['BOTH'])).toMatch(/isn't in your parts box/);
    expect(msg('BOTH(a,b) c')).toMatch(/Extra text/);
  });

  it('code view and board always match, both ways', () => {
    const rng = new Rng(3);
    const parts = ['BOTH', 'EITHER', 'FLIP', 'ONLYONE'];
    const rand = (d: number): string => {
      if (d > 3 || rng.chance(0.3)) return rng.pick(['a', 'b', 'c']);
      const p = rng.pick(parts);
      return p === 'FLIP' ? `FLIP(${rand(d + 1)})` : `${p}(${rand(d + 1)}, ${rand(d + 1)})`;
    };
    for (let k = 0; k < 200; k++) {
      const e = rand(0);
      const l = lv({ bulb: e.replace(/ONLYONE/g, 'XOR') }, ['a', 'b', 'c']);
      const net = buildNet({ bulb: parse(e, l.inputs) }, board);
      expect(check(l, net).every(Boolean)).toBe(true);
      // Code line -> parse -> rebuild gives the same behaviour.
      const again = buildNet(currentAsts(l, net), board);
      expect(check(l, again).every(Boolean)).toBe(true);
      expect(codeLines(l, again).map((t) => t.map((x) => x.text).join('')).join()).toBe(codeLines(l, net).map((t) => t.map((x) => x.text).join('')).join());
    }
  });

  it('shares identical parts and multi-output chips', () => {
    const net = buildNet({ sum: parse('HALFADD(a,b).sum', ['a', 'b']), carry: parse('HALFADD(a,b).carry', ['a', 'b']) }, board);
    expect(net.gates.length).toBe(1);
    expect(evaluate(net, { a: 1, b: 1 }, ['sum', 'carry']).out).toEqual({ sum: 0, carry: 1 });
  });

  it('refuses wires that would make a loop', () => {
    const net: Net = { gates: [{ id: 'g1', type: 'BOTH', x: 3, y: 1 }, { id: 'g2', type: 'FLIP', x: 6, y: 1 }], wires: [['g1', 'g2.0']] };
    expect(makesLoop(net, 'g2', 'g1.0')).toBe(true);
    expect(makesLoop(net, 'g1', 'g1.1')).toBe(true);
    expect(makesLoop(net, 'a', 'g1.0')).toBe(false);
  });

  it('undo never corrupts a circuit (500 random edits)', () => {
    const rng = new Rng(9);
    const h = new History<Net>();
    let net: Net = { gates: [], wires: [] };
    let n = 0;
    for (let i = 0; i < 500; i++) {
      const r = rng.next();
      if (r < 0.25) h.track(net, () => { net.gates.push({ id: `g${++n}`, type: rng.pick(['BOTH', 'FLIP']), x: rng.int(2, 12), y: rng.int(0, 4) }); });
      else if (r < 0.5 && net.gates.length) {
        const g = rng.pick(net.gates), src = rng.chance(0.5) ? rng.pick(['a', 'b']) : rng.pick(net.gates).id;
        const dst = `${g.id}.${g.type === 'FLIP' ? 0 : rng.int(0, 1)}`;
        if (!makesLoop(net, src, dst)) h.track(net, () => { net.wires = net.wires.filter((w) => w[1] !== dst); net.wires.push([src, dst]); });
      } else if (r < 0.62 && net.gates.length) {
        const g = rng.pick(net.gates);
        h.track(net, () => { net.gates = net.gates.filter((x) => x !== g); net.wires = net.wires.filter(([s, d]) => s.split('.')[0] !== g.id && d.split('.')[0] !== g.id); });
      } else if (r < 0.85) { const u = h.undo(net); if (u) net = u; }
      else { const u = h.redo(net); if (u) net = u; }
      // Invariants: every wire ends on existing parts, one wire per input pin, no loops.
      const ids = new Set(net.gates.map((g) => g.id));
      for (const [s, d] of net.wires) {
        expect(['a', 'b'].includes(s) || ids.has(s.split('.')[0])).toBe(true);
        expect(ids.has(d.split('.')[0])).toBe(true);
      }
      expect(new Set(net.wires.map((w) => w[1])).size).toBe(net.wires.length);
      expect(() => evaluate(net, { a: 1, b: 0 }, [])).not.toThrow();
    }
  });
});
