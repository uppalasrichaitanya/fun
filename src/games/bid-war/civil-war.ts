import { glowSprite } from '../../engine/glow';
import { Particles, Shape } from '../../engine/particles';
import { Rng } from '../../engine/rng';
import { settings } from '../../engine/settings';
import { C, FONT, rgba } from '../../engine/theme';
import { ease } from '../../engine/tween';
import { h } from '../../shell/dom';
import { initials } from './card-view';
import type { AuctionState } from './rules';
import { champion, type CivilWar } from './scoring';
import type { BidSfx } from './sfx';
import type { Card, PlayerIdx } from './types';

const W = 1280, H = 720;
const PC = [C.pink, C.cyan] as const;
const INTRO = 2.2, ROUND = 5.4, OUTRO = 3.2;
const TOTAL = INTRO + ROUND * 3 + OUTRO;

/**
 * The two hero teams fight a best-of-3, about 20 s. Every outcome comes from
 * `civilWar()`; the animation only shows it. Random numbers here are visual.
 */
export class CivilWarView {
  private root: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private t = 0;
  private last = -1;
  private raf = 0;
  private teams: Card[][];
  private imgs = new Map<string, HTMLImageElement>();
  private p = new Particles(new Rng(7));
  private rng = new Rng(11);
  private beats = new Set<string>();
  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); this.finish(); }
  };

  constructor(parent: HTMLElement, state: AuctionState, private names: [string, string], private war: CivilWar, private sfx: BidSfx, private done: () => void) {
    this.teams = state.players.map((p) => p.squad.map((b) => b.card));
    for (const c of this.teams.flat()) {
      if (!c.image) continue;
      const img = new Image();
      img.src = c.image;
      this.imgs.set(c.id, img);
    }
    this.cv = h('canvas.bwcw-canvas');
    this.g = this.cv.getContext('2d')!;
    this.root = h('div.bwcw', { role: 'dialog', 'aria-label': 'Civil War' }, this.cv,
      h('button.btn.bwcw-skip', { type: 'button', onclick: () => this.finish() }, 'Skip ', h('kbd', {}, 'Space')));
    parent.append(this.root);
    window.addEventListener('keydown', this.onKey, true);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private resize(): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.cv.width = innerWidth * dpr;
    this.cv.height = innerHeight * dpr;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.last < 0 ? 0.016 : Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    if (this.cv.width !== Math.round(innerWidth * Math.min(2, devicePixelRatio || 1))) this.resize();
    this.p.update(dt);
    this.draw();
    if (this.t >= TOTAL) this.finish();
  };

  private once(key: string, fn: () => void): void {
    if (this.beats.has(key)) return;
    this.beats.add(key);
    fn();
  }

  private draw(): void {
    const g = this.g, cw = this.cv.width, ch = this.cv.height;
    const s = Math.min(cw / W, ch / H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#07070F';
    g.fillRect(0, 0, cw, ch);
    g.setTransform(s, 0, 0, s, (cw - W * s) / 2, (ch - H * s) / 2);
    const t = this.t;
    // Backdrop: split sky in team colours.
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, rgba(C.pink, 0.22)); grad.addColorStop(0.5, '#0B0B18'); grad.addColorStop(1, rgba(C.cyan, 0.22));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (t < INTRO) {
      const k = ease.outBack(Math.min(1, t / 0.6));
      this.title('CIVIL WAR', 360, 120 * k, C.yellow);
      this.title(`${this.names[0]}  vs  ${this.names[1]}`, 450, 40, C.text);
      this.once('intro', () => this.sfx.brass());
      this.drawTeams(1, 1);
      return;
    }
    const rt = t - INTRO;
    const ri = Math.min(2, Math.floor(rt / ROUND));
    const lt = rt - ri * ROUND;
    if (t < INTRO + ROUND * 3) this.drawRound(ri, lt);
    else this.drawOutro(t - INTRO - ROUND * 3);
    this.p.render(g);
    // Round score pips.
    for (let r = 0; r < 3; r++) {
      const done = t >= INTRO + (r + 1) * ROUND - 1.4;
      const w = this.war.rounds[r].winner;
      g.fillStyle = done && w !== null ? PC[w] : 'rgba(255,255,255,.15)';
      g.beginPath(); g.arc(W / 2 - 40 + r * 40, 40, 10, 0, Math.PI * 2); g.fill();
    }
  }

  private title(text: string, y: number, size: number, color: string): void {
    const g = this.g;
    g.font = `700 ${Math.max(1, size)}px ${FONT.title}`;
    g.fillStyle = color;
    g.fillText(text, W / 2, y);
  }

  private drawRound(ri: number, lt: number): void {
    const g = this.g, round = this.war.rounds[ri];
    const keys = round.keys;
    const winner = round.winner;
    // 0-0.8 title, 0.8-2.8 bars race, 2.8-4 clash, 4-5.4 result.
    this.title(`ROUND ${ri + 1}`, 92, 26, C.muted);
    this.title(round.name.toUpperCase(), 132, 44, C.yellow);
    this.once(`r${ri}`, () => this.sfx.gavelBang());
    const max = Math.max(1, ...round.totals);
    const race = Math.min(1, Math.max(0, (lt - 0.8) / 2));
    const k = ease.outCubic(race);
    for (const p of [0, 1] as PlayerIdx[]) {
      const y = 190 + p * 46;
      const w = 460 * (round.totals[p] / max) * k;
      g.fillStyle = 'rgba(255,255,255,.06)';
      g.fillRect(W / 2 - 230, y, 460, 30);
      g.fillStyle = PC[p];
      g.fillRect(W / 2 - 230, y, w, 30);
      g.font = `600 18px ${FONT.ui}`;
      g.textAlign = 'right';
      g.fillStyle = C.text;
      g.fillText(this.names[p], W / 2 - 244, y + 16);
      g.textAlign = 'left';
      g.font = `700 22px ${FONT.title}`;
      g.fillText(String(Math.round(round.totals[p] * k)), W / 2 - 230 + w + 10, y + 16);
      g.textAlign = 'center';
    }
    g.font = `500 15px ${FONT.ui}`;
    g.fillStyle = C.muted;
    g.fillText(`Team total: ${keys[0]} + ${keys[1]}`, W / 2, 292);
    if (race > 0 && race < 1 && Math.floor(lt * 12) % 2 === 0) this.once(`tick${ri}${Math.floor(lt * 12)}`, () => this.sfx.tick());

    // Clash line: starts centred, pushed toward the loser.
    const clash = Math.min(1, Math.max(0, (lt - 2.8) / 1.2));
    const push = winner === null ? 0 : (winner === 0 ? 1 : -1) * 170 * ease.outBack(clash);
    const cx = W / 2 + push;
    const all = ri === 2;
    const champs = this.teams.map((t) => all ? t : [champion(t, keys)].filter((c): c is Card => !!c));
    const charge = ease.inCubic(Math.min(1, Math.max(0, (lt - 2.2) / 0.6)));
    for (const p of [0, 1] as PlayerIdx[]) {
      const dir = p === 0 ? 1 : -1;
      const homeX = p === 0 ? 210 : W - 210;
      const x = homeX + (cx - dir * 70 - homeX) * charge;
      const list = champs[p];
      list.forEach((c, i) => {
        const off = (i - (list.length - 1) / 2) * (all ? 62 : 0);
        this.portrait(c, x - dir * Math.abs(off) * 0.4, 470 + off, all ? 30 : 64, PC[p]);
      });
    }
    if (clash > 0 && clash < 1) {
      this.once(`hit${ri}`, () => {
        this.sfx.bigDrum();
        const col = [C.yellow, C.white, winner === null ? C.violet : PC[winner]];
        this.p.burst(cx, 470, C.yellow, { count: 50, speed: 520, life: 0.9, size: 6, colors: col, shape: ri === 1 ? Shape.Dot : Shape.Spark });
      });
      this.effect(ri, cx, clash);
    }
    if (lt > 4) {
      const label = winner === null ? 'DRAW' : `${this.names[winner].toUpperCase()} TAKES IT`;
      this.title(label, 640, 40, winner === null ? C.muted : PC[winner]);
      this.once(`res${ri}`, () => { if (winner !== null) this.sfx.ooh(1.5); });
    }
  }

  /** Round-specific clash visuals: shockwave, holographic board, beam collision. */
  private effect(ri: number, cx: number, k: number): void {
    const g = this.g;
    g.save();
    g.globalCompositeOperation = 'lighter';
    if (ri === 0) {
      for (let i = 0; i < 3; i++) {
        const r = (k * 1.4 - i * 0.15) * 340;
        if (r <= 0) continue;
        g.strokeStyle = rgba(C.yellow, Math.max(0, 0.6 - k * 0.5));
        g.lineWidth = 8 - i * 2;
        g.beginPath(); g.ellipse(cx, 470, r, r * 0.35, 0, 0, Math.PI * 2); g.stroke();
      }
    } else if (ri === 1) {
      for (let x = -4; x < 4; x++) for (let y = -2; y < 2; y++) {
        if ((x + y + Math.floor(k * 12)) % 3 !== 0) continue;
        g.fillStyle = rgba(C.cyan, 0.25 * (1 - k) + this.rng.next() * 0.1);
        g.fillRect(cx + x * 44, 470 + y * 44, 40, 40);
      }
    } else {
      const glow = glowSprite(C.white);
      for (const p of [0, 1]) {
        const x0 = p === 0 ? 0 : W;
        g.strokeStyle = rgba(PC[p], 0.9);
        g.lineWidth = 18 * (1 - k * 0.5);
        g.beginPath(); g.moveTo(x0, 470); g.lineTo(cx, 470); g.stroke();
      }
      g.drawImage(glow, cx - 160, 470 - 160, 320, 320);
    }
    g.restore();
    if (settings.motion && ri === 2) {
      const flash = Math.max(0, 0.35 - k * 0.35);
      g.fillStyle = `rgba(255,255,255,${flash})`;
      g.fillRect(0, 0, W, H);
    }
  }

  private drawOutro(t: number): void {
    const w = this.war.winner;
    if (w === null) {
      this.title('STALEMATE', 300, 90, C.muted);
      this.title('Equal in every way. Suspicious.', 380, 28, C.text);
      this.drawTeams(1, 1);
      return;
    }
    // Slow-motion victory pose: the winners rise, the losers fade.
    const k = ease.outCubic(Math.min(1, t / 1.2));
    this.once('win', () => {
      this.sfx.fanfare();
      this.p.confetti(W / 2, 700, -Math.PI / 2, [PC[w], C.yellow, C.white], 80, 1100);
    });
    this.title(`${this.names[w].toUpperCase()} WINS`, 170, 80 * ease.outBack(Math.min(1, t / 0.7)), PC[w]);
    this.title(`Civil War ${Math.max(...this.war.wins)}-${Math.min(...this.war.wins)}`, 240, 30, C.text);
    const team = this.teams[w];
    const gap = Math.min(220, 1180 / team.length);
    team.forEach((c, i) => {
      const x = W / 2 + (i - (team.length - 1) / 2) * gap;
      this.portrait(c, x, 480 - 40 * k, Math.min(56, gap * 0.36), PC[w], 1, gap - 12);
    });
  }

  private drawTeams(a: number, b: number): void {
    for (const p of [0, 1] as PlayerIdx[]) {
      const team = this.teams[p];
      team.forEach((c, i) => {
        const x = p === 0 ? 120 + (i % 3) * 120 : W - 120 - (i % 3) * 120;
        const y = 560 + Math.floor(i / 3) * 110 - 40;
        this.portrait(c, x, y, 46, PC[p], p === 0 ? a : b);
      });
    }
  }

  private portrait(c: Card, x: number, y: number, r: number, color: string, alpha = 1, labelW = 200): void {
    const g = this.g;
    g.save();
    g.globalAlpha = alpha;
    g.drawImage(glowSprite(color), x - r * 1.8, y - r * 1.8, r * 3.6, r * 3.6);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = '#15152A'; g.fill();
    g.save();
    g.clip();
    const img = this.imgs.get(c.id);
    if (img && img.complete && img.naturalWidth) {
      const k = (r * 2) / Math.min(img.naturalWidth, img.naturalHeight);
      g.drawImage(img, x - (img.naturalWidth * k) / 2, y - r * 1.1, img.naturalWidth * k, img.naturalHeight * k);
    } else {
      g.fillStyle = color;
      g.font = `700 ${r * 0.8}px ${FONT.title}`;
      g.textAlign = 'center';
      g.fillText(initials(c.name), x, y + 2);
    }
    g.restore();
    g.lineWidth = 4; g.strokeStyle = color; g.stroke();
    if (r >= 34) {
      g.font = `700 ${Math.round(Math.max(13, r * 0.3))}px ${FONT.title}`;
      g.fillStyle = C.text;
      g.textAlign = 'center';
      let name = c.name.toUpperCase();
      while (name.length > 3 && g.measureText(name).width > labelW) name = name.slice(0, -2) + '…';
      g.fillText(name, x, y + r + 18);
    }
    g.restore();
  }

  private finish(): void {
    if (!this.root.isConnected) return;
    this.done();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
