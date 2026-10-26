import type { Rng } from '../../engine/rng';
import { deltaE, oklch } from './color';
import { gridFor } from './config';

export type Channel = 'L' | 'C' | 'H';

export interface Round {
  n: number;           // grid is n x n
  odd: number;         // index of the odd tile
  base: string;        // CSS colour
  oddColor: string;
  hue: number;         // base hue, for the background tint
  channel: Channel;
  delta: number;
}

/** Difference size in OKLCH lightness for a round (1-based). */
export const deltaFor = (round: number): number => Math.max(0.012, 0.18 * Math.pow(0.9, round - 1));

export function makeRound(round: number, rng: Rng, colorblind: boolean): Round {
  const n = gridFor(round);
  const delta = deltaFor(round);
  const channels: Channel[] = ['L', 'C', 'H'];
  const channel: Channel = colorblind || round < 16 ? 'L' : channels[(round - 16) % 3];
  for (let attempt = 0; attempt < 200; attempt++) {
    const H = rng.range(0, 360), C = rng.range(0.1, 0.17), L = rng.range(0.55, 0.78);
    const base = oklch(L, C, H);
    if (!base) continue;
    let sign = rng.sign();
    for (let flip = 0; flip < 2; flip++, sign = -sign) {
      let L2 = L, C2 = C, H2 = H;
      if (channel === 'L') L2 = L + sign * delta;
      else if (channel === 'C') C2 = C + sign * delta * 1.4;
      else {
        // Spec: delta x 220 degrees. At low chroma that can be imperceptible, so never
        // let the perceptual (OKLab) distance fall below the lightness delta.
        const minDeg = ((delta / C) * 180) / Math.PI;
        H2 = H + sign * Math.max(delta * 220, minDeg);
      }
      if (C2 < 0.02) continue;
      const odd = oklch(L2, C2, H2);
      if (!odd || odd === base) continue;
      if (deltaE(L, C, H, L2, C2, H2) < delta * 0.95) continue;
      return { n, odd: rng.int(0, n * n - 1), base, oddColor: odd, hue: H, channel, delta };
    }
  }
  // Practically unreachable; a safe fallback that is always in gamut.
  return { n, odd: rng.int(0, n * n - 1), base: oklch(0.65, 0.1, 250)!, oddColor: oklch(0.65 + delta, 0.1, 250)!, hue: 250, channel: 'L', delta };
}
