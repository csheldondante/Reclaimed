// Follow a person (round 128l, m4; V128-10, minimal — the user: "so that we could follow a unit and see it go about it's
// day"). A tap on a person (or a cart) picks it: a card with its number, a name made from it, its job, what it carries,
// where it's going, its day so far (home, work, haul, eat, home) and a thought made up from its number and what it's
// doing — nothing simulated behind the thought. Follow keeps the camera on it (the window slides with the camera) until
// a tap lands elsewhere. Pure but for `PersonFacts` (FortressLife fills them), so the card is tested and linted
// (follow.test.ts, docs/WRITING.md).
import type { Goods } from '../api/contracts/fortress';
import { goodsText } from './words';

/** what a person (or cart) is doing now, as the card tells it */
export type Doing =
  | 'home'
  | 'rest'
  | 'idle'
  | 'arrive'
  | 'build-fetch'
  | 'build-carry'
  | 'build-work'
  | 'to-work'
  | 'work'
  | 'haul'
  | 'eat'
  | 'fetch'
  | 'drill'
  | 'muster'
  | 'march'
  | 'wall'
  | 'cart-park'
  | 'cart-out'
  | 'cart-load'
  | 'cart-back';

export interface PersonFacts {
  /** the unit's number (UnitId: kept for its life) */
  id: number;
  kind: 'villager' | 'soldier' | 'cart';
  /** its job's word: builder, miner, woodcutter, farmer, smith, recruit; null: none */
  job: string | null;
  /** where it works (a structure's name: the quarry, the smithy …) */
  workplace: string | null;
  doing: Doing;
  carrying: Goods;
  /** what it did today, in order (repeats folded) */
  today: string[];
  /** the stores are out of grain */
  hungry: boolean;
  /** the economy's day number (the thought changes with it) */
  day: number;
}

const NAMES = [
  'Maren', 'Tobin', 'Ada', 'Hugh', 'Elsa', 'Rolf', 'Ida', 'Bram', 'Wynn', 'Odo', 'Greta', 'Piers', 'Nell', 'Aldo', 'Mira',
  'Osric', 'Bea', 'Corin', 'Edda', 'Lars', 'Tilde', 'Garth', 'Rhea', 'Ivo', 'Saskia', 'Jory', 'Hild', 'Matti', 'Una', 'Dag',
  'Fenna', 'Wulf', 'Kit', 'Asa', 'Ber', 'Lene', 'Ottar', 'Sabe', 'Yves', 'Ronja',
];

/** a small hash of numbers (deterministic: the same person, the same day, the same words) */
function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= v & 0xffff;
    h = Math.imul(h, 16777619);
    h ^= v >>> 16;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** a person's name, made from its number */
export function nameOf(id: number): string {
  return NAMES[hash(id, 7) % NAMES.length];
}

const THOUGHTS: Record<string, string[]> = {
  hungry: ['I could eat a whole loaf.', 'There is no bread left. I am worried.', 'My belly is empty.'],
  home: ['It is good to be home.', 'I will rest my feet for a while.', 'Home is warm.'],
  rest: ['My feet hurt. I need to sit down.', 'A long day. Time to sleep.', 'Tomorrow will be busy.'],
  idle: ['I wish there was work for me.', 'Nobody needs me today.', 'Maybe they will build something soon.'],
  arrive: ['I hope there is a bed for me.', 'So this is the fortress.', 'The road was long. I am nearly there.'],
  build: ['One more load and it goes up.', 'This stone is heavier than it looks.', 'We will make the walls strong.'],
  work: ['Hard work, but it is honest work.', 'The day goes fast when I am busy.', 'Almost done here.'],
  haul: ['The stores will be glad of this.', 'Heavy. Keep walking.', 'Nearly at the stores.'],
  eat: ['Bread and a bowl of soup. Good.', 'Time to eat.', 'I am glad of a meal.'],
  forge: ['The forge is hot today.', 'A good blade takes patience.', 'Another weapon for the barracks.'],
  drill: ['Shield up. Step. Again.', 'I am a soldier now.', 'The sergeant shouts a lot.'],
  march: ['Left, right. Left, right.', 'To the walls.', 'My post is waiting.'],
  wall: ['I can see a long way from up here.', 'All quiet on the wall.', 'Nobody gets past me.'],
  cart: ['The road makes this easy.', 'Mind the wheel ruts.', 'A full load this time.'],
};

/** the thought: made up from the person's number, the day and what it's doing (nothing simulated behind it) */
export function thoughtOf(f: PersonFacts): string {
  const key =
    f.kind === 'cart'
      ? 'cart'
      : f.hungry && f.kind === 'villager'
        ? 'hungry'
        : f.doing === 'build-fetch' || f.doing === 'build-carry' || f.doing === 'build-work'
          ? 'build'
          : f.doing === 'work' && f.job === 'smith'
            ? 'forge'
            : f.doing === 'to-work' || f.doing === 'fetch'
              ? 'work'
              : f.doing === 'muster'
                ? 'march'
                : f.doing;
  const list = THOUGHTS[key] ?? THOUGHTS.work;
  return list[hash(f.id, f.day) % list.length];
}

/** where it's going or what it's doing, a sentence */
export function doingLine(f: PersonFacts): string {
  const at = f.workplace ?? 'work';
  switch (f.doing) {
    case 'home':
      return 'At home.';
    case 'rest':
      return 'Going home to rest.';
    case 'idle':
      return 'Waiting for work.';
    case 'arrive':
      return 'Walking in to find a bed.';
    case 'build-fetch':
      return 'Going to the stores for building stone or wood.';
    case 'build-carry':
      return 'Carrying a load to a building site.';
    case 'build-work':
      return 'Building.';
    case 'to-work':
      return `Going to ${at}.`;
    case 'work':
      return `Working at ${at}.`;
    case 'haul':
      return 'Taking goods to the stores.';
    case 'eat':
      return 'Going to the stores to eat.';
    case 'fetch':
      return `Going to the stores for what ${at} needs.`;
    case 'drill':
      return 'Drilling at the barracks.';
    case 'muster':
      return 'Going to the barracks to muster.';
    case 'march':
      return 'Marching to the walls.';
    case 'wall':
      return 'Walking the wall.';
    case 'cart-park':
      return 'Waiting by the stores.';
    case 'cart-out':
      return `Driving out to ${at}.`;
    case 'cart-load':
      return 'Loading up.';
    case 'cart-back':
      return 'Driving back to the stores.';
  }
}

/** The card: a title and a few plain lines (docs/WRITING.md). */
export function personCard(f: PersonFacts): { title: string; lines: string[] } {
  const title = f.kind === 'cart' ? `Cart number ${f.id}` : `${nameOf(f.id)}, ${f.kind === 'soldier' ? 'a soldier' : f.job ? `a ${f.job}` : 'a villager'}`;
  const lines: string[] = [];
  if (f.kind !== 'cart') lines.push(`Person number ${f.id}.`);
  lines.push(doingLine(f));
  const c = goodsText(f.carrying);
  lines.push(c === 'nothing' ? 'Carrying nothing.' : `Carrying ${c}.`);
  if (f.today.length) lines.push(`Today: ${f.today.join(', ')}.`);
  lines.push(f.kind === 'cart' ? `The driver says: "${thoughtOf(f)}"` : `${nameOf(f.id)} thinks: "${thoughtOf(f)}"`);
  return { title, lines };
}

/** A tap's pick and the follow: who is picked, and whether the camera follows them. */
export class FortressFollow {
  selected: number | null = null;
  following = false;
  readonly onChange: (() => void)[] = [];

  select(id: number | null): void {
    if (id === this.selected) return;
    this.selected = id;
    if (id === null) this.following = false;
    for (const h of this.onChange) h();
  }

  follow(on: boolean): void {
    this.following = on && this.selected !== null;
    for (const h of this.onChange) h();
  }
}
