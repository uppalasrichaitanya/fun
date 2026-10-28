// Chapter manifest for the Brain Lab games. The registry builds level select
// from this without loading any level data; `npm run verify-levels` checks it
// against the shipped level files.

export interface ChapterInfo { title: string; count: number }

export const BRAIN_CHAPTERS: Record<string, ChapterInfo[]> = {
  'light-bender': [
    { title: 'Mirrors', count: 10 }, { title: 'Splitters', count: 10 },
    { title: 'Colour', count: 10 }, { title: 'Portals', count: 10 },
  ],
  'maze-maker': [
    { title: 'First walls', count: 10 }, { title: 'Detours', count: 10 },
    { title: 'Labyrinths', count: 10 }, { title: 'Defence', count: 10 },
  ],
  'wire-it': [
    { title: 'Basics', count: 8 }, { title: 'Combos', count: 8 },
    { title: 'Building blocks', count: 8 }, { title: 'Make a calculator', count: 6 },
  ],
  'gravity-golf': [
    { title: 'Home Galaxy', count: 10 }, { title: 'Asteroid Reach', count: 10 },
    { title: 'Moon Gardens', count: 10 }, { title: 'Far Wells', count: 10 },
  ],
  'heist-15': [{ title: 'Museum', count: 12 }, { title: 'Bank', count: 12 }, { title: 'Casino', count: 12 }],
  switchyard: [{ title: 'Countryside', count: 12 }, { title: 'City', count: 12 }, { title: 'Mountains', count: 12 }],
  firebreak: [{ title: 'Spring', count: 10 }, { title: 'Summer drought', count: 10 }, { title: 'Autumn storms', count: 10 }],
};

/** Levels that open on something other than the previous level's first star. */
export const BRAIN_GATES: Record<string, Record<string, string>> = {
  // Defence opens after puzzle 10, alongside the remaining puzzle chapters.
  'maze-maker': { '4-1': '1-10' },
};
