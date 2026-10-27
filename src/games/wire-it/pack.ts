import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type WILevel } from './logic';

const files = import.meta.glob<ChapterFile<WILevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('wire-it', files, LEVEL_SCHEMA, lintLevel);
