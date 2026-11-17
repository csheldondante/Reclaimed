// (card-table; docs/design/PACK_FORMAT.md) The validator for outside-authored opportunity packs: one pack's JSON in,
// a list of problems out, each in plain words an author who has never seen the code can act on. The loader
// (packs/load.ts) refuses a pack with errors. This file imports nothing at run time, so `node scripts/packcheck.mjs
// <file>` runs it as it is; its vocabularies are checked against the engine's own by test/unit/packs.test.ts.

import type { SeasonWeather } from '../weather/presets';

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
  | { resolved: string; tier?: string[]; at?: string; run?: 'earlier' | 'any'; about?: string }
  | { leader: string }
  // (draft 7: factions) how many far towns a faction holds; the stance between a faction and the player (or another)
  | { faction_holds: string; gte?: number; lte?: number }
  | { faction_stance: string; is: string[]; with?: string }
  // (draft 8: the record knows it — a faction met, a place found, an ending reached, in any run of this world)
  | { met: string }
;

/** (draft 8) between runs: when the world fits, these effects are applied as the next run begins (years pass), and
 *  the line is shown at that run's start ("While you were gone: …") */
export interface PackBetween {
  id: string;
  when?: PackCond[];
  do: PackEffect[];
  say: string;
}

/** (draft 7) a faction the pack declares: pirates, a rival town, a mining guild. It is an entity of the world (who
 *  holds a town, who a live event's foes belong to) with a stance towards the player and towards other factions */
export interface PackFaction {
  id: string;
  name: string;
  /** a note for the reader: pirates, town, guild, band … */
  kind: string;
  text: string;
}

/** (draft 7: templates) a card's variable: what kind of place or faction it binds to. The dealer offers one card for
 *  each binding it finds worth offering. `set_off`: it binds to what the rule that offered or started the card matched */
export type PackBind =
  | { site: { tags?: string[]; not?: string[] }; set_off?: boolean }
  | { far: { state?: string[]; tags?: string[]; not?: string[]; holder?: string }; set_off?: boolean }
  | { faction: { stance?: string[]; with?: string }; set_off?: boolean }
  // (loop round 14, draft 9) a point of interest on the map: its kind, its state, every tag, none of `not`, its holder
  | { poi: { kind?: string[]; state?: string[]; tags?: string[]; not?: string[]; holder?: string }; set_off?: boolean };

export type PackEffect =
  // (loop round 14, draft 9) a point of interest put on the map near a place, and a card changing one's state
  | { poi: string; id: string; name: string; near?: string; holder?: string }
  | { poi_state: string; where: string }
  | { pool: string; add: number }
  | { income: string; add: number }
  | { put: string; at?: string }
  | { remove: string }
  | { tag: string; on: string }
  | { untag: string; on: string }
  | { mutate: string; where: string }
  | { far: string; where?: string; by?: string; tribute?: number; id?: string; name?: string; purpose?: string; resource?: string }
  | { stance: string; to: string; with?: string }
  | { sign: string; seasons?: number; strength?: number; where?: string; for_good?: boolean }
  | { trade: string; end?: boolean }
  | { arrive: string; count?: number; from?: string }
  // (draft 8: an ability of the pack — this run; or locked content — a card, a leader, "pack:<id>" — for good)
  | { unlock: string }
  | { law: string; seasons?: number }
  // (draft 8, between runs only: a law a card's `laws_after` left stops standing from the next run)
  | { law_ends: string }
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
  /** (loop round 8) a picture's URL for the thing's card (else local/art/<id>.png if there) */
  image?: string;
}
export interface PackCard {
  id: string;
  title: string;
  presenter: { name?: string; role: string; at: string };
  pitch: string;
  /** (draft 7) the card's variables: `$name` in places and `{name}` in text */
  bind?: Record<string, PackBind>;
  appears_when?: PackCond[];
  threat?: boolean;
  /** true (default): once for each binding; "run": once a run whatever it binds; false: comes back */
  once?: boolean | 'run';
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
  /** (ages) only when the card ended so: results (`success` …) or "lapsed" (a world-ending left to run out) */
  laws_after_if?: string[];
  /** 1 to 5: how soon it comes up among the cards whose conditions hold (3: as a middling base card) */
  weight?: number;
  /** (draft 8) never dealt until an `unlock` names it (in an earlier run of the world or this one); `hint`: the line
   *  "Not yet found" shows */
  locked?: boolean;
  hint?: string;
  art?: string;
  /** (loop round 8) a picture's URL for the card's presenter (else local/art/<id>.png if there, else a pixel face) */
  image?: string;
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
  /** (loop round 12) a front's `far` (how far uphill its source is), `rate` and `pour` (seconds) */
  hazard?: { kind: string; points: number; spread: number; far?: number; rate?: number; pour?: number };
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
  /** (loop round 10, LS-94) or turns the foes within `berserk` paces of the tap on anyone near, one another too; or
   *  hides your people within `hides` paces (no foe goes for them; they are not seen) */
  /** (loop round 12) or raises a shield `shield` paces wide round the tap for `seconds`: lava and flood water flow
   *  round it; (loop round 14) fire and units stop at it too, and it gives way when what presses on it drains its
   *  `energy` faster than its `regen` (a second) fills it */
  in_event?: { kinds: string[]; kills?: number; douses?: number; berserk?: number; hides?: number; shield?: number; seconds?: number; energy?: number; regen?: number };
  text: string;
  look?: string;
}
export interface Pack {
  /** (draft 8) `locked`: none of the pack's cards is dealt until `{ "unlock": "pack:<id>" }`; `hint` for "Not yet found" */
  pack: { id: string; name: string; version: number; summary?: string; appears_when?: PackCond[]; themes?: string[]; locked?: boolean; hint?: string };
  /** (draft 8) what moves in the world between two runs (years pass) */
  between_runs?: PackBetween[];
  tags?: PackTag[];
  things?: PackThing[];
  cards?: PackCard[];
  rules?: PackRule[];
  events?: PackEvent[];
  abilities?: PackAbility[];
  laws?: PackLaw[];
  factions?: PackFaction[];
  /** (ages) who the player can be: offered at a run's start while the world fits */
  leaders?: PackLeader[];
  wants?: string[];
  /** (loop round 13) the weather of seasons of the run: `{ "season": 3, "weather": "fog" }`, `{ "from": 10, "weather":
   *  "ashfall" }`, `{ "from": 4, "to": 6, "weather": "rain" }` (src/weather/presets.ts seasonWeather) */
  weather?: SeasonWeather[];
}

/** (ages) a leader a pack offers at a run's start, while the world fits (`appears_when` over the record and the far
 *  places), with a start of their own: pools, income, things in play, laws in force, cards out of the deck.
 *  `replaces`: while this leader can be chosen, the base game's leaders cannot (the world has moved past them) */
export interface PackLeader {
  id: string;
  name: string;
  /** who they are, one plain line ("Chief of the ash tribe. Few hands, little to build with.") */
  line: string;
  appears_when?: PackCond[];
  replaces?: boolean;
  pools: Record<string, number>;
  income?: Record<string, number>;
  things?: string[];
  laws?: string[];
  deck_out?: { ids?: string[]; themes?: string[] };
  /** (draft 8) the run is played FROM a far town: the first that fits (yours, sworn to you, a colony, held by a
   *  faction …). The leader is offered only while one fits; the old home is a far town from then on */
  home?: { far: { state?: string[]; tags?: string[]; not?: string[]; holder?: string } };
  /** (draft 8) offered only once unlocked; `hint` for "Not yet found" */
  locked?: boolean;
  hint?: string;
}
/** (ages) the conditions a leader's `appears_when` may use: read on the world before the run, with no run to ask */
export const LEADER_COND_KEYS: readonly string[] = ['resolved', 'far_town_is', 'faction_stance', 'faction_holds', 'met'];

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
  // (draft 7: a far town as a thing the rules read — packs/load.ts farThings)
  'far-town', 'colony', 'vassal', 'founded', 'found', 'yours',
];
/** (draft 7) what a far town carries, set by the game: its state, whose it is (`yours`, or a faction's id) and what
 *  it was founded for (its resource tag) */
export const FAR_TAGS: readonly string[] = ['far-town', 'colony', 'vassal', 'founded', 'found', 'yours', 'occupied', 'destroyed', 'abandoned', 'standing', 'ruined', 'trade-partner'];
/** (draft 7) the stances between the player and a faction, or two factions (the fact layer's relations: hostile is
 *  `at_war_with`, truce `truce_with`, allied `allied_with`); "none" ends one */
export const STANCES: readonly string[] = ['hostile', 'truce', 'allied'];
/** (draft 7) a pack's far change kinds: the mutators' (FAR_KINDS) and "revealed" (a place found, not settled) */
export const PACK_FAR_KINDS: readonly string[] = ['captured', 'vassal', 'destroyed', 'abandoned', 'founded', 'revealed'];
/** (draft 7) the states a far variable may ask for: a far town's, and "found" (revealed, not settled) */
export const BIND_FAR_STATES: readonly string[] = ['standing', 'destroyed', 'abandoned', 'occupied', 'vassal', 'founded', 'found'];
export const LAND_KINDS: readonly string[] = ['flooded', 'burned', 'melted', 'buried', 'dried', 'withered', 'greened'];
export const FAR_KINDS: readonly string[] = ['captured', 'vassal', 'destroyed', 'abandoned', 'founded'];
/** (loop round 13) the weathers a pack's season list may name (src/weather/presets.ts WEATHER_IDS) */
export const WEATHER_NAMES: readonly string[] = ['fair', 'clear', 'rain', 'storm', 'ashfall', 'fog', 'dark'];
/** (loop round 13: `rain`, `storm`, `fog` are weathers, as `ashfall` and `darkness` are — src/weather/presets.ts) */
export const SIGN_KINDS: readonly string[] = ['ashfall', 'darkness', 'deadrise', 'crime', 'rain', 'storm', 'fog'];
export const TIERS: readonly string[] = ['triumph', 'success', 'cost', 'failure', 'disaster'];
export const THING_KINDS: readonly string[] = ['building', 'garrison', 'policy', 'effect', 'relic', 'people'];
export const LEADER_IDS: readonly string[] = ['ysolt', 'dunstan', 'ilveth'];
export const FAR_STATES: readonly string[] = ['standing', 'destroyed', 'abandoned', 'occupied', 'vassal', 'founded'];
export const LIVE_KINDS: readonly string[] = ['raid', 'parade', 'fire', 'rising', 'refugees'];
/** abilities that do something when cast into a live event (living/live.ts SPELL_MECH) */
export const EVENT_ABILITIES: readonly string[] = ['fire', 'heat-ray', 'rain'];
export const AMOUNTS: readonly string[] = ['crowd', 'stopped', 'burned', 'reached'];
/** (loop round 12, docs/design/FRONTS.md) the hazards an event may set going: a fire at the event's place, or a front —
 *  lava or flood water poured uphill of the event's place, running down the ground to it */
export const HAZARD_KINDS: readonly string[] = ['fire', 'lava', 'flood'];
/** a front's defaults (cells, cells³ a second, seconds): what reached Muru's market across its flat valley in round 12
 *  (lava has a yield: 90 cells out at 40 a second it piled by its vent; 45 out at 300 a second it went ~27 cells) */
export const FRONT_DEFAULTS = { far: 36, rate: 220, pour: 45 };
/** the numbers each of the base game's live events has (season/realm-events.ts), which a rule on that kind may name */
export const LIVE_AMOUNTS: Record<string, readonly string[]> = {
  raid: ['raiders', 'alive', 'soldiers', 'fallen', 'stopped'],
  rising: ['up'],
  parade: ['crowd', 'marching', 'out'],
  fire: ['lots', 'burned', 'alight', 'rain'],
  refugees: ['walking', 'carts'],
};
/** the numbers the base game's rules change in each kind of live event (season/realm-rules.ts) */
export const LIVE_NEEDS: Record<string, readonly string[]> = { raid: ['stopped'], parade: ['crowd'], fire: ['burned'] };
export const BASE_ABILITIES: readonly string[] = ['growth-rune', 'fire', 'heat-ray', 'rain'];
export const UNIT_KINDS: readonly string[] = ['soldier', 'raider', 'worker', 'cart', 'dead'];
/** the base game's card ids (season/realm-templates.ts): a pack's may not clash with them */
export const BASE_CARD_IDS: readonly string[] = ['build:houses', 'build:farms', 'build:market', 'build:workshops', 'build:harbour', 'build:keep', 'build:quarry', 'build:lumber', 'build:bridge', 'build:trade', 'build:walls', 'mining-outpost', 'tower-lens', 'relieve-neighbour', 'house-refugees', 'guard-camp', 'dead-rise', 'pay-raiders', 'mend-dam', 'fire-wards', 'feed-shrine', 'shore-hill', 'raid', 'gate-parade', 'refugees-arrive', 'resettle-refugees', 'market-fire', 'hire-sellswords'];
export const COND_KEYS: readonly string[] = ['pool', 'season_gte', 'has_thing', 'no_thing', 'town_has', 'site_has', 'far_town_is', 'resolved', 'leader', 'faction_holds', 'faction_stance', 'met'];
export const EFFECT_KEYS: readonly string[] = ['pool', 'income', 'put', 'remove', 'tag', 'untag', 'mutate', 'far', 'sign', 'arrive', 'unlock', 'law', 'end_run', 'far_all', 'trade', 'stance', 'law_ends', 'poi', 'poi_state', 'say'];
/** (loop round 14, draft 9) the kinds of point of interest (season/pois.ts; the validator imports nothing at run time,
 *  so the vocabulary is here) */
export const POI_KINDS = ['camp', 'lair', 'tower', 'crash', 'battlefield', 'vault', 'temple', 'bridge', 'dungeon', 'giant'] as const;
export type PoiKind = (typeof POI_KINDS)[number];
export const isPoiKind = (k: unknown): k is PoiKind => typeof k === 'string' && (POI_KINDS as readonly string[]).includes(k);
/** (loop round 14, draft 9) a point of interest's states: a card binds to these and sets them (gone: off the map) */
export const POI_BIND_STATES: readonly string[] = ['standing', 'cleared'];
export const POI_SET_STATES: readonly string[] = ['standing', 'cleared', 'gone'];
/** (draft 8) what `met` can name: a faction (its id, or "raiders"), "place:<id>" (a place found or founded), "ending:<word>"
 *  (a run ended so: won, fell, stood, or a pack's own word) */
export const MET_PREFIXES: readonly string[] = ['place:', 'ending:'];
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
  for (const k of ['tags', 'things', 'cards', 'rules', 'events', 'abilities', 'laws', 'factions', 'leaders', 'wants'] as const) if (p[k] !== undefined && !Array.isArray(p[k])) err(k, `"${k}" must be a list.`);
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
  // (draft 7: factions — entities of the world; their ids are also tags: a far town a faction holds carries it, a
  // live event's foes tagged with it are its people; the home town carries "<faction>:<stance>")
  const factions = p.factions ?? [];
  factions.forEach((f, i) => {
    const w = `factions[${i}] (${f.id})`;
    id('faction', f.id, `factions[${i}]`);
    if (!f.name || !f.text) err(w, 'A faction needs a "name" and a "text" the player reads.');
    if (typeof f.kind !== 'string' || !f.kind) err(w, 'A faction needs a "kind": pirates, town, guild, band … (a note for the reader).');
  });
  const factionIds = new Set(factions.map((f) => f.id));
  /** (draft 7) the variables of the card being checked: name → what it binds (site, far, faction) */
  let vars = new Map<string, 'site' | 'far' | 'faction' | 'poi'>();
  const usedVars = new Set<string>();
  /** a `$name` reference: bound by the card, of a kind allowed here */
  const varRef = (ref: string, where: string, kinds: ('site' | 'far' | 'faction' | 'poi')[]): boolean => {
    if (!ref.startsWith('$')) return false;
    const k = vars.get(ref.slice(1));
    usedVars.add(ref.slice(1));
    if (!k) err(where, `"${ref}" is a variable the card does not bind. Add it to the card's "bind", or name a place.`);
    else if (!kinds.includes(k)) err(where, `"${ref}" binds a ${k}; a ${kinds.join(' or ')} is wanted here.`);
    return true;
  };
  /** a faction named in `by`, a stance, a condition: a faction of this pack or a faction variable */
  const faction = (x: unknown, where: string, also: string[] = []): void => {
    const s = String(x);
    if (also.includes(s) || factionIds.has(s)) return;
    if (varRef(s, where, ['faction'])) return;
    err(where, `"${s}" is not a faction of this pack${also.length ? ` or one of ${also.join(', ')}` : ''}. Declare it in "factions".`);
  };
  /** `{name}` in text: a variable of the card (or {other}, the neighbour) */
  const placeholders = (s: string | undefined, where: string): void => {
    for (const m of (s ?? '').matchAll(/\{([a-z][\w-]*)\}/gi)) {
      if (m[1] === 'other') continue;
      usedVars.add(m[1]);
      if (!vars.has(m[1])) err(where, `The text names {${m[1]}}, which the card does not bind. Add it to "bind" or write the name.`);
    }
  };
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
  // (ages: a leader's start puts things in play too)
  for (const l of Array.isArray(p.leaders) ? p.leaders : []) for (const t of l.things ?? []) put.add(t);
  const needTag = (t: string, where: string, how: 'read' | 'made') => {
    // (the record: a ruined thing or place carries what it was as "remains-of-<tag>"; only read, never set)
    const remains = /^remains-of-(.+)$/.exec(t)?.[1];
    if (remains && how === 'read') {
      if (!tagIds.has(remains)) err(where, `"${t}" reads the remains of the tag "${remains}", which is not an existing tag or one of the pack's.`);
      read.add(remains);
      return;
    }
    // (draft 7: a faction's id is the tag of what it holds and of its people; "<faction>:<stance>" is on the home town)
    const fs = /^(.+):(hostile|truce|allied)$/.exec(t);
    if (factionIds.has(t) || (fs && factionIds.has(fs[1]))) {
      if (how === 'made' && fs) err(where, `"${t}" is set by the game from the stance. Use { "stance": "${fs[1]}", "to": "${fs[2]}" }.`);
      return;
    }
    if (!tagIds.has(t)) err(where, `Unknown tag "${t}". Use an existing tag or add it to the pack's "tags" list.`);
    (how === 'read' ? read : produced).add(t);
  };
  const pool = (k: unknown, where: string) => {
    if (typeof k !== 'string' || !POOL_NAMES.includes(k)) err(where, `Unknown pool ${JSON.stringify(k)}. The pools are ${POOL_NAMES.join(', ')}.`);
  };
  // (places: the far places this pack founds can be named by its cards, "far:<id>")
  const founded = new Set(cards.flatMap((c) => [...(c.if_taken ?? []), ...(c.if_expires ?? []), ...Object.values(c.if_tier ?? {}).flat()] as Record<string, unknown>[]).filter((e) => e && (e.far === 'founded' || e.far === 'revealed') && typeof e.id === 'string').map((e) => String(e.id)));
  const place = (ref: string | undefined, where: string, allow: { town?: boolean; far?: boolean; target?: boolean; world?: boolean; site?: boolean } = {}) => {
    if (ref === 'town' && allow.town) return;
    if (ref === 'far:neighbour' && allow.far) return;
    if (ref === 'target' && allow.target) return;
    // (draft 7: a variable of the card — a site where a site goes, a far place where a far place goes)
    if (ref?.startsWith('$')) return void varRef(ref, where, [...(allow.site === false ? [] : ['site' as const]), ...(allow.far ? ['far' as const] : [])]);
    if (ref === 'world') return allow.world ? undefined : err(where, '"world" (every town) is allowed for "mutate" and "sign" only.');
    if (ref?.startsWith('far:')) {
      if (!allow.far) return err(where, `A far place is not allowed here. It is ${JSON.stringify(ref)}.`);
      const st = /^far:where:(.+)$/.exec(ref)?.[1];
      if (ref === 'far:all' || /^far:(nearest|free):[1-9]\d*$/.test(ref) || (st && FAR_SELECT_STATES.includes(st)) || founded.has(ref.slice(4))) return;
      return err(where, `Unknown far place "${ref}". Write "far:neighbour", "far:all", "far:nearest:2", "far:free:1" (the nearest standing towns nobody holds), "far:where:<state>" (${FAR_SELECT_STATES.join(', ')}) or "far:<id>" of a place this pack founds.`);
    }
    if (!siteOf(ref)) err(where, `Unknown place ${JSON.stringify(ref)}. A site is written "site:<name>" with one of: ${SITE_KEYS.join(', ')}.${allow.town ? ' Or "town".' : ''}`);
  };

  // (loop round 14, draft 9: the points of interest a card may name by id — the raiders' camp, and those the pack makes)
  const poiIds = new Set(['raiders-camp', ...cards.flatMap((c) => [...(c.if_taken ?? []), ...(c.if_expires ?? []), ...Object.values(c.if_tier ?? {}).flat()] as Record<string, unknown>[]).filter((e) => e && typeof e.poi === 'string' && typeof e.id === 'string').map((e) => String(e.id))]);
  const poiId = (ref: string, where: string): void => {
    if (!poiIds.has(ref.slice(4))) err(where, `"${ref}" is no point of interest: poi:raiders-camp, or one this pack puts on the map ({ "poi": "<kind>", "id": … }).`);
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
  /** (draft 8) what can be unlocked (locked cards and leaders, the pack if it is locked), and what is */
  const lockable = new Set<string>([...cards.filter((c) => c.locked).map((c) => c.id), ...(Array.isArray(p.leaders) ? p.leaders : []).filter((l) => l.locked).map((l) => l.id), ...(p.pack.locked ? [`pack:${p.pack.id}`] : [])]);
  const unlocks = new Set<string>();
  const effects = (list: PackEffect[] | undefined, where: string, o: { ability?: boolean; between?: boolean } = {}): void => {
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
        // (draft 7: a far town bound to a variable can carry the pack's own tags too)
        if (String(x.on).startsWith('$')) varRef(String(x.on), w, ['site', 'far']);
        else place(String(x.on), w, { town: true, target: o.ability });
      } else if (key === 'mutate') {
        if (!LAND_KINDS.includes(String(x.mutate))) err(w, `Unknown land change "${String(x.mutate)}". The kinds are ${LAND_KINDS.join(', ')}. For a far town use "far".`);
        place(String(x.where), w, { town: true, far: true, world: true });
        produced.add(String(x.mutate));
      } else if (key === 'far') {
        if (!PACK_FAR_KINDS.includes(String(x.far))) err(w, `Unknown change to a far place "${String(x.far)}". The kinds are ${PACK_FAR_KINDS.join(', ')}.`);
        if (x.far === 'founded' || x.far === 'revealed') {
          // (draft 7: founded at a place a card revealed — `where` a far variable bound to a "found" place — or new)
          if (x.far === 'founded' && typeof x.where === 'string') {
            place(x.where, w, { far: true, site: false });
            if (x.id !== undefined || x.name !== undefined) err(w, 'A place founded "where" a found place is takes that place\'s id and name: leave out "id" and "name".');
          } else if (typeof x.id !== 'string' || typeof x.name !== 'string') err(w, `A ${x.far} place needs an "id" and a "name"${x.far === 'founded' ? ', or "where": a variable bound to a found place' : ''}.`);
          else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id)) err(w, `A place's id is lowercase words joined by hyphens. It is ${JSON.stringify(x.id)}.`);
          else if (!x.id.startsWith(`${p.pack.id}-`)) warn(w, `Start the place's id with the pack's id ("${p.pack.id}-…") so two packs never found the same place.`);
          if (x.far === 'revealed' && typeof x.resource !== 'string') err(w, 'A revealed place needs a "resource": a tag (ore, or one of the pack\'s: timber, salt …) that the colony founded there will carry.');
          if (typeof x.resource === 'string') needTag(x.resource, w, 'made');
          if (x.purpose !== undefined && x.purpose !== 'mining') warn(w, `"purpose" is "mining" (a pit is cut beside the camp) or left out. "${String(x.purpose)}" is kept on the map only.`);
        } else place(String(x.where), w, { far: true, site: false });
        if (x.by !== undefined) faction(x.by, w, ['raiders', 'player', 'dead']);
        if (x.far === 'revealed' && x.by !== undefined) err(w, 'Nobody holds a revealed place: leave out "by".');
      } else if (key === 'poi') {
        // (loop round 14, draft 9: a point of interest put on the map near a place)
        if (!isPoiKind(x.poi)) err(w, `Unknown kind of point of interest "${String(x.poi)}". The kinds are ${POI_KINDS.join(', ')}.`);
        if (typeof x.id !== 'string' || typeof x.name !== 'string' || !x.name.trim()) err(w, 'A point of interest needs an "id" and a "name" the player reads on the map.');
        else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id)) err(w, `Its id is lowercase words joined by hyphens. It is ${JSON.stringify(x.id)}.`);
        else if (!x.id.startsWith(`${p.pack.id}-`)) warn(w, `Start its id with the pack's id ("${p.pack.id}-…") so two packs never make the same place.`);
        if (x.near !== undefined) {
          const n = String(x.near);
          if (n.startsWith('poi:')) poiId(n, w);
          else if (n.startsWith('$')) varRef(n, w, ['far', 'poi']);
          else if (n !== 'town') err(w, '"near" is "town" (the default), a far or point-of-interest variable ("$town"), or "poi:<id>".');
        }
        if (x.holder !== undefined) faction(x.holder, w, ['raiders']);
      } else if (key === 'poi_state') {
        if (!POI_SET_STATES.includes(String(x.poi_state))) err(w, `"poi_state" is ${POI_SET_STATES.join(', ')}. It is ${JSON.stringify(x.poi_state)}.`);
        const r = String(x.where ?? '');
        if (r.startsWith('$')) varRef(r, w, ['poi']);
        else if (r.startsWith('poi:')) poiId(r, w);
        else err(w, '"where" is a point-of-interest variable ("$lair") or "poi:<id>" (poi:raiders-camp, or one this pack makes).');
      } else if (key === 'stance') {
        // (draft 7: a stance between a faction and the player, or another faction)
        faction(x.stance, w);
        if (!STANCES.includes(String(x.to)) && x.to !== 'none') err(w, `"to" is ${STANCES.join(', ')} or "none". It is ${JSON.stringify(x.to)}.`);
        if (x.with !== undefined) faction(x.with, w, ['player']);
        if (x.with !== undefined && x.with === x.stance) err(w, 'A faction has no stance towards itself.');
      } else if (key === 'trade') {
        // (trade routes: those towns trade with you, or no longer do)
        place(String(x.trade), w, { far: true, site: false });
        if (x.trade === 'far:where:trade-partner' && !x.end) err(w, 'Every trade partner already trades with you. Name other towns, or add "end": true.');
        if (x.end !== undefined && typeof x.end !== 'boolean') err(w, '"end" is true or left out.');
      } else if (key === 'sign') {
        if (!SIGN_KINDS.includes(String(x.sign))) err(w, `Unknown sign "${String(x.sign)}". The signs are ${SIGN_KINDS.join(', ')}.`);
        if (x.where !== undefined) place(String(x.where), w, { town: true, far: true, world: true });
        if (x.strength !== undefined && (typeof x.strength !== 'number' || x.strength < 0 || x.strength > 1)) err(w, '"strength" is a number from 0 (off) to 1.');
        // (draft 8: a sign fades between runs unless it is set for good)
        if (x.for_good !== undefined && x.for_good !== true) err(w, '"for_good" is true or left out.');
        if (x.for_good && x.seasons !== undefined) err(w, 'A sign "for_good" has no "seasons": it stays in every later run. Leave one of them out.');
      } else if (key === 'law_ends') {
        // (draft 8: between runs only — a law a card's laws_after left stops standing)
        if (!o.between) err(w, '"law_ends" is for "between_runs" only: during a run a law ends with its source.');
        if (!laws.some((l) => l.id === x.law_ends)) err(w, `"law_ends" names the law "${String(x.law_ends)}", which is not in the pack's "laws".`);
        else if (!cards.some((c) => c.laws_after?.includes(String(x.law_ends)))) warn(w, `No card leaves the law "${String(x.law_ends)}" for later runs ("laws_after"), so there is nothing for this to end.`);
      } else if (key === 'arrive') {
        if (x.arrive !== 'refugees') err(w, `"arrive": "${String(x.arrive)}" is not supported yet. Only "refugees" arrive today.`);
        else if (x.from !== 'far:neighbour') err(w, 'Refugees can only come "from": "far:neighbour" today.');
        else if (x.count !== undefined && x.count !== 40) err(w, `The engine brings 40 refugees each time. Write "count": 40 or leave it out. It is ${JSON.stringify(x.count)}.`);
      } else if (key === 'unlock') {
        // (an ability: the player's for this run. Draft 8: locked content — a card, a leader, the whole pack — opened for
        // this run and every later run of the world: a line in the record)
        const u = String(x.unlock);
        if (u !== 'heat-ray' && !abilities.some((a) => a.id === u) && !lockable.has(u)) err(w, `"unlock" names "${u}". It can be an ability of this pack, "heat-ray", or locked content of this pack: a card or leader with "locked": true, or "pack:${p.pack.id}" if the pack is locked.`);
        unlocks.add(u);
      } else if (key === 'end_run') {
        // (endings: an instant win or loss, or an ending of the pack's own naming)
        if (typeof x.end_run !== 'string' || !x.end_run) err(w, '"end_run" is "won", "fell", or a word of your own for the ending.');
        if (typeof x.name !== 'string' || !x.name.trim()) err(w, 'An ending needs a "name": what the run-end screen says ended it.');
      } else if (key === 'far_all') {
        if (!['captured', 'destroyed', 'abandoned'].includes(String(x.far_all))) err(w, '"far_all" is captured, destroyed or abandoned: what happens to every far town.');
        if (x.by !== undefined) faction(x.by, w, ['raiders', 'player', 'dead']);
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
        // (draft 7: done about this place or faction — a variable of the card, or a place the pack founds)
        if (x.about !== undefined && !varRef(String(x.about), w, ['site', 'far', 'faction']) && !founded.has(String(x.about).replace(/^far:/, ''))) err(w, '"about" is a variable of the card ("$town") or "far:<id>" of a place this pack founds or reveals.');
      } else if (key === 'leader') {
        if (!LEADER_IDS.includes(String(x.leader))) err(w, `Unknown leader "${String(x.leader)}". The leaders are ${LEADER_IDS.join(', ')}.`);
      } else if (key === 'faction_holds') {
        faction(x.faction_holds, w, ['player']);
        if (x.gte !== undefined && (!Number.isInteger(x.gte) || Number(x.gte) < 0)) err(w, '"gte" is a whole number, 0 or more.');
        if (x.lte !== undefined && (!Number.isInteger(x.lte) || Number(x.lte) < 0)) err(w, '"lte" is a whole number, 0 or more.');
      } else if (key === 'faction_stance') {
        faction(x.faction_stance, w);
        if (!Array.isArray(x.is) || !x.is.length) err(w, `"is" is a list of stances: ${STANCES.join(', ')}, "none".`);
        else for (const s of x.is as string[]) if (!STANCES.includes(s) && s !== 'none') err(w, `Unknown stance "${s}". The stances are ${STANCES.join(', ')}, "none".`);
        if (x.with !== undefined) faction(x.with, w, ['player']);
      } else if (key === 'met') {
        // (draft 8: the record knows it — a faction met, a place found or founded, an ending reached)
        const m = String(x.met);
        if (m.startsWith('place:') || m.startsWith('ending:')) {
          if (m.split(':')[1] === '') err(w, `"met" needs a name after "${m}".`);
        } else faction(m, w, ['raiders']);
      }
    });
  };
  conds(p.pack.appears_when, 'pack.appears_when');

  // ---- cards ----
  // (draft 7: what the pack's effects make — a faction that comes to hold a town, a place revealed — so a variable
  // that waits for one can be told apart from one that can never match)
  const allFx = JSON.stringify([cards.map((c) => [c.if_taken, c.if_expires, c.if_tier]), abilities.map((a) => a.effect)]);
  cards.forEach((c, i) => {
    const w = `cards[${i}] (${c.id})`;
    vars = new Map();
    usedVars.clear();
    if (c.bind !== undefined) {
      if (!isObj(c.bind)) err(`${w}.bind`, '"bind" is { "name": { "site": … } | { "far": … } | { "faction": … } }.');
      else
        for (const [v, spec] of Object.entries(c.bind)) {
          const bw = `${w}.bind.${v}`;
          if (!/^[a-z][a-z0-9]*$/.test(v) || v === 'other') err(bw, `A variable's name is one lowercase word other than "other" ("place", "town", "port", "foe"). It is "${v}".`);
          const s = spec as Record<string, unknown>;
          const kind = (['site', 'far', 'faction', 'poi'] as const).find((k) => isObj(s?.[k]));
          if (!kind) {
            err(bw, 'A variable binds { "site": { "tags": [...] } }, { "far": { "state": [...], "tags": [...], "holder": "<faction>" } }, { "faction": { "stance": [...] } } or { "poi": { "kind": [...], "state": [...] } }.');
            continue;
          }
          vars.set(v, kind);
          const q = s[kind] as Record<string, unknown>;
          if (s.set_off !== undefined && s.set_off !== true) err(bw, '"set_off" is true or left out.');
          for (const t of [...((q.tags as string[] | undefined) ?? []), ...((q.not as string[] | undefined) ?? [])]) needTag(t, bw, 'read');
          if (kind === 'site') {
            const all = (q.tags as string[] | undefined) ?? [];
            if (!all.length) warn(bw, 'A site variable with no tags binds any of the 20 sites.');
          } else if (kind === 'far') {
            for (const st of (q.state as string[] | undefined) ?? []) if (!BIND_FAR_STATES.includes(st)) err(bw, `Unknown state "${st}". The states are ${BIND_FAR_STATES.join(', ')}.`);
            if (q.holder !== undefined) faction(q.holder, bw, ['player']);
            // (never matches in a world this pack alone makes: a holder nothing makes hold a town, a found place
            // nothing reveals — a LOOK: another pack, or an earlier run, may)
            if (typeof q.holder === 'string' && factionIds.has(q.holder) && !allFx.includes(`"by":"${q.holder}"`)) warn(bw, `No effect of this pack makes ${q.holder} hold a town, so this binds nothing unless another pack or an earlier run does.`);
            if (((q.state as string[] | undefined) ?? []).includes('found') && !allFx.includes('"far":"revealed"')) warn(bw, 'No effect of this pack reveals a place, so a "found" place binds nothing unless another pack or an earlier run reveals one.');
          } else if (kind === 'poi') {
            // (loop round 14, draft 9: a point of interest on the map)
            for (const k of (q.kind as string[] | undefined) ?? []) if (!isPoiKind(k)) err(bw, `Unknown kind of point of interest "${k}". The kinds are ${POI_KINDS.join(', ')}.`);
            for (const st of (q.state as string[] | undefined) ?? []) if (!POI_BIND_STATES.includes(st)) err(bw, `Unknown state "${st}". A point of interest is ${POI_BIND_STATES.join(' or ')}.`);
            if (q.holder !== undefined) faction(q.holder, bw, ['raiders']);
            const kinds = (q.kind as string[] | undefined) ?? [];
            if (kinds.length && !kinds.includes('camp') && !kinds.some((k) => allFx.includes(`"poi":"${k}"`))) warn(bw, `No effect of this pack puts a ${kinds.join(' or ')} on the map, so this binds nothing unless another pack or an earlier run does.`);
          } else {
            for (const st of (q.stance as string[] | undefined) ?? []) if (!STANCES.includes(st) && st !== 'none') err(bw, `Unknown stance "${st}". The stances are ${STANCES.join(', ')}, "none".`);
            if (q.with !== undefined) faction(q.with, bw, ['player']);
            if (!factions.length) err(bw, 'The pack declares no factions for this variable to bind.');
          }
        }
    }
    placeholders(c.title, `${w}.title`);
    placeholders(c.pitch, `${w}.pitch`);
    for (const list of [c.if_taken, c.if_expires, ...Object.values(c.if_tier ?? {})]) for (const e of list ?? []) if (isObj(e) && typeof (e as { say?: unknown }).say === 'string') placeholders((e as { say: string }).say, `${w} say`);
    if (c.once !== undefined && typeof c.once !== 'boolean' && c.once !== 'run') err(w, '"once" is true (once for each binding), "run" (once a run, whatever it binds) or false (it comes back).');
    if (c.locked !== undefined && typeof c.locked !== 'boolean') err(w, '"locked" is true or left out.');
    if (!isObj(c.presenter) || !c.presenter.role) err(w, 'A card needs a "presenter" with a "role" (a trade, such as "miller") and an "at".');
    else if (c.presenter.at?.startsWith('$')) varRef(c.presenter.at, `${w}.presenter.at`, ['site']);
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
    for (const v of vars.keys()) if (!usedVars.has(v) && !(c.presenter?.at === `$${v}`)) warn(`${w}.bind.${v}`, `The variable "${v}" is bound but nothing uses it: the card would be offered once for each place it fits, all alike.`);
  });
  vars = new Map();

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
      if (a === 'burned' && e.hazard?.kind !== 'fire') err(w, 'The amount "burned" needs a "hazard" of kind "fire".');
      if (a === 'reached' && !['lava', 'flood'].includes(e.hazard?.kind ?? '')) err(w, 'The amount "reached" needs a "hazard" of kind "lava" or "flood".');
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
    if (e.hazard && !HAZARD_KINDS.includes(e.hazard.kind)) err(w, `The hazard "${e.hazard.kind}" is not supported yet. The hazards are ${HAZARD_KINDS.join(', ')}.`);
    if (e.hazard && (!Number.isInteger(e.hazard.points) || e.hazard.points < 1)) err(w, 'A hazard\'s "points" is a whole number, 1 or more.');
    if (e.hazard && (e.hazard.kind === 'lava' || e.hazard.kind === 'flood')) {
      const far = e.hazard.far ?? FRONT_DEFAULTS.far;
      if (!(far > e.hazard.spread)) err(w, `The ${e.hazard.kind}'s source ("far", ${far} paces out) must lie past its points ("spread", ${e.hazard.spread}).`);
      for (const k of ['rate', 'pour'] as const) if (e.hazard[k] !== undefined && !(e.hazard[k]! > 0)) err(w, `A hazard's "${k}" is a number above 0.`);
      if (!amounts.has('reached')) warn(w, `A ${e.hazard.kind} event's result is how many of its points it reached: list the amount "reached".`);
    }
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
      const n = [ie.kills, ie.douses, ie.berserk, ie.hides, ie.shield].filter((x) => x !== undefined);
      if (n.length !== 1 || !Number.isInteger(n[0]) || n[0]! < 1) err(w, '"in_event" needs exactly one of "kills" (foes put down by a cast), "douses" (burning lots put out), "berserk" (the foes within so many paces of the tap turn on anyone near, one another too), "hides" (your people within so many paces are hidden: no foe goes for them) or "shield" (a shield so many paces wide round the tap: lava and flood water flow round it), a whole number, 1 or more.');
      if (ie.seconds !== undefined && (ie.shield === undefined || !Number.isInteger(ie.seconds) || ie.seconds < 1)) err(w, '"seconds" goes with "shield" only: how long the shield stands, a whole number, 1 or more.');
      if ((ie.shield ?? 0) > 60) warn(w, 'A shield more than 60 paces wide covers the whole town and more.');
      // (loop round 14: the shield's energy and recharge)
      if (ie.energy !== undefined && (ie.shield === undefined || typeof ie.energy !== 'number' || !(ie.energy > 0))) err(w, '"energy" goes with "shield" only: the shield\'s store, a number over 0. What presses on it (lava, fire, foes at its rim) drains it; empty, it gives way.');
      if (ie.regen !== undefined && (ie.shield === undefined || typeof ie.regen !== 'number' || !(ie.regen >= 0))) err(w, '"regen" goes with "shield" only: the energy it gets back a second, 0 or more.');
      if ((ie.kills ?? 0) > 3 || (ie.douses ?? 0) > 3) warn(w, 'One cast does more than 3. Heat ray, the strongest spell of the base game, does 2.');
      if ((ie.berserk ?? 0) > 20 || (ie.hides ?? 0) > 20) warn(w, 'One cast reaches more than 20 paces: the whole fight at once.');
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
  // (draft 7: a variable bound to what set the card off needs a rule that offers or starts the card)
  for (const c of cards)
    for (const [v, s] of Object.entries(c.bind ?? {}))
      if (isObj(s) && s.set_off === true && !rules.some((r) => { const a = actOf(r); return !!a && (a.kind === 'offer' || a.kind === 'start') && a.id === c.id; })) warn(`cards (${c.id}).bind.${v}`, '"set_off": no rule of this pack offers or starts this card, so nothing sets it off. Fine only if a pack loaded with it does.');

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
  for (const c of cards) {
    for (const t of c.laws_after_if ?? []) if (!TIERS.includes(t) && t !== 'lapsed') err(`cards (${c.id}).laws_after_if`, `"laws_after_if" lists results (${TIERS.join(', ')}) or "lapsed". It has "${t}".`);
    if (c.laws_after_if?.length && !c.laws_after?.length) err(`cards (${c.id}).laws_after_if`, '"laws_after_if" goes with "laws_after".');
  }
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
      // (CT-37: the two shapes that pass here and break the rule book at run time, for a rule of this pack)
      const target = rules.find((r) => r.id === d.rule);
      if (target) lawRuleShape(d, target).forEach((x) => err(w, x));
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

  // ---- (ages) leaders ----
  (p.leaders ?? []).forEach((l, i) => {
    const w = `leaders[${i}] (${l.id})`;
    id('leader', l.id, `leaders[${i}]`);
    if (LEADER_IDS.includes(l.id)) err(w, `"${l.id}" is a leader of the base game already.`);
    if (!l.name || !l.line) err(w, 'A leader needs a "name" and a "line": who they are, in one plain sentence.');
    for (const [k, n] of Object.entries(l.pools ?? {})) (pool(k, w), (!Number.isInteger(n) || n < 0) && err(w, `A starting pool is a whole number, 0 or more. ${k} is ${JSON.stringify(n)}.`));
    if (!isObj(l.pools)) err(w, 'A leader needs "pools": what the run starts with.');
    for (const [k, n] of Object.entries(l.income ?? {})) (GOODS.includes(k) || err(w, `Income is of ${GOODS.join(', ')}.`), (!Number.isInteger(n) || n < 0) && err(w, `Income is a whole number. ${k} is ${JSON.stringify(n)}.`));
    for (const t of l.things ?? []) {
      if (!thingIds.has(t)) err(w, `"things" names "${t}", which is not in the pack's "things".`);
      put.add(t);
    }
    for (const x of l.laws ?? []) needLaw(x, w);
    if (l.deck_out !== undefined && (!isObj(l.deck_out) || (!Array.isArray(l.deck_out.ids) && !Array.isArray(l.deck_out.themes)))) err(w, '"deck_out" is { "themes": ["build"] } or { "ids": [...] }: cards out of the deck for this leader\'s runs.');
    for (const c of (l.appears_when ?? []) as Record<string, unknown>[]) {
      const k = Object.keys(c).find((x) => COND_KEYS.includes(x));
      if (!k || !LEADER_COND_KEYS.includes(k)) err(w, `A leader's "appears_when" is read before the run, on the world: it may use ${LEADER_COND_KEYS.join(', ')}. It has ${JSON.stringify(c)}.`);
    }
    conds(l.appears_when, `${w}.appears_when`);
    if (l.replaces && !l.appears_when?.length && !l.home) err(w, 'A leader that replaces the base leaders needs an "appears_when": otherwise the base leaders are never offered.');
    // (draft 8: a leader who starts in a far town — the first that fits)
    if (l.home !== undefined) {
      const f = isObj(l.home) && isObj(l.home.far) ? (l.home.far as Record<string, unknown>) : null;
      if (!f) err(w, '"home" is { "far": { "state": [...], "tags": [...], "not": [...], "holder": "player" } }: the far town the run is played from.');
      else {
        for (const st of (f.state as string[] | undefined) ?? []) if (!FAR_STATES.includes(st)) err(w, `Unknown state "${st}" for "home". The states are ${FAR_STATES.join(', ')}.`);
        for (const t of [...((f.tags as string[] | undefined) ?? []), ...((f.not as string[] | undefined) ?? [])]) needTag(t, w, 'read');
        if (f.holder !== undefined) faction(f.holder, w, ['player']);
      }
    }
    if (l.locked !== undefined && typeof l.locked !== 'boolean') err(w, '"locked" is true or left out.');
  });

  // ---- (draft 8) between runs ----
  if (p.between_runs !== undefined && !Array.isArray(p.between_runs)) err('between_runs', '"between_runs" must be a list.');
  (Array.isArray(p.between_runs) ? p.between_runs : []).forEach((b, i) => {
    const w = `between_runs[${i}] (${b.id})`;
    id('between', b.id, `between_runs[${i}]`);
    if (typeof b.say !== 'string' || !b.say.trim()) err(w, 'A between-runs entry needs a "say": the line the next run reads ("While you were gone: …").');
    if (!Array.isArray(b.do) || !b.do.length) err(w, 'A between-runs entry needs "do": its effects.');
    conds(b.when, `${w}.when`);
    for (const c of (b.when ?? []) as Record<string, unknown>[]) if ('season_gte' in c || 'pool' in c || 'leader' in c) err(w, `Between runs there is no season, pool or leader to read. It has ${JSON.stringify(c)}.`);
    vars = new Map();
    effects(b.do, `${w}.do`, { between: true });
    for (const e of (b.do ?? []) as Record<string, unknown>[]) if (['pool', 'income', 'put', 'remove', 'tag', 'untag', 'law', 'end_run', 'arrive', 'say'].some((k) => k in e)) err(w, `Between runs there is no run to change: use the world's words (far, far_all, mutate, sign, stance, trade, unlock, law_ends). It has ${JSON.stringify(e)}.`);
  });

  // ---- (loop round 13) the weather of seasons of the run ----
  if (p.weather !== undefined && !Array.isArray(p.weather)) err('weather', '"weather" must be a list, like [ { "from": 10, "weather": "ashfall" } ].');
  (Array.isArray(p.weather) ? p.weather : []).forEach((x, i) => {
    const w = `weather[${i}]`;
    const o = x as unknown as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['season', 'from', 'to', 'weather'].includes(k)) err(w, `"${k}" is not a word of a weather entry. Use "season", or "from" and "to", and "weather".`);
    if (!WEATHER_NAMES.includes(String(o.weather))) err(w, `Unknown weather "${String(o.weather)}". The weathers are ${WEATHER_NAMES.join(', ')}.`);
    const num = (k: string) => o[k] === undefined || (Number.isInteger(o[k]) && (o[k] as number) >= 1 && (o[k] as number) <= 16);
    for (const k of ['season', 'from', 'to']) if (!num(k)) err(w, `"${k}" is a season of the run, 1 to 16.`);
    if (o.season !== undefined && (o.from !== undefined || o.to !== undefined)) err(w, 'Give "season" (one season) or "from" and "to", not both.');
    if (o.season === undefined && o.from === undefined && o.to === undefined) err(w, 'Say which seasons: "season", or "from" (and "to").');
    if (typeof o.from === 'number' && typeof o.to === 'number' && o.to < o.from) err(w, '"to" comes before "from".');
  });

  // ---- (draft 8) locked content: what can be unlocked, and a hint for it ----
  for (const c of cards) if (c.hint !== undefined && !c.locked) warn(`cards (${c.id})`, '"hint" is shown only for a locked card.');
  for (const x of lockable) {
    if (!unlocks.has(x)) warn(`locked (${x})`, `Nothing unlocks "${x}": no effect of this pack says { "unlock": "${x}" }. It can never be found unless another pack unlocks it.`);
    const hint = x.startsWith('pack:') ? p.pack.hint : (cards.find((c) => c.id === x)?.hint ?? (p.leaders ?? []).find((l) => l.id === x)?.hint);
    if (!hint) warn(`locked (${x})`, 'Give it a "hint": the line "Not yet found" shows the player.');
  }

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

/**
 * (CT-37) What a rule law would break in the rule it changes: `times` or `set` numbers on a rule that acts (an act has
 * no number to multiply), and `on` moved to a live event's result on a rule that changes an amount (a result comes
 * after the amounts are read). Empty: it is fine.
 */
export function lawRuleShape(d: Record<string, unknown>, r: PackRule): string[] {
  const out: string[] = [];
  const fx = (isObj(r.effect) ? r.effect : {}) as Record<string, unknown>;
  const acts = ['offer', 'start', 'tag', 'untag', 'law', 'end_run'].some((k) => k in fx);
  if (acts && (d.times !== undefined || (isObj(d.set) && ('n' in d.set || 'cap' in d.set)))) out.push(`The rule "${r.id}" acts (it ${Object.keys(fx)[0]}s); it has no number for "times" or "set" to change. Use "fires" to make it act more often.`);
  const on = d.on as { tier?: unknown } | undefined;
  if ('amount' in fx && isObj(on) && on.tier !== undefined) out.push(`The rule "${r.id}" changes the amount "${String(fx.amount)}"; a rule that waits for a result ("tier") comes after the amounts are read and cannot change one.`);
  return out;
}

/** what the base game records in the world's history that a rule `on: { "event": name }` can wait for (the events its
 *  cards write: season/realm-templates.ts, realm-events.ts, realm.ts; draft 8: the raiders are cards, no arc — the
 *  old arc's `farm-burned` is gone, `raiders-march` is the standing threat's lapse) */
export const BASE_EVENT_KINDS: readonly string[] = [
  'built', 'made-safe', 'scouts-seen', 'raiders-march', 'tribute-paid', 'raid-held', 'raid-broke', 'raid-missed', 'lens-lit', 'camp-opened', 'camp-held', 'camp-lost',
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
      // (CT-37: a law on another pack's rule, in a shape that would break it)
      const other = packs.filter((q) => q !== p).flatMap((q) => q.rules ?? []).find((r) => r.id === l.does.rule);
      if (other) for (const x of lawRuleShape(l.does, other)) err(`${name(p)} law (${l.id})`, x);
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
    // (draft 7: a place revealed or founded for a resource carries that tag)
    if (typeof x.far === 'string' && typeof x.resource === 'string') made.add(x.resource);
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
