import type { Schema } from '../../engine/levels/schema';

// Wire It: gates, chips, netlists, the expression language (used by the code view,
// Type mode, level specs and stored solutions) and truth tables. Pure.

export interface PartDef {
  /** Name shown big on the part (and used in code). */
  name: string;
  /** Real name, small underneath. */
  real: string;
  rule: string;
  ins: string[];
  outs: string[];
  color: string;
  fn(v: number[]): number[];
}

export const PARTS: Record<string, PartDef> = {
  BOTH: { name: 'BOTH', real: 'AND', rule: 'ON only when both inputs are ON', ins: ['a', 'b'], outs: ['out'], color: '#4ADE80', fn: ([a, b]) => [a & b] },
  EITHER: { name: 'EITHER', real: 'OR', rule: 'ON when at least one input is ON', ins: ['a', 'b'], outs: ['out'], color: '#38E1F5', fn: ([a, b]) => [a | b] },
  FLIP: { name: 'FLIP', real: 'NOT', rule: 'Turns ON into OFF and OFF into ON', ins: ['a'], outs: ['out'], color: '#FF9F43', fn: ([a]) => [a ^ 1] },
  ONLYONE: { name: 'ONLY ONE', real: 'XOR', rule: 'ON when exactly one input is ON', ins: ['a', 'b'], outs: ['out'], color: '#9B7BFF', fn: ([a, b]) => [a ^ b] },
  HALFADD: { name: 'HALF ADD', real: 'half adder', rule: 'Adds two bits: sum and carry', ins: ['a', 'b'], outs: ['sum', 'carry'], color: '#FFD93D', fn: ([a, b]) => [a ^ b, a & b] },
  FULLADD: { name: 'FULL ADD', real: 'full adder', rule: 'Adds three bits: sum and carry out', ins: ['a', 'b', 'cin'], outs: ['sum', 'cout'], color: '#FF4F8B', fn: ([a, b, c]) => [a ^ b ^ c, (a & b) | (c & (a ^ b))] },
  SELECT: { name: 'SELECT', real: 'multiplexer', rule: 'Passes a when s is OFF, b when s is ON', ins: ['a', 'b', 's'], outs: ['out'], color: '#4F8BFF', fn: ([a, b, s]) => [s ? b : a] },
};
/** Parts that are built by the player (from a level) before they appear in the palette. */
export const MADE_BY: Record<string, string> = { ONLYONE: 'ONLYONE', HALFADD: 'HALFADD', FULLADD: 'FULLADD', SELECT: 'SELECT' };

const ALIASES: Record<string, string> = {
  BOTH: 'BOTH', AND: 'BOTH', EITHER: 'EITHER', OR: 'EITHER', FLIP: 'FLIP', NOT: 'FLIP',
  ONLYONE: 'ONLYONE', XOR: 'ONLYONE', HALFADD: 'HALFADD', HALFADDER: 'HALFADD', FULLADD: 'FULLADD', FULLADDER: 'FULLADD',
  SELECT: 'SELECT', MUX: 'SELECT', SELECTOR: 'SELECT',
  // Spec-only shorthands (never in a palette).
  NEITHER: 'NEITHER', NOR: 'NEITHER', NOTBOTH: 'NOTBOTH', NAND: 'NOTBOTH', SAME: 'SAME', XNOR: 'SAME',
};
const SPEC_ONLY: Record<string, (v: number[]) => number> = {
  NEITHER: ([a, b]) => (a | b) ^ 1, NOTBOTH: ([a, b]) => (a & b) ^ 1, SAME: ([a, b]) => (a ^ b) ^ 1,
};

// ---- levels -------------------------------------------------------------------

export interface WILevel {
  name: string;
  /** Switch names, top to bottom. */
  inputs: string[];
  /** Bulb names, top to bottom. */
  outputs: string[];
  /** What each bulb should do, as an expression (may use shorthands like XOR). */
  spec: Record<string, string>;
  /** One known solution, as expressions (shared parts are merged). */
  solution: Record<string, string>;
  /** Parts in the palette for this level. */
  parts: string[];
  /** Part this level turns into a chip / gate for later levels. */
  makes?: string;
  /** New idea introduced here (shows the 1-screen intro). */
  intro?: string;
  /** Show numbers: groups of switch / bulb names, least significant first. */
  numbers?: { label: string; bits: string[] }[];
  /** Plain-words goal under the title. */
  goal: string;
}

export const LEVEL_SCHEMA: Schema = {
  obj: {
    name: 'string', inputs: { arr: 'string', min: 1, max: 9 }, outputs: { arr: 'string', min: 1, max: 5 },
    spec: { obj: {} }, solution: { obj: {} }, parts: { arr: 'string' }, makes: 'string', intro: 'string', goal: 'string',
    numbers: { arr: { obj: { label: 'string', bits: { arr: 'string' } } } },
  },
  opt: ['makes', 'intro', 'numbers'],
};

// ---- netlists -----------------------------------------------------------------

export interface Gate { id: string; type: string; x: number; y: number }
/** A wire from a source pin to a sink pin. Sources: switch name, "g3" or "g3.sum". Sinks: "g3.0" (input index) or a bulb name. */
export type Wire = [string, string];
export interface Net { gates: Gate[]; wires: Wire[] }

export function partOf(net: Net, id: string): Gate | undefined { return net.gates.find((g) => g.id === id); }

/** Split a source ref into gate id and output index (-1 = a switch). */
export function srcRef(net: Net, src: string): { gate: Gate | null; out: number } {
  const [id, port] = src.split('.');
  const g = partOf(net, id);
  if (!g) return { gate: null, out: -1 };
  const outs = PARTS[g.type].outs;
  return { gate: g, out: port ? Math.max(0, outs.indexOf(port)) : 0 };
}
export function srcName(g: Gate, out: number): string { return PARTS[g.type].outs.length > 1 ? `${g.id}.${PARTS[g.type].outs[out]}` : g.id; }
export function sinkRef(net: Net, dst: string): { gate: Gate | null; pin: number } {
  const [id, port] = dst.split('.');
  const g = partOf(net, id);
  return g ? { gate: g, pin: Number(port) } : { gate: null, pin: -1 };
}

/** Would wiring src -> dst close a loop? */
export function makesLoop(net: Net, src: string, dst: string): boolean {
  const from = srcRef(net, src).gate, to = sinkRef(net, dst).gate;
  if (!from || !to) return false;
  if (from.id === to.id) return true;
  // Can `to` reach `from` by following wires forward?
  const seen = new Set<string>();
  const stack = [to.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const [s, d] of net.wires) if (s.split('.')[0] === id) { const g = sinkRef(net, d).gate; if (g) stack.push(g.id); }
  }
  return false;
}

export interface Eval {
  /** Value of every source pin (switch names and gate outputs). */
  src: Map<string, number>;
  /** Value arriving at each bulb. */
  out: Record<string, number>;
}

/** Evaluate the circuit for one set of switch values. Unwired inputs read OFF. */
export function evaluate(net: Net, inputs: Record<string, number>, outputs: readonly string[]): Eval {
  const src = new Map<string, number>(Object.entries(inputs));
  const feed = new Map<string, string>();
  for (const [s, d] of net.wires) feed.set(d, s);
  const done = new Set<string>();
  const visiting = new Set<string>();
  const run = (g: Gate) => {
    if (done.has(g.id) || visiting.has(g.id)) return;
    visiting.add(g.id);
    const def = PARTS[g.type];
    const vals = def.ins.map((_, i) => read(feed.get(`${g.id}.${i}`)));
    const res = def.fn(vals);
    res.forEach((v, k) => src.set(srcName(g, k), v));
    visiting.delete(g.id);
    done.add(g.id);
  };
  const read = (s: string | undefined): number => {
    if (!s) return 0;
    if (!src.has(s)) { const g = srcRef(net, s).gate; if (g) run(g); }
    return src.get(s) ?? 0;
  };
  for (const g of net.gates) run(g);
  const out: Record<string, number> = {};
  for (const o of outputs) out[o] = read(feed.get(o));
  return { src, out };
}

export const gateCount = (net: Net): number => net.gates.length;
export const wireCount = (net: Net): number => net.wires.length;

// ---- expressions ----------------------------------------------------------------

export type Ast = { k: 'in'; name: string } | { k: 'call'; part: string; args: Ast[]; out?: string } | { k: 'none' };

export class ParseError extends Error {}

/** Parse "BOTH(a, FLIP(b))" (any case, friendly or real names). Errors read like advice. */
export function parse(text: string, inputs: readonly string[], allowed?: readonly string[]): Ast {
  let i = 0;
  const s = text;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const ident = (): string => {
    ws();
    const m = /^[A-Za-z_][A-Za-z0-9_ ]*/.exec(s.slice(i));
    if (!m) return '';
    // Allow "ONLY ONE" style names: take words up to "(" "," ")" or ".".
    let word = m[0];
    const stop = word.search(/\s+(?=[,).])|\s+$/);
    if (stop >= 0) word = word.slice(0, stop);
    i += word.length;
    return word.trim();
  };
  const expr = (): Ast => {
    ws();
    if (s[i] === '?') { i++; return { k: 'none' }; }
    const start = i;
    const name = ident();
    if (!name) throw new ParseError(i >= s.length ? 'The expression stops early. Something is missing at the end.' : `I didn't expect "${s[i]}" here.`);
    ws();
    if (s[i] !== '(') {
      const sw = inputs.find((x) => x.toLowerCase() === name.toLowerCase());
      if (!sw) {
        const key = name.replace(/[\s_]/g, '').toUpperCase();
        if (ALIASES[key]) throw new ParseError(`${name} needs its inputs in brackets, like ${name}(a, b).`);
        throw new ParseError(`There's no switch called "${name}". Switches here: ${inputs.join(', ')}.`);
      }
      return { k: 'in', name: sw };
    }
    const key = name.replace(/[\s_]/g, '').toUpperCase();
    const part = ALIASES[key];
    if (!part) throw new ParseError(`I don't know a part called "${name}". Try ${(allowed ?? ['BOTH', 'EITHER', 'FLIP']).map((p) => PARTS[p]?.name ?? p).join(', ')}.`);
    if (allowed && !allowed.includes(part)) throw new ParseError(`${PARTS[part]?.name ?? name} isn't in your parts box for this level.`);
    i++;
    const args: Ast[] = [];
    ws();
    if (s[i] !== ')') {
      for (;;) {
        args.push(expr());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ')') break;
        throw new ParseError(i >= s.length ? `Missing ")" to close ${PARTS[part]?.name ?? name}(...).` : `Expected "," or ")" after an input of ${PARTS[part]?.name ?? name}.`);
      }
    }
    i++;
    const want = PARTS[part]?.ins.length ?? 2;
    if (args.length !== want) throw new ParseError(`${PARTS[part]?.name ?? name} needs ${want} input${want === 1 ? '' : 's'}, you gave ${args.length}.`);
    const node: Ast = { k: 'call', part, args };
    ws();
    if (s[i] === '.') {
      i++;
      const port = ident().toLowerCase();
      const outs = PARTS[part]?.outs ?? [];
      if (!outs.includes(port)) throw new ParseError(`${PARTS[part]?.name ?? name} has outputs ${outs.join(' and ')}, not "${port}".`);
      node.out = port;
    } else if ((PARTS[part]?.outs.length ?? 1) > 1) {
      throw new ParseError(`${PARTS[part].name} has two outputs. Pick one: ${PARTS[part].name}(...).${PARTS[part].outs[0]}`);
    }
    void start;
    return node;
  };
  const ast = expr();
  ws();
  if (i < s.length) throw new ParseError(`Extra text after the expression: "${s.slice(i).trim()}".`);
  return ast;
}

/** Evaluate an expression directly (level specs). */
export function evalAst(a: Ast, env: Record<string, number>): number {
  if (a.k === 'none') return 0;
  if (a.k === 'in') return env[a.name] ?? 0;
  const v = a.args.map((x) => evalAst(x, env));
  if (SPEC_ONLY[a.part]) return SPEC_ONLY[a.part](v);
  const def = PARTS[a.part];
  const res = def.fn(v);
  return res[a.out ? def.outs.indexOf(a.out) : 0];
}

/**
 * Build a netlist from bulb expressions. Identical sub-expressions become one
 * shared part (so a chip used for both outputs appears once). Parts are laid out
 * in columns by depth.
 */
export function buildNet(exprs: Record<string, Ast>, board: { w: number; h: number; inputs: readonly string[] }): Net {
  const gates: Gate[] = [];
  const wires: Wire[] = [];
  const memo = new Map<string, { id: string; depth: number }>();
  let n = 0;
  const key = (a: Ast): string => a.k === 'in' ? a.name : a.k === 'none' ? '?' : `${a.part}(${a.args.map(key).join(',')})`;
  const node = (a: Ast): { src: string | null; depth: number } => {
    if (a.k === 'none') return { src: null, depth: 0 };
    if (a.k === 'in') return { src: a.name, depth: 0 };
    const k = key(a);
    let m = memo.get(k);
    if (!m) {
      const args = a.args.map(node);
      const id = `g${++n}`;
      const depth = 1 + Math.max(0, ...args.map((x) => x.depth));
      gates.push({ id, type: a.part, x: depth, y: 0 });
      args.forEach((x, i) => { if (x.src) wires.push([x.src, `${id}.${i}`]); });
      m = { id, depth };
      memo.set(k, m);
    }
    const g = gates.find((x) => x.id === m!.id)!;
    return { src: a.out ? srcName(g, PARTS[a.part].outs.indexOf(a.out)) : srcName(g, 0), depth: m.depth };
  };
  for (const [bulb, a] of Object.entries(exprs)) {
    const r = node(a);
    if (r.src) wires.push([r.src, bulb]);
  }
  layout({ gates, wires }, board);
  return { gates, wires };
}

/** Columns by depth, rows spread evenly; part positions are centres in board units. */
export function layout(net: Net, board: { w: number; h: number }): void {
  const depth = new Map(net.gates.map((g) => [g.id, g.x]));
  const maxD = Math.max(1, ...depth.values());
  const cols = new Map<number, Gate[]>();
  for (const g of net.gates) { const d = depth.get(g.id)!; cols.set(d, [...(cols.get(d) ?? []), g]); }
  const x0 = 4, x1 = board.w - 4;
  for (const [d, list] of cols) {
    const x = maxD === 1 ? (x0 + x1) / 2 : x0 + ((d - 1) / (maxD - 1)) * (x1 - x0);
    list.forEach((g, i) => {
      g.x = Math.round(x * 2) / 2;
      g.y = Math.round(((i + 0.5) / list.length) * board.h * 2) / 2;
    });
  }
}

/** Expected bulb values for every switch combination (row r: bit i of r = input i). */
export function truthTable(l: WILevel): { ins: number[]; outs: number[] }[] {
  const specs = l.outputs.map((o) => parse(l.spec[o], l.inputs));
  const rows: { ins: number[]; outs: number[] }[] = [];
  for (let r = 0; r < 1 << l.inputs.length; r++) {
    const env: Record<string, number> = {};
    const ins = l.inputs.map((name, i) => { const v = (r >> (l.inputs.length - 1 - i)) & 1; env[name] = v; return v; });
    rows.push({ ins, outs: specs.map((s) => evalAst(s, env)) });
  }
  return rows;
}

export function envOf(l: WILevel, ins: number[]): Record<string, number> {
  return Object.fromEntries(l.inputs.map((n, i) => [n, ins[i]]));
}

/** Which rows the circuit gets right. */
export function check(l: WILevel, net: Net, rows = truthTable(l)): boolean[] {
  return rows.map((row) => {
    const e = evaluate(net, envOf(l, row.ins), l.outputs);
    return l.outputs.every((o, k) => e.out[o] === row.outs[k]);
  });
}

// ---- code view --------------------------------------------------------------------

export interface Token { text: string; gate?: string }

/** The circuit as one readable line per bulb, with each part's tokens tagged by gate id. */
export function codeLines(l: WILevel, net: Net): Token[][] {
  const feed = new Map<string, string>();
  for (const [s, d] of net.wires) feed.set(d, s);
  const expr = (src: string | undefined, depth: number, out: Token[]) => {
    if (!src) { out.push({ text: '?' }); return; }
    const { gate, out: k } = srcRef(net, src);
    if (!gate) { out.push({ text: src }); return; }
    if (depth > 30) { out.push({ text: '…' }); return; }
    const def = PARTS[gate.type];
    out.push({ text: def.name + '(', gate: gate.id });
    def.ins.forEach((_, i) => {
      if (i) out.push({ text: ', ', gate: gate.id });
      expr(feed.get(`${gate.id}.${i}`), depth + 1, out);
    });
    out.push({ text: ')', gate: gate.id });
    if (def.outs.length > 1) out.push({ text: '.' + def.outs[k], gate: gate.id });
  };
  return l.outputs.map((o) => {
    const line: Token[] = [{ text: `${o} = ` }];
    expr(feed.get(o), 0, line);
    return line;
  });
}

/** Current expressions per bulb (for Type mode: rebuild all bulbs, replacing one). */
export function currentAsts(l: WILevel, net: Net): Record<string, Ast> {
  const out: Record<string, Ast> = {};
  codeLines(l, net).forEach((line, k) => {
    const text = line.slice(1).map((t) => t.text).join('');
    try { out[l.outputs[k]] = parse(text, l.inputs); } catch { out[l.outputs[k]] = { k: 'none' }; }
  });
  return out;
}

export function boardSize(l: WILevel): { w: number; h: number; inputs: readonly string[] } {
  const parts = l.outputs.length * 2;
  return { w: l.inputs.length > 6 ? 20 : 16, h: Math.max(6, Math.max(l.inputs.length, l.outputs.length, parts) * 1.3), inputs: l.inputs };
}

/** Height of a part in board units. */
export function partH(type: string): number {
  const d = PARTS[type];
  return Math.max(1.6, Math.max(d.ins.length, d.outs.length) * 0.8 + 0.4);
}
export const PART_W = 2.6;

/** Stored solution as a netlist. */
export function solutionNet(l: WILevel): Net {
  const asts: Record<string, Ast> = {};
  for (const o of l.outputs) asts[o] = parse(l.solution[o], l.inputs);
  return buildNet(asts, boardSize(l));
}

export function lintLevel(l: WILevel): string[] {
  const e: string[] = [];
  for (const o of l.outputs) {
    if (!l.spec[o]) e.push(`spec missing for ${o}`);
    if (!l.solution[o]) e.push(`solution missing for ${o}`);
    try { parse(l.spec[o] ?? '', l.inputs); } catch (err) { e.push(`spec ${o}: ${(err as Error).message}`); }
    try { parse(l.solution[o] ?? '', l.inputs, l.parts); } catch (err) { e.push(`solution ${o}: ${(err as Error).message}`); }
  }
  for (const p of l.parts) if (!PARTS[p]) e.push(`unknown part ${p}`);
  return e;
}

/** Par = the stored solution's part and wire counts. */
export function par(l: WILevel): { gates: number; wires: number } {
  const n = solutionNet(l);
  return { gates: gateCount(n), wires: wireCount(n) };
}
