import type { Rng } from '../../engine/rng';
import type { PackId } from './types';

export type Moment =
  | 'lot' | 'lotStar' | 'bid' | 'jump' | 'war' | 'once' | 'twice' | 'sold' | 'soldBig' | 'steal' | 'unsold'
  | 'allIn' | 'allInFailed' | 'locked' | 'take' | 'leave' | 'free' | 'unsoldRound' | 'end' | 'undo' | 'solo';

export type Vars = Record<string, string | number>;

// About 60 templates. {name} slots are filled from Vars; missing ones fall back to "someone".
const LINES: Record<Moment, string[]> = {
  lot: [
    '{card} on the block. Base price ${base}.',
    'Next up: {card}. Opening at ${base}.',
    '{card}, ladies and gentlemen. ${base} to start.',
    'Who wants {card}? Base ${base}.',
    'Lot {lot}: {card}. Hands ready.',
  ],
  lotStar: [
    '{card} on the block. Base price ${base}. Who wants a legend?',
    'Marquee lot! {card}. Wallets out.',
    'This is the one. {card}, starting at ${base}.',
    '{card}. The crowd goes quiet. ${base} to open.',
  ],
  bid: [
    '${price} from {leader}! Do I hear ${next}?',
    '{leader} says ${price}.',
    '${price}, {leader} leads. {trailer}?',
    '{leader} at ${price}. Your move, {trailer}.',
    'Bid! ${price} to {leader}.',
    '{trailer}, it is ${price} against you.',
  ],
  jump: [
    '{leader} jumps to ${price}! Statement bid.',
    'Whoa. ${price} from {leader}. No messing about.',
    '{leader} skips the small talk: ${price}.',
  ],
  war: [
    '{P1} and {P2} really don\'t like each other right now.',
    'BIDDING WAR! ${price} and climbing.',
    'Somebody open a window, it is getting heated in here.',
    'This is personal now. ${price}.',
  ],
  once: [
    'Going once... {trailer}, your wallet is shaking.',
    'Going once at ${price}...',
    '${price}, going once. Last chance, {trailer}.',
  ],
  twice: [
    'Going twice...',
    'Going twice! {trailer}, speak now.',
    'Twice at ${price}. Hammer is up.',
  ],
  sold: [
    'SOLD to {leader} for ${price}.',
    'SOLD! {card} joins {leader} for ${price}.',
    '{leader} gets {card}. ${price}, done.',
    'Hammer down. {card} to {leader}.',
  ],
  soldBig: [
    'SOLD to {leader} for ${price}. Accountants are crying.',
    '${price}?! {leader} has lost the plot. SOLD.',
    'SOLD for ${price}. {leader} wanted that one badly.',
  ],
  steal: [
    'A steal at ${price}! Somebody check {leader}\'s pockets.',
    '{card} for ${price}? Daylight robbery.',
    '{trailer} just let {card} go for ${price}. Bold.',
  ],
  unsold: [
    'Nobody? {card} will remember this.',
    'UNSOLD. {card} walks off in silence.',
    'No takers for {card}. Ouch.',
    '{card} goes to the unsold tray. For now.',
  ],
  allIn: [
    '{player} goes ALL IN! Bold. Possibly stupid. Definitely entertaining.',
    'ALL IN from {player}! ${price} on {card}!',
    '{player} pushes every dollar into the middle!',
  ],
  allInFailed: [
    'Outbid! {player}\'s all-in crumbles.',
    '{other} calls the bluff. All-in gone, {player}.',
    'All in... and not enough. Sorry, {player}.',
  ],
  locked: [
    '{player} is locked. {other}, it\'s shopping day.',
    '{player} is out of money and out of moves. {other} shops alone.',
  ],
  solo: [
    '{other} alone on {card}. Take it for ${base}, or leave it.',
    'Take or leave, {other}? ${base} for {card}.',
  ],
  take: [
    '{leader} takes {card} for ${price}.',
    'Into the cart: {card}.',
  ],
  leave: [
    '{other} leaves {card}... straight to {player}, free!',
    'Left behind. {player} says thank you very much.',
  ],
  free: [
    '{card} goes to {player} for nothing.',
    'Free {card} for {player}. All-in perks.',
  ],
  unsoldRound: [
    'Unsold round! The leftovers get a second chance.',
    'Back from the tray: the unsold round.',
  ],
  end: [
    'That is the auction! Squads are full.',
    'Hammer down for the last time.',
  ],
  undo: [
    'Hold on, hold on. Let\'s run that back.',
    'Undo! The hammer is back up.',
  ],
};

const FLAVOUR: Record<PackId, Partial<Record<Moment, string[]>>> = {
  cricket: {
    steal: ['That\'s a six-hitter at a dot-ball price.'],
    lotStar: ['{card} walks out to the middle. Base ${base}.'],
    sold: ['{card} padded up for {leader}. ${price}.'],
  },
  pokemon: {
    lot: ['Wild bidding appeared! {card} at ${base}.'],
    sold: ['{leader} caught {card}! ${price}.'],
    unsold: ['{card} fled!'],
  },
  heroes: {
    sold: ['{card} assembling with {leader} at ${price}.'],
    lotStar: ['A cosmic-level threat... I mean hero. {card}, ${base}.'],
    war: ['This bidding war needs its own sequel.'],
  },
};

/** Picks lines without ever repeating the previous line. */
export class Commentary {
  private last = '';
  constructor(private rng: Rng, private pack: PackId) {}

  line(m: Moment, v: Vars): string {
    const pool = [...LINES[m], ...(FLAVOUR[this.pack][m] ?? [])];
    let tpl = this.rng.pick(pool);
    if (pool.length > 1) for (let i = 0; i < 6 && fill(tpl, v) === this.last; i++) tpl = this.rng.pick(pool);
    this.last = fill(tpl, v);
    return this.last;
  }
}

export function fill(tpl: string, v: Vars): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? 'someone'));
}

export const templateCount = (): number => Object.values(LINES).reduce((a, l) => a + l.length, 0)
  + Object.values(FLAVOUR).reduce((a, f) => a + Object.values(f).reduce((b, l) => b + (l?.length ?? 0), 0), 0);
