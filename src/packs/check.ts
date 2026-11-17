// (card-table; docs/design/PACK_FORMAT.md) The validator for outside-authored opportunity packs: one pack's JSON in,
// a list of problems out, each in plain words an author who has never seen the code can act on. The loader
// (packs/load.ts) refuses a pack with errors. This file imports nothing at run time, so `node scripts/packcheck.mjs
// <file>` runs it as it is; its vocabularies are checked against the engine's own by test/unit/packs.test.ts.

// ---- the pack as written (PACK_FORMAT.md) ----------------------------------------------------------------------------

export type PoolName = 'magic' | 'might' | 'labor' | 'materials' | 'intel' | 'unrest';
export type TierName = 'triumph' | 'success' | 'cost' | 'failure' | 'disaster';

export type PackCond =
  | { pool: string; gte?: number; lte?: number }
  | { season_gte: number }
  | { has_thing: string }
  | { no_thing: string }
  | { town_has: string[] }
  | { site_has: string[] }
  | { far_town_is: string[] }
  | { resolved: string; tier?: string[]; at?: string; run?: 'earlier' | 'any' }
  | { leader: string }
;

export type PackEffect =
  | { pool: string; add: number }
  | { income: string; add: number }
  | { put: string; at?: string }
  | { remove: string }
  | { tag: string; on: string }
  | { untag: string; on: string }
  | { mutate: string; where: string }
  | { far: string; where?: string; by?: string; tribute?: number; id?: string; name?: string; purpose?: string }
  | { sign: string; seasons?: number; strength?: number; where?: string }
  | { trade: string; end?: boolean }
  | { arrive: string; count?: number; from?: string }
  | { unlock: string }
  | { law: string; seasons?: number }
  | { end_run: string; name: string }
  | { far_all: string; by?: string }
  | { say: string };

/** (laws: docs/design/LAWS.md) a law as written: its id, its name, and what it does (one key of LAW_KEYS) */
export interface PackLaw {
  id: string;
  name: string;
  does: Record<string, unknown>;
}

export interface PackTag {
  id: string;
  on: string;
  meaning: string;
  timed?: boolean;
  ruins?: boolean;
  /** other packs declare the same tag (the same id, `on` and `timed`) and produce or read it */
  shared?: boolean;
}
export interface PackThing {
  id: string;
  name: string;
  kind: string;
  at: string;
  tags: string[];
  text: string;
  capacity?: number;
  /** goods taken each season while it is in play (materials, magic, intel) */
  upkeep?: Record<string, number>;
  /** (laws) laws of this pack in force while the thing is in play and not ruined */
  laws?: string[];
  /** (trade routes) a place selector: those towns trade with the home town while the thing stands */
  trade?: string;
  art?: string;
}
export interface PackCard {
  id: string;
  title: string;
  presenter: { name?: string; role: string; at: string };
  pitch: string;
  appears_when?: PackCond[];
  threat?: boolean;
  once?: boolean;
  offer_seasons?: number;
  cost?: Record<string, number>;
  build_seasons?: number;
  if_taken?: PackEffect[];
  if_expires?: PackEffect[];
  if_tier?: Partial<Record<TierName, PackEffect[]>>;
  live?: string | null;
  leads_to?: string[];
  /** (the record) laws of this pack in force from the first season of every later run of the world this card was
   *  done in: an ending that changed the world */
  laws_after?: string[];
  /** 1 to 5: how soon it comes up among the cards whose conditions hold (3: as a middling base card) */
  weight?: number;
  art?: string;
}
/** a rule: the engine's own RuleDef (living/rules.ts), unchanged */
export interface PackRule {
  id: string;
  name: string;
  on: 'turn' | { event: string } | { live: string; tier?: string[] };
  a: PackQuery;
  b?: PackQuery;
  need?: { pool: string; gte?: number; lte?: number };
  effect: { pool: string; n: number } | { amount: string; op: 'add' | 'mul'; n: number } | { offer: string } | { start: string } | { tag: string; on: 'a'; timed?: boolean } | { untag: string; on: 'a' } | { law: string; seasons?: number } | { end_run: string; name?: string };
  /** (laws) it fires this many times on one trigger (set by a law; an author may write it too) */
  fires?: number;
  per?: 'a' | 'b' | { amount: string; each: number };
  cap?: number;
  perSeason?: number;
  why: string;
}
export interface PackQuery {
  tags: string[];
  not?: string[];
  near?: { of: 'a' | 'event' | 'route'; cells: number };
  sameTown?: boolean;
}
export interface PackEvent {
  id: string;
  tag: string;
  title: string;
  how: string;
  /** not used: an event plays at the place of the card that starts it */
  where?: string;
  groups?: { who: string; count: number | string; tags: string[]; from: string; order?: string; formation?: string; to?: string }[];
  hazard?: { kind: string; points: number; spread: number };
  seconds?: number;
  abilities?: string[];
  amounts: string[];
  tiers: { tier: string; when?: { amount: string; lte?: number; gte?: number }[] }[];
}
export interface PackAbility {
  id: string;
  name: string;
  cost: Record<string, number>;
  target?: { tags: string[] };
  effect?: PackEffect[];
  /** cast into a live event of one of these kinds: each cast puts down so many foes, or puts out so many burning lots */
  in_event?: { kinds: string[]; kills?: number; douses?: number };
  text: string;
  look?: string;
}
export interface Pack {
  pack: { id: string; name: string; version: number; summary?: string; appears_when?: PackCond[]; themes?: string[] };
  tags?: PackTag[];
  things?: PackThing[];
  cards?: PackCard[];
  rules?: PackRule[];
  events?: PackEvent[];
  abilities?: PackAbility[];
  laws?: PackLaw[];
  wants?: string[];
}

// ---- the vocabularies (each the engine's own: test/unit/packs.test.ts holds them to it) -------------------------------

export const POOL_NAMES: readonly string[] = ['magic', 'might', 'labor', 'materials', 'intel', 'unrest'];
/** people are locked while a card is built and come back; goods are spent */
export const PEOPLE: readonly string[] = ['labor', 'might'];
export const GOODS: readonly string[] = ['materials', 'magic', 'intel'];
/** the home town's sites a card can stand at (season/realm-templates.ts SITES) */
export const SITE_KEYS: readonly string[] = ['keep', 'forge', 'quarter', 'fields', 'market', 'gate', 'tower', 'dam', 'shrine', 'mill', 'wall', 'watch', 'harbour', 'quarry', 'woods', 'river', 'road', 'pit', 'wagons', 'graves'];
/** the tags the game has already (PACK_FORMAT.md "Existing tags") */
export const KNOWN_TAGS: readonly string[] = [
  'keep', 'workshop', 'mill', 'ore', 'homes', 'field', 'market', 'gate', 'watch', 'tower', 'water', 'dam', 'river', 'quay', 'temple', 'rampart', 'quarry', 'woods', 'road', 'yard', 'graves', 'camp',
  'standing', 'worked', 'growth-active', 'festival', 'sheltered',
  'burned', 'flooded', 'buried', 'melted', 'abandoned', 'destroyed', 'occupied', 'lost', 'ruined',
  'town', 'home', 'wall', 'garrison', 'unrest', 'trade-partner',
];
export const LAND_KINDS: readonly string[] = ['flooded', 'burned', 'melted', 'buried', 'dried', 'withered', 'greened'];
export const FAR_KINDS: readonly string[] = ['captured', 'vassal', 'destroyed', 'abandoned', 'founded'];
export const SIGN_KINDS: readonly string[] = ['ashfall', 'darkness', 'deadrise', 'crime'];
export const TIERS: readonly string[] = ['triumph', 'success', 'cost', 'failure', 'disaster'];
export const THING_KINDS: readonly string[] = ['building', 'garrison', 'policy', 'effect', 'relic', 'people'];
export const LEADER_IDS: readonly string[] = ['ysolt', 'dunstan', 'ilveth'];
export const FAR_STATES: readonly string[] = ['standing', 'destroyed', 'abandoned', 'occupied', 'vassal', 'founded'];
export const LIVE_KINDS: readonly string[] = ['raid', 'parade', 'fire', 'rising', 'refugees'];
/** abilities that do something when cast into a live event (living/live.ts SPELL_MECH) */
export const EVENT_ABILITIES: readonly string[] = ['fire', 'heat-ray', 'rain'];
export const AMOUNTS: readonly string[] = ['crowd', 'stopped', 'burned'];
/** the numbers each of the base game's live events has (season/realm-events.ts), which a rule on that kind may name */
export const LIVE_AMOUNTS: Record<string, readonly string[]> = {
  raid: ['raiders', 'alive', 'soldiers', 'fallen', 'stopped'],
  rising: ['up'],
  parade: ['crowd', 'marching', 'out'],
  fire: ['lots', 'burned', 'alight'],
  refugees: ['walking', 'carts'],
};
/** the numbers the base game's rules change in each kind of live event (season/realm-rules.ts) */
export const LIVE_NEEDS: Record<string, readonly string[]> = { raid: ['stopped'], parade: ['crowd'], fire: ['burned'] };
export const BASE_ABILITIES: readonly string[] = ['growth-rune', 'fire', 'heat-ray', 'rain'];
export const UNIT_KINDS: readonly string[] = ['soldier', 'raider', 'worker', 'cart', 'dead'];
/** the base game's card ids (season/realm-templates.ts): a pack's may not clash with them */
export const BASE_CARD_IDS: readonly string[] = ['build:houses', 'build:farms', 'build:market', 'build:workshops', 'build:harbour', 'build:keep', 'build:quarry', 'build:lumber', 'build:bridge', 'build:trade', 'build:walls', 'mining-outpost', 'tower-lens', 'relieve-neighbour', 'house-refugees', 'guard-camp', 'dead-rise', 'pay-raiders', 'mend-dam', 'fire-wards', 'feed-shrine', 'shore-hill', 'raid', 'gate-parade', 'refugees-arrive', 'resettle-refugees', 'market-fire', 'hire-sellswords'];
export const COND_KEYS: readonly string[] = ['pool', 'season_gte', 'has_thing', 'no_thing', 'town_has', 'site_has', 'far_town_is', 'resolved', 'leader', ];
export const EFFECT_KEYS: readonly string[] = ['pool', 'income', 'put', 'remove', 'tag', 'untag', 'mutate', 'far', 'sign', 'arrive', 'unlock', 'law', 'end_run', 'far_all', 'trade', 'say'];
/** (laws) what a law can do: its one key (living/laws.ts LawDo), by kind */
export const LAW_KEYS: Record<string, readonly string[]> = {
  tags: ['count_as', 'grant', 'spare'],
  rules: ['rule', 'add_rule'],
  cards: ['cost', 'pay', 'build', 'stay', 'pool_as'],
  spells: ['spell', 'event'],
  run: ['board', 'income', 'raiders', 'win'],
  meta: ['multipliers', 'next_law'],
};
/** (places) the states a far place selector `far:where:<state>` may name */
export const FAR_SELECT_STATES: readonly string[] = ['standing', 'destroyed', 'abandoned', 'occupied', 'vassal', 'founded', 'trade-partner', 'founded-by-player'];
/** the ruin words (a law may spare one) */
export const RUIN_WORDS: readonly string[] = ['burned', 'flooded', 'buried', 'melted', 'abandoned', 'destroyed', 'occupied', 'lost'];
/** spells a law may name: the base game's, as a pack writes them */
export const LAW_SPELLS: readonly string[] = ['fire', 'heat-ray', 'rain', 'growth-rune'];
/** written in the first draft of the format, not built: each with what to write instead (BACKLOG CT-10..) */
export const NOT_YET: Record<string, string> = {
  units: 'not supported yet. Add soldiers with { "pool": "might", "add": 1 }: each Might is 3 soldiers',
  offer: 'not supported yet. Give the later card "appears_when": [ { "resolved": "this-card-id" } ] instead',
  sign_cond: 'not supported yet as a condition. Use { "resolved": "card-id" } of the card that set the sign',
  upkeep: 'not supported yet. Nothing is taken each season for a thing; put the cost on the card',
};

export interface Problem {
  /** 'error': the pack is refused. 'warn': it loads, and the author should look */
  level: 'error' | 'warn';
  where: string;
  text: string;
}

/** the site a reference names ('site:mill' → 'mill'), or null */
export function siteOf(ref: string | undefined): string | null {
  if (!ref || !ref.startsWith('site:')) return null;
  const k = ref.slice(5);
  return SITE_KEYS.includes(k) ? k : null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const numbersIn = (s: string): number[] => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
/** every number in a piece of data */
function numbersOf(x: unknown, out: number[] = []): number[] {
  if (typeof x === 'number') out.push(Math.abs(x));
  else if (Array.isArray(x)) for (const y of x) numbersOf(y, out);
  else if (isObj(x)) for (const [k, y] of Object.entries(x)) if (k !== 'say') numbersOf(y, out);
  return out;
}

/**
 * Every problem in a pack. `base`: ids of the game's own cards and rules (a pack's must not clash with them).
 */
export function checkPack(p: Pack, base: { cards?: readonly string[]; rules?: readonly string[] } = {}): Problem[] {
  base = { cards: base.cards ?? BASE_CARD_IDS, rules: base.rules ?? BASE_RULE_IDS };
  const out: Problem[] = [];
  const err = (where: string, text: string): void => void out.push({ level: 'error', where, text });
  const warn = (where: string, text: string): void => void out.push({ level: 'warn', where, text });
  if (!isObj(p) || !isObj(p.pack) || typeof p.pack.id !== 'string') {
    err('pack', 'The file needs a "pack" block with an "id" and a "name".');
    return out;
  }
  for (const k of ['tags', 'things', 'cards', 'rules', 'events', 'abilities', 'laws', 'wants'] as const) if (p[k] !== undefined && !Array.isArray(p[k])) err(k, `"${k}" must be a list.`);
  if (out.length) return out;
  const tags = p.tags ?? [];
  const things = p.things ?? [];
  const cards = p.cards ?? [];
  const rules = p.rules ?? [];
  const events = p.events ?? [];
  const abilities = p.abilities ?? [];
  const laws = p.laws ?? [];
  /** (laws) the laws something brings into force: an effect, a thing, a rule */
  const brought = new Set<string>();

  // ---- ids ----
  const seen = new Map<string, string>();
  const id = (kind: string, x: string | undefined, where: string) => {
    if (typeof x !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x)) return err(where, `Its id must be lowercase words joined by hyphens. It is ${JSON.stringify(x)}.`);
    if (seen.has(x)) err(where, `The id "${x}" is used twice: here and in ${seen.get(x)}. Give one of them another id.`);
    seen.set(x, where);
    if ((kind === 'card' && base.cards?.includes(x)) || (kind === 'rule' && base.rules?.includes(x))) err(where, `The id "${x}" is already a ${kind} of the base game. Put the pack's id in front: "${p.pack.id}-${x}".`);
    if (kind === 'tag' && KNOWN_TAGS.includes(x)) err(where, `The tag "${x}" exists already. Existing tags need no entry; remove this one.`);
  };
  tags.forEach((t, i) => id('tag', t.id, `tags[${i}]`));
  things.forEach((t, i) => id('thing', t.id, `things[${i}]`));
  cards.forEach((c, i) => id('card', c.id, `cards[${i}]`));
  rules.forEach((r, i) => id('rule', r.id, `rules[${i}]`));
  events.forEach((e, i) => id('event', e.id, `events[${i}]`));
  abilities.forEach((a, i) => id('ability', a.id, `abilities[${i}]`));
  laws.forEach((l, i) => id('law', l.id, `laws[${i}]`));
  const lawIds = new Set(laws.map((l) => l.id));
  const needLaw = (x: unknown, where: string) => {
    if (!lawIds.has(String(x))) err(where, `It names the law "${String(x)}", which is not in the pack's "laws".`);
    brought.add(String(x));
  };

  const tagIds = new Set([...KNOWN_TAGS, ...tags.map((t) => t.id)]);
  const thingIds = new Set(things.map((t) => t.id));
  const cardIds = new Set(cards.map((c) => c.id));
  const eventIds = new Set(events.map((e) => e.id));
  const abilityIds = new Set([...BASE_ABILITIES, ...abilities.map((a) => a.id)]);
  const produced = new Set<string>();
  const read = new Set<string>();
  const put = new Set<string>();
  const needTag = (t: string, where: string, how: 'read' | 'made') => {
    // (the record: a ruined thing or place carries what it was as "remains-of-<tag>"; only read, never set)
    const remains = /^remains-of-(.+)$/.exec(t)?.[1];
    if (remains && how === 'read') {
      if (!tagIds.has(remains)) err(where, `"${t}" reads the remains of the tag "${remains}", which is not an existing tag or one of the pack's.`);
      read.add(remains);
      return;
    }
    if (!tagIds.has(t)) err(where, `Unknown tag "${t}". Use an existing tag or add it to the pack's "tags" list.`);
    (how === 'read' ? read : produced).add(t);
  };
  const pool = (k: unknown, where: string) => {
    if (typeof k !== 'string' || !POOL_NAMES.includes(k)) err(where, `Unknown pool ${JSON.stringify(k)}. The pools are ${POOL_NAMES.join(', ')}.`);
  };
  // (places: the far places this pack founds can be named by its cards, "far:<id>")
  const founded = new Set(cards.flatMap((c) => [...(c.if_taken ?? []), ...(c.if_expires ?? []), ...Object.values(c.if_tier ?? {}).flat()] as Record<string, unknown>[]).filter((e) => e && e.far === 'founded' && typeof e.id === 'string').map((e) => String(e.id)));
  const place = (ref: string | undefined, where: string, allow: { town?: boolean; far?: boolean; target?: boolean; world?: boolean } = {}) => {
    if (ref === 'town' && allow.town) return;
    if (ref === 'far:neighbour' && allow.far) return;
    if (ref === 'target' && allow.target) return;
    if (ref === 'world') return allow.world ? undefined : err(where, '"world" (every town) is allowed for "mutate" and "sign" only.');
    if (ref?.startsWith('far:')) {
      if (!allow.far) return err(where, `A far place is not allowed here. It is ${JSON.stringify(ref)}.`);
      const st = /^far:where:(.+)$/.exec(ref)?.[1];
      if (ref === 'far:all' || /^far:nearest:[1-9]\d*$/.test(ref) || (st && FAR_SELECT_STATES.includes(st)) || founded.has(ref.slice(4))) return;
      return err(where, `Unknown far place "${ref}". Write "far:neighbour", "far:all", "far:nearest:2", "far:where:<state>" (${FAR_SELECT_STATES.join(', ')}) or "far:<id>" of a place this pack founds.`);
    }
    if (!siteOf(ref)) err(where, `Unknown place ${JSON.stringify(ref)}. A site is written "site:<name>" with one of: ${SITE_KEYS.join(', ')}.${allow.town ? ' Or "town".' : ''}`);
  };

  // ---- things ----
  things.forEach((t, i) => {
    const w = `things[${i}] (${t.id})`;
    if (!t.name || !t.text) err(w, 'A thing needs a "name" and a "text" the player reads.');
    if (!THING_KINDS.includes(t.kind)) err(w, `Unknown kind "${t.kind}". The kinds are ${THING_KINDS.join(', ')}.`);
    place(t.at, w, { town: true });
    if (!Array.isArray(t.tags) || !t.tags.length) err(w, 'A thing needs at least one tag, or no rule can read it.');
    for (const x of t.tags ?? []) needTag(x, w, 'made');
    if (t.laws !== undefined && !Array.isArray(t.laws)) err(w, '"laws" is a list of law ids of this pack.');
    for (const l of t.laws ?? []) needLaw(l, w);
    if (t.trade !== undefined) {
      place(t.trade, w, { far: true });
      if (t.trade === 'far:where:trade-partner') err(w, 'A thing\'s trade route names other towns than the trade partners.');
    }
    for (const [k, n] of Object.entries(t.upkeep ?? {})) {
      if (!GOODS.includes(k)) err(w, `Upkeep can be paid in ${GOODS.join(', ')} only. It asks for ${k}.`);
      if (!Number.isInteger(n) || n < 1) err(w, `Upkeep is a whole number, 1 or more. ${k} is ${JSON.stringify(n)}.`);
    }
    for (const n of numbersIn(t.text ?? '')) if (!numbersOf([t.upkeep, t.capacity]).includes(n)) err(w, `The text says ${n}, but the thing's upkeep and capacity have no such number.`);
  });

  // ---- effects ----
  const effects = (list: PackEffect[] | undefined, where: string, o: { ability?: boolean } = {}): void => {
    if (list === undefined) return;
    if (!Array.isArray(list)) return err(where, 'Effects must be a list.');
    list.forEach((e, i) => {
      const w = `${where}[${i}]`;
      if (!isObj(e)) return err(w, 'An effect must be an object.');
      const key = Object.keys(e).find((k) => EFFECT_KEYS.includes(k) || k in NOT_YET);
      if (!key) return err(w, `Unknown effect ${JSON.stringify(e)}. The effects are ${EFFECT_KEYS.join(', ')}. If you need another, describe it in "wants".`);
      const x = e as Record<string, unknown>;
      if (key in NOT_YET) return err(w, `"${key}" is ${NOT_YET[key]}.`);
      if (key === 'pool' || key === 'income') {
        pool(x[key], w);
        if (typeof x.add !== 'number' || !Number.isInteger(x.add) || x.add === 0) err(w, `"add" must be a whole number that is not 0. It is ${JSON.stringify(x.add)}.`);
        if (key === 'income' && !GOODS.includes(String(x.income))) err(w, `Income can only be of ${GOODS.join(', ')}. For people, use { "pool": "labor", "add": 1 } once.`);
        if (key === 'pool' && PEOPLE.includes(String(x.pool)) && Number(x.add) < 0 && String(x.pool) === 'labor') warn(w, 'This takes workers away for good. A cost in Labor only locks them while the card is built.');
      } else if (key === 'put') {
        if (!thingIds.has(String(x.put))) err(w, `"put" names the thing "${String(x.put)}", which is not in the pack's "things".`);
        put.add(String(x.put));
        if (x.at !== undefined) place(String(x.at), w, { town: true });
      } else if (key === 'remove') {
        if (!thingIds.has(String(x.remove))) err(w, `"remove" names the thing "${String(x.remove)}", which is not in the pack's "things".`);
      } else if (key === 'tag' || key === 'untag') {
        const t = String(x[key]);
        needTag(t, w, 'made');
        if (KNOWN_TAGS.includes(t) && !['festival', 'growth-active'].includes(t)) err(w, `The tag "${t}" is set by the game itself (what a site is, or what happened to it). To ruin a site use "mutate"; to add your own state, declare a tag in "tags".`);
        place(String(x.on), w, { town: true, target: o.ability });
      } else if (key === 'mutate') {
        if (!LAND_KINDS.includes(String(x.mutate))) err(w, `Unknown land change "${String(x.mutate)}". The kinds are ${LAND_KINDS.join(', ')}. For a far town use "far".`);
        place(String(x.where), w, { town: true, far: true, world: true });
        produced.add(String(x.mutate));
      } else if (key === 'far') {
        if (!FAR_KINDS.includes(String(x.far))) err(w, `Unknown change to a far place "${String(x.far)}". The kinds are ${FAR_KINDS.join(', ')}.`);
        if (x.far === 'founded') {
          if (typeof x.id !== 'string' || typeof x.name !== 'string') err(w, 'A founded place needs an "id" and a "name".');
        } else place(String(x.where), w, { far: true });
        if (x.by !== undefined && !['raiders', 'player', 'dead'].includes(String(x.by))) err(w, `"by" can be "raiders", "player" or "dead". It is ${JSON.stringify(x.by)}.`);
      } else if (key === 'trade') {
        // (trade routes: those towns trade with you, or no longer do)
        place(String(x.trade), w, { far: true });
        if (x.trade === 'far:where:trade-partner' && !x.end) err(w, 'Every trade partner already trades with you. Name other towns, or add "end": true.');
        if (x.end !== undefined && typeof x.end !== 'boolean') err(w, '"end" is true or left out.');
      } else if (key === 'sign') {
        if (!SIGN_KINDS.includes(String(x.sign))) err(w, `Unknown sign "${String(x.sign)}". The signs are ${SIGN_KINDS.join(', ')}.`);
        if (x.where !== undefined) place(String(x.where), w, { town: true, far: true, world: true });
        if (x.strength !== undefined && (typeof x.strength !== 'number' || x.strength < 0 || x.strength > 1)) err(w, '"strength" is a number from 0 (off) to 1.');
      } else if (key === 'arrive') {
        if (x.arrive !== 'refugees') err(w, `"arrive": "${String(x.arrive)}" is not supported yet. Only "refugees" arrive today.`);
        else if (x.from !== 'far:neighbour') err(w, 'Refugees can only come "from": "far:neighbour" today.');
        else if (x.count !== undefined && x.count !== 40) err(w, `The engine brings 40 refugees each time. Write "count": 40 or leave it out. It is ${JSON.stringify(x.count)}.`);
      } else if (key === 'unlock') {
        if (x.unlock !== 'heat-ray' && !abilities.some((a) => a.id === x.unlock)) err(w, `"unlock" names the ability "${String(x.unlock)}". It can be an ability of this pack, or "heat-ray".`);
      } else if (key === 'end_run') {
        // (endings: an instant win or loss, or an ending of the pack's own naming)
        if (typeof x.end_run !== 'string' || !x.end_run) err(w, '"end_run" is "won", "fell", or a word of your own for the ending.');
        if (typeof x.name !== 'string' || !x.name.trim()) err(w, 'An ending needs a "name": what the run-end screen says ended it.');
      } else if (key === 'far_all') {
        if (!['captured', 'destroyed', 'abandoned'].includes(String(x.far_all))) err(w, '"far_all" is captured, destroyed or abandoned: what happens to every far town.');
        if (x.by !== undefined && !['raiders', 'player', 'dead'].includes(String(x.by))) err(w, '"by" is raiders, player or dead.');
      } else if (key === 'law') {
        needLaw(x.law, w);
        if (x.seasons !== undefined && (!Number.isInteger(x.seasons) || Number(x.seasons) < 1)) err(w, '"seasons" is a whole number, 1 or more: the law stands the rest of this season and so many more. Leave it out for the rest of the run.');
      } else if (key === 'say') {
        if (typeof x.say !== 'string' || !x.say.trim()) err(w, '"say" needs one plain sentence.');
      }
    });
  };
  /** numbers written in a branch's sentences must be numbers of its data */
  const sayNumbers = (list: PackEffect[] | undefined, where: string, extra: number[]) => {
    if (!Array.isArray(list)) return;
    const data = [...numbersOf(list), ...extra];
    for (const e of list) if (isObj(e) && typeof (e as { say?: unknown }).say === 'string') for (const n of numbersIn((e as { say: string }).say)) if (!data.includes(n)) err(where, `The sentence "${(e as { say: string }).say}" says ${n}, but no effect or cost beside it has that number. Change the sentence or the data.`);
  };

  // ---- conditions ----
  const conds = (list: PackCond[] | undefined, where: string): void => {
    if (list === undefined) return;
    if (!Array.isArray(list)) return err(where, '"appears_when" must be a list of tests.');
    list.forEach((c, i) => {
      const w = `${where}[${i}]`;
      const x = c as Record<string, unknown>;
      if ('sign' in x) return err(w, `"sign" is ${NOT_YET.sign_cond}.`);
      const key = Object.keys(x).find((k) => COND_KEYS.includes(k));
      if (!key) return err(w, `Unknown condition ${JSON.stringify(c)}. The conditions are ${COND_KEYS.join(', ')}.`);
      if (key === 'pool') {
        pool(x.pool, w);
        if (typeof x.gte !== 'number' && typeof x.lte !== 'number') err(w, 'A pool test needs "gte" or "lte" with a number.');
      } else if (key === 'season_gte') {
        if (typeof x.season_gte !== 'number' || x.season_gte < 1) err(w, '"season_gte" needs a season number, 1 or more.');
        else if (x.season_gte > 15) err(w, `This can never appear: a run has 16 seasons and the last one is the attack. "season_gte" is ${x.season_gte}.`);
      } else if (key === 'has_thing' || key === 'no_thing') {
        if (!thingIds.has(String(x[key]))) err(w, `"${key}" names the thing "${String(x[key])}", which is not in the pack's "things".`);
      } else if (key === 'town_has' || key === 'site_has') {
        if (!Array.isArray(x[key]) || !(x[key] as unknown[]).length) err(w, `"${key}" needs a list of tags.`);
        else for (const t of x[key] as string[]) needTag(t, w, 'read');
      } else if (key === 'far_town_is') {
        for (const s of (Array.isArray(x.far_town_is) ? x.far_town_is : [x.far_town_is]) as string[]) if (!FAR_STATES.includes(s)) err(w, `Unknown state "${s}" of a far town. The states are ${FAR_STATES.join(', ')}.`);
      } else if (key === 'resolved') {
        if (!cardIds.has(String(x.resolved))) err(w, `"resolved" names the card "${String(x.resolved)}", which is not in this pack.`);
        // (the record: a result, a place, an earlier run)
        for (const t of (x.tier as string[] | undefined) ?? []) if (!TIERS.includes(t) && t !== 'lapsed') err(w, `"tier" lists results (${TIERS.join(', ')}) or "lapsed". It has "${t}".`);
        if (x.at !== undefined) place(String(x.at), w, { town: true });
        if (x.run !== undefined && x.run !== 'earlier' && x.run !== 'any') err(w, '"run" is "earlier" (a run before this one) or "any".');
      } else if (key === 'leader') {
        if (!LEADER_IDS.includes(String(x.leader))) err(w, `Unknown leader "${String(x.leader)}". The leaders are ${LEADER_IDS.join(', ')}.`);
      }
    });
  };
  conds(p.pack.appears_when, 'pack.appears_when');

  // ---- cards ----
  cards.forEach((c, i) => {
    const w = `cards[${i}] (${c.id})`;
    if (!c.title || !c.pitch) err(w, 'A card needs a "title" and a "pitch".');
    if (!isObj(c.presenter) || !c.presenter.role) err(w, 'A card needs a "presenter" with a "role" (a trade, such as "miller") and an "at".');
    else place(c.presenter.at, `${w}.presenter.at`);
    conds(c.appears_when, `${w}.appears_when`);
    const cost = c.cost ?? {};
    for (const [k, n] of Object.entries(cost)) {
      pool(k, `${w}.cost`);
      if (k === 'unrest') err(`${w}.cost`, 'Unrest cannot be paid. To raise it, use the effect { "pool": "unrest", "add": 1 }.');
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) err(`${w}.cost`, `A cost is a whole number, 1 or more. ${k} is ${JSON.stringify(n)}.`);
    }
    if (c.build_seasons !== undefined && (!Number.isInteger(c.build_seasons) || c.build_seasons < 1 || c.build_seasons > 4)) err(w, '"build_seasons" is a whole number from 1 to 4.');
    if (c.weight !== undefined && (!Number.isInteger(c.weight) || c.weight < 1 || c.weight > 5)) err(w, '"weight" is a whole number from 1 (comes up late, when little else fits) to 5 (comes up as soon as it can).');
    if (c.offer_seasons !== undefined && (!Number.isInteger(c.offer_seasons) || c.offer_seasons < 1)) err(w, '"offer_seasons" is a whole number, 1 or more.');
    if (c.live) {
      if (!eventIds.has(c.live)) err(w, `"live" names the event "${c.live}", which is not in the pack's "events".`);
      if (!c.if_tier || !Object.keys(c.if_tier).length) err(w, 'A card with a live event needs "if_tier": what each result does.');
      if (c.if_taken?.length) err(w, 'A card with a live event has no "if_taken". Its event\'s result picks one of "if_tier".');
      // (every result its event can give needs its effects: nothing is guessed for a missing one)
      for (const row of events.find((e) => e.id === c.live)?.tiers ?? []) if (c.if_tier && TIERS.includes(row.tier) && !(row.tier in c.if_tier)) err(`${w}.if_tier`, `The event "${c.live}" can end in "${row.tier}", but "if_tier" has no "${row.tier}". Add it.`);
      for (const [t, list] of Object.entries(c.if_tier ?? {})) {
        if (!TIERS.includes(t)) err(`${w}.if_tier`, `Unknown result "${t}". The results are ${TIERS.join(', ')}.`);
        effects(list, `${w}.if_tier.${t}`);
        sayNumbers(list, `${w}.if_tier.${t}`, numbersOf(cost));
        if (!list?.some((e) => 'say' in e)) err(`${w}.if_tier.${t}`, 'Each result needs a "say" sentence.');
      }
    } else {
      if (c.if_tier) err(w, '"if_tier" is only for a card with a "live" event.');
      if (!c.if_taken?.length) err(w, 'A card needs "if_taken": what taking it does.');
    }
    effects(c.if_taken, `${w}.if_taken`);
    effects(c.if_expires, `${w}.if_expires`);
    if (c.if_taken?.length && !c.if_taken.some((e) => 'say' in e)) err(`${w}.if_taken`, 'Add a "say" sentence: what the player reads when it is done.');
    if (!c.if_expires?.length) (c.threat ? err : warn)(w, c.threat ? 'A threat needs "if_expires": the bad outcome when it is not answered.' : 'This card has no "if_expires". Passing should cost or risk something.');
    else if (!c.if_expires.some((e) => 'say' in e)) err(`${w}.if_expires`, 'Add a "say" sentence: what the player reads when it runs out.');
    const mine = [...numbersOf(cost), c.offer_seasons ?? 0, c.build_seasons ?? 0];
    sayNumbers(c.if_taken, `${w}.if_taken`, mine);
    sayNumbers(c.if_expires, `${w}.if_expires`, mine);
    const all = [...mine, ...numbersOf(c.if_taken), ...numbersOf(c.if_expires), ...numbersOf(c.if_tier)];
    for (const n of numbersIn(c.pitch ?? '')) if (!all.includes(n)) err(w, `The pitch says ${n}, but no cost or effect of the card has that number.`);
    for (const l of c.leads_to ?? []) if (!cardIds.has(l)) err(w, `"leads_to" names the card "${l}", which is not in this pack.`);
  });

  // ---- cards that can never appear ----
  cards.forEach((c, i) => {
    const w = `cards[${i}] (${c.id})`;
    for (const x of (c.appears_when ?? []) as Record<string, unknown>[]) {
      if (typeof x.has_thing === 'string' && thingIds.has(x.has_thing) && !put.has(x.has_thing)) err(w, `This card can never appear: it waits for the thing "${x.has_thing}", and no card puts it in play.`);
      if (x.resolved === c.id) err(w, 'This card can never appear: it waits for itself to resolve.');
    }
    const cost = c.cost ?? {};
    if ((cost.labor ?? 0) > 12 || (cost.might ?? 0) > 8) warn(w, 'Its cost in people is more than a town usually has. It may never be affordable.');
  });
  // (a chain that waits on itself: a → b → a)
  const waits = new Map<string, string[]>();
  for (const c of cards) waits.set(c.id, [...((c.appears_when ?? []) as Record<string, unknown>[]).filter((x) => typeof x.resolved === 'string').map((x) => String(x.resolved)), ...cards.filter((o) => o.leads_to?.includes(c.id)).map((o) => o.id)]);
  for (const c of cards) {
    const stack = [...(waits.get(c.id) ?? [])];
    const visited = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (x === c.id) {
        err(`cards (${c.id})`, 'This card can never appear: the cards it waits for wait for it in turn.');
        break;
      }
      if (visited.has(x)) continue;
      visited.add(x);
      stack.push(...(waits.get(x) ?? []));
    }
  }
  for (const t of things) if (!put.has(t.id)) warn(`things (${t.id})`, 'No card puts this thing in play.');

  // ---- events ----
  const liveTags = new Set([...LIVE_KINDS, ...events.map((e) => e.tag)]);
  events.forEach((e, i) => {
    const w = `events[${i}] (${e.id})`;
    if (!e.title || !e.how) err(w, 'An event needs a "title" and a "how" (what the player can do).');
    if (!e.tag) err(w, 'An event needs a "tag": the kind rules trigger on.');
    if (e.where !== undefined) warn(w, '"where" is not used: an event plays at the place of the card that starts it ("presenter.at"). Remove it.');
    if (!(e.groups ?? []).length && !e.hazard) err(w, 'An event needs at least one group or a hazard.');
    const amounts = new Set<string>(Array.isArray(e.amounts) ? e.amounts : []);
    const groupTags = new Set((e.groups ?? []).flatMap((g) => g.tags ?? []));
    for (const a of amounts) {
      const m = /^(alive|dead):(.+)$/.exec(a);
      if (m ? !groupTags.has(m[2]) : !AMOUNTS.includes(a)) err(w, `Unknown amount "${a}". The amounts are ${AMOUNTS.join(', ')}, "alive:<group tag>" and "dead:<group tag>" for a tag one of its groups has.`);
      if (a === 'burned' && !e.hazard) err(w, 'The amount "burned" needs a "hazard" of kind "fire".');
      if (a === 'crowd' && !groupTags.has('crowd')) err(w, 'The amount "crowd" counts the people of groups tagged "crowd" who arrive. Give a group the tag "crowd" and the order "go".');
    }
    for (const g of e.groups ?? []) {
      if (typeof g.count !== 'number' || !Number.isInteger(g.count) || g.count < 1) err(w, `A group's "count" is a whole number, 1 or more. It is ${JSON.stringify(g.count)}.`);
      if (!Array.isArray(g.tags) || !g.tags.length) err(w, 'A group needs at least one tag.');
      if (!UNIT_KINDS.includes(g.who)) err(w, `Unknown unit "${g.who}". The units are ${UNIT_KINDS.join(', ')}.`);
      if (g.order !== undefined && !['go', 'guard', 'attack'].includes(g.order)) err(w, `The order "${g.order}" is not supported yet. The orders are go, guard, attack.`);
      if (g.formation !== undefined && !['column', 'line', 'loose'].includes(g.formation)) err(w, `Unknown formation "${g.formation}". The formations are column, line, loose.`);
      for (const k of ['from', 'to'] as const) if (g[k] !== undefined && !['gate', 'road', 'event'].includes(g[k]!) && !siteOf(g[k])) err(w, `A group's "${k}" is a site ("site:<name>"), "gate", "road" or "event". It is ${JSON.stringify(g[k])}.`);
    }
    if (e.hazard && e.hazard.kind !== 'fire') err(w, `The hazard "${e.hazard.kind}" is not supported yet. Only "fire" exists.`);
    for (const a of e.abilities ?? []) {
      if (EVENT_ABILITIES.includes(a)) continue;
      const mine = abilities.find((x) => x.id === a);
      if (!mine) err(w, abilityIds.has(a) ? `The ability "${a}" does nothing when cast into an event. The spells that do: ${EVENT_ABILITIES.join(', ')}.` : `Unknown ability "${a}". An event may list ${EVENT_ABILITIES.join(', ')}, or an ability of this pack that has "in_event".`);
      else if (!mine.in_event) err(w, `The ability "${a}" has no "in_event", so it does nothing when cast into an event.`);
      else if (!mine.in_event.kinds?.includes(e.tag)) err(w, `The ability "${a}" is for events of kind ${JSON.stringify(mine.in_event.kinds)}, and this event is a "${e.tag}".`);
    }
    if (!Array.isArray(e.tiers) || !e.tiers.length) return err(w, 'An event needs "tiers": how its result is read.');
    e.tiers.forEach((t, k) => {
      const tw = `${w}.tiers[${k}]`;
      if (!TIERS.includes(t.tier)) err(tw, `Unknown result "${t.tier}". The results are ${TIERS.join(', ')}.`);
      for (const c of t.when ?? []) {
        if (!amounts.has(c.amount)) err(tw, `It reads the amount "${c.amount}", which is not in the event's "amounts".`);
        if (typeof c.lte !== 'number' && typeof c.gte !== 'number') err(tw, 'A test needs "lte" or "gte" with a number.');
      }
      const open = !t.when?.length;
      if (open && k < e.tiers.length - 1) err(tw, `This result has no "when", so every result after it can never be reached. Put it last.`);
      if (k === e.tiers.length - 1 && !open) err(tw, 'The last result must have no "when": it is what happens when nothing else fits.');
      // (a row hidden by an earlier one that tests the same amount more loosely)
      if (t.when?.length === 1)
        for (const prev of e.tiers.slice(0, k)) {
          const a = prev.when?.length === 1 ? prev.when[0] : null;
          const b = t.when[0];
          if (a && a.amount === b.amount && ((a.lte !== undefined && b.lte !== undefined && b.lte <= a.lte && a.gte === undefined && b.gte === undefined) || (a.gte !== undefined && b.gte !== undefined && b.gte >= a.gte && a.lte === undefined && b.lte === undefined))) err(tw, `This result can never be reached: the "${prev.tier}" row before it already takes every case it tests.`);
        }
    });
    if (!cards.some((c) => c.live === e.id)) warn(w, 'No card starts this event.');
    // (the base game's rules about this kind of event change these numbers: an event of the kind must have them)
    for (const a of LIVE_NEEDS[e.tag] ?? []) if (!amounts.has(a)) err(w, `A "${e.tag}" event must list the amount "${a}": the base game's rules about ${e.tag} events change it.`);
  });

  // ---- abilities ----
  abilities.forEach((a, i) => {
    const w = `abilities[${i}] (${a.id})`;
    if (BASE_ABILITIES.includes(a.id)) err(w, `The ability "${a.id}" exists already.`);
    if (!a.name || !a.text) err(w, 'An ability needs a "name" and a "text".');
    for (const [k, n] of Object.entries(a.cost ?? {})) {
      if (k !== 'magic') err(w, `An ability costs Magic only today. It asks for ${k}.`);
      if (!Number.isInteger(n) || n < 1) err(w, 'An ability costs a whole number of Magic, 1 or more.');
    }
    if (!a.cost || !Object.keys(a.cost).length) err(w, 'An ability needs a "cost" in Magic.');
    const ie = a.in_event;
    if (!ie && !a.target?.tags?.length) err(w, 'An ability needs a "target" with tags (what it can be cast on), or "in_event" (the events it can be cast into).');
    if (a.target && !a.effect?.length) err(w, 'An ability with a "target" needs an "effect".');
    if (a.effect?.length && !a.target?.tags?.length) err(w, 'An ability with an "effect" needs a "target" with tags.');
    if (ie) {
      if (!Array.isArray(ie.kinds) || !ie.kinds.length) err(w, '"in_event" needs "kinds": the kinds of event it can be cast into.');
      for (const k of ie.kinds ?? []) if (!liveTags.has(k)) warn(w, `"in_event" names the event kind "${k}", which no event of this pack or the base game has.`);
      const n = [ie.kills, ie.douses].filter((x) => x !== undefined);
      if (n.length !== 1 || !Number.isInteger(n[0]) || n[0]! < 1) err(w, '"in_event" needs exactly one of "kills" (foes put down by a cast) or "douses" (burning lots put out), a whole number, 1 or more.');
      if ((ie.kills ?? 0) > 3 || (ie.douses ?? 0) > 3) warn(w, 'One cast does more than 3. Heat ray, the strongest spell of the base game, does 2.');
    }
    for (const t of a.target?.tags ?? []) needTag(t, w, 'read');
    effects(a.effect, `${w}.effect`, { ability: true });
    for (const e of a.effect ?? []) if (!('tag' in e) && !('untag' in e) && !('pool' in e) && !('law' in e) && !('say' in e)) err(w, `An ability's effect can set or clear a tag on its target, change a pool, or make a law. ${JSON.stringify(e)} is not supported yet.`);
    for (const n of numbersIn(a.text ?? '')) if (![...numbersOf(a.cost), ...numbersOf(a.effect), ...numbersOf(a.in_event)].includes(n)) err(w, `The text says ${n}, but the ability's cost and effects have no such number.`);
    if (!cards.some((c) => JSON.stringify([c.if_taken, c.if_tier]).includes(`"unlock":"${a.id}"`))) warn(w, 'No card unlocks this ability.');
  });

  // ---- rules ----
  // (one rule: the pack's own, or a whole rule a law adds)
  const checkRule = (r: PackRule, w: string): void => {
    if (!isObj(r)) return err(w, 'A rule must be an object.');
    if (!r.name || !r.why) err(w, 'A rule needs a "name" and a "why" in plain words.');
    if (r.fires !== undefined && (!Number.isInteger(r.fires) || r.fires < 0)) err(w, '"fires" is a whole number: how many times it pays each time it fires.');
    const on = r.on as 'turn' | { event?: string; live?: string };
    if (on !== 'turn' && !(isObj(on) && (typeof on.event === 'string' || typeof on.live === 'string'))) err(w, '"on" is "turn", { "live": "<kind>" } or { "event": "<name>" }.');
    if (isObj(on) && typeof on.event === 'string') {
      const why = eventTrigger(on.event, cardIds);
      if (why === 'other') warn(w, `It triggers on "${on.event}", a card that is not in this pack. Fine only if a pack loaded with it has that card.`);
      else if (why) err(w, why);
    }
    // (another pack loaded with this one may have the kind: checked over the whole set by checkTogether)
    if (isObj(on) && typeof on.live === 'string' && !liveTags.has(on.live)) warn(w, `It triggers on the live event kind "${on.live}", which no event of this pack or the base game has. Fine only if a pack loaded with it has one. Kinds here: ${[...liveTags].join(', ')}.`);
    for (const [k, q] of [['a', r.a], ['b', r.b]] as const) {
      if (k === 'a' && (!isObj(q) || !Array.isArray(q.tags) || !q.tags.length)) err(w, '"a" needs a list of tags.');
      if (!q) continue;
      for (const t of [...(q.tags ?? []), ...(q.not ?? [])]) needTag(t, `${w}.${k}`, 'read');
      if (q.near && (!['a', 'event', 'route'].includes(q.near.of) || typeof q.near.cells !== 'number')) err(`${w}.${k}`, '"near" is { "of": "a" | "event" | "route", "cells": number }.');
      if (q.near?.of === 'a' && k === 'a') err(`${w}.a`, 'The first thing cannot be near itself. Put "near" on "b".');
      if (q.near && q.near.of !== 'a' && on === 'turn') err(`${w}.${k}`, 'Only a live event has a place or a route. A rule "on": "turn" can only use "near": { "of": "a" }.');
    }
    const fx = r.effect as { pool: string; n: number } | { amount: string; op: 'add' | 'mul'; n: number };
    const tier = isObj(on) ? (on as { tier?: string[] }).tier : undefined;
    if (tier !== undefined) {
      if (!isObj(on) || typeof on.live !== 'string') err(w, '"tier" goes with "live": { "live": "raid", "tier": ["success"] }.');
      if (!Array.isArray(tier) || !tier.length) err(w, '"tier" is a list of results.');
      else for (const t of tier) if (!TIERS.includes(t)) err(w, `Unknown result "${t}". The results are ${TIERS.join(', ')}.`);
    }
    const ending = isObj(r.effect) && 'end_run' in (r.effect as object);
    const lawAct = (isObj(r.effect) && 'law' in (r.effect as object)) || ending;
    const act = lawAct ? null : actOf(r);
    if (ending) {
      const x = r.effect as { end_run: unknown; name?: unknown };
      if (typeof x.end_run !== 'string' || typeof x.name !== 'string') err(w, 'A rule that ends the run: { "end_run": "won", "name": "what ended it" }.');
    } else if (lawAct) {
      // (laws: a rule that makes a law)
      const x = r.effect as { law: unknown; seasons?: unknown };
      needLaw(x.law, w);
      if (x.seasons !== undefined && (!Number.isInteger(x.seasons) || Number(x.seasons) < 1)) err(w, '"seasons" is a whole number, 1 or more. Leave it out for the rest of the run.');
      if (on === 'turn') warn(w, 'Each season it makes the law again, and laws stack: the same law twice is in force twice. Fine if that is the engine you mean.');
    } else if (act) {
      // (a rule that does something: offers a card, starts a live card, tags the thing it matched)
      if (r.perSeason !== undefined && (!Number.isInteger(r.perSeason) || r.perSeason < 1)) err(w, '"perSeason" is a whole number, 1 or more. Leave it out for a rule that fires every time.');
      if (act.kind === 'offer' || act.kind === 'start') {
        const c = cards.find((x) => x.id === act.id);
        if (!c) warn(w, `It ${act.kind}s the card "${act.id}", which is not in this pack. Fine only if a pack loaded with it has that card.`);
        else {
          if (act.kind === 'start' && !c.live) err(w, `It starts the card "${act.id}", which has no "live" event. Use "offer" for a card the player takes.`);
          if (act.kind === 'start' && Object.keys(c.cost ?? {}).length) err(w, `It starts the card "${act.id}", which has a cost. A card that begins by itself cannot cost anything.`);
          if (c.appears_when?.length) warn(w, `The card "${act.id}" comes up only when this rule ${act.kind}s it: its own "appears_when" is not used. Remove it.`);
        }
        if (on === 'turn' && c && c.once === false) warn(w, `Each season it ${act.kind}s "${act.id}" again, for as long as its things are in play.`);
      } else {
        needTag(act.id, w, 'made');
        if (KNOWN_TAGS.includes(act.id) && !['festival', 'growth-active'].includes(act.id)) err(w, `The tag "${act.id}" is set by the game itself. A rule may set the pack's own tags, "festival" and "growth-active".`);
        if ((r.effect as { on?: string }).on !== 'a') err(w, 'A rule tags the thing it matched: "on": "a".');
      }
    } else if (!isObj(fx) || typeof fx.n !== 'number' || fx.n === 0) err(w, 'A rule needs an "effect": a pool or an amount with a number "n" that is not 0, or "offer", "start", "tag", "untag".');
    else if (tier !== undefined && 'amount' in fx) err(w, 'A rule about a result ("tier") comes after the event\'s numbers are read: it cannot change an amount. It can change a pool, or offer, start or tag.');
    else if ('pool' in fx) {
      pool(fx.pool, `${w}.effect`);
      // (the owner's ruling, 2026-11-16: engines are not bounded. `cap` is the author's own word: only a rule that
      // multiplies by a count and has none is pointed at, to be sure it is meant)
      if (fx.n > 0 && typeof r.cap !== 'number' && r.per !== undefined) warn(w, 'This rule adds to a pool for each thing or each so-many of an amount, with no "cap". It can pay any amount. Fine if that is the engine you mean.');
    } else {
      if (on === 'turn' || !isObj(on) || typeof on.live !== 'string') err(w, 'Only a rule "on": { "live": ... } can change an event\'s amount.');
      if (!['add', 'mul'].includes(fx.op)) err(w, '"op" is "add" or "mul".');
    }
    // (a rule on a live event names numbers every event of that kind must have: the engine stops on a missing one)
    if (isObj(on) && typeof on.live === 'string') {
      const names = [...('amount' in (fx ?? {}) ? [(fx as { amount: string }).amount] : []), ...(isObj(r.per) ? [(r.per as { amount: string }).amount] : [])];
      for (const a of names) {
        if (LIVE_AMOUNTS[on.live] && !LIVE_AMOUNTS[on.live].includes(a)) err(w, `A "${on.live}" event of the base game has no amount "${a}". It has: ${LIVE_AMOUNTS[on.live].join(', ')}.`);
        for (const e of events) if (e.tag === on.live && !(e.amounts ?? []).includes(a)) err(w, `It reads the amount "${a}", but the event "${e.id}" of that kind does not list it in "amounts".`);
      }
    }
    if (r.need) pool(r.need.pool, `${w}.need`);
    if (r.per === 'b' && !r.b) err(w, '"per": "b" counts a second thing the rule does not name.');
    if (!act && !lawAct && r.why && !/\{n\}/.test(r.why)) warn(w, 'Its "why" does not say how much. Add {n}.');
    for (const n of numbersIn((r.why ?? '').replace(/\{\w+\}/g, ''))) if (!numbersOf([r.effect, r.cap, r.per]).includes(n)) err(w, `Its "why" says ${n}, but the rule's data has no such number. Use {n} for the amount.`);
  };
  rules.forEach((r, i) => checkRule(r, `rules[${i}] (${r.id})`));

  // ---- laws (docs/design/LAWS.md) ----
  const ruleIds = new Set([...(base.rules ?? []), ...rules.map((r) => r.id), ...laws.flatMap((l) => (isObj(l.does) && isObj(l.does.add_rule) ? [String((l.does.add_rule as { id?: unknown }).id)] : []))]);
  const allKeys = Object.values(LAW_KEYS).flat();
  const whole = (n: unknown, where: string, what: string, o: { min?: number; zero?: boolean } = {}) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || (o.min !== undefined && n < o.min) || (!o.zero && n === 0)) err(where, `${what} is a whole number${o.min !== undefined ? `, ${o.min} or more` : ''}${o.zero ? '' : ', not 0'}. It is ${JSON.stringify(n)}.`);
  };
  const query = (q: unknown, where: string, how: 'read' | 'made' = 'read') => {
    if (!isObj(q) || !Array.isArray(q.tags)) return err(where, 'A query is { "tags": [...], "not": [...] }.');
    for (const t of [...(q.tags as string[]), ...((q.not as string[] | undefined) ?? [])]) needTag(t, where, how);
  };
  const cardsOf = (m: unknown, where: string) => {
    if (m === undefined) return;
    if (!isObj(m) || (!Array.isArray(m.themes) && !Array.isArray(m.ids))) return err(where, '"cards" is { "themes": [...] } or { "ids": [...] }; leave it out for every card.');
    for (const id of (m.ids as string[] | undefined) ?? []) if (!cardIds.has(id) && !base.cards?.includes(id)) warn(where, `"cards" names the card "${id}", which is not in this pack or the base game. Fine only if a pack loaded with it has that card.`);
  };
  // (the record: a card's `laws_after` stand in every later run of the world it was done in)
  for (const c of cards) for (const l of c.laws_after ?? []) needLaw(l, `cards (${c.id}).laws_after`);
  laws.forEach((l, i) => {
    const w = `laws[${i}] (${l.id})`;
    if (!l.name) err(w, 'A law needs a "name" the player reads in the list of laws.');
    if (!isObj(l.does)) return err(w, `A law needs "does": one of ${allKeys.join(', ')}.`);
    const d = l.does;
    const keys = Object.keys(d).filter((k) => allKeys.includes(k));
    if (keys.length !== 1) return err(w, `"does" needs exactly one of ${allKeys.join(', ')}. It has ${keys.length ? keys.join(', ') : 'none'}.`);
    const k = keys[0];
    const known = new Set([k, ...(k === 'rule' ? ['set', 'times', 'on', 'a', 'b', 'off', 'fires'] : k === 'spell' ? ['kills', 'douses', 'also_tag', 'on'] : k === 'event' ? ['allow', 'shift', 'foes', 'tier', 'counts_as'] : k === 'grant' ? ['to'] : ['cost', 'pay', 'build', 'stay'].includes(k) ? ['cards'] : [])]);
    for (const x of Object.keys(d)) if (!known.has(x)) err(w, `"does" has "${x}", which a "${k}" law does not read.`);
    if (k === 'count_as') {
      const c = d.count_as as { tag?: unknown; as?: unknown };
      if (!isObj(c) || typeof c.tag !== 'string' || typeof c.as !== 'string') return err(w, '"count_as" is { "tag": "field", "as": "temple" }.');
      needTag(c.tag, w, 'read');
      needTag(c.as, w, 'made');
    } else if (k === 'grant') {
      if (typeof d.grant !== 'string') return err(w, '"grant" is a tag.');
      needTag(d.grant, w, 'made');
      query(d.to ?? { tags: [] }, `${w}.to`);
    } else if (k === 'spare') {
      if (!RUIN_WORDS.includes(String(d.spare))) err(w, `"spare" is a ruin word: ${RUIN_WORDS.join(', ')}.`);
    } else if (k === 'rule') {
      if (!ruleIds.has(String(d.rule))) warn(w, `It changes the rule "${String(d.rule)}", which is not a base rule or a rule of this pack. Fine only if a pack loaded with it has that rule.`);
      const set = d.set as Record<string, unknown> | undefined;
      if (set !== undefined) {
        if (!isObj(set)) err(w, '"set" is { "n": 4, "cap": 4, "each": 3, "perSeason": 2 }; null removes "cap" or "perSeason".');
        else
          for (const [x, v] of Object.entries(set)) {
            if (!['n', 'cap', 'each', 'perSeason'].includes(x)) err(w, `"set" can change n, cap, each and perSeason. It has "${x}".`);
            if (v !== null && typeof v !== 'number') err(w, `"set" gives numbers (or null to remove). ${x} is ${JSON.stringify(v)}.`);
            if (v === null && (x === 'n' || x === 'each')) err(w, `"${x}" cannot be removed.`);
            if (v === 0 && (x === 'n' || x === 'each')) err(w, `"${x}" cannot be 0: a rule that gives nothing is turned off with "off": true.`);
          }
      }
      if (d.times !== undefined && (typeof d.times !== 'number' || d.times <= 0)) err(w, '"times" is a number above 0: the rule gives so many times as much.');
      if (d.fires !== undefined) whole(d.fires, w, '"fires"', { min: 0, zero: true });
      if (d.off !== undefined && d.off !== true) err(w, '"off" is true or left out.');
      if (d.a !== undefined) query(d.a, `${w}.a`);
      if (d.b !== undefined) query(d.b, `${w}.b`);
      if (d.on !== undefined && d.on !== 'turn' && !(isObj(d.on) && (typeof d.on.event === 'string' || typeof d.on.live === 'string'))) err(w, '"on" is "turn", { "live": "<kind>" } or { "event": "<name>" }.');
      if (!['set', 'times', 'on', 'a', 'b', 'off', 'fires'].some((x) => x in d)) err(w, 'A "rule" law needs one of set, times, on, a, b, off, fires.');
    } else if (k === 'add_rule') {
      checkRule(d.add_rule as PackRule, `${w}.add_rule`);
      const r = d.add_rule as PackRule;
      if (isObj(r) && (base.rules?.includes(r.id) || rules.some((x) => x.id === r.id))) err(w, `The rule it adds has the id "${r.id}", which a rule already has.`);
      else if (isObj(r)) id('rule', r.id, `${w}.add_rule`);
    } else if (k === 'cost') {
      if (!isObj(d.cost) || !Object.keys(d.cost).length) err(w, '"cost" is { "materials": -1 }: so much more or less of each pool.');
      else for (const [x, n] of Object.entries(d.cost)) (pool(x, w), whole(n, w, `"cost" ${x}`), x === 'unrest' && err(w, 'Unrest is never a cost.'));
      cardsOf(d.cards, w);
    } else if (k === 'pay') {
      if (!isObj(d.pay) || !Object.keys(d.pay).length) err(w, '"pay" is { "labor": "magic" }: that part of a cost is paid from the other pool.');
      else for (const [x, v] of Object.entries(d.pay)) (pool(x, w), pool(v, w), (x === 'unrest' || v === 'unrest') && err(w, 'Unrest is never a cost.'));
      cardsOf(d.cards, w);
    } else if (k === 'build' || k === 'stay') {
      whole(d[k], w, `"${k}"`);
      cardsOf(d.cards, w);
    } else if (k === 'pool_as') {
      if (!isObj(d.pool_as)) err(w, '"pool_as" is { "unrest": "might" }.');
      else for (const [x, v] of Object.entries(d.pool_as)) (pool(x, w), v !== 'might' && err(w, '"pool_as" can only count a pool as "might" today (soldiers in a fight).'));
    } else if (k === 'spell') {
      const s = String(d.spell);
      const mine = abilities.find((a) => a.id === s);
      if (!LAW_SPELLS.includes(s) && !mine) err(w, `"spell" is one of ${LAW_SPELLS.join(', ')}, or an ability of this pack.`);
      if (d.kills !== undefined) whole(d.kills, w, '"kills"', { min: 0, zero: true });
      if (d.douses !== undefined) whole(d.douses, w, '"douses"', { min: 0, zero: true });
      if (d.also_tag !== undefined) {
        needTag(String(d.also_tag), w, 'made');
        if (KNOWN_TAGS.includes(String(d.also_tag)) && !['festival', 'growth-active'].includes(String(d.also_tag))) err(w, `A law may set the pack's own tags, "festival" and "growth-active". "${String(d.also_tag)}" is set by the game itself.`);
        query(d.on ?? { tags: [] }, `${w}.on`);
        if (s !== 'growth-rune' && s !== 'rain' && s !== 'fire' && s !== 'heat-ray') err(w, '"also_tag" works on the base spells only.');
      }
      if (d.kills === undefined && d.douses === undefined && d.also_tag === undefined) err(w, 'A "spell" law needs "kills", "douses" or "also_tag".');
    } else if (k === 'event') {
      if (!liveTags.has(String(d.event))) warn(w, `It is about the event kind "${String(d.event)}", which no event of this pack or the base game has. Fine only if a pack loaded with it has one.`);
      for (const s of (d.allow as string[] | undefined) ?? []) if (!EVENT_ABILITIES.includes(s)) err(w, `"allow" lists spells that can be cast into an event: ${EVENT_ABILITIES.join(', ')}.`);
      if (d.shift !== undefined) whole(d.shift, w, '"shift"');
      if (d.foes !== undefined) whole(d.foes, w, '"foes"');
      for (const t of (d.tier as string[] | undefined) ?? []) if (!TIERS.includes(t)) err(w, `Unknown result "${t}".`);
      const ca = d.counts_as as { live?: unknown; tier?: unknown } | undefined;
      if (ca !== undefined && (!isObj(ca) || typeof ca.live !== 'string' || !Array.isArray(ca.tier) || !(ca.tier as string[]).every((t) => TIERS.includes(t)))) err(w, '"counts_as" is { "live": "raid", "tier": ["failure"] }.');
      if (!['allow', 'shift', 'foes', 'counts_as'].some((x) => x in d)) err(w, 'An "event" law needs one of allow, shift, foes, counts_as.');
    } else if (k === 'board') whole(d.board, w, '"board"');
    else if (k === 'income') {
      if (!isObj(d.income)) err(w, '"income" is { "materials": 2 }.');
      else for (const [x, n] of Object.entries(d.income)) (GOODS.includes(x) || err(w, `Income by law is of ${GOODS.join(', ')}.`), whole(n, w, `"income" ${x}`));
    } else if (k === 'raiders') {
      const r = d.raiders as { add?: unknown; times?: unknown };
      if (!isObj(r) || (r.add === undefined && r.times === undefined)) err(w, '"raiders" is { "add": -6 } or { "times": 0.5 }.');
      else {
        if (r.add !== undefined) whole(r.add, w, '"add"');
        if (r.times !== undefined && (typeof r.times !== 'number' || r.times < 0)) err(w, '"times" is a number, 0 or more.');
      }
    } else if (k === 'win') {
      const x = d.win as { count?: unknown; tags?: unknown };
      if (!isObj(x) || !Array.isArray(x.tags) || !x.tags.length) err(w, '"win" is { "count": 5, "tags": ["temple"] }.');
      else {
        whole(x.count, w, '"count"', { min: 1 });
        for (const t of x.tags as string[]) needTag(t, w, 'read');
      }
    } else if (k === 'multipliers') {
      if (typeof d.multipliers !== 'number' || d.multipliers <= 0) err(w, '"multipliers" is a number above 0.');
    } else if (k === 'next_law' && d.next_law !== 'run') err(w, '"next_law" is "run".');
  });
  for (const l of laws) if (!brought.has(l.id)) warn(`laws (${l.id})`, 'Nothing brings this law into force: no effect, thing, rule or ability names it.');

  // ---- chains that come back to themselves (to look at: each step is bounded, one firing a season) ----
  for (const c of chainCycles([p])) warn(`rules (${c.rule})`, cycleText(c.way));

  // ---- tags nothing produces, tags nothing reads ----
  for (const t of tags) {
    if (!['site', 'town', 'far-town', 'unit', 'effect'].includes(t.on)) err(`tags (${t.id})`, `"on" is site, town, far-town, unit or effect. It is ${JSON.stringify(t.on)}.`);
    if (!t.meaning) err(`tags (${t.id})`, 'A tag needs a "meaning" in plain words.');
    if (t.ruins) err(`tags (${t.id})`, '"ruins": true is not supported yet. Only the existing ruin tags remove working tags; set them with "mutate".');
    // (a shared tag: another pack loaded with this one may produce or read it — checked over the set by checkTogether)
    if (!t.shared && !produced.has(t.id)) warn(`tags (${t.id})`, 'Nothing produces this tag: no thing carries it and no effect sets it. If another pack does, mark the tag "shared": true.');
    if (!t.shared && !read.has(t.id)) warn(`tags (${t.id})`, 'Nothing reads this tag: no rule, condition or ability looks for it. If another pack does, mark the tag "shared": true.');
  }
  return out;
}

/** what the base game records in the world's history that a rule `on: { "event": name }` can wait for (the events its
 *  cards and its arc write: season/realm-templates.ts, realm-events.ts, realm.ts) */
export const BASE_EVENT_KINDS: readonly string[] = [
  'built', 'made-safe', 'scouts-seen', 'farm-burned', 'tribute-paid', 'raid-held', 'raid-broke', 'raid-missed', 'lens-lit', 'camp-opened', 'camp-held', 'camp-lost',
  'relieved', 'fell', 'refugees-arrived', 'refugees-housed', 'refugees-resettled', 'refugees-turned-away', 'dead-burned', 'dead-loose', 'parade-held', 'parade-thin',
  'fire-fought', 'sellswords-hired', 'spell-cast', 'ability-cast',
];
/** Why a rule's event trigger is no good (null: it is fine; 'other': it names a card this pack has not). A pack can
 *  wait for: a base event; a land change to a SITE by any card (`burned`, `flooded` …); a card of a pack done
 *  (`pack-done:<card-id>`) or run out (`pack-lapsed:<card-id>`). */
export function eventTrigger(name: string, cards: ReadonlySet<string>): string | 'other' | null {
  if (BASE_EVENT_KINDS.includes(name) || LAND_KINDS.includes(name)) return null;
  const m = /^pack-(done|lapsed):(.+)$/.exec(name);
  if (m) return cards.has(m[2]) ? null : 'other';
  return `Unknown event "${name}". A rule can wait for: a card done ("pack-done:<card-id>") or run out ("pack-lapsed:<card-id>"); a land change to a site (${LAND_KINDS.join(', ')}); or one of the base game's events: ${BASE_EVENT_KINDS.join(', ')}.`;
}

const cycleText = (way: string[]): string => `This chain comes back to itself: ${way.join(' -> ')}. A loop is allowed: each turn of it costs the player a season or an action (a card to take, an event to win). It goes on for as long as its things are in play and its cards can come back ("once": false). Check what one turn pays against what it costs.`;
/** what an acting rule does (null: it changes a pool or an amount) */
export function actOf(r: PackRule): { kind: 'offer' | 'start' | 'tag' | 'untag'; id: string } | null {
  const fx = r.effect as Record<string, unknown>;
  if (!isObj(fx)) return null;
  for (const k of ['offer', 'start', 'tag', 'untag'] as const) if (typeof fx[k] === 'string') return { kind: k, id: fx[k] as string };
  return null;
}
/**
 * The chains a set of packs can make, as far as the data shows: a rule that offers or starts a card is followed by
 * the rules that card sets off (its `pack-done` / `pack-lapsed` event; for a live card, the rules on its event's kind
 * that wait for a result). Returns each rule that can come back to itself, with the way round.
 */
export function chainCycles(packs: readonly Pack[]): { rule: string; pack: string; way: string[] }[] {
  const rules = packs.flatMap((p) => (p.rules ?? []).map((r) => ({ r, pack: p.pack.id })));
  const cards = new Map(packs.flatMap((p) => (p.cards ?? []).map((c) => [c.id, { c, kind: (p.events ?? []).find((e) => e.id === c.live)?.tag }] as const)));
  const next = (id: string): string[] => {
    const act = actOf(rules.find((x) => x.r.id === id)!.r);
    const card = act && (act.kind === 'offer' || act.kind === 'start') ? cards.get(act.id) : undefined;
    if (!act || !card) return [];
    return rules
      .filter(({ r }) => {
        const on = r.on as { event?: string; live?: string; tier?: string[] };
        if (!isObj(on)) return false;
        return on.event === `pack-done:${act.id}` || on.event === `pack-lapsed:${act.id}` || (!!card.kind && on.live === card.kind && !!on.tier);
      })
      .map(({ r }) => r.id);
  };
  const out: { rule: string; pack: string; way: string[] }[] = [];
  for (const { r, pack } of rules) {
    if (!actOf(r)) continue;
    const stack: string[][] = next(r.id).map((x) => [x]);
    const seen = new Set<string>();
    while (stack.length) {
      const way = stack.pop()!;
      const at = way[way.length - 1];
      if (at === r.id) {
        out.push({ rule: r.id, pack, way: [r.id, ...way] });
        break;
      }
      if (seen.has(at)) continue;
      seen.add(at);
      for (const n of next(at)) stack.push([...way, n]);
    }
  }
  return out;
}

/** the base game's rule ids (season/realm-rules.ts): two rules with one id stop the game from starting */
export const BASE_RULE_IDS: readonly string[] = ['blessed-fields', 'temple-procession', 'garrisoned-walls', 'gate-market', 'water-by-fire', 'sullen-festival', 'harvest-home', 'tower-watch', 'forge-by-keep', 'camp-hands', 'garrison-pay', 'roofs-to-mend', 'idle-hands', 'bread-for-all'];
/** cards of several packs on one site before the validator says to look (one card stands at a site at a time) */
export const SITE_CROWD = 3;
/** threats over all the packs before the validator says to look (one threat stands at a time) */
export const THREAT_CROWD = 4;

/**
 * Problems that only show when several packs are loaded together (each has passed `checkPack` alone): an id two packs
 * share, a tag two packs declare differently, a rule on a live event kind none of them has, and — to look at — too
 * many cards on one site or too many threats over the set.
 */
export function checkTogether(packs: readonly Pack[]): Problem[] {
  const out: Problem[] = [];
  const err = (where: string, text: string): void => void out.push({ level: 'error', where, text });
  const warn = (where: string, text: string): void => void out.push({ level: 'warn', where, text });
  const name = (p: Pack): string => p?.pack?.id ?? '?';
  const owner = new Map<string, string>();
  for (const p of packs) {
    if (packs.filter((q) => name(q) === name(p)).length > 1 && !owner.has(`pack:${name(p)}`)) err(name(p), `Two packs have the id "${name(p)}". Each pack needs its own id.`);
    owner.set(`pack:${name(p)}`, name(p));
    for (const [kind, list] of [['card', p.cards], ['thing', p.things], ['rule', p.rules], ['event', p.events], ['ability', p.abilities], ['law', p.laws]] as const)
      for (const x of list ?? []) {
        const first = owner.get(x.id);
        if (first && first !== name(p)) err(`${name(p)} ${kind} (${x.id})`, `The id "${x.id}" is also used in the pack "${first}". Put each pack's id in front of its ids: "${name(p)}-…".`);
        else owner.set(x.id, name(p));
      }
  }
  // (laws: a law about a rule or a card names one some pack of the set or the base game has)
  const ruleIds = new Set([...BASE_RULE_IDS, ...packs.flatMap((p) => (p.rules ?? []).map((r) => r.id)), ...packs.flatMap((p) => (p.laws ?? []).flatMap((l) => (isObj(l.does) && isObj(l.does.add_rule) ? [String((l.does.add_rule as { id?: unknown }).id)] : [])))]);
  const cardIds = new Set([...BASE_CARD_IDS, ...packs.flatMap((p) => (p.cards ?? []).map((c) => c.id))]);
  for (const p of packs)
    for (const l of p.laws ?? []) {
      if (!isObj(l.does)) continue;
      if (typeof l.does.rule === 'string' && !ruleIds.has(l.does.rule)) err(`${name(p)} law (${l.id})`, `It changes the rule "${l.does.rule}", which no pack of the set and not the base game has.`);
      for (const id of ((l.does.cards as { ids?: string[] } | undefined)?.ids ?? [])) if (!cardIds.has(id)) err(`${name(p)} law (${l.id})`, `It names the card "${id}", which no pack of the set and not the base game has.`);
    }
  // (a shared custom tag: each pack that uses it declares it, and every declaration says the same)
  const tags = new Map<string, { pack: string; on: string; timed: boolean }>();
  for (const p of packs)
    for (const t of p.tags ?? []) {
      const was = tags.get(t.id);
      if (!was) tags.set(t.id, { pack: name(p), on: t.on, timed: !!t.timed });
      else if (was.timed !== !!t.timed) err(`${name(p)} tags (${t.id})`, `The pack "${was.pack}" declares the tag "${t.id}" with "timed": ${was.timed}; here it is ${!!t.timed}. A shared tag must be declared the same in every pack.`);
      else if (was.on !== t.on) err(`${name(p)} tags (${t.id})`, `The pack "${was.pack}" declares the tag "${t.id}" with "on": "${was.on}"; here it is "${t.on}". A shared tag must be declared the same in every pack.`);
    }
  // (over the whole set, each declared tag is produced by something and read by something)
  const made = new Set<string>();
  const read = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return void x.forEach(walk);
    if (!isObj(x)) return;
    if (typeof x.tag === 'string' && typeof x.on === 'string') made.add(x.tag);
    for (const k of ['town_has', 'site_has'] as const) if (Array.isArray(x[k])) for (const t of x[k] as string[]) read.add(t);
    for (const v of Object.values(x)) walk(v);
  };
  for (const p of packs) {
    for (const t of p.things ?? []) for (const x of t.tags ?? []) made.add(x);
    for (const r of p.rules ?? []) for (const q of [r.a, r.b]) for (const x of [...(q?.tags ?? []), ...(q?.not ?? [])]) read.add(x);
    for (const a of p.abilities ?? []) for (const x of a.target?.tags ?? []) read.add(x);
    for (const r of p.rules ?? []) if (actOf(r)?.kind === 'tag') made.add(actOf(r)!.id);
    walk([p.cards, p.abilities]);
  }
  for (const [id, t] of tags) {
    if (!made.has(id)) warn(`${t.pack} tags (${id})`, 'No loaded pack produces this tag: no thing carries it and no effect sets it.');
    if (!read.has(id)) warn(`${t.pack} tags (${id})`, 'No loaded pack reads this tag: no rule, condition or ability looks for it.');
  }
  const kinds = new Set([...LIVE_KINDS, ...packs.flatMap((p) => (p.events ?? []).map((e) => e.tag))]);
  const allCards = new Set(packs.flatMap((p) => (p.cards ?? []).map((c) => c.id)));
  // (chains over the set: a rule that offers or starts a card of another pack, and chains that come back round)
  for (const p of packs)
    for (const r of p.rules ?? []) {
      const act = actOf(r);
      if (act && (act.kind === 'offer' || act.kind === 'start') && !allCards.has(act.id)) err(`${name(p)} rules (${r.id})`, `It ${act.kind}s the card "${act.id}", but no loaded pack has that card.`);
    }
  if (packs.length > 1) for (const c of chainCycles(packs)) if (!chainCycles(packs.filter((p) => name(p) === c.pack)).some((x) => x.rule === c.rule)) warn(`${c.pack} rules (${c.rule})`, cycleText(c.way));
  for (const p of packs)
    for (const r of p.rules ?? []) {
      const on = r.on as 'turn' | { live?: string };
      if (isObj(on) && typeof on.live === 'string' && !kinds.has(on.live)) err(`${name(p)} rules (${r.id})`, `It triggers on the live event kind "${on.live}", which no event of any loaded pack or the base game has.`);
      const ev = (r.on as { event?: string }).event;
      if (typeof ev === 'string' && eventTrigger(ev, allCards) === 'other') err(`${name(p)} rules (${r.id})`, `It triggers on "${ev}", but no loaded pack has that card.`);
      // (a rule of one pack about an event kind of another must name numbers that event lists)
      const fx = r.effect as { amount?: string };
      const names = [...(isObj(on) && typeof on.live === 'string' && typeof fx?.amount === 'string' ? [fx.amount] : []), ...(isObj(on) && typeof on.live === 'string' && isObj(r.per) ? [(r.per as { amount: string }).amount] : [])];
      for (const q of packs) if (q !== p) for (const e of q.events ?? []) for (const a of names) if (isObj(on) && e.tag === on.live && !(e.amounts ?? []).includes(a)) err(`${name(p)} rules (${r.id})`, `It reads the amount "${a}", but the event "${e.id}" of the pack "${name(q)}" is a "${e.tag}" event and does not list "${a}" in "amounts". The game would stop when that event ends.`);
    }
  const sites = new Map<string, string[]>();
  let threats = 0;
  // (a card that only a rule offers or starts comes one at a time, after another: it does not crowd its site)
  const chained = new Set(packs.flatMap((p) => (p.rules ?? []).map((r) => actOf(r)).filter((a) => a && (a.kind === 'offer' || a.kind === 'start')).map((a) => a!.id)));
  for (const p of packs)
    for (const c of p.cards ?? []) {
      const s = c.presenter?.at ?? '?';
      if (!chained.has(c.id)) sites.set(s, [...(sites.get(s) ?? []), c.id]);
      if (c.threat) threats++;
    }
  for (const [s, ids] of sites) if (ids.length > SITE_CROWD) warn(`all packs (${s})`, `${ids.length} cards stand at ${s}: ${ids.join(', ')}. One card stands at a site at a time, so they wait for each other. Spread them over more sites.`);
  if (threats > THREAT_CROWD) warn('all packs', `${threats} threats over the loaded packs. One threat stands at a time, and a run has 15 seasons: some will never come up.`);
  return out;
}

/** the problems as lines an author reads */
export function reportText(name: string, ps: Problem[]): string {
  const e = ps.filter((x) => x.level === 'error');
  const w = ps.filter((x) => x.level === 'warn');
  const lines = [`${name}: ${e.length ? `${e.length} to fix` : 'no errors'}${w.length ? `, ${w.length} to look at` : ''}.`];
  for (const x of e) lines.push(`  FIX   ${x.where}: ${x.text}`);
  for (const x of w) lines.push(`  LOOK  ${x.where}: ${x.text}`);
  return lines.join('\n');
}
