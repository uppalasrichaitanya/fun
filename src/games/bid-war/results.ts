import type { AudioBus } from '../../engine/audio';
import { settings } from '../../engine/settings';
import { Confetti } from '../../shell/confetti';
import { h, toast } from '../../shell/dom';
import { share } from '../../shell/share';
import { cardEl } from './card-view';
import { CivilWarView } from './civil-war';
import { MUSIC_REVEAL } from './config';
import { recordMatch, type MatchRecord } from './history';
import { openHistory } from './history-view';
import type { Auction } from './rules';
import { autoScore, awards, civilWar, judgePrompt, modeLabel, spentOf, summaryText, type Award, type AutoScore, type CivilWar } from './scoring';
import type { SetupResult } from './setup';
import type { BidSfx } from './sfx';
import { saveShareImage } from './share-image';
import type { PlayerIdx } from './types';

export interface ResultsOpts {
  setup: SetupResult;
  auction: Auction;
  audio: AudioBus;
  sfx: BidSfx;
  onRematch: () => void;
  onNew: () => void;
  onHub: () => void;
}

const PACK = { cricket: 'Cricket', pokemon: 'Pokemon', heroes: 'Superheroes' } as const;

/** Reveal, awards, then the four ways to settle it. */
export class Results {
  readonly root: HTMLElement;
  private score: AutoScore;
  private war: CivilWar | null;
  private awards: Award[];
  private names: [string, string];
  private record: MatchRecord;
  private timers: number[] = [];
  private revealing = true;
  private flipQueue: HTMLElement[] = [];
  private settle!: HTMLElement;
  private out!: HTMLElement;
  private awardsEl!: HTMLElement;
  private confetti = new Confetti();
  private overlay: { destroy(): void } | null = null;
  private onKeyBound = (e: KeyboardEvent) => this.onKey(e);
  private vote: { picks: [PlayerIdx | null, PlayerIdx | null]; el: HTMLElement } | null = null;

  constructor(parent: HTMLElement, private o: ResultsOpts) {
    const st = o.auction.state;
    this.names = o.setup.names;
    this.war = st.settings.pack === 'heroes' ? civilWar(st) : null;
    this.score = autoScore(st, this.war?.winner ?? null);
    this.awards = awards(st, this.names);
    this.record = {
      id: `${o.setup.code}-${Date.now()}`, date: Date.now(), pack: st.settings.pack, squadSize: st.settings.squadSize,
      names: this.names, winner: this.score.winner, totals: [this.score.teams[0].total, this.score.teams[1].total], via: 'auto', code: o.setup.code,
    };
    recordMatch(this.record);

    const s = st.settings;
    this.root = h('div.bwr', { style: '--p1:var(--pink);--p2:var(--cyan)' },
      h('header.bwr-head', {},
        h('span.bw-logo', {}, 'BID WAR'),
        h('span.bwr-sub', {}, `${PACK[s.pack]} · ${modeLabel(s)} · ${s.squadSize}-a-side · $${st.purseStart} purses · match ${o.setup.code}`),
        h('button.btn.bwr-skip', { type: 'button', onclick: () => this.skipReveal() }, 'Skip ', h('kbd', {}, 'Space'))),
      h('div.bwr-teams', {}, this.team(0), this.team(1)),
      this.awardsEl = h('div.bwr-awards'),
      this.settle = h('section.bwr-settle', { hidden: true }),
    );
    parent.append(this.root);
    window.addEventListener('keydown', this.onKeyBound, true);
    o.audio.music(MUSIC_REVEAL);
    o.audio.duck(true);
    this.startReveal();
  }

  private team(p: PlayerIdx): HTMLElement {
    const st = this.o.auction.state, pl = st.players[p];
    // Cheapest first, so the big buys land last.
    const squad = [...pl.squad].sort((a, b) => a.price - b.price || a.card.rating - b.card.rating);
    const grid = h('div.bwr-grid', { 'data-size': String(st.settings.squadSize) });
    for (const b of squad) {
      const flip = h('div.bwr-flip', { 'data-p': String(p), 'data-price': String(b.price) },
        h('div.bwr-back', {}, h('span', {}, '?')),
        h('div.bwr-front', {}, cardEl(b.card, st.settings, 'md'),
          h('span.bwr-price', {}, b.how === 'free' ? 'FREE (all-in)' : b.how === 'reserve' ? 'FREE (leftover)' : `$${b.price}`)));
      grid.append(flip);
    }
    return h(`section.bwr-team.p${p + 1}`, {},
      h('h2', {}, this.names[p]),
      h('div.bwr-money', {}, `Spent $${spentOf(pl.squad)} · Left $${pl.purse}`),
      grid);
  }

  private startReveal(): void {
    const cols = [0, 1].map((p) => [...this.root.querySelectorAll<HTMLElement>(`.bwr-team.p${p + 1} .bwr-flip`)]);
    const seq: HTMLElement[] = [];
    for (let i = 0; i < Math.max(cols[0].length, cols[1].length); i++) for (const c of cols) if (c[i]) seq.push(c[i]);
    this.flipQueue = seq;
    const step = Math.min(420, 6000 / Math.max(1, seq.length));
    seq.forEach((el, i) => this.timers.push(window.setTimeout(() => this.flip(el, i), 500 + i * step)));
    this.timers.push(window.setTimeout(() => this.showAwards(), 700 + seq.length * step));
  }

  private flip(el: HTMLElement, i: number): void {
    if (el.classList.contains('up')) return;
    el.classList.add('up');
    this.o.sfx.coin(Math.min(14, i));
  }

  private skipReveal(): void {
    if (!this.revealing) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const el of this.flipQueue) el.classList.add('up', 'instant');
    this.showAwards(true);
  }

  private showAwards(instant = false): void {
    if (!this.revealing) return;
    this.revealing = false;
    this.root.querySelector('.bwr-skip')?.remove();
    this.awardsEl.replaceChildren(...this.awards.map((a, i) => h(`div.bwr-award${a.p === null ? '' : `.p${a.p + 1}`}`, { style: `animation-delay:${instant ? 0 : i * 260}ms` },
      h('b', {}, a.title), h('span', {}, a.text))));
    if (!instant) this.awards.forEach((_, i) => this.timers.push(window.setTimeout(() => this.o.sfx.stamp(), i * 260)));
    this.timers.push(window.setTimeout(() => this.showSettle(), instant ? 0 : this.awards.length * 260 + 300));
  }

  // ---- settle ------------------------------------------------------------------

  private showSettle(): void {
    const pack = this.o.auction.state.settings.pack;
    const btn = (label: string, sub: string, fn: () => void, cls = '') => h(`button.bwr-way${cls}`, { type: 'button', onclick: fn }, h('b', {}, label), h('small', {}, sub));
    this.out = h('div.bwr-out', { 'aria-live': 'polite' });
    this.settle.replaceChildren(
      h('h2', {}, 'Settle it'),
      h('div.bwr-ways', {},
        btn('Auto score', 'Strength + Balance + Value', () => this.showAuto(), '.primary'),
        pack === 'heroes' ? btn('Civil War', 'Watch the teams fight', () => this.showWar()) : null,
        btn('Copy for AI judge', 'Paste into ChatGPT or Claude', () => void this.copyJudge()),
        btn('You decide', 'Secret vote, Q/W and O/P', () => this.startVote()),
      ),
      this.out,
      h('div.bwr-actions', {},
        h('button.btn.primary', { type: 'button', onclick: () => this.o.onRematch() }, 'Rematch'),
        h('button.btn', { type: 'button', onclick: () => void this.shareImage() }, 'Share image'),
        h('button.btn', { type: 'button', onclick: () => void share(summaryText(this.o.auction.state, this.names, this.score, this.awards)) }, 'Copy as text'),
        h('button.btn', { type: 'button', onclick: () => this.o.onNew() }, 'New auction'),
        h('button.btn', { type: 'button', onclick: () => openHistory() }, 'History'),
        h('button.btn', { type: 'button', onclick: () => this.o.onHub() }, 'Hub'),
      ),
    );
    this.settle.hidden = false;
    this.o.audio.duck(false);
    if (settings.motion) this.settle.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.settle.querySelector<HTMLElement>('.bwr-way')?.focus({ preventScroll: true });
  }

  private showAuto(): void {
    const sc = this.score;
    const SCALE = 140;
    const row = (p: PlayerIdx) => {
      const t = sc.teams[p];
      const seg = (cls: string, v: number, label: string) => v > 0
        ? h(`i.${cls}`, { style: `--w:${(v / SCALE) * 100}%`, title: `${label} ${v}` }, h('span', {}, v >= 12 ? `${label} ${Math.round(v)}` : `+${Math.round(v)}`))
        : null;
      const total = h('b.bwr-total', {}, '0');
      this.countUp(total, t.total);
      return h(`div.bwr-scorerow.p${p + 1}${sc.winner === p ? '.win' : ''}`, {},
        h('div.bwr-scorename', {}, this.names[p], sc.winner === p ? h('span.crown', {}, 'WINNER') : null),
        h('div.bwr-bar', {},
          seg('str', t.strength, 'Strength'), seg('bal', Math.max(0, t.balance), 'Balance'), seg('val', t.value, 'Value'), seg('bat', t.battle, 'Battle')),
        total,
        h('div.bwr-notes', {}, [...t.notes, t.balance < 0 ? `Balance ${t.balance}` : '', t.value ? 'Best rating per dollar: +5' : '', t.battle ? 'Won the Civil War: +10' : ''].filter(Boolean).join(' · ')),
      );
    };
    const verdict = sc.winner === null ? 'Dead heat. Nobody wins. Everybody loses.'
      : `${this.names[sc.winner]} wins the auction${sc.tiebreak ? ' on the best single player (exact tie)' : ''}!`;
    this.out.replaceChildren(h('div.bwr-auto', {}, row(0), row(1), h('div.bwr-verdict', {}, verdict)));
    this.celebrate(sc.winner);
  }

  private countUp(el: HTMLElement, to: number): void {
    const t0 = performance.now(), dur = settings.motion ? 1100 : 0;
    const step = (now: number) => {
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      el.textContent = (to * (1 - Math.pow(1 - k, 3))).toFixed(1);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private celebrate(winner: PlayerIdx | null): void {
    if (winner === null) { this.o.sfx.scratch(); return; }
    this.timers.push(window.setTimeout(() => { this.o.sfx.fanfare(); this.confetti.fire(); }, settings.motion ? 1100 : 0));
  }

  private showWar(): void {
    if (!this.war) return;
    this.overlay?.destroy();
    this.o.audio.duck(true);
    this.overlay = new CivilWarView(document.body, this.o.auction.state, this.names, this.war, this.o.sfx, () => {
      this.overlay?.destroy();
      this.overlay = null;
      this.o.audio.duck(false);
      const w = this.war!;
      this.out.replaceChildren(h('div.bwr-war', {},
        ...w.rounds.map((r) => h(`div.bwr-round${r.winner === null ? '' : `.p${r.winner + 1}`}`, {},
          h('b', {}, r.name), h('span', {}, `${this.names[0]} ${r.totals[0]} - ${r.totals[1]} ${this.names[1]}`),
          h('em', {}, r.winner === null ? 'Draw' : this.names[r.winner]))),
        h('div.bwr-verdict', {}, w.winner === null ? 'The Civil War ends in a stalemate.' : `${this.names[w.winner]} wins the Civil War ${Math.max(...w.wins)}-${Math.min(...w.wins)} (+10 in auto score)`)));
      this.celebrate(w.winner);
    });
  }

  private async copyJudge(): Promise<void> {
    const text = judgePrompt(this.o.auction.state, this.names, this.awards);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* shown below for manual copy */ }
    const ta = h('textarea.bwr-prompt', { readonly: true, rows: 12, 'aria-label': 'AI judge prompt' });
    ta.value = text;
    this.out.replaceChildren(h('div.bwr-judge', {},
      h('div.bwr-verdict', {}, copied ? 'Copied! Paste into ChatGPT or Claude' : 'Select the text below and copy it'), ta));
    if (copied) toast('Copied! Paste into ChatGPT or Claude');
    else { ta.focus(); ta.select(); }
  }

  // ---- you decide ----------------------------------------------------------------

  private startVote(): void {
    const el = h('div.bwr-vote');
    this.vote = { picks: [null, null], el };
    this.drawVote();
    this.out.replaceChildren(el);
  }

  private drawVote(): void {
    const v = this.vote!;
    const n = this.names;
    const side = (p: PlayerIdx) => {
      const keys = p === 0 ? ['Q', 'W'] : ['O', 'P'];
      const voted = v.picks[p] !== null;
      return h(`div.bwr-voter.p${p + 1}${voted ? '.done' : ''}`, {},
        h('b', {}, n[p]),
        voted ? h('span', {}, 'Vote locked in') : h('span', {}, `${keys[0]} = ${n[0]} · ${keys[1]} = ${n[1]}`),
        voted ? null : h('div.bwr-votebtns', {},
          h('button.btn', { type: 'button', onclick: () => this.cast(p, 0) }, n[0]),
          h('button.btn', { type: 'button', onclick: () => this.cast(p, 1) }, n[1])),
      );
    };
    v.el.replaceChildren(h('p', {}, 'Who won? Vote in secret. No peeking.'), h('div.bwr-voters', {}, side(0), side(1)));
  }

  private cast(p: PlayerIdx, pick: PlayerIdx): void {
    const v = this.vote;
    if (!v || v.picks[p] !== null) return;
    v.picks[p] = pick;
    this.o.sfx.gavelTap();
    if (v.picks[0] === null || v.picks[1] === null) { this.drawVote(); return; }
    const [a, b] = v.picks as [PlayerIdx, PlayerIdx];
    const sc = this.score;
    let text: string, winner: PlayerIdx | null;
    if (a === b) {
      winner = a;
      text = `Unanimous: ${this.names[a]} wins.${a !== sc.winner && sc.winner !== null ? ' (Auto score disagrees, but who asked.)' : ''}`;
    } else {
      winner = sc.winner;
      const tie = sc.winner === null ? 'and auto score calls it a dead heat.' : `so auto score breaks the tie: ${this.names[sc.winner]} wins.`;
      text = a === 0 && b === 1 ? `You both voted for yourselves. Shocking. ${tie[0].toUpperCase()}${tie.slice(1)}` : `Split decision, ${tie}`;
    }
    v.el.replaceChildren(h('div.bwr-verdict', {}, text),
      h('div.bwr-votes', {}, `${this.names[0]} voted ${this.names[a]} · ${this.names[1]} voted ${this.names[b]}`));
    this.record = { ...this.record, winner, via: a === b ? 'vote' : 'auto' };
    recordMatch(this.record);
    this.vote = null;
    this.celebrate(winner);
  }

  private async shareImage(): Promise<void> {
    try {
      await saveShareImage(this.o.auction.state, this.names, this.score, this.awards, this.o.setup.code);
    } catch (e) {
      console.warn(e);
      toast('Could not make the image');
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (document.querySelector('.modal-back') || this.overlay) return;
    if (this.revealing && (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape')) { e.preventDefault(); this.skipReveal(); return; }
    if (this.vote && !e.repeat) {
      const map: Record<string, [PlayerIdx, PlayerIdx]> = { KeyQ: [0, 0], KeyW: [0, 1], KeyO: [1, 0], KeyP: [1, 1] };
      const m = map[e.code];
      if (m) { e.preventDefault(); this.cast(m[0], m[1]); }
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyBound, true);
    for (const t of this.timers) clearTimeout(t);
    this.overlay?.destroy();
    this.confetti.stop();
    this.o.audio.duck(false);
    this.root.remove();
  }
}
