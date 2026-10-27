import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type GGLevel } from './logic';

const files = import.meta.glob<ChapterFile<GGLevel>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('gravity-golf', files, LEVEL_SCHEMA, lintLevel);
