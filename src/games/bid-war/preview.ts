import { Rng } from '../../engine/rng';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import type { Game, GameContext } from '../../engine/types';
import { BASE_PRICE, TIMING } from './config';
import { Auction } from './rules';
import type { Card, PlayerIdx, Tier } from './types';

// A tiny built-in roster so the hub card never has to load a pack.
const SAMPLE: [string, Tier, number][] = [
  ['Thunder King', 'S', 95], ['Blaze Bowler', 'A', 84], ['Captain Calm', 'A', 82], ['Night Keeper', 'B', 72],
  ['Spin Wizard', 'B', 70], ['Rookie Rocket', 'C', 55], ['Iron Wall', 'S', 92], ['Swift Edge', 'A', 80],
];
const PC = [C.pink, C.cyan] as const;

/** Hub attract mode: two bots run a real auction on the rules engine. */
class BidWarPreview implements Game {
  private ctx!: GameContext;
  private rng = new Rng();
  private a!: Auction;
  private flash = 0;
  private flashP: PlayerIdx = 0;
  private stamp = 0;
  private stampText = '';
  private cardT = 0;
  private lotN = -1;

  init(ctx: GameContext): void { this.ctx = ctx; }

  start(seed: number): void {
    this.rng.seed(seed);
    const pool: Card[] = this.rng.shuffle([...SAMPLE]).map(([name, tier, rating], i) => ({
      id: `p${i}`, name, tier, rating, role: 'Batter', stats: {}, tags: {},
    }));
    this.a = new Auction({ pack: 'cricket', squadSize: 3, cricketMode: 'general', marqueeFirst: false, roster: 'both', purseFeel: 'normal', showUpcoming: false }, pool, 20, seed);
    this.a.begin();
  }

  update(dt: number): void {
    const a = this.a;
    if (a.state.phase === 'done') { this.start(this.rng.int(1, 1e9)); return; }
    const lot = a.state.lot;
    if (a.state.phase === 'lot' && lot && this.rng.chance(dt * 1.6)) {
      const p = this.rng.int(0, 1) as PlayerIdx;
      const want = BASE_PRICE[lot.card.tier] * (1.2 + this.rng.next());
      const type = a.nextPrice('bid1', p) <= want ? (this.rng.chance(0.2) ? 'bid5' : 'bid1') : 'pass';
      for (const ev of a.dispatch({ type: lot.solo === p ? (type === 'pass' ? 'leave' : 'take') : type, p })) {
        if (ev.type === 'bid') { this.flash = 1; this.flashP = ev.p; }
      }
    }
    for (const ev of a.dispatch({ type: 'tick', ms: dt * 2000 })) {
      if (ev.type === 'sold') { this.stamp = 1; this.stampText = 'SOLD'; this.flashP = ev.p; }
      if (ev.type === 'unsold') { this.stamp = 1; this.stampText = 'UNSOLD'; }
    }
    this.flash = Math.max(0, this.flash - dt * 3);
    this.stamp = Math.max(0, this.stamp - dt * 1.2);
    if (a.state.lot && a.state.lot.n !== this.lotN) { this.lotN = a.state.lot.n; this.cardT = 0; }
    this.cardT = Math.min(1, this.cardT + dt * 3);
  }

  render(): void {
    const { canvas } = this.ctx;
    const g = canvas.begin('#11121F');
    const W = canvas.w, H = canvas.h, st = this.a.state, lot = st.lot;
    for (const p of [0, 1] as PlayerIdx[]) {
      const x = p === 0 ? 0 : W - 150;
      const lead = lot?.leader === p;
      g.fillStyle = rgba(PC[p], lead ? 0.28 : 0.12);
      g.fillRect(x, 0, 150, H);
      g.fillStyle = PC[p];
      g.font = `700 22px ${FONT.title}`;
      g.textAlign = 'center';
      g.fillText(p === 0 ? 'P1' : 'P2', x + 75, 40);
      g.fillStyle = C.yellow;
      g.font = `700 44px ${FONT.title}`;
      g.fillText(`$${st.players[p].purse}`, x + 75, 98);
      st.players[p].squad.forEach((b, i) => {
        g.fillStyle = rgba(PC[p], 0.5);
        g.fillRect(x + 25, 140 + i * 62, 100, 52);
        g.fillStyle = C.text;
        g.font = `600 13px ${FONT.ui}`;
        g.fillText(b.card.name.split(' ')[0], x + 75, 162 + i * 62);
        g.fillStyle = C.yellow;
        g.fillText(`$${b.price}`, x + 75, 180 + i * 62);
      });
    }
    if (lot) {
      const k = ease.outBack(this.cardT);
      const cx = W / 2 + (1 - k) * 200, cw = 170, chh = 220;
      g.save();
      g.translate(cx, 170);
      g.rotate((1 - k) * 0.2);
      g.fillStyle = lot.card.tier === 'S' ? '#3A2E08' : C.surface2;
      g.strokeStyle = lot.card.tier === 'S' ? C.yellow : lot.card.tier === 'A' ? '#C9CCE0' : '#B07A4A';
      g.lineWidth = 4;
      g.beginPath(); g.roundRect(-cw / 2, -chh / 2, cw, chh, 16); g.fill(); g.stroke();
      g.fillStyle = C.orange;
      g.beginPath(); g.arc(0, -30, 42, 0, Math.PI * 2); g.fill();
      g.fillStyle = C.bg;
      g.font = `700 32px ${FONT.title}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(lot.card.name.split(' ').map((w) => w[0]).join(''), 0, -28);
      g.fillStyle = C.text;
      g.font = `700 18px ${FONT.title}`;
      g.fillText(lot.card.name, 0, 40);
      g.fillStyle = C.muted;
      g.font = `600 14px ${FONT.ui}`;
      g.fillText(`Tier ${lot.card.tier} · ${lot.card.rating}`, 0, 66);
      g.restore();
      g.textBaseline = 'alphabetic';
      const max = lot.leader === null ? TIMING.opening : TIMING.countdown;
      g.strokeStyle = lot.leader === null ? C.muted : PC[lot.leader];
      g.lineWidth = 6;
      g.beginPath(); g.arc(W / 2 + 120, 330, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, lot.timer / max)); g.stroke();
      g.fillStyle = this.flash > 0 ? PC[this.flashP] : C.yellow;
      g.font = `700 ${46 + this.flash * 10}px ${FONT.title}`;
      g.textAlign = 'center';
      g.fillText(`$${lot.price}`, W / 2 - 10, 346);
    }
    if (this.stamp > 0) {
      g.save();
      g.globalAlpha = Math.min(1, this.stamp * 2);
      g.translate(W / 2, 170);
      g.rotate(-0.2);
      g.scale(1 + (1 - Math.min(1, (1 - this.stamp) * 6)) * 0.6, 1 + (1 - Math.min(1, (1 - this.stamp) * 6)) * 0.6);
      g.strokeStyle = this.stampText === 'SOLD' ? PC[this.flashP] : C.muted;
      g.fillStyle = g.strokeStyle;
      g.lineWidth = 5;
      g.font = `700 54px ${FONT.title}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.strokeRect(-110, -38, 220, 76);
      g.fillText(this.stampText, 0, 2);
      g.restore();
    }
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {}
}

export default (): Game => new BidWarPreview();
