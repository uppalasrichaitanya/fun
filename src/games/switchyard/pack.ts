import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type SYLevel } from './logic';

const files = import.meta.glob<ChapterFile<SYLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('switchyard', files, LEVEL_SCHEMA, lintLevel);
