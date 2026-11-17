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
import { text, type Ctx, type Helper, type Stage } from '../living/dsl';
import { LivingEngine, outcomesOf, type EngineReport, type Offer, type TemplateDef, type EngineState } from '../living/engine';
import { idleState, liveDerive, liveNames, liveRead, liveTier, type LiveDef, type LiveState, type LiveVars } from '../living/live';
import { RuleBook, type RuleHit, type RuleOccasion, type RuleState, type Thing } from '../living/rules';
import type { Tier } from '../api/contracts/opportunity';
import { seedLocus } from '../living/seed';
import { FactWorld } from '../living/world';
import { OPP_TUNE, type DealerTune } from '../opps/tune';
import { CATALOG, card } from './catalog';
import { hasLand, type Land } from './deal';
import { adopt, lose, grant, pools, total, POOL_ROLE, type Pool, type Pools, type SeasonLedger } from './ledger';
import { cardOfTemplate, projectTemplate, raidArc, siteId, SITES, WORLD_TEMPLATES, type SiteKey } from './realm-templates';
import { RUIN, RULES, SITE_TAGS, TIMED } from './realm-rules';
import { FIRE_TEMPLATE } from './realm-events';
import { placeState } from '../mutate/facts';
import { military, SQUAD } from './war';
import { mutators, type Mutation, type PhysicalKind } from '../mutate';
import { recordMutation } from '../mutate/facts';
import '../mutate/outcomes';
import { ROW_H } from '../world/lattice';

/** seasons to the run's major threat (a knob; 16 is the orchestrator's number, not the user's) */
export const RUN_SEASONS = 16;
/** the projects and ventures on offer at once (the dealer's resource limit, counted over what still stands). With the
 *  dealer's one guarantee (a card that answers the run's threat) and the one threatening card a season's schedule lets
 *  stand, a season asks at most BOARD + 2 things of the player, however long the run or large the holdings */
export const BOARD = 3;
/** seasons before the attack from which the raiders can be paid off */
export const TRIBUTE_SEASONS = 3;

/** 'heatray': unlocked by the tower's lens, cast in a fight. The three every leader has: 'fire' (cast in a live event:
 *  it sets what will burn alight and burns the dead), 'rain' (a storm over the tap: it puts a fire out), 'growth' (a
 *  rune over a field, any season: the plants there grow and the field is 'growth-active' until the season ends) */
export type SpellId = 'heatray' | 'fire' | 'rain' | 'growth';
export const BASIC_SPELLS: readonly SpellId[] = ['fire', 'rain', 'growth'];
/** what a cast costs in Magic (a tunable: BACKLOG LS-66) */
export const SPELL_COST: Record<SpellId, number> = { heatray: 1, fire: 1, rain: 1, growth: 1 };
/** far towns that count as trade partners once the trade route is built: the nearest so many */
export const PARTNERS = 3;
/** the refugees' camp (by the east fields since round 7), as a thing of the fact world */
export const campId = (home: string): string => `camp:${home}`;
/** (loop round 7, LS-67) how far out from its site the refugees' tents stand (world units): a first guess, tunable */
const CAMP_OUT = 20;
/** (loop round 7, LS-67) the site the refugees camp by: the east fields (open, dry; the reeve puts them to work there) */
const CAMP_SITE: SiteKey = 'fields';

/** a live event as the scene tells it: its state, where it was (world cells [x, row]), the way its marchers took, and
 *  the hazard's points that burned */
export interface LiveTold {
  state: LiveState;
  at?: readonly [number, number];
  route?: readonly [readonly [number, number], readonly [number, number]];
  burned?: readonly (readonly [number, number])[];
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
  averted: boolean;
  fight: Realm['fight'];
  /** each land change's place in the player's words (a mutation's id → "the old dam") */
  where: [string, string][];
  engine: EngineState;
  /** (round 6) the synergy rules' firings this season, and the history's events they have seen */
  rules?: RuleState;
  seen?: number;
  /** the trade partners standing when the season began (the news says when one is gone) */
  partners?: number;
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
  /** the attack due now (its size), once the arc's last stage lands */
  raid: number | null = null;
  /** the threat is over: fought, or paid off */
  fight: { raiders: number; left: number; fallen: number; held: boolean } | null = null;
  averted = false;
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
    if (!f.entity(RAIDERS_ID)) f.add({ id: RAIDERS_ID, kind: 'army', name: 'the raiders', cause: 'realm' });
    // (the home town's sites: named buildings and districts a card stands at — once a world)
    const region = this.w.settlement(o.home)!.region;
    for (const s of SITES) if (!f.entity(siteId(o.home, s.key))) f.add({ id: siteId(o.home, s.key), kind: 'site', name: s.name, at: { region, settlement: o.home }, attrs: { site: s.key, what: s.kind }, cause: 'realm' });
    const res = o.resume;
    if (res) {
      // (a run under way: its turn is the saved world's, its own state as saved)
      this.t0 = res.t0;
      this.spells.push(...res.spells);
      this.raid = res.raid;
      this.averted = res.averted;
      this.fight = res.fight;
      for (const [k, v] of res.where ?? []) this.whereOf.set(k, v);
      this.partnersWere = res.partners ?? -1;
    } else {
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
    // (the live fire is dealt only when asked for: realm-events.ts FIRE_TEMPLATE, BACKLOG LS-63)
    const world = o.liveFire ? [...WORLD_TEMPLATES.filter((t) => t.id !== 'fire-wards'), FIRE_TEMPLATE] : WORLD_TEMPLATES;
    const templates: TemplateDef[] = [...CATALOG.map(projectTemplate).filter((t): t is TemplateDef => t !== null), ...world];
    // (the arc's turns are the history's: this run's seasons after the turn it began at)
    const rel = raidArc(o.home, this.seasons);
    const arc = { ...rel, stages: rel.stages.map((s) => ({ ...s, turn: this.t0 + s.turn })) };
    // (the arc's entity is the world's: a new run's arc starts from its first stage)
    const old = f.entity(`arc:${arc.id}`);
    if (old && !res) old.attrs.stage = -1;
    this.engine = new LivingEngine(this.w, templates, arc, o.home, {
      stage: this.stage(),
      tune: o.tune ?? (() => ({ ...OPP_TUNE.dealer, reach: Number.MAX_VALUE, resourceMax: BOARD })),
      economy: false,
      limitBoard: true,
      threatMax: 1,
      // (round 7, LS-73: the board, the threat and the arc's card — five things asked at most, whatever the guarantee adds)
      boardMax: BOARD + 2,
      rng: () => 0,
      liveNumbers: Object.keys(this.runNumbers()),
    });
    this.rules = new RuleBook(RULES, { things: () => this.things(), pool: (k) => pools(this.led)[k as Pool] ?? 0, gain: (k, n) => this.addPool(k as Pool, n) });
    if (res?.rules) this.rules.load(res.rules);
    else this.rules.season(this.w.turn);
    this.seen = res?.seen ?? this.w.facts.events().length;
    if (res) {
      this.engine.load(res.engine);
      this.last = { turn: this.w.turn, dealt: [], kept: this.engine.offers, notProposed: [], dealer: null, evaluated: { templates: 0, of: 0, changed: 0 }, ms: 0 };
    } else this.last = this.engine.deal();
    this.sync();
  }

  /** the run as it stands, to save beside the world's snapshot (`RealmOptions.resume` takes it up) */
  runState(): RunState {
    return { v: 1, leader: this.leader.id, seasons: this.seasons, t0: this.t0, spells: [...this.spells], raid: this.raid, averted: this.averted, fight: this.fight, where: [...this.whereOf], engine: this.engine.state(), rules: this.rules.save(), seen: this.seen, partners: this.partnersWere };
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
      // (built card: the town has built it)
      built: { pred: (_c, a) => this.led.built.includes(String(a[0])) },
      threatComing: { pred: () => !this.averted && !this.fight && this.raid === null },
      threatNear: { pred: () => this.seasons - this.season < TRIBUTE_SEASONS },
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
      raid: { effect: (c, a) => void (c.dry || this.averted || (this.raid = Number(a[0]))) },
      avert: { effect: (c) => void (c.dry || (this.averted = true)) },
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
          const cell = this.cellOf('hills');
          const purpose = a[2] === 'mining' ? ('mining' as const) : undefined;
          const spec = { kind: 'founded' as const, place: id, cell, radius: 30, strength: 1, by: 'player', name: String(a[1]), size: 'camp' as const, ...(purpose ? { purpose } : {}) };
          const fact = recordMutation(c.w, spec, { cause: c.cause, regionAt: this.o.regionAt ?? (() => this.w.settlement(this.home)!.region) });
          if (!c.dry && mutators.ready) mutators.apply({ kind: 'founded', place: id, at: cell, radius: 30, by: 'player', name: spec.name, size: 'camp', ...(purpose ? { purpose } : {}), cause: c.cause, fact });
        },
      },
    };
    return { helpers };
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
    return { raid: this.raid ?? 0, soldiers: military(this.led) ? p.might * SQUAD : 0, watchers: 4 + 2 * Math.min(3, houses) };
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
    const f = this.w.facts;
    const l = this.led;
    const out: Thing[] = [];
    const h = this.w.settlement(this.home)!;
    const ruinOf = (id: EntityId) => RUIN.filter((k) => !!f.tag(id, 'condition', k)?.value);
    const timed = (id: EntityId) => TIMED.filter((k) => Number(f.tag(id, 'condition', k)?.value ?? -1) >= this.w.turn);
    for (const s of SITES) {
      const id = siteId(this.home, s.key);
      if (!f.entity(id)) continue;
      const ruin = ruinOf(id);
      const meta = SITE_TAGS[s.key];
      const tags = ruin.length ? ['ruined', ...ruin] : [...meta.is, 'standing', ...(meta.built && l.built.includes(meta.built) ? ['worked'] : []), ...timed(id)];
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
    return hits;
  }

  /** the history's new events as triggers (a rule's own record is never one), each once */
  private pump(): RuleHit[] {
    const hits: RuleHit[] = [];
    const evs = this.w.facts.events();
    const fresh = evs.slice(this.seen);
    this.seen = evs.length;
    for (const e of fresh) if (e.kind !== 'rule-fired') hits.push(...this.fireRules({ on: { event: e.kind } }));
    // (the rules' own records are seen, and trigger nothing)
    this.seen = this.w.facts.events().length;
    return hits;
  }

  // ---- live events (living/live.ts; the scene's runner plays them: scenes/level/live-runner.ts) ------------------------

  /** a template's live event, or null */
  liveOf(o: Offer): LiveDef | null {
    return this.engine.template(o.template).play?.event ?? null;
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
    const hits = this.fireRules({ on: { live: def.tag }, vars, at: this.posOf(how.at ?? this.cellOf(site ?? 'market')), route: how.route ? [this.posOf(how.route[0]), this.posOf(how.route[1])] : null });
    const out = liveDerive(def, vars);
    const tier = liveTier(def, out);
    this.liveOut.set(id, out);
    this.w.holdings = this.led.holdings;
    this.engine.resolve(id, tier);
    this.sync();
    hits.push(...this.pump());
    const oc = outcomesOf(t)[tier] ?? outcomesOf(t).success;
    const title = text(this.engine.ctx(t, o.bind, o.id), t.title);
    const lines = [...(oc ? [text(this.engine.ctx(t, o.bind, o.id), oc.text)] : []), ...hits.map((h) => `${h.text}.`)];
    console.log(`[realm] live event ${o.template}: ${tier} ${JSON.stringify(out)}${hits.length ? ` rules: ${hits.map((h) => h.rule).join(', ')}` : ''}`);
    return { id, template: o.template, title, tier, vars: out, lines, hits };
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
    this.addPool('magic', -cost);
    const at = site ? siteId(this.home, site) : this.home;
    if (spell === 'growth' && site) this.mark(at, 'growth-active', 'spell');
    this.w.facts.record({ kind: 'spell-cast', by: ['player'], to: [at], note: spell === 'growth' ? `you drew a growth rune over ${this.w.name(at)}` : `you cast ${spell} at ${this.w.name(at)}` });
    this.said.push(...this.pump().map((h) => `${h.text}.`));
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
    for (const r of o.opp.requires) {
      const k: Pool | null = r.kind === 'workers' ? 'labor' : r.kind === 'army' ? 'might' : null;
      if (k && have[k] < r.count) out[k] = r.count - have[k];
    }
    for (const [g, n] of Object.entries(o.opp.costs ?? {})) if (POOL_ROLE[g as Pool] === 'goods' && have[g as Pool] < n) out[g as Pool] = n - have[g as Pool];
    return out;
  }

  /** Commit to an offer: its people locked and goods spent by the contract; a town project adopted by the ledger. */
  commit(id: string): Offer {
    this.w.holdings = this.led.holdings;
    const o = this.engine.commit(id);
    this.sync();
    this.said.push(...this.pump().map((h) => `${h.text}.`));
    const c = cardOfTemplate(o.template);
    if (c) this.led = adopt(this.led, card(c), o.commitment!, o.id, this.season + (o.resolvesTurn! - this.w.turn));
    this.w.holdings = this.led.holdings;
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
    // (round 6: a live event still under way is resolved now, from the state it is in)
    const live = this.liveRunning().map((o) => this.finishLive(o.id));
    // (the season's own rules, while its states still hold — a growth rune lasts to this point: one line a firing:
    // what, how much, why)
    const turned = this.fireRules({ on: 'turn' });
    this.w.holdings = this.led.holdings;
    const before = this.engine.changes.length;
    const past = this.engine.past.length;
    this.last = this.engine.advance();
    this.sync();
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
    this.news = [...live.flatMap((r) => r.lines), ...told, ...arc, ...this.said.splice(0), ...hits.map((h) => `${h.text}.`), ...fewer];
    return this.news;
  }

  /** after the ledger's season (income in, people back from the fight): the deal again over what is free now */
  afterSeason(l: SeasonLedger): void {
    this.ledger = l;
    this.last = this.engine.redeal();
    this.sync();
  }

  /** seasons until the raiders attack (0: this season); null: paid off, or fought */
  threatIn(): number | null {
    return this.averted || this.fight ? null : Math.max(0, this.seasons - this.season);
  }

  /** the run is over: the threat fought or paid off */
  get over(): boolean {
    return this.fight !== null || (this.averted && this.season >= this.seasons);
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
