import type { Pointer } from '../input';
import type { InventoryBar } from './ui';

/** What a grid build game exposes to the placement controller. */
export interface GridModel {
  cols: number;
  rows: number;
  /** Kind of the player-placed (movable) piece on a cell, or null. */
  pieceAt(c: number, r: number): string | null;
  /** Can `kind` stand on this cell, assuming it is free of player pieces? */
  canPlace(kind: string, c: number, r: number): boolean;
  /** Pieces of `kind` left in the inventory (null = unlimited). */
  left(kind: string): number | null;
  place(kind: string, c: number, r: number): void;
  move(fc: number, fr: number, tc: number, tr: number): void;
  rotate(c: number, r: number): void;
  remove(c: number, r: number): void;
}

export type EditKind = 'place' | 'move' | 'rotate' | 'remove' | 'deny' | 'pick';

interface Drag {
  id: number;
  kind: string;
  from: { c: number; r: number } | null;
  x: number; y: number; sx: number; sy: number;
  moved: boolean;
  t: number;
}

const LONG_PRESS = 0.45;
const SLOP = 9;

/**
 * Snap-to-grid placement shared by the grid build games: drag from the
 * inventory to place, drag a piece to move it, tap to rotate, long-press or
 * right-click to return it, ghost preview while dragging. Keyboard: arrows
 * move a cursor, R or Space rotates (or places the selected piece), Delete
 * removes, 1-9 pick an inventory slot.
 */
export class GridPlacer {
  ox = 0; oy = 0; cell = 40;
  selected: string | null = null;
  cursor = { c: 0, r: 0, show: false };
  drag: Drag | null = null;
  enabled = true;
  /** Last cell flashed red (rejected), with time left. */
  denied: { c: number; r: number; t: number } | null = null;

  constructor(private model: GridModel, private inv: InventoryBar, private edit: (fn: () => void, kind: EditKind) => void) {}

  setView(ox: number, oy: number, cell: number): void { this.ox = ox; this.oy = oy; this.cell = cell; }

  cellAt(x: number, y: number): { c: number; r: number } | null {
    const c = Math.floor((x - this.ox) / this.cell), r = Math.floor((y - this.oy) / this.cell);
    return c >= 0 && r >= 0 && c < this.model.cols && r < this.model.rows ? { c, r } : null;
  }

  center(c: number, r: number): { x: number; y: number } {
    return { x: this.ox + (c + 0.5) * this.cell, y: this.oy + (r + 0.5) * this.cell };
  }

  private canDrop(kind: string, c: number, r: number, from: { c: number; r: number } | null): boolean {
    if (!this.model.canPlace(kind, c, r)) return false;
    const there = this.model.pieceAt(c, r);
    return !there || (!!from && from.c === c && from.r === r);
  }

  down(p: Pointer): boolean {
    if (!this.enabled) return false;
    this.cursor.show = false;
    const slot = this.inv.at(p.x, p.y);
    if (slot) {
      const left = slot.item.count;
      if (left === 0) { this.edit(() => {}, 'deny'); return true; }
      this.drag = { id: p.id, kind: slot.item.kind, from: null, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, t: 0 };
      return true;
    }
    const cell = this.cellAt(p.x, p.y);
    if (!cell) return false;
    const kind = this.model.pieceAt(cell.c, cell.r);
    if (kind) {
      this.drag = { id: p.id, kind, from: cell, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, t: 0 };
      return true;
    }
    if (this.selected) { this.tryPlace(this.selected, cell.c, cell.r); return true; }
    return false;
  }

  move(p: Pointer): void {
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    d.x = p.x; d.y = p.y;
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > SLOP) d.moved = true;
  }

  up(p: Pointer): void {
    const d = this.drag;
    if (!d || d.id !== p.id) return;
    this.drag = null;
    const cell = this.cellAt(p.x, p.y);
    if (!d.from) {
      if (!d.moved) { this.selected = this.selected === d.kind ? null : d.kind; this.edit(() => {}, 'pick'); return; }
      if (cell) this.tryPlace(d.kind, cell.c, cell.r);
      return;
    }
    const from = d.from;
    if (!d.moved) { this.edit(() => this.model.rotate(from.c, from.r), 'rotate'); return; }
    if (!cell) {
      if (this.inv.at(p.x, p.y) || p.y > this.oy + this.model.rows * this.cell) this.edit(() => this.model.remove(from.c, from.r), 'remove');
      return;
    }
    if (cell.c === from.c && cell.r === from.r) return;
    if (!this.canDrop(d.kind, cell.c, cell.r, from)) { this.deny(cell.c, cell.r); return; }
    this.edit(() => this.model.move(from.c, from.r, cell.c, cell.r), 'move');
  }

  /** Right-click: return the piece under the pointer. */
  alt(p: Pointer): void {
    if (!this.enabled) return;
    const cell = this.cellAt(p.x, p.y);
    if (cell && this.model.pieceAt(cell.c, cell.r)) this.edit(() => this.model.remove(cell.c, cell.r), 'remove');
  }

  update(dt: number): void {
    if (this.denied && (this.denied.t -= dt) <= 0) this.denied = null;
    const d = this.drag;
    if (!d || !d.from || d.moved) return;
    d.t += dt;
    if (d.t >= LONG_PRESS) {
      const from = d.from;
      this.drag = null;
      this.edit(() => this.model.remove(from.c, from.r), 'remove');
    }
  }

  key(code: string): boolean {
    if (!this.enabled) return false;
    const cur = this.cursor;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[code]) {
      if (cur.show) {
        cur.c = Math.max(0, Math.min(this.model.cols - 1, cur.c + dirs[code][0]));
        cur.r = Math.max(0, Math.min(this.model.rows - 1, cur.r + dirs[code][1]));
      }
      cur.show = true;
      return true;
    }
    const m = /^Digit([1-9])$/.exec(code);
    if (m) {
      const slot = this.inv.slots[Number(m[1]) - 1];
      if (slot) { this.selected = slot.item.kind; cur.show = true; this.edit(() => {}, 'pick'); }
      return !!slot;
    }
    if (!cur.show) return false;
    const piece = this.model.pieceAt(cur.c, cur.r);
    if (code === 'KeyR' || code === 'Space' || code === 'Enter') {
      if (piece) this.edit(() => this.model.rotate(cur.c, cur.r), 'rotate');
      else if (this.selected) this.tryPlace(this.selected, cur.c, cur.r);
      else return false;
      return true;
    }
    if ((code === 'Delete' || code === 'Backspace') && piece) {
      this.edit(() => this.model.remove(cur.c, cur.r), 'remove');
      return true;
    }
    return false;
  }

  private tryPlace(kind: string, c: number, r: number): void {
    const left = this.model.left(kind);
    if (left === 0 || !this.canDrop(kind, c, r, null)) { this.deny(c, r); return; }
    this.edit(() => this.model.place(kind, c, r), 'place');
  }

  private deny(c: number, r: number): void {
    this.denied = { c, r, t: 0.35 };
    this.edit(() => {}, 'deny');
  }

  /** Ghost preview: the dragged piece over a cell, or the selected piece under the mouse. */
  ghost(hover: { x: number; y: number } | null): { kind: string; c: number; r: number; ok: boolean } | null {
    const d = this.drag;
    if (d && d.moved) {
      const cell = this.cellAt(d.x, d.y);
      return cell ? { kind: d.kind, ...cell, ok: this.canDrop(d.kind, cell.c, cell.r, d.from) } : null;
    }
    if (!d && this.selected && this.model.left(this.selected) !== 0) {
      const cell = this.cursor.show ? this.cursor : hover ? this.cellAt(hover.x, hover.y) : null;
      if (cell && !this.model.pieceAt(cell.c, cell.r) && this.model.canPlace(this.selected, cell.c, cell.r)) return { kind: this.selected, c: cell.c, r: cell.r, ok: true };
    }
    return null;
  }

  /** Cell whose piece is being dragged (draw it under the pointer instead). */
  lifted(): { c: number; r: number; x: number; y: number } | null {
    const d = this.drag;
    return d && d.from && d.moved ? { ...d.from, x: d.x, y: d.y } : null;
  }

  /** Inventory piece being dragged (draw it under the pointer). */
  carried(): { kind: string; x: number; y: number } | null {
    const d = this.drag;
    return d && !d.from && d.moved ? { kind: d.kind, x: d.x, y: d.y } : null;
  }

  /** Long-press progress 0..1 for the held piece (draw a shrinking ring). */
  holdProgress(): { c: number; r: number; k: number } | null {
    const d = this.drag;
    return d && d.from && !d.moved && d.t > 0.12 ? { ...d.from, k: d.t / LONG_PRESS } : null;
  }
}
