import { C, FONT, rgba } from '../theme';

// Canvas widgets shared by the Brain Lab build games: buttons, the toolbar,
// the inventory bar and a budget meter. Everything is drawn in logical units.

export type IconName = 'undo' | 'redo' | 'reset' | 'play' | 'build' | 'test' | 'stop' | 'trash' | 'rotate' | 'eye';

export interface Btn {
  id: string;
  x: number; y: number; w: number; h: number;
  icon?: IconName;
  label?: string;
  enabled: boolean;
  /** Filled with the accent colour (the main action). */
  primary?: boolean;
  /** Toggle look (Build / Play). */
  active?: boolean;
  /** Keyboard hint drawn small under the button on pointer devices. */
  hint?: string;
}

export function hitBtn(btns: readonly Btn[], x: number, y: number): Btn | null {
  for (const b of btns) if (b.enabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  return null;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export function drawBtn(g: CanvasRenderingContext2D, b: Btn, accent: string, hover: boolean, press = 0): void {
  const s = 1 - press * 0.06;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  g.save();
  g.translate(cx, cy); g.scale(s, s); g.translate(-cx, -cy);
  g.globalAlpha = b.enabled ? 1 : 0.35;
  roundRect(g, b.x, b.y, b.w, b.h, Math.min(14, b.h / 2));
  g.fillStyle = b.primary ? accent : b.active ? rgba(accent, 0.22) : hover && b.enabled ? C.surface2 : C.surface;
  g.fill();
  if (b.active && !b.primary) { g.strokeStyle = accent; g.lineWidth = 2; g.stroke(); }
  const fg = b.primary ? C.bg : b.active ? accent : C.text;
  const iconOnly = b.icon && !b.label;
  const iconX = iconOnly ? cx : b.x + Math.min(b.h, 40) * 0.55 + 4;
  if (b.icon) drawIcon(g, b.icon, iconX, cy, Math.min(b.h, 40) * 0.42, fg);
  if (b.label) {
    g.fillStyle = fg; g.font = `700 ${Math.round(Math.min(17, b.h * 0.4))}px ${FONT.title}`;
    g.textAlign = b.icon ? 'left' : 'center'; g.textBaseline = 'middle';
    g.fillText(b.label, b.icon ? iconX + b.h * 0.36 : cx, cy + 1);
  }
  g.restore();
}

export function drawIcon(g: CanvasRenderingContext2D, name: IconName, x: number, y: number, r: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.strokeStyle = color; g.fillStyle = color;
  g.lineWidth = Math.max(2, r * 0.22); g.lineCap = 'round'; g.lineJoin = 'round';
  const arrowHead = (ax: number, ay: number, ang: number) => {
    const L = r * 0.45;
    g.beginPath();
    g.moveTo(ax + Math.cos(ang + 2.5) * L, ay + Math.sin(ang + 2.5) * L);
    g.lineTo(ax, ay);
    g.lineTo(ax + Math.cos(ang - 2.5) * L, ay + Math.sin(ang - 2.5) * L);
    g.stroke();
  };
  switch (name) {
    case 'undo': case 'redo': {
      const d = name === 'undo' ? 1 : -1;
      g.scale(d, 1);
      g.beginPath(); g.moveTo(-r * 0.75, -r * 0.2); g.lineTo(r * 0.3, -r * 0.2);
      g.arc(r * 0.3, r * 0.25, r * 0.45, -Math.PI / 2, Math.PI / 2); g.lineTo(-r * 0.2, r * 0.7); g.stroke();
      arrowHead(-r * 0.75, -r * 0.2, Math.PI);
      break;
    }
    case 'reset':
      g.beginPath(); g.arc(0, 0, r * 0.7, -Math.PI * 0.35, Math.PI * 1.45); g.stroke();
      arrowHead(Math.cos(-Math.PI * 0.35) * r * 0.7, Math.sin(-Math.PI * 0.35) * r * 0.7, -Math.PI * 0.35 + Math.PI / 2 + 0.3);
      break;
    case 'play':
      g.beginPath(); g.moveTo(-r * 0.45, -r * 0.7); g.lineTo(r * 0.75, 0); g.lineTo(-r * 0.45, r * 0.7); g.closePath(); g.fill();
      break;
    case 'stop':
      g.fillRect(-r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
      break;
    case 'build':
      for (const [a, b] of [[-0.7, -0.7], [0.1, -0.7], [-0.7, 0.1], [0.1, 0.1]]) { roundRect(g, a * r, b * r, r * 0.6, r * 0.6, r * 0.12); g.fill(); }
      break;
    case 'test':
      g.beginPath(); g.moveTo(-r * 0.7, 0); g.lineTo(-r * 0.2, r * 0.55); g.lineTo(r * 0.75, -r * 0.55); g.stroke();
      break;
    case 'trash':
      g.beginPath(); g.moveTo(-r * 0.7, -r * 0.5); g.lineTo(r * 0.7, -r * 0.5); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.5, -r * 0.5); g.lineTo(-r * 0.38, r * 0.75); g.lineTo(r * 0.38, r * 0.75); g.lineTo(r * 0.5, -r * 0.5); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.2, -r * 0.75); g.lineTo(r * 0.2, -r * 0.75); g.stroke();
      break;
    case 'rotate':
      g.beginPath(); g.arc(0, 0, r * 0.65, Math.PI * 0.9, Math.PI * 2.2); g.stroke();
      arrowHead(Math.cos(Math.PI * 2.2) * r * 0.65, Math.sin(Math.PI * 2.2) * r * 0.65, Math.PI * 2.2 + Math.PI / 2);
      break;
    case 'eye':
      g.beginPath(); g.ellipse(0, 0, r * 0.8, r * 0.45, 0, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(0, 0, r * 0.2, 0, Math.PI * 2); g.fill();
      break;
  }
  g.restore();
}

// ---- inventory bar ----------------------------------------------------------

export interface InvItem {
  kind: string;
  /** Pieces left; null = unlimited. */
  count: number | null;
  label?: string;
  draw(g: CanvasRenderingContext2D, cx: number, cy: number, size: number): void;
}

export interface Slot { item: InvItem; x: number; y: number; w: number; h: number }

/** Row of piece slots with counts. Empty slots grey out. */
export class InventoryBar {
  slots: Slot[] = [];
  x = 0; y = 0; w = 0; h = 0;

  layout(items: InvItem[], x: number, y: number, w: number, h: number): void {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const n = Math.max(1, items.length);
    const size = Math.min(h, (w - (n - 1) * 8) / n, 96);
    const total = n * size + (n - 1) * 8;
    let sx = x + (w - total) / 2;
    this.slots = items.map((item) => { const s = { item, x: sx, y: y + (h - size) / 2, w: size, h: size }; sx += size + 8; return s; });
  }

  at(x: number, y: number): Slot | null {
    for (const s of this.slots) if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
    return null;
  }

  draw(g: CanvasRenderingContext2D, accent: string, selected: string | null, hover: string | null, keyHints = false): void {
    this.slots.forEach((s, i) => {
      const empty = s.item.count === 0;
      const sel = s.item.kind === selected;
      g.save();
      g.globalAlpha = empty ? 0.38 : 1;
      roundRect(g, s.x, s.y, s.w, s.h, 14);
      g.fillStyle = sel ? rgba(accent, 0.2) : s.item.kind === hover && !empty ? C.surface2 : C.surface;
      g.fill();
      if (sel) { g.strokeStyle = accent; g.lineWidth = 2; g.stroke(); }
      s.item.draw(g, s.x + s.w / 2, s.y + s.h / 2 - (s.item.label ? 6 : 0), s.w * 0.5);
      if (s.item.label) {
        g.fillStyle = C.muted; g.font = `600 ${Math.max(10, Math.round(s.w * 0.13))}px ${FONT.ui}`;
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.fillText(s.item.label, s.x + s.w / 2, s.y + s.h - 6);
      }
      if (s.item.count !== null) {
        const r = Math.max(10, s.w * 0.16);
        g.beginPath(); g.arc(s.x + s.w - r * 0.6, s.y + r * 0.6, r, 0, Math.PI * 2);
        g.fillStyle = empty ? C.surface2 : accent; g.fill();
        g.fillStyle = empty ? C.muted : C.bg; g.font = `700 ${Math.round(r * 1.2)}px ${FONT.title}`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(s.item.count), s.x + s.w - r * 0.6, s.y + r * 0.66);
      }
      if (keyHints && i < 9) {
        g.fillStyle = rgba(C.text, 0.35); g.font = `600 11px ${FONT.mono}`;
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.fillText(String(i + 1), s.x + 6, s.y + 5);
      }
      g.restore();
    });
  }
}

/** Horizontal budget meter ("$34 / $50"). Turns pink when over. */
export function drawBudget(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, used: number, total: number, label: string, accent: string): void {
  roundRect(g, x, y, w, h, h / 2); g.fillStyle = C.surface; g.fill();
  const k = Math.min(1, used / Math.max(1, total));
  if (k > 0) { roundRect(g, x, y, Math.max(h, w * k), h, h / 2); g.fillStyle = used > total ? C.pink : accent; g.fill(); }
  g.fillStyle = C.text; g.font = `700 ${Math.round(h * 0.55)}px ${FONT.title}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, x + w / 2, y + h / 2 + 1);
}

/** Small star row (0-3 earned). */
export function drawStars(g: CanvasRenderingContext2D, cx: number, cy: number, size: number, earned: number, of = 3): void {
  for (let i = 0; i < of; i++) {
    const x = cx + (i - (of - 1) / 2) * size * 1.25;
    star(g, x, cy, size / 2);
    g.fillStyle = i < earned ? C.yellow : rgba(C.text, 0.14); g.fill();
  }
}

export function star(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    if (i) g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

/** Fit a cols x rows board into a rectangle; returns the cell size and top-left. */
export function fitGrid(cols: number, rows: number, x: number, y: number, w: number, h: number, maxCell = 72): { cell: number; ox: number; oy: number } {
  const cell = Math.floor(Math.min(w / cols, h / rows, maxCell));
  return { cell, ox: Math.round(x + (w - cols * cell) / 2), oy: Math.round(y + (h - rows * cell) / 2) };
}

/** Shorten text with an ellipsis to fit `max` px in the current font. */
export function fitText(g: CanvasRenderingContext2D, s: string, max: number): string {
  if (g.measureText(s).width <= max) return s;
  while (s.length > 2 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/** Room left of the top toolbar for the title block. */
export function titleRoom(btns: readonly Btn[], fallback: number): number {
  const xs = btns.filter((b) => b.y < 60).map((b) => b.x);
  return (xs.length ? Math.min(...xs) : fallback) - 28;
}
