import type { LevelDef } from './sim';

// Handcrafted levels live as JSON, one file per level.
const files = import.meta.glob<LevelDef>('./levels/*.json', { eager: true, import: 'default' });
export const LEVELS: LevelDef[] = Object.keys(files).sort().map((k) => files[k]);
