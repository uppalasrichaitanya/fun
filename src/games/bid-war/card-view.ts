import { h } from '../../shell/dom';
import { BASE_PRICE } from './config';
import { roleLabel } from './scoring';
import type { Card, MatchSettings } from './types';

export const TYPE_COLOR: Record<string, string> = {
  normal: '#A8A77A', fire: '#EE8130', water: '#6390F0', electric: '#F7D02C', grass: '#7AC74C', ice: '#96D9D6',
  fighting: '#C22E28', poison: '#A33EA1', ground: '#E2BF65', flying: '#A98FF3', psychic: '#F95587', bug: '#A6B91A',
  rock: '#B6A136', ghost: '#735797', dragon: '#6F35FC', dark: '#705746', steel: '#B7B7CE', fairy: '#D685AD',
};
export const CRICKET_COLOR: Record<string, string> = {
  Batter: '#FF9F43', Wicketkeeper: '#38E1F5', 'All-rounder': '#9B7BFF', 'Pace bowler': '#FF4F8B', 'Spin bowler': '#4ADE80',
};
export const HERO_COLOR: Record<string, string> = {
  Powerhouse: '#FF4F8B', Genius: '#38E1F5', Fighter: '#FF9F43', Mystic: '#9B7BFF', Speedster: '#FFD93D',
};
/** Short role tags for empty squad slots and tight spaces. */
export const HERO_SHORT: Record<string, string> = { Powerhouse: 'PWR', Genius: 'GEN', Fighter: 'FGT', Mystic: 'MYS', Speedster: 'SPD' };

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const BAT = '<path d="M14.5 3.5l6 6-9.5 9.5-3.5.5.5-3.5z"/><path d="M8 16l-4.5 4.5"/>';
const BALL = '<circle cx="12" cy="12" r="7.5"/><path d="M8 6.5c2 3.5 2 7.5 0 11M16 6.5c-2 3.5-2 7.5 0 11"/>';
export const ROLE_ICON: Record<string, string> = {
  Batter: svg(BAT),
  Wicketkeeper: svg('<path d="M7 21V11a2 2 0 0 1 4 0v-5a2 2 0 0 1 4 0v5.5a2 2 0 0 1 4 0V17a4 4 0 0 1-4 4z"/>'),
  'All-rounder': svg('<path d="M15 3l5 5-7.5 7.5-3 .5.5-3z"/><circle cx="6.5" cy="17.5" r="3.5"/>'),
  'Pace bowler': svg(BALL + '<path d="M2 12h2M3 8.5l1.5.5M3 15.5l1.5-.5"/>'),
  'Spin bowler': svg(BALL + '<path d="M19 4a9 9 0 0 1 2 6"/>'),
};

export function tint(c: Card): string {
  return TYPE_COLOR[c.tags.types?.[0] ?? ''] ?? CRICKET_COLOR[c.role] ?? HERO_COLOR[c.role] ?? '#9A97B8';
}

export function initials(name: string): string {
  const w = name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[w.length - 1][0] : w[0]?.[1] ?? '')).toUpperCase();
}

const STAT_MAX: Record<string, number> = { HP: 160, Atk: 160, Def: 160, SpA: 160, SpD: 160, Spe: 160 };

export type CardSize = 'lg' | 'md' | 'sm';

/** Pack-styled card. `lg` on the stage, `md` in the reveal, `sm` in squad slots. */
export function cardEl(card: Card, s: MatchSettings, size: CardSize): HTMLElement {
  const color = tint(card);
  const el = h(`div.bwc.bwc-${size}.tier-${card.tier}.pack-${s.pack}`, { style: `--tint:${color}`, 'data-id': card.id });
  const art = h('div.bwc-art');
  const fallback = () => h('div.bwc-initials', {}, initials(card.name));
  if (card.image && s.pack !== 'cricket') {
    const img = h('img', { src: card.image, alt: '', draggable: 'false', decoding: 'async', loading: size === 'sm' ? 'lazy' : 'eager' });
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    art.append(img);
    if (s.pack === 'heroes') art.append(h('div.bwc-halftone'));
  } else {
    art.append(fallback());
    if (s.pack === 'cricket') art.append(h('div.bwc-roleicon', { html: ROLE_ICON[card.role] ?? '' }));
  }
  const big = s.pack === 'pokemon' ? card.stats.BST ?? card.rating : card.rating;
  const frame = h('div.bwc-frame', {},
    art,
    h('div.bwc-tier', { title: `Tier ${card.tier}, base $${BASE_PRICE[card.tier]}` }, card.tier),
    h('div.bwc-big', { title: s.pack === 'pokemon' ? 'Base stat total' : 'Rating' }, String(big)),
    s.pack === 'cricket' && s.cricketMode === 'ipl' && card.tags.overseas ? h('div.bwc-os', { title: 'Overseas player' }, 'OS') : null,
    card.tags.legendary ? h('div.bwc-badge', {}, 'LEGENDARY') : null,
    card.tags.cosmic ? h('div.bwc-badge', {}, 'COSMIC') : null,
    h('div.bwc-name', {}, s.pack === 'heroes' ? card.name.toUpperCase() : card.name),
  );
  if (size !== 'sm') {
    frame.append(h('div.bwc-role', {}, roleLine(card, s)));
    frame.append(statBars(card, s));
  }
  el.append(frame);
  return el;
}

function roleLine(card: Card, s: MatchSettings): HTMLElement {
  if (s.pack === 'pokemon') {
    return h('span.bwc-types', {}, ...(card.tags.types ?? [card.role]).map((t) => h('span.type-chip', { style: `--tc:${TYPE_COLOR[t] ?? '#999'}` }, t)));
  }
  if (s.pack === 'heroes') return h('span.role-badge', {}, card.role, card.tags.publisher ? h('small', {}, ` ${card.tags.publisher}`) : null);
  return h('span', {}, roleLabel(card), card.tags.country ? h('small', {}, ` · ${card.tags.country}`) : null);
}

function statBars(card: Card, s: MatchSettings): HTMLElement {
  const keys = s.pack === 'cricket' ? ['Bat', 'Bowl'] : s.pack === 'pokemon' ? ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'] : ['INT', 'STR', 'SPD', 'DUR', 'PWR', 'CMB'];
  const wrap = h('div.bwc-stats');
  for (const k of keys) {
    const v = card.stats[k] ?? 0;
    const pct = Math.max(2, Math.min(100, (v / (STAT_MAX[k] ?? 100)) * 100));
    wrap.append(h('div.bwc-stat', {}, h('span', {}, k), h('i', {}, h('b', { style: `width:${pct}%` })), h('em', {}, String(v))));
  }
  return wrap;
}
