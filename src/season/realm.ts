// (loop-skeleton round 2; docs/design/LOOP_SKELETON.md "Conformance") The realm: a home-town run on the existing
// engine. It joins the living engine (living/engine.ts: templates over the fact world, the one dealer, the one
// contract) to the season ledger (season/ledger.ts: the pools, the projects the season loop builds). It replaces round
// 1's run record, its deck and hand, its effects and its world record:
//   - what is offered: `LivingEngine.deal` (the dealer deals few, by its own tuning; nothing here caps a hand);
//   - committing: `LivingEngine.commit` on the one Holdings record, which is the ledger's (people locked, goods spent);
//     a town project is then adopted by the ledger so the season builds it;
//   - a season: `LivingEngine.advance` (commitments due resolve into the fact layer, offers past their time fire their
//     expiry, the run's arc moves on), then the ledger's own season (income, stages) — the caller runs that between
//     `endSeason` and `afterSeason`, since the season loop owns it;
//   - the world's record: the fact layer (entities, relations, claims, the event history) in the WorldState, saved
//     whole (`snapshot`) and read by the next run;
//   - what the land and the lots show of it: the mutators (mutate/index.ts). A template's outcome names them — `mutate`
//     and `sign` (mutate/outcomes.ts) for a whole place, `mutateAt` and `found` here for a part of the home town or a
//     new place — and each entry carries the id of the fact event that says what happened. With no world bound to the
//     mutators (a test, the inspector) the facts alone change.
// The run's own state (its length, the spells unlocked, the raid due, the fight) is small and kept here; each change is
// also an event in the history. Pure: no DOM, no GPU, no clock.
import type { EntityId, FactEvent } from '../api/contracts/facts';
import type { WorldSnapshot } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import { HELPERS, text, type Ctx, type Helper, type Stage } from '../living/dsl';
import { LivingEngine, outcomesOf, type EngineReport, type Offer, type TemplateDef, type EngineState } from '../living/engine';
import { idleState, liveDerive, liveNames, liveRead, liveTier, type LiveDef, type LiveFront, type LiveState, type LiveVars } from '../living/live';
import { RuleBook, type RuleAct, type RuleDef, type RuleHit, type RuleOccasion, type RuleState, type Thing } from '../living/rules';
import { applyTags, boardDelta, cardTerms, deriveRules, lawIncome, liveLaw, poolsAs, raidersOf, resultAlso, shiftTier, spared, spellAlso, spellMech, stayOf, wonBy, type ActiveLaw, type CardTerms, type DerivedRules, type LawDef, type LawSource, type Mech } from '../living/laws';
import { liveWhat } from './live-words';
import type { Tier } from '../api/contracts/opportunity';
import { seedLocus } from '../living/seed';
import { FactWorld } from '../living/world';
import { OPP_TUNE, type DealerTune } from '../opps/tune';
import { CATALOG, card } from './catalog';
import { hasLand, type Land } from './deal';
import { adopt, lose, grant, pools, total, POOL_ROLE, type Pool, type Pools, type SeasonLedger } from './ledger';
import { cardOfTemplate, projectTemplate, RAIDERS, RAIDERS_CAMP, siteId, SITES, WORLD_TEMPLATES, type SiteKey } from './realm-templates';
import { BASE_BETWEEN, BETWEEN, LAW_ENDED, type BetweenDef } from './realm-between';
import { holds } from '../living/dsl';
import { applyBatch } from '../living/engine';
import { setStance, stanceOf, type Stance } from '../living/stance';
import { recordSign } from '../mutate/facts';
import { SIGNS } from '../mutate';
import { RUIN, RULES, SITE_TAGS, TIMED } from './realm-rules';
import { FIRE_TEMPLATE } from './realm-events';
import { placeState } from '../mutate/facts';
import { military, SQUAD } from './war';
import { mutators, type Mutation, type PhysicalKind } from '../mutate';
import { recordMutation } from '../mutate/facts';
import '../mutate/outcomes';
import { ROW_H } from '../world/lattice';

/** the run's length in seasons: the run ends when its last season ends (or at once, by an `end_run`). A knob, in this
 *  one place; 16 is the orchestrator's number, not the user's */
export const RUN_SEASONS = 16;
/** the projects and ventures on offer at once (the dealer's resource limit, counted over what still stands). With the
 *  dealer's one guarantee (a card that answers the run's threat) and the one threatening card a season's schedule lets
 *  stand, a season asks at most BOARD + 2 things of the player, however long the run or large the holdings — and the
 *  raiders' standing threat (draft 8, a card over the whole town from a fifth of the run on): BOARD + 3 */
export const BOARD = 3;

/** 'heatray': unlocked by the tower's lens, cast in a fight. The three every leader has: 'fire' (cast in a live event:
 *  it sets what will burn alight and burns the dead), 'rain' (a storm over the tap: it puts a fire out), 'growth' (a
 *  rune over a field, any season: the plants there grow and the field is 'growth-active' until the season ends) */
export type SpellId = 'heatray' | 'fire' | 'rain' | 'growth';
export const BASIC_SPELLS: readonly SpellId[] = ['fire', 'rain', 'growth'];
/** what a cast costs in Magic (a tunable: BACKLOG LS-66) */
export const SPELL_COST: Record<SpellId, number> = { heatray: 1, fire: 1, rain: 1, growth: 1 };
/** (draft 8) a sign set for good carries this tag beside it (`ashfall:for-good`): it does not fade between runs */
export const FOR_GOOD = ':for-good';
/** the ending of a run that reached its last season with nothing else ending it */
export const STOOD = 'The town stands';
/** far towns that count as trade partners once the trade route is built: the nearest so many */
export const PARTNERS = 3;
/** the refugees' camp (by the east fields since round 7), as a thing of the fact world */
export const campId = (home: string): string => `camp:${home}`;
/** (loop round 7, LS-67) how far out from its site the refugees' tents stand (world units): a first guess, tunable */
const CAMP_OUT = 20;
/** (loop round 12) the land changed round each point a front reached on its way to the town (cells) */
const FRONT_WAY_R = 5;
/** (loop round 12) the fact event a front's end records on the home town (its note: liquid, points reached, a path) */
export const FRONT_EVENT = 'front-ended';
/** (loop round 7, LS-67) the site the refugees camp by: the east fields (open, dry; the reeve puts them to work there) */
const CAMP_SITE: SiteKey = 'fields';

/** a live event as the scene tells it: its state, where it was (world cells [x, row]), the way its marchers took, and
 *  the hazard's points that burned */
export interface LiveTold {
  state: LiveState;
  at?: readonly [number, number];
  route?: readonly [readonly [number, number], readonly [number, number]];
  burned?: readonly (readonly [number, number])[];
  /** (loop round 12) a front's points reached along its way, outside the town (world cells) */
  path?: readonly (readonly [number, number])[];
}
/** how a live event came out: its tier, its numbers, and what to tell the player (the outcome's line, then a line a
 *  rule that fired: what, how much, why) */
export interface LiveReport {
  id: string;
  template: string;
  title: string;
  tier: Tier;
  vars: LiveVars;
  lines: string[];
  hits: RuleHit[];
}

export interface Leader {
  id: string;
  name: string;
  line: string;
  pools: Partial<Pools>;
  income: Partial<Pools>;
}

/** a spot a land change can be put that is no site of the town: the hills a camp is founded in, the mountain that
 *  breaks */
export type Spot = SiteKey | 'hills' | 'mountain';

/** the raiders as an entity of the fact world (who holds a town they took) */
export const RAIDERS_ID = 'raiders';
/** people a fallen town's refugees add to the streets, the carts they come with (that season), a camp's ore wagons */
export const REFUGEES = 40;
export const ARRIVAL_CARTS = 10;
export const CAMP_WAGONS = 14;
/** the mining camp the run can found */
export const CAMP_ID = 'copper-hollow';

export interface RealmOptions {
  /** the world as saved, or the atlas's own (never changed: restored into a new WorldState) */
  world: WorldSnapshot;
  /** the home town's settlement id. FIXED-CITY (BACKLOG LS-40): one settlement for the whole run — its sites are the
   *  cards' locations, its ledger the run's pools, its gate what the raid breaks; a run that follows a moving group
   *  needs a locus that can change (LIVING_WORLD's "locus"), with the sites and the ledger following it */
  home: EntityId;
  seed: number;
  leader: Leader;
  /** the ledger this run starts with (the leader's pools; what earlier runs built) */
  ledger: SeasonLedger;
  /** the town's land for district cards (the season loop's), read when a deal asks */
  land: () => Land;
  /** the run's length in seasons (default RUN_SEASONS) */
  seasons?: number;
  /** where a site of the home town (or a spot out of it) is, in world cells [x, row]: the scene's, from the town as it
   *  is laid out. Absent (a test): the town's own centre, the hills and the mountain a fixed way off it */
  where?: (spot: Spot) => readonly [number, number] | null;
  /** the region of a world point (x cells, y world units): a founded place's */
  regionAt?: (x: number, y: number) => number;
  tune?: () => DealerTune;
  /** a run under way taken up again (`Realm.runState`), over the world saved with it: no new run begins, nothing is
   *  dealt, the ledger given is the one saved */
  resume?: RunState;
  /** (card-table, packs/load.ts) more opportunities than the base game's, the helpers their conditions and effects
   *  name, more synergy rules, and more things in play (with their tags) for the rules to read: an outside-authored
   *  pack, loaded. A helper here never replaces one of the realm's own. `things` is given the realm's own list and
   *  returns the whole list (a pack's things added, their tags lent to the place they stand at) */
  extra?: {
    templates?: TemplateDef[];
    helpers?: Record<string, Helper>;
    rules?: RuleDef[];
    things?: (base: Thing[]) => Thing[];
    /** (laws: docs/design/LAWS.md) the laws that can come into force, and the things in play that carry laws (each
     *  thing's id as `things()` gives it, its name, the laws it carries) */
    laws?: LawDef[];
    lawThings?: () => { id: string; name: string; laws: string[] }[];
    /** (the record) the laws a card leaves: in force from the first season of every later run of the world it was done
     *  in (a pack card's `laws_after`) */
    recordLaws?: { card: string; laws: string[]; results?: string[] }[];
    /** (trade routes) place selectors of things in play that carry a trade route: those towns are trade partners */
    tradeThings?: () => string[];
    /** (draft 7) entities the packs add to the world before the first deal (their factions) */
    seed?: (w: FactWorld) => void;
    /** (ages) cards out of this run's deck: by id, or every card with one of these themes (the raid stays) */
    deckOut?: { ids?: string[]; themes?: string[] };
    /** (draft 8) the packs' between-runs entries, applied after the base game's (realm-between.ts) */
    between?: BetweenDef[];
  };
  /** (card-table, tuning) raiders in the run's last stage (default realm-templates.ts RAIDERS) */
  raiders?: number;
  /** (card-table) told each time synergy rules fire, with the firings (a front end's log of what, how much, why) */
  onRules?: (hits: RuleHit[]) => void;
  /** deal the live fire at the market in place of the instant `fire-wards` hazard (off: BACKLOG LS-63) */
  liveFire?: boolean;
}

/** a run under way, as saved beside the world (BACKLOG LS-8): the realm's own small state and the engine's */
export interface RunState {
  v: 1;
  leader: string;
  seasons: number;
  /** the history's turn before the run's first season */
  t0: number;
  spells: SpellId[];
  raid: number | null;
  fight: Realm['fight'];
  /** each land change's place in the player's words (a mutation's id → "the old dam") */
  where: [string, string][];
  engine: EngineState;
  /** (round 6) the synergy rules' firings this season, and the history's events they have seen */
  rules?: RuleState;
  seen?: number;
  /** the trade partners standing when the season began (the news says when one is gone) */
  partners?: number;
  /** (chains) the cards a rule has asked for that are not yet done: card → the rule's name */
  asked?: [string, string][];
  /** (draft 7) what each asking rule matched */
  askedOn?: [string, string[]][];
  /** (laws) the laws in force, in the order they came into force, and the last order number given */
  laws?: ActiveLaw[];
  lawSeq?: number;
  /** (endings) the run was ended by an effect, a rule or a law */
  ended?: Realm['ended'];
}

/** the risen dead as an entity of the fact world (who holds the towns they took) */
export const DEAD_ID = 'the-dead';

/**
 * (the world's memory; the owner: "Just keep the history of resolved cards.") The record of every card that resolved
 * or ran out, in every run: one fact event a card, `card-done:<tier>` or `card-lapsed`, `to: [its place, the home
 * town]`, `about.thing`: the card's template, the note its title. The fact layer's events are saved with the world, so
 * the record outlives the run; a run's number and leader are read from the `run-began` events before it. What a card
 * put in play stays as a thing of the world (standing, or ruined with its old tags as `remains-of-<tag>`).
 */
export const CARD_DONE = 'card-done:';
export const CARD_LAPSED = 'card-lapsed';
export interface RecordEntry {
  card: string;
  title: string;
  /** a tier, or 'lapsed' */
  result: string;
  place: string;
  /** (draft 7) the home town and what the card's variables were bound to */
  about: string[];
  turn: number;
  run: number;
  leader: string;
}
/** the record of resolved and lapsed cards, oldest first */
export function recordOf(w: FactWorld): RecordEntry[] {
  const runs = w.facts.events({ kind: 'run-began' });
  return w.facts
    .events()
    .filter((e) => (e.kind.startsWith(CARD_DONE) || e.kind === CARD_LAPSED) && !!e.about?.thing)
    .map((e) => {
      const began = runs.filter((r) => r.turn <= e.turn);
      return { card: e.about!.thing!, title: e.note, result: e.kind === CARD_LAPSED ? 'lapsed' : e.kind.slice(CARD_DONE.length), place: e.to[0] ?? '', about: e.to.slice(1), turn: e.turn, run: began.length, leader: (began.at(-1)?.note ?? '').replace(/ took the town$/, '') };
    });
}

export class Realm {
  readonly ws: MemoryWorldState;
  readonly w: FactWorld;
  readonly engine: LivingEngine;
  readonly home: EntityId;
  readonly seasons: number;
  readonly leader: Leader;
  /** the season ledger: its holdings are the fact world's (one record) */
  private led: SeasonLedger;
  readonly spells: SpellId[] = [];
  /** the attack due now (its size), once the raiders' standing threat has run out: the raid card is forced while it is
   *  set */
  raid: number | null = null;
  /** how the raid came out, once it is fought (the end screen's lines; it no longer ends the run) */
  fight: { raiders: number; left: number; fallen: number; held: boolean } | null = null;
  /** what happened this season, in the player's words (resolved, lapsed, the arc) */
  news: string[] = [];
  last: EngineReport;
  /** the tags-and-synergy rules (season/realm-rules.ts), over this world's things */
  readonly rules: RuleBook;
  /** the history's events the rules have seen (an event recorded is a trigger once) */
  private seen = 0;
  /** rule lines not yet in a season's news (fired by an answer given mid-season) */
  private said: string[] = [];
  /** each live event's numbers once read (the template's `vars: 'live'`), and what the scene told of it */
  private liveOut = new Map<string, LiveVars>();
  private told = new Map<string, LiveTold>();
  private partnersWere = -1;

  constructor(private o: RealmOptions) {
    this.ws = MemoryWorldState.restore(structuredClone(o.world));
    this.w = new FactWorld(this.ws);
    this.home = o.home;
    this.seasons = o.seasons ?? RUN_SEASONS;
    this.leader = o.leader;
    this.led = o.ledger;
    // FIXED-CITY: the world's holdings are one town's ledger
    this.w.holdings = o.ledger.holdings;
    const f = this.w.facts;
    if (!this.w.settlement(o.home)) throw new Error(`realm: no settlement ${o.home} in the world`);
    seedLocus(this.w, o.home, o.seed);
    this.w.diplomacy.idOf({ player: true });
    // (the raiders as the base game's data, once a world: who they are, their camp on the road, and their stance —
    // hostile. The standing threat of a run (`pay-raiders`) is dealt only while they are hostile and have somewhere to
    // come from; a world that has lost them has no raid)
    if (!f.entity(RAIDERS_ID)) f.add({ id: RAIDERS_ID, kind: 'army', name: 'the raiders', cause: 'realm' });
    if (!f.entity(RAIDERS_CAMP)) {
      f.add({ id: RAIDERS_CAMP, kind: 'site', name: "the raiders' camp", at: { region: this.w.settlement(o.home)!.region }, attrs: { camp: RAIDERS_ID }, cause: 'realm' });
      if (stanceOf(this.w, RAIDERS_ID, 'player') === 'none') setStance(this.w, RAIDERS_ID, 'player', 'hostile', 'realm');
    }
    // (the home town's sites: named buildings and districts a card stands at — once a world)
    const region = this.w.settlement(o.home)!.region;
    for (const s of SITES) if (!f.entity(siteId(o.home, s.key))) f.add({ id: siteId(o.home, s.key), kind: 'site', name: s.name, at: { region, settlement: o.home }, attrs: { site: s.key, what: s.kind }, cause: 'realm' });
    // (card-table, draft 7: what the packs add to the world before the first deal — their factions)
    o.extra?.seed?.(this.w);
    const res = o.resume;
    if (res) {
      // (a run under way: its turn is the saved world's, its own state as saved)
      this.t0 = res.t0;
      this.spells.push(...res.spells);
      this.raid = res.raid;
      this.fight = res.fight;
      for (const [k, v] of res.where ?? []) this.whereOf.set(k, v);
      this.partnersWere = res.partners ?? -1;
      this.ended = res.ended ?? null;
    } else {
      // (draft 8: years pass between two runs of a world — the one step where the world moves on its own, never during
      // a run: realm-between.ts)
      if (f.events({ kind: 'run-began' }).length) this.betweenRuns([...BASE_BETWEEN, ...(o.extra?.between ?? [])]);
      // (a run's turn is its season; the history's turns run on across runs)
      const start = Math.max(f.turn, 0) + 1;
      f.turn = start;
      this.t0 = start - 1;
      f.record({ kind: 'run-began', by: ['player'], to: [o.home], note: `${o.leader.name} took the town` });
    }
    // (the mutators read and write this run's world from here on; their seasons are the history's turns, which run on
    // across runs: a sign cast in one run's last season ends in the next run's third)
    if (mutators.ready) {
      mutators.useWorld(this.w);
      mutators.season(f.turn);
    }
    f.drainChanged();
    // (laws: the ones that can come into force; a run taken up again has its list as saved)
    for (const l of o.extra?.laws ?? []) this.lawDefs.set(l.id, l);
    this.active = structuredClone(res?.laws ?? []);
    this.lawSeq = res?.lawSeq ?? 0;
    // (the live fire is dealt only when asked for: realm-events.ts FIRE_TEMPLATE, BACKLOG LS-63)
    const world = o.liveFire ? [...WORLD_TEMPLATES.filter((t) => t.id !== 'fire-wards'), FIRE_TEMPLATE] : WORLD_TEMPLATES;
    // (card-table, ages: a leader's start may take cards out of the deck — by id or theme — for the new age; the raid
    // that ends a run stays)
    const out = o.extra?.deckOut;
    const keep = (t: TemplateDef): boolean => !out || t.id === 'raid' || !(out.ids?.includes(t.id) || t.themes.some((x) => out.themes?.includes(x)));
    const templates: TemplateDef[] = [...CATALOG.map(projectTemplate).filter((t): t is TemplateDef => t !== null), ...world, ...(o.extra?.templates ?? [])].filter(keep);
    // (the owner, 2026-11-16: no separate raid mechanism — the raid is a card. No arc is timed here: the raiders'
    // standing threat is a template like any other, dealt while the world has hostile raiders. The dealer's one
    // guarantee — a card that answers the run's threat — reads the raiders' themes while they threaten the town)
    const tune = o.tune ?? (() => ({ ...OPP_TUNE.dealer, reach: Number.MAX_VALUE, resourceMax: BOARD }));
    const realm = this;
    this.engine = new LivingEngine(this.w, templates, undefined, o.home, {
      get hooks() {
        return realm.raidersThreaten() ? ['raiders', 'war'] : [];
      },
      stage: this.stage(),
      // (laws: cards on offer at once, more or fewer)
      tune: () => {
        const t = tune();
        const d = boardDelta(this.laws());
        return d ? { ...t, resourceMax: Math.max(0, t.resourceMax + d) } : t;
      },
      economy: false,
      limitBoard: true,
      threatMax: 1,
      // (round 7, LS-73: the board, the threat and the arc's card — five things asked at most, whatever the guarantee adds.
      // Loop round 10, merging card-table round 5: the raiders' standing card now stands at the town, not a site, so it
      // keeps no site's card off the board, and the dealer's guarantee answers it (hook `raiders-threat`) — CT-52 (6):
      // six. At five the cap cut the guaranteed answer (farms never dealt in table-live.test.ts) and changed which cards
      // run 1 of home.test.ts took. Six until the owner rules (LS-105))
      boardMax: BOARD + 3,
      rng: () => 0,
      liveNumbers: Object.keys(this.runNumbers()),
    });
    this.baseRules = [...RULES, ...(o.extra?.rules ?? [])];
    // (laws: the rule book reads the rules with the laws in force applied)
    this.rules = new RuleBook(() => this.ruleView().rules, { things: () => this.things(), pool: (k) => pools(this.led)[k as Pool] ?? 0, gain: (k, n) => this.addPool(k as Pool, n), act: (fx, things, rule) => this.act(fx, things, rule) });
    for (const [k, v] of res?.asked ?? []) this.asked.set(k, v);
    for (const [k, v] of res?.askedOn ?? []) this.askedOn.set(k, v);
    if (res?.rules) this.rules.load(res.rules);
    else this.rules.season(this.w.turn);
    this.seen = res?.seen ?? this.w.facts.events().length;
    if (res) {
      this.engine.load(res.engine);
      this.last = { turn: this.w.turn, dealt: [], kept: this.engine.offers, notProposed: [], dealer: null, evaluated: { templates: 0, of: 0, changed: 0 }, ms: 0 };
    } else {
      // (a new run: the laws a world tag carries are in force from its first deal)
      this.refreshLaws();
      this.last = this.dealt(this.engine.deal());
    }
    this.sync();
    this.refreshLaws();
  }

  /** the run as it stands, to save beside the world's snapshot (`RealmOptions.resume` takes it up) */
  runState(): RunState {
    return { v: 1, leader: this.leader.id, seasons: this.seasons, t0: this.t0, spells: [...this.spells], raid: this.raid, fight: this.fight, where: [...this.whereOf], engine: this.engine.state(), rules: this.rules.save(), seen: this.seen, partners: this.partnersWere, asked: [...this.asked], askedOn: [...this.askedOn], laws: structuredClone(this.active), lawSeq: this.lawSeq, ended: this.ended };
  }

  // ---- endings and the world's own tags (the owner: "Innovation does this where high tech can instantly win and lose
  // the game … A faction winning and essentially making the whole world undead doesn't really break future play
  // sessions if you are an undead leader in the new world order.") ---------------------------------------------------

  /** the run ended by an effect, a rule or a law: 'won', 'fell' or an ending's own word; its name; who made it */
  ended: { result: string; name: string; by: string } | null = null;
  /** End the run now (the first ending stands). Instant win and instant loss are both allowed. */
  endRun(result: string, name: string, by: string): void {
    if (this.ended) return;
    this.ended = { result, name, by };
    // (about.thing: the ending's word, for `met: "ending:<word>"`)
    this.w.facts.record({ kind: 'run-ended', by: ['player'], to: [this.home], about: { thing: result }, note: `${name} (${by})` });
  }
  /** this run's number in its world (1 the first) */
  runNumber(): number {
    return this.w.facts.events({ kind: 'run-began' }).length;
  }
  /** the record of resolved and lapsed cards over every run of this world, oldest first (`recordOf`) */
  record(): RecordEntry[] {
    return recordOf(this.w);
  }
  /** a card's resolution written to the record (an offer resolved at this tier, or run out) */
  private remember(o: Offer, result: string): void {
    // (draft 7: and what its variables were bound to — a far town, a found place, a faction — so the record can be
    // asked "this card done about this town")
    const bound = Object.entries(o.bind).filter(([k, v]) => (k.startsWith('v_') || k === 'other') && !!this.w.facts.entity(v)).map(([, v]) => v);
    this.w.facts.record({ kind: result === 'lapsed' ? CARD_LAPSED : `${CARD_DONE}${result}`, by: ['player'], to: [...new Set([o.place, ...(o.place === this.home ? [] : [this.home]), ...bound])], about: { opp: o.id, thing: o.template }, note: o.opp.title });
  }


  // ---- laws (living/laws.ts; docs/design/LAWS.md) ---------------------------------------------------------------------

  /** the laws that can come into force, by id */
  private lawDefs = new Map<string, LawDef>();
  /** the laws in force, in the order they came into force (a timed one past its turn is dropped at the next refresh) */
  private active: ActiveLaw[] = [];
  private lawSeq = 0;
  /** the base rules: the run's and the packs' (laws are applied over them) */
  private baseRules: RuleDef[] = [];
  private ruleCache: { key: string; view: DerivedRules } | null = null;

  /** a law that can come into force, by id */
  lawDef(id: string): LawDef | undefined {
    return this.lawDefs.get(id);
  }
  /** every law that can come into force */
  allLaws(): LawDef[] {
    return [...this.lawDefs.values()];
  }
  /** the laws in force now, in the order they came into force, each with its entry (who made it, how long) */
  lawsInForce(): { def: LawDef; at: ActiveLaw }[] {
    return this.active.filter((a) => !('until' in a.source) || a.source.until >= this.w.turn).flatMap((a) => {
      const def = this.lawDefs.get(a.law);
      return def ? [{ def, at: a }] : [];
    });
  }
  /** the laws in force, as defs, in order */
  laws(): LawDef[] {
    return this.lawsInForce().map((x) => x.def);
  }
  /** the rules with the laws in force applied (the same list while the laws do not change), what each law changed,
   *  and the rules turned off */
  ruleView(): DerivedRules {
    const key = this.lawsInForce().map((x) => x.at.seq).join(',');
    if (this.ruleCache?.key !== key) this.ruleCache = { key, view: deriveRules(this.baseRules, this.laws()) };
    return this.ruleCache.view;
  }
  /** the base rules, before any law */
  rulesBefore(): readonly RuleDef[] {
    return this.baseRules;
  }

  /**
   * A law comes into force from an effect, a rule or an ability: for `seasons` (the rest of this season and so many
   * more) or, with none, the rest of the run. `from`: who or what made it, in the player's words. Laws stack: the same
   * law twice is in force twice.
   */
  enact(id: string, from: string, seasons?: number): void {
    if (!this.lawDefs.has(id)) throw new Error(`realm: no law ${id}`);
    this.push(id, from, seasons ? { until: this.w.turn + seasons } : { run: true });
  }
  private push(law: string, from: string, source: LawSource, via?: string): void {
    const def = this.lawDefs.get(law)!;
    // (meta: the next law to come into force lasts the rest of the run, whatever its source; that law is used up)
    if (!('next_law' in def.does)) {
      const next = this.lawsInForce().find((x) => 'next_law' in x.def.does);
      if (next) {
        this.active = this.active.filter((a) => a !== next.at);
        source = { run: true };
        from = `${from} (${next.def.name})`;
      }
    }
    this.active.push({ law, from, source, seq: ++this.lawSeq, ...(via ? { via } : {}) });
    this.w.facts.record({ kind: 'law-made', by: ['player'], to: [this.home], note: `a new law: ${def.name}` });
  }
  /**
   * The laws whose source is a thing follow the things: a thing that left play or is ruined takes its laws with it, a
   * thing newly standing brings its laws (they come into force now, after the laws already in force). A timed law past
   * its turn leaves. Called after every player action and at the season's end.
   */
  refreshLaws(): void {
    // (a world tag that carries laws is a source like a thing: `world:<tag>`, standing while the world has the tag)
    // (the record: a card done in an earlier run of this world whose laws stand in every later run — an ending that
    // changed the world)
    const recordLaws = this.o.extra?.recordLaws ?? [];
    const run = this.runNumber();
    // (done or run out: a threat left to run out is in the record too)
    const earlier = recordLaws.length ? recordOf(this.w).filter((e) => e.run < run) : [];
    // (ages: `results` — only when the card ended so: a world-ending left to run out, not one that was stopped)
    const fits = (x: { card: string; results?: string[] }, e: RecordEntry): boolean => e.card === x.card && (!x.results?.length || x.results.includes(e.result));
    // (draft 8: a law ended between runs — `law_ends` — stands no more, unless the card is done again after that)
    const ended = recordLaws.length ? this.w.facts.events({ kind: LAW_ENDED }) : [];
    const world = recordLaws.filter((x) => earlier.some((e) => fits(x, e))).map((x) => {
      const e = earlier.filter((y) => fits(x, y)).at(-1)!;
      return { id: `record:${x.card}`, name: `"${e.title}" (run ${e.run})`, laws: x.laws.filter((l) => !ended.some((v) => v.about?.thing === l && v.turn >= e.turn)) };
    });
    const src = [...world, ...(this.o.extra?.lawThings?.() ?? [])];
    this.active = this.active.filter((a) => !('until' in a.source) || a.source.until >= this.w.turn);
    if (!src.length && !this.active.some((a) => 'thing' in a.source)) return;
    const standing = new Set([...this.things().filter((t) => !t.tags.includes('ruined')).map((t) => t.id), ...world.map((x) => x.id)]);
    const carries = (thing: string, law: string) => standing.has(thing) && src.some((s) => s.id === thing && s.laws.includes(law));
    this.active = this.active.filter((a) => !('thing' in a.source) || carries(a.source.thing, a.law));
    for (const s of src) {
      if (!standing.has(s.id)) continue;
      for (const law of s.laws) if (!this.active.some((a) => a.law === law && (('thing' in a.source && a.source.thing === s.id) || a.via === s.id))) this.push(law, s.name, { thing: s.id }, s.id);
    }
  }
  /**
   * (the table's previews) What `fn` reads with these laws in force as well, the newest last; nothing is kept. A law
   * a thing would bring is read as in force for the run.
   */
  withLaws<T>(ids: readonly string[], fn: () => T): T {
    const [active, seq, cache] = [this.active, this.lawSeq, this.ruleCache];
    this.active = [...active, ...ids.filter((id) => this.lawDefs.has(id)).map((law, i) => ({ law, from: 'preview', source: { run: true } as LawSource, seq: seq + i + 1 }))];
    try {
      return fn();
    } finally {
      [this.active, this.lawSeq, this.ruleCache] = [active, seq, cache];
    }
  }

  /** an offer's terms with the card laws in force: people locked, goods spent, seasons to build */
  terms(o: Offer): CardTerms {
    const t = this.engine.template(o.template);
    const locks: Record<string, number> = {};
    for (const q of o.opp.requires) if (q.kind === 'workers' || q.kind === 'army') locks[q.kind === 'workers' ? 'labor' : 'might'] = (locks[q.kind === 'workers' ? 'labor' : 'might'] ?? 0) + q.count;
    const turns = 'turns' in o.opp.duration ? o.opp.duration.turns : 1;
    return cardTerms({ id: t.id, themes: t.themes }, { locks, costs: { ...(o.opp.costs ?? {}) } as Record<string, number>, turns }, this.laws());
  }
  /** what one cast of each spell (and ability) in `base` does in an event, with the laws in force */
  spellMech(base: Mech): Mech {
    return spellMech(base, this.laws());
  }
  /** the run is won by a law (an achievement): which, or null */
  won(): { law: string; count: number; tags: string[] } | null {
    const laws = this.laws();
    return laws.some((l) => 'win' in l.does) ? wonBy(this.things(), laws) : null;
  }
  /** offers just dealt stay on offer longer or shorter by the laws in force (`stay`) */
  private dealt(r: EngineReport): EngineReport {
    const laws = this.laws();
    if (laws.some((l) => 'stay' in l.does))
      for (const o of r.dealt) {
        const t = this.engine.template(o.template);
        const n = stayOf({ id: t.id, themes: t.themes }, laws);
        if (n) o.expires = Math.max(this.w.turn, o.expires + n);
      }
    return r;
  }
  /** the history's turn before this run's first season */
  private t0: number;

  /** the run's season (1 the first) */
  get season(): number {
    return this.w.turn - this.t0;
  }

  get ledger(): SeasonLedger {
    return this.led;
  }
  /** the ledger as the season loop left it (income added, a fight's losses): its holdings are the world's again */
  set ledger(l: SeasonLedger) {
    this.led = l;
    this.w.holdings = l.holdings;
  }
  private sync(): void {
    this.led = { ...this.led, holdings: this.w.holdings };
  }

  // ---- what the templates ask of the run (living/dsl.ts Stage) -------------------------------------------------------

  private stage(): Stage {
    const pool = (k: Pool, n: number) => void this.addPool(k, n);
    /** a helper's amount: a number, or one of the card's numbers by name ('-left': taken away) */
    const amount = (c: Ctx, x: string | number | undefined): number => {
      if (typeof x === 'number') return x;
      const s = String(x ?? 0);
      if (!Number.isNaN(Number(s))) return Number(s);
      const neg = s.startsWith('-');
      const v = c.vars?.[neg ? s.slice(1) : s];
      if (typeof v !== 'number') throw new Error(`realm: no number ${s} in ${c.cause}'s vars`);
      return neg ? -v : v;
    };
    const helpers: Record<string, Helper> = {
      isHome: { pred: (c, a) => refOf(c.b, a[0]) === this.home },
      siteIs: { pred: (c, a) => this.w.facts.entity(refOf(c.b, a[0]))?.attrs?.site === a[1] && this.w.facts.entity(refOf(c.b, a[0]))?.at?.settlement === this.home },
      exists: { pred: (_c, a) => !!this.w.facts.entity(String(a[0])) },
      neighbour: { pred: (c, a) => refOf(c.b, a[0]) === this.neighbour() },
      canBuild: {
        pred: (_c, a) => {
          const c = card(String(a[0]));
          const l = this.led;
          const started = l.built.includes(c.id) || l.projects.some((p) => p.card.id === c.id);
          return (c.needs ?? []).every((n) => l.built.includes(n)) && (c.repeat || !started) && hasLand(l, this.o.land(), c);
        },
      },
      hasSpell: { pred: (_c, a) => this.spells.includes(a[0] as SpellId) },
      // (chains) a rule has put this card on offer, or started it, and it is not yet done
      ruleAsked: { pred: (_c, a) => this.asked.has(String(a[0])) },
      // (draft 7: askedOn $var card — the variable is one of the things the rule that asked for the card matched)
      askedOn: { pred: (c, a) => (this.askedOn.get(String(a[1])) ?? []).includes(refOf(c.b, a[0])) },
      // (laws: law id seasons? — a law comes into force, made by the card that names it; seasons 0: the rest of the run)
      law: {
        effect: (c, a) => {
          if (c.dry) return;
          const o = [...this.engine.offers, ...this.engine.past].find((x) => c.cause === x.id || c.cause.startsWith(`${x.id}:`));
          this.enact(String(a[0]), o ? `"${o.opp.title}"` : c.cause, Number(a[1] ?? 0) || undefined);
        },
      },
      // (endings: endRun result name — the run ends now, made by the card that names it)
      endRun: {
        effect: (c, a) => {
          if (c.dry) return;
          const o = [...this.engine.offers, ...this.engine.past].find((x) => c.cause === x.id || c.cause.startsWith(`${x.id}:`));
          this.endRun(String(a[0]), String(a[1] ?? a[0]), o ? `"${o.opp.title}"` : c.cause);
        },
      },
      // (places: eachTown selector helper args… — the helper (`mutate`, `sign`) applied to every town the selector
      // names, nearest first; '$each' in the args is the town. A capture also marks each town occupied)
      eachTown: {
        effect: (c, a) => {
          const [sel, name, ...args] = a.map(String);
          const h = HELPERS[name]?.effect;
          if (!h) throw new Error(`realm: no helper ${name} for eachTown`);
          // (a faction: its id, or a card's variable bound to one)
          const by = args[4] === 'dead' ? DEAD_ID : args[4] === 'player' ? 'player' : args[4] === 'raiders' ? RAIDERS_ID : args[4]?.startsWith('$') ? refOf(c.b, args[4]) : args[4];
          if (by === DEAD_ID && !c.w.facts.entity(DEAD_ID)) c.w.facts.add({ id: DEAD_ID, kind: 'army', name: 'the risen dead', cause: c.cause });
          for (const id of this.selectTowns(sel)) {
            if (name === 'mutate' && args[0] === 'captured') c.w.facts.setTag(id, 'condition', 'occupied', true, c.cause);
            const xs: (string | number)[] = args.map((x, i) => (x === '$each' ? '$each' : i === 4 && by !== undefined ? '$each_by' : Number.isNaN(Number(x)) || x === '' ? x : Number(x)));
            h({ ...c, b: { ...c.b, each: id, ...(by !== undefined ? { each_by: by } : {}) } }, xs);
          }
        },
      },
      // (places: townsExist selector — the selector names at least one town)
      townsExist: { pred: (_c, a) => this.selectTowns(String(a[0])).length > 0 },
      // (trade routes: trade selector on|off — the towns supply the home town (a trade partner), or no longer do)
      trade: {
        effect: (c, a) => {
          for (const id of this.selectTowns(String(a[0]))) {
            const has = c.w.facts.relations({ type: 'supplies', from: id, to: this.home }).length > 0;
            if (a[1] === 'off' && has) c.w.facts.unrelate({ type: 'supplies', from: id, to: this.home }, c.cause);
            else if (a[1] !== 'off' && !has) c.w.facts.relate({ type: 'supplies', from: id, to: this.home });
          }
        },
      },
      // (recordHas card tiers place when: the record has the card done — at one of these tiers ('' any; 'lapsed' for run
      // out), at this place ('' anywhere; a bound entity), in an earlier run ('earlier') or any ('any'))
      recordHas: {
        pred: (c, a) => {
          const [card, tiers, where, when, of] = [String(a[0]), String(a[1] ?? ''), String(a[2] ?? ''), String(a[3] ?? 'any'), String(a[4] ?? '')];
          const place = where ? refOf(c.b, where) : '';
          // (draft 7: about — what the card was bound to, a variable or a place's id)
          const about = of ? refOf(c.b, of) : '';
          const run = this.runNumber();
          return recordOf(c.w).some((e) => e.card === card && (tiers ? tiers.split('|').includes(e.result) : e.result !== 'lapsed') && (!place || e.place === place) && (!about || e.about.includes(about)) && (when !== 'earlier' || e.run < run));
        },
      },
      // (built card: the town has built it)
      built: { pred: (_c, a) => this.led.built.includes(String(a[0])) },
      // (the raiders as cards: they are hostile to you and have somewhere to come from — their camp, or a town they hold)
      raidersThreaten: { pred: () => this.raidersThreaten() },
      // (raidersAre stance: the raiders' stance with you is this one)
      raidersAre: { pred: (_c, a) => !!this.w.facts.entity(RAIDERS_ID) && stanceOf(this.w, RAIDERS_ID, 'player') === a[0] },
      // (their camp stands)
      raidersCamp: { pred: () => this.campStands() },
      // (raidersStance stance: the raiders' stance with you becomes this one — paid off: a truce)
      raidersStance: { effect: (c, a) => void setStance(c.w, RAIDERS_ID, 'player', String(a[0]) as Stance, c.cause) },
      // (doneThisRun template: a card of it was answered or ran out in this run — "once a run" for a base card)
      doneThisRun: { pred: (_c, a) => this.engine.past.some((o) => o.template === a[0] && o.dealt > this.t0 && (o.status === 'resolved' || o.status === 'expired')) },
      // (a countdown to the end of the season before the run's last: the raiders' standing threat lapses then, and the
      // raid it brings is in the last season)
      beforeLastSeason: { expiry: () => ({ turn: Math.max(this.w.turn, this.t0 + this.seasons - 1) }) },
      // ---- (draft 8) the between-runs step's own words (realm-between.ts) ----
      // (a sign stands on some town and was not set for good)
      signsLinger: { pred: () => this.lingering().length > 0 },
      // (loop round 10: in the 3D game the mutators keep the signs too, and laid them again on the new run's world as it
      // was bound — run 2's "The world now" said the thieves were gone and then "Thieves work the streets". The sign is
      // ended in their list as well)
      fadeSigns: {
        effect: (c) => {
          if (c.dry) return;
          for (const [id, k] of this.lingering()) {
            recordSign(c.w, k, id, false, c.cause);
            if (mutators.ready) mutators.sign({ kind: k, place: id, strength: 0, cause: c.cause });
          }
        },
      },
      // (some far town is still there — in any state but destroyed or abandoned: standing, sworn, taken, founded)
      farStands: { pred: () => { const gone = new Set([...this.selectTowns('far:where:destroyed'), ...this.selectTowns('far:where:abandoned')]); return this.selectTowns('far:all').some((id) => !gone.has(id)); } },
      // (a far town lies in ruins, destroyed or abandoned, and nothing has grown over it yet)
      ruinsBare: { pred: () => [...this.selectTowns('far:where:destroyed'), ...this.selectTowns('far:where:abandoned')].some((id) => !this.w.facts.tag(id, 'condition', 'greened')?.value) },
      // (signForGood kind selector: the sign on these towns does not fade between runs — an ending's mark on the world)
      signForGood: { effect: (c, a) => void (String(a[1]) === 'town' ? [this.home] : this.selectTowns(String(a[1]))).forEach((id) => c.w.facts.setTag(id, 'condition', `${String(a[0])}${FOR_GOOD}`, true, c.cause)) },
      // (after share: the run is at least that far along — the smaller threats come one at a time, spread over the run)
      after: { pred: (_c, a) => this.season >= Math.max(1, Math.ceil(Number(a[0]) * this.seasons)) },

      // (round 6) the raid is due and not yet fought: its card is on the board
      raidDue: { pred: () => this.raid !== null && !this.fight },
      // (a live event's numbers, for its card's words and its outcome's amounts: the run's own, every name it counts at
      // 0, then what was read once it is over — living/live.ts)
      live: {
        vars: (c) => {
          const t = this.engine.templates.find((x) => c.cause === x.id || c.cause.startsWith(`${x.id}:`));
          const id = [...this.liveOut.keys()].find((k) => c.cause === k || c.cause.startsWith(`${k}:`));
          return { ...this.runNumbers(), ...(t?.play?.event ? liveNames(t.play.event) : {}), ...(id ? this.liveOut.get(id) : {}) };
        },
      },
      // (the raid is over: what the run's screens and its end read)
      raidOver: {
        effect: (c) => {
          if (c.dry) return;
          const [raiders, left, fallen] = [amount(c, 'raiders'), amount(c, 'left'), amount(c, 'fallen')];
          this.fight = { raiders, left, fallen, held: raiders > 0 && left === 0 };
          this.raid = null;
        },
      },
      // (mark $thing tag: a state that lasts to the end of this season — 'festival', 'growth-active')
      mark: { effect: (c, a) => void (c.dry || this.mark(refOf(c.b, a[0]), String(a[1]), c.cause)) },
      // (burnPoints $site radius: the lots that burned in a live fire get the `burned` condition where they stand — the
      // points the scene told; none told (nothing ran): one burn round the site, as wide as the share that burned)
      burnPoints: {
        effect: (c, a) => {
          if (c.dry) return;
          const site = refOf(c.b, a[0]);
          const id = [...this.told.keys()].find((k) => c.cause === k || c.cause.startsWith(`${k}:`));
          const cells = id ? (this.told.get(id)?.burned ?? []) : [];
          for (const cell of cells) this.landAt('burned', site, Number(a[1]), 1, c.cause, undefined, cell);
          const n = amount(c, 'burned');
          if (!cells.length && n > 0) this.landAt('burned', site, Math.round(Number(a[1]) * Math.sqrt(n)), 1, c.cause);
        },
      },
      // (camp $site state?: the refugees' camp by a site of the town — a thing of the fact world the rules and a later card
      // read; its tents on the ground are the scene's)
      camp: {
        effect: (c, a) => {
          const site = refOf(c.b, a[0]);
          const id = campId(this.home);
          if (!c.w.facts.entity(id)) c.w.facts.add({ id, kind: 'site', name: 'the refugee camp', at: { region: this.w.settlement(this.home)!.region, settlement: this.home }, attrs: { camp: true, by: site }, cause: c.cause });
          // (camp $site state: what became of it — 'sheltered' (huts raised), 'abandoned' (its people moved on or sent away))
          if (a[1]) c.w.facts.setTag(id, 'condition', String(a[1]), true, c.cause);
          // (loop round 7, LS-67: its tents on the ground — the mutators' 'camp' sign, which the save keeps — by the east
          // fields, out from the town's middle: open, dry ground (by the watch post they stood in the river's silt))
          if (!c.dry && mutators.ready && !a[1]) mutators.sign({ kind: 'camp', place: this.home, at: this.campCell(), cause: c.cause });
        },
      },

      pool: { effect: (c, a) => void (c.dry || pool(a[0] as Pool, amount(c, a[1]))) },
      income: {
        effect: (c, a) => {
          if (c.dry) return;
          const k = a[0] as Pool;
          this.led = { ...this.led, income: { ...this.led.income, [k]: (this.led.income[k] ?? 0) + Number(a[1]) } };
        },
      },
      spell: { effect: (c, a) => void (c.dry || this.spells.includes(a[0] as SpellId) || this.spells.push(a[0] as SpellId)) },
      // (raid n?: the raid is due — n raiders, by default the run's own number; the raid card is forced while it is due)
      raid: { effect: (c, a) => void (c.dry || (this.raid = a[0] !== undefined ? Number(a[0]) : (this.o.raiders ?? RAIDERS))) },
      // (mutateAt kind $site radius strength? spot?: the land round a site of the home town changed — or round a spot
      // out of it, when one is named: the mountain. The physical side of the event the template has just recorded)
      // (round 6: spot 'live' — where the live event the card played was when it ended, as the scene told)
      mutateAt: {
        effect: (c, a) => {
          if (c.dry) return;
          const id = a[4] === 'live' ? [...this.told.keys()].find((k) => c.cause === k || c.cause.startsWith(`${k}:`)) : undefined;
          this.landAt(a[0] as PhysicalKind, refOf(c.b, a[1]), Number(a[2]), Number(a[3] ?? 1), c.cause, a[4] === 'live' ? undefined : (a[4] as Spot | undefined), id ? this.told.get(id)?.at : undefined);
        },
      },
      // (found id name purpose?: a new camp in the hills, with what it is for — 'mining': the mutators cut a pit and
      // heap its spoil beside it, and the camp is built as a site of the field towns when the window nears it; — the settlement's record, its entity, its event, its place on the map)
      found: {
        effect: (c, a) => {
          const id = String(a[0]);
          // (draft 7: each later camp a step round the hills from the last, so two camps are two places on the map;
          // founded by the player, or a faction of a pack — `by`)
          const hills = this.cellOf('hills');
          // (merge, round 8: only foundings a mutation made — they carry the world-state change in `about.atlas`; the
          // atlas's own settlement histories are 'founding' events too, and moved the first camp off the hills)
          const k = c.w.facts.events({ kind: 'founding' }).filter((e) => (e.about?.atlas?.length ?? 0) > 0).length;
          const cell: [number, number] = k ? [Math.round(hills[0] + 90 * Math.cos(k * 1.3)), Math.round(hills[1] + (90 * Math.sin(k * 1.3)) / ROW_H)] : hills;
          const purpose = a[2] === 'mining' ? ('mining' as const) : undefined;
          const by = a[3] ? refOf(c.b, a[3]) : 'player';
          const spec = { kind: 'founded' as const, place: id, cell, radius: 30, strength: 1, by, name: String(a[1]), size: 'camp' as const, ...(purpose ? { purpose } : {}) };
          const fact = recordMutation(c.w, spec, { cause: c.cause, regionAt: this.o.regionAt ?? (() => this.w.settlement(this.home)!.region) });
          if (!c.dry && mutators.ready) mutators.apply({ kind: 'founded', place: id, at: cell, radius: 30, by, name: spec.name, size: 'camp', ...(purpose ? { purpose } : {}), cause: c.cause, fact });
        },
      },
    };
    return { helpers: { ...(this.o.extra?.helpers ?? {}), ...helpers } };
  }

  /** a pool changed by an outcome or a rule: added to (negative: taken, never below what is there; Unrest moves both
   *  ways). Returns what was really added */
  private addPool(k: Pool, n: number): number {
    const l = { ...this.led, holdings: this.w.holdings };
    const was = k === 'might' || k === 'labor' ? total(l, k) : pools(l)[k];
    const next = k === 'unrest' ? lose(l, { unrest: n }) : n >= 0 ? grant(l, { [k]: n }) : lose(l, { [k]: -n });
    this.w.holdings = next.holdings;
    this.led = { ...this.led, holdings: next.holdings };
    return (k === 'might' || k === 'labor' ? total(next, k) : pools(next)[k]) - was;
  }

  /** a state on a thing that lasts to the end of this season: a condition whose value is the turn it ends with (as
   *  text: a number in the fact layer is an intensity) */
  private mark(id: EntityId, tag: string, cause: string): void {
    this.w.facts.setTag(id, 'condition', tag, String(this.w.turn), cause);
  }

  // ---- things and their tags (the synergy rules read these: season/realm-rules.ts) -----------------------------------

  /** the run's numbers a live event's groups and words may name */
  runNumbers(): LiveVars {
    const p = pools(this.led);
    const houses = this.led.built.filter((c) => c === 'houses').length;
    // (laws: the raid's size; a pool that counts as Might in a fight — Unrest)
    const laws = this.laws();
    const might = p.might + poolsAs(laws).filter(([, as]) => as === 'might').reduce((n, [k]) => n + (p[k as Pool] ?? 0), 0);
    return { raid: this.raid === null ? 0 : raidersOf(this.raid, laws), soldiers: military(this.led) ? might * SQUAD : 0, watchers: 4 + 2 * Math.min(3, houses) };
  }

  /** where a thing is, in world units (x cells, y) */
  private posOf(cell: readonly [number, number]): [number, number] {
    return [cell[0], cell[1] * ROW_H];
  }

  /** the far towns the home town trades with: once the trade route is built, the nearest PARTNERS that the atlas has
   *  (standing or not: a fallen one is a partner lost); and any place that supplies the town (the mining camp).
   *  FIXED-CITY: partners of the one home town */
  partners(): { id: EntityId; standing: boolean }[] {
    const f = this.w.facts;
    const h = this.w.settlement(this.home)!;
    const ids = new Set<EntityId>(f.relations({ type: 'supplies', to: this.home }).map((r) => r.from));
    // (trade routes: a policy thing in play makes the towns its selector names partners, on top of the default)
    for (const sel of this.o.extra?.tradeThings?.() ?? []) for (const id of this.selectTowns(sel)) ids.add(id);
    if (this.led.built.includes('trade')) {
      const near = this.ws.settlements.filter((s) => s.id !== this.home && s.size !== 'camp' && f.entity(s.id)).sort((a, b) => Math.hypot(a.at[0] - h.at[0], a.at[1] - h.at[1]) - Math.hypot(b.at[0] - h.at[0], b.at[1] - h.at[1]));
      for (const s of near.slice(0, PARTNERS)) ids.add(s.id);
    }
    return [...ids].map((id) => {
      const st = placeState(this.w, id)?.status;
      const s = this.w.settlement(id);
      const down = st === 'destroyed' || st === 'abandoned' || st === 'occupied' || s?.condition === 'ruined' || s?.condition === 'abandoned' || !!f.tag(id, 'condition', 'lost') || !!f.tag(id, 'condition', 'occupied');
      return { id, standing: !down };
    });
  }

  /**
   * Every persistent thing the rules know, with its tags: what it is, and its state. A site that is burned, flooded,
   * buried, melted or abandoned carries only 'ruined' and those words — its working tags are gone, so every rule about
   * what it was stops.
   */
  things(): Thing[] {
    const base = this.baseThings();
    // (card-table: a pack's things added, their tags lent to their place — packs/load.ts; LS-75 asks for the same here)
    const all = this.o.extra?.things ? this.o.extra.things(base) : base;
    // (laws: a tag that counts as another, a tag granted to every match, in the order they came into force)
    const laws = this.laws();
    return laws.length ? applyTags(all, laws) : all;
  }
  private baseThings(): Thing[] {
    const f = this.w.facts;
    const l = this.led;
    const out: Thing[] = [];
    const h = this.w.settlement(this.home)!;
    // (laws: a ruin word a law spares no longer ruins — the thing keeps its working tags and carries the word too)
    const spare = spared(this.laws());
    const ruinOf = (id: EntityId) => RUIN.filter((k) => !spare.has(k) && !!f.tag(id, 'condition', k)?.value);
    const sparedOn = (id: EntityId) => RUIN.filter((k) => spare.has(k) && !!f.tag(id, 'condition', k)?.value);
    const timed = (id: EntityId) => TIMED.filter((k) => Number(f.tag(id, 'condition', k)?.value ?? -1) >= this.w.turn);
    for (const s of SITES) {
      const id = siteId(this.home, s.key);
      if (!f.entity(id)) continue;
      const ruin = ruinOf(id);
      const meta = SITE_TAGS[s.key];
      // (a ruined place keeps what it was as remains: a later card can ask for "remains-of-field")
      const tags = ruin.length ? ['ruined', ...ruin, ...meta.is.map((x) => `remains-of-${x}`)] : [...meta.is, 'standing', ...(meta.built && l.built.includes(meta.built) ? ['worked'] : []), ...timed(id), ...sparedOn(id)];
      out.push({ id, name: s.name, tags, at: this.posOf(this.cellOf(s.key)), town: this.home });
    }
    const p = pools(l);
    const sacked = ruinOf(siteId(this.home, 'gate')).length > 0;
    out.push({ id: this.home, name: this.w.name(this.home), tags: ['town', 'home', ...(l.built.includes('walls') && !sacked ? ['wall'] : []), ...(military(l) && p.might > 0 ? ['garrison'] : []), ...(p.unrest > 0 ? ['unrest'] : [])], at: [h.at[0], h.at[1]], town: this.home });
    for (const x of this.partners()) {
      const s = this.w.settlement(x.id);
      out.push({ id: x.id, name: this.w.name(x.id), tags: ['town', 'trade-partner', x.standing ? 'standing' : 'ruined'], at: s ? [s.at[0], s.at[1]] : null, town: x.id });
    }
    const camp = campId(this.home);
    if (f.entity(camp)) out.push({ id: camp, name: 'the refugee camp', tags: ['camp', ...(f.tag(camp, 'condition', 'sheltered')?.value ? ['sheltered'] : []), ...(f.tag(camp, 'condition', 'abandoned')?.value ? ['ruined'] : ['standing'])], at: this.posOf(this.campCell()), town: this.home });
    return out;
  }

  /** the rules fired on an occasion: each firing recorded in the history (why a pool moved) */
  private fireRules(o: RuleOccasion): RuleHit[] {
    this.w.holdings = this.led.holdings;
    const hits = this.rules.fire(o);
    for (const h of hits) this.w.facts.record({ kind: 'rule-fired', by: h.things.filter((id) => !!this.w.facts.entity(id)), to: [this.home], note: h.text });
    if (hits.length) this.o.onRules?.(hits);
    return hits;
  }

  /** the history's new events as triggers (a rule's own record is never one), each once */
  private pump(): RuleHit[] {
    const hits: RuleHit[] = [];
    const evs = this.w.facts.events();
    const fresh = evs.slice(this.seen);
    this.seen = evs.length;
    for (const e of fresh) {
      if (e.kind === 'rule-fired') continue;
      // (a card a rule had put on offer, now done or run out: the rules it fires are that rule's chain)
      const card = /^pack-(?:done|lapsed):(.+)$/.exec(e.kind)?.[1];
      const after = card ? this.asked.get(card) : undefined;
      // (no longer asked for, before its rules fire: a rule may ask for the same card again — a loop's next turn)
      if (card) this.asked.delete(card);
      hits.push(...this.fireRules({ on: { event: e.kind }, id: e.id, ...(e.note ? { what: e.note } : {}), ...(after ? { after } : {}) }));
    }
    // (the rules' own records are seen, and trigger nothing)
    this.seen = this.w.facts.events().length;
    return hits;
  }

  /** the cards a rule has put on offer or started and that are not yet done or run out: card → the rule's name */
  private asked = new Map<string, string>();
  /** (draft 7) what the rule that asked for a card matched: card → thing ids */
  private askedOn = new Map<string, EntityId[]>();
  /** a card was asked for since the last deal */
  private dealDue = false;

  /**
   * (card-table: chains) An acting rule's act, for the rule book (living/rules.ts RuleAct). `offer` / `start`: the
   * card is wanted from now — its template's `ruleAsked` condition holds, so the next deal puts it on the board (a
   * started live card is `forced`: it begins as it is dealt). False if it is unknown, on the board or under way
   * already, asked for already, or done for good (`once`). `tag` / `untag`: on each thing the rule matched.
   */
  private act(fx: RuleAct, things: Thing[], rule: RuleDef): boolean {
    const f = this.w.facts;
    // (laws: a rule makes a law; it is in force from now — the rules after it in this cascade read it)
    if ('law' in fx) {
      if (!this.lawDefs.has(fx.law)) return false;
      this.enact(fx.law, `the rule "${rule.name}"`, fx.seasons);
      return true;
    }
    // (endings: a rule ends the run)
    if ('end_run' in fx) {
      if (this.ended) return false;
      this.endRun(fx.end_run, fx.name ?? fx.end_run, `the rule "${rule.name}"`);
      return true;
    }
    if ('offer' in fx || 'start' in fx) {
      const id = 'offer' in fx ? fx.offer : fx.start;
      const t = this.engine.templates.find((x) => x.id === id);
      if (!t || this.asked.has(id)) return false;
      if (this.engine.offers.some((o) => o.template === id && (o.status === 'offered' || o.status === 'committed'))) return false;
      if (t.once && this.engine.past.some((o) => o.template === id && o.status === 'resolved' && o.dealt > this.t0)) return false;
      this.asked.set(id, rule.name);
      // (draft 7: what the rule matched — the card's `set_off` variable binds to one of them)
      this.askedOn.set(id, things.map((t) => t.id));
      this.dealDue = true;
      return true;
    }
    let changed = false;
    for (const a of things) {
      if (!f.entity(a.id)) continue;
      const cur = f.tag(a.id, 'condition', 'tag' in fx ? fx.tag : fx.untag)?.value;
      const on = cur === true || (typeof cur === 'string' && Number(cur) >= this.w.turn);
      if ('tag' in fx && !on) {
        f.setTag(a.id, 'condition', fx.tag, fx.timed ? String(this.w.turn) : true, `rule:${rule.id}`);
        changed = true;
      } else if ('untag' in fx && on) {
        f.dropTag(a.id, 'condition', fx.untag);
        changed = true;
      }
    }
    return changed;
  }

  /** a card a rule asked for mid-season is dealt now (at a season's end the season's own deal does it) */
  private dealAsked(): void {
    if (!this.dealDue) return;
    this.dealDue = false;
    this.last = this.dealt(this.engine.redeal());
    this.sync();
  }

  // ---- live events (living/live.ts; the scene's runner plays them: scenes/level/live-runner.ts) ------------------------

  /** a template's live event, or null */
  liveOf(o: Offer): LiveDef | null {
    const def = this.engine.template(o.template).play?.event ?? null;
    // (laws: spells allowed, foes added)
    return def ? liveLaw(def, this.laws()) : null;
  }
  /** the live events under way: agreed (or forced) and not yet resolved */
  liveRunning(): Offer[] {
    return this.engine.running().filter((o) => !!this.liveOf(o));
  }
  /** a forced live event on the board (the raid, refugees arriving): nobody asks, it begins */
  forcedLive(): Offer | null {
    return this.engine.offered.find((o) => !!this.liveOf(o) && !!this.engine.template(o.template).play?.forced) ?? null;
  }
  /** the scene says how a live event stands (kept until it is resolved: the season's end reads it) */
  tellLive(id: string, told: LiveTold): void {
    this.told.set(id, told);
  }

  /**
   * A live event resolved from the state it is in — its own end, or the season's: its numbers counted, the rules
   * applied to them, a tier read, the template's outcome for that tier run through the engine. `told` absent: what the
   * scene last told; none (nothing ran: a test, the bots, a reload): the event as nobody played it.
   */
  finishLive(id: string, told?: LiveTold): LiveReport {
    const o = this.engine.running().find((x) => x.id === id);
    const def = o && this.liveOf(o);
    if (!o || !def) throw new Error(`realm: no live event ${id} under way`);
    const t = this.engine.template(o.template);
    const run = this.runNumbers();
    const how = told ?? this.told.get(id) ?? { state: idleState(def, run) };
    this.told.set(id, how);
    const site = this.w.facts.entity(o.place)?.attrs?.site as SiteKey | undefined;
    const vars = liveRead(def, how.state, run);
    const hits = this.fireRules({ on: { live: def.tag }, id, vars, at: this.posOf(how.at ?? this.cellOf(site ?? 'market')), route: how.route ? [this.posOf(how.route[0]), this.posOf(how.route[1])] : null });
    const out = liveDerive(def, vars);
    // (laws: a result moved up or down a step)
    const tier = shiftTier(def, liveTier(def, out), this.laws());
    this.liveOut.set(id, out);
    this.w.holdings = this.led.holdings;
    // (the record: this card, at this tier, here — before its outcome, so a rule or a card reading the record sees it)
    this.remember(o, tier);
    this.engine.resolve(id, tier);
    // (loop round 12) what a front reached is changed whatever the tier: the land under it is the liquid's
    if (def.hazard?.kind === 'front') this.frontLand(def.hazard, o, how);
    this.sync();
    const oc = outcomesOf(t)[tier] ?? outcomesOf(t).success;
    const title = text(this.engine.ctx(t, o.bind, o.id), t.title);
    // (card-table: chains) the result is picked: the rules about results fire now, as the chain of whichever rule had
    // offered or started this card — before the events its outcome wrote are read, so a tag a win sets is there for
    // the rule that waits for the card to be done
    const after = this.asked.get(o.template);
    hits.push(...this.fireRules({ on: { live: def.tag, tier: [tier] }, id: `${id}:result`, vars: { ...out }, at: this.posOf(how.at ?? this.cellOf(site ?? 'market')), route: null, what: liveWhat(title, tier), ...(after ? { after } : {}) }));
    // (laws: the result also counts as another kind's result, for the rules that wait for that)
    for (const also of resultAlso(def.tag, tier, this.laws())) hits.push(...this.fireRules({ on: { live: also.live, tier: also.tier }, id: `${id}:as:${also.live}`, vars: { ...out }, at: this.posOf(how.at ?? this.cellOf(site ?? 'market')), route: null, what: liveWhat(title, tier), ...(after ? { after } : {}) }));
    this.refreshLaws();
    // (the card's own record of its end, read here, is what takes it off the asked list — and a rule waiting for that
    // record may ask for the same card again: a loop's next turn)
    hits.push(...this.pump());
    const lines = [...(oc ? [text(this.engine.ctx(t, o.bind, o.id), oc.text)] : []), ...hits.map((h) => `${h.text}.`)];
    console.log(`[realm] live event ${o.template}: ${tier} ${JSON.stringify(out)}${hits.length ? ` rules: ${hits.map((h) => h.rule).join(', ')}` : ''}`);
    return { id, template: o.template, title, tier, vars: out, lines, hits };
  }

  /**
   * (card-table) How a live event under way would come out if it ended now in `state`: its numbers counted, the rules
   * that would apply (nothing is changed: no pool moves, no firing counted), the tier, and the outcome's line. The same
   * four steps as `finishLive`, so the prediction and the result agree when the state does not change.
   */
  predictLive(id: string, state: LiveState): { tier: Tier; vars: LiveVars; hits: RuleHit[]; text: string } {
    const o = this.engine.running().find((x) => x.id === id);
    const def = o && this.liveOf(o);
    if (!o || !def) throw new Error(`realm: no live event ${id} under way`);
    const t = this.engine.template(o.template);
    const site = this.w.facts.entity(o.place)?.attrs?.site as SiteKey | undefined;
    const vars = liveRead(def, state, this.runNumbers());
    const hits = this.rules.preview({ on: { live: def.tag }, vars, at: this.posOf(this.cellOf(site ?? 'market')), route: null });
    const out = liveDerive(def, vars);
    // (laws: a result moved up or down a step)
    const tier = shiftTier(def, liveTier(def, out), this.laws());
    const oc = outcomesOf(t)[tier] ?? outcomesOf(t).success;
    const line = (oc?.text ?? '').replace(/\{(\w+)\}/g, (m, k: string) => (typeof out[k] === 'number' ? String(out[k]) : m));
    return { tier, vars: out, hits, text: text(this.engine.ctx(t, o.bind, o.id), line) };
  }

  /** (a test, the bots) every forced live event on the board begun and resolved as nobody played it */
  playForced(): LiveReport[] {
    const out: LiveReport[] = [];
    for (let o = this.forcedLive(); o; o = this.forcedLive()) {
      this.commit(o.id);
      out.push(this.finishLive(o.id));
    }
    return out;
  }

  /**
   * A spell cast (LOOP_SKELETON.md "who decides the fight": a cast is a record): its Magic spent and an event written.
   * A growth rune over a site marks it 'growth-active' until the season ends. False: not enough Magic.
   */
  cast(spell: SpellId, site?: SiteKey): boolean {
    const cost = SPELL_COST[spell];
    if (pools(this.led).magic < cost) return false;
    // (a player's action: a cascade of the rules begins)
    this.rules.begin();
    this.addPool('magic', -cost);
    const at = site ? siteId(this.home, site) : this.home;
    if (spell === 'growth' && site) this.mark(at, 'growth-active', 'spell');
    // (laws: a cast also sets a tag for the season on every thing that matches — Rain grows the fields)
    for (const also of spellAlso(spell, this.laws())) for (const t of this.things()) if (this.w.facts.entity(t.id) && !t.tags.includes('ruined') && also.on.tags.every((x) => t.tags.includes(x)) && !(also.on.not ?? []).some((x) => t.tags.includes(x))) this.mark(t.id, also.tag, `law:${also.law}`);
    this.w.facts.record({ kind: 'spell-cast', by: ['player'], to: [at], note: spell === 'growth' ? `you drew a growth rune over ${this.w.name(at)}` : `you cast ${spell} at ${this.w.name(at)}` });
    this.said.push(...this.pump().map((h) => `${h.text}.`));
    this.refreshLaws();
    this.dealAsked();
    return true;
  }

  /** (loop round 7, LS-67) a camp's cell by a site: CAMP_OUT world units out from it, away from the home town's middle */
  campCell(key: SiteKey = CAMP_SITE): [number, number] {
    const [x, r] = this.cellOf(key);
    const h = this.w.settlement(this.home)!.at;
    const dx = x - h[0];
    const dy = r * ROW_H - h[1];
    const d = Math.hypot(dx, dy) || 1;
    return [Math.round(x + (dx / d) * CAMP_OUT), Math.round((r * ROW_H + (dy / d) * CAMP_OUT) / ROW_H)];
  }

  /** where a spot is in world cells [x, row]: the scene's answer, else a fixed way off the town's centre */

  cellOf(spot: Spot): [number, number] {
    const at = this.o.where?.(spot);
    if (at) return [Math.round(at[0]), Math.round(at[1])];
    const h = this.w.settlement(this.home)!;
    const off = spot === 'hills' ? [220, -60] : spot === 'mountain' ? [-520, 180] : [0, 0];
    return [Math.round(h.at[0] + off[0]), Math.round((h.at[1] + off[1]) / ROW_H)];
  }

  /**
   * The land round a site changed (flooded, burned, melted, buried): the physical projection of the fact event that says
   * so — the latest one `cause` recorded (a template records its event before it names this). The mutators write the
   * land and the lots there at once, or when that land next arrives. Nothing bound (a test): the facts stand alone.
   */
  /**
   * (loop round 12, docs/design/FRONTS.md) A front's land: its kind (`melted`, `flooded` …) at every point it reached —
   * in the town, a lot's width round each (the lots there take the kind's condition); on its way, a narrower one. Told
   * nothing (nothing ran: a test, the bots, a reload), one change round the card's site as wide as the share of points
   * reached.
   */
  private frontLand(hz: LiveFront, o: Offer, how: LiveTold): void {
    const town = how.burned ?? [];
    const way = how.path ?? [];
    const lot = Math.max(4, Math.round(hz.spread / Math.sqrt(hz.points)));
    for (const cell of town) this.landAt(hz.mutate, o.place, lot, 1, o.id, undefined, cell);
    for (const cell of way) this.landAt(hz.mutate, o.place, FRONT_WAY_R, 1, o.id, undefined, cell);
    const n = how.state.burned / Math.max(1, hz.points);
    if (!town.length && !way.length && n > 0) this.landAt(hz.mutate, o.place, Math.round(hz.spread * Math.sqrt(n)), 1, o.id);
    // (the record of what it did to the town: the next run's "The world now" tells it — run-packs.ts startLines)
    this.w.facts.record({ kind: FRONT_EVENT, by: [], to: [this.home], about: { opp: o.id }, note: JSON.stringify({ liquid: hz.liquid, reached: how.state.burned, path: way.length > 0 || how.state.burned > 0 }) });
  }

  private landAt(kind: PhysicalKind, site: EntityId, radius: number, strength: number, cause: string, spot?: Spot, cell?: readonly [number, number]): void {
    if (!mutators.ready) return;
    const ev = this.w.facts.events().filter((e) => e.about?.opp === cause || e.id === cause).at(-1);
    const key = spot ?? (this.w.facts.entity(site)?.attrs?.site as SiteKey | undefined);
    if (!key) throw new Error(`realm: ${site} is no site of the home town`);
    let seed = 1;
    for (const ch of site) seed = (seed * 31 + ch.charCodeAt(0)) & 0xffff;
    const m = mutators.apply({ kind, at: cell ? [Math.round(cell[0]), Math.round(cell[1])] : this.cellOf(key), radius, strength, seed, cause, ...(ev ? { fact: ev.id } : {}) });
    this.whereOf.set(m.id, spot === 'mountain' ? 'the mountain' : this.w.name(site));
  }
  /** the place each of this run's land changes is named by (the site it was about), by the entry's id */
  private whereOf = new Map<string, string>();
  /** the name of the place an entry of `changes()` is about */
  placeName(m: Mutation): string {
    return this.whereOf.get(m.id) ?? m.name ?? this.w.name(m.place ?? this.home);
  }

  /**
   * What the world's state adds to the living town's streets (season/life.ts counts): the people who came as refugees
   * (40 for each town that fell and sent them — the migrations in the history), carts through the gate the season they
   * arrive, and the ore wagons of a mining camp while it stands.
   */
  // FIXED-CITY: what comes home comes to the one home town, and its living town is the only one fed
  life(): { people: number; wagons: number; trade: number } {
    const f = this.w.facts;
    const came = f.events({ kind: 'migration' }).filter((e) => e.to.includes(this.home));
    const camp = !!f.entity(CAMP_ID) && f.relations({ type: 'controls', from: 'player', to: CAMP_ID }).length > 0 && !f.tag(CAMP_ID, 'condition', 'lost');
    // (round 6, SYSTEMS.md recipe 3: the trade route's wagons and ships come from the far towns it reaches — the share
    // of them still standing)
    const ps = this.partners().filter((x) => x.id !== CAMP_ID);
    const trade = ps.length ? ps.filter((x) => x.standing).length / ps.length : 1;
    return { people: REFUGEES * came.length, wagons: (camp ? CAMP_WAGONS : 0) + (came.some((e) => e.turn === this.w.turn) ? ARRIVAL_CARTS : 0), trade };
  }

  /** what this run changed in the land and the places of the world: the mutators' entries whose fact event is this
   *  run's (empty with no world bound to them) */
  changes(): Mutation[] {
    const mine = new Set(this.history().map((e) => e.id));
    return mutators.record().list.filter((m) => m.fact !== undefined && mine.has(m.fact));
  }

  /**
   * (places) The towns a place selector names, nearest the home town first (deterministic: by distance, then id):
   * `far:neighbour` (the nearest standing), `far:nearest:<n>` (the n nearest standing), `far:all` (every far town),
   * `far:where:<state>` (a far town in that state: standing, destroyed, abandoned, occupied, vassal, founded,
   * trade-partner, founded-by-player), `far:<id>` (that place, if it exists), `world` (every town, the home town
   * first). Empty: nothing matches (a card naming it does not appear).
   */
  selectTowns(sel: string): EntityId[] {
    const f = this.w.facts;
    const h = this.w.settlement(this.home)!;
    const far = this.ws.settlements
      .filter((s) => s.id !== this.home && !!f.entity(s.id))
      .sort((a, b) => Math.hypot(a.at[0] - h.at[0], a.at[1] - h.at[1]) - Math.hypot(b.at[0] - h.at[0], b.at[1] - h.at[1]) || (a.id < b.id ? -1 : 1));
    const state = (id: EntityId): string => {
      const s = this.w.settlement(id);
      const st = placeState(this.w, id)?.status as string | undefined;
      if (st && st !== 'standing') return st;
      if (f.tag(id, 'condition', 'occupied')?.value) return 'occupied';
      return s?.condition === 'ruined' ? 'destroyed' : s?.condition === 'abandoned' ? 'abandoned' : 'standing';
    };
    if (sel === 'world') return [this.home, ...far.map((s) => s.id)];
    if (sel === 'far:all') return far.map((s) => s.id);
    if (sel === 'far:neighbour') {
      const n = this.neighbour();
      return n ? [n] : [];
    }
    const nearest = /^far:nearest:(\d+)$/.exec(sel);
    if (nearest) return far.filter((s) => state(s.id) === 'standing' && s.size !== 'camp').slice(0, Number(nearest[1])).map((s) => s.id);
    const where = /^far:where:(.+)$/.exec(sel)?.[1];
    if (where === 'trade-partner') return far.filter((s) => this.partners().some((p) => p.id === s.id)).map((s) => s.id);
    if (where === 'founded-by-player') return far.filter((s) => f.relations({ type: 'controls', from: 'player', to: s.id }).length > 0).map((s) => s.id);
    if (where) return far.filter((s) => state(s.id) === where).map((s) => s.id);
    const id = /^far:(.+)$/.exec(sel)?.[1];
    return id && f.entity(id) && this.w.settlement(id) ? [id] : [];
  }

  /** the standing settlement nearest the home town (the neighbour its cards are about); null: none.
   *  FIXED-CITY: "nearest" is measured from the one home town */
  neighbour(): EntityId | null {
    const h = this.w.settlement(this.home)!;
    let best: EntityId | null = null;
    let d = Infinity;
    for (const s of this.ws.settlements) {
      if (s.id === this.home || s.condition === 'ruined' || s.condition === 'abandoned' || !this.w.facts.entity(s.id) || s.size === 'camp') continue;
      const x = Math.hypot(s.at[0] - h.at[0], s.at[1] - h.at[1]);
      if (x < d) [d, best] = [x, s.id];
    }
    return best;
  }

  // ---- the player's moves ---------------------------------------------------------------------------------------------

  /** what is offered now (the dealer's deal), each over its site */
  offers(): Offer[] {
    return this.engine.offered;
  }
  /** the site of the home town an offer stands at */
  siteOf(o: Offer): SiteKey | null {
    return (this.w.facts.entity(o.place)?.attrs?.site as SiteKey | undefined) ?? null;
  }
  /** seasons an offer stays (1: this is the last) */
  left(o: Offer): number {
    return o.expires - this.w.turn + 1;
  }

  /** what an offer needs that isn't free now (empty: it can be committed) */
  short(o: Offer): Partial<Pools> {
    const have = pools(this.led);
    const out: Partial<Pools> = {};
    // (laws: the terms in force, not the printed ones)
    const t = this.terms(o);
    for (const [k, n] of Object.entries(t.locks) as [Pool, number][]) if (have[k] < n) out[k] = n - have[k];
    for (const [g, n] of Object.entries(t.costs)) if (POOL_ROLE[g as Pool] === 'goods' && have[g as Pool] < n) out[g as Pool] = n - have[g as Pool];
    return out;
  }

  /** Commit to an offer: its people locked and goods spent by the contract; a town project adopted by the ledger. */
  commit(id: string): Offer {
    this.w.holdings = this.led.holdings;
    this.rules.begin();
    // (laws: the offer is committed on the terms in force — people locked, goods spent, seasons to build)
    const was = this.engine.offered.find((x) => x.id === id);
    if (was && this.laws().length) {
      const t = this.terms(was);
      was.opp = {
        ...was.opp,
        requires: [...was.opp.requires.filter((q) => q.kind !== 'workers' && q.kind !== 'army'), ...(t.locks.labor ? [{ kind: 'workers' as const, count: t.locks.labor }] : []), ...(t.locks.might ? [{ kind: 'army' as const, count: t.locks.might }] : [])],
        costs: t.costs as Offer['opp']['costs'],
        duration: 'turns' in was.opp.duration ? { turns: t.turns } : was.opp.duration,
      };
    }
    const o = this.engine.commit(id);
    this.sync();
    this.said.push(...this.pump().map((h) => `${h.text}.`));
    const c = cardOfTemplate(o.template);
    if (c) this.led = adopt(this.led, card(c), o.commitment!, o.id, this.season + (o.resolvesTurn! - this.w.turn));
    this.w.holdings = this.led.holdings;
    this.refreshLaws();
    this.dealAsked();
    return o;
  }

  refuse(id: string): Offer {
    const o = this.engine.refuse(id);
    this.sync();
    return o;
  }

  /**
   * The season ends for the opportunities (before the ledger's own season): commitments due resolve into the fact
   * layer, offers past their time fire their expiry, the arc moves on, the next deal is made. Returns the season's news.
   */
  endSeason(): string[] {
    this.w.holdings = this.led.holdings;
    // (the season ended: one cascade of the rules, from the live events' results to the season's turn)
    this.rules.begin();
    // (round 6: a live event still under way is resolved now, from the state it is in)
    const live = this.liveRunning().map((o) => this.finishLive(o.id));
    // (the season's own rules, while its states still hold — a growth rune lasts to this point: one line a firing:
    // what, how much, why)
    const turned = this.fireRules({ on: 'turn', id: `turn:${this.w.turn}` });
    // (laws: goods each season by law)
    const byLaw = Object.entries(lawIncome(this.laws())).flatMap(([k, n]) => {
      const got = n ? this.addPool(k as Pool, n) : 0;
      return got ? [`By law: ${got > 0 ? '+' : ''}${got} ${k.charAt(0).toUpperCase()}${k.slice(1)}.`] : [];
    });
    this.w.holdings = this.led.holdings;
    const before = this.engine.changes.length;
    const past = this.engine.past.length;
    // (the run's last season ends: commitments due resolve and cards run out, and nothing more is dealt)
    const last = this.season >= this.seasons;
    this.last = this.dealt(this.engine.advance(!last));
    this.sync();
    // (the record: the cards resolved or run out this season — a live card's is written when its event ends)
    for (const o of this.engine.past.slice(past)) {
      if (o.status === 'resolved' && this.liveOf(o)) continue;
      if (o.status === 'resolved') this.remember(o, o.commitment?.rolled ?? 'success');
      else if (o.status === 'expired') this.remember(o, 'lapsed');
    }
    this.refreshLaws();
    if (mutators.ready) mutators.season(this.w.turn);
    // (the season's news in the cards' own words: what was done, what was left too long; then the arc's stage)
    const told = this.engine.past.slice(past).flatMap((o) => {
      const t = this.engine.template(o.template);
      const line = o.status === 'resolved' ? t.outcomeText : o.status === 'expired' ? t.expireText : undefined;
      return line ? [text(this.engine.ctx(t, o.bind, o.id), line)] : [];
    });
    const arc = this.engine.changes.slice(before).filter((c) => !/^(resolved|lapsed|committed): /.test(c.what)).map((c) => arcLine(c.what));
    // (the season turns for the rules: each may fire again; then what the season's own events fire)
    this.rules.season(this.w.turn);
    const hits = [...turned, ...this.pump()];
    this.sync();
    const ps = this.partners().filter((x) => x.id !== CAMP_ID);
    const standing = ps.filter((x) => x.standing).length;
    const fewer = this.partnersWere >= 0 && standing < this.partnersWere && ps.length ? [`Fewer wagons come by the trade road: ${standing} of ${ps.length} towns on it still stand.`] : [];
    this.partnersWere = ps.length ? standing : -1;
    this.news = [...live.flatMap((r) => r.lines), ...told, ...arc, ...this.said.splice(0), ...hits.map((h) => `${h.text}.`), ...byLaw, ...fewer];
    // (the run reached its end with nothing else ending it: a plain ending, in the record like any other)
    if (last && !this.ended && !this.won()) this.endRun('stood', STOOD, 'the last season');
    return this.news;
  }

  /** after the ledger's season (income in, people back from the fight): the deal again over what is free now */
  afterSeason(l: SeasonLedger): void {
    this.ledger = l;
    this.dealDue = false;
    this.refreshLaws();
    // (a run that is over deals nothing more)
    if (this.over) return this.sync();
    this.last = this.dealt(this.engine.redeal());
    this.sync();
  }

  /**
   * (card-table) The player resolves a live event under way now, with the casts made so far, in place of waiting for
   * the season's end: one player action (a cascade). Its result rules fire, and a card a rule starts or offers is
   * dealt at once — a chain's next step is on the table this season.
   */
  resolveNow(id: string): LiveReport {
    this.w.holdings = this.led.holdings;
    this.rules.begin();
    const rep = this.finishLive(id);
    this.sync();
    this.refreshLaws();
    this.dealAsked();
    return rep;
  }

  /**
   * The threat that stands longest on the board now, with its own countdown — the header's line ("Raiders on the road:
   * 12 seasons left"). Any threat counts: the raiders' standing card, a pack's final threat; the one with the most
   * seasons left is shown. Null: none stands.
   */
  standingThreat(): { id: string; template: string; title: string; left: number } | null {
    const all = this.engine.offered.filter((o) => {
      const t = this.engine.template(o.template);
      return t.threat === true || !!t.expiry;
    });
    const o = all.sort((a, b) => this.left(b) - this.left(a) || (a.id < b.id ? -1 : 1))[0];
    return o ? { id: o.id, template: o.template, title: o.opp.title, left: this.left(o) } : null;
  }

  /** the raiders threaten the town: they are hostile to you and have somewhere to come from (their camp, or a town
   *  they hold that stands) */
  raidersThreaten(): boolean {
    const f = this.w.facts;
    if (!f.entity(RAIDERS_ID) || stanceOf(this.w, RAIDERS_ID, 'player') !== 'hostile') return false;
    if (this.campStands()) return true;
    return f.relations({ type: 'occupies', from: RAIDERS_ID }).some((r) => this.selectTowns('far:where:occupied').includes(r.to));
  }
  private campStands(): boolean {
    const f = this.w.facts;
    return !!f.entity(RAIDERS_CAMP) && !['abandoned', 'destroyed', 'burned'].some((k) => !!f.tag(RAIDERS_CAMP, 'condition', k)?.value);
  }
  /** the signs standing on the towns that were not set for good: [town, sign] */
  private lingering(): [EntityId, (typeof SIGNS)[number]['kind']][] {
    const f = this.w.facts;
    return this.selectTowns('world').flatMap((id) => SIGNS.filter((s) => !!f.tag(id, 'condition', s.kind)?.value && !f.tag(id, 'condition', `${s.kind}${FOR_GOOD}`)?.value).map((s) => [id, s.kind] as [EntityId, (typeof SIGNS)[number]['kind']]));
  }

  /**
   * (draft 8) Between runs: each entry whose conditions hold now is applied, in order, and written to the record as a
   * `between-runs` event (its line the note). Called once, as a new run of a world begins — never during a run, never
   * when a saved run is taken up again. Deterministic: the entries in order, the towns nearest first.
   */
  private betweenRuns(defs: readonly BetweenDef[]): void {
    const stage = this.stage();
    const b = { town: this.home };
    for (const d of defs) {
      const cause = `between:${d.id}`;
      if (!d.when.every((p) => holds({ w: this.w, b, cause, stage }, p))) continue;
      applyBatch(this.w, d.do, b, cause, undefined, { stage });
      this.w.facts.record({ kind: BETWEEN, by: [], to: [this.home], about: { thing: d.id }, note: d.say });
    }
  }

  /** the run is over: its last season has ended, or an effect, a rule or a law ended it */
  get over(): boolean {
    // (laws: a run won by an achievement is over too)
    return this.season > this.seasons || this.ended !== null || this.won() !== null;
  }

  // ---- the record -----------------------------------------------------------------------------------------------------

  /** this run's events, oldest first (the end-of-run screen reads it; nothing else is kept of "what you caused") */
  history(all = false): FactEvent[] {
    return this.w.facts.events().filter((e) => all || e.turn > this.t0);
  }

  /** the world to save: the fact layer, the characters, the holdings (WorldState's own snapshot) */
  snapshot(): WorldSnapshot {
    return this.ws.snapshot();
  }
}

/** a bound name ('$site') or an id, as an id */
function refOf(b: Record<string, EntityId>, r: string | number | undefined): EntityId {
  const s = String(r ?? '');
  return s.startsWith('$') ? (b[s.slice(1)] ?? s) : s;
}

/** the arc's change line ("The raiders on the road: Scouts on the road — its text") as its text */
function arcLine(what: string): string {
  const i = what.indexOf(' — ');
  const t = i >= 0 ? what.slice(i + 3) : what;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * (LS-16) Where the camera looks down a road before a raid is called on it. `road`: its points from the town outward,
 * ending where the town's box does; `sure`: the cells round the camera's target the world's window is sure to hold.
 * The point `sure` back from the road's end, measured along each axis: the window then holds the road from there to
 * its end — the stretch a spawn point stands on (past the town's limit, short of the road's end). A road shorter than
 * that: its first point. Null: no road.
 */
export function roadLook(road: readonly (readonly [number, number])[], sure: number): [number, number] | null {
  if (road.length < 2) return null;
  const end = road[road.length - 1];
  for (let i = road.length - 1; i >= 0; i--) {
    if (Math.max(Math.abs(road[i][0] - end[0]), Math.abs(road[i][1] - end[1])) >= sure) return [road[i][0], road[i][1]];
  }
  return [road[0][0], road[0][1]];
}
