import { loadPack, type ChapterFile } from '../../engine/levels/pack';
import { LEVEL_SCHEMA, lintLevel, type RMission } from './logic';

const files = import.meta.glob<ChapterFile<RMission>>('./levels/*.json', { eager: true, import: 'default' });
export const pack = loadPack('rocket-builder', files, LEVEL_SCHEMA, lintLevel);
