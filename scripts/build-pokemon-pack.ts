/**
 * Builds src/games/bid-war/packs/pokemon.json and downloads official artwork
 * into public/packs/pokemon/ so the game never hotlinks.
 *
 *   npm run pack:pokemon            data + images
 *   npm run pack:pokemon -- --no-images
 *
 * Data from PokeAPI (https://pokeapi.co), with its GitHub api-data mirror as a
 * fallback. Artwork is for private friend-group use; public/packs/ is gitignored.
 */
import { resolve } from 'node:path';
import type { Card, Tier } from '../src/games/bid-war/types';
import { exists, getBytes, getJson, pool, saveImage, writePack } from './lib/fetch';

// Hand-picked: popular picks across every generation, 20 Legendary/Mythical.
const IDS = [
  // Gen 1
  1, 3, 4, 6, 7, 9, 18, 25, 26, 31, 34, 35, 36, 38, 39, 52, 54, 59, 65, 68, 76, 78, 80, 92, 94, 95,
  106, 107, 112, 113, 115, 121, 123, 129, 130, 131, 132, 133, 134, 135, 136, 142, 143, 147, 149,
  144, 145, 146, 150, 151,
  // Gen 2
  154, 157, 160, 169, 172, 175, 181, 186, 196, 197, 208, 212, 214, 227, 229, 230, 232, 242, 248,
  243, 244, 245, 249, 250, 251,
  // Gen 3
  254, 257, 260, 282, 286, 302, 306, 310, 330, 334, 350, 359, 373, 376,
  382, 383, 384, 385,
  // Gen 4
  389, 392, 395, 405, 407, 428, 442, 445, 448, 461, 466, 467, 468, 470, 471, 472, 473, 475, 478, 479,
  483, 484, 487, 491, 493,
  // Gen 5
  497, 500, 503, 530, 534, 571, 609, 612, 635, 637,
  643, 644,
  // Gen 6-9
  655, 658, 681, 700, 706, 724, 727, 730, 745, 778, 784, 812, 815, 818, 823, 887, 908, 911, 914, 937, 998,
];

const NAME_FIX: Record<string, string> = {
  'ho-oh': 'Ho-Oh', 'nidoqueen': 'Nidoqueen', 'kommo-o': 'Kommo-o',
};

const HOSTS = (path: string) => [
  `https://pokeapi.co/api/v2/${path}/`,
  `https://raw.githubusercontent.com/PokeAPI/api-data/master/data/api/v2/${path}/index.json`,
];
const ART = (id: number) => [
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`,
];

interface ApiPokemon {
  id: number;
  stats: { base_stat: number; stat: { name: string } }[];
  types: { slot: number; type: { name: string } }[];
  species: { name: string };
}
interface ApiSpecies { is_legendary: boolean; is_mythical: boolean; names: { name: string; language: { name: string } }[] }

const STAT_KEY: Record<string, string> = {
  hp: 'HP', attack: 'Atk', defense: 'Def', 'special-attack': 'SpA', 'special-defense': 'SpD', speed: 'Spe',
};

function title(s: string): string {
  return NAME_FIX[s] ?? s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** S = Legendary/Mythical, A = BST 500+, B = 420-499, C = below 420. */
export function tierFor(bst: number, legendary: boolean): Tier {
  if (legendary) return 'S';
  if (bst >= 500) return 'A';
  if (bst >= 420) return 'B';
  return 'C';
}

/** BST 180..720 mapped onto 30..100 so filler still reads as a real rating. */
export function ratingFor(bst: number): number {
  return Math.round(Math.max(0, Math.min(100, 30 + ((bst - 180) / 540) * 70)));
}

async function main(): Promise<void> {
  const images = !process.argv.includes('--no-images');
  const root = resolve(import.meta.dirname, '..');
  const cards = await pool(IDS, 8, async (id): Promise<Card> => {
    const p = await getJson<ApiPokemon>(HOSTS(`pokemon/${id}`));
    const sp = await getJson<ApiSpecies>(HOSTS(`pokemon-species/${id}`));
    const stats: Record<string, number> = {};
    let bst = 0;
    for (const s of p.stats) { stats[STAT_KEY[s.stat.name]] = s.base_stat; bst += s.base_stat; }
    const types = [...p.types].sort((a, b) => a.slot - b.slot).map((t) => t.type.name);
    const legendary = sp.is_legendary || sp.is_mythical;
    const en = sp.names.find((n) => n.language.name === 'en')?.name;
    const out = resolve(root, 'public/packs/pokemon', String(id));
    let ext = exists(out + '.webp') ? 'webp' : exists(out + '.png') ? 'png' : '';
    if (!ext && images) ext = saveImage(await getBytes(ART(id)), out, 'png', 256);
    // Without a download the path still points where the image will land; the card falls back to drawn art.
    const image = `packs/pokemon/${id}.${ext || 'webp'}`;
    process.stdout.write('.');
    return {
      id: `pkmn-${id}`, name: en ?? title(p.species.name), tier: tierFor(bst, legendary), rating: ratingFor(bst),
      role: types[0], image, stats: { ...stats, BST: bst }, tags: { legendary, types },
    };
  });
  const file = resolve(root, 'src/games/bid-war/packs/pokemon.json');
  writePack(file, 'pokemon', cards);
  const count = (t: Tier) => cards.filter((c) => c.tier === t).length;
  console.log(`\n${cards.length} Pokemon (S ${count('S')} / A ${count('A')} / B ${count('B')} / C ${count('C')}) -> ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
