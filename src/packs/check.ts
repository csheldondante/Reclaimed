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
  | { resolved: string }
  | { leader: string };

export type PackEffect =
  | { pool: string; add: number }
  | { income: string; add: number }
  | { put: string; at?: string }
  | { remove: string }
  | { tag: string; on: string }
  | { untag: string; on: string }
  | { mutate: string; where: string }
  | { far: string; where?: string; by?: string; tribute?: number; id?: string; name?: string; purpose?: string }
  | { sign: string; seasons?: number; strength?: number }
  | { arrive: string; count?: number; from?: string }
  | { unlock: string }
  | { say: string };

export interface PackTag {
  id: string;
  on: string;
  meaning: string;
  timed?: boolean;
  ruins?: boolean;
}
export interface PackThing {
  id: string;
  name: string;
  kind: string;
  at: string;
  tags: string[];
  text: string;
  capacity?: number;
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
  art?: string;
}
/** a rule: the engine's own RuleDef (living/rules.ts), unchanged */
export interface PackRule {
  id: string;
  name: string;
  on: 'turn' | { event: string } | { live: string };
  a: PackQuery;
  b?: PackQuery;
  need?: { pool: string; gte?: number; lte?: number };
  effect: { pool: string; n: number } | { amount: string; op: 'add' | 'mul'; n: number };
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
  effect: PackEffect[];
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
export const BASE_ABILITIES: readonly string[] = ['growth-rune', 'fire', 'heat-ray', 'rain'];
export const UNIT_KINDS: readonly string[] = ['soldier', 'raider', 'worker', 'cart', 'dead'];
/** the base game's card ids (season/realm-templates.ts): a pack's may not clash with them */
export const BASE_CARD_IDS: readonly string[] = ['build:houses', 'build:farms', 'build:market', 'build:workshops', 'build:harbour', 'build:keep', 'build:quarry', 'build:lumber', 'build:bridge', 'build:trade', 'build:walls', 'mining-outpost', 'tower-lens', 'relieve-neighbour', 'house-refugees', 'guard-camp', 'dead-rise', 'pay-raiders', 'mend-dam', 'fire-wards', 'feed-shrine', 'shore-hill', 'raid', 'gate-parade', 'refugees-arrive', 'resettle-refugees', 'market-fire'];
export const COND_KEYS: readonly string[] = ['pool', 'season_gte', 'has_thing', 'no_thing', 'town_has', 'site_has', 'far_town_is', 'resolved', 'leader'];
export const EFFECT_KEYS: readonly string[] = ['pool', 'income', 'put', 'remove', 'tag', 'untag', 'mutate', 'far', 'sign', 'arrive', 'unlock', 'say'];
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
  base = { cards: base.cards ?? BASE_CARD_IDS, rules: base.rules ?? [] };
  const out: Problem[] = [];
  const err = (where: string, text: string): void => void out.push({ level: 'error', where, text });
  const warn = (where: string, text: string): void => void out.push({ level: 'warn', where, text });
  if (!isObj(p) || !isObj(p.pack) || typeof p.pack.id !== 'string') {
    err('pack', 'The file needs a "pack" block with an "id" and a "name".');
    return out;
  }
  for (const k of ['tags', 'things', 'cards', 'rules', 'events', 'abilities', 'wants'] as const) if (p[k] !== undefined && !Array.isArray(p[k])) err(k, `"${k}" must be a list.`);
  if (out.length) return out;
  const tags = p.tags ?? [];
  const things = p.things ?? [];
  const cards = p.cards ?? [];
  const rules = p.rules ?? [];
  const events = p.events ?? [];
  const abilities = p.abilities ?? [];

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

  const tagIds = new Set([...KNOWN_TAGS, ...tags.map((t) => t.id)]);
  const thingIds = new Set(things.map((t) => t.id));
  const cardIds = new Set(cards.map((c) => c.id));
  const eventIds = new Set(events.map((e) => e.id));
  const abilityIds = new Set([...BASE_ABILITIES, ...abilities.map((a) => a.id)]);
  const produced = new Set<string>();
  const read = new Set<string>();
  const put = new Set<string>();
  const needTag = (t: string, where: string, how: 'read' | 'made') => {
    if (!tagIds.has(t)) err(where, `Unknown tag "${t}". Use an existing tag or add it to the pack's "tags" list.`);
    (how === 'read' ? read : produced).add(t);
  };
  const pool = (k: unknown, where: string) => {
    if (typeof k !== 'string' || !POOL_NAMES.includes(k)) err(where, `Unknown pool ${JSON.stringify(k)}. The pools are ${POOL_NAMES.join(', ')}.`);
  };
  const place = (ref: string | undefined, where: string, allow: { town?: boolean; far?: boolean; target?: boolean } = {}) => {
    if (ref === 'town' && allow.town) return;
    if (ref === 'far:neighbour' && allow.far) return;
    if (ref === 'target' && allow.target) return;
    if (ref?.startsWith('far:')) return err(where, `"${ref}" is not supported yet. The only far place a card can name is "far:neighbour", the nearest standing town.`);
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
    if ('upkeep' in t) err(w, `"upkeep" is ${NOT_YET.upkeep}.`);
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
        place(String(x.where), w, { town: true, far: true });
        produced.add(String(x.mutate));
      } else if (key === 'far') {
        if (!FAR_KINDS.includes(String(x.far))) err(w, `Unknown change to a far place "${String(x.far)}". The kinds are ${FAR_KINDS.join(', ')}.`);
        if (x.far === 'founded') {
          if (typeof x.id !== 'string' || typeof x.name !== 'string') err(w, 'A founded place needs an "id" and a "name".');
        } else place(String(x.where), w, { far: true });
        if (x.by !== undefined && x.by !== 'raiders' && x.by !== 'player') err(w, `"by" can be "raiders" or "player". It is ${JSON.stringify(x.by)}.`);
      } else if (key === 'sign') {
        if (!SIGN_KINDS.includes(String(x.sign))) err(w, `Unknown sign "${String(x.sign)}". The signs are ${SIGN_KINDS.join(', ')}.`);
        if (x.strength !== undefined && (typeof x.strength !== 'number' || x.strength < 0 || x.strength > 1)) err(w, '"strength" is a number from 0 (off) to 1.');
      } else if (key === 'arrive') {
        if (x.arrive !== 'refugees') err(w, `"arrive": "${String(x.arrive)}" is not supported yet. Only "refugees" arrive today.`);
        else if (x.from !== 'far:neighbour') err(w, 'Refugees can only come "from": "far:neighbour" today.');
        else if (x.count !== undefined && x.count !== 40) err(w, `The engine brings 40 refugees each time. Write "count": 40 or leave it out. It is ${JSON.stringify(x.count)}.`);
      } else if (key === 'unlock') {
        if (x.unlock !== 'heat-ray' && !abilities.some((a) => a.id === x.unlock)) err(w, `"unlock" names the ability "${String(x.unlock)}". It can be an ability of this pack, or "heat-ray".`);
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
    for (const a of e.abilities ?? []) if (!EVENT_ABILITIES.includes(a)) err(w, abilityIds.has(a) ? `The ability "${a}" does nothing when cast into an event yet. The ones that do: ${EVENT_ABILITIES.join(', ')}.` : `Unknown ability "${a}". The ones that can be cast into an event: ${EVENT_ABILITIES.join(', ')}.`);
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
    if (!a.target?.tags?.length) err(w, 'An ability needs a "target" with tags: what it can be cast on.');
    for (const t of a.target?.tags ?? []) needTag(t, w, 'read');
    effects(a.effect, `${w}.effect`, { ability: true });
    for (const e of a.effect ?? []) if (!('tag' in e) && !('untag' in e) && !('pool' in e) && !('say' in e)) err(w, `An ability's effect can set or clear a tag on its target, or change a pool. ${JSON.stringify(e)} is not supported yet.`);
    for (const n of numbersIn(a.text ?? '')) if (![...numbersOf(a.cost), ...numbersOf(a.effect)].includes(n)) err(w, `The text says ${n}, but the ability's cost and effects have no such number.`);
    if (!cards.some((c) => JSON.stringify([c.if_taken, c.if_tier]).includes(`"unlock":"${a.id}"`))) warn(w, 'No card unlocks this ability.');
  });

  // ---- rules ----
  rules.forEach((r, i) => {
    const w = `rules[${i}] (${r.id})`;
    if (!r.name || !r.why) err(w, 'A rule needs a "name" and a "why" in plain words.');
    const on = r.on as 'turn' | { event?: string; live?: string };
    if (on !== 'turn' && !(isObj(on) && (typeof on.event === 'string' || typeof on.live === 'string'))) err(w, '"on" is "turn", { "live": "<kind>" } or { "event": "<name>" }.');
    if (isObj(on) && typeof on.live === 'string' && !liveTags.has(on.live)) err(w, `It triggers on the live event kind "${on.live}", which no event has. Kinds: ${[...liveTags].join(', ')}.`);
    for (const [k, q] of [['a', r.a], ['b', r.b]] as const) {
      if (k === 'a' && (!isObj(q) || !Array.isArray(q.tags) || !q.tags.length)) err(w, '"a" needs a list of tags.');
      if (!q) continue;
      for (const t of [...(q.tags ?? []), ...(q.not ?? [])]) needTag(t, `${w}.${k}`, 'read');
      if (q.near && (!['a', 'event', 'route'].includes(q.near.of) || typeof q.near.cells !== 'number')) err(`${w}.${k}`, '"near" is { "of": "a" | "event" | "route", "cells": number }.');
      if (q.near?.of === 'a' && k === 'a') err(`${w}.a`, 'The first thing cannot be near itself. Put "near" on "b".');
      if (q.near && q.near.of !== 'a' && on === 'turn') err(`${w}.${k}`, 'Only a live event has a place or a route. A rule "on": "turn" can only use "near": { "of": "a" }.');
    }
    const fx = r.effect;
    if (!isObj(fx) || typeof fx.n !== 'number' || fx.n === 0) err(w, 'A rule needs an "effect" with a number "n" that is not 0.');
    else if ('pool' in fx) {
      pool(fx.pool, `${w}.effect`);
      if (fx.n > 0 && typeof r.cap !== 'number') err(w, 'This rule adds to a pool and has no "cap". Every rule that adds to a pool needs one.');
    } else {
      if (on === 'turn' || !isObj(on) || typeof on.live !== 'string') err(w, 'Only a rule "on": { "live": ... } can change an event\'s amount.');
      if (!['add', 'mul'].includes(fx.op)) err(w, '"op" is "add" or "mul".');
    }
    if (r.need) pool(r.need.pool, `${w}.need`);
    if (r.per === 'b' && !r.b) err(w, '"per": "b" counts a second thing the rule does not name.');
    if (r.why && !/\{n\}/.test(r.why)) warn(w, 'Its "why" does not say how much. Add {n}.');
    for (const n of numbersIn((r.why ?? '').replace(/\{\w+\}/g, ''))) if (!numbersOf([r.effect, r.cap, r.per]).includes(n)) err(w, `Its "why" says ${n}, but the rule's data has no such number. Use {n} for the amount.`);
  });

  // ---- tags nothing produces, tags nothing reads ----
  for (const t of tags) {
    if (!['site', 'town', 'far-town', 'unit', 'effect'].includes(t.on)) err(`tags (${t.id})`, `"on" is site, town, far-town, unit or effect. It is ${JSON.stringify(t.on)}.`);
    if (!t.meaning) err(`tags (${t.id})`, 'A tag needs a "meaning" in plain words.');
    if (t.ruins) err(`tags (${t.id})`, '"ruins": true is not supported yet. Only the existing ruin tags remove working tags; set them with "mutate".');
    if (!produced.has(t.id)) warn(`tags (${t.id})`, 'Nothing produces this tag: no thing carries it and no effect sets it.');
    if (!read.has(t.id)) warn(`tags (${t.id})`, 'Nothing reads this tag: no rule, condition or ability looks for it.');
  }
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
