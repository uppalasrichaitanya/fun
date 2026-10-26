import { settings } from './settings';

// Every sound is synthesised. Zero audio files.

const PENT = [0, 2, 4, 7, 9];
/** Major pentatonic step -> frequency. Step 0 = base, step 5 = one octave up. */
export function pent(step: number, base = 523.25): number {
  const oct = Math.floor(step / 5);
  const i = ((step % 5) + 5) % 5;
  return base * Math.pow(2, (oct * 12 + PENT[i]) / 12);
}
export const midiHz = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

export interface ToneOpts {
  f: number;              // start frequency
  f2?: number;            // end frequency (exponential glide)
  type?: OscillatorType;
  a?: number;             // attack s
  d?: number;             // decay s
  g?: number;             // peak gain
  at?: number;            // delay from now, s
  vary?: number;          // random pitch variation (0.06 = +/-6%)
  lp?: number;            // lowpass cutoff Hz
  out?: 'sfx' | 'music';
}
export interface NoiseOpts {
  d: number; g?: number; a?: number; at?: number;
  f?: number; f2?: number; q?: number; type?: BiquadFilterType; out?: 'sfx' | 'music';
}
export interface MusicSpec {
  bpm: number;
  root: number;                 // MIDI note of the key
  chords: number[][];           // semitone offsets from root, one chord per bar
  arp?: number[];               // indices into the chord (spread over 2 octaves), one per 8th note
  wave?: OscillatorType;
  gain?: number;
  bass?: boolean;
  pad?: boolean;
  kick?: boolean;
  hats?: boolean;
}

export interface Drone { set(freq: number, gain: number, glide?: number): void; stop(): void }

class Engine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private duckNode!: GainNode;
  private noiseBuf!: AudioBuffer;
  private music: MusicSpec | null = null;
  private musicStep = 0;
  private nextNote = 0;
  private rate = 1;
  private timer = 0;
  private beats = [0, 0, 0, 0];
  private beatIdx = 0;

  constructor() {
    const unlock = () => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend().catch(() => {});
      else void this.ctx.resume().catch(() => {});
    });
    settings.on(() => this.apply());
  }

  get running(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        const c = new AC();
        this.ctx = c;
        this.master = c.createGain();
        this.sfx = c.createGain();
        this.musicBus = c.createGain();
        this.duckNode = c.createGain();
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -12; comp.ratio.value = 4;
        this.sfx.connect(this.master);
        this.musicBus.connect(this.duckNode).connect(this.master);
        this.master.connect(comp).connect(c.destination);
        this.noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
        const ch = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        // iOS needs a buffer played inside the gesture to unlock output.
        const s = c.createBufferSource(); s.buffer = c.createBuffer(1, 1, 22050); s.connect(c.destination); s.start(0);
        this.apply();
      }
      if (this.ctx.state !== 'running' && !document.hidden) void this.ctx.resume().catch(() => {});
    } catch { /* no audio available */ }
  }

  private apply(): void {
    if (!this.ctx) return;
    const s = settings.data, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.volume, t, 0.02);
    this.sfx.gain.setTargetAtTime(s.sfx ? 1 : 0, t, 0.02);
    this.musicBus.gain.setTargetAtTime(s.music ? 0.55 : 0, t, 0.05);
  }

  private dest(out?: 'sfx' | 'music'): AudioNode { return out === 'music' ? this.musicBus : this.sfx; }

  tone(o: ToneOpts): void {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime + (o.at ?? 0);
    const k = o.vary ? 1 + (Math.random() * 2 - 1) * o.vary : 1;
    const a = o.a ?? 0.005, d = o.d ?? 0.2, g = o.g ?? 0.25;
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f * k, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2 * k), t + a + d);
    const gn = c.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(g, t + a);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    let node: AudioNode = osc;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node.connect(f); node = f; }
    node.connect(gn).connect(this.dest(o.out));
    osc.start(t);
    osc.stop(t + a + d + 0.05);
  }

  noise(o: NoiseOpts): void {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime + (o.at ?? 0);
    const a = o.a ?? 0.003, g = o.g ?? 0.2;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = c.createBiquadFilter();
    filt.type = o.type ?? 'bandpass';
    filt.frequency.setValueAtTime(o.f ?? 1200, t);
    if (o.f2) filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + a + o.d);
    filt.Q.value = o.q ?? 1;
    const gn = c.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(g, t + a);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + a + o.d);
    src.connect(filt).connect(gn).connect(this.dest(o.out));
    const off = Math.random() * 0.5;
    src.start(t, off);
    src.stop(t + a + o.d + 0.05);
  }

  drone(type: OscillatorType | 'noise', freq: number): Drone {
    const c = this.ctx;
    const dead: Drone = { set() {}, stop() {} };
    if (!c || c.state !== 'running') return dead;
    const gn = c.createGain();
    gn.gain.value = 0;
    let src: AudioScheduledSourceNode;
    let param: AudioParam;
    if (type === 'noise') {
      const b = c.createBufferSource(); b.buffer = this.noiseBuf; b.loop = true;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
      b.connect(f).connect(gn);
      src = b; param = f.frequency;
    } else {
      const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2400;
      o.connect(f).connect(gn);
      src = o; param = o.frequency;
    }
    gn.connect(this.sfx);
    src.start();
    let stopped = false;
    return {
      set: (f, g, glide = 0.04) => {
        if (stopped) return;
        const t = c.currentTime;
        param.setTargetAtTime(f, t, glide);
        gn.gain.setTargetAtTime(g, t, glide);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = c.currentTime;
        gn.gain.setTargetAtTime(0, t, 0.05);
        try { src.stop(t + 0.3); } catch { /* already stopped */ }
      },
    };
  }

  // ---- music -------------------------------------------------------------

  playMusic(spec: MusicSpec): void {
    if (this.music === spec) return;
    this.music = spec;
    this.musicStep = 0;
    this.rate = 1;
    this.nextNote = this.ctx ? this.ctx.currentTime + 0.1 : 0;
    if (!this.timer) this.timer = window.setInterval(() => this.schedule(), 50);
  }

  stopMusic(): void {
    this.music = null;
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  setMusicRate(r: number): void { this.rate = r; }

  duck(on: boolean): void {
    if (!this.ctx) return;
    this.duckNode.gain.setTargetAtTime(on ? 0.5 : 1, this.ctx.currentTime, 0.15);
  }

  /** 0..1 position inside the current beat (for visual pulses). */
  beatPhase(): number {
    const c = this.ctx;
    if (!c || !this.music) return 0;
    const now = c.currentTime;
    const beat = 60 / (this.music.bpm * this.rate);
    let last = -1;
    for (const b of this.beats) if (b <= now && b > last) last = b;
    if (last < 0) return 0;
    return Math.min(1, (now - last) / beat);
  }

  private schedule(): void {
    const c = this.ctx, m = this.music;
    if (!c || !m || c.state !== 'running') return;
    if (this.nextNote < c.currentTime - 0.2) this.nextNote = c.currentTime + 0.05;
    const eighth = 30 / (m.bpm * this.rate);
    while (this.nextNote < c.currentTime + 0.2) {
      this.playStep(m, this.musicStep, this.nextNote - c.currentTime, eighth);
      this.musicStep++;
      this.nextNote += eighth;
    }
  }

  private playStep(m: MusicSpec, step: number, at: number, eighth: number): void {
    const bar = Math.floor(step / 8) % m.chords.length;
    const chord = m.chords[bar];
    const pos = step % 8;
    const g = m.gain ?? 1;
    if (pos % 2 === 0) { this.beats[this.beatIdx] = (this.ctx!.currentTime + at); this.beatIdx = (this.beatIdx + 1) % 4; }
    const arp = m.arp ?? [0, 1, 2, 3, 2, 1, 0, 2];
    const idx = arp[step % arp.length];
    const tones = chord.length;
    const note = m.root + 12 + chord[idx % tones] + 12 * Math.floor(idx / tones);
    this.tone({ f: midiHz(note), type: m.wave ?? 'triangle', a: 0.01, d: eighth * 1.8, g: 0.05 * g, at, lp: 2600, out: 'music' });
    if (m.bass && (pos === 0 || pos === 4)) {
      this.tone({ f: midiHz(m.root - 12 + chord[0]), type: 'sine', a: 0.01, d: eighth * 3.5, g: 0.13 * g, at, out: 'music' });
    }
    if (m.pad && pos === 0) {
      for (const n of chord) this.tone({ f: midiHz(m.root + n), type: 'sine', a: eighth * 2, d: eighth * 7, g: 0.025 * g, at, out: 'music' });
    }
    if (m.kick && (pos === 0 || pos === 4)) {
      this.tone({ f: 130, f2: 45, type: 'sine', a: 0.002, d: 0.18, g: 0.22 * g, at, out: 'music' });
    }
    if (m.hats && pos % 2 === 1) {
      this.noise({ d: 0.04, g: 0.035 * g, f: 8000, type: 'highpass', at, out: 'music' });
    }
  }
}

export const engine = new Engine();

/**
 * Per-host audio facade. Hub previews get a silent bus; the shell mutes SFX
 * while a game runs its attract demo behind the start screen.
 */
export class AudioBus {
  sfxOn = true;
  constructor(readonly enabled: boolean) {}

  private get ok(): boolean { return this.enabled && this.sfxOn && engine.running; }

  tone(o: ToneOpts): void { if (this.ok) engine.tone(o); }
  noise(o: NoiseOpts): void { if (this.ok) engine.noise(o); }
  drone(type: OscillatorType | 'noise', freq: number): Drone {
    return this.ok ? engine.drone(type, freq) : { set() {}, stop() {} };
  }

  // ---- presets -------------------------------------------------------------
  pluck(f: number, g = 0.22, vary = 0.06): void {
    this.tone({ f, type: 'triangle', a: 0.003, d: 0.28, g, vary });
    this.tone({ f: f * 2, type: 'sine', a: 0.003, d: 0.12, g: g * 0.3, vary });
  }
  pop(f = 600, g = 0.25): void {
    this.tone({ f: f * 0.6, f2: f * 1.6, type: 'sine', a: 0.002, d: 0.09, g, vary: 0.06 });
  }
  thud(vol = 1): void {
    this.tone({ f: 160, f2: 60, type: 'sine', a: 0.002, d: 0.14, g: 0.35 * vol, vary: 0.06 });
    this.noise({ d: 0.06, g: 0.12 * vol, f: 400, type: 'lowpass' });
  }
  chime(step: number, g = 0.2): void {
    const f = pent(step, 523.25);
    this.tone({ f, type: 'sine', a: 0.004, d: 0.6, g });
    this.tone({ f: f * 2, type: 'sine', a: 0.004, d: 0.35, g: g * 0.35 });
    this.tone({ f: f * 3, type: 'triangle', a: 0.004, d: 0.18, g: g * 0.12 });
  }
  buzz(): void {
    this.tone({ f: 110, type: 'sawtooth', a: 0.005, d: 0.22, g: 0.12, lp: 900, vary: 0.04 });
    this.tone({ f: 116, type: 'square', a: 0.005, d: 0.2, g: 0.06, lp: 700 });
  }
  tick(f = 1800, g = 0.08): void {
    this.tone({ f, type: 'square', a: 0.001, d: 0.025, g, lp: 5000, vary: 0.04 });
  }
  whoosh(g = 0.18, d = 0.25): void {
    this.noise({ d, g, f: 600, f2: 2400, q: 1.2, a: 0.03 });
  }
  shatter(): void {
    this.noise({ d: 0.5, g: 0.3, f: 5000, f2: 1500, type: 'bandpass', q: 0.7 });
    for (let i = 0; i < 6; i++) this.tone({ f: 1800 + Math.random() * 3000, type: 'triangle', a: 0.001, d: 0.08 + Math.random() * 0.2, g: 0.05, at: Math.random() * 0.12 });
    this.tone({ f: 220, f2: 55, type: 'sine', a: 0.002, d: 0.35, g: 0.3 });
  }
  heartbeat(g = 0.3): void {
    this.tone({ f: 70, f2: 45, type: 'sine', a: 0.005, d: 0.12, g });
    this.tone({ f: 62, f2: 40, type: 'sine', a: 0.005, d: 0.14, g: g * 0.7, at: 0.16 });
  }
  sparkle(base = 1046.5): void {
    for (let i = 0; i < 5; i++) this.tone({ f: pent(i * 2, base), type: 'sine', a: 0.002, d: 0.18, g: 0.06, at: i * 0.04 });
  }
  fanfare(): void {
    const seq = [0, 2, 4, 7, 10];
    seq.forEach((s, i) => this.tone({ f: pent(s, 392), type: 'triangle', a: 0.01, d: i === seq.length - 1 ? 0.8 : 0.18, g: 0.16, at: i * 0.09 }));
  }
  ui(): void { this.tone({ f: 880, f2: 1320, type: 'sine', a: 0.002, d: 0.06, g: 0.08 }); }

  // ---- music -----------------------------------------------------------------
  music(spec: MusicSpec): void { if (this.enabled) engine.playMusic(spec); }
  stopMusic(): void { if (this.enabled) engine.stopMusic(); }
  musicRate(r: number): void { if (this.enabled) engine.setMusicRate(r); }
  duck(on: boolean): void { if (this.enabled) engine.duck(on); }
  beatPhase(): number { return this.enabled ? engine.beatPhase() : 0; }
}
