// Runs every Brain Lab level's stored solution headlessly (3 times each, comparing
// final-state hashes) and exits non-zero if any level is invalid or unsolvable.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChapterFile } from '../src/engine/levels/pack';
import { verifyAll } from '../src/games/brain-verify';

const read = (game: string): Record<string, ChapterFile<unknown>> => {
  const dir = join('src/games', game, 'levels');
  const out: Record<string, ChapterFile<unknown>> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) out[f] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
};

const t0 = Date.now();
const { levels, errors } = verifyAll(read);
const byGame = new Map<string, typeof levels>();
for (const l of levels) byGame.set(l.game, [...(byGame.get(l.game) ?? []), l]);
for (const [game, ls] of byGame) {
  const solved = ls.filter((l) => l.solved).length;
  const three = ls.filter((l) => l.stars === 3).length;
  console.log(`${game.padEnd(16)} ${solved}/${ls.length} solvable, ${three} stored solutions earn 3 stars, deterministic ${ls.every((l) => l.deterministic) ? 'yes' : 'NO'}`);
}
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n` + errors.map((e) => '  ' + e).join('\n'));
  process.exit(1);
}
console.log(`All ${levels.length} levels verified in ${Date.now() - t0} ms.`);
