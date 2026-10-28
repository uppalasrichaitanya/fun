// Rocket Builder artwork: parts (drawn in rocket metres at any scale) and the
// little scenes on Fail Album cards.
import { C, rgba } from '../../engine/theme';
import { PARTS, type FailId, type LaidPart, type PartKind } from './logic';

const WHITE = '#EEF1F7', SHADE = '#C9CFDC', DARK = '#3A3F4E', ORANGE = C.orange, RED = '#E8505B';

/**
 * Draw one part centred at (cx, cy) on screen, `s` px per metre. `side` mirrors
 * side parts (-1 left, 1 right). `up` = screen angle of the rocket's nose is
 * handled by the caller's transform; here +y is down the rocket.
 */
export function drawPart(g: CanvasRenderingContext2D, kind: PartKind, cx: number, cy: number, s: number, side: -1 | 0 | 1 = 0, ghost = false): void {
  const P = PARTS[kind];
  const w = P.w * s, h = P.h * s;
  const x0 = cx - w / 2, y0 = cy - h / 2;
  g.save();
  if (ghost) g.globalAlpha *= 0.55;
  g.lineWidth = Math.max(1, s * 0.05);
  g.strokeStyle = 'rgba(20,24,36,0.55)';
  switch (kind) {
    case 'pod': {
      g.beginPath();
      g.moveTo(cx - w * 0.22, y0); g.lineTo(cx + w * 0.22, y0);
      g.lineTo(x0 + w, y0 + h); g.lineTo(x0, y0 + h); g.closePath();
      g.fillStyle = WHITE; g.fill(); g.stroke();
      // Bob's window.
      g.beginPath(); g.arc(cx, cy + h * 0.08, w * 0.18, 0, Math.PI * 2); g.fillStyle = '#2B5D8C'; g.fill(); g.stroke();
      g.beginPath(); g.arc(cx, cy + h * 0.1, w * 0.1, 0, Math.PI * 2); g.fillStyle = '#9BE15D'; g.fill();
      g.fillStyle = DARK; g.fillRect(cx - w * 0.05, cy + h * 0.07, w * 0.03, w * 0.03); g.fillRect(cx + w * 0.02, cy + h * 0.07, w * 0.03, w * 0.03);
      break;
    }
    case 'cone':
      g.beginPath(); g.moveTo(cx, y0); g.quadraticCurveTo(x0 + w * 0.95, y0 + h * 0.45, x0 + w, y0 + h);
      g.lineTo(x0, y0 + h); g.quadraticCurveTo(x0 + w * 0.05, y0 + h * 0.45, cx, y0); g.fillStyle = RED; g.fill(); g.stroke();
      break;
    case 'chute':
      g.beginPath(); g.ellipse(cx, y0 + h, w / 2, h, 0, Math.PI, 0); g.fillStyle = ORANGE; g.fill(); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.moveTo(cx, y0 + h * 0.15); g.lineTo(cx, y0 + h); g.stroke();
      break;
    case 'tankS': case 'tankM': case 'tankL': {
      rr(g, x0, y0, w, h, w * 0.12); g.fillStyle = WHITE; g.fill(); g.stroke();
      g.fillStyle = SHADE; g.fillRect(x0 + w * 0.68, y0 + 2, w * 0.18, h - 4);
      g.fillStyle = ORANGE; g.fillRect(x0, y0 + h * 0.12, w, Math.max(2, s * 0.12)); g.fillRect(x0, y0 + h * 0.88 - Math.max(2, s * 0.12), w, Math.max(2, s * 0.12));
      if (s > 9) {
        g.fillStyle = DARK; g.font = `700 ${Math.round(s * 0.45)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(kind.slice(4), cx - w * 0.06, cy);
      }
      break;
    }
    case 'engineS': case 'engineB': {
      const big = kind === 'engineB';
      g.fillStyle = DARK; g.fillRect(cx - w * 0.36, y0, w * 0.72, h * 0.32);
      g.beginPath(); g.moveTo(cx - w * (big ? 0.2 : 0.16), y0 + h * 0.3); g.lineTo(cx + w * (big ? 0.2 : 0.16), y0 + h * 0.3);
      g.lineTo(cx + w / 2, y0 + h); g.lineTo(cx - w / 2, y0 + h); g.closePath();
      g.fillStyle = '#5C6274'; g.fill(); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(cx - w * 0.3, y0 + h * 0.55, w * 0.1, h * 0.35);
      break;
    }
    case 'decoupler':
      g.fillStyle = C.yellow; g.fillRect(x0, y0, w, h);
      g.fillStyle = DARK;
      for (let k = 0; k < 6; k++) { const xx = x0 + (k / 6) * w; g.beginPath(); g.moveTo(xx, y0 + h); g.lineTo(xx + w / 12, y0); g.lineTo(xx + w / 6, y0); g.lineTo(xx + w / 12, y0 + h); g.fill(); }
      break;
    case 'booster':
      g.beginPath(); g.moveTo(x0, y0 + w * 0.8); g.quadraticCurveTo(cx, y0 - w * 0.2, x0 + w, y0 + w * 0.8);
      g.lineTo(x0 + w, y0 + h - w * 0.3); g.lineTo(x0, y0 + h - w * 0.3); g.closePath();
      g.fillStyle = WHITE; g.fill(); g.stroke();
      g.fillStyle = ORANGE; g.fillRect(x0, y0 + h * 0.45, w, Math.max(2, s * 0.15));
      g.fillStyle = '#5C6274'; g.beginPath(); g.moveTo(x0 + w * 0.2, y0 + h - w * 0.3); g.lineTo(x0 + w * 0.8, y0 + h - w * 0.3); g.lineTo(x0 + w, y0 + h); g.lineTo(x0, y0 + h); g.fill();
      break;
    case 'fins': {
      const d = side || 1;
      const inner = cx - (d * w) / 2;
      g.beginPath(); g.moveTo(inner, y0); g.lineTo(inner + d * w, y0 + h * 0.8); g.lineTo(inner + d * w, y0 + h); g.lineTo(inner, y0 + h * 0.85); g.closePath();
      g.fillStyle = RED; g.fill(); g.stroke();
      break;
    }
    case 'legs': {
      const d = side || 1;
      const inner = cx - (d * w) / 2;
      g.strokeStyle = '#8A90A0'; g.lineWidth = Math.max(1.5, s * 0.12); g.lineCap = 'round';
      g.beginPath(); g.moveTo(inner, y0 + h * 0.1); g.lineTo(inner + d * w * 0.85, y0 + h * 0.95); g.moveTo(inner, y0 + h * 0.55); g.lineTo(inner + d * w * 0.6, y0 + h * 0.75); g.stroke();
      g.fillStyle = DARK; g.fillRect(inner + d * w * 0.85 - w * 0.25, y0 + h * 0.92, w * 0.5, h * 0.08);
      break;
    }
  }
  g.restore();
}

/** A whole rocket from laid-out parts, `s` px/m, origin = rocket coords (0,0) at screen (ox, oy). Rocket +y is up. */
export function drawRocket(g: CanvasRenderingContext2D, parts: readonly LaidPart[], ox: number, oy: number, s: number): void {
  // Side parts behind the core, then the core.
  for (const p of parts) if (p.side) drawPart(g, p.kind, ox + p.x * s, oy - p.y * s, s, p.side);
  for (const p of parts) if (!p.side) drawPart(g, p.kind, ox + p.x * s, oy - p.y * s, s, 0);
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** Simple rocket icon pointing along `ang` (screen radians, 0 = right), for cards and the minimap. */
export function miniRocket(g: CanvasRenderingContext2D, x: number, y: number, size: number, ang: number, color = WHITE): void {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.fillStyle = color;
  g.beginPath(); g.moveTo(size, 0); g.lineTo(size * 0.3, -size * 0.28); g.lineTo(-size * 0.7, -size * 0.28); g.lineTo(-size * 0.7, size * 0.28); g.lineTo(size * 0.3, size * 0.28); g.closePath(); g.fill();
  g.fillStyle = RED;
  g.beginPath(); g.moveTo(-size * 0.4, -size * 0.28); g.lineTo(-size * 0.8, -size * 0.55); g.lineTo(-size * 0.8, -size * 0.2); g.fill();
  g.beginPath(); g.moveTo(-size * 0.4, size * 0.28); g.lineTo(-size * 0.8, size * 0.55); g.lineTo(-size * 0.8, size * 0.2); g.fill();
  g.restore();
}

/** The scene on a Fail Album card, in a w x h box at (x, y). `t` animates. */
export function drawFailScene(g: CanvasRenderingContext2D, id: FailId, x: number, y: number, w: number, h: number, t: number): void {
  const cx = x + w / 2, cy = y + h / 2, s = Math.min(w, h);
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  const sky = id === 'crater' || id === 'bounce' || id === 'postcard' ? '#0B0F24' : '#2C6FB0';
  g.fillStyle = sky; g.fillRect(x, y, w, h);
  const ground = (col: string, gy = y + h * 0.8) => { g.fillStyle = col; g.fillRect(x, gy, w, y + h - gy); };
  switch (id) {
    case 'ballerina':
      ground('#4D8A3E');
      miniRocket(g, cx, cy - s * 0.05, s * 0.22, t * 6);
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 2;
      for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(cx, cy - s * 0.05, s * (0.28 + k * 0.06), t * 6 + k, t * 6 + k + 1.2); g.stroke(); }
      break;
    case 'hop': {
      ground('#4D8A3E');
      const k = Math.abs(Math.sin(t * 2));
      miniRocket(g, cx, y + h * 0.8 - s * 0.2 - k * s * 0.08, s * 0.2, -Math.PI / 2);
      g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.moveTo(cx - s * 0.3, y + h * 0.78); g.quadraticCurveTo(cx, y + h * 0.5, cx + s * 0.3, y + h * 0.78); g.stroke(); g.setLineDash([]);
      break;
    }
    case 'drill':
      ground('#6B4F3A', y + h * 0.55);
      miniRocket(g, cx, y + h * 0.62 + Math.sin(t * 20) * 1.5, s * 0.22, Math.PI / 2);
      g.fillStyle = '#8B6B4A';
      for (let k = 0; k < 6; k++) { const a = t * 3 + k; g.beginPath(); g.arc(cx + Math.cos(a) * s * 0.2, y + h * 0.52 - Math.abs(Math.sin(a)) * s * 0.12, s * 0.025, 0, Math.PI * 2); g.fill(); }
      break;
    case 'spaghetti':
      ground('#4D8A3E');
      g.strokeStyle = WHITE; g.lineWidth = s * 0.07; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx, y + h * 0.78);
      for (let k = 1; k <= 8; k++) g.lineTo(cx + Math.sin(k * 0.8 + t * 3) * s * 0.03 * k, y + h * 0.78 - k * s * 0.07);
      g.stroke();
      break;
    case 'sideways':
      ground('#4D8A3E');
      miniRocket(g, x + ((t * 0.3) % 1) * w, y + h * 0.6, s * 0.18, 0);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2;
      for (let k = 0; k < 3; k++) { const lx = x + ((t * 0.3) % 1) * w - s * (0.3 + k * 0.12); g.beginPath(); g.moveTo(lx, y + h * (0.56 + k * 0.04)); g.lineTo(lx - s * 0.12, y + h * (0.56 + k * 0.04)); g.stroke(); }
      break;
    case 'soclose': {
      g.fillStyle = '#0B0F24'; g.fillRect(x, y, w, h * 0.3);
      g.setLineDash([5, 4]); g.strokeStyle = C.yellow; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y + h * 0.3); g.lineTo(x + w, y + h * 0.3); g.stroke(); g.setLineDash([]);
      miniRocket(g, cx, y + h * 0.38 + Math.sin(t * 2) * 3, s * 0.18, -Math.PI / 2);
      break;
    }
    case 'statue':
      ground('#4D8A3E');
      g.fillStyle = '#A9A9B4'; g.fillRect(cx - s * 0.16, y + h * 0.68, s * 0.32, s * 0.12);
      miniRocket(g, cx, y + h * 0.48, s * 0.2, -Math.PI / 2, '#D9C27A');
      break;
    case 'clingy':
      ground('#4D8A3E');
      miniRocket(g, cx, cy, s * 0.2, -Math.PI / 2 + Math.sin(t * 4) * 0.6);
      g.fillStyle = C.pink;
      for (const d of [-1, 1]) { const hx = cx + d * s * 0.25, hy = cy - s * 0.15 - ((t * 0.5 + (d + 1) * 0.2) % 1) * s * 0.2; g.beginPath(); g.arc(hx - 3, hy, 3, 0, Math.PI * 2); g.arc(hx + 3, hy, 3, 0, Math.PI * 2); g.moveTo(hx - 6, hy + 1); g.lineTo(hx, hy + 8); g.lineTo(hx + 6, hy + 1); g.fill(); }
      break;
    case 'torn':
      for (let k = 0; k < 5; k++) { g.fillStyle = k % 2 ? ORANGE : WHITE; const a = -2.4 + k * 0.4; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, s * 0.3, a + Math.sin(t * 9 + k) * 0.1, a + 0.3); g.closePath(); g.fill(); }
      miniRocket(g, cx, cy + s * 0.25, s * 0.12, Math.PI / 2);
      break;
    case 'crater':
      g.fillStyle = '#8E8E99'; g.beginPath(); g.ellipse(cx, y + h, w * 0.7, h * 0.35, 0, Math.PI, 0); g.fill();
      g.fillStyle = '#5E5E69'; g.beginPath(); g.ellipse(cx, y + h * 0.78, s * 0.22, s * 0.06, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = C.yellow; g.font = `900 ${Math.round(s * 0.16)}px system-ui`; g.textAlign = 'center'; g.fillText('BOOM', cx, y + h * 0.45 + Math.sin(t * 6) * 2);
      break;
    case 'postcard':
      g.fillStyle = C.yellow; g.beginPath(); g.arc(x + w * 0.85, y + h * 0.25, s * 0.15, 0, Math.PI * 2); g.fill();
      miniRocket(g, x + w * 0.3 + ((t * 0.1) % 1) * w * 0.3, y + h * 0.6, s * 0.08, -0.4);
      g.fillStyle = '#3D7DD8'; g.beginPath(); g.arc(x + w * 0.1, y + h * 0.9, s * 0.12, 0, Math.PI * 2); g.fill();
      break;
    case 'dry':
      ground('#4D8A3E');
      drawPart(g, 'engineB', cx, cy, s * 0.35);
      g.fillStyle = C.cyan; g.beginPath(); g.moveTo(cx + s * 0.25, cy - s * 0.2); g.quadraticCurveTo(cx + s * 0.32, cy - s * 0.08, cx + s * 0.25, cy - s * 0.04); g.quadraticCurveTo(cx + s * 0.18, cy - s * 0.08, cx + s * 0.25, cy - s * 0.2); g.fill();
      break;
    case 'pancake':
      ground('#4D8A3E');
      g.fillStyle = WHITE; g.beginPath(); g.ellipse(cx, y + h * 0.78, s * 0.28, s * 0.05, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9BE15D'; g.beginPath(); g.arc(cx, y + h * 0.75, s * 0.04, 0, Math.PI * 2); g.fill();
      break;
    case 'bounce': {
      g.fillStyle = '#8E8E99'; g.fillRect(x, y + h * 0.82, w, h * 0.18);
      const ph = (t * 0.8) % 1;
      const bx = x + w * (0.15 + ph * 0.7), by = y + h * 0.78 - Math.abs(Math.sin(ph * Math.PI * 3)) * h * 0.35 * (1 - ph * 0.6);
      miniRocket(g, bx, by, s * 0.12, -Math.PI / 2 + ph * 6);
      break;
    }
  }
  g.restore();
}

export const FAIL_COLOR = rgba(C.orange, 1);
