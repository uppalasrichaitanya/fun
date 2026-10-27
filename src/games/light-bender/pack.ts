import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type LBLevel } from './logic';

const files = import.meta.glob<ChapterFile<LBLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('light-bender', files, LEVEL_SCHEMA, lintLevel);
