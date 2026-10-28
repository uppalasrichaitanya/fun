import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type FBLevel } from './logic';

const files = import.meta.glob<ChapterFile<FBLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('firebreak', files, LEVEL_SCHEMA, lintLevel);
