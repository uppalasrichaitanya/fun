import { C, FONT, rgba } from '../engine/theme';
import { toast } from './dom';

export interface CardInfo {
  title: string;
  color: string;
  score: string;
  unit: string;
  line: string;        // e.g. "NEW BEST!" or "Best 42"
  stats: { label: string; value: string }[];
  url: string;
  daily?: string;      // "Daily #42"
}

const S = 1080;

/** 1080 x 1080 PNG: a snapshot of the final frame, the score and the run stats. */
export function drawCard(info: CardInfo, snapshot: HTMLCanvasElement | null): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = C.bg; g.fillRect(0, 0, S, S);
  const glow = g.createRadialGradient(S / 2, 0, 0, S / 2, 0, S);
  glow.addColorStop(0, rgba(info.color, 0.3)); glow.addColorStop(1, rgba(info.color, 0));
  g.fillStyle = glow; g.fillRect(0, 0, S, S);
  // Final frame, cropped to fill a rounded panel.
  const px = 60, py = 60, pw = S - 120, ph = 560;
  g.save();
  roundRect(g, px, py, pw, ph, 36); g.clip();
  g.fillStyle = '#05060C'; g.fillRect(px, py, pw, ph);
  if (snapshot && snapshot.width && snapshot.height) {
    const k = Math.max(pw / snapshot.width, ph / snapshot.height);
    const w = snapshot.width * k, h = snapshot.height * k;
    g.drawImage(snapshot, px + (pw - w) / 2, py + (ph - h) / 2, w, h);
  }
  const fade = g.createLinearGradient(0, py + ph * 0.55, 0, py + ph);
  fade.addColorStop(0, 'rgba(14,15,26,0)'); fade.addColorStop(1, 'rgba(14,15,26,0.85)');
  g.fillStyle = fade; g.fillRect(px, py, pw, ph);
  g.restore();
  g.strokeStyle = rgba(info.color, 0.8); g.lineWidth = 6;
  roundRect(g, px, py, pw, ph, 36); g.stroke();
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = C.text; g.font = `700 64px ${FONT.title}`;
  g.fillText(info.title, px + 36, py + ph - 40);
  if (info.daily) {
    g.textAlign = 'right'; g.fillStyle = C.yellow; g.font = `700 40px ${FONT.title}`;
    g.fillText(info.daily, px + pw - 36, py + ph - 44);
  }
  g.textAlign = 'center';
  g.fillStyle = info.color; g.font = `700 170px ${FONT.title}`;
  g.fillText(info.score, S / 2, 810);
  g.fillStyle = C.muted; g.font = `600 36px ${FONT.ui}`;
  g.fillText([info.unit, info.line].filter(Boolean).join(' · '), S / 2, 866);
  const stats = info.stats.slice(0, 3);
  stats.forEach((s, i) => {
    const x = S / 2 + (i - (stats.length - 1) / 2) * 300;
    g.fillStyle = C.text; g.font = `700 44px ${FONT.title}`;
    g.fillText(s.value, x, 950);
    g.fillStyle = C.muted; g.font = `500 26px ${FONT.ui}`;
    g.fillText(s.label, x, 988);
  });
  g.fillStyle = rgba(C.text, 0.6); g.font = `600 26px ${FONT.ui}`;
  g.fillText(`Pocket Arcade · ${info.url.replace(/^https?:\/\//, '')}`, S / 2, 1050);
  return cv;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** Share sheet with the PNG on touch devices; a download elsewhere. */
export async function shareCard(info: CardInfo, snapshot: HTMLCanvasElement | null, text: string, file: string): Promise<void> {
  await document.fonts?.ready;
  const cv = drawCard(info, snapshot);
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
  if (!blob) { toast('Could not make the image'); return; }
  const f = new File([blob], `${file}.png`, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], text }); return; } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = f.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Image saved');
}
