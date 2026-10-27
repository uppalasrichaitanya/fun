export type WeaponId = 'bolt' | 'orbit' | 'chain' | 'aura' | 'boomerang' | 'frost';
export type PassiveId = 'boots' | 'magnet' | 'might' | 'haste' | 'vitality' | 'multishot';
export type EnemyType = 'blob' | 'bat' | 'brute' | 'spitter' | 'boss';

export const MAX_LEVEL = 5;
export const MAX_WEAPONS = 4;
export const MAX_PASSIVES = 4;

export const WEAPONS: Record<WeaponId, { name: string; icon: string; color: string; desc: string; ups: string[] }> = {
  bolt: { name: 'Magic Bolt', icon: '✦', color: '#38E1F5', desc: 'Fires at the nearest enemy.', ups: ['+1 bolt', '+1 pierce', '-20% cooldown', '+1 bolt, +1 pierce'] },
  orbit: { name: 'Orbit Blades', icon: '◈', color: '#9B7BFF', desc: 'Two blades circle you.', ups: ['+1 blade', '+15 radius, faster', '+1 blade', '+15 radius, faster'] },
  chain: { name: 'Chain Lightning', icon: 'ϟ', color: '#FFD93D', desc: 'Strikes and jumps to 3 more.', ups: ['+1 jump', '+5 damage', '+1 jump', '+5 damage'] },
  aura: { name: 'Ember Aura', icon: '◉', color: '#FF9F43', desc: 'Burns everything close.', ups: ['+12 radius', '+2 damage', '+12 radius', '+2 damage'] },
  boomerang: { name: 'Boomerang', icon: '↺', color: '#4ADE80', desc: 'Thrown ahead, comes back.', ups: ['+1 boomerang', '+40 range', '+1 boomerang', '+40 range'] },
  frost: { name: 'Frost Nova', icon: '❄', color: '#A5F3FC', desc: 'Freezing ring every 4 s.', ups: ['+0.5 s slow', '+25 radius', '+0.5 s slow', '+25 radius'] },
};

export const PASSIVES: Record<PassiveId, { name: string; icon: string; color: string; desc: string }> = {
  boots: { name: 'Swift Boots', icon: '»', color: '#4ADE80', desc: '+10% speed' },
  magnet: { name: 'Magnet', icon: '∩', color: '#38E1F5', desc: '+35% pickup radius' },
  might: { name: 'Might', icon: '✊', color: '#FF4F8B', desc: '+15% damage' },
  haste: { name: 'Haste', icon: '⧗', color: '#FFD93D', desc: '-8% cooldowns' },
  vitality: { name: 'Vitality', icon: '♥', color: '#FF4F8B', desc: '+20 max HP, full heal' },
  multishot: { name: 'Multishot', icon: '⁂', color: '#9B7BFF', desc: '+1 projectile' },
};

export const ENEMIES: Record<EnemyType, { hp: number; speed: number; r: number; dmg: number; color: string; cost: number; xp: number }> = {
  blob: { hp: 10, speed: 55, r: 9, dmg: 8, color: '#4ADE80', cost: 1, xp: 1 },
  bat: { hp: 6, speed: 110, r: 7, dmg: 5, color: '#9B7BFF', cost: 1, xp: 1 },
  brute: { hp: 70, speed: 40, r: 15, dmg: 18, color: '#FF9F43', cost: 5, xp: 5 },
  spitter: { hp: 18, speed: 60, r: 9, dmg: 10, color: '#FF4F8B', cost: 2, xp: 1 },
  boss: { hp: 1500, speed: 45, r: 42, dmg: 25, color: '#4ADE80', cost: 0, xp: 25 },
};

export const PLAYER = { hp: 100, speed: 170, pickup: 50, invuln: 0.6, r: 8 } as const;

/** XP needed to go from level n to n + 1. */
export const xpFor = (n: number): number => 5 + 6 * (n - 1);

export const RUN_TIME = 180;
export const CAP = 350;
