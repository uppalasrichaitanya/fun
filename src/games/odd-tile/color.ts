// OKLCH -> sRGB with gamut checking. Perceptually even steps for the odd tile.

export interface Rgb { r: number; g: number; b: number }

export function oklabToLinear(L: number, a: number, b: number, out: Rgb): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  out.r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out.g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out.b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return out;
}

const gamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const EPS = 1e-4;

/** Returns a CSS rgb() string, or null when out of the sRGB gamut. */
export function oklch(L: number, C: number, hDeg: number): string | null {
  const h = (hDeg * Math.PI) / 180;
  const lin = oklabToLinear(L, C * Math.cos(h), C * Math.sin(h), { r: 0, g: 0, b: 0 });
  if (lin.r < -EPS || lin.r > 1 + EPS || lin.g < -EPS || lin.g > 1 + EPS || lin.b < -EPS || lin.b > 1 + EPS) return null;
  const to = (c: number) => Math.round(Math.min(1, Math.max(0, gamma(c))) * 255);
  return `rgb(${to(lin.r)},${to(lin.g)},${to(lin.b)})`;
}

/** Euclidean distance in OKLab between two LCH colours. */
export function deltaE(L1: number, C1: number, h1: number, L2: number, C2: number, h2: number): number {
  const r1 = (h1 * Math.PI) / 180, r2 = (h2 * Math.PI) / 180;
  const da = C1 * Math.cos(r1) - C2 * Math.cos(r2), db = C1 * Math.sin(r1) - C2 * Math.sin(r2);
  return Math.hypot(L1 - L2, da, db);
}
