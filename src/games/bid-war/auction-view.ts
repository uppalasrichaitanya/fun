import type { AudioBus } from '../../engine/audio';
import { Particles } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { settings } from '../../engine/settings';
import { C } from '../../engine/theme';
import { h } from '../../shell/dom';
import { ICON } from '../../shell/icons';
import { CRICKET_COLOR, HERO_SHORT, cardEl } from './card-view';
import { Commentary, type Moment, type Vars } from './commentary';
import { allInMinSlots, BASE_PRICE, MUSIC, MUSIC_WAR, OVERSEAS_CAP, ROLE_MIN, TIMING, WAR_BIDS } from './config';
import { HERO_ROLES } from './pool';
import { Auction, type AuctionEvent, type PlayerAction, type Reject } from './rules';
import { cricketRoles } from './scoring';
import type { SetupResult } from './setup';
import type { BidSfx } from './sfx';
import type { Card, PlayerIdx } from './types';

const W = 1280, H = 720;
const PC = [C.pink, C.cyan] as const;
type KeyRole = 'bid1' | 'bid5' | 'pass' | 'hold';
const KEYS: Record<string, [PlayerIdx, KeyRole]> = {
  KeyQ: [0, 'bid1'], KeyW: [0, 'bid5'], KeyE: [0, 'pass'], KeyR: [0, 'hold'],
  KeyP: [1, 'bid1'], KeyO: [1, 'bid5'], KeyI: [1, 'pass'], KeyU: [1, 'hold'],
};
const KEY_LABEL: [string[], string[]] = [['Q', 'W', 'E', 'R'], ['P', 'O', 'I', 'U']];

const REASON: Record<Reject, string> = {
  'no-lot': '', locked: 'Locked: takes what\'s left', full: 'Squad full', cap: 'Cap reached', passed: 'You passed this lot',
  leading: 'You are leading', max: 'Over your max bid', 'too-late': 'Too late!', 'leader-pass': 'Leader can\'t pass',
  'all-in-used': 'All-in already used', 'all-in-closed': 'All-in closed', 'all-in-hidden': 'No all-in now', 'cant-afford': 'Can\'t afford it',
  'solo-only': 'Take or leave only', 'not-solo': '',
};

interface Panel {
  root: HTMLElement;
  purse: HTMLElement;
  ring: SVGCircleElement;
  max: HTMLElement;
  allIn: HTMLElement;
  squad: HTMLElement;
  roles: HTMLElement;
  why: HTMLElement;
  tag: HTMLElement;
  touch: HTMLButtonElement[];
  shown: number;           // displayed purse (tweened)
  squadKey: string;
  whyT: number;
}

interface Coin { x0: number; y0: number; x1: number; y1: number; t: number; color: string }

export interface AuctionViewOpts {
  setup: SetupResult;
  pool: Card[];
  purse: number;
  audio: AudioBus;
  sfx: BidSfx;
  onEnd: (a: Auction) => void;
  onQuit: (toHub: boolean) => void;
}

/** The auction screen: 1280 x 720 logical, letterboxed to fit. */
export class AuctionView {
  readonly root: HTMLElement;
  readonly auction: Auction;
  private stage: HTMLElement;
  private fx: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private particles = new Particles(new Rng());
  private coins: Coin[] = [];
  private panels: [Panel, Panel];
  private els: Record<string, HTMLElement> = {};
  private ringEl!: SVGCircleElement;
  private keyChips: HTMLElement[][] = [[], []];
  private cardNode: HTMLElement | null = null;
  private hidden = new Set<string>();
  private commentary: Commentary;
  private commentText = '';
  private commentShown = 0;
  private holds: [number | null, number | null] = [null, null];
  private scale = 1;
  private raf = 0;
  private last = -1;
  private paused = false;
  private pauseEl: HTMLElement | null = null;
  private slowmo = 0;
  private renderedBids = 0;
  private endTimer = 0;
  private timers: number[] = [];
  private names: [string, string];
  private mainTotal: number;
  private roundStart = 0;
  private upcomingOpen = true;
  private off: (() => void)[] = [];
  private warOn = false;

  constructor(parent: HTMLElement, private o: AuctionViewOpts) {
    const { setup } = o;
    this.names = setup.names;
    this.mainTotal = o.pool.length;
    this.auction = new Auction(setup.settings, o.pool, o.purse, setup.seed);
    this.commentary = new Commentary(new Rng(setup.seed ^ 0xc0ffee), setup.settings.pack);

    this.fx = h('canvas.bwa-fx', { width: W, height: H });
    this.g = this.fx.getContext('2d')!;
    this.panels = [this.makePanel(0), this.makePanel(1)];
    this.stage = h('div.bwa-stage', {},
      this.makeCenter(), this.makeKeyBar(), h('div.bwa-dim'), this.panels[0].root, this.panels[1].root,
      this.fx,
      this.els.banner = h('div.bwa-banner'),
      this.els.flash = h('div.bwa-flash'),
      this.els.undo = h('button.bwa-undo', { type: 'button', onclick: () => this.undo() }, 'Undo ', h('kbd', {}, 'Ctrl+Z'), h('i')),
    );
    this.root = h('div.bwa', { style: `--p1:${PC[0]};--p2:${PC[1]}` }, this.stage);
    parent.append(this.root);

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    const onUp = (e: KeyboardEvent) => this.onKeyUp(e);
    const onResize = () => this.fit();
    const onBlur = () => this.pause();
    const onVis = () => { if (document.hidden) this.pause(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    this.off.push(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    });
    this.fit();
    this.upcomingOpen = setup.settings.showUpcoming;
    o.audio.music(MUSIC);
    this.handle(this.auction.begin());
    const op = setup.opener;
    this.say(`${this.names[op]} won the toss and opens the bidding. Good luck, ${this.names[op === 0 ? 1 : 0]}.`);
    this.panels[op].tag.textContent = 'Opens Lot 1';
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---- layout ----------------------------------------------------------------

  private fit(): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    this.scale = Math.min(vw / W, vh / H);
    this.stage.style.transform = `translate(${(vw - W * this.scale) / 2}px, ${(vh - H * this.scale) / 2}px) scale(${this.scale})`;
    const dpr = Math.min(2, window.devicePixelRatio || 1) * Math.max(1, this.scale);
    const pw = Math.round(W * Math.min(2, dpr)), ph = Math.round(H * Math.min(2, dpr));
    if (this.fx.width !== pw) { this.fx.width = pw; this.fx.height = ph; }
  }

  private makePanel(p: PlayerIdx): Panel {
    const purse = h('div.bwa-purse');
    const svgNs = 'http://www.w3.org/2000/svg';
    const ringSvg = document.createElementNS(svgNs, 'svg');
    ringSvg.setAttribute('viewBox', '0 0 100 100');
    ringSvg.classList.add('bwa-hold');
    const ring = document.createElementNS(svgNs, 'circle');
    ring.setAttribute('cx', '50'); ring.setAttribute('cy', '50'); ring.setAttribute('r', '46');
    ringSvg.append(ring);
    const keys = KEY_LABEL[p];
    const touch = (['+1', '+5', 'Pass', 'ALL-IN'] as const).map((label, i) => {
      const role: KeyRole = (['bid1', 'bid5', 'pass', 'hold'] as const)[i];
      const b = h('button.bwa-tbtn', { type: 'button', 'data-role': role }, h('span', {}, label), h('small', {}, keys[i]));
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.press(p, role); });
      if (role === 'hold') {
        for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => this.release(p));
      }
      return b;
    });
    const panel: Panel = {
      root: h(`section.bwa-panel.p${p + 1}`, { 'aria-label': `Player ${p + 1}` }),
      purse, ring, touch,
      max: h('div.bwa-max'), allIn: h('div.bwa-allin'), squad: h('div.bwa-squad'), roles: h('div.bwa-roles'),
      why: h('div.bwa-why'), tag: h('div.bwa-tag'), shown: this.o.purse, squadKey: '', whyT: 0,
    };
    panel.root.append(
      h('div.bwa-pname', {}, this.o.setup.names[p], panel.tag),
      h('div.bwa-pursewrap', {}, ringSvg, purse, h('span.bwa-purse-label', {}, 'purse')),
      panel.max, panel.allIn, panel.why,
      panel.squad, panel.roles,
      h('div.bwa-touch', {}, ...touch),
      h('div.bwa-chains', {}, h('span', {}, 'ALL-IN: takes what\'s left')),
    );
    return panel;
  }

  private makeCenter(): HTMLElement {
    const e = this.els;
    const svgNs = 'http://www.w3.org/2000/svg';
    const ring = document.createElementNS(svgNs, 'svg');
    ring.setAttribute('viewBox', '0 0 100 100');
    ring.classList.add('bwa-ring');
    const track = document.createElementNS(svgNs, 'circle');
    track.setAttribute('cx', '50'); track.setAttribute('cy', '50'); track.setAttribute('r', '44'); track.classList.add('track');
    this.ringEl = document.createElementNS(svgNs, 'circle');
    this.ringEl.setAttribute('cx', '50'); this.ringEl.setAttribute('cy', '50'); this.ringEl.setAttribute('r', '44');
    ring.append(track, this.ringEl);
    e.upToggle = h('button.bwa-uptoggle', { type: 'button', onclick: () => { this.upcomingOpen = !this.upcomingOpen; this.renderUpcoming(); } }, 'Upcoming');
    return h('section.bwa-center', {},
      h('div.bwa-lothead', {}, e.lotNo = h('span.bwa-lotno'), e.badges = h('span.bwa-badges'), h('span.bwa-code', {}, `Match ${this.o.setup.code}`), e.upToggle,
        h('button.icon-btn.bwa-pausebtn', { type: 'button', 'aria-label': 'Pause', html: ICON.pause, onclick: () => this.pause() })),
      e.upcoming = h('div.bwa-upcoming'),
      e.cardSlot = h('div.bwa-cardslot', {}, e.call = h('div.bwa-call'), e.stamp = h('div.bwa-stamp'), h('div.bwa-gavel', { 'aria-hidden': 'true' })),
      h('div.bwa-pricerow', {},
        h('div.bwa-base', {}, h('small', {}, 'Base'), e.base = h('b')),
        h('div.bwa-current', {}, h('small', {}, 'Current bid'), e.price = h('div.bwa-price')),
        h('div.bwa-timer', {}, ring, e.timerText = h('span')),
      ),
      e.leader = h('div.bwa-leader'),
      e.ticker = h('div.bwa-ticker'),
      e.comment = h('div.bwa-comment', { 'aria-live': 'polite' }),
      e.tray = h('div.bwa-tray', {}, h('small', {}, 'Unsold'), e.trayList = h('div')),
    );
  }

  private makeKeyBar(): HTMLElement {
    const side = (p: PlayerIdx) => {
      const wrap = h(`div.bwa-keyside.p${p + 1}`);
      ['+1', '+5', 'pass', 'hold ALL-IN'].forEach((label, i) => {
        const chip = h('span.bwa-key', {}, h('kbd', {}, KEY_LABEL[p][i]), h('span', {}, label));
        this.keyChips[p].push(chip);
        wrap.append(chip);
      });
      return wrap;
    };
    return h('footer.bwa-keys', {}, side(0), h('span.bwa-keys-mid', {}, 'Esc pause'), side(1));
  }

  // ---- input -----------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (document.querySelector('.modal-back')) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); this.undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape') { e.preventDefault(); if (this.paused) this.resume(); else this.pause(); return; }
    if (this.paused) {
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); this.resume(); }
      return;
    }
    const k = KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    if (e.repeat) return;
    this.press(k[0], k[1]);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const k = KEYS[e.code];
    if (k && k[1] === 'hold') this.release(k[0]);
  }

  private press(p: PlayerIdx, role: KeyRole): void {
    if (this.paused) return;
    const a = this.auction, lot = a.state.lot;
    if (role === 'hold') {
      if (a.allInBlock(p) === null) { this.holds[p] = 0; this.root.classList.add('holding'); }
      else this.reject(p, 'allIn', a.allInBlock(p)!);
      return;
    }
    let type: PlayerAction = role;
    if (lot?.solo === p) type = role === 'pass' ? 'leave' : role === 'bid1' ? 'take' : role;
    this.handle(a.dispatch({ type, p, seen: this.renderedBids }));
  }

  private release(p: PlayerIdx): void {
    if (this.holds[p] === null) return;
    this.holds[p] = null;
    if (this.holds[0] === null && this.holds[1] === null) this.root.classList.remove('holding');
  }

  private undo(): void {
    if (this.paused) return;
    this.handle(this.auction.dispatch({ type: 'undo' }));
  }

  // ---- events → feel -------------------------------------------------------------

  private vars(extra: Vars = {}): Vars {
    const st = this.auction.state, lot = st.lot;
    const leader = lot?.leader ?? null;
    return {
      P1: this.names[0], P2: this.names[1],
      card: lot?.card.name ?? '', base: lot ? BASE_PRICE[lot.card.tier] : 0, lot: lot?.n ?? 0,
      price: lot?.price ?? 0, next: (lot?.price ?? 0) + 1,
      leader: leader === null ? '' : this.names[leader], trailer: leader === null ? '' : this.names[leader === 0 ? 1 : 0],
      ...extra,
    };
  }

  private say(text: string): void { this.commentText = text; this.commentShown = 0; }
  private line(m: Moment, extra: Vars = {}): void { this.say(this.commentary.line(m, this.vars(extra))); }

  private handle(events: AuctionEvent[]): void {
    const { sfx } = this.o;
    for (const ev of events) {
      switch (ev.type) {
        case 'lot': this.onLot(); break;
        case 'bid': this.onBid(ev.p, ev.jump, ev.count, ev.war); break;
        case 'reject': this.reject(ev.p, ev.action, ev.reason); break;
        case 'pass':
          this.panels[ev.p].root.classList.add('passed');
          sfx.tick();
          break;
        case 'goingOnce': this.call('GOING ONCE'); sfx.gavelTap(); this.line('once'); break;
        case 'goingTwice':
          this.call('GOING TWICE'); sfx.gavelTap(); this.timers.push(window.setTimeout(() => sfx.gavelTap(), 140)); this.line('twice');
          break;
        case 'allIn': this.onAllIn(ev.p, ev.amount); break;
        case 'allInFailed':
          this.panels[ev.p].purse.classList.remove('crack'); void this.panels[ev.p].purse.offsetWidth;
          this.panels[ev.p].purse.classList.add('crack');
          this.banner('OUTBID!', PC[ev.by]);
          sfx.scratch();
          this.line('allInFailed', { player: this.names[ev.p], other: this.names[ev.by] });
          break;
        case 'sold': this.onSold(ev.p, ev.price, ev.card, ev.steal, ev.allIn); break;
        case 'unsold': this.onUnsold(ev.card); break;
        case 'free': this.onFree(ev.p, ev.card); break;
        case 'locked':
          this.timers.push(window.setTimeout(() => {
            this.panels[ev.p].root.classList.add('locked');
            sfx.chains();
            this.line('locked', { player: this.names[ev.p], other: this.names[ev.p === 0 ? 1 : 0] });
          }, 700));
          break;
        case 'unsoldRound':
          this.roundStart = this.auction.state.lotCount;
          this.banner('UNSOLD ROUND', C.yellow);
          this.line('unsoldRound');
          break;
        case 'reserves':
          for (const f of ev.fills) this.particles.sparkle(f.p === 0 ? 150 : W - 150, 420, PC[f.p], 6, 60);
          break;
        case 'end': this.onEnd(); break;
        case 'undone': this.onUndone(); break;
      }
    }
  }

  private onLot(): void {
    const st = this.auction.state, lot = st.lot!;
    for (const p of this.panels) p.root.classList.remove('passed', 'lead', 'trail', 'shake');
    this.endWar();
    this.els.call.className = 'bwa-call';
    this.els.stamp.className = 'bwa-stamp';
    // A card still on the stage (not already flying off) is stale.
    if (this.cardNode && !this.cardNode.classList.contains('flying')) this.cardNode.remove();
    const node = cardEl(lot.card, st.settings, 'lg');
    node.classList.add('enter');
    this.els.cardSlot.append(node);
    this.cardNode = node;
    const star = lot.card.tier === 'S';
    this.els.cardSlot.classList.toggle('star', star);
    this.o.sfx.cardIn(star);
    if (lot.solo !== null) this.line('solo', { other: this.names[lot.solo] });
    else if (lot.n > 1 || lot.round === 'unsold') this.line(star ? 'lotStar' : 'lot');
    if (lot.n > 1) this.panels.forEach((p) => { p.tag.textContent = ''; });
  }

  private onBid(p: PlayerIdx, jump: boolean, count: number, war: boolean): void {
    // The price itself rolls in render(), which also covers undo.
    const { sfx } = this.o;
    sfx.coin(count);
    const from = this.pos(this.panels[p].purse), to = this.pos(this.els.price);
    this.coins.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t: 0, color: PC[p] });
    this.panels.forEach((pl) => pl.tag.textContent = '');
    if (war) {
      this.warOn = true;
      this.banner('BIDDING WAR!', C.yellow);
      this.stage.classList.add('war');
      this.o.audio.music(MUSIC_WAR, true);
      this.line('war');
    } else {
      if (count > WAR_BIDS) for (const pl of this.panels) { pl.root.classList.remove('shake'); void pl.root.offsetWidth; pl.root.classList.add('shake'); }
      // An all-in already has its own line.
      if (!this.auction.state.lot?.bids.at(-1)?.allIn) this.line(jump ? 'jump' : 'bid');
    }
    if (count >= WAR_BIDS) sfx.setMurmur(count - WAR_BIDS + 1);
    this.els.call.className = 'bwa-call';
  }

  private onAllIn(p: PlayerIdx, amount: number): void {
    const { sfx } = this.o;
    this.release(p);
    sfx.bigDrum();
    this.slowmo = 400;
    if (settings.motion) {
      this.els.flash.style.background = PC[p];
      this.els.flash.className = 'bwa-flash go';
    }
    this.banner('ALL IN!', PC[p], true);
    this.line('allIn', { player: this.names[p], price: amount });
    const c = this.pos(this.panels[p].purse);
    this.particles.burst(c.x, c.y, C.yellow, { count: 30, speed: 420, life: 0.9, size: 6, colors: [C.yellow, PC[p], C.white] });
  }

  private onSold(p: PlayerIdx, price: number, card: Card, steal: boolean, allIn: boolean): void {
    const { sfx } = this.o;
    const base = BASE_PRICE[card.tier];
    this.stamp(steal ? 'STEAL!' : 'SOLD', PC[p]);
    this.els.cardSlot.classList.remove('slam'); void this.els.cardSlot.offsetWidth;
    this.els.cardSlot.classList.add('slam');
    sfx.gavelBang();
    sfx.ooh(price / base - 1);
    if (steal) {
      sfx.whistle();
      const x = p === 0 ? 150 : W - 150;
      this.particles.confetti(x, 600, -Math.PI / 2, [PC[p], C.yellow, C.white], 50, 900);
    }
    const lot = this.auction.state.history.at(-1);
    const solo = lot && this.auction.state.players[p === 0 ? 1 : 0].locked;
    if (steal) this.line('steal', { leader: this.names[p], price });
    else if (solo) this.line('take', { leader: this.names[p], price, card: card.name });
    else if (!allIn && price >= base * 2) this.line('soldBig', { leader: this.names[p], price, card: card.name });
    else this.line('sold', { leader: this.names[p], price, card: card.name });
    this.flyTo(card, p);
  }

  private onUnsold(card: Card): void {
    this.stamp('UNSOLD', C.muted);
    this.o.sfx.mutedThud();
    this.line('unsold', { card: card.name });
    const node = this.cardNode;
    if (node) this.fly(node, this.els.tray, 500);
  }

  private onFree(p: PlayerIdx, card: Card): void {
    this.stamp('FREE', PC[p]);
    this.o.sfx.stamp();
    const st = this.auction.state;
    const other = p === 0 ? 1 : 0;
    if (st.history.at(-1)?.bids.length === 0 && st.players[other].squad.length < st.settings.squadSize) {
      this.line('leave', { player: this.names[p], other: this.names[other], card: card.name });
    } else this.line('free', { player: this.names[p], card: card.name });
    this.flyTo(card, p);
  }

  private flyTo(card: Card, p: PlayerIdx): void {
    const node = this.cardNode;
    if (!node) return;
    this.hidden.add(card.id);
    this.timers.push(window.setTimeout(() => {
      this.renderSquad(p, true);
      const slot = this.panels[p].squad.querySelector<HTMLElement>(`[data-slot="${card.id}"]`) ?? this.panels[p].squad;
      this.fly(node, slot, 480, () => {
        this.hidden.delete(card.id);
        this.renderSquad(p, true);
        this.panels[p].squad.querySelector(`[data-slot="${card.id}"]`)?.classList.add('arrive');
      });
    }, 420));
  }

  /** Animate a stage card into a target element, then remove it. */
  private fly(node: HTMLElement, target: HTMLElement, ms: number, done?: () => void): void {
    if (node === this.cardNode) this.cardNode = null;
    const a = node.getBoundingClientRect(), b = target.getBoundingClientRect();
    const dx = (b.left + b.width / 2 - (a.left + a.width / 2)) / this.scale;
    const dy = (b.top + b.height / 2 - (a.top + a.height / 2)) / this.scale;
    const k = Math.max(0.12, Math.min(1, b.width / Math.max(1, a.width)));
    node.classList.remove('enter');
    node.classList.add('flying');
    node.style.transition = settings.motion ? `transform ${ms}ms cubic-bezier(.5,0,.3,1), opacity ${ms}ms` : 'none';
    node.style.transform = `translate(${dx}px, ${dy}px) scale(${k}) rotate(${dx < 0 ? -8 : 8}deg)`;
    node.style.opacity = '0.4';
    this.timers.push(window.setTimeout(() => { node.remove(); done?.(); }, settings.motion ? ms : 0));
  }

  private onEnd(): void {
    this.endWar();
    this.banner('AUCTION COMPLETE!', C.yellow, true);
    this.line('end');
    this.o.sfx.fanfare();
    this.particles.confetti(0, 650, -Math.PI / 3, [C.pink, C.yellow, C.cyan], 60, 1000);
    this.particles.confetti(W, 650, -Math.PI * 2 / 3, [C.pink, C.yellow, C.cyan], 60, 1000);
    clearTimeout(this.endTimer);
    // Wait out the undo window so a last accidental press can still be taken back.
    this.endTimer = window.setTimeout(() => this.o.onEnd(this.auction), TIMING.undo + 400);
  }

  private onUndone(): void {
    clearTimeout(this.endTimer);
    this.o.sfx.undo();
    this.hidden.clear();
    for (const n of [...this.els.cardSlot.querySelectorAll('.bwc')]) n.remove();
    this.cardNode = null;
    for (const p of [0, 1] as PlayerIdx[]) {
      const pl = this.auction.state.players[p];
      this.panels[p].root.classList.toggle('locked', pl.locked);
      this.panels[p].root.classList.toggle('passed', !!this.auction.state.lot?.out[p] && this.auction.state.lot?.solo === null);
      this.renderSquad(p, true);
    }
    this.els.banner.className = 'bwa-banner';
    this.line('undo');
    // The following 'lot' event re-creates the stage card.
  }

  private reject(p: PlayerIdx, action: PlayerAction | 'allIn', reason: Reject): void {
    if (reason === 'no-lot' || reason === 'not-solo') return;
    const pl = this.panels[p];
    let text = REASON[reason];
    const lot = this.auction.state.lot;
    if (reason === 'cap' && lot) text = this.auction.capBlock(p, lot.card) ?? text;
    if (reason === 'max') text = `Over your max ($${this.auction.maxBid(p)})`;
    pl.why.textContent = text;
    pl.why.classList.add('show');
    pl.whyT = 1400;
    const i = action === 'bid1' || action === 'take' ? 0 : action === 'bid5' ? 1 : action === 'pass' || action === 'leave' ? 2 : 3;
    const chip = this.keyChips[p][i];
    chip.classList.remove('nope'); void chip.offsetWidth; chip.classList.add('nope');
    this.o.sfx.reject();
  }

  private endWar(): void {
    if (this.warOn) this.o.audio.music(MUSIC, true);
    this.warOn = false;
    this.stage.classList.remove('war');
    this.o.sfx.setMurmur(0);
  }

  private call(text: string): void {
    const el = this.els.call;
    el.textContent = text;
    el.className = 'bwa-call';
    void el.offsetWidth;
    el.className = 'bwa-call go';
  }

  private stamp(text: string, color: string): void {
    const el = this.els.stamp;
    el.textContent = text;
    el.style.setProperty('--sc', color);
    el.className = 'bwa-stamp';
    void el.offsetWidth;
    el.className = 'bwa-stamp go';
    this.els.call.className = 'bwa-call';
  }

  private banner(text: string, color: string, big = false): void {
    const el = this.els.banner;
    el.textContent = text;
    el.style.setProperty('--bc', color);
    el.className = 'bwa-banner';
    void el.offsetWidth;
    el.className = `bwa-banner go${big ? ' big' : ''}`;
  }

  private pos(el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect(), s = this.stage.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - s.left) / this.scale, y: (r.top + r.height / 2 - s.top) / this.scale };
  }

  // ---- pause -------------------------------------------------------------------

  pause(): void {
    if (this.paused || this.auction.state.phase === 'done') return;
    this.paused = true;
    this.holds = [null, null];
    this.root.classList.remove('holding');
    this.o.audio.duck(true);
    const resume = h('button.btn.primary', { type: 'button', onclick: () => this.resume() }, 'Resume');
    let armed = false;
    const quit = h('button.btn', {
      type: 'button',
      onclick: () => { if (!armed) { armed = true; quit.textContent = 'Click again to abandon'; return; } this.o.onQuit(false); },
    }, 'Abandon auction');
    this.pauseEl = h('div.bwa-pause', {}, h('div.panel', {},
      h('h2', {}, 'Paused'),
      h('p.bwa-pause-note', {}, 'The countdown is frozen. Space or Esc to resume.'),
      resume, quit,
      h('button.btn', { type: 'button', onclick: () => this.o.onQuit(true) }, 'Exit to hub'),
    ));
    this.root.append(this.pauseEl);
    resume.focus({ preventScroll: true });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseEl?.remove(); this.pauseEl = null;
    this.o.audio.duck(false);
    this.last = -1;
  }

  // ---- frame -------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.last < 0 ? 16 : Math.min(100, now - this.last);
    this.last = now;
    if (!this.paused) {
      for (const p of [0, 1] as PlayerIdx[]) {
        const t = this.holds[p];
        if (t === null) continue;
        const nt = t + dt;
        this.holds[p] = nt;
        this.o.sfx.drumRoll(dt / 1000, Math.min(1, nt / TIMING.allInHold));
        if (nt >= TIMING.allInHold) {
          this.release(p);
          this.handle(this.auction.dispatch({ type: 'allIn', p }));
        }
      }
      let scale = 1;
      if (this.slowmo > 0) { this.slowmo -= dt; scale = settings.motion ? 0.25 : 1; }
      this.handle(this.auction.dispatch({ type: 'tick', ms: dt * scale }));
    }
    this.render(dt);
    this.drawFx(dt / 1000);
  };

  private render(dt: number): void {
    const a = this.auction, st = a.state, lot = st.lot, e = this.els;
    // Lot header.
    if (lot) {
      setText(e.lotNo, lot.round === 'unsold'
        ? `UNSOLD ROUND ${lot.n - this.roundStart} / ${st.lotCount - this.roundStart + st.queue.length}`
        : `LOT ${lot.n} / ${this.mainTotal}`);
      const badges = [lot.card.tier === 'S' ? (st.settings.pack === 'cricket' ? 'Marquee' : st.settings.pack === 'pokemon' ? 'Legendary' : 'Cosmic') : '', lot.solo !== null ? 'Take or leave' : ''].filter(Boolean).join(' · ');
      setText(e.badges, badges);
      setText(e.base, `$${BASE_PRICE[lot.card.tier]}`);
      const leader = lot.leader;
      const priceKey = `${lot.n}|${lot.bids.length}|${leader}`;
      if (e.price.dataset.k !== priceKey) {
        // Odometer roll: a fresh span slides up each time the price changes.
        e.price.dataset.k = priceKey;
        e.price.classList.toggle('open', leader === null);
        if (leader === null) e.price.style.removeProperty('--pc'); else e.price.style.setProperty('--pc', PC[leader]);
        e.price.replaceChildren(h(leader === null ? 'span' : 'span.roll', {}, `$${lot.price}`));
      }
      setText(e.leader, leader === null
        ? lot.solo !== null ? `${this.names[lot.solo]}: take for $${lot.price} or leave` : 'No bids yet'
        : `${lot.allIn === leader ? 'ALL-IN: ' : 'Leader: '}${this.names[leader]}`);
      e.leader.style.color = leader === null ? '' : PC[leader];
      const max = lot.leader !== null || lot.solo !== null ? TIMING.countdown : TIMING.opening;
      const k = Math.max(0, Math.min(1, lot.timer / max));
      this.ringEl.style.strokeDashoffset = String(276.5 * (1 - k));
      this.ringEl.style.stroke = lot.stage === 2 ? C.pink : lot.stage === 1 ? C.orange : leader === null ? C.muted : PC[leader];
      setText(e.timerText, String(Math.ceil(Math.max(0, lot.timer) / 1000)));
      const tick = lot.bids.slice(-6).map((b) => `<span style="color:${PC[b.p]}">${esc(this.names[b.p])} ${b.allIn ? 'ALL-IN ' : ''}$${b.price}</span>`).join('<i>›</i>');
      if (e.ticker.dataset.k !== tick) { e.ticker.dataset.k = tick; e.ticker.innerHTML = tick; }
      for (const p of [0, 1] as PlayerIdx[]) {
        this.panels[p].root.classList.toggle('lead', leader === p);
        this.panels[p].root.classList.toggle('trail', leader !== null && leader !== p);
      }
      this.renderedBids = lot.bids.length;
    }
    this.root.classList.toggle('resolved', st.phase !== 'lot');
    // Panels.
    for (const p of [0, 1] as PlayerIdx[]) this.renderPanel(p, dt);
    this.renderUpcoming();
    // Tray.
    const trayKey = st.unsold.map((c) => c.id).join();
    if (e.trayList.dataset.k !== trayKey) {
      e.trayList.dataset.k = trayKey;
      e.trayList.replaceChildren(...st.unsold.slice(-8).map((c) => h(`span.bwa-traycard.tier-${c.tier}`, { title: c.name }, c.name)));
      e.tray.classList.toggle('empty', !st.unsold.length);
    }
    // Undo pill.
    const age = a.undoAge();
    e.undo.classList.toggle('show', age !== null);
    if (age !== null) (e.undo.lastElementChild as HTMLElement).style.width = `${100 * (1 - age / TIMING.undo)}%`;
    // Commentary typewriter.
    if (this.commentShown < this.commentText.length) {
      this.commentShown = Math.min(this.commentText.length, this.commentShown + dt * 0.11);
      e.comment.textContent = this.commentText.slice(0, Math.ceil(this.commentShown));
    } else setText(e.comment, this.commentText);
  }

  private renderPanel(p: PlayerIdx, dt: number): void {
    const a = this.auction, st = a.state, pl = st.players[p], panel = this.panels[p], lot = st.lot;
    // Purse: a pledged all-in shows as empty; everything else ticks toward the real value.
    const target = lot?.allIn === p && st.phase === 'lot' ? 0 : pl.purse;
    const diff = target - panel.shown;
    if (diff !== 0) {
      const step = Math.max(1, Math.abs(diff) * dt / 140);
      panel.shown = Math.abs(diff) <= step ? target : panel.shown + Math.sign(diff) * step;
    }
    setText(panel.purse, `$${Math.round(panel.shown)}`);
    panel.purse.classList.toggle('low', pl.purse < st.purseStart * 0.25 && !pl.locked);
    const empty = a.empty(p);
    setText(panel.max, pl.locked ? 'Locked' : empty <= 0 ? 'Squad full' : `max bid $${Math.max(0, a.maxBid(p))}`);
    // All-in pill.
    const block = a.allInBlock(p);
    let label: string, cls: string;
    if (pl.locked) { label = 'ALL-IN won'; cls = 'won'; }
    else if (pl.allInUsed) { label = 'ALL-IN used'; cls = 'used'; }
    else if (st.players[p === 0 ? 1 : 0].locked) { label = 'ALL-IN off'; cls = 'used'; }
    else if (empty < allInMinSlots(st.settings.squadSize)) { label = 'ALL-IN closed'; cls = 'used'; }
    else if (block === null) { label = `ALL-IN ready · hold ${KEY_LABEL[p][3]}`; cls = 'ready'; }
    else { label = 'ALL-IN ready'; cls = 'idle'; }
    setText(panel.allIn, label);
    if (panel.allIn.dataset.c !== cls) { panel.allIn.dataset.c = cls; panel.allIn.className = `bwa-allin ${cls}`; }
    const hold = this.holds[p];
    panel.ring.style.strokeDashoffset = String(289 * (1 - (hold === null ? 0 : Math.min(1, hold / TIMING.allInHold))));
    panel.root.classList.toggle('holding', hold !== null);
    // Why line fades after a reject; otherwise shows the standing reason.
    if (panel.whyT > 0) { panel.whyT -= dt; if (panel.whyT <= 0) panel.why.classList.remove('show'); }
    else setText(panel.why, this.standing(p));
    this.renderSquad(p);
    this.renderKeys(p);
  }

  /** Always-visible reason a player cannot act, so nothing is a surprise. */
  private standing(p: PlayerIdx): string {
    const a = this.auction, lot = a.state.lot, pl = a.state.players[p];
    if (pl.locked || !lot || a.state.phase !== 'lot') return '';
    if (a.full(p)) return 'Auto-pass: squad full';
    const cap = a.capBlock(p, lot.card);
    if (cap) return cap;
    if (lot.solo !== null && lot.solo !== p) return 'Sitting this one out';
    if (lot.out[p]) return 'Passed';
    if (lot.leader === p) return 'Leading';
    const next = a.nextPrice('bid1', p);
    if (next > a.maxBid(p)) return a.allInBlock(p) === null ? `Over your max: only ALL-IN` : `Can't go to $${next}`;
    return '';
  }

  private renderKeys(p: PlayerIdx): void {
    const a = this.auction, lot = a.state.lot;
    const solo = lot?.solo === p;
    const chips = this.keyChips[p];
    const ok = [
      lot ? a.bidBlock(p, a.nextPrice('bid1', p)) === null : false,
      lot && !solo ? a.bidBlock(p, a.nextPrice('bid5', p)) === null : false,
      lot ? !a.state.players[p].locked && (solo || (!lot.out[p] && lot.leader !== p)) && a.state.phase === 'lot' : false,
      a.allInBlock(p) === null,
    ];
    const labels = solo
      ? [`take $${lot!.price}`, '-', 'leave', '-']
      : [`+1 ($${a.nextPrice('bid1', p)})`, `+5 ($${a.nextPrice('bid5', p)})`, 'pass', 'hold ALL-IN'];
    chips.forEach((chip, i) => {
      chip.classList.toggle('off', !ok[i]);
      setText(chip.lastElementChild as HTMLElement, labels[i]);
      const btn = this.panels[p].touch[i];
      btn.disabled = !ok[i];
      setText(btn.firstElementChild as HTMLElement, (solo ? ['Take', '+5', 'Leave', 'ALL-IN'] : ['+1', '+5', 'Pass', 'ALL-IN'])[i]);
    });
  }

  private renderSquad(p: PlayerIdx, force = false): void {
    const st = this.auction.state, s = st.settings, pl = st.players[p], panel = this.panels[p];
    const key = pl.squad.map((b) => b.card.id + (this.hidden.has(b.card.id) ? '-' : '')).join() + '|' + s.squadSize;
    if (!force && key === panel.squadKey) return;
    panel.squadKey = key;
    const visible = pl.squad.filter((b) => !this.hidden.has(b.card.id));
    const slots: HTMLElement[] = visible.map((b) => {
      const c = cardEl(b.card, s, 'sm');
      return h('div.bwa-slot.filled', { 'data-slot': b.card.id, title: `${b.card.name}: $${b.price}${b.how === 'free' ? ' (free)' : ''}` },
        c, h('span.bwa-slotprice', {}, b.how === 'free' || b.how === 'reserve' ? 'FREE' : `$${b.price}`));
    });
    const hints = this.slotHints(p);
    for (const b of pl.squad.filter((x) => this.hidden.has(x.card.id))) slots.push(h('div.bwa-slot.incoming', { 'data-slot': b.card.id }));
    for (let i = pl.squad.length; i < s.squadSize; i++) slots.push(h('div.bwa-slot.empty', {}, hints[i - pl.squad.length] ?? ''));
    panel.squad.replaceChildren(...slots);
    panel.squad.dataset.size = String(s.squadSize);
    // Roles line.
    const cards = pl.squad.map((b) => b.card);
    const bits: string[] = [];
    if (s.pack === 'cricket') {
      const r = cricketRoles(cards), m = ROLE_MIN[s.squadSize] ?? ROLE_MIN[6]!;
      const tag = (label: string, n: number, need: number) => `<span class="${n >= need ? 'ok' : ''}">${label} ${n}/${need}</span>`;
      bits.push(tag('WK', r.wk, m.wk), tag('Bat', r.bat, m.bat), tag('Bowl', r.bowl, m.bowl));
      if (s.cricketMode === 'ipl') {
        const cap = OVERSEAS_CAP[s.squadSize] ?? 2, n = cards.filter((c) => c.tags.overseas).length;
        bits.push(`<span class="${n >= cap ? 'capped' : ''}">Overseas ${n}/${cap}</span>`);
      }
    } else if (s.pack === 'pokemon') {
      const n = cards.filter((c) => c.tags.legendary).length;
      bits.push(`<span class="${n ? 'capped' : ''}">Legendary ${n}/1</span>`, `<span>Types ${new Set(cards.flatMap((c) => c.tags.types ?? [])).size}</span>`);
    } else {
      const n = cards.filter((c) => c.tags.cosmic).length;
      bits.push(`<span class="${n ? 'capped' : ''}">Cosmic ${n}/1</span>`, `<span>Roles ${new Set(cards.map((c) => c.role)).size}/5</span>`);
    }
    panel.roles.innerHTML = bits.join('');
  }

  /** Faint labels in empty slots for what the squad still needs. */
  private slotHints(p: PlayerIdx): string[] {
    const st = this.auction.state, s = st.settings, cards = st.players[p].squad.map((b) => b.card);
    const out: string[] = [];
    if (s.pack === 'cricket') {
      const r = cricketRoles(cards), m = ROLE_MIN[s.squadSize] ?? ROLE_MIN[6]!;
      for (let i = r.wk; i < m.wk; i++) out.push('WK');
      for (let i = r.bowl; i < m.bowl; i++) out.push('BOWL');
      for (let i = r.bat + Math.max(0, m.wk - r.wk); i < m.bat; i++) out.push('BAT');
    } else if (s.pack === 'heroes') {
      for (const role of HERO_ROLES) if (!cards.some((c) => c.role === role)) out.push(HERO_SHORT[role]);
    }
    return out;
  }

  private renderUpcoming(): void {
    const st = this.auction.state, e = this.els;
    const show = st.settings.showUpcoming;
    e.upToggle.hidden = !show;
    e.upToggle.setAttribute('aria-expanded', String(this.upcomingOpen));
    const next = show && this.upcomingOpen ? st.queue.slice(0, 3) : [];
    const key = next.map((c) => c.id).join();
    if (e.upcoming.dataset.k === key) return;
    e.upcoming.dataset.k = key;
    e.upcoming.replaceChildren(...next.map((c) => h(`span.bwa-upcard.tier-${c.tier}`, { style: `--tint:${CRICKET_COLOR[c.role] ?? ''}` }, h('b', {}, c.tier), c.name)));
  }

  private drawFx(dt: number): void {
    const g = this.g, k = this.fx.width / W;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.fx.width, this.fx.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    this.particles.update(dt);
    this.particles.render(g);
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      c.t += dt / 0.45;
      if (c.t >= 1) { this.coins.splice(i, 1); this.particles.sparkle(c.x1, c.y1, C.yellow, 5, 16); continue; }
      const t = c.t, e = 1 - Math.pow(1 - t, 2);
      const x = c.x0 + (c.x1 - c.x0) * e, y = c.y0 + (c.y1 - c.y0) * e - Math.sin(t * Math.PI) * 120;
      g.globalAlpha = 1;
      g.fillStyle = C.yellow;
      g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#B8860B'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#7A5A00'; g.font = '700 13px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('$', x, y + 1);
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.endTimer);
    for (const t of this.timers) clearTimeout(t);
    for (const f of this.off) f();
    this.o.sfx.setMurmur(0);
    this.root.remove();
  }
}

function setText(el: HTMLElement | null, t: string): void {
  if (el && el.textContent !== t) el.textContent = t;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
