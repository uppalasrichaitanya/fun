import { GameHost } from '../engine/host';
import { randomSeed } from '../engine/rng';
import { getScores } from '../engine/scores';
import { settings } from '../engine/settings';
import type { ShellHooks } from '../engine/types';
import { GAMES, GROUPS, type GameMeta } from '../games/registry';
import { h } from '../shell/dom';
import { CONTROL_ICON, CONTROL_LABEL, ICON } from '../shell/icons';
import { openSettings, soundOn, toggleSound } from '../shell/settings-panel';

interface Card {
  meta: GameMeta;
  el: HTMLElement;
  preview: HTMLElement;
  host: GameHost | null;
  loading: boolean;
  visible: boolean;
  hot: boolean;
}

const NOOP_HOOKS: ShellHooks = {
  gameOver() {}, setScore() {}, recordScore: () => ({ best: 0, isNewBest: false }), best: () => 0, setShare() {},
};

/** Arcade lobby. Every playable card runs its game's own renderer in attract mode. */
export class Hub {
  readonly root: HTMLElement;
  private cards: Card[] = [];
  private io: IntersectionObserver;
  private raf = 0;
  private off: (() => void)[] = [];

  constructor(parent: HTMLElement) {
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const card = this.cards.find((c) => c.preview === en.target);
        if (!card) continue;
        card.visible = en.isIntersecting;
        if (card.visible) void this.ensureHost(card);
      }
    }, { rootMargin: '80px' });

    const soundBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Toggle sound' });
    const syncSound = () => { soundBtn.innerHTML = soundOn() ? ICON.soundOn : ICON.soundOff; soundBtn.setAttribute('aria-pressed', String(soundOn())); };
    soundBtn.addEventListener('click', () => { toggleSound(); });
    syncSound();
    this.off.push(settings.on(syncSound));

    const header = h('header.hub-header', {},
      h('div', {}, h('h1.wordmark', {}, 'Pocket Arcade'), h('p.hub-sub', {}, 'Ten tiny games. One more try.')),
      h('div.hub-actions', {}, soundBtn,
        h('button.icon-btn', { type: 'button', 'aria-label': 'Settings', html: ICON.gear, onclick: () => openSettings(() => this.refreshBests()) })),
    );
    const main = h('main');
    for (const group of GROUPS) {
      const metas = GAMES.filter((g) => g.group === group);
      if (!metas.length) continue;
      const grid = h('div.grid', { role: 'list' });
      for (const m of metas) grid.append(this.makeCard(m));
      main.append(h('section', { 'aria-label': group }, h('h2.group-label', {}, group), grid));
    }
    this.root = h('div.hub', {}, header, main,
      h('footer.hub-footer', {}, 'Works offline. No accounts, no ads. Scores stay on this device.'));
    parent.append(this.root);
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    for (const c of this.cards) if (c.meta.load) this.io.observe(c.preview);
    this.raf = requestAnimationFrame(this.frame);
  }

  private makeCard(meta: GameMeta): HTMLElement {
    const playable = !!meta.load;
    const preview = h('div.preview', {}, playable ? null : h('span.soon-tag', {}, 'Coming soon'));
    const best = h('span.chip');
    const controls = h('span.controls', { 'aria-label': 'Controls: ' + meta.controls.map((c) => CONTROL_LABEL[c]).join(', ') });
    for (const c of meta.controls) controls.insertAdjacentHTML('beforeend', CONTROL_ICON[c]);
    const el = h(playable ? 'a.card' : 'div.card.soon', {
      href: playable ? `#/game/${meta.id}` : undefined, role: 'listitem', 'data-id': meta.id,
      style: `--c:${meta.color}`, 'aria-disabled': playable ? undefined : 'true',
    },
      preview,
      h('div.info', {},
        h('div.title-row', {}, h('h3', {}, meta.title)),
        h('p', {}, meta.tagline),
        h('div.meta', {}, best, controls)),
    ) as HTMLElement;
    const card: Card = { meta, el, preview, host: null, loading: false, visible: false, hot: false };
    const hot = (v: boolean) => () => { card.hot = v; };
    el.addEventListener('pointerenter', hot(true));
    el.addEventListener('pointerleave', hot(false));
    el.addEventListener('focus', hot(true));
    el.addEventListener('blur', hot(false));
    this.cards.push(card);
    this.setBest(card, best);
    return el;
  }

  private setBest(card: Card, chip?: HTMLElement): void {
    const el = chip ?? card.el.querySelector<HTMLElement>('.chip');
    if (!el) return;
    if (!card.meta.load) { el.textContent = 'Soon'; el.className = 'chip empty'; return; }
    const b = getScores(card.meta.id).best;
    el.textContent = b == null ? 'New' : `Best ${card.meta.format(b)}`;
    el.className = b == null ? 'chip empty' : 'chip';
  }

  private refreshBests(): void { for (const c of this.cards) this.setBest(c); }

  private async ensureHost(card: Card): Promise<void> {
    if (card.host || card.loading || !card.meta.load) return;
    card.loading = true;
    try {
      const mod = await card.meta.load();
      if (!this.root.isConnected) return;
      const host = new GameHost(card.preview, mod.default(), {
        mode: card.meta.canvas, logical: card.meta.logical, preview: true, hooks: NOOP_HOOKS, maxDpr: 1.5,
      });
      host.input.enabled = false;
      host.game.start(randomSeed(), { demo: true });
      card.host = host;
    } catch (err) {
      console.warn('preview failed', card.meta.id, err);
    } finally {
      card.loading = false;
    }
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    for (const c of this.cards) {
      if (!c.host || !c.visible) continue;
      c.host.loop.minFrame = c.hot ? 0 : 1 / 30;
      c.host.frame(now);
    }
  };

  private onKey(e: KeyboardEvent): void {
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (!d) return;
    const cur = document.activeElement as HTMLElement | null;
    const playable = this.cards.filter((c) => c.meta.load).map((c) => c.el);
    if (!cur || !playable.includes(cur)) { e.preventDefault(); playable[0]?.focus(); return; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of playable) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const primary = dx * d[0] + dy * d[1];
      if (primary <= 4) continue;
      const secondary = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
      const score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { e.preventDefault(); best.focus(); best.scrollIntoView({ block: 'nearest', behavior: settings.motion ? 'smooth' : 'auto' }); }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.io.disconnect();
    for (const f of this.off) f();
    for (const c of this.cards) c.host?.destroy();
    this.root.remove();
  }
}
