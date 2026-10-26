// Every read/write is guarded: the site must work with storage blocked (private mode, sandboxed iframes).
const PREFIX = 'pa:';

function ls(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = ls()?.getItem(PREFIX + key);
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { ls()?.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* quota or blocked */ }
  },
  remove(key: string): void {
    try { ls()?.removeItem(PREFIX + key); } catch { /* blocked */ }
  },
  clearAll(): void {
    try {
      const s = ls();
      if (!s) return;
      const doomed: string[] = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX)) doomed.push(k); }
      for (const k of doomed) s.removeItem(k);
    } catch { /* blocked */ }
  },
};
export type Storage_ = typeof storage;
