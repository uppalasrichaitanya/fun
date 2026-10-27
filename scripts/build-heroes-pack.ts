/**
 * Builds src/games/bid-war/packs/heroes.json from the free akabab Superhero API
 * (all.json) and downloads hero images into public/packs/heroes/.
 *
 *   npm run pack:heroes            data + images
 *   npm run pack:heroes -- --no-images
 *
 * Heroes only. Tiers and roles are hand-assigned here; rating and stat fixes
 * live in packs/heroes.overrides.json and are applied when the game loads.
 * Images are for private friend-group use; public/packs/ is gitignored.
 */
import { resolve } from 'node:path';
import type { Card, Tier } from '../src/games/bid-war/types';
import { exists, getBytes, getJson, pool, saveImage, writePack } from './lib/fetch';

type Role = 'Powerhouse' | 'Genius' | 'Fighter' | 'Mystic' | 'Speedster';
type Pick = [id: number, publisher: 'Marvel' | 'DC', tier: Tier, role: Role, name?: string, cosmic?: boolean];

// prettier-ignore
const PICKS: Pick[] = [
  // Marvel: Cosmic tier
  [659, 'Marvel', 'S', 'Powerhouse', 'Thor'], [332, 'Marvel', 'S', 'Powerhouse'], [579, 'Marvel', 'S', 'Mystic'],
  [226, 'Marvel', 'S', 'Mystic'], [157, 'Marvel', 'S', 'Powerhouse'], [697, 'Marvel', 'S', 'Genius'],
  [517, 'Marvel', 'S', 'Mystic'], [598, 'Marvel', 'S', 'Speedster'],
  // Marvel: A
  [346, 'Marvel', 'A', 'Genius'], [106, 'Marvel', 'A', 'Fighter'], [717, 'Marvel', 'A', 'Fighter'], [638, 'Marvel', 'A', 'Mystic'],
  [527, 'Marvel', 'A', 'Genius'], [456, 'Marvel', 'A', 'Genius'], [344, 'Marvel', 'A', 'Mystic'], [333, 'Marvel', 'A', 'Speedster'],
  [658, 'Marvel', 'A', 'Powerhouse'], [589, 'Marvel', 'A', 'Powerhouse'], [481, 'Marvel', 'A', 'Powerhouse'], [96, 'Marvel', 'A', 'Mystic'],
  [567, 'Marvel', 'A', 'Powerhouse'], [196, 'Marvel', 'A', 'Fighter'], [325, 'Marvel', 'A', 'Powerhouse'], [79, 'Marvel', 'A', 'Powerhouse'],
  [496, 'Marvel', 'A', 'Speedster'], [703, 'Marvel', 'A', 'Genius'], [280, 'Marvel', 'A', 'Mystic'], [185, 'Marvel', 'A', 'Powerhouse'],
  // Marvel: B
  [149, 'Marvel', 'B', 'Fighter'], [620, 'Marvel', 'B', 'Speedster'], [107, 'Marvel', 'B', 'Fighter'], [201, 'Marvel', 'B', 'Fighter'],
  [714, 'Marvel', 'B', 'Fighter'], [470, 'Marvel', 'B', 'Fighter'], [587, 'Marvel', 'B', 'Fighter'], [345, 'Marvel', 'B', 'Mystic'],
  [112, 'Marvel', 'B', 'Fighter'], [75, 'Marvel', 'B', 'Genius'], [274, 'Marvel', 'B', 'Mystic'], [490, 'Marvel', 'B', 'Speedster'],
  [339, 'Marvel', 'B', 'Mystic'], [234, 'Marvel', 'B', 'Powerhouse', 'Drax'], [275, 'Marvel', 'B', 'Fighter'], [630, 'Marvel', 'B', 'Genius'],
  [303, 'Marvel', 'B', 'Powerhouse'], [619, 'Marvel', 'B', 'Speedster'], [723, 'Marvel', 'B', 'Fighter'], [529, 'Marvel', 'B', 'Mystic'],
  [145, 'Marvel', 'B', 'Genius'], [586, 'Marvel', 'B', 'Genius'],
  // Marvel: C
  [313, 'Marvel', 'C', 'Fighter'], [251, 'Marvel', 'C', 'Speedster'], [31, 'Marvel', 'C', 'Genius', 'Ant-Man'], [708, 'Marvel', 'C', 'Speedster'],
  [566, 'Marvel', 'C', 'Genius'], [530, 'Marvel', 'C', 'Fighter'], [372, 'Marvel', 'C', 'Mystic'], [211, 'Marvel', 'C', 'Mystic'],
  [431, 'Marvel', 'C', 'Mystic'], [99, 'Marvel', 'C', 'Speedster'], [238, 'Marvel', 'C', 'Fighter'], [489, 'Marvel', 'C', 'Genius'],
  // DC
  [644, 'DC', 'S', 'Powerhouse', 'Superman'], [720, 'DC', 'S', 'Powerhouse'], [156, 'DC', 'S', 'Mystic', 'Shazam'],
  [70, 'DC', 'A', 'Genius'], [263, 'DC', 'A', 'Speedster'], [306, 'DC', 'A', 'Mystic', 'Green Lantern'], [432, 'DC', 'A', 'Powerhouse'],
  [38, 'DC', 'A', 'Powerhouse'], [524, 'DC', 'A', 'Powerhouse'], [643, 'DC', 'A', 'Speedster'], [194, 'DC', 'A', 'Genius'],
  [224, 'DC', 'A', 'Mystic'], [632, 'DC', 'A', 'Powerhouse'],
  [298, 'DC', 'B', 'Fighter'], [98, 'DC', 'B', 'Fighter', 'Black Canary'], [76, 'DC', 'B', 'Speedster'], [315, 'DC', 'B', 'Fighter'],
  [367, 'DC', 'B', 'Mystic'], [730, 'DC', 'B', 'Mystic'], [103, 'DC', 'B', 'Speedster'], [126, 'DC', 'B', 'Genius', 'Blue Beetle'],
  [564, 'DC', 'C', 'Fighter', 'Robin'], [66, 'DC', 'C', 'Fighter', 'Batgirl'], [520, 'DC', 'C', 'Powerhouse'], [384, 'DC', 'C', 'Speedster'],
  [633, 'DC', 'C', 'Mystic'],
];

/** Ratings sit inside a band per tier so the tier always reads right; powerstats pick the spot in the band. */
const BAND: Record<Tier, [number, number]> = { S: [88, 98], A: [74, 88], B: [62, 77], C: [48, 64] };

interface ApiHero {
  id: number; name: string; slug: string;
  powerstats: Record<'intelligence' | 'strength' | 'speed' | 'durability' | 'power' | 'combat', number>;
  biography: { alignment: string };
}

const BASE = [
  'https://akabab.github.io/superhero-api/api',
  'https://raw.githubusercontent.com/akabab/superhero-api/master/api',
];

async function main(): Promise<void> {
  const images = !process.argv.includes('--no-images');
  const root = resolve(import.meta.dirname, '..');
  const all = await getJson<ApiHero[]>(BASE.map((b) => `${b}/all.json`));
  const byId = new Map(all.map((h) => [h.id, h]));
  const cards = await pool(PICKS, 8, async ([id, publisher, tier, role, name]): Promise<Card> => {
    const h = byId.get(id);
    if (!h) throw new Error(`hero ${id} missing from all.json`);
    const p = h.powerstats;
    const stats = { INT: p.intelligence, STR: p.strength, SPD: p.speed, DUR: p.durability, PWR: p.power, CMB: p.combat };
    const avg = Object.values(stats).reduce((a, b) => a + b, 0) / 6;
    const [lo, hi] = BAND[tier];
    const out = resolve(root, 'public/packs/heroes', String(id));
    let ext = exists(out + '.webp') ? 'webp' : exists(out + '.jpg') ? 'jpg' : '';
    if (!ext && images) ext = saveImage(await getBytes(BASE.map((b) => `${b}/images/md/${h.slug}.jpg`)), out, 'jpg', 240);
    process.stdout.write('.');
    return {
      id: `hero-${id}`, name: name ?? h.name, tier, rating: Math.round(lo + (hi - lo) * (avg / 100)), role,
      image: `packs/heroes/${id}.${ext || 'webp'}`, stats,
      tags: { cosmic: tier === 'S', publisher },
    };
  });
  const file = resolve(root, 'src/games/bid-war/packs/heroes.json');
  writePack(file, 'heroes', cards);
  const n = (pub: string) => cards.filter((c) => c.tags.publisher === pub).length;
  console.log(`\n${cards.length} heroes (Marvel ${n('Marvel')}, DC ${n('DC')}) -> ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
