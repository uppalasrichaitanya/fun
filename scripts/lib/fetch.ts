import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** GET JSON from the first host that answers. */
export async function getJson<T>(urls: string[]): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as T;
      last = new Error(`${res.status} ${url}`);
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function getBytes(urls: string[]): Promise<Uint8Array> {
  let last: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      last = new Error(`${res.status} ${url}`);
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

let ffmpeg: boolean | null = null;
function hasFfmpeg(): boolean {
  if (ffmpeg === null) {
    try { execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: 'pipe' }); ffmpeg = true; } catch { ffmpeg = false; }
  }
  return ffmpeg;
}

/**
 * Save an image, shrunk to `width` px and re-encoded as .webp when ffmpeg is
 * available. Returns the extension actually written.
 */
export function saveImage(bytes: Uint8Array, outNoExt: string, srcExt: string, width: number): string {
  mkdirSync(dirname(outNoExt), { recursive: true });
  const raw = `${outNoExt}.src.${srcExt}`;
  writeFileSync(raw, bytes);
  if (hasFfmpeg()) {
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', `scale=${width}:-1`, '-quality', '82', `${outNoExt}.webp`], { stdio: 'pipe' });
      execFileSync('rm', ['-f', raw]);
      return 'webp';
    } catch { /* fall through and keep the original */ }
  }
  execFileSync('mv', [raw, `${outNoExt}.${srcExt}`]);
  return srcExt;
}

export const exists = existsSync;

/** Run `fn` over items with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** One card per line: small diffs, still hand-editable. */
export function writePack(file: string, id: string, cards: unknown[]): void {
  writeFileSync(file, `{"id":${JSON.stringify(id)},"cards":[\n${cards.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
}
