import type { Card, Pack, PackId } from './types';

export interface Overrides { cards: Record<string, Partial<Omit<Card, 'id'>>> }

/** Overrides replace fields; `stats` and `tags` merge key by key. */
export function applyOverrides(pack: Pack, ov: Overrides | undefined): Pack {
  if (!ov?.cards) return pack;
  return {
    id: pack.id,
    cards: pack.cards.map((c) => {
      const o = ov.cards[c.id];
      if (!o) return c;
      return { ...c, ...o, id: c.id, stats: { ...c.stats, ...o.stats }, tags: { ...c.tags, ...o.tags } };
    }),
  };
}

const LOADERS: Record<PackId, () => Promise<[{ default: unknown }, { default: unknown }]>> = {
  cricket: () => Promise.all([import('./packs/cricket.json'), import('./packs/cricket.overrides.json')]),
  pokemon: () => Promise.all([import('./packs/pokemon.json'), import('./packs/pokemon.overrides.json')]),
  heroes: () => Promise.all([import('./packs/heroes.json'), import('./packs/heroes.overrides.json')]),
};

const cache = new Map<PackId, Pack>();

/** Bundled with the site (one lazy chunk per pack): works offline, never calls an API. */
export async function loadPack(id: PackId): Promise<Pack> {
  const hit = cache.get(id);
  if (hit) return hit;
  const [p, o] = await LOADERS[id]();
  const pack = applyOverrides(p.default as Pack, o.default as Overrides);
  cache.set(id, pack);
  return pack;
}

/** Warm the browser (and service worker) cache with a pack's artwork so it works offline later. */
export function prefetchImages(pack: Pack): void {
  const urls = pack.cards.map((c) => c.image).filter((u): u is string => !!u);
  let i = 0;
  const next = () => {
    if (i >= urls.length) return;
    const img = new Image();
    img.onload = img.onerror = () => setTimeout(next, 0);
    img.src = urls[i++];
  };
  for (let k = 0; k < 4; k++) next();
}
