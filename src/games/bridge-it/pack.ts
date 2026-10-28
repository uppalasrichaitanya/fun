import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type BLevel } from './logic';

const files = import.meta.glob<ChapterFile<BLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('bridge-it', files, LEVEL_SCHEMA, lintLevel);
