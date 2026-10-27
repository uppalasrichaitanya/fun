import type { AudioBus, Drone } from '../../engine/audio';

/** Bid War sound set, all synthesised on the shared bus. */
export class BidSfx {
  private murmur: Drone | null = null;
  private murmurLevel = 0;
  private rollT = 0;

  constructor(private a: AudioBus) {}

  cardIn(star: boolean): void {
    this.a.whoosh(0.16, 0.3);
    if (star) this.brass();
  }
  brass(): void {
    for (const f of [98, 147, 196]) this.a.tone({ f, type: 'sawtooth', a: 0.02, d: 0.7, g: 0.07, lp: 1100 });
    this.a.tone({ f: 49, type: 'sine', a: 0.01, d: 0.8, g: 0.2 });
  }
  /** Pitch climbs with each bid on the same lot. */
  coin(n: number): void {
    const f = 1900 * Math.pow(2, Math.min(n, 14) / 24);
    this.a.tone({ f, type: 'triangle', a: 0.001, d: 0.12, g: 0.12, vary: 0.02 });
    this.a.tone({ f: f * 2.71, type: 'sine', a: 0.001, d: 0.2, g: 0.05 });
    this.a.tone({ f: f * 1.5, type: 'sine', a: 0.001, d: 0.08, g: 0.05, at: 0.05 });
  }
  gavelTap(): void {
    this.a.tone({ f: 900, f2: 420, type: 'triangle', a: 0.001, d: 0.06, g: 0.2 });
    this.a.noise({ d: 0.04, g: 0.12, f: 1800, q: 2 });
  }
  gavelBang(): void {
    this.a.tone({ f: 200, f2: 55, type: 'sine', a: 0.001, d: 0.3, g: 0.45 });
    this.a.noise({ d: 0.12, g: 0.3, f: 900, q: 0.8 });
    this.a.tone({ f: 640, f2: 300, type: 'triangle', a: 0.001, d: 0.08, g: 0.15 });
  }
  /** Crowd "ooh", bigger for bigger price/base. */
  ooh(intensity: number): void {
    const g = Math.min(0.22, 0.05 + intensity * 0.05);
    this.a.noise({ d: 0.9, a: 0.15, g, f: 420, f2: 700, q: 5 });
    this.a.noise({ d: 0.9, a: 0.15, g: g * 0.6, f: 900, f2: 1300, q: 6 });
  }
  whistle(): void {
    this.a.tone({ f: 1300, f2: 2500, type: 'sine', a: 0.01, d: 0.16, g: 0.12 });
    this.a.tone({ f: 2500, f2: 1500, type: 'sine', a: 0.01, d: 0.22, g: 0.12, at: 0.2 });
  }
  mutedThud(): void {
    this.a.tone({ f: 120, f2: 50, type: 'sine', a: 0.002, d: 0.2, g: 0.25 });
    this.a.noise({ d: 0.08, g: 0.06, f: 300, type: 'lowpass' });
  }
  /** Call every frame while ALL-IN is held; `k` is 0..1 hold progress. */
  drumRoll(dt: number, k: number): void {
    this.rollT -= dt;
    if (this.rollT > 0) return;
    this.rollT = 0.055 - k * 0.025;
    this.a.noise({ d: 0.05, g: 0.05 + k * 0.12, f: 1400 + k * 600, q: 0.9 });
  }
  bigDrum(): void {
    this.a.tone({ f: 90, f2: 38, type: 'sine', a: 0.002, d: 0.7, g: 0.55 });
    this.a.noise({ d: 0.35, g: 0.25, f: 500, type: 'lowpass' });
    // Gasp.
    this.a.noise({ d: 0.35, a: 0.06, g: 0.12, f: 1600, f2: 3200, q: 1.5, at: 0.08 });
  }
  scratch(): void {
    this.a.noise({ d: 0.28, g: 0.22, f: 3200, f2: 260, q: 3 });
    this.a.tone({ f: 900, f2: 140, type: 'sawtooth', a: 0.005, d: 0.25, g: 0.07, lp: 2000 });
  }
  chains(): void {
    for (let i = 0; i < 9; i++) {
      this.a.tone({ f: 2400 + Math.random() * 2200, type: 'triangle', a: 0.001, d: 0.05 + Math.random() * 0.08, g: 0.05, at: i * 0.035 + Math.random() * 0.02 });
    }
    this.a.noise({ d: 0.3, g: 0.06, f: 4000, type: 'highpass' });
  }
  reject(): void { this.a.tone({ f: 220, f2: 180, type: 'square', a: 0.002, d: 0.07, g: 0.05, lp: 1200 }); }
  undo(): void { this.a.tone({ f: 500, f2: 1200, type: 'triangle', a: 0.01, d: 0.25, g: 0.1 }); }
  stamp(): void { this.a.thud(0.8); }
  tick(): void { this.a.tick(2200, 0.035); }
  ui(): void { this.a.ui(); }
  fanfare(): void { this.a.fanfare(); }

  /** Crowd murmur that grows with each bid of a bidding war. 0 = silent. */
  setMurmur(level: number): void {
    if (level <= 0) {
      // Dropped (not kept silent) so the next war gets a fresh drone even if audio unlocked since.
      this.murmur?.stop();
      this.murmur = null;
      this.murmurLevel = 0;
      return;
    }
    if (!this.murmur) this.murmur = this.a.drone('noise', 380);
    this.murmurLevel = level;
    this.murmur.set(380 + level * 40, Math.min(0.09, 0.015 + level * 0.012), 0.3);
  }
  get murmuring(): number { return this.murmurLevel; }

  stop(): void { this.murmur?.stop(); this.murmur = null; }
}
