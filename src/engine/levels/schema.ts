/**
 * A tiny JSON schema for level files. Enough to catch typos and missing fields
 * in hand-edited or generated levels; errors read like `level 2-4: walls[3][1] should be an int`.
 */
export type Schema =
  | 'number' | 'int' | 'string' | 'boolean' | 'any'
  | { enum: readonly (string | number)[] }
  | { arr: Schema; min?: number; max?: number }
  | { tuple: Schema[] }
  | { obj: Record<string, Schema>; opt?: readonly string[] }
  | { or: Schema[] };

export function validate(v: unknown, s: Schema, path = 'level'): string[] {
  const out: string[] = [];
  check(v, s, path, out);
  return out;
}

function check(v: unknown, s: Schema, path: string, out: string[]): void {
  if (out.length > 20) return;
  if (s === 'any') return;
  if (s === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${path} should be a number`); return; }
  if (s === 'int') { if (!Number.isInteger(v)) out.push(`${path} should be an int`); return; }
  if (s === 'string') { if (typeof v !== 'string') out.push(`${path} should be a string`); return; }
  if (s === 'boolean') { if (typeof v !== 'boolean') out.push(`${path} should be true/false`); return; }
  if ('enum' in s) { if (!s.enum.includes(v as string)) out.push(`${path} should be one of ${s.enum.join(', ')} (got ${JSON.stringify(v)})`); return; }
  if ('or' in s) {
    for (const alt of s.or) if (!validate(v, alt, path).length) return;
    out.push(`${path} matches none of the allowed shapes`);
    return;
  }
  if ('arr' in s) {
    if (!Array.isArray(v)) { out.push(`${path} should be an array`); return; }
    if (s.min !== undefined && v.length < s.min) out.push(`${path} needs at least ${s.min} items`);
    if (s.max !== undefined && v.length > s.max) out.push(`${path} allows at most ${s.max} items`);
    v.forEach((x, i) => check(x, s.arr, `${path}[${i}]`, out));
    return;
  }
  if ('tuple' in s) {
    if (!Array.isArray(v) || v.length !== s.tuple.length) { out.push(`${path} should be [${s.tuple.length} items]`); return; }
    s.tuple.forEach((t, i) => check(v[i], t, `${path}[${i}]`, out));
    return;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) { out.push(`${path} should be an object`); return; }
  const o = v as Record<string, unknown>;
  for (const [k, ks] of Object.entries(s.obj)) {
    if (!(k in o) || o[k] === undefined) { if (!s.opt?.includes(k)) out.push(`${path}.${k} is missing`); continue; }
    check(o[k], ks, `${path}.${k}`, out);
  }
}
