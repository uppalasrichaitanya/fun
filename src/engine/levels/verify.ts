import type { Schema } from './schema';

/** What `npm run verify-levels` needs from each Brain Lab game. Pure: no DOM, no canvas. */
export interface Verifier<L> {
  game: string;
  schema: Schema;
  lint?(level: L): string[];
  /** Run the level's stored solution headlessly. */
  run(level: L): { solved: boolean; stars: number; hash: string; note?: string };
}
