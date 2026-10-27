import { GameHost } from '../engine/host';
import { randomSeed } from '../engine/rng';
import { getScores, recordScore } from '../engine/scores';
import { dailyNumber, dailyResults, dailySeed, dailyShareText, recordDaily } from '../engine/daily';
import { storage } from '../engine/storage';
import { GAMES } from '../games/registry';
import { shareCard } from './share-card';
import type { Game, GameResult, ShellHooks } from '../engine/types';
import type { GameMeta } from '../games/registry';
import { engine } from '../engine/audio';
import { Confetti } from './confetti';
import { h } from './dom';
import { ICON } from './icons';
import { openSettings, soundOn, toggleSound } from './settings-panel';
import { gameUrl, share } from './share';

type State = 'loading' | 'start' | 'playing' | 'paused' | 'dying' | 'over';

const debugFromUrl = (): boolean => /[?&]debug\b/.test(location.search) || /[?&]debug\b/.test(location.hash);

/**
 * The identical frame every game runs inside: start screen, HUD, pause,
 * game-over panel, retry. Owns the rAF loop for the active game.
 */
export class Shell {
  readonly root: HTMLElement;
  private host: GameHost | null = null;
  private state: State = 'loading';
  private raf = 0;
  private stage: HTMLElement;
  private hud: HTMLElement;
  private scoreEl: HTMLElement;
  private bestEl: HTMLElement;
  private shareBtn: HTMLButtonElement;
  private startEl: HTMLElement | null = null;
  private pauseEl: HTMLElement | null = null;
  private overEl: HTMLElement | null = null;
  private debugEl: HTMLElement | null = null;
  private debugTimer = 0;
  private score = 0;
  private overTimer = 0;
  private acceptRetryAt = 0;
  private shareText: string | null = null;
  private nextMode: string | undefined;
  private confetti = new Confetti();
  private seed = randomSeed();
  private mode: string | undefined;
  private pickEls: HTMLButtonElement[] = [];
  private disposed = false;
  private off: (() => void)[] = [];

  constructor(private meta: GameMeta, parent: HTMLElement, private daily = false) {
    this.root = h('div.pa-game', { style: `--c:${meta.color}` });
    this.stage = h('div.pa-stage');
    this.scoreEl = h('div.pa-score', { 'aria-live': 'polite' }, '0');
    this.bestEl = h('div.pa-best');
    this.shareBtn = h('button.btn.pa-share-pill', { type: 'button', onclick: () => this.shareText && void share(this.shareText) }, 'Share');
    const pauseBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Pause', html: ICON.pause, onclick: () => this.pause() });
    this.hud = h('div.pa-hud.hidden', { class: `pa-hud hidden ${meta.hud}` }, this.scoreEl, h('div.pa-hud-right', {}, this.shareBtn, this.bestEl, pauseBtn));
    this.root.append(this.stage, this.hud, h('div.pa-skeleton', {}, h('div.dot')));
    parent.append(this.root);
    this.updateBest();

    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey, true);
    this.off.push(() => window.removeEventListener('keydown', onKey, true));
    const onVis = () => { if (document.hidden) this.pause(); };
    document.addEventListener('visibilitychange', onVis);
    this.off.push(() => document.removeEventListener('visibilitychange', onVis));
    const onBlur = () => this.pause();
    window.addEventListener('blur', onBlur);
    this.off.push(() => window.removeEventListener('blur', onBlur));
  }

  async mount(): Promise<void> {
    const mod = await this.meta.load!();
    if (this.disposed) return;
    const game: Game = mod.default();
    const hooks: ShellHooks = {
      gameOver: (r, delay) => this.gameOver(r, delay),
      setScore: (n) => this.setScore(n),
      recordScore: (n) => {
        const r = recordScore(this.meta.id, n);
        this.updateBest();
        return r;
      },
      best: () => getScores(this.meta.id).best ?? 0,
      setShare: (t) => { this.shareText = t; this.shareBtn.classList.toggle('show', !!t); },
    };
    this.host = new GameHost(this.stage, game, {
      mode: this.meta.canvas, logical: this.meta.logical, preview: false, hooks,
    });
    this.host.debug.enabled = debugFromUrl();
    // Test/debug hook: inspect the running game from the console.
    if (this.host.debug.enabled) (window as unknown as { __pa: unknown }).__pa = { host: this.host, shell: this };
    this.root.querySelector('.pa-skeleton')?.remove();
    this.enterStart();
    this.syncDebug();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    this.host?.frame(now);
  };

  // ---- states -------------------------------------------------------------

  private enterStart(): void {
    const host = this.host!;
    this.state = 'start';
    host.input.enabled = false;
    host.audio.sfxOn = false;
    host.paused = false;
    host.resetFx();
    host.game.start(randomSeed(), { demo: true });
    const best = getScores(this.meta.id).best;
    const picker = this.daily ? null : this.makePicker();
    const official = this.daily ? dailyResults()[this.meta.id] : undefined;
    const dailyLine = this.daily
      ? h('div.pa-daily-badge', {}, `DAILY #${dailyNumber()}`, h('small', {}, official ? `Official: ${official.label} · this run is practice` : 'Same seed for everyone today. First run counts.'))
      : null;
    const playBtn = h('button.btn.primary.play-hint', { type: 'button', onclick: (e: Event) => { e.stopPropagation(); this.play(); } },
      matchMedia('(pointer: coarse)').matches ? 'Tap to play' : 'Click or Space to play');
    this.startEl = h('div.pa-overlay.pa-start', { onpointerdown: (e: Event) => { if (e.target === this.startEl) { e.preventDefault(); this.play(); } } },
      h('h1', {}, this.meta.title),
      h('p.tagline', {}, this.meta.tagline),
      dailyLine ?? h('div.best', {}, best == null ? 'No best yet' : `Best ${this.meta.format(best)}`),
      picker,
      playBtn,
    );
    const backBtn = h('button.icon-btn.pa-topleft', { type: 'button', 'aria-label': 'Back to hub', html: ICON.back, onclick: () => this.exit() });
    this.startEl.append(backBtn);
    this.root.append(this.startEl);
    playBtn.focus({ preventScroll: true });
  }

  /** Mode / level buttons on the start screen, when the game has them. */
  private makePicker(): HTMLElement | null {
    this.pickEls = [];
    if (!this.meta.picker) return null;
    const items = this.meta.picker();
    const saved = storage.get<string | null>(`${this.meta.id}:mode`, null);
    const open = items.filter((i) => !i.locked);
    this.mode = (open.find((i) => i.id === saved) ?? open[open.length - 1] ?? items[0])?.id;
    const wrap = h(`div.modes${items.length > 6 ? '.levels' : ''}`, { role: 'radiogroup', 'aria-label': 'Choose' });
    for (const it of items) {
      const b = h('button.btn.mode', {
        type: 'button', role: 'radio', disabled: !!it.locked, 'data-id': it.id,
        onclick: (e: Event) => { e.stopPropagation(); if (this.mode === it.id) this.play(); else this.pick(it.id); },
      }, h('span', {}, it.label), it.sub ? h('small', {}, it.sub) : null);
      this.pickEls.push(b);
      wrap.append(b);
    }
    this.pick(this.mode);
    const toggles = this.meta.toggles ?? [];
    if (!toggles.length) return wrap;
    const box = h('div.pa-toggles');
    for (const t of toggles) {
      const key = `${this.meta.id}:opt:${t.id}`;
      const input = h('input.toggle', {
        type: 'checkbox', id: `opt-${t.id}`, checked: storage.get<boolean>(key, false),
        onchange: (e: Event) => storage.set(key, (e.target as HTMLInputElement).checked),
      });
      box.append(h('label.pa-toggle', { for: `opt-${t.id}`, onpointerdown: (e: Event) => e.stopPropagation() }, input, t.label));
    }
    return h('div', {}, wrap, box);
  }

  /** The chosen mode plus any enabled start-screen toggles. */
  private fullMode(): string | undefined {
    const on = (this.meta.toggles ?? []).filter((t) => storage.get<boolean>(`${this.meta.id}:opt:${t.id}`, false)).map((t) => `+${t.id}`);
    return this.mode === undefined && !on.length ? undefined : `${this.mode ?? ''}${on.join('')}`;
  }

  private pick(id: string | undefined): void {
    this.mode = id;
    for (const b of this.pickEls) b.setAttribute('aria-checked', String(b.dataset.id === id));
  }

  private stepPick(d: number): void {
    const open = this.pickEls.filter((b) => !b.disabled);
    if (!open.length) return;
    const i = open.findIndex((b) => b.dataset.id === this.mode);
    this.pick(open[(i + d + open.length) % open.length].dataset.id);
  }

  play(mode?: string): void {
    const host = this.host;
    if (!host) return;
    if (mode !== undefined) this.mode = mode;
    if (this.mode !== undefined) storage.set(`${this.meta.id}:mode`, this.mode);
    engine.unlock();
    clearTimeout(this.overTimer);
    this.startEl?.remove(); this.startEl = null;
    this.pauseEl?.remove(); this.pauseEl = null;
    this.overEl?.remove(); this.overEl = null;
    this.confetti.stop();
    this.state = 'playing';
    host.paused = false;
    host.resetFx();
    host.input.reset();
    host.input.enabled = true;
    host.audio.sfxOn = true;
    host.audio.duck(false);
    this.hud.classList.remove('hidden');
    this.shareText = null; this.shareBtn.classList.remove('show');
    this.score = -1;
    this.setScore(0);
    this.seed = this.daily ? dailySeed(this.meta.id) : randomSeed();
    host.game.start(this.seed, { mode: this.daily ? 'daily' : this.fullMode() });
    this.root.focus?.();
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  pause(): void {
    if (this.state !== 'playing' || !this.host) return;
    this.state = 'paused';
    const host = this.host;
    host.paused = true;
    host.input.enabled = false;
    host.input.reset();
    host.game.pause();
    host.audio.duck(true);
    const resume = h('button.btn.primary', { type: 'button', onclick: () => this.resume() }, 'Resume');
    const soundBtn = h('button.btn', { type: 'button', onclick: () => { toggleSound(); soundBtn.textContent = soundLabel(); } }, soundLabel());
    this.pauseEl = h('div.pa-overlay.pa-pause', {},
      h('div.panel', {},
        h('h2', {}, 'Paused'),
        resume,
        h('button.btn', { type: 'button', onclick: () => this.play() }, 'Restart'),
        soundBtn,
        h('button.btn', { type: 'button', onclick: () => openSettings(() => resume.focus()) }, 'Settings'),
        h('button.btn', { type: 'button', onclick: () => this.exit() }, 'Exit to hub'),
      ));
    this.root.append(this.pauseEl);
    resume.focus({ preventScroll: true });
  }

  resume(): void {
    if (this.state !== 'paused' || !this.host) return;
    this.pauseEl?.remove(); this.pauseEl = null;
    this.state = 'playing';
    this.host.paused = false;
    this.host.input.enabled = true;
    this.host.audio.duck(false);
    this.host.game.resume();
  }

  private gameOver(result: GameResult, delayMs = 650): void {
    if (this.state !== 'playing' || !this.host) return;
    this.state = 'dying';
    this.host.input.enabled = false;
    this.overTimer = window.setTimeout(() => this.showOver(result), delayMs);
  }

  private showOver(r: GameResult): void {
    const host = this.host;
    if (!host || this.state !== 'dying') return;
    this.state = 'over';
    const rec = recordScore(this.meta.id, r.score);
    const dailyRec = this.daily ? recordDaily(this.meta.id, r.score, r.dailyLabel ?? this.meta.format(r.score)) : null;
    const snapshot = this.snapshot();
    this.updateBest();
    host.audio.duck(true);
    this.hud.classList.add('hidden');

    const big = h('div.big', {}, this.meta.format(0));
    const next = r.next;
    const nextBtn = next ? h('button.btn.primary', { type: 'button', onclick: () => this.play(next.mode) }, next.label) : null;
    const retry = h(next ? 'button.btn' : 'button.btn.primary', { type: 'button', onclick: () => this.play() }, 'Retry');
    this.nextMode = next?.mode;
    const titles = Object.fromEntries(GAMES.map((g) => [g.id, g.title]));
    const text = dailyRec ? dailyShareText(titles)
      : r.share ?? `Pocket Arcade - ${this.meta.title}: ${this.meta.format(r.score)} ${this.meta.unit === '%' ? '' : this.meta.unit} | ${gameUrl(this.meta.id)}`.replace('  ', ' ');
    const image = () => void shareCard({
      title: this.meta.title, color: this.meta.color, score: r.noScore ? (r.rank ?? r.title ?? '') : this.meta.format(r.score),
      unit: r.noScore || this.meta.unit === '%' ? '' : this.meta.unit,
      line: rec.isNewBest ? 'NEW BEST!' : r.noScore ? (r.title ?? '') : `Best ${this.meta.format(rec.best)}`,
      stats: r.stats, url: gameUrl(this.meta.id), daily: this.daily ? `Daily #${dailyNumber()}` : undefined,
    }, snapshot, text, `pocket-arcade-${this.meta.id}`);
    const panel = h('div.panel', { role: 'dialog', 'aria-label': 'Game over' },
      h('div.headline', {}, r.title ?? 'Game over'),
      r.noScore ? null : big,
      r.noScore || this.meta.unit === '%' ? null : h('div.unit', {}, this.meta.unit),
      r.noScore ? null : rec.isNewBest ? h('div.newbest', {}, 'NEW BEST!') : h('div.bestline', {}, `Best ${this.meta.format(rec.best)}`),
      r.rank ? h('div.rank', {}, r.rank) : null,
      dailyRec ? h('div.pa-daily-result', {}, dailyRec.official ? `Official daily score: ${dailyRec.entry.label}` : `Practice run · official: ${dailyRec.entry.label}`) : null,
      r.stats.length ? h('div.stats', {}, ...r.stats.map((s) => h('div.stat', {}, h('b', {}, s.value), h('span', {}, s.label)))) : null,
      h(`div.buttons${nextBtn ? '.has-next' : ''}`, {},
        nextBtn,
        retry,
        h('button.btn', { type: 'button', onclick: () => void share(text) }, 'Share'),
        h('button.btn', { type: 'button', onclick: image, 'aria-label': 'Share image' }, 'Image'),
        h('button.btn', { type: 'button', onclick: () => this.exit() }, 'Hub'),
      ),
      matchMedia('(pointer: fine)').matches ? h('div.kbd-hint', {}, next ? `Enter: ${next.label} · R: retry` : 'Space / Enter / R to retry') : null,
    );
    this.overEl = h('div.pa-over.pa-overlay', {}, panel);
    this.root.append(this.overEl);
    (nextBtn ?? retry).focus({ preventScroll: true });
    this.acceptRetryAt = performance.now() + 180;

    // Count the score up with ticks.
    const t0 = performance.now(), dur = Math.min(900, 300 + r.score * 20);
    let lastShown = '';
    const step = (now: number) => {
      if (this.state !== 'over' || !big.isConnected) return;
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const shown = this.meta.format(this.meta.unit === '%' ? r.score * e : Math.round(r.score * e));
      if (shown !== lastShown) { big.textContent = shown; lastShown = shown; host.audio.tick(1400 + 800 * e, 0.04); }
      if (k < 1) requestAnimationFrame(step);
      else if (rec.isNewBest) { this.confetti.fire(); host.audio.fanfare(); }
    };
    requestAnimationFrame(step);
  }

  /** Copy of the final frame for the share card. */
  private snapshot(): HTMLCanvasElement | null {
    const src = this.host?.canvas.el;
    if (!src) return null;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    try { c.getContext('2d')!.drawImage(src, 0, 0); } catch { return null; }
    return c;
  }

  private setScore(n: number): void {
    if (n === this.score) return;
    this.score = n;
    this.scoreEl.textContent = this.meta.format(n);
    this.scoreEl.classList.remove('pop');
    void this.scoreEl.offsetWidth;
    this.scoreEl.classList.add('pop');
  }

  private updateBest(): void {
    const b = getScores(this.meta.id).best;
    this.bestEl.textContent = b == null ? '' : `Best ${this.meta.format(b)}`;
  }

  private exit(): void { location.hash = '#/'; }

  private onKey(e: KeyboardEvent): void {
    if (document.querySelector('.modal-back')) return;
    const code = e.code;
    if (code === 'F3') { e.preventDefault(); if (this.host) { this.host.debug.enabled = !this.host.debug.enabled; this.syncDebug(); } return; }
    const consume = () => { e.preventDefault(); e.stopPropagation(); };
    switch (this.state) {
      case 'start':
        if (code === 'Space' || code === 'Enter') { consume(); this.play(); }
        else if (code === 'Escape') { consume(); this.exit(); }
        else if (this.pickEls.length && (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'ArrowUp' || code === 'ArrowDown')) {
          consume(); this.stepPick(code === 'ArrowLeft' || code === 'ArrowUp' ? -1 : 1);
        }
        break;
      case 'playing':
        if (code === 'Escape' || code === 'KeyP') { consume(); this.pause(); }
        break;
      case 'paused':
        if (code === 'Escape' || code === 'KeyP') { consume(); this.resume(); }
        else if (code === 'KeyR') { consume(); this.play(); }
        break;
      case 'dying':
        if (code === 'Space' || code === 'Enter') consume();
        break;
      case 'over':
        if (code === 'Space' || code === 'Enter' || code === 'KeyR') {
          consume();
          if (!e.repeat && performance.now() >= this.acceptRetryAt) this.play(code !== 'KeyR' ? this.nextMode : undefined);
        } else if (code === 'Escape' || code === 'KeyH') { consume(); this.exit(); }
        break;
    }
  }

  private syncDebug(): void {
    const on = !!this.host?.debug.enabled;
    clearInterval(this.debugTimer);
    if (!on) { this.debugEl?.remove(); this.debugEl = null; return; }
    if (!this.debugEl) { this.debugEl = h('div.pa-debug'); this.root.append(this.debugEl); }
    const upd = () => {
      const host = this.host;
      if (!host || !this.debugEl) return;
      const lines = [`fps ${host.loop.fps.toFixed(0)}`, `state ${this.state}`, `particles ${host.ctx.fx.particles.live}`,
        `logical ${Math.round(host.canvas.w)}x${Math.round(host.canvas.h)} dpr ${host.canvas.dpr}`];
      let info: Record<string, number | string> = {};
      try { info = host.game.debugInfo?.() ?? {}; } catch { /* debug must never break the game */ }
      for (const [k, v] of Object.entries(info)) lines.push(`${k} ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`);
      this.debugEl.textContent = lines.join('\n');
    };
    upd();
    this.debugTimer = window.setInterval(upd, 250);
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.overTimer);
    clearInterval(this.debugTimer);
    for (const f of this.off) f();
    this.confetti.stop();
    this.host?.audio.stopMusic();
    this.host?.audio.duck(false);
    this.host?.destroy();
    this.host = null;
    this.root.remove();
  }
}

function soundLabel(): string { return soundOn() ? 'Sound: On' : 'Sound: Off'; }
// Re-export so the hub can share the sound toggle icon logic.
export { ICON, soundOn, toggleSound };
