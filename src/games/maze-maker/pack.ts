import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type MMLevel } from './logic';

const files = import.meta.glob<ChapterFile<MMLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('maze-maker', files, LEVEL_SCHEMA, lintLevel);
