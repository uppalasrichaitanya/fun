import { C, FONT, rgba } from '../../engine/theme';
import { toast } from '../../shell/dom';
import type { AuctionState } from './rules';
import { modeLabel, spentOf, type Award, type AutoScore } from './scoring';
import type { PlayerIdx } from './types';

const W = 1080, H = 1350;
const PC = [C.pink, C.cyan] as const;
const PACK = { cricket: 'Cricket', pokemon: 'Pokemon', heroes: 'Superheroes' } as const;

/** 1080 x 1350 PNG (WhatsApp / Instagram portrait) with both squads, prices, winner and awards. */
export function drawShareImage(state: AuctionState, names: [string, string], score: AutoScore, aw: Award[], code: string): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#15162B'); bg.addColorStop(1, C.bg);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  for (const [x, c] of [[0, C.pink], [W, C.cyan]] as const) {
    const r = g.createRadialGradient(x, 300, 0, x, 300, 600);
    r.addColorStop(0, rgba(c, 0.25)); r.addColorStop(1, rgba(c, 0));
    g.fillStyle = r;
    g.fillRect(0, 0, W, H);
  }
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.yellow;
  g.font = `700 92px ${FONT.title}`;
  g.fillText('BID WAR', W / 2, 120);
  const s = state.settings;
  g.fillStyle = C.muted;
  g.font = `600 30px ${FONT.ui}`;
  g.fillText(`${PACK[s.pack]} · ${modeLabel(s)} · ${s.squadSize}-a-side · $${state.purseStart} purses`, W / 2, 172);

  const w = score.winner;
  g.fillStyle = w === null ? C.text : PC[w];
  g.font = `700 60px ${FONT.title}`;
  g.fillText(w === null ? 'DEAD HEAT' : `${names[w].toUpperCase()} WINS`, W / 2, 262);

  const rows = s.squadSize;
  const lineH = rows > 6 ? 38 : 54;
  const font = rows > 6 ? 26 : 32;
  for (const p of [0, 1] as PlayerIdx[]) {
    const x0 = p === 0 ? 60 : W / 2 + 40, colW = W / 2 - 100;
    const pl = state.players[p];
    g.fillStyle = rgba(PC[p], 0.12);
    roundRect(g, x0 - 20, 300, colW + 40, 140 + rows * lineH, 28);
    g.fill();
    g.textAlign = 'left';
    g.fillStyle = PC[p];
    g.font = `700 44px ${FONT.title}`;
    g.fillText(fit(g, names[p], colW - 120), x0, 358);
    g.textAlign = 'right';
    g.fillStyle = C.text;
    g.fillText(score.teams[p].total.toFixed(1), x0 + colW, 358);
    g.font = `500 24px ${FONT.ui}`;
    g.fillStyle = C.muted;
    g.fillText('pts', x0 + colW, 386);
    g.textAlign = 'left';
    g.fillText(`Spent $${spentOf(pl.squad)} · left $${pl.purse}`, x0, 392);
    const squad = [...pl.squad].sort((a, b) => b.price - a.price || b.card.rating - a.card.rating);
    squad.forEach((b, i) => {
      const y = 448 + i * lineH;
      g.font = `600 ${font}px ${FONT.ui}`;
      g.fillStyle = C.text;
      g.textAlign = 'left';
      g.fillText(fit(g, b.card.name, colW - 110), x0, y);
      g.textAlign = 'right';
      g.fillStyle = b.price ? C.yellow : C.muted;
      g.font = `700 ${font}px ${FONT.title}`;
      g.fillText(b.price ? `$${b.price}` : 'free', x0 + colW, y);
    });
  }

  g.textAlign = 'left';
  let y = 300 + 160 + rows * lineH + 40;
  for (const a of aw.slice(0, 5)) {
    g.fillStyle = C.yellow;
    g.font = `700 28px ${FONT.title}`;
    g.fillText(a.title, 60, y);
    g.fillStyle = C.text;
    g.font = `500 26px ${FONT.ui}`;
    g.fillText(fit(g, a.text, W - 120), 60, y + 36);
    y += 84;
    if (y > H - 110) break;
  }
  g.textAlign = 'center';
  g.fillStyle = C.muted;
  g.font = `500 24px ${FONT.ui}`;
  g.fillText(`Pocket Arcade · match code ${code}`, W / 2, H - 40);
  return cv;
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Share sheet with the PNG on phones; download elsewhere. */
export async function saveShareImage(state: AuctionState, names: [string, string], score: AutoScore, aw: Award[], code: string): Promise<void> {
  await document.fonts?.ready;
  const cv = drawShareImage(state, names, score, aw, code);
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  const file = new File([blob], `bid-war-${code}.png`, { type: 'image/png' });
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Bid War' }); return; } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Image saved');
}
