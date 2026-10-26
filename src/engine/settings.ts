import { storage } from './storage';

export interface SettingsData {
  volume: number;        // 0..1 master
  sfx: boolean;
  music: boolean;
  reducedMotion: boolean;
  colorblind: boolean;   // Odd Tile Out: lightness-only differences
}

const prefersReduced = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

const DEFAULTS = (): SettingsData => ({
  volume: 0.8, sfx: true, music: true, reducedMotion: prefersReduced(), colorblind: false,
});

type Listener = (s: SettingsData) => void;

class Settings {
  data: SettingsData;
  private listeners = new Set<Listener>();
  constructor() {
    this.data = { ...DEFAULTS(), ...storage.get<Partial<SettingsData>>('settings', {}) };
  }
  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
    storage.set('settings', this.data);
    for (const l of this.listeners) l(this.data);
  }
  reset(): void {
    this.data = DEFAULTS();
    for (const l of this.listeners) l(this.data);
  }
  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Multiplier for screen shake (reduced motion keeps 25%). */
  get shakeScale(): number { return this.data.reducedMotion ? 0.25 : 1; }
  get motion(): boolean { return !this.data.reducedMotion; }
}

export const settings = new Settings();
export type { Settings };
