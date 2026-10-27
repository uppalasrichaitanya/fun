import './bid-war.css';
import { AudioBus, engine } from '../../engine/audio';
import { h } from '../../shell/dom';
import type { App } from '../registry';
import { AuctionView } from './auction-view';
import { pursesFor } from './config';
import { loadPack, prefetchImages } from './packs';
import { buildPool, codeForSeed } from './pool';
import { Results } from './results';
import type { Auction } from './rules';
import { Setup, type SetupResult } from './setup';
import { BidSfx } from './sfx';

/** Bid War runs its own screens: setup, auction, results. */
class BidWarApp implements App {
  private root: HTMLElement;
  private audio = new AudioBus(true);
  private sfx = new BidSfx(this.audio);
  private screen: { destroy(): void } | null = null;
  private last: SetupResult | null = null;
  private gen = 0;

  constructor(parent: HTMLElement) {
    this.root = h('div.bw');
    parent.append(this.root);
    this.showSetup();
  }

  private swap(next: { destroy(): void } | null): void {
    this.screen?.destroy();
    this.screen = next;
    window.scrollTo(0, 0);
  }

  private showSetup(step = 0): void {
    this.audio.stopMusic();
    this.swap(new Setup(this.root, this.sfx, (r) => void this.startAuction(r), () => { location.hash = '#/'; }, step));
  }

  private async startAuction(r: SetupResult): Promise<void> {
    engine.unlock();
    this.last = r;
    const gen = ++this.gen;
    this.swap({ destroy: () => loading.remove() });
    const loading = h('div.bw-loading', {}, h('div.dot'), 'Shuffling the pool...');
    this.root.append(loading);
    const pack = await loadPack(r.settings.pack);
    if (gen !== this.gen) return;
    prefetchImages(pack);
    const pool = buildPool(pack, r.settings, r.seed);
    if (pool.problem) console.warn(`[bid-war] pool check "${pool.problem}" still failing after ${pool.tries} draws`);
    this.swap(new AuctionView(this.root, {
      setup: r, pool: pool.cards, purse: pursesFor(r.settings.squadSize, r.settings.purseFeel), audio: this.audio, sfx: this.sfx,
      onEnd: (a) => this.showResults(r, a),
      onQuit: (toHub) => { if (toHub) location.hash = '#/'; else this.showSetup(); },
    }));
  }

  private showResults(r: SetupResult, auction: Auction): void {
    this.swap(new Results(this.root, {
      setup: r, auction, audio: this.audio, sfx: this.sfx,
      onRematch: () => this.rematch(),
      onNew: () => this.showSetup(),
      onHub: () => { location.hash = '#/'; },
    }));
  }

  /** Same names and settings, fresh draw. */
  private rematch(): void {
    if (!this.last) { this.showSetup(); return; }
    const seed = Date.now() >>> 0;
    void this.startAuction({ ...this.last, seed, code: codeForSeed(seed), opener: Math.random() < 0.5 ? 0 : 1 });
  }

  destroy(): void {
    this.gen++;
    this.screen?.destroy();
    this.sfx.stop();
    this.audio.stopMusic();
    this.audio.duck(false);
    this.root.remove();
  }
}

export default (parent: HTMLElement): App => new BidWarApp(parent);
