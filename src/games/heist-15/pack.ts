import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type HLevel } from './logic';

const files = import.meta.glob<ChapterFile<HLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('heist-15', files, LEVEL_SCHEMA, lintLevel);
