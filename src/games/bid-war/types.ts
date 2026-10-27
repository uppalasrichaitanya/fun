export type Tier = 'S' | 'A' | 'B' | 'C';
export type PackId = 'cricket' | 'pokemon' | 'heroes';
export type PlayerIdx = 0 | 1;

export interface CardTags {
  overseas?: boolean;
  legendary?: boolean;
  cosmic?: boolean;
  types?: string[];
  country?: string;
  publisher?: string;
}

/** One auction lot. Shared by every pack. */
export interface Card {
  id: string;
  name: string;
  tier: Tier;
  /** 0-100, drives auto score. */
  rating: number;
  /** Pack-specific role (cricket role, primary type, hero role). */
  role: string;
  /** Path relative to the site root, e.g. "packs/pokemon/25.webp". */
  image?: string;
  /** Shown as mini bars on the card. */
  stats: Record<string, number>;
  tags: CardTags;
  /** Generic filler created when the pool runs dry. */
  reserve?: boolean;
}

export interface Pack {
  id: PackId;
  cards: Card[];
}

export type SquadSize = 3 | 4 | 6 | 12;
export type PurseFeel = 'tight' | 'normal' | 'loose';

export interface MatchSettings {
  pack: PackId;
  squadSize: SquadSize;
  /** Cricket only. */
  cricketMode: 'ipl' | 'general';
  /** Cricket only. All S-tier lots first. */
  marqueeFirst: boolean;
  /** Superheroes only. */
  roster: 'marvel' | 'both';
  purseFeel: PurseFeel;
  /** Show the next 3 lots. */
  showUpcoming: boolean;
}
