import { h } from '../../shell/dom';
import { ICON } from '../../shell/icons';
import { NAME_MAX, PURSE_FEEL, pursesFor, SKIP_RULES_AFTER } from './config';
import { headToHead, playedBy, savedNames, savedSettings, saveNames, saveSettings } from './history';
import { codeForSeed, seedFromCode } from './pool';
import type { BidSfx } from './sfx';
import type { MatchSettings, PackId, PlayerIdx, PurseFeel, SquadSize } from './types';

export interface SetupResult {
  settings: MatchSettings;
  names: [string, string];
  seed: number;
  code: string;
  /** Coin-toss winner: opens Lot 1 (cosmetic). */
  opener: PlayerIdx;
}

const PACKS: { id: PackId; title: string; blurb: string; art: string }[] = [
  {
    id: 'cricket', title: 'Cricket', blurb: 'IPL-style or general. 6 or 12 a side. Keepers, bowlers, overseas stars.',
    art: '<svg viewBox="0 0 120 90" aria-hidden="true"><rect x="66" y="10" width="14" height="62" rx="5" transform="rotate(32 73 41)" fill="#FF9F43"/><rect x="70" y="58" width="6" height="24" rx="3" transform="rotate(32 73 70)" fill="#9B6A3A"/><circle cx="36" cy="58" r="15" fill="#FF4F8B"/><path d="M27 47c6 7 6 15 0 22M45 47c-6 7-6 15 0 22" stroke="#fff" stroke-width="2" fill="none" opacity=".8"/><g fill="#F4F1FF"><rect x="22" y="14" width="4" height="26" rx="2"/><rect x="30" y="14" width="4" height="26" rx="2"/><rect x="38" y="14" width="4" height="26" rx="2"/><rect x="20" y="12" width="24" height="3" rx="1.5"/></g></svg>',
  },
  {
    id: 'pokemon', title: 'Pokemon', blurb: '151 favourites across every generation. Only one Legendary per team.',
    art: '<svg viewBox="0 0 120 90" aria-hidden="true"><circle cx="60" cy="45" r="32" fill="#F4F1FF"/><path d="M28 45a32 32 0 0 1 64 0z" fill="#FF4F8B"/><rect x="28" y="42" width="64" height="6" fill="#0E0F1A"/><circle cx="60" cy="45" r="11" fill="#0E0F1A"/><circle cx="60" cy="45" r="6.5" fill="#F4F1FF"/><path d="M98 16l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#FFD93D"/></svg>',
  },
  {
    id: 'heroes', title: 'Superheroes', blurb: 'Marvel, or Marvel + DC. One Cosmic per team. Ends in a Civil War.',
    art: '<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M60 8l30 12v22c0 20-13 33-30 40-17-7-30-20-30-40V20z" fill="#38E1F5"/><path d="M60 16l22 9v17c0 15-9 25-22 31-13-6-22-16-22-31V25z" fill="#0E0F1A"/><path d="M60 26l5.5 11.5 12.5 1.5-9.3 8.5 2.5 12.5L60 54l-11.2 6 2.5-12.5L42 39l12.5-1.5z" fill="#FFD93D"/></svg>',
  },
];

const STEPS = ['Pack', 'Options', 'Purse', 'Players', 'Rules'];

export function defaultSettings(): MatchSettings {
  const saved = savedSettings();
  return {
    pack: 'cricket', squadSize: 6, cricketMode: 'ipl', marqueeFirst: true, roster: 'both', purseFeel: 'normal', showUpcoming: true,
    ...saved,
  };
}

/** Five one-screen steps. Back always available, Enter continues. */
export class Setup {
  readonly root: HTMLElement;
  private step = 0;
  private s: MatchSettings = defaultSettings();
  private names: [string, string] = savedNames();
  private code = '';
  private opener: PlayerIdx | null = null;
  private flipping = false;
  private ready: [boolean, boolean] = [false, false];
  private body: HTMLElement;
  private dots: HTMLElement;
  private next: HTMLButtonElement;
  private onKeyBound = (e: KeyboardEvent) => this.onKey(e);
  private timers: number[] = [];

  constructor(parent: HTMLElement, private sfx: BidSfx, private done: (r: SetupResult) => void, private exit: () => void, startAt = 0) {
    this.body = h('div.bws-body');
    this.dots = h('ol.bws-dots', { 'aria-label': 'Setup steps' });
    this.next = h('button.btn.primary', { type: 'button', onclick: () => this.advance() }, 'Continue');
    const back = h('button.icon-btn.bws-back', { type: 'button', 'aria-label': 'Back', html: ICON.back, onclick: () => this.back() });
    this.root = h('div.bws', {},
      h('header.bws-head', {}, back, h('div.bws-title', {}, h('span.bw-logo', {}, 'BID WAR'), this.dots)),
      this.body,
      h('footer.bws-foot', {}, h('span.bws-hint', {}, 'Enter to continue · Esc to go back'), this.next),
    );
    parent.append(this.root);
    window.addEventListener('keydown', this.onKeyBound, true);
    this.go(startAt);
  }

  private go(step: number): void {
    this.step = step;
    this.ready = [false, false];
    this.dots.replaceChildren(...STEPS.map((label, i) => h(`li${i === step ? '.on' : i < step ? '.done' : ''}`, {}, h('span', {}, String(i + 1)), label)));
    this.body.replaceChildren(this.renderStep());
    this.next.hidden = step === 4;
    this.next.textContent = step === 3 && this.opener === null ? 'Flip the coin' : 'Continue';
    this.body.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }

  private renderStep(): HTMLElement {
    switch (this.step) {
      case 0: return this.packStep();
      case 1: return this.optionStep();
      case 2: return this.purseStep();
      case 3: return this.playerStep();
      default: return this.rulesStep();
    }
  }

  // ---- step 1 --------------------------------------------------------------

  private packStep(): HTMLElement {
    const grid = h('div.bws-packs', { role: 'radiogroup', 'aria-label': 'Pack' });
    PACKS.forEach((p, i) => {
      const on = this.s.pack === p.id;
      const btn = h('button.bws-pack', {
        type: 'button', role: 'radio', 'aria-checked': String(on), 'data-pack': p.id, 'data-autofocus': on ? '' : undefined,
        onclick: () => { this.pickPack(p.id); this.advance(); },
      },
        h('div.bws-pack-art', { html: p.art }),
        h('h3', {}, p.title),
        h('p', {}, p.blurb),
        h('kbd', {}, String(i + 1)),
      );
      grid.append(btn);
    });
    return h('section.bws-step', {}, h('h2', {}, 'Pick a pack'), grid);
  }

  private pickPack(id: PackId): void {
    if (this.s.pack !== id) {
      this.s.pack = id;
      this.s.showUpcoming = id === 'cricket';
      if (id === 'cricket' && this.s.squadSize !== 12) this.s.squadSize = 6;
      if (id !== 'cricket' && this.s.squadSize === 12) this.s.squadSize = 6;
    }
    this.sfx.ui();
  }

  // ---- step 2 --------------------------------------------------------------

  private seg<T extends string | number>(label: string, value: T, options: [T, string, string?][], set: (v: T) => void): HTMLElement {
    const row = h('div.bws-seg', { role: 'radiogroup', 'aria-label': label });
    const hint = h('small.bws-seg-hint');
    const draw = (v: T) => {
      row.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(options[i][0] === v)));
      hint.textContent = options.find((o) => o[0] === v)?.[2] ?? '';
    };
    for (const [v, text] of options) {
      row.append(h('button', { type: 'button', role: 'radio', onclick: () => { set(v); draw(v); this.sfx.ui(); } }, text));
    }
    draw(value);
    return h('div.bws-opt', {}, h('label', {}, label), row, hint);
  }

  private optionStep(): HTMLElement {
    const s = this.s;
    const rows: HTMLElement[] = [];
    if (s.pack === 'cricket') {
      if (s.squadSize !== 6 && s.squadSize !== 12) s.squadSize = 6;
      rows.push(this.seg('Mode', s.cricketMode, [['ipl', 'IPL-style', 'Overseas players capped at 2 (6-a-side) or 4 (12-a-side).'], ['general', 'General', 'No overseas rule. Country is just flavour.']], (v) => { s.cricketMode = v; }));
      rows.push(this.seg('Squad size', s.squadSize, [[6, '6', 'About 6-10 minutes.'], [12, '12', 'Long auction: about 15-20 minutes.']] as [SquadSize, string, string?][], (v) => { s.squadSize = v; }));
      rows.push(this.seg('Marquee first', s.marqueeFirst ? 'on' : 'off', [['on', 'On', 'All S-tier stars go under the hammer first.'], ['off', 'Off', 'Stars are spread through the auction.']], (v) => { s.marqueeFirst = v === 'on'; }));
    } else {
      if (s.squadSize === 12) s.squadSize = 6;
      rows.push(this.seg('Squad size', s.squadSize, [[3, '3', 'Quick: 8 lots, 2 S-tier. About 3 minutes.'], [4, '4', '10 lots. About 4-6 minutes.'], [6, '6', '15 lots. About 6-10 minutes.']] as [SquadSize, string, string?][], (v) => { s.squadSize = v; }));
      if (s.pack === 'heroes') rows.push(this.seg('Roster', s.roster, [['marvel', 'Marvel'], ['both', 'Marvel + DC']], (v) => { s.roster = v; }));
    }
    rows.push(this.seg('Upcoming lots', s.showUpcoming ? 'on' : 'off', [['on', 'Show', 'See the next 3 lots. Changes strategy.'], ['off', 'Hide', 'Every lot is a surprise.']], (v) => { s.showUpcoming = v === 'on'; }));
    const code = h('input.bws-code', {
      type: 'text', maxlength: 24, placeholder: 'Optional', value: this.code, autocomplete: 'off', spellcheck: 'false',
      oninput: (e: Event) => { this.code = (e.target as HTMLInputElement).value; },
    });
    rows.push(h('div.bws-opt', {}, h('label', {}, 'Match code'), code, h('small.bws-seg-hint', {}, 'Type a friend\'s code to replay the exact same draw.')));
    const title = PACKS.find((p) => p.id === s.pack)!.title;
    return h('section.bws-step', {}, h('h2', {}, `${title} options`), h('div.bws-opts', {}, ...rows));
  }

  // ---- step 3 --------------------------------------------------------------

  private purseStep(): HTMLElement {
    const live = h('div.bws-purse-live');
    const show = () => { live.innerHTML = `Each player gets <b>$${pursesFor(this.s.squadSize, this.s.purseFeel)}</b> for ${this.s.squadSize} players`; };
    const grid = h('div.bws-feels', { role: 'radiogroup', 'aria-label': 'Purse feel' });
    const draw = () => grid.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.feel === this.s.purseFeel)));
    for (const feel of ['tight', 'normal', 'loose'] as PurseFeel[]) {
      const f = PURSE_FEEL[feel];
      grid.append(h('button.bws-feel', {
        type: 'button', role: 'radio', 'data-feel': feel, 'data-autofocus': feel === this.s.purseFeel ? '' : undefined,
        onclick: () => { this.s.purseFeel = feel; draw(); show(); this.sfx.ui(); },
        onfocus: () => { this.s.purseFeel = feel; draw(); show(); },
      }, h('b', {}, f.label), h('span', {}, `$${pursesFor(this.s.squadSize, feel)}`), h('small', {}, feel === 'tight' ? 'Every dollar hurts' : feel === 'loose' ? 'Big spenders' : 'Recommended')));
    }
    draw(); show();
    return h('section.bws-step', {}, h('h2', {}, 'Purse feel'), grid, live);
  }

  // ---- step 4 --------------------------------------------------------------

  private playerStep(): HTMLElement {
    const h2h = h('div.bws-h2h');
    const showH2h = () => {
      const r = headToHead(this.names[0], this.names[1]);
      h2h.textContent = r ? `Head to head: ${this.names[0]} ${r[0]} - ${r[1]} ${this.names[1]}` : '';
    };
    const field = (i: PlayerIdx) => h('label.bws-name', { style: `--pc:var(${i ? '--cyan' : '--pink'})` },
      h('span', {}, `Player ${i + 1}`),
      h('input', {
        type: 'text', maxlength: NAME_MAX, value: this.names[i], autocomplete: 'off', spellcheck: 'false', 'data-autofocus': i === 0 ? '' : undefined,
        oninput: (e: Event) => { this.names[i] = (e.target as HTMLInputElement).value.slice(0, NAME_MAX); showH2h(); },
        onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
      }),
      h('small', {}, i ? 'Keys P O I U' : 'Keys Q W E R'),
    );
    const coin = h('div.bws-coin', { 'aria-hidden': 'true' }, h('div.face.p1', {}, '1'), h('div.face.p2', {}, '2'));
    const result = h('div.bws-coin-result', { 'aria-live': 'polite' });
    if (this.opener !== null) {
      coin.classList.add(this.opener ? 'show-p2' : 'show-p1');
      result.textContent = `${this.cleanName(this.opener)} opens the bidding on Lot 1`;
    }
    showH2h();
    return h('section.bws-step', {}, h('h2', {}, 'Players'),
      h('div.bws-names', {}, field(0), h('div.bws-vs', {}, 'VS'), field(1)), h2h,
      h('div.bws-toss', {}, coin, result, h('small.bws-seg-hint', {}, 'The toss is just for show: after Lot 1 both of you bid at the same time.')));
  }

  private cleanName(i: PlayerIdx): string {
    return this.names[i].trim().slice(0, NAME_MAX) || `Player ${i + 1}`;
  }

  private flip(): void {
    if (this.flipping) return;
    this.flipping = true;
    // Cosmetic only, so plain Math.random is fine here.
    this.opener = Math.random() < 0.5 ? 0 : 1;
    const coin = this.body.querySelector<HTMLElement>('.bws-coin')!;
    coin.classList.remove('show-p1', 'show-p2');
    void coin.offsetWidth;
    coin.classList.add('flip', this.opener ? 'show-p2' : 'show-p1');
    for (let i = 0; i < 6; i++) this.timers.push(window.setTimeout(() => this.sfx.tick(), i * 140));
    this.timers.push(window.setTimeout(() => {
      this.flipping = false;
      this.sfx.stamp();
      const r = this.body.querySelector('.bws-coin-result');
      if (r) r.textContent = `${this.cleanName(this.opener!)} opens the bidding on Lot 1`;
      this.next.textContent = 'Continue';
      this.timers.push(window.setTimeout(() => { if (this.step === 3) this.advance(); }, 900));
    }, 1100));
  }

  // ---- step 5 --------------------------------------------------------------

  private rulesStep(): HTMLElement {
    const s = this.s;
    const cap = s.pack === 'cricket'
      ? s.cricketMode === 'ipl' ? `Overseas players are capped at ${s.squadSize === 12 ? 4 : 2}.` : 'No overseas cap in General mode.'
      : s.pack === 'pokemon' ? 'Only one Legendary or Mythical per team.' : 'Only one Cosmic-tier hero per team.';
    const rules = [
      ['One card at a time.', 'First +1 pays the base price, +5 jumps ahead. Highest bid when the hammer falls wins.'],
      ['8-second countdown.', 'Every bid resets it. Going once, going twice, SOLD.'],
      ['Pass = out of this lot.', 'If your rival is leading when you pass, it is theirs. You cannot pass while you lead.'],
      ['Budget guard.', 'You must be able to fill every slot, so your max bid is shown under your purse.'],
      ['ALL-IN, once a match.', 'Hold for 1 s to bid your whole purse. Win it and you are locked: your rival shops alone, and anything they leave comes to you free.'],
      ['Caps and roles.', `${cap} Squads always end full; the best team on score wins.`],
    ];
    const keys = (i: PlayerIdx) => {
      const k = i ? ['P', 'O', 'I', 'U'] : ['Q', 'W', 'E', 'R'];
      return h(`div.bws-keys.p${i + 1}`, {}, h('b', {}, this.cleanName(i)),
        ...[['+1', k[0]], ['+5', k[1]], ['Pass', k[2]], ['ALL-IN (hold)', k[3]]].map(([what, key]) => h('div', {}, h('kbd', {}, key), h('span', {}, what))));
    };
    const readyBtn = (i: PlayerIdx) => h(`button.btn.bws-ready.p${i + 1}`, { type: 'button', onclick: () => this.setReady(i) }, `${this.cleanName(i)}: ready (${i ? 'I' : 'E'})`);
    const canSkip = playedBy(this.cleanName(0)) >= SKIP_RULES_AFTER && playedBy(this.cleanName(1)) >= SKIP_RULES_AFTER;
    return h('section.bws-step.bws-rules', {}, h('h2', {}, 'The rules'),
      h('ol.bws-rule-list', {}, ...rules.map(([b, t]) => h('li', {}, h('b', {}, b), ' ', t))),
      h('div.bws-keymap', {}, keys(0), keys(1)),
      h('p.bws-ready-hint', {}, 'Both players press their Pass key to start.'),
      h('div.bws-readies', {}, readyBtn(0), readyBtn(1)),
      canSkip ? h('button.btn.bws-skip', { type: 'button', onclick: () => this.finish() }, 'Skip rules') : null,
    );
  }

  private setReady(i: PlayerIdx): void {
    if (this.ready[i]) return;
    this.ready[i] = true;
    this.sfx.gavelTap();
    this.body.querySelector(`.bws-ready.p${i + 1}`)?.classList.add('on');
    if (this.ready[0] && this.ready[1]) this.timers.push(window.setTimeout(() => this.finish(), 350));
  }

  // ---- flow ----------------------------------------------------------------

  private advance(): void {
    if (this.step === 3 && this.opener === null) { this.flip(); return; }
    if (this.step === 3 && this.flipping) return;
    if (this.step >= 4) return;
    this.sfx.ui();
    this.go(this.step + 1);
  }

  private back(): void {
    if (this.step === 0) { this.exit(); return; }
    this.go(this.step - 1);
  }

  private finish(): void {
    const names: [string, string] = [this.cleanName(0), this.cleanName(1)];
    if (names[0].toLowerCase() === names[1].toLowerCase()) names[1] = `${names[1]} 2`.slice(-NAME_MAX);
    saveNames(names);
    saveSettings(this.s);
    const seed = this.code.trim() ? seedFromCode(this.code) : Date.now() >>> 0;
    this.done({ settings: { ...this.s }, names, seed, code: codeForSeed(seed), opener: this.opener ?? 0 });
  }

  private onKey(e: KeyboardEvent): void {
    if (document.querySelector('.modal-back')) return;
    const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
    if (e.key === 'Escape') { e.preventDefault(); this.back(); return; }
    if (e.key === 'Enter') { e.preventDefault(); this.advance(); return; }
    if (typing) return;
    if (this.step === 0 && ['1', '2', '3'].includes(e.key)) { this.pickPack(PACKS[Number(e.key) - 1].id); this.advance(); return; }
    if (this.step === 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const i = PACKS.findIndex((p) => p.id === this.s.pack);
      const j = (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      this.pickPack(PACKS[j].id);
      this.go(0);
      return;
    }
    if (this.step === 4 && !e.repeat) {
      if (e.code === 'KeyE') this.setReady(0);
      else if (e.code === 'KeyI') this.setReady(1);
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyBound, true);
    for (const t of this.timers) clearTimeout(t);
    this.root.remove();
  }
}
