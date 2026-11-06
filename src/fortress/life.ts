// The fortress's people (fortress slice 1; milestone 2 "workers build the plan", milestone 3 "the economy feeds the
// building"). Adapted from settle/life.ts's phase machine and its IO (take, fell, the trees in reach): every person is a
// unit; a pure JobBoard (economy.ts) gives each one a job from the jobs open (a built block of a farm, quarry or lumber
// camp gives its type's jobs; the builders' while there's something to build), in priority order (defs.ts JOB_ORDER):
//  - builders walk to the warehouse, take a load out of the stores (what the next block still lacks), carry it to that
//    block and work it in; a block stands when its cost is in (Town.add). Blocks go up in BuildCrew's order;
//  - miners walk to the quarry's built cells and dig: the ground itself is taken (terrain take, a real pit that deepens;
//    round 128m: tier by tier down the plan's pit, its ramps spiralling down the sides — quarry.ts QuarryDig); after a
//    load's work they carry stone, a share of it ore, up the ramps to the warehouse;
//  - woodcutters walk to a tree in their lumber camp's reach (it grows with the camp's size), fell it (the plants'
//    fell: the tree goes) and carry its logs to the warehouse;
//  - grain grows on the farms' built cells (their type's rate); farmers reap it and carry it to the warehouse;
//  - (round 128l, milestone 4) smiths fetch a batch of the blacksmith's recipe (ore and wood) from the stores, carry it
//    to the smithy, work it there and carry the weapon back (recipes.ts RecipeRunner over data/recipes/fortress.json);
//    recruits fetch a weapon, carry it to the barracks and drill: the villager becomes a soldier (a guard unit, steel,
//    at the barracks). Soldiers muster at the barracks (a drill each morning), march by road to the foot of the wall's
//    stairs and walk the wall-walk (the units' own goal fields: AgentUnits 'go'), then muster again;
//  - (round 128l, m4) carts: a long haul (a quarry, lumber camp or farm over ECON.cartDist from the stores) is left on the
//    structure's pile and a cart — slower, a bigger load, roads only — rides out for it and back; short hauls are walked;
//  - (m4) newcomers walk in from the window's edge where the roads come nearest it, and ride the roads to a house;
//  - people with no work go home and wait.
// Goods come in only that way: nothing by rates. A load that doesn't fit the stores' room isn't started (the bar says
// the stores are full). People eat grain (ECON.eat a day each). While there's a bed free and grain in the stores, a
// newcomer walks in from the edge of the box, along the roads where there are any. Erase gives back half a built
// block's cost, and all that was brought to a block not yet built (as far as the stores' room takes it).
//
// The walking is the agents' (units/agent-units.ts): each leg a shared field (life.ts's groups): the warehouse (F.pile),
// the blocks lacking stone (F.site) or wood (F.store), the quarry's cells (F.quarry), the trees in reach (F.fell), the
// farms (F.farm), the houses (F.home). Roads cost less to walk in every field (Agents.setRoads, FT-46).
// (round 128i, V128-14) The legs to the stores, the houses and the farms ride the road graph instead when every goal of
// theirs is by it (Agents.ride: the shared road field onto the network, the roads, a straight last leg) — their own
// fields unseeded; the legs to the sites, the trees and the quarry keep their fields.
//
// It runs the pinned settlement's units in place of a SettlementLife (Settlements.pin(id, true)): the two share those
// fields and groups (FORTRESS_SLICE1 correction 1), so they never run together.
import type { Good, Goods } from '../api/contracts/fortress';
import type { FactionId } from '../api/contracts/world';
import type { UnitId, V2 } from '../api/contracts/units';
import { buildOrder } from '../agents/buildcrew';
import type { Block } from '../build/town';
import { R } from '../settle/life';
import { F, G, type AgentUnits, type Routine, type UnitRec } from '../units/agent-units';
import { ROAD_FIELD } from '../agents/agents';
import { noGraph, type RoadGraph } from '../agents/roadgraph';
import { DEFS, ECON } from './defs';
import { builtBlocks, cartsOf, eaten, fits, grown, haulBy, JobBoard, jobSlots, mayArrive, putIn, quarryLoad, reachOf, refundOf, workSeconds, type JobKind, type JobSlot } from './economy';
import { nearestNode, nodeCount } from '../agents/roadgraph';
import { ROW_H } from '../world/lattice';
import { RecipeRunner, type TrainRoom } from './recipes';
import type { Structure } from '../api/contracts/fortress';
import type { Erased, Fortress } from './fortress';
import { WAY_ROAD } from './ways';
import { cellAt } from '../world/lattice';
import type { Doing, PersonFacts } from './follow';
import type { FortressRaid } from './raiders';
import { BuildBook, type Load } from './work';
import { QuarryDig } from './quarry';

/** goods a builder carries a trip */
export const LOAD = 3;
/** seconds working a load in */
const WORK_S = 1.5;
/** how near the heap counts as there (world units) */
const THERE = 2.4;
/** how near a block's middle a builder works it in (it stands outside the cell: a cell is ~5 across) */
const REACH = 5;
/** how near a work spot (a quarry or farm cell's middle, a tree) counts as there */
const AT_SPOT = 3;
/** blocks seeded as sites at once (the builders' field leads to the nearest) */
const SITES = 6;
/** seeds a field at most (the agents hold 48 in all) */
const SEEDS = 6;
/** sim seconds between the JobBoard's turns (and the roads'), the trees' looks */
const JOBS_S = 1;
/** the most grain a farm holds ripe: this many days of its growth */
const RIPE_DAYS = 3;

/**
 * (round 128l, milestone 4) The fortress's own groups past the settlements' (settle/life.ts R: 8-15; agents MAX_GROUPS
 * 24): the legs to the smithy and the barracks, the soldiers' march to the wall's stairs. They ride the road graph only
 * (Agents.ride: no fields of their own — V128-14, "we only need the flow fields where they go off tracks"); a leg whose
 * goals no road reaches waits where it is.
 */
export const R4 = { toSmith: 16, toBarracks: 17, toPost: 18, cart0: 19 } as const;
/** (m4) the carts' own groups (each rides to its own pile): cart0 .. cart0 + ECON.cartsMax - 1 */
const CART_GROUPS = 3;
/** (m4) a person's day (a share of ECON.daySec): a meal at the stores from EAT_FROM (EAT_S s), home to rest from REST_FROM */
const EAT_FROM = 0.45;
const EAT_S = 2;
const REST_FROM = 0.9;
/** (m4, follow) what each thing a person does counts as in its day */
const DAY_WORD: Record<Doing, string | null> = {
  home: 'home', rest: 'home', idle: null, arrive: 'the road in', 'build-fetch': 'work', 'build-carry': 'work', 'build-work': 'work',
  'to-work': 'work', work: 'work', haul: 'haul', eat: 'eat', fetch: 'work', drill: 'drill', muster: 'muster', march: 'march', wall: 'the wall',
  'cart-park': 'the stores', 'cart-out': 'the road', 'cart-load': 'loading', 'cart-back': 'the road',
};
/** (m4) a pile's road node at most this far from the structure's door (m) */
const PILE_ROAD = 14;
/** (m4) sim seconds a soldier may take to a wall-walk point before it gives up and musters again */
const PATROL_STUCK = 40;

export interface FortressLifeIO {
  units: AgentUnits;
  fort: Fortress;
  /** the settlement whose people they are */
  settlement: string;
  faction: FactionId | null;
  /** the town's own heap (window coordinates now): the stores until a warehouse stands */
  townHeap(): V2;
  /** the town's own houses' doors (window coordinates now) */
  homes(): V2[];
  /** the stores now */
  stores(): Goods;
  /** goods taken out of the stores (negative: put in) */
  take(good: Good, amount: number): void;
  /** the `n` nearest trees within r of a point (window coordinates), nearest first, asked of the GPU (api/plants.ts
   *  treesNear; round 128o DA-B6); null: the window moved while it was asked (looked at again next turn) */
  trees(at: V2, r: number, n: number): Promise<V2[] | null>;
  /** a tree felled: its logs (0: none there) */
  fell(at: V2): Promise<number>;
  /** ground dug out at a point (the world API's terrain take: quiet, sim/sleep.ts touch): how much came */
  dig(at: V2, amount: number): Promise<number>;
  /** the ground's top now at window world (x, y) */
  ground(x: number, y: number): number;
  /** the sim's speed: the units' steps come in wall time (0 while planning) */
  speed(): number;
  /** (round 128m) wake the ground round window world (x, y) within r: a pit's tier dug, its walls' stability checked */
  settle?(x: number, y: number, r: number): void;
  /** (round 128m) the surface read `top` answers from (a new object each read) */
  groundRead?(): unknown;
  /** (round 128m) the ground's top now at window world (x, y), loose ground on it too (null: not read yet); none: `ground` */
  top?(x: number, y: number): number | null;
}

type Phase = 'rest' | 'eat' | 'idle' | 'home' | 'wait' | 'toPile' | 'toSite' | 'working' | 'toWork' | 'gather' | 'lifting' | 'carry' | 'fetch' | 'muster' | 'drill' | 'march' | 'patrol' | 'arrive' | 'park' | 'out' | 'load' | 'back';
interface Work {
  phase: Phase;
  t: number;
  /** the JobBoard's key: 'build', `s<id>`; null: no work */
  job: string | null;
  /** a builder's block and load */
  block?: Block;
  load?: Load | null;
  /** a worker's goods on their way to the stores, and the structure they're from */
  goods?: Goods | null;
  from?: number | null;
  /** where it gathers (a cell's middle, a tree) */
  where?: V2;
  /** seconds to the miner's next dig */
  dig?: number;
  /** (m4) a soldier's wall-walk points walked */
  walked?: number;
  /** (m4) the economy day it last ate */
  ate?: number;
  /** (round 128m) a miner gone on to another part of the pit mid-load: its load's work carries on there */
  moved?: boolean;
}

/** what a worker carries, drawn */
const LOOK: Partial<Record<Good, string>> = { stone: 'stone', ore: 'stone', log: 'log', grain: 'sand', weapons: 'steel' };

export class FortressLife implements Routine {
  readonly ids: UnitId[] = [];
  readonly book: BuildBook;
  /** loads brought, blocks built, waits at the heap with nothing to take; (milestone 3) trips in, ground dug, trees felled, newcomers, refunds */
  readonly stats = { trips: 0, built: 0, starved: 0, hauled: 0, dug: 0, felled: 0, arrived: 0, refunds: 0, forged: 0, trained: 0, mustered: 0, patrols: 0, onWall: 0, carted: 0, cartLoads: 0, piled: 0 };
  /** (round 128l, milestone 4) the recipes: the smiths' batches, the recruits' */
  readonly recipes = new RecipeRunner();
  /** (m4) the soldiers the barracks trained (guards: not people — no job, no bed of the houses', no grain) */
  readonly soldiers: UnitId[] = [];
  /** (m4) recruits done drilling: made soldiers at the next update (not inside the units' step) */
  private enlisting: UnitId[] = [];
  /** (m4) soldiers on the wall-walk (the units' own 'go' orders): the point each heads for */
  private patrol = new Map<UnitId, { at: V2; walked: number; since: number }>();
  /** (m4) the carts (not people: no bed, no grain, no job) and the goods waiting on each structure's pile for one */
  readonly carts: UnitId[] = [];
  readonly piles = new Map<number, Goods>();
  /** (m4, follow) what each person did today, in order (repeats folded): the card's "Today" */
  private today = new Map<UnitId, string[]>();
  private todayN = 0;
  /** (m4) per cart group whether it rides now (reseed) */
  private cartRiding: boolean[] = [];
  /** (m4) carts sent onto the road by a goal order (stepCart), each back to its round once there */
  /** (m4) per cart group the pile its ride was last made for (reseed): a ride not made for it — no road reaches it */
  private cartRideFor: (number | null)[] = [];
  /** (m4) structures no cart's road reaches (its ride failed): their workers walk their hauls */
  private noCartRoad = new Set<number>();
  private day = 0;
  readonly board = new JobBoard();
  /** (round 128l, m4: the attack wave) the raid (raiders.ts): its raiders and its rider are stepped through this routine */
  raid: FortressRaid | null = null;
  /** (m4) raiders are about: the villagers stay home (FortressRaid sets it) */
  shelter = false;
  /** (m4) the villagers in at home while raiders are about: nobody fights them there (FortressRaid.mayFight) */
  readonly inside = new Set<UnitId>();
  /** (m4) the doors of houses set alight (FortressRaid): nobody goes home to them */
  unsafe: V2[] = [];
  /** (scripted checks) where the last trees were felled */
  readonly felledAt: V2[] = [];
  private seeded = '';
  /** (round 128i, V128-14) the road graph the last seeding saw (a new one: the rides are set again) */
  private seededGraph: RoadGraph | null = null;
  /** (round 128i) the legs that ride the roads now (their own fields left unseeded) */
  riding: { pile: boolean; home: boolean; farm: boolean; smith: boolean; barracks: boolean; post: boolean } = { pile: false, home: false, farm: false, smith: false, barracks: false, post: false };
  private order: Block[] = [];
  private orderAt = -1;
  private t = 0;
  /** (FT-20) the heap's field read back: which sites a builder can walk to from the heap (and where a newcomer may start) */
  /** (round 128n, phonefix) where a newcomer comes in without a road: the reach's answer (undefined: none asked or taken) */
  private entryAnswer: V2 | null | undefined = undefined;
  private entryAsking = false;
  /** (round 128l) the reach's answer the cut-off check last read (Fortress.reachStats.checks), and the cells it found cut off */
  private reachSeen = -1;
  private cutCells = new Set<number>();
  private slots: JobSlot[] = [];
  private jobsAt = -1e9;
  private trees: V2[] = [];
  /** (round 128o, DA-B6) the trees asked of the GPU and not answered yet; what they were last asked for (the lumber
   *  camps and their built blocks, and the day: the woods grow back) — asked again when it changes, or a tree is felled */
  private treesAsked = false;
  private treesFor = '';
  private arriveAt = 0;
  /** per structure: what its workers brought in, its ripe grain (farms) */
  private made = new Map<number, Goods>();
  private ripe = new Map<number, number>();
  /** (round 128m, V128-11) the quarries' pits, dug down tier by tier */
  readonly quarry: QuarryDig;
  private onErased = (e: Erased) => this.refund(e);

  constructor(
    private io: FortressLifeIO,
    people: number,
  ) {
    const fort = io.fort;
    this.quarry = new QuarryDig({ fort, ground: io.top ?? io.ground, dig: io.dig, settle: io.settle, groundRead: io.groundRead });
    this.book = new BuildBook((b) => DEFS[fort.plan.typeAt(b.cell) ?? 'house'].cost);
    const { units } = io;
    units.routine = this;
    const A = units.agents;
    A.follow(R.toPile, F.pile);
    A.follow(R.toSite, F.site);
    A.follow(R.toStore, F.store);
    A.follow(R.toQuarry, F.quarry);
    A.follow(R.toFell, F.fell);
    A.follow(R.toFarm, F.farm);
    A.follow(R.toHome, F.home);
    A.follow(R.working, -1);
    A.workPose(R.working, true);
    // (m4: ride only — reseed)
    for (const g of [R4.toSmith, R4.toBarracks, R4.toPost]) A.follow(g, -1);
    for (let i = 0; i < CART_GROUPS; i++) A.follow(R4.cart0 + i, -1);
    const h = this.heap();
    for (let i = 0; i < people; i++) this.spawn([h[0] + Math.cos(i * 2.4) * 4, h[1] + Math.sin(i * 2.4) * 4], 0.5 + i * 0.4);
    fort.onErased.push(this.onErased);
    this.arriveAt = ECON.arriveSec;
  }

  private spawn(at: V2, wait: number): UnitId {
    const { units } = this.io;
    const id = units.spawn('villager', at, this.io.faction, { settlement: this.io.settlement, role: 'villager', health: 3, job: { kind: 'work', at, what: 'villager' } });
    this.ids.push(id);
    units.recs.get(id)!.work = { phase: 'idle', t: wait, job: null } satisfies Work;
    return id;
  }

  takes(u: UnitRec): boolean {
    return (u.v.settlement === this.io.settlement && u.v.job.kind === 'work') || (this.raid?.takes(u) ?? false);
  }

  /** (m4) the fortress's settlement and faction (the raid's: who is whose) */
  get settlementId(): string {
    return this.io.settlement;
  }
  get faction(): FactionId | null {
    return this.io.faction;
  }

  drop(u: UnitRec): void {
    // (its load is lost with it — the agents drop it on the ground where it fell — but no longer on its way)
    const w = u.work as Work | undefined;
    if (w?.load && w.block) this.book.giveBack(w.block, w.load, {});
    // (m4: a batch fetched and not yet made goes back to the stores)
    this.giveBackBatch(u.v.id);
    this.io.units.carry(u, null);
    u.work = undefined;
  }

  dispose(): void {
    const i = this.io.fort.onErased.indexOf(this.onErased);
    if (i >= 0) this.io.fort.onErased.splice(i, 1);
    for (const id of this.ids) this.io.units.remove(id);
    for (const id of this.soldiers) this.io.units.remove(id);
    for (const id of this.carts) this.io.units.remove(id);
    if (this.io.units.routine === this) this.io.units.routine = null;
    for (const f of [F.pile, F.site, F.store, F.quarry, F.fell, F.farm, F.home]) this.io.units.agents.seed(f, []);
    this.io.units.agents.keepInScope('fortress', []);
    this.io.units.agents.setRoads(new Float32Array(0));
    for (const g of [R.toPile, R.toHome, R.toFarm, R4.toSmith, R4.toBarracks, R4.toPost, ...Array.from({ length: CART_GROUPS }, (_, i) => R4.cart0 + i)]) this.io.units.agents.ride(g, null);
    this.io.units.agents.setRoadGraph(noGraph());
  }

  /** The people alive. */
  people(): UnitId[] {
    return this.ids.filter((id) => this.io.units.get(id)?.alive);
  }

  /** The stores: the first warehouse built (its door), else the town's own heap. */
  heap(): V2 {
    return this.io.fort.storesAt() ?? this.io.townHeap();
  }

  /** The blocks still to build, in order (buildOrder from the heap: lowest first, then nearest). */
  todo(): Block[] {
    if (this.orderAt !== this.t) {
      this.orderAt = this.t;
      const f = this.io.fort;
      const [hx, hy] = f.toBox(...this.heap());
      this.order = buildOrder(f.town, [hx, hy])
        .filter((d) => !d.down)
        .map((d) => d.block);
    }
    return this.order;
  }

  /**
   * The road shapes and the box's offset in the window to the agents (stamped on the GPU when either changed). Each
   * update, and (round 128i, FT-67) from the window's slide itself (level.ts onSlide): the offset moved in the slide's
   * frame, before the agents' next step — update doesn't run while the streamer's busy.
   */
  roads(): void {
    this.io.units.agents.setRoads(this.io.fort.roadShapes(), ...this.io.fort.offset());
    // (round 128i, V128-14: and the road graph the people ride, in the same frame)
    this.io.units.agents.setRoadGraph(this.io.fort.roadGraph(), ...this.io.fort.offset());
  }

  /** each frame (sim time): the economy, the jobs, the newcomers, the fields seeded */
  update(dt: number): void {
    this.t += dt;
    const alive = this.people();
    if (alive.length !== this.ids.length) this.ids.splice(0, this.ids.length, ...alive);
    const armed = this.soldiers.filter((id) => this.io.units.get(id)?.alive);
    if (armed.length !== this.soldiers.length) this.soldiers.splice(0, this.soldiers.length, ...armed);
    this.enlist();
    this.walkTheWalls(dt);
    this.keepCarts();
    this.checkReach();
    // (round 128i, FT-58: the road shapes stamped on the GPU — again only when the lanes or the box's offset change)
    this.roads();
    if (dt > 0) this.economy(dt);
    if (this.t - this.jobsAt >= JOBS_S) {
      this.jobsAt = this.t;
      this.jobs();
      this.quarry.update();
      this.stats.dug = this.quarry.stats.taken;
      // (round 128f: the user, "agents seem to not be able to path through the city or farms to buildings at the
      // peripheral") every block still to build kept in the fields' scope: past the box round the units and the seeds
      // every field reads no way, so a block not yet among the sites read cut off, was never a site, never seeded, never
      // in the scope — cut off for good
      this.io.units.agents.keepInScope('fortress', this.todo().flatMap((b) => this.standsFor(b)));
      // (the JobBoard's turn: whether the camps' trees need asking again)
      this.lookForTrees();
    }
    this.reseed();
    this.writeStatus();
  }

  /** grain grows on the farms and is eaten; a newcomer when there's a bed and grain */
  private economy(dt: number): void {
    const f = this.io.fort;
    const built = (c: number, l: number) => f.town.has(c, l);
    for (const s of f.plan.structures()) {
      if (s.type !== 'farm') continue;
      const n = builtBlocks(f.plan, s, built);
      const max = (DEFS.farm.perBlock.makes?.grain ?? 0) * n * RIPE_DAYS;
      this.ripe.set(s.id, Math.min(max, (this.ripe.get(s.id) ?? 0) + grown(n, dt)));
    }
    const grain = this.io.stores().grain ?? 0;
    const ate = Math.min(grain, eaten(this.ids.length, dt));
    if (ate > 0) this.io.take('grain', ate);
    // (m4: nobody walks in while raiders are about)
    if (!this.shelter && this.t >= this.arriveAt && mayArrive(this.ids.length, f.beds(), this.io.stores().grain ?? 0)) {
      // (undefined: the reach is still being asked where, round 128n — they come once it answers)
      const at = this.entry();
      if (at !== undefined) {
        if (at) {
          const id = this.spawn(at, 0);
          // (m4: by road to a house first)
          (this.io.units.recs.get(id)!.work as Work).phase = 'arrive';
          this.stats.arrived++;
        }
        this.arriveAt = this.t + ECON.arriveSec;
      }
    }
  }

  /** the JobBoard's turn: people to the jobs open */
  private jobs(): void {
    const f = this.io.fort;
    const building = f.mode === 'build' && this.sites().length > 0;
    const st = this.io.stores();
    // (m4) the smiths only while the stores hold a batch of ore and wood, the recruits while there's a weapon and a bed in
    // the barracks — and those with a batch on its way keep their place
    const cap = (s: Structure, n: number): number => {
      if (s.type !== 'blacksmith' && s.type !== 'barracks') return n;
      const busy = this.board.count(`s${s.id}`) && [...this.ids].filter((id) => this.board.jobOf(id) === `s${s.id}` && this.recipes.batchOf(id)).length;
      return this.recipes.canStart(s.type, st, this.trainRoom()) ? n : busy || 0;
    };
    this.slots = jobSlots(f.plan, (c, l) => f.town.has(c, l), building, undefined, undefined, cap);
    const changed = this.board.assign(this.ids, this.slots);
    for (const id of changed) {
      const u = this.io.units.recs.get(id);
      const w = u?.work as Work | undefined;
      if (!w) continue;
      // (m4: a batch fetched for the old job goes back)
      if (this.giveBackBatch(id)) {
        this.io.units.carry(u!, null);
        Object.assign(w, { phase: 'idle', t: 0.2 });
      }
      w.job = this.board.jobOf(id);
      // (one carrying finishes the trip first: the next job after it)
      if (!['toSite', 'working', 'lifting', 'carry'].includes(w.phase)) Object.assign(w, { phase: 'idle', t: 0.2 });
    }
  }

  private slot(key: string | null): JobSlot | null {
    return key === null ? null : (this.slots.find((s) => s.key === key) ?? null);
  }

  /**
   * The trees in the lumber camps' reach, nearest each camp first (12 a camp), asked of the GPU — when the camps or their
   * built blocks change, a tree is felled, or a day passes (the woods grow back by succession): never on a timer of its
   * own (round 128o, DA-B6).
   */
  private lookForTrees(): void {
    if (this.treesAsked) return;
    const f = this.io.fort;
    const camps: { mid: V2; r: number }[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'lumber') continue;
      const n = builtBlocks(f.plan, s, (c, l) => f.town.has(c, l));
      if (!n) continue;
      const cs = [...s.cells.keys()].map((c) => f.centre(c));
      camps.push({ mid: [cs.reduce((a, p) => a + p[0], 0) / cs.length, cs.reduce((a, p) => a + p[1], 0) / cs.length], r: reachOf(n) });
    }
    const key = JSON.stringify([Math.floor(this.t / ECON.daySec), camps.map((c) => [c.mid.map(Math.round), c.r])]);
    if (key === this.treesFor) return;
    this.treesFor = key;
    if (!camps.length) {
      this.trees = [];
      return;
    }
    this.treesAsked = true;
    void Promise.all(camps.map((c) => this.io.trees(c.mid, c.r, 12))).then((got) => {
      this.treesAsked = false;
      // (the window moved while they were asked: asked again next turn)
      if (got.some((g) => g === null)) {
        this.treesFor = '';
        return;
      }
      this.trees = got.flatMap((g) => g!);
    });
  }

  private writeStatus(): void {
    const f = this.io.fort;
    const jobs: Partial<Record<JobKind | 'idle', number>> = {};
    const workers = new Map<number, number>();
    // (round 128e, FT-49) what the builders are doing, for the bar
    const crew = { builders: 0, toStores: 0, carrying: 0, working: 0, waiting: 0 };
    for (const id of this.ids) {
      const s = this.slot(this.board.jobOf(id));
      const k = s ? s.kind : 'idle';
      jobs[k] = (jobs[k] ?? 0) + 1;
      if (s && s.structure !== null) workers.set(s.structure, (workers.get(s.structure) ?? 0) + 1);
      const p = (this.io.units.recs.get(id)?.work as Work | undefined)?.phase ?? 'idle';
      if (k !== 'build' && p !== 'toSite' && p !== 'working') continue;
      crew.builders++;
      if (p === 'toPile') crew.toStores++;
      else if (p === 'toSite') crew.carrying++;
      else if (p === 'working') crew.working++;
      else crew.waiting++;
    }
    f.crew = crew;
    // (m4) the soldiers in the ledger (the bar's and Inspect's: stores.soldiers)
    const had = this.io.stores().soldiers ?? 0;
    if (had !== this.soldiers.length) this.io.take('soldiers', had - this.soldiers.length);
    f.status = {
      people: this.ids.length,
      jobs,
      workers,
      made: this.made,
      ripe: this.ripe,
      full: !fits(this.io.stores(), f.room(), ECON.haul),
      hungry: (this.io.stores().grain ?? 0) < 1,
    };
  }

  /**
   * Where a newcomer starts: in from the edge of the box, as far out as the stores reach (ground a walker can cross to
   * the stores), along the road that reaches farthest out if there are roads, else the first way in. Undefined while
   * the reach is asked (round 128n, phonefix: the fortress's own reach on the GPU, a bit a spot read back — it was the
   * heap's field read whole, 8.2 MB every 500 ms, for this one question).
   */
  private entry(): V2 | null | undefined {
    // (round 128l, m4) where the roads come nearest the window's edge: in from the edge there, toward that road
    const gate = this.edgeEntry();
    if (gate) return gate;
    if (this.entryAnswer !== undefined) {
      const a = this.entryAnswer;
      this.entryAnswer = undefined;
      return a;
    }
    if (!this.entryAsking) {
      this.entryAsking = true;
      void this.askEntry().then((a) => {
        this.entryAnswer = a;
        this.entryAsking = false;
      });
    }
    return undefined;
  }

  /** the spots a newcomer might start at, farthest out first along each way out, and the first the stores reach */
  private async askEntry(): Promise<V2 | null> {
    const f = this.io.fort;
    const h = this.heap();
    const angles: number[] = [];
    const way = f.ways().way;
    let far = -1;
    let fd = 0;
    for (let c = 0; c < way.length; c++) {
      if (way[c] !== WAY_ROAD) continue;
      const [x, y] = f.centre(c);
      const d = Math.hypot(x - h[0], y - h[1]);
      if (d > fd) {
        fd = d;
        far = c;
      }
    }
    if (far >= 0) {
      const [x, y] = f.centre(far);
      angles.push(Math.atan2(y - h[1], x - h[0]));
    }
    for (let k = 0; k < 12; k++) angles.push((k / 12) * Math.PI * 2);
    const half = Math.min(f.box.w, f.box.h * 0.866) / 2;
    const spots: { at: V2; cell: number }[] = [];
    for (const a of angles)
      for (let r = half; r >= 16; r -= 4) {
        const x = h[0] + Math.cos(a) * r;
        const y = h[1] + Math.sin(a) * r;
        const cell = f.cellAt(x, y);
        if (cell >= 0) spots.push({ at: [x, y], cell });
      }
    const cells = [...new Set(spots.map((s) => s.cell))];
    const reached = await f.probeReach(cells);
    if (!reached) return null;
    const ok = new Set(cells.filter((_, i) => reached[i]));
    return spots.find((s) => ok.has(s.cell))?.at ?? null;
  }

  /**
   * (round 128l, m4; the user: "have units come in on the roads") The road graph's node nearest the window's edge, and
   * the point on that edge straight out from it (EDGE_IN in from the edge): a newcomer starts there and walks onto the
   * road. Null: no roads.
   */
  edgeEntry(): V2 | null {
    return this.edgeWay()?.edge ?? null;
  }

  /** (m4) the road graph's node nearest the window's edge (window world), and the point on the edge straight out from it */
  edgeWay(): { edge: V2; node: V2 } | null {
    const f = this.io.fort;
    const g = f.roadGraph();
    const n = nodeCount(g);
    if (!n) return null;
    const W = f.windowDims().w;
    const Hh = f.windowDims().h * ROW_H;
    const IN = 3;
    let best: { edge: V2; node: V2 } | null = null;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const [x, y] = f.toWindow(g.xy[2 * i], g.xy[2 * i + 1]);
      const sides: [number, V2][] = [
        [x, [IN, y]],
        [W - x, [W - IN, y]],
        [y, [x, IN]],
        [Hh - y, [x, Hh - IN]],
      ];
      for (const [d, p] of sides)
        if (d < bd) {
          bd = d;
          best = { edge: p, node: [x, y] };
        }
    }
    return best;
  }

  /**
   * (round 128e, FT-49) Where to look when the builders start: between the stores and the first block they'll build,
   * and how far apart those are (window world).
   */
  focus(): { at: V2; span: number } {
    const h = this.heap();
    const b = this.sites()[0] ?? this.todo()[0];
    if (!b) return { at: h, span: 0 };
    const [x, y] = this.io.fort.centre(b.cell);
    return { at: [(h[0] + x) / 2, (h[1] + y) / 2], span: Math.hypot(x - h[0], y - h[1]) };
  }

  /**
   * (round 128e, FT-50) Why the plan can't be finished now (Skip to done stops on it): every block left is cut off from
   * the stores, or nobody carries a load and the stores lack what the blocks left still need. null: it's going on (or
   * done). (milestone 3: goods still come in from the quarry, the woods and the farms — so short stores only block while
   * nothing of what's lacking is being brought either.)
   */
  blocked(): { cutOff: number } | { short: Goods } | null {
    const todo = this.todo();
    if (!todo.length) return null;
    if (!this.sites().length) return { cutOff: this.unreachable().length };
    const c = this.io.fort.crew;
    if (c && (c.carrying || c.working)) return null;
    const need: Goods = {};
    for (const b of todo) for (const [g, v] of Object.entries(this.book.need(b)) as [Good, number][]) need[g] = (need[g] ?? 0) + v;
    const st = this.io.stores();
    const short: Goods = {};
    for (const [g, v] of Object.entries(need) as [Good, number][]) {
      const s = Math.ceil(v - (st[g] ?? 0));
      if (s > 0) short[g] = s;
    }
    const any = (Object.keys(need) as Good[]).some((g) => (st[g] ?? 0) >= 1);
    const coming = (Object.keys(short) as Good[]).some((g) => this.bringing(g));
    return Object.keys(short).length && !any && !coming ? { short } : null;
  }

  /** (milestone 3) whether anyone works at bringing a good in (a quarry's miners: stone; woodcutters: wood) */
  private bringing(g: Good): boolean {
    for (const s of this.slots) {
      if (this.board.count(s.key) === 0) continue;
      const makes = DEFS[s.kind === 'build' ? 'house' : s.kind].perBlock.makes ?? {};
      if (s.kind !== 'build' && (makes[g] ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * (round 128d, FT-20) The blocks no builder can walk to from the heap. They're left out of the sites (a builder isn't
   * sent with a load it can't bring) and the bar says so (Fortress.cutOff). (Round 128f: by a check on the
   * agents' rules — round 128l: the GPU's components, fortress/reachgpu.ts — not by the heap's GPU field read back: that field fills out
   * from the heap over seconds and starts over when a seed moves or a chunk comes into its scope, and a block read out
   * of it for 8 sim seconds — a moment under Skip — was cut off for good, the user's "agents seem to not be able to path
   * through the city or farms to buildings at the peripheral".)
   */
  unreachable(): Block[] {
    return this.todo().filter((b) => this.isCutOff(b));
  }

  private isCutOff(b: Block): boolean {
    return this.cutCells.has(b.cell);
  }

  /** (round 128l, m4) each time the reach answers (Fortress.requestReach: the GPU's components): the blocks still to
   *  build the stores don't reach */
  private checkReach(): void {
    const f = this.io.fort;
    if (f.reachStats.checks === this.reachSeen) return;
    this.reachSeen = f.reachStats.checks;
    this.cutCells = f.cutCells();
    const n = this.unreachable().length;
    if (n !== f.cutOff) f.setCutOff(n);
  }

  private sites(): Block[] {
    return this.todo()
      .filter((b) => !this.isCutOff(b))
      .slice(0, SITES);
  }

  /** the sites still lacking a good (counting only what's been worked in: loads on their way may yet be moved) */
  private sitesFor(g: Good): Block[] {
    return this.sites().filter((b) => (this.book.need(b, false)[g] ?? 0) > 0);
  }

  /** the built cells' middles of a type's structures (the quarry's, the farms'): where its workers work */
  private cellsOf(type: 'quarry' | 'farm'): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures().sort((a, b) => a.id - b.id)) {
      if (s.type !== type) continue;
      for (const c of s.cells.keys()) if (f.town.has(c, 0)) out.push(f.centre(c));
    }
    return out;
  }

  // ---- (round 128l, milestone 4) the recipes and the soldiers

  /** the barracks' room: soldiers there are and in training, against the barracks' built beds */
  private trainRoom(): TrainRoom {
    const f = this.io.fort;
    let beds = 0;
    for (const s of f.plan.structures()) if (s.type === 'barracks') beds += (DEFS.barracks.perBlock.beds ?? 0) * builtBlocks(f.plan, s, (c, l) => f.town.has(c, l));
    return { units: this.soldiers.length + this.enlisting.length + this.recipes.inProgress('train'), beds };
  }

  /** a person's batch not yet made: its goods back to the stores (true: there was one) */
  private giveBackBatch(id: UnitId): boolean {
    const g = this.recipes.giveBack(id);
    if (!g) return false;
    const went = putIn({ ...this.io.stores() }, this.io.fort.room(), g);
    for (const [k, v] of Object.entries(went) as [Good, number][]) this.io.take(k, -v);
    return true;
  }

  /** (m4) how far through the economy's day it is (0..1) */
  private dayFrac(): number {
    return (this.t % ECON.daySec) / ECON.daySec;
  }

  /** (m4, follow) a word on a person's day (repeats folded; a new day starts a new list) */
  private logDay(id: UnitId, word: string | null): void {
    const n = Math.floor(this.t / ECON.daySec);
    if (n !== this.todayN) {
      this.todayN = n;
      this.today.clear();
    }
    const l = this.today.get(id) ?? [];
    if (word === null) return;
    if (l[l.length - 1] !== word) l.push(word);
    if (l.length > 12) l.shift();
    this.today.set(id, l);
  }

  /** (m4, follow) what a unit is doing now, as the card tells it */
  private doingOf(u: UnitRec): Doing {
    const w = u.work as Work | undefined;
    const p = w?.phase ?? 'idle';
    if (u.v.role === 'cart') return p === 'out' ? 'cart-out' : p === 'load' ? 'cart-load' : p === 'back' ? 'cart-back' : 'cart-park';
    if (u.v.role === 'guard') return u.v.job.kind === 'go' ? 'wall' : p === 'drill' ? 'drill' : p === 'march' ? 'march' : 'muster';
    const kind = this.slot(w?.job ?? null)?.kind;
    switch (p) {
      case 'home': {
        const at = u.v.at;
        return this.homes().some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT) ? 'home' : 'idle';
      }
      case 'rest':
        return 'rest';
      case 'arrive':
        return 'arrive';
      case 'eat':
        return 'eat';
      case 'toPile':
        return 'build-fetch';
      case 'toSite':
        return 'build-carry';
      case 'working':
        return 'build-work';
      case 'fetch':
        return 'fetch';
      case 'toWork':
        return 'to-work';
      case 'gather':
      case 'lifting':
        return kind === 'barracks' ? 'drill' : 'work';
      case 'carry':
        return 'haul';
      default:
        return 'idle';
    }
  }

  /** (round 128l, m4; V128-10) the follow card's facts on a unit of the fortress (null: not one, or gone) */
  personFacts(id: UnitId): PersonFacts | null {
    const u = this.io.units.recs.get(id);
    if (!u?.v.alive || !(this.ids.includes(id) || this.soldiers.includes(id) || this.carts.includes(id))) return null;
    const w = u.work as Work | undefined;
    const slot = this.slot(w?.job ?? null);
    const JOB: Record<string, string> = { build: 'builder', farm: 'farmer', quarry: 'miner', lumber: 'woodcutter', blacksmith: 'smith', barracks: 'recruit' };
    const f = this.io.fort;
    const place = (sid: number | null | undefined) => {
      const s = sid != null ? f.plan.structure(sid) : null;
      return s ? `the ${DEFS[s.type].one}` : null;
    };
    const carrying: Goods = w?.load ? { [w.load.good]: w.load.amount } : (w?.goods ?? {});
    const batch = this.recipes.batchOf(id);
    const kind = u.v.role === 'cart' ? 'cart' : u.v.role === 'guard' ? 'soldier' : 'villager';
    return {
      id,
      kind,
      job: kind === 'villager' && slot ? JOB[slot.kind] : null,
      workplace: kind === 'cart' ? place(w?.from) : place(slot?.structure ?? null),
      doing: this.doingOf(u),
      carrying: batch && w?.phase === 'toWork' ? batch.recipe.in : carrying,
      today: [...(this.today.get(id) ?? [])],
      hungry: (this.io.stores().grain ?? 0) < 1,
      day: Math.floor(this.t / ECON.daySec),
    };
  }

  /** (m4, scripted checks) the carts' state: piles no road reaches, piles given up and until when, their rides */
  cartsState(): { noRoad: number[]; riding: boolean[]; goals: V2[][] } {
    return { noRoad: [...this.noCartRoad], riding: [...this.cartRiding], goals: this.cartGoals() };
  }

  /** (m4) the people, soldiers and carts (the follow's picks) */
  everyone(): UnitId[] {
    return [...this.ids, ...this.soldiers, ...this.carts];
  }

  /** (m4) the carts the fortress has (cartsOf: the town's and one a warehouse block), spawned at the stores */
  private keepCarts(): void {
    const f = this.io.fort;
    const U = this.io.units;
    const alive = this.carts.filter((id) => U.get(id)?.alive);
    if (alive.length !== this.carts.length) this.carts.splice(0, this.carts.length, ...alive);
    let blocks = 0;
    for (const s of f.plan.structures()) if (s.type === 'warehouse') blocks += builtBlocks(f.plan, s, (c, l) => f.town.has(c, l));
    const want = Math.min(CART_GROUPS, cartsOf(blocks));
    while (this.carts.length < want) {
      const h = this.heap();
      const i = this.carts.length;
      // (on the road nearest the stores: a cart starts on the network it rides)
      const g = f.roadGraph();
      const [bx, by] = f.toBox(h[0], h[1]);
      const n = nodeCount(g) ? nearestNode(g, bx, by).node : -1;
      const base: V2 = n >= 0 ? f.toWindow(g.xy[2 * n], g.xy[2 * n + 1]) : h;
      const at: V2 = [base[0] + Math.cos(i * 2.1) * 1.5, base[1] + Math.sin(i * 2.1) * 1.5];
      const id = U.spawn('cart', at, this.io.faction, { settlement: this.io.settlement, role: 'cart', health: 6, job: { kind: 'work', at, what: 'cart' } });
      U.recs.get(id)!.work = { phase: 'park', t: 1, job: null } satisfies Work;
      this.carts.push(id);
    }
  }

  /** (m4) the pile a cart goes for: the fullest no other cart is after, with a load's worth on it (null: none) */
  private pileFor(self: UnitId): number | null {
    const taken = new Set(this.carts.filter((c) => c !== self).map((c) => (this.io.units.recs.get(c)?.work as Work | undefined)?.from).filter((x) => x != null));
    let best: number | null = null;
    let most = ECON.cartLoad / 2 - 1e-6;
    for (const [id, g] of this.piles) {
      if (taken.has(id) || this.noCartRoad.has(id) || !this.pilePoint(id)) continue;
      const n = Object.values(g).reduce((a, b) => a + (b ?? 0), 0);
      if (n > most) {
        most = n;
        best = id;
      }
    }
    return best;
  }

  /**
   * (m4) Where a cart loads a structure's pile: the road's node nearest its door (within PILE_ROAD m) that isn't on a
   * cell the plan digs (a quarry's) — the footprint's road edge. A quarry's door is a cell of its pit, which its miners
   * dig deeper while a cart stands in it: a cart that drove into the pit never climbed out (the lab, round 128l). Null:
   * no such node — no cart serves it, its workers walk their hauls.
   */
  private pilePoint(id: number): V2 | null {
    const f = this.io.fort;
    const door = f.doorOf(id);
    const g = f.roadGraph();
    if (!door || !nodeCount(g)) return null;
    const [dx, dy] = f.toBox(door[0], door[1]);
    let best: V2 | null = null;
    let bd = PILE_ROAD;
    for (let v = 0; v < nodeCount(g); v++) {
      const x = g.xy[2 * v];
      const y = g.xy[2 * v + 1];
      const d = Math.hypot(x - dx, y - dy);
      if (d > bd) continue;
      const c = f.grid.cellAtWorld(x, y);
      if (c >= 0 && f.plan.typeAt(c) === 'quarry') continue;
      bd = d;
      best = f.toWindow(x, y);
    }
    return best;
  }

  /** (m4) the pile's goods a cart takes (up to ECON.cartLoad) */
  private takePile(id: number): Goods {
    const g = this.piles.get(id) ?? {};
    const out: Goods = {};
    let room = ECON.cartLoad;
    for (const [k, v] of Object.entries(g) as [Good, number][]) {
      const n = Math.min(room, v ?? 0);
      if (n <= 0) continue;
      out[k] = n;
      g[k] = (v ?? 0) - n;
      room -= n;
    }
    return out;
  }

  /** the cart groups' goals: each its pile's door (reseed) */
  private cartGoals(): V2[][] {
    return Array.from({ length: CART_GROUPS }, (_, i) => {
      const id = this.carts[i];
      const w = id !== undefined ? (this.io.units.recs.get(id)?.work as Work | undefined) : undefined;
      const d = w && w.from != null && (w.phase === 'out' || w.phase === 'load') ? this.pilePoint(w.from) : null;
      return d ? [d] : [];
    });
  }

  /**
   * (m4) A cart's round, roads only: parked at the stores; out by road to the fullest pile; a load taken (up to
   * ECON.cartLoad); back by road to the stores, where it's put in.
   */
  private stepCart(u: UnitRec, w: Work, dt: number): void {
    const U = this.io.units;
    const at: V2 = [u.v.at[0], u.v.at[1]];
    const i = this.carts.indexOf(u.v.id);
    const stand = () => {
      U.regroup(u, G.stand);
      u.v.state = 'idle';
    };
    switch (w.phase) {
      case 'out': {
        const door = w.from != null ? this.pilePoint(w.from) : null;
        if (!door || i < 0) return void Object.assign(w, { phase: 'park', t: 1, from: null });
        const g = R4.cart0 + i;
        // (its ride is made at the next reseed; made for this pile and failed: no road reaches it — its workers walk)
        if (!this.cartRiding[i]) {
          if (this.cartRideFor[i] === w.from) {
            this.noCartRoad.add(w.from!);
            Object.assign(w, { phase: 'park', t: 1, from: null });
          }
          return void stand();
        }
        U.regroup(u, g);
        u.v.state = 'walk';
        if (Math.hypot(door[0] - at[0], door[1] - at[1]) < AT_SPOT + 1) Object.assign(w, { phase: 'load', t: 2 });
        break;
      }
      case 'load': {
        stand();
        if ((w.t -= dt) > 0) break;
        const goods = this.takePile(w.from!);
        w.goods = goods;
        const main = (Object.entries(goods) as [Good, number][]).sort((a, b) => b[1] - a[1])[0];
        if (main) U.carry(u, LOOK[main[0]] ?? 'stone', 0.8);
        w.phase = 'back';
        break;
      }
      case 'back': {
        if (!this.riding.pile) return void stand();
        U.regroup(u, R.toPile);
        u.v.state = 'walk';
        const h = this.heap();
        if (Math.hypot(h[0] - at[0], h[1] - at[1]) > THERE + 1) break;
        U.carry(u, null);
        this.stats.carted += Object.values(w.goods ?? {}).reduce((a, b) => a + (b ?? 0), 0);
        this.stats.cartLoads++;
        this.deliver(w);
        Object.assign(w, { phase: 'park', t: 1, from: w.from });
        w.from = null;
        break;
      }
      default: {
        // parked by the stores: off for the next pile
        stand();
        if ((w.t -= dt) > 0) break;
        w.t = 1;
        const p = this.pileFor(u.v.id);
        if (p === null) break;
        Object.assign(w, { phase: 'out', t: 0, from: p });
      }
    }
  }

  /** the doors of a type's built structures (window world) */
  private doorsOf(type: 'blacksmith' | 'barracks'): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures().sort((a, b) => a.id - b.id)) {
      if (s.type !== type) continue;
      const d = f.doorOf(s.id);
      if (d) out.push(d);
    }
    return out.slice(0, 4);
  }

  /** the feet of the built walls' stairs (window world): the soldiers' posts */
  private posts(): V2[] {
    const f = this.io.fort;
    return f
      .ways()
      .stairs.filter((st) => f.town.has(st.wall, 0))
      .map((st) => f.centre(st.foot))
      .slice(0, 4);
  }

  /** the built wall cells' middles (window world): the wall-walk's points */
  private wallPoints(): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures()) if (s.type === 'wall') for (const c of s.cells.keys()) if (f.town.has(c, 0) && !f.plan.gate[c]) out.push(f.centre(c));
    return out;
  }

  /** recruits done drilling: each villager taken away and a soldier (a guard) stood up where it stood */
  private enlist(): void {
    if (!this.enlisting.length) return;
    const U = this.io.units;
    for (const id of this.enlisting.splice(0)) {
      const v = U.get(id);
      if (!v?.alive) continue;
      const at: V2 = [v.at[0], v.at[1]];
      U.remove(id);
      const i = this.ids.indexOf(id);
      if (i >= 0) this.ids.splice(i, 1);
      this.standSoldier(at, v.name);
      this.stats.trained++;
    }
  }

  /** a soldier (a guard) stood up at `at`: it musters at the barracks first */
  private standSoldier(at: V2, name?: string): UnitId {
    const U = this.io.units;
    const sid = U.spawn('guard', at, this.io.faction, { settlement: this.io.settlement, role: 'guard', name, health: ECON.soldierHealth, damage: ECON.soldierDamage, job: { kind: 'work', at, what: 'soldier' } });
    U.recs.get(sid)!.work = { phase: 'muster', t: 0, job: null } satisfies Work;
    this.soldiers.push(sid);
    return sid;
  }

  /** (m4, scripted checks: the lab's raids) `n` soldiers stood up round the stores, as if trained */
  standSoldiers(n: number): UnitId[] {
    const h = this.heap();
    return Array.from({ length: n }, (_, i) => this.standSoldier([h[0] + Math.cos(i * 2.1) * 3, h[1] + Math.sin(i * 2.1) * 3]));
  }

  /** (m4: the attack wave) a soldier the raid posted is let off its patrol (the raid orders it now) */
  unpatrol(id: UnitId): void {
    this.patrol.delete(id);
  }

  /** (m4: the attack wave) a soldier back to its own round after the raid: it musters at the barracks */
  backToRoutine(id: UnitId): void {
    const U = this.io.units;
    const v = U.get(id);
    if (!v?.alive) return;
    U.order(id, { kind: 'work', at: [v.at[0], v.at[1]], what: 'soldier' });
    const r = U.recs.get(id);
    if (r) r.work = { phase: 'muster', t: 0, job: null } satisfies Work;
  }

  /**
   * A soldier's round (its own routine, not a job): muster at the barracks and drill; march by road to the foot of the
   * wall's stairs; walk the wall-walk (walkTheWalls); muster again each morning (a new economy day).
   */
  private stepSoldier(u: UnitRec, w: Work, dt: number): void {
    const U = this.io.units;
    const at: V2 = [u.v.at[0], u.v.at[1]];
    const stand = () => {
      U.regroup(u, G.stand);
      u.v.state = 'idle';
    };
    switch (w.phase) {
      case 'drill':
        U.regroup(u, R.working);
        u.v.state = 'swing';
        w.t -= dt;
        if (w.t <= 0) {
          this.stats.mustered++;
          w.phase = 'march';
        }
        break;
      case 'march': {
        const posts = this.posts();
        const walls = this.wallPoints();
        if (!posts.length || !walls.length || !this.riding.post) return void Object.assign(w, { phase: 'wait', t: 5 });
        U.regroup(u, R4.toPost);
        u.v.state = 'walk';
        if (!posts.some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT)) break;
        // (up the stairs and along the wall-walk: the units' own goal fields — AgentUnits 'go' orders, walkTheWalls)
        const to = this.nearest(walls, at);
        this.patrol.set(u.v.id, { at: to, walked: 0, since: this.t });
        U.order(u.v.id, { kind: 'go', to });
        break;
      }
      case 'wait':
        stand();
        w.t -= dt;
        if (w.t <= 0) w.phase = 'muster';
        break;
      default: {
        // muster: by road to the barracks; there, drill
        const doors = this.doorsOf('barracks');
        if (!doors.length || !this.riding.barracks) return void stand();
        U.regroup(u, R4.toBarracks);
        u.v.state = 'walk';
        if (doors.some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT)) Object.assign(w, { phase: 'drill', t: ECON.drillSec });
        else w.phase = 'muster';
      }
    }
  }

  /** the ground the fortress first read at window world (x, y) (its box column: before anything was built there) */
  keptGround(p: V2): number {
    const f = this.io.fort;
    const [bx, by] = f.toBox(p[0], p[1]);
    const [k, r] = cellAt(bx, by);
    return f.groundAt(Math.max(0, Math.min(f.box.h - 1, r)) * f.box.w + Math.max(0, Math.min(f.box.w - 1, k)));
  }

  private nearest(pts: V2[], at: V2): V2 {
    let best = pts[0];
    for (const p of pts) if (Math.hypot(p[0] - at[0], p[1] - at[1]) < Math.hypot(best[0] - at[0], best[1] - at[1])) best = p;
    return best;
  }

  /**
   * The soldiers on the wall-walk: at a point, on to the next wall cell along (the nearest not just walked); after
   * ECON.patrolPoints, or at a new day, back to their routine to muster.
   */
  private walkTheWalls(dt: number): void {
    if (!this.patrol.size && dt <= 0) return;
    const U = this.io.units;
    const day = Math.floor(this.t / ECON.daySec);
    const morning = day !== this.day;
    this.day = day;
    const walls = this.wallPoints();
    for (const [id, p] of [...this.patrol]) {
      const v = U.get(id);
      if (!v?.alive) {
        this.patrol.delete(id);
        continue;
      }
      // (there: by the point and up on the wall — over the ground the fortress first read there)
      this.logDay(id, 'the wall');
      const there = Math.hypot(p.at[0] - v.at[0], p.at[1] - v.at[1]) < AT_SPOT && v.at[2] > this.keptGround(p.at) + 1.5;
      // (no way up for PATROL_STUCK s: back to the barracks)
      const stuck = !there && this.t - p.since > PATROL_STUCK;
      if (morning || stuck || !walls.length || (there && p.walked + 1 >= ECON.patrolPoints)) {
        this.patrol.delete(id);
        U.order(id, { kind: 'work', at: [v.at[0], v.at[1]], what: 'soldier' });
        const r = U.recs.get(id);
        if (r) r.work = { phase: 'muster', t: 0, job: null } satisfies Work;
        this.stats.patrols++;
        continue;
      }
      if (!there) continue;
      // (the next point along: the nearest wall cell 8 or more away from this one — a walk, not a hop)
      const next = walls.filter((q) => Math.hypot(q[0] - p.at[0], q[1] - p.at[1]) > 8).sort((a, b) => Math.hypot(a[0] - p.at[0], a[1] - p.at[1]) - Math.hypot(b[0] - p.at[0], b[1] - p.at[1]))[0];
      if (!next) continue;
      this.patrol.set(id, { at: next, walked: p.walked + 1, since: this.t });
      this.stats.onWall++;
      U.order(id, { kind: 'go', to: next });
    }
  }

  /** (round 128m) where the miners go: the pit's cells with ground still to take while one is dug, else the quarries' */
  private quarrySpots(): V2[] {
    return this.quarry.digging() ? this.quarry.spots(SEEDS) : this.cellsOf('quarry');
  }

  private homes(): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'house') continue;
      const d = f.doorOf(s.id);
      if (d) out.push(d);
    }
    // (round 128i: the fortress's own houses once there are any — its people ride its roads home — else the town's)
    // (m4: not a house the raiders set alight — those in it run to another)
    const safe = out.filter(([x, y]) => !this.unsafe.some(([ux, uy]) => Math.hypot(ux - x, uy - y) < 1));
    return (safe.length ? safe : out.length ? out : this.io.homes()).slice(0, 4);
  }

  private reseed(): void {
    const h = this.heap();
    const stone = this.sitesFor('stone').flatMap((b) => this.standsFor(b));
    const wood = this.sitesFor('log').flatMap((b) => this.standsFor(b));
    const quarry = this.quarrySpots().slice(0, SEEDS);
    const farm = this.cellsOf('farm').slice(0, SEEDS);
    const fell = this.trees.slice(0, SEEDS);
    const homes = this.homes();
    // (m4) the smithies' and the barracks' doors, the wall stairs' feet
    const smiths = this.doorsOf('blacksmith');
    const barracks = this.doorsOf('barracks');
    const posts = this.posts();
    const r = (v: V2[]) => v.map((p) => p.map(Math.round));
    const carts = this.cartGoals();
    const key = JSON.stringify([h.map(Math.round), r(stone), r(wood), r(quarry), r(farm), r(fell), r(homes), r(smiths), r(barracks), r(posts), carts.map(r)]);
    const graph = this.io.fort.roadGraph();
    if (key === this.seeded && graph === this.seededGraph) return;
    this.seeded = key;
    this.seededGraph = graph;
    const A = this.io.units.agents;
    const seed = (f: number, v: V2[]) => A.seed(f, v.map(([x, y]) => ({ x, y })));
    // (round 128i, V128-14; the user: "We only need the flow fields where they go off tracks or where the destinations
    // switch") the legs to fixed places by the roads — the stores, the houses, the farms — ride the road graph when every
    // goal of theirs is by it (Agents.ride): the shared field onto the roads, then the roads, then a straight last leg;
    // their own fields go unseeded. The legs to changing places (the sites, the trees, the quarry's pits) keep fields.
    const f = this.io.fort;
    const ride = (g: number, field: number, v: V2[]): boolean => {
      const ok = A.ride(g, v.map(([x, y]) => f.toBox(x, y)));
      A.follow(g, ok ? ROAD_FIELD : field);
      seed(field, ok ? [] : v);
      return ok;
    };
    // (m4: ride only — no fields of their own; a leg no road reaches waits)
    const rideOnly = (g: number, v: V2[]): boolean => {
      const ok = v.length > 0 && A.ride(g, v.map(([x, y]) => f.toBox(x, y)));
      if (!ok) A.ride(g, null);
      A.follow(g, ok ? ROAD_FIELD : -1);
      return ok;
    };
    this.riding = {
      pile: ride(R.toPile, F.pile, [h]),
      home: ride(R.toHome, F.home, homes),
      farm: ride(R.toFarm, F.farm, farm),
      smith: rideOnly(R4.toSmith, smiths),
      barracks: rideOnly(R4.toBarracks, barracks),
      post: rideOnly(R4.toPost, posts),
    };
    this.cartRiding = carts.map((v, i) => rideOnly(R4.cart0 + i, v));
    this.cartRideFor = carts.map((v, i) => {
      const w = v.length && this.carts[i] !== undefined ? (this.io.units.recs.get(this.carts[i])?.work as Work | undefined) : undefined;
      return w?.from ?? null;
    });
    seed(F.site, stone.slice(0, 8));
    seed(F.store, wood.slice(0, 8));
    seed(F.quarry, quarry);
    seed(F.fell, fell);
  }

  /**
   * Where builders stand to work on a block: just outside its cell's sides with nothing built beside at the ground
   * (as BuildCrew's). Never inside: a block that stands is drawn as pieces whose columns are claimed solid, and a
   * builder inside it when it went up was buried (they died at the site in the first headless run).
   */
  private standsFor(b: Block): V2[] {
    const f = this.io.fort;
    const g = f.town.grid;
    const [cx, cy] = g.centre(b.cell);
    const out: V2[] = [];
    for (let e = 0; e < 4; e++) {
      const n = g.nbr[b.cell * 4 + e];
      if (n < 0 || f.town.has(n, 0)) continue;
      const [ax, ay] = g.corner(b.cell, e);
      const [bx, by] = g.corner(b.cell, e + 1);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const d = Math.hypot(mx - cx, my - cy) || 1;
      out.push(f.toWindow(mx + ((mx - cx) / d) * 1.4, my + ((my - cy) / d) * 1.4));
    }
    return out;
  }

  /** the first block (of the sites) that still lacks something the stores have */
  private nextJob(): { b: Block; load: Load } | null {
    const st = this.io.stores();
    for (const b of this.sites()) {
      const load = this.book.fetch(b, st, LOAD);
      if (load) {
        this.io.take(load.good, load.amount);
        return { b, load };
      }
    }
    return null;
  }

  step(u: UnitRec, dtWall: number): void {
    if (this.raid?.takes(u)) return this.raid.step(u, dtWall);
    const dt = dtWall * this.io.speed();
    const w = (u.work ??= { phase: 'idle', t: 1, job: null } satisfies Work) as Work;
    // (m4, follow) its day so far
    this.logDay(u.v.id, DAY_WORD[this.doingOf(u)]);
    const U = this.io.units;
    const at: V2 = [u.v.at[0], u.v.at[1]];
    const go = (g: number) => {
      U.regroup(u, g);
      u.v.state = 'walk';
    };
    const stand = () => {
      U.regroup(u, G.stand);
      u.v.state = 'idle';
    };
    if (u.v.role === 'guard') return this.stepSoldier(u, w, dt);
    if (u.v.role === 'cart') return this.stepCart(u, w, dt);
    // (m4: raiders about) home, and stay there; what they were doing goes on after
    if (this.shelter) {
      const homes = this.homes();
      const home = !homes.length || homes.some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT);
      if (home) stand();
      else go(R.toHome);
      if (home) this.inside.add(u.v.id);
      else this.inside.delete(u.v.id);
      return;
    }
    const slot = this.slot(w.job);
    switch (w.phase) {
      // ---- (m4) smiths and recruits: a batch out of the stores
      case 'fetch': {
        if (!slot || (slot.kind !== 'blacksmith' && slot.kind !== 'barracks')) return void Object.assign(w, { phase: 'idle', t: 0.2 });
        go(R.toPile);
        const h = this.heap();
        if (Math.hypot(h[0] - at[0], h[1] - at[1]) > THERE) break;
        const goods = this.recipes.start(u.v.id, slot.kind, slot.structure!, this.io.stores(), this.trainRoom());
        if (!goods) return void Object.assign(w, { phase: 'wait', t: 3 });
        for (const [g, v] of Object.entries(goods) as [Good, number][]) this.io.take(g, v);
        U.carry(u, slot.kind === 'barracks' ? 'steel' : 'stone', 0.3);
        w.phase = 'toWork';
        break;
      }
      case 'arrive': {
        // (m4) a newcomer: by road to a house, then the JobBoard's work
        const homes = this.homes();
        if (!homes.length || homes.some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT)) Object.assign(w, { phase: 'idle', t: 0.5 });
        else go(R.toHome);
        break;
      }
      case 'rest': {
        // (m4) the day's end: home to rest until the next day
        const homes = this.homes();
        if (!homes.length || homes.some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT)) stand();
        else go(R.toHome);
        if (this.dayFrac() < REST_FROM) Object.assign(w, { phase: 'idle', t: 0.2 });
        break;
      }
      case 'eat': {
        // (m4) once a day, at the stores: a meal (the grain is eaten by the day, ECON.eat)
        go(R.toPile);
        const h = this.heap();
        if (Math.hypot(h[0] - at[0], h[1] - at[1]) > THERE) break;
        stand();
        w.t -= dt;
        if (w.t <= 0) Object.assign(w, { phase: 'idle', t: 0.2, ate: Math.floor(this.t / ECON.daySec) });
        break;
      }
      case 'idle': {
        stand();
        w.t -= dt;
        if (w.t > 0) break;
        // (m4: a person's day — work, a meal at midday at the stores, home to rest at its end)
        const day = Math.floor(this.t / ECON.daySec);
        if (this.dayFrac() >= REST_FROM) return void (w.phase = 'rest');
        if (this.dayFrac() >= EAT_FROM && w.ate !== day && !w.load && !w.goods) return void Object.assign(w, { phase: 'eat', t: EAT_S });
        if (!slot) w.phase = 'home';
        else if (slot.kind === 'build') w.phase = this.io.fort.mode === 'build' && this.sites().length ? 'toPile' : 'home';
        else if (slot.kind === 'blacksmith' || slot.kind === 'barracks') {
          // (m4) to the stores for a batch (or, carrying one already, on to the structure)
          w.from = slot.structure;
          w.phase = this.recipes.batchOf(u.v.id) ? 'toWork' : 'fetch';
        } else {
          w.from = slot.structure;
          // (the stores too full for another load: the haul stops, they wait — the bar says so)
          if (!fits(this.io.stores(), this.io.fort.room(), ECON.haul)) Object.assign(w, { phase: 'wait', t: 3 });
          else w.phase = 'toWork';
        }
        break;
      }
      case 'wait':
        stand();
        w.t -= dt;
        if (w.t <= 0) w.phase = 'idle';
        break;
      case 'home': {
        // (no work: home, and wait there; the JobBoard's next turn may give them some)
        const homes = this.homes();
        const near = homes.some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT);
        if (near || !homes.length) stand();
        else go(R.toHome);
        if (slot && !(slot.kind === 'build' && !this.sites().length)) Object.assign(w, { phase: 'idle', t: 0.2 });
        break;
      }
      // ---- builders
      case 'toPile': {
        go(R.toPile);
        const h = this.heap();
        if (Math.hypot(h[0] - at[0], h[1] - at[1]) > THERE) break;
        const j = slot?.kind === 'build' ? this.nextJob() : null;
        if (!j) {
          // (nothing to build, or nothing it lacks in the stores: wait by the heap)
          if (slot?.kind === 'build' && this.sites().length) this.stats.starved++;
          Object.assign(w, { phase: 'idle', t: 3 });
          break;
        }
        w.block = j.b;
        w.load = j.load;
        U.carry(u, j.load.good === 'log' ? 'log' : 'stone', Math.max(0.2, Math.min(0.6, j.load.amount / 6)));
        w.phase = 'toSite';
        break;
      }
      case 'toSite': {
        const job = w.block!;
        const good = w.load!.good;
        go(good === 'log' ? R.toStore : R.toSite);
        // (the good's field leads to the nearest site lacking it: work on whichever block it came to)
        let here: Block | null = null;
        const f = this.io.fort;
        for (const b of this.sitesFor(good)) {
          // (at one of its stands — the field's goals — or by its middle)
          const [cx, cy] = f.centre(b.cell);
          const by = Math.hypot(cx - at[0], cy - at[1]) <= REACH || this.standsFor(b).some(([sx, sy]) => Math.hypot(sx - at[0], sy - at[1]) <= THERE);
          if (!by) continue;
          if (b.cell === job.cell && b.level === job.level) {
            here = b;
            break;
          }
          if (!here && (this.book.need(b, false)[w.load!.good] ?? 0) > 0) here = b;
        }
        if (!here) {
          // (its block erased or built under it: the load goes back, it goes back to the heap)
          // (FT-20: or found cut off from the heap — no way there: the same)
          if (!this.todo().some((b) => b.cell === job.cell && b.level === job.level) || this.isCutOff(job)) this.unload(u, w, false);
          break;
        }
        if (here.cell !== job.cell || here.level !== job.level) {
          this.book.move(job, here, w.load!);
          w.block = here;
        }
        Object.assign(w, { phase: 'working', t: WORK_S });
        break;
      }
      case 'working':
        U.regroup(u, R.working);
        u.v.state = 'swing';
        w.t -= dt;
        if (w.t <= 0) this.unload(u, w, true);
        break;
      // ---- miners, woodcutters, farmers
      case 'toWork': {
        if (!slot || slot.kind === 'build') return void Object.assign(w, { phase: 'idle', t: 0.2 });
        const kind = slot.kind;
        if (kind === 'blacksmith' || kind === 'barracks') {
          // (m4) by road to its own structure's door; no road reaches it: they wait there with the batch
          const door = this.io.fort.doorOf(slot.structure!);
          if (!door || !(kind === 'blacksmith' ? this.riding.smith : this.riding.barracks)) return void Object.assign(w, { phase: 'wait', t: 3 });
          go(kind === 'blacksmith' ? R4.toSmith : R4.toBarracks);
          if (Math.hypot(door[0] - at[0], door[1] - at[1]) >= AT_SPOT) break;
          U.carry(u, null);
          w.where = door;
          w.phase = 'gather';
          break;
        }
        const spots = kind === 'quarry' ? this.quarrySpots() : kind === 'farm' ? this.cellsOf('farm') : this.trees;
        if (!spots.length) return void Object.assign(w, { phase: 'wait', t: 3 });
        go(kind === 'quarry' ? R.toQuarry : kind === 'farm' ? R.toFarm : R.toFell);
        const spot = spots.find(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT);
        if (!spot) break;
        w.where = spot;
        w.phase = 'gather';
        w.t = kind === 'farm' ? ECON.reapSec : w.moved && w.t > 0 ? w.t : workSeconds(DEFS[kind]);
        w.moved = false;
        w.dig = ECON.digSec * Math.random();
        break;
      }
      case 'gather': {
        U.regroup(u, R.working);
        u.v.state = 'swing';
        const kind = slot?.kind;
        if (kind === 'blacksmith' || kind === 'barracks') {
          // (m4) the batch's work: a weapon to carry to the stores, or a soldier
          const out = this.recipes.work(u.v.id, dt);
          if (!out) break;
          if (kind === 'blacksmith') {
            this.stats.forged += out.weapons ?? 0;
            this.carry(u, w, out);
          } else {
            w.phase = 'lifting';
            this.enlisting.push(u.v.id);
          }
          break;
        }
        w.t -= dt;
        if (kind === 'quarry' && (w.dig = (w.dig ?? 0) - dt) <= 0) {
          w.dig = ECON.digSec;
          // (round 128m: nothing left to dig in reach — this cell's part of the tier is down — on to another)
          if (!this.quarry.dig(at) && this.quarry.digging()) {
            w.phase = 'toWork';
            w.moved = true;
            break;
          }
        }
        if (w.t > 0) break;
        if (kind === 'quarry') this.carry(u, w, quarryLoad(ECON.haul));
        else if (kind === 'farm') {
          const ripe = w.from != null ? (this.ripe.get(w.from) ?? 0) : 0;
          const n = Math.min(ECON.haul, ripe);
          // (not ripe yet: they work on and look again)
          if (n < 0.5) w.t = ECON.reapSec;
          else {
            this.ripe.set(w.from!, ripe - n);
            this.carry(u, w, { grain: n });
          }
        } else if (kind === 'lumber') {
          w.phase = 'lifting';
          const where = w.where ?? at;
          void this.io.fell(where).then((logs) => {
            this.trees = this.trees.filter((t) => Math.hypot(t[0] - where[0], t[1] - where[1]) > 0.8);
            // (a tree gone: the camps' lists asked again — its edit has run, the answer won't hold it)
            this.treesFor = '';
            if (w.phase !== 'lifting') return;
            if (logs > 0) {
              this.stats.felled++;
              this.felledAt.push(where);
              if (this.felledAt.length > 20) this.felledAt.shift();
              this.carry(u, w, { log: ECON.haul });
            } else w.phase = 'idle';
          });
        } else w.phase = 'idle';
        break;
      }
      case 'lifting':
        U.regroup(u, R.working);
        break;
      case 'carry': {
        go(R.toPile);
        const h = this.heap();
        if (Math.hypot(h[0] - at[0], h[1] - at[1]) <= THERE) {
          U.carry(u, null);
          this.deliver(w);
        }
        break;
      }
    }
  }

  private carry(u: UnitRec, w: Work, goods: Goods): void {
    // (round 128l, m4) a long haul from a quarry, a lumber camp or a farm: left on its pile for a cart
    const f = this.io.fort;
    const s = w.from != null ? f.plan.structure(w.from) : null;
    if (s && (s.type === 'quarry' || s.type === 'lumber' || s.type === 'farm')) {
      const door = f.doorOf(s.id);
      const h = this.heap();
      const pile = this.piles.get(s.id) ?? {};
      const held = Object.values(pile).reduce((a, b) => a + (b ?? 0), 0);
      if (door && haulBy(Math.hypot(door[0] - h[0], door[1] - h[1]), { carts: this.carts.length, pile: held, road: this.riding.pile && !this.noCartRoad.has(s.id) && this.pilePoint(s.id) !== null }) === 'cart') {
        for (const [g, v] of Object.entries(goods) as [Good, number][]) pile[g] = (pile[g] ?? 0) + v;
        this.piles.set(s.id, pile);
        this.stats.piled++;
        this.io.units.carry(u, null);
        Object.assign(w, { phase: 'idle', t: 0.3, goods: null });
        return;
      }
    }
    w.goods = goods;
    const main = (Object.entries(goods) as [Good, number][]).sort((a, b) => b[1] - a[1])[0];
    this.io.units.carry(u, (main && LOOK[main[0]]) ?? 'stone', 0.4);
    w.phase = 'carry';
  }

  /** a worker's goods into the stores (as far as their room takes them) */
  private deliver(w: Work): void {
    const goods = w.goods ?? {};
    const went = putIn({ ...this.io.stores() }, this.io.fort.room(), goods);
    for (const [g, v] of Object.entries(went) as [Good, number][]) this.io.take(g, -v);
    if (w.from != null) {
      const m = this.made.get(w.from) ?? {};
      for (const [g, v] of Object.entries(went) as [Good, number][]) m[g] = (m[g] ?? 0) + v;
      this.made.set(w.from, m);
    }
    this.stats.hauled++;
    w.goods = null;
    Object.assign(w, { phase: 'idle', t: 0.3 });
  }

  /** a load worked into its block (the block stands when its cost is in), or given back */
  private unload(u: UnitRec, w: Work, work: boolean): void {
    const b = w.block!;
    const load = w.load!;
    this.io.units.carry(u, null);
    w.load = null;
    w.block = undefined;
    // (back to the heap for the next load, or to the next job if the JobBoard moved them meanwhile)
    Object.assign(w, { phase: 'idle', t: 0 });
    const f = this.io.fort;
    if (!work || !f.town.planned(b.cell, b.level) || f.town.has(b.cell, b.level)) {
      this.book.giveBack(b, load, this.io.stores());
      this.io.take(load.good, -load.amount);
      return;
    }
    this.stats.trips++;
    if (this.book.pay(b, load)) {
      f.markBuilt(b.cell, b.level);
      this.stats.built++;
      this.orderAt = -1;
    } else f.markStarted(b.cell, b.level);
  }

  /**
   * Erase gives back: half a built block's cost (ECON.refund, each good rounded down); all that was brought to a block
   * not yet built. As far as the stores' room takes it.
   */
  private refund(e: Erased): void {
    const goods = e.built ? refundOf(DEFS[e.type].cost) : this.book.forget({ cell: e.cell, level: e.level });
    const went = putIn({ ...this.io.stores() }, this.io.fort.room(), goods);
    for (const [g, v] of Object.entries(went) as [Good, number][]) this.io.take(g, -v);
    this.stats.refunds++;
  }
}
