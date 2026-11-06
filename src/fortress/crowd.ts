// The fortress's people as the one crowd (DA-A6, round 128o; DESIGN.md section 11): the wiring between the town's
// routine (town/life.ts TownLife, over fortress/townwork.ts FortressWork) and the agents (units/agent-units.ts). It
// replaces fortress/life.ts's FortressLife, which polled every person's position each step to decide its phase.
//  - Events in: the agents' arrivals (AgentUnits hands a working unit's `arrived` here: at the end of the field its leg
//    follows, or at its group's ride's goal), deaths, the world's answers (a tree felled), the town's own (FortressWork's:
//    stores, sites, spot, pile, room), raiders about (shelter); a lost event throws (TownLife).
//  - Orders out: a leg is a group (a field, or a ride on the roads when every goal of the leg is by them); standing is the
//    standing group, or the working one (bent to a tool) while a phase works; a load carried is shown; a dig or a felling
//    is a task timed here (the quarry dug as before: QuarryDig), answered as an event; a newcomer stood up where the town's
//    people come in; a recruit drilled restyled a soldier where it stands.
//  - Each frame: the fields and rides seeded for the legs' goals, the bar's status, the stores eaten from — what
//    FortressLife did besides its people's phases, kept.
// Positions read: none for the routine. (The follow card, the pick, the lab's snapshot still read the units' synced
// positions; the units' sync of every unit goes with DA-B2b's watched sync.)
// It runs the pinned settlement's units in place of a settlement's life (Settlements.pin): they share the agents' fields
// and groups, so they never run together.
import type { Good, Goods } from '../api/contracts/fortress';
import type { FactionId } from '../api/contracts/world';
import type { UnitId, V2 } from '../api/contracts/units';
import { buildOrder } from '../agents/buildcrew';
import type { Block } from '../build/town';
import { F, G, R, R4, type AgentUnits, type Routine, type UnitRec } from '../units/agent-units';
import { ROAD_FIELD } from '../agents/agents';
import { nearestNode, nodeCount, noGraph, type RoadGraph } from '../agents/roadgraph';
import { DEFS, ECON } from './defs';
import { builtBlocks, cartsOf, eaten, fits, reachOf, workSeconds } from './economy';
import { ROW_H, cellAt } from '../world/lattice';
import type { Fortress } from './fortress';
import { WAY_ROAD } from '../build/ways';
import type { Doing, PersonFacts } from './follow';
import type { FortressRaid } from './raiders';
import { QuarryDig } from './quarry';
import { FortressWork } from './townwork';
import { TownLife, type LifeEvent, type Leg, type Order, type To } from '../town/life';

/** seeds a field at most (the agents hold 48 in all) */
const SEEDS = 6;
/** sim seconds between the quarry's look at its pits, the trees' look, the follow card's day words */
const JOBS_S = 1;
/** the carts' ride groups (R4.cart0 ..) */
const CART_GROUPS = 3;
/** a pile's road node at most this far from the structure's door (m) */
const PILE_ROAD = 14;
/**
 * Where a leg ends (the agents' arrival radius on its field, and the radius it has left by): the field's distance at the
 * unit's feet, near the goal about metres. The stores and the spots as FortressLife judged "there" (2.4, 3 m as the crow
 * flies); a builder's stand closer (it stands just outside the block); a soldier's wall point as the units' goals (1.6).
 */
const ARRIVE: [number, number[], number][] = [
  [F.pile, [2.4], 5],
  [F.site, [2], 4],
  [F.store, [2], 4],
  [F.quarry, [2.5], 5],
  [F.fell, [2.5], 5],
  [F.farm, [2.5], 5],
  [F.home, [2.5], 5],
  [F.goal0, [1.6], 4],
  [F.goal0 + 1, [1.6], 4],
  [F.goal0 + 2, [1.6], 4],
];
/** the field each leg's group follows when it doesn't ride */
const FIELD_OF: Record<number, number> = {
  [R.toPile]: F.pile,
  [R.toSite]: F.site,
  [R.toStore]: F.store,
  [R.toQuarry]: F.quarry,
  [R.toFell]: F.fell,
  [R.toFarm]: F.farm,
  [R.toHome]: F.home,
  [G.goal0]: F.goal0,
  [G.goal0 + 1]: F.goal0 + 1,
  [G.goal0 + 2]: F.goal0 + 2,
};
/** the phases that stand bent to a tool (the working group's pose) */
const POSE: ReadonlySet<string> = new Set(['working', 'gather', 'digging', 'felling', 'batching', 'drill']);
/** what a worker carries, drawn */
const LOOK: Partial<Record<string, string>> = { stone: 'stone', ore: 'stone', log: 'log', grain: 'sand', weapons: 'steel' };
/** (follow) what each thing a person does counts as in its day */
const DAY_WORD: Record<Doing, string | null> = {
  home: 'home', rest: 'home', idle: null, arrive: 'the road in', 'build-fetch': 'work', 'build-carry': 'work', 'build-work': 'work',
  'to-work': 'work', work: 'work', haul: 'haul', eat: 'eat', fetch: 'work', drill: 'drill', muster: 'muster', march: 'march', wall: 'the wall',
  'cart-park': 'the stores', 'cart-out': 'the road', 'cart-load': 'loading', 'cart-back': 'the road',
};

/**
 * Where the town's first people start (window world): at the stores — a warehouse's door (its way out: open ground the
 * reach is seeded from) or the town's heap. (DA-A2, round 128o: they were spawned 4 m round it, and a unit lands on the
 * top surface where it's put — in the user's start town on the warehouse's roof and the lighthouse, with no way down.)
 */
export function startSpots(stores: V2, n: number): V2[] {
  return Array.from({ length: n }, (): V2 => [stores[0], stores[1]]);
}

export interface FortressCrowdIO {
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
  /** (round 128m) wake the ground round window world (x, y) within r: a pit's tier dug, its walls' stability checked */
  settle?(x: number, y: number, r: number): void;
  /** (round 128m) the surface read `top` answers from (a new object each read) */
  groundRead?(): unknown;
  /** (round 128m) the ground's top now at window world (x, y), loose ground on it too (null: not read yet); none: `ground` */
  top?(x: number, y: number): number | null;
}

/** a dig or a felling under way (a task the routine asked for: its answer an event) */
interface Task {
  kind: 'dig' | 'fell';
  at: V2;
  /** sim seconds of work left; to the next bite of the pit */
  t: number;
  next: number;
}

export class FortressCrowd implements Routine {
  readonly work: FortressWork;
  readonly life: TownLife;
  /** (round 128m, V128-11) the quarries' pits, dug down tier by tier */
  readonly quarry: QuarryDig;
  /** loads brought, blocks built, waits at the stores with nothing to take; trips in, ground dug, trees felled, newcomers,
   *  refunds; (m4) batches, soldiers, carts */
  readonly stats = { trips: 0, built: 0, starved: 0, hauled: 0, dug: 0, felled: 0, arrived: 0, refunds: 0, forged: 0, trained: 0, mustered: 0, patrols: 0, onWall: 0, carted: 0, cartLoads: 0, piled: 0 };
  /** (m4: the attack wave) the raid (raiders.ts): its raiders and its rider are stepped through this routine */
  raid: FortressRaid | null = null;
  /** (m4) the villagers in at home while raiders are about (FortressRaid.mayFight) */
  readonly inside = new Set<UnitId>();
  /** (m4) the doors of houses set alight (FortressRaid): nobody goes home to them */
  unsafe: V2[] = [];
  /** (scripted checks) where the last trees were felled */
  readonly felledAt: V2[] = [];
  /** (round 128i) the legs that ride the roads now (their own fields left unseeded) */
  riding = { pile: false, home: false, farm: false, smith: false, barracks: false, post: false };
  /** the job board's view (scripted checks) */
  readonly board = { jobOf: (id: UnitId): string | null => this.life.jobOf(id) };

  /** each unit's leg now: the leg, its target, the group it's in for it */
  private legs = new Map<UnitId, { leg: Leg; to?: To; group: number }>();
  /** what each carries (its look's good: a builder's load decides its site field) */
  private load = new Map<UnitId, string>();
  private tasks = new Map<UnitId, Task>();
  /** a miner's load's work left when its spot gave out (it goes on at the next) */
  private digLeft = new Map<UnitId, number>();
  /** events for the routine since the last update (the agents' arrivals, deaths, the world's answers) */
  private inbox: LifeEvent[] = [];
  /** the carts by their ride group's slot (null: none there) */
  private cartSlots: (UnitId | null)[] = Array.from({ length: CART_GROUPS }, () => null);
  private cartRiding: boolean[] = [];
  private t = 0;
  private jobsAt = -1e9;
  private seeded = '';
  private seededGraph: RoadGraph | null = null;
  private reachSeen = -1;
  private cut = new Set<number>();
  private order: Block[] = [];
  private orderAt = -1;
  private trees: V2[] = [];
  private treesAsked = false;
  private treesFor = '';
  private quarryKey = '';
  /** a newcomer asked for (the routine's order) and where it comes in from (the reach's answer: undefined while asked) */
  private calling = false;
  private entryAnswer: V2 | null | undefined = undefined;
  private entryAsking = false;
  private sheltering = false;
  /** (follow) what each did today, in order (repeats folded) */
  private today = new Map<UnitId, string[]>();
  private todayN = 0;

  constructor(
    private io: FortressCrowdIO,
    people: number,
  ) {
    const fort = io.fort;
    this.quarry = new QuarryDig({ fort, ground: io.top ?? io.ground, dig: io.dig, settle: io.settle, groundRead: io.groundRead });
    this.work = new FortressWork({
      fort,
      stores: io.stores,
      take: io.take,
      stores_at: () => this.heap(),
      spots: (kind) => (kind === 'lumber' ? this.trees : this.quarrySpots()),
      pileAt: (s) => this.pilePoint(s),
    });
    this.life = new TownLife(this.work);
    const A = io.units.agents;
    io.units.routine = this;
    A.follow(R.toPile, F.pile);
    A.follow(R.toSite, F.site);
    A.follow(R.toStore, F.store);
    A.follow(R.toQuarry, F.quarry);
    A.follow(R.toFell, F.fell);
    A.follow(R.toFarm, F.farm);
    A.follow(R.toHome, F.home);
    A.follow(R.working, -1);
    A.workPose(R.working, true);
    for (const g of [R4.toSmith, R4.toBarracks, R4.toPost]) A.follow(g, -1);
    for (let i = 0; i < CART_GROUPS; i++) A.follow(R4.cart0 + i, -1);
    for (const [f, [r], leave] of ARRIVE) A.arrivals(f, r, leave);
    for (const at of startSpots(this.heap(), people)) this.life.add(this.spawn(at));
  }

  private spawn(at: V2): UnitId {
    return this.io.units.spawn('villager', at, this.io.faction, { settlement: this.io.settlement, role: 'villager', health: 3, job: { kind: 'work', at, what: 'villager' } });
  }

  // ---- the agents' side (Routine) ---------------------------------------------------------------------------------

  takes(u: UnitRec): boolean {
    return (u.v.settlement === this.io.settlement && u.v.job.kind === 'work') || (this.raid?.takes(u) ?? false);
  }

  /** the raid's units are its own; the crowd's move on orders, not steps */
  step(u: UnitRec, dtWall: number): void {
    if (this.raid?.takes(u)) this.raid.step(u, dtWall);
  }

  drop(u: UnitRec): void {
    const id = u.v.id;
    this.legs.delete(id);
    this.load.delete(id);
    this.tasks.delete(id);
    this.digLeft.delete(id);
    this.io.units.goalGroup(u, null);
    this.io.units.carry(u, null);
    if (!u.v.alive || !this.io.units.recs.has(id)) this.inbox.push({ type: 'death', unit: id });
    // (another order — the defence posts a soldier: the routine leaves it be until it's given back)
    else this.life.away(id);
  }

  arrived(u: UnitRec, e: { field?: number; ride?: number; at: [number, number, number] }): void {
    const leg = this.legs.get(u.v.id);
    if (!leg) return;
    // (its own leg's: the field its group follows, or its group's ride — not one it has left)
    const mine = e.ride !== undefined ? e.ride === leg.group : e.field === FIELD_OF[leg.group];
    if (mine) this.inbox.push({ type: 'arrived', unit: u.v.id, leg: leg.leg, at: [e.at[0], e.at[1]], to: leg.to });
  }

  lost(count: number): void {
    this.inbox.push({ type: 'lost', count });
  }

  // ---- the raid's side ------------------------------------------------------------------------------------------

  /** (m4) raiders about: the villagers stay home (FortressRaid sets it) */
  get shelter(): boolean {
    return this.sheltering;
  }
  set shelter(on: boolean) {
    if (on === this.sheltering) return;
    this.sheltering = on;
    this.inbox.push({ type: 'shelter', on });
  }

  get settlementId(): string {
    return this.io.settlement;
  }
  get faction(): FactionId | null {
    return this.io.faction;
  }

  /** (m4, scripted checks: the lab's raids) `n` soldiers stood up round the stores, as if trained */
  standSoldiers(n: number): UnitId[] {
    const h = this.heap();
    return Array.from({ length: n }, (_, i) => {
      const at: V2 = [h[0] + Math.cos(i * 2.1) * 3, h[1] + Math.sin(i * 2.1) * 3];
      const id = this.io.units.spawn('guard', at, this.io.faction, { settlement: this.io.settlement, role: 'guard', health: ECON.soldierHealth, damage: ECON.soldierDamage, job: { kind: 'work', at, what: 'soldier' } });
      this.life.addSoldier(id);
      return id;
    });
  }

  /** (m4: the attack wave) a soldier back to its own round after the raid: it musters at the barracks */
  backToRoutine(id: UnitId): void {
    const v = this.io.units.get(id);
    if (!v?.alive) return;
    this.io.units.order(id, { kind: 'work', at: [v.at[0], v.at[1]], what: 'soldier' });
    this.life.back(id);
  }

  /** the ground the fortress first read at window world (x, y) (its box column: before anything was built there) */
  keptGround(p: V2): number {
    const f = this.io.fort;
    const [bx, by] = f.toBox(p[0], p[1]);
    const [k, r] = cellAt(bx, by);
    return f.groundAt(Math.max(0, Math.min(f.box.h - 1, r)) * f.box.w + Math.max(0, Math.min(f.box.w - 1, k)));
  }

  // ---- who ------------------------------------------------------------------------------------------------------

  /** The people alive. */
  people(): UnitId[] {
    return this.life.units().filter((id) => this.io.units.get(id)?.alive);
  }
  get ids(): UnitId[] {
    return this.people();
  }
  get soldiers(): UnitId[] {
    return this.life.soldiers();
  }
  get carts(): UnitId[] {
    return this.life.carts();
  }
  get piles(): Map<number, Goods> {
    return this.work.piles;
  }
  /** (m4) the people, soldiers and carts (the follow's picks) */
  everyone(): UnitId[] {
    return [...this.life.units(), ...this.life.soldiers(), ...this.life.carts()];
  }

  /** The stores: the first warehouse built (its door), else the town's own heap. */
  heap(): V2 {
    return this.io.fort.storesAt() ?? this.io.townHeap();
  }

  // ---- each frame -------------------------------------------------------------------------------------------------

  /**
   * The road shapes and the box's offset in the window to the agents (stamped on the GPU when either changed). Each
   * update, and (round 128i, FT-67) from the window's slide itself (level.ts onSlide).
   */
  roads(): void {
    this.io.units.agents.setRoads(this.io.fort.roadShapes(), ...this.io.fort.offset());
    this.io.units.agents.setRoadGraph(this.io.fort.roadGraph(), ...this.io.fort.offset());
  }

  /** each frame (sim seconds): what happened in, the routine's turn, its orders out; the fields, the bar */
  update(dt: number): void {
    this.t += dt;
    this.keepCarts();
    this.checkReach();
    this.roads();
    if (dt > 0) {
      this.work.grow(dt);
      const grain = this.io.stores().grain ?? 0;
      const ate = Math.min(grain, eaten(this.life.units().length, dt));
      if (ate > 0) this.io.take('grain', ate);
    }
    if (this.t - this.jobsAt >= JOBS_S) {
      this.jobsAt = this.t;
      this.quarry.update();
      this.stats.dug = this.quarry.stats.taken;
      const qk = JSON.stringify(this.quarrySpots());
      if (qk !== this.quarryKey) {
        this.quarryKey = qk;
        for (const s of this.io.fort.plan.structures()) if (s.type === 'quarry') this.work.spotReady(s.id);
      }
      // (round 128f) every block still to build kept in the fields' scope
      this.io.units.agents.keepInScope('fortress', this.todo().flatMap((b) => this.io.fort.standsOf(b.cell)));
      this.lookForTrees();
      for (const id of this.everyone()) this.logDay(id, DAY_WORD[this.doingOf(id)]);
    }
    this.runTasks(dt);
    for (const e of this.work.drain()) this.life.on(e);
    for (const e of this.inbox.splice(0)) this.life.on(e);
    for (const o of this.life.tick(dt)) this.apply(o);
    this.newcomer();
    this.inside.clear();
    for (const id of this.life.inside()) this.inside.add(id);
    this.reseed();
    this.writeStatus();
  }

  /** an order of the routine's carried out */
  private apply(o: Order): void {
    if ('newcomer' in o) {
      this.calling = true;
      return;
    }
    const U = this.io.units;
    const u = U.recs.get(o.unit);
    if (!u?.v.alive) return;
    const id = o.unit;
    if ('go' in o) {
      this.goLeg(u, o.go, o.to);
      // (its leg's goals changed under it: told where it is now — the agents' latch let go)
      if (o.again) U.rearm(u);
      return;
    }
    if ('carry' in o) {
      if (!o.carry) {
        this.load.delete(id);
        return U.carry(u, null);
      }
      this.load.set(id, o.carry);
      if (u.v.role === 'cart') this.stats.cartLoads++;
      if (o.carry === 'weapons') this.stats.forged++;
      return U.carry(u, LOOK[o.carry] ?? 'stone', u.v.role === 'cart' ? 0.8 : 0.4);
    }
    if ('dig' in o) {
      // (a load's work goes on where it went on to: the seconds it had left)
      const t = this.digLeft.get(id) ?? workSeconds(DEFS.quarry);
      this.digLeft.delete(id);
      return void this.tasks.set(id, { kind: 'dig', at: o.dig, t, next: ECON.digSec * Math.random() });
    }
    if ('fell' in o) return void this.tasks.set(id, { kind: 'fell', at: o.fell, t: workSeconds(DEFS.lumber), next: 0 });
    if ('become' in o) {
      U.restyle(id, 'guard', { health: ECON.soldierHealth, damage: ECON.soldierDamage });
      u.v.job = { kind: 'work', at: [u.v.at[0], u.v.at[1]], what: 'soldier' };
      this.stats.trained++;
    }
  }

  /** a unit to a leg's group (its field or its ride), or standing (at work: the working group's pose) */
  private goLeg(u: UnitRec, leg: Leg | null, to?: To): void {
    const U = this.io.units;
    const id = u.v.id;
    if (leg !== 'wall') U.goalGroup(u, null);
    if (leg === null) {
      this.legs.delete(id);
      const pose = POSE.has(this.life.phaseOf(id) ?? '');
      U.regroup(u, pose ? R.working : G.stand);
      u.v.state = pose ? 'swing' : 'idle';
      return;
    }
    let g: number;
    switch (leg) {
      case 'stores':
        g = R.toPile;
        break;
      case 'site':
        g = this.load.get(id) === 'log' ? R.toStore : R.toSite;
        break;
      case 'farm':
        g = R.toFarm;
        break;
      case 'quarry':
        g = R.toQuarry;
        break;
      case 'fell':
        g = R.toFell;
        break;
      case 'home':
        g = R.toHome;
        break;
      case 'smithy':
        g = R4.toSmith;
        break;
      case 'barracks':
        g = R4.toBarracks;
        break;
      case 'post':
        g = R4.toPost;
        break;
      case 'pile': {
        const i = this.cartSlots.indexOf(id);
        if (i < 0) throw new Error(`fortress crowd: unit ${id} sent for a pile is none of its carts`);
        g = R4.cart0 + i;
        break;
      }
      case 'wall': {
        this.stats.onWall++;
        // (the units' shared goal fields: all held elsewhere — it stands, and musters with the morning)
        g = U.goalGroup(u, to as V2) ?? G.stand;
        break;
      }
    }
    if (leg === 'barracks' && u.v.role === 'guard') this.stats.mustered++;
    U.regroup(u, g);
    u.v.state = g === G.stand ? 'idle' : 'walk';
    this.legs.set(id, { leg, to, group: g });
  }

  /** the digs and fellings under way: a dig bites the pit each ECON.digSec; done, the answer to the routine */
  private runTasks(dt: number): void {
    for (const [id, k] of [...this.tasks]) {
      const u = this.io.units.recs.get(id);
      if (!u?.v.alive) {
        this.tasks.delete(id);
        continue;
      }
      k.t -= dt;
      if (k.kind === 'dig') {
        k.next -= dt;
        if (k.next <= 0) {
          k.next = ECON.digSec;
          // (round 128m: nothing left to dig at its spot — this cell's part of the tier is down — on to another; the
          // load's work goes on there)
          if (!this.quarry.dig(k.at) && this.quarry.digging()) {
            this.tasks.delete(id);
            this.digLeft.set(id, Math.max(k.t, 0));
            this.inbox.push({ type: 'dug', unit: id, amount: 0 });
            continue;
          }
        }
        if (k.t > 0) continue;
        this.tasks.delete(id);
        this.inbox.push({ type: 'dug', unit: id, amount: ECON.haul });
        continue;
      }
      if (k.t > 0) continue;
      this.tasks.delete(id);
      const where = k.at;
      void this.io.fell(where).then((logs) => {
        this.trees = this.trees.filter((t) => Math.hypot(t[0] - where[0], t[1] - where[1]) > 0.8);
        // (a tree gone: the camps' lists asked again — its edit has run, the answer won't hold it)
        this.treesFor = '';
        if (logs > 0) {
          this.stats.felled++;
          this.felledAt.push(where);
          if (this.felledAt.length > 20) this.felledAt.shift();
        }
        this.inbox.push({ type: 'felled', unit: id, logs: logs > 0 ? ECON.haul : 0 });
      });
    }
  }

  /** a newcomer the routine asked for: stood up where the town's people come in, once the reach says where */
  private newcomer(): void {
    if (!this.calling) return;
    const at = this.entry();
    if (at === undefined) return;
    this.calling = false;
    if (!at) return this.life.turnedAway();
    this.life.arrive(this.spawn(at));
    this.stats.arrived++;
  }

  /**
   * Where a newcomer starts: in from the edge of the box where the roads come nearest it, else as far out as the stores
   * reach (the fortress's reach on the GPU, a bit a spot read back). Undefined while the reach is asked.
   */
  private entry(): V2 | null | undefined {
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

  /** (round 128l, m4) where the roads come nearest the window's edge: a newcomer (a raider) comes in there */
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

  // ---- the carts ----------------------------------------------------------------------------------------------------

  /** (m4) the carts the fortress has (cartsOf: the town's and one a warehouse block), stood on the road by the stores */
  private keepCarts(): void {
    const f = this.io.fort;
    const U = this.io.units;
    const mine = new Set(this.life.carts());
    for (let i = 0; i < CART_GROUPS; i++) if (this.cartSlots[i] !== null && !mine.has(this.cartSlots[i]!)) this.cartSlots[i] = null;
    let blocks = 0;
    for (const s of f.plan.structures()) if (s.type === 'warehouse') blocks += builtBlocks(f.plan, s, (c, l) => f.town.has(c, l));
    const want = Math.min(CART_GROUPS, cartsOf(blocks));
    for (let i = 0; i < CART_GROUPS && mine.size < want; i++) {
      if (this.cartSlots[i] !== null) continue;
      const h = this.heap();
      // (on the road nearest the stores: a cart starts on the network it rides)
      const g = f.roadGraph();
      const [bx, by] = f.toBox(h[0], h[1]);
      const n = nodeCount(g) ? nearestNode(g, bx, by).node : -1;
      const base: V2 = n >= 0 ? f.toWindow(g.xy[2 * n], g.xy[2 * n + 1]) : h;
      const at: V2 = [base[0] + Math.cos(i * 2.1) * 1.5, base[1] + Math.sin(i * 2.1) * 1.5];
      const id = U.spawn('cart', at, this.io.faction, { settlement: this.io.settlement, role: 'cart', health: 6, job: { kind: 'work', at, what: 'cart' } });
      this.cartSlots[i] = id;
      mine.add(id);
      this.life.addCart(id);
    }
  }

  /**
   * (m4) Where a cart loads a structure's pile: the road's node nearest its door (within PILE_ROAD m) that isn't on a
   * cell the plan digs (a quarry's: a cart that drove into the pit never climbed out, round 128l). Null: no such node —
   * no cart serves it, its workers walk their hauls.
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

  /** the cart groups' goals: each its claimed pile's road node (reseed) */
  private cartGoals(): V2[][] {
    return this.cartSlots.map((id) => {
      const leg = id !== null ? this.legs.get(id) : undefined;
      const p = leg?.leg === 'pile' && typeof leg.to === 'number' ? this.pilePoint(leg.to) : null;
      return p ? [p] : [];
    });
  }

  /** (scripted checks) the pile a cart rides for, or brings a load back from (null: none) */
  pileOf(id: UnitId): number | null {
    return this.life.cartPile(id);
  }

  /** (m4, scripted checks) the carts' rides */
  cartsState(): { riding: boolean[]; goals: V2[][] } {
    return { riding: [...this.cartRiding], goals: this.cartGoals() };
  }

  // ---- the fields and the rides --------------------------------------------------------------------------------------

  /** (round 128m) where the miners go: the pit's cells with ground still to take while one is dug, else the quarries' */
  private quarrySpots(): V2[] {
    return this.quarry.digging() ? this.quarry.spots(SEEDS) : this.cellsOf('quarry');
  }

  /** the built cells' middles of a type's structures: where its workers work */
  private cellsOf(type: 'quarry' | 'farm'): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures().sort((a, b) => a.id - b.id)) {
      if (s.type !== type) continue;
      for (const c of s.cells.keys()) if (f.town.has(c, 0)) out.push(f.centre(c));
    }
    return out;
  }

  private homes(): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'house') continue;
      const d = f.doorOf(s.id);
      if (d) out.push(d);
    }
    // (the fortress's own houses once there are any, else the town's; m4: not one the raiders set alight)
    const safe = out.filter(([x, y]) => !this.unsafe.some(([ux, uy]) => Math.hypot(ux - x, uy - y) < 1));
    return (safe.length ? safe : out.length ? out : this.io.homes()).slice(0, 4);
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

  private reseed(): void {
    const f = this.io.fort;
    const h = this.heap();
    const stone = this.work.sitesLacking('stone').flatMap((b) => f.standsOf(b.cell));
    const wood = this.work.sitesLacking('log').flatMap((b) => f.standsOf(b.cell));
    const quarry = this.quarrySpots().slice(0, SEEDS);
    const farm = this.cellsOf('farm').slice(0, SEEDS);
    const fell = this.trees.slice(0, SEEDS);
    const homes = this.homes();
    const smiths = this.doorsOf('blacksmith');
    const barracks = this.doorsOf('barracks');
    const posts = this.posts();
    const r = (v: V2[]) => v.map((p) => p.map(Math.round));
    const carts = this.cartGoals();
    const key = JSON.stringify([h.map(Math.round), r(stone), r(wood), r(quarry), r(farm), r(fell), r(homes), r(smiths), r(barracks), r(posts), carts.map(r)]);
    const graph = f.roadGraph();
    if (key === this.seeded && graph === this.seededGraph) return;
    this.seeded = key;
    this.seededGraph = graph;
    const A = this.io.units.agents;
    const seed = (field: number, v: V2[]) => A.seed(field, v.map(([x, y]) => ({ x, y })));
    // (round 128i, V128-14) the legs to fixed places by the roads — the stores, the houses, the farms — ride the road
    // graph when every goal of theirs is by it; their own fields go unseeded. The legs to changing places keep fields.
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
    // (round 128o: a stand seeded on its floor's surface — under a passage's arch the top one is the roof)
    const atFloor = (v: V2[]) => v.map(([x, y]) => ({ x, y, z: f.standFloor(x, y) }));
    A.seed(F.site, atFloor(stone.slice(0, 8)));
    A.seed(F.store, atFloor(wood.slice(0, 8)));
    seed(F.quarry, quarry);
    seed(F.fell, fell);
  }

  /**
   * The trees in the lumber camps' reach, nearest each camp first (12 a camp), asked of the GPU — when the camps or their
   * built blocks change, a tree is felled, or a day passes (the woods grow back by succession). Their answer is the
   * camps' work ready: a `spot` each.
   */
  private lookForTrees(): void {
    if (this.treesAsked) return;
    const f = this.io.fort;
    const camps: { id: number; mid: V2; r: number }[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'lumber') continue;
      const n = builtBlocks(f.plan, s, (c, l) => f.town.has(c, l));
      if (!n) continue;
      const cs = [...s.cells.keys()].map((c) => f.centre(c));
      camps.push({ id: s.id, mid: [cs.reduce((a, p) => a + p[0], 0) / cs.length, cs.reduce((a, p) => a + p[1], 0) / cs.length], r: reachOf(n) });
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
      for (const c of camps) this.work.spotReady(c.id);
    });
  }

  // ---- the plan's progress ----------------------------------------------------------------------------------------

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

  /** (round 128l) each time the reach answers: the blocks still to build the stores don't reach */
  private checkReach(): void {
    const f = this.io.fort;
    if (f.reachStats.checks === this.reachSeen) return;
    this.reachSeen = f.reachStats.checks;
    this.cut = f.cutCells();
    const n = this.unreachable().length;
    if (n !== f.cutOff) f.setCutOff(n);
  }

  /** (round 128d, FT-20) The blocks no builder can walk to from the stores (the reach's cut-off cells). */
  unreachable(): Block[] {
    return this.todo().filter((b) => this.cut.has(b.cell));
  }

  /** (round 128e, FT-49) Where to look when the builders start: between the stores and the first block they'll build */
  focus(): { at: V2; span: number } {
    const h = this.heap();
    const b = this.work.sites()[0] ?? this.todo()[0];
    if (!b) return { at: h, span: 0 };
    const [x, y] = this.io.fort.centre(b.cell);
    return { at: [(h[0] + x) / 2, (h[1] + y) / 2], span: Math.hypot(x - h[0], y - h[1]) };
  }

  /**
   * (round 128e, FT-50) Why the plan can't be finished now (Skip to done stops on it): every block left is cut off from
   * the stores, or nobody carries a load and the stores lack what the blocks left still need and nobody brings it in.
   */
  blocked(): { cutOff: number } | { short: Goods } | null {
    const todo = this.todo();
    if (!todo.length) return null;
    if (!this.work.sites().length) return { cutOff: this.unreachable().length };
    const c = this.io.fort.crew;
    if (c && (c.carrying || c.working)) return null;
    const need: Goods = {};
    for (const b of todo) for (const [g, v] of Object.entries(this.work.book.need(b)) as [Good, number][]) need[g] = (need[g] ?? 0) + v;
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

  /** whether anyone works at bringing a good in (a quarry's miners: stone; woodcutters: wood) */
  private bringing(g: Good): boolean {
    const busy = new Set(this.life.units().map((id) => this.life.jobOf(id)));
    for (const s of this.work.slots(this.life.crowdNow())) {
      if (s.kind === 'build' || !busy.has(s.key)) continue;
      if ((DEFS[s.kind].perBlock.makes?.[g] ?? 0) > 0) return true;
    }
    return false;
  }

  // ---- the bar, the follow card -----------------------------------------------------------------------------------

  private writeStatus(): void {
    const f = this.io.fort;
    const jobs: Record<string, number> = {};
    const workers = new Map<number, number>();
    const crew = { builders: 0, toStores: 0, carrying: 0, working: 0, waiting: 0 };
    for (const id of this.life.units()) {
      const s = this.life.jobSlot(id);
      const k = s ? s.kind : 'idle';
      jobs[k] = (jobs[k] ?? 0) + 1;
      if (s && s.structure !== null) workers.set(s.structure, (workers.get(s.structure) ?? 0) + 1);
      const p = this.life.phaseOf(id) ?? 'idle';
      if (k !== 'build' && p !== 'toSite' && p !== 'working') continue;
      crew.builders++;
      if (p === 'toStores') crew.toStores++;
      else if (p === 'toSite') crew.carrying++;
      else if (p === 'working') crew.working++;
      else crew.waiting++;
    }
    f.crew = crew;
    // (m4) the soldiers in the ledger (the bar's and Inspect's: stores.soldiers)
    const had = this.io.stores().soldiers ?? 0;
    const n = this.life.soldiers().length;
    if (had !== n) this.io.take('soldiers', had - n);
    this.stats.refunds = this.work.refunds;
    Object.assign(this.stats, this.work.stats);
    f.status = {
      people: this.life.units().length,
      jobs,
      workers,
      made: this.work.made,
      ripe: this.work.ripe,
      full: !fits(this.io.stores(), f.room(), ECON.haul),
      hungry: (this.io.stores().grain ?? 0) < 1,
    };
  }

  /** (follow) a word on a unit's day (repeats folded; a new day starts a new list) */
  private logDay(id: UnitId, word: string | null): void {
    const n = Math.floor(this.t / ECON.daySec);
    if (n !== this.todayN) {
      this.todayN = n;
      this.today.clear();
    }
    if (word === null) return;
    const l = this.today.get(id) ?? [];
    if (l[l.length - 1] !== word) l.push(word);
    if (l.length > 12) l.shift();
    this.today.set(id, l);
  }

  /** (follow) what a unit is doing now, as the card tells it: its phase in the routine */
  private doingOf(id: UnitId): Doing {
    const p = this.life.phaseOf(id) ?? 'idle';
    const role = this.io.units.get(id)?.role;
    if (role === 'cart') return p === 'out' ? 'cart-out' : p === 'back' ? 'cart-back' : 'cart-park';
    if (role === 'guard') return p === 'patrol' ? 'wall' : p === 'drill' ? 'drill' : p === 'march' || p === 'guard' ? 'march' : 'muster';
    switch (p) {
      case 'home':
      case 'shelter':
      case 'inside':
        return 'home';
      case 'rest':
        return 'rest';
      case 'arriving':
        return 'arrive';
      case 'toEat':
      case 'eating':
        return 'eat';
      case 'toStores':
      case 'waitLoad':
        return 'build-fetch';
      case 'toSite':
        return 'build-carry';
      case 'working':
        return 'build-work';
      case 'toFetch':
      case 'waitBatch':
        return 'fetch';
      case 'toWork':
      case 'waitSpot':
      case 'toBatch':
        return 'to-work';
      case 'gather':
      case 'digging':
      case 'felling':
      case 'batching':
        return this.life.jobSlot(id)?.kind === 'barracks' ? 'drill' : 'work';
      case 'carry':
        return 'haul';
      default:
        return 'idle';
    }
  }

  /** (round 128l, m4; V128-10) the follow card's facts on a unit of the fortress (null: not one, or gone) */
  personFacts(id: UnitId): PersonFacts | null {
    const v = this.io.units.get(id);
    if (!v?.alive || this.life.phaseOf(id) === null) return null;
    const slot = this.life.jobSlot(id);
    const JOB: Record<string, string> = { build: 'builder', farm: 'farmer', quarry: 'miner', lumber: 'woodcutter', blacksmith: 'smith', barracks: 'recruit' };
    const f = this.io.fort;
    const place = (sid: number | null | undefined) => {
      const s = sid != null ? f.plan.structure(sid) : null;
      return s ? `the ${DEFS[s.type].one}` : null;
    };
    const kind = v.role === 'cart' ? 'cart' : v.role === 'guard' ? 'soldier' : 'villager';
    const leg = this.legs.get(id);
    return {
      id,
      kind,
      job: kind === 'villager' && slot ? JOB[slot.kind] : null,
      workplace: kind === 'cart' ? place(leg?.leg === 'pile' && typeof leg.to === 'number' ? leg.to : null) : place(slot?.structure ?? null),
      doing: this.doingOf(id),
      carrying: this.life.holding(id),
      today: [...(this.today.get(id) ?? [])],
      hungry: (this.io.stores().grain ?? 0) < 1,
      day: Math.floor(this.t / ECON.daySec),
    };
  }

  dispose(): void {
    const U = this.io.units;
    this.work.dispose();
    for (const id of this.everyone()) U.remove(id);
    if (U.routine === this) U.routine = null;
    const A = U.agents;
    for (const f of [F.pile, F.site, F.store, F.quarry, F.fell, F.farm, F.home]) A.seed(f, []);
    for (const [f] of ARRIVE) A.arrivals(f, 0);
    A.keepInScope('fortress', []);
    A.setRoads(new Float32Array(0));
    for (const g of [R.toPile, R.toHome, R.toFarm, R4.toSmith, R4.toBarracks, R4.toPost, ...Array.from({ length: CART_GROUPS }, (_, i) => R4.cart0 + i)]) A.ride(g, null);
    A.setRoadGraph(noGraph());
  }
}
