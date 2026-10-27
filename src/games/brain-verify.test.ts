import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChapterFile } from '../engine/levels/pack';
import { verifyAll } from './brain-verify';

const read = (game: string): Record<string, ChapterFile<unknown>> => {
  const dir = join(__dirname, game, 'levels');
  const out: Record<string, ChapterFile<unknown>> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) out[f] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
};

describe('Brain Lab levels', () => {
  const report = verifyAll(read);
  it('every level is valid, solvable by its stored solution, and deterministic', () => {
    expect(report.errors).toEqual([]);
  });
  it('every stored solution earns 3 stars', () => {
    expect(report.levels.filter((l) => l.stars !== 3).map((l) => `${l.game} ${l.id}`)).toEqual([]);
  });
});
