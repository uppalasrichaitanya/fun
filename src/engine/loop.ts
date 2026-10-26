export const STEP = 1 / 120;
const MAX_FRAME = 0.1;      // clamp frame delta so a backgrounded tab never explodes the sim
const MAX_STEPS = 24;

/**
 * Fixed-timestep accumulator. The owner calls advance() once per animation frame;
 * this keeps a single rAF possible for many hosts (hub previews).
 */
export class Loop {
  private acc = 0;
  private last = -1;
  private sinceDraw = 0;
  fps = 0;
  private fpsAcc = 0; private fpsFrames = 0;
  /** Minimum seconds between draws (0 = every frame). */
  minFrame = 0;

  constructor(
    private step: (dt: number) => void,
    private draw: (alpha: number) => void,
    private scale: (realDt: number) => number,
    private real: (realDt: number) => void,
  ) {}

  /** Returns true if a frame was drawn. */
  advance(now: number, simulate: boolean): boolean {
    if (this.last < 0) this.last = now;
    let d = (now - this.last) / 1000;
    this.last = now;
    if (d < 0) d = 0;
    if (d > MAX_FRAME) d = MAX_FRAME;
    this.sinceDraw += d;
    // Throttled hosts (hub previews) skip whole frames and catch up on the next draw.
    if (this.minFrame > 0 && this.sinceDraw + 0.004 < this.minFrame) return false;
    const realDt = this.sinceDraw;
    this.sinceDraw = 0;
    this.real(realDt);
    if (simulate) {
      this.acc += realDt * this.scale(realDt);
      let n = 0;
      while (this.acc >= STEP && n < MAX_STEPS) { this.step(STEP); this.acc -= STEP; n++; }
      if (n === MAX_STEPS) this.acc = 0;
    }
    this.draw(simulate ? this.acc / STEP : 1);
    this.fpsAcc += realDt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }
    return true;
  }

  /** Forget the last timestamp, e.g. after a pause, so no time is "owed". */
  resetClock(): void { this.last = -1; this.acc = 0; this.sinceDraw = 0; }
}
