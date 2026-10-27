import type { GameCanvas } from './canvas';

export interface Pointer {
  id: number;
  /** Logical coordinates. */
  x: number; y: number;
  /** Client (CSS px) coordinates. */
  cx: number; cy: number;
  type: string;   // 'mouse' | 'touch' | 'pen'
  down: boolean;
}

type PointerFn = (p: Pointer, e: PointerEvent) => void;
type KeyFn = (code: string, e: KeyboardEvent) => void;

/**
 * Unified pointer + keyboard input for one game host. Mouse, touch and pen all
 * arrive as pointers (multi-touch supported). Coalesced moves are delivered
 * individually so strokes are smooth. Touch never scrolls or zooms the page.
 */
export class Input {
  /** When false, nothing is delivered to the game (menus are open). */
  enabled = true;
  readonly keys = new Set<string>();
  readonly pointers = new Map<number, Pointer>();
  /** Most recent pointer position even when not pressed (mouse hover). */
  readonly hover: Pointer = { id: -1, x: 0, y: 0, cx: 0, cy: 0, type: 'mouse', down: false };
  hasHover = false;
  private downFns = new Set<PointerFn>();
  private moveFns = new Set<PointerFn>();
  private upFns = new Set<PointerFn>();
  private altFns = new Set<PointerFn>();
  private keyFns = new Set<KeyFn>();
  private keyUpFns = new Set<KeyFn>();
  private off: (() => void)[] = [];
  private tmp = { x: 0, y: 0 };

  constructor(private canvas: GameCanvas, listen = true) {
    if (!listen) return;
    const el = canvas.el;
    this.bind(el, 'pointerdown', this.onDown as EventListener);
    this.bind(window, 'pointermove', this.onMove as EventListener);
    this.bind(window, 'pointerup', this.onUp as EventListener);
    this.bind(window, 'pointercancel', this.onUp as EventListener);
    this.bind(window, 'keydown', this.onKeyDown as EventListener);
    this.bind(window, 'keyup', this.handleKeyUp as EventListener);
    this.bind(window, 'blur', this.onBlur);
    const prevent = (e: Event) => { if (e.cancelable) e.preventDefault(); };
    this.bind(el, 'touchstart', prevent, { passive: false });
    this.bind(el, 'touchmove', prevent, { passive: false });
    this.bind(el, 'contextmenu', prevent);
  }

  private bind(t: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.off.push(() => t.removeEventListener(type, fn, opts));
  }

  /** 'alt' = right-click (secondary button) press; the context menu never opens. */
  on(type: 'down' | 'move' | 'up' | 'alt', fn: PointerFn): void {
    (type === 'down' ? this.downFns : type === 'move' ? this.moveFns : type === 'up' ? this.upFns : this.altFns).add(fn);
  }
  onKey(fn: KeyFn): void { this.keyFns.add(fn); }
  onKeyUp(fn: KeyFn): void { this.keyUpFns.add(fn); }
  isDown(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }
  /** Number of pressed pointers. */
  get pressed(): number { let n = 0; for (const p of this.pointers.values()) if (p.down) n++; return n; }

  private update(p: Pointer, e: PointerEvent): void {
    this.canvas.toLogical(e.clientX, e.clientY, this.tmp);
    p.x = this.tmp.x; p.y = this.tmp.y; p.cx = e.clientX; p.cy = e.clientY; p.type = e.pointerType || 'mouse';
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button > 0) {
      if (e.button === 2 && this.enabled) {
        const p: Pointer = { id: e.pointerId, x: 0, y: 0, cx: 0, cy: 0, type: 'mouse', down: false };
        this.update(p, e);
        for (const fn of this.altFns) fn(p, e);
      }
      return;
    }
    let p = this.pointers.get(e.pointerId);
    if (!p) { p = { id: e.pointerId, x: 0, y: 0, cx: 0, cy: 0, type: 'mouse', down: true }; this.pointers.set(e.pointerId, p); }
    p.down = true;
    this.update(p, e);
    this.update(this.hover, e); this.hasHover = true;
    try { this.canvas.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (e.pointerType !== 'mouse') e.preventDefault();
    if (!this.enabled) return;
    for (const fn of this.downFns) fn(p, e);
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    for (const ev of list) {
      this.update(this.hover, ev); this.hasHover = true;
      if (p) this.update(p, ev);
      if (!this.enabled) continue;
      for (const fn of this.moveFns) fn(p ?? this.hover, ev);
    }
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.update(p, e);
    p.down = false;
    this.pointers.delete(e.pointerId);
    if (!this.enabled) return;
    for (const fn of this.upFns) fn(p, e);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && this.enabled) e.preventDefault();
    this.keys.add(e.code);
    if (!this.enabled || e.repeat) return;
    for (const fn of this.keyFns) fn(e.code, e);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (!this.enabled) return;
    for (const fn of this.keyUpFns) fn(e.code, e);
  };

  private onBlur = (): void => { this.keys.clear(); };

  /** Drop all held state, e.g. when a menu opens. */
  reset(): void { this.keys.clear(); this.pointers.clear(); }

  destroy(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    this.downFns.clear(); this.moveFns.clear(); this.upFns.clear(); this.altFns.clear(); this.keyFns.clear(); this.keyUpFns.clear();
  }
}
