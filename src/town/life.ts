// One crowd for a town's people, on events (DA-A6, round 128o; DESIGN.md section 11: "One crowd"; "no per-frame CPU copy
// of all units"). The routine that is to replace fortress/life.ts's FortressLife and settle/life.ts's SettlementLife:
// every town's people work its plan's job board (economy.ts jobSlots: a generated town's farms, quarries and lumber camps
// give jobs as the player's do; the builders' slot while there's building), and a unit's phase moves only on what
// happens to it — never on a position read back.
//  - In: events (`LifeEvent`) — a leg's arrival (the agents' `arrived` on its field, DA-B2a, or the ride's at a trip's
//    goal), a world operation's answer (dug, felled), a death; the town's own (goods into the stores, the sites changed,
//    a structure's work ready, goods on a pile for a cart, room for a newcomer: TownWork's adapter emits them); a lost
//    event (the agents' ring overflowed) is thrown.
//  - Out: orders (`Order`) — the leg a unit follows (its group: a field or a ride; a leg with a target — a cart's pile,
//    a soldier's wall point — names it), what it carries, a world operation to ask for, a newcomer to stand up, a person
//    turned soldier. The wiring (AgentUnits, the world API) carries them out and turns what comes back into events.
//  - Time: a phase that takes time (working a load in, gathering, a batch, a drill, eating) counts sim seconds in `tick`;
//    nothing waits on a timer to give up.
// Nothing is polled: a unit waiting (at the stores with nothing to bring or no batch to start, at its work with nothing
// ready, a cart with no pile) waits for the event that changes that. Pure: no GPU, no DOM, no units — tested with scripted
// event streams (life.test.ts). Every town runs it (src/town/; the fortress's adapter is fortress/townwork.ts).
// The crowd: people (the job board's — builders, farmers, miners, woodcutters, smiths, recruits; a newcomer walks in to a
// house first), soldiers (a recruit drilled: muster at the barracks, drill, march to the wall's stairs, walk the wall,
// muster again each morning) and carts (a long haul is left on its structure's pile; a cart rides out for it).
import { JobBoard, type JobKind, type JobSlot, type Load } from './jobs';
import type { Good, Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import type { Block } from '../build/town';

/** the legs a unit walks or rides: each the wiring's field or ride group ('pile', 'wall': with a target) */
export type Leg = 'stores' | 'site' | 'farm' | 'quarry' | 'fell' | 'home' | 'smithy' | 'barracks' | 'post' | 'wall' | 'pile';
/** a leg's target, for the legs that have one: a cart's pile (its structure), a soldier's wall point */
export type To = number | V2;

export type LifeEvent =
  /** a unit got to the end of its leg (where it stands: from the event, never read; `to`: the leg's target) */
  | { type: 'arrived'; unit: number; leg: Leg; at: V2; to?: To }
  /** a dig answered: how much ground came */
  | { type: 'dug'; unit: number; amount: number }
  /** a felling answered: its logs (0: no tree there any more) */
  | { type: 'felled'; unit: number; logs: number }
  | { type: 'death'; unit: number }
  /** (the town's) goods came into the stores: a builder, smith or recruit waiting there may have something now */
  | { type: 'stores' }
  /** (the town's) the plan's sites changed (planned, erased, cut off or reached again) */
  | { type: 'sites' }
  /** (the town's) a structure has work ready: ripe grain, a tree in reach, a free spot */
  | { type: 'spot'; structure: number }
  /** (the town's) goods were left on a pile: a parked cart may ride out */
  | { type: 'pile' }
  /** (the town's) beds or grain changed: a newcomer may come */
  | { type: 'room' }
  /** events the agents' ring dropped (it overflowed): a unit may never hear of its arrival */
  | { type: 'lost'; count: number }
  /** (the town's) raiders about (on): the people go home and stay in; gone (off): back to their day */
  | { type: 'shelter'; on: boolean };

export type Order =
  /** follow this leg (to its target, for the legs that have one); null: stand where it is. `again`: tell its arrival
   *  even where it was told one already (the leg's goals changed under it: the agents' latch let go) */
  | { unit: number; go: Leg | null; to?: To; again?: true }
  /** carry this (a look: 'stone', 'log', 'grain', 'ore'), or nothing */
  | { unit: number; carry: string | null }
  | { unit: number; dig: V2 }
  | { unit: number; fell: V2 }
  /** this person is a soldier now (the wiring restyles the unit: a guard's look, health, blow) */
  | { unit: number; become: 'soldier' }
  /** a newcomer to stand up where the town's people come in; the wiring calls `arrive(unit)` once it stands */
  | { newcomer: true };

/** who's in the crowd, as the town's answers need it */
export interface Crowd {
  people: number;
  soldiers: number;
  carts: number;
}

/** What the routine asks of the town (the plan, its stores, its sites, its work spots): pure answers. */
export interface TownWork {
  /** the town's day (sim seconds): a person's day — work, a meal at midday, home to rest at its end */
  readonly daySec: number;
  /** seconds a soldier drills at the barracks when it musters; wall points it walks before it musters again */
  readonly drillSec: number;
  readonly patrolPoints: number;
  /** the jobs open now, in priority order */
  slots(crowd: Crowd): JobSlot[];
  /** a builder at the stores: the next block that lacks something the stores have, and the load taken out for it
   *  (taken now); null: nothing to bring */
  nextLoad(): { block: Block; load: Load } | null;
  /** the block a builder with this load works in, arrived at `at` (its field led it to the nearest site lacking the
   *  load's good); null: none there any more (erased or built) — the load goes back */
  siteAt(at: V2, load: Load, meant: Block): Block | null;
  /** a load worked into a block */
  workIn(block: Block, load: Load): void;
  /** a load that couldn't be worked in, back into the stores */
  giveBack(block: Block, load: Load): void;
  /** goods carried home, into the stores (what fits) */
  deliver(goods: Goods, from: number | null): void;
  /** a worker of a structure arrived at `at`: the spot it works (a farm cell, the quarry's face, a tree); null: none */
  workSpot(kind: JobKind, structure: number, at: V2): V2 | null;
  /** a farmer's reap at a spot: the grain, and the seconds it takes */
  reap(structure: number, spot: V2): { goods: Goods; seconds: number };
  /** what a load of dug ground is (stone, a share of it ore) */
  dugGoods(amount: number): Goods;
  /** a smith or recruit at the stores: its batch's goods, taken out now, and the seconds of its work; null: the stores
   *  lack them, or (a recruit) there's no bed in the barracks for another soldier */
  startBatch(unit: number, kind: JobKind, structure: number, crowd: Crowd): { goods: Goods; seconds: number } | null;
  /** a batch worked: a smith's goods to carry home, or 'soldier' (the recruit is one now) */
  finishBatch(unit: number): Goods | 'soldier';
  /** a batch dropped before it was worked (the job changed, the worker died): its goods back into the stores */
  dropBatch(unit: number): void;
  /** a worker's haul home from its structure: true — left on the structure's pile for a cart (taken now); false — walked */
  pile(structure: number, goods: Goods, crowd: Crowd): boolean;
  /** a cart without a load: the pile it rides out for (claimed for it), or null: none worth a ride */
  pileFor(cart: number): number | null;
  /** a cart at its pile: the goods it loads, up to a cart's load; its claim ends */
  loadPile(cart: number, structure: number): Goods;
  /** a cart gone before it got to its pile: its claim ends (the goods stay for another) */
  unclaim(cart: number): void;
  /** a soldier's next wall point along from `from` (null from: its first — the nearest `at`); null: no wall */
  wallPoint(at: V2, from: V2 | null): V2 | null;
  /** whether one more person may come (a bed for it, grain to eat) */
  mayArrive(crowd: Crowd): boolean;
}

/** seconds working a load in */
export const WORK_S = 1.5;
/** ground dug a load */
export const DIG = 2;
/** a person's day (a share of it): a meal at the stores from EAT_FROM (EAT_S s), home to rest from REST_FROM */
export const EAT_FROM = 0.45;
export const EAT_S = 2;
export const REST_FROM = 0.9;

type Phase =
  | { p: 'idle' }
  | { p: 'home' }
  | { p: 'toStores' }
  /** at the stores with nothing to bring: until the stores or the sites change */
  | { p: 'waitLoad' }
  | { p: 'toSite'; block: Block; load: Load }
  | { p: 'working'; block: Block; load: Load; t: number }
  | { p: 'toWork' }
  /** at its work with nothing ready: until its structure has */
  | { p: 'waitSpot'; at: V2 }
  | { p: 'gather'; goods: Goods; t: number }
  | { p: 'digging' }
  | { p: 'felling' }
  | { p: 'carry'; goods: Goods }
  | { p: 'toEat' }
  | { p: 'eating'; t: number }
  | { p: 'rest' }
  // ---- smiths and recruits: a batch out of the stores, carried to the structure, worked there
  | { p: 'toFetch' }
  /** at the stores with no batch to start: until the stores change (or a soldier's bed frees) */
  | { p: 'waitBatch' }
  | { p: 'toBatch'; seconds: number }
  | { p: 'batching'; t: number }
  // ---- a newcomer: to a house first
  | { p: 'arriving' }
  // ---- raiders about: home, and in
  | { p: 'shelter' }
  | { p: 'inside' }
  // ---- soldiers
  | { p: 'muster' }
  | { p: 'drill'; t: number }
  | { p: 'march' }
  /** at the wall's stairs with no wall to walk: until the morning's muster */
  | { p: 'guard' }
  | { p: 'patrol'; at: V2; walked: number }
  // ---- carts
  /** parked with no pile to ride for: until a pile has goods */
  | { p: 'park' }
  | { p: 'out'; pile: number }
  | { p: 'back'; goods: Goods; pile: number };

type Role = 'person' | 'soldier' | 'cart';

interface Unit {
  unit: number;
  role: Role;
  phase: Phase;
  /** the leg it last arrived at the end of (and its target), and where — until it's sent on another (a unit standing at
   *  its field's end isn't told it's there again: agents' arrivals latch) */
  there: { leg: Leg; to?: To; at: V2 } | null;
  /** the leg it was sent on since the orders last went out (undefined: none; null: told to stand) */
  sent?: { leg: Leg; to?: To } | null;
  /** the day it last ate */
  ate: number;
  /** taken out of its round by the game (a soldier the defence posts): its orders and arrivals aren't the routine's */
  away?: boolean;
}

/** the look a load of goods is carried as: its largest good */
function lookOf(goods: Goods): string | null {
  const main = (Object.entries(goods) as [Good, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
  return main ? main[0] : null;
}

function sameTo(a: To | undefined, b: To | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

/** phases holding something of the town's (a load, a batch, goods): their job is kept first at the board's turn */
const HOLDING: ReadonlySet<Phase['p']> = new Set(['toSite', 'working', 'toBatch', 'batching', 'carry', 'gather', 'digging', 'felling']);

export class TownLife {
  private crowd = new Map<number, Unit>();
  private board = new JobBoard();
  private orders: Order[] = [];
  /** sim seconds since it began */
  private t = 0;
  /** a newcomer asked for and not yet standing (one walks in at a time) */
  private calling = false;
  /** raiders about: the people stay in (and nobody new comes) */
  private sheltering = false;
  /** the jobs open at the last job board's turn (asked of the town once a tick) */
  private slotsNow: JobSlot[] | null = null;

  constructor(private work: TownWork) {}

  /** a person of the town (a unit already standing in the world) */
  add(unit: number): void {
    this.join(unit, 'person', { p: 'idle' });
  }

  /** a newcomer the wiring stood up (an `{newcomer}` order answered): to a house first, then the job board's */
  arrive(unit: number): void {
    if (!this.calling) throw new Error(`town life: unit ${unit} came in as a newcomer no one asked for`);
    this.calling = false;
    this.set(this.join(unit, 'person', { p: 'arriving' }), { p: 'arriving' }, 'home');
  }

  /** a soldier of the town (a unit standing in the world): it musters at the barracks */
  addSoldier(unit: number): void {
    this.muster(this.join(unit, 'soldier', { p: 'muster' }));
  }

  /** a cart of the town (a unit on the road by the stores): it rides for a pile when there's one */
  addCart(unit: number): void {
    const u = this.join(unit, 'cart', { p: 'out', pile: -1 });
    // (claimed nothing yet: a pile, or parked where it stands)
    this.toPile(u);
  }

  private join(unit: number, role: Role, phase: Phase): Unit {
    if (this.crowd.has(unit)) throw new Error(`town life: unit ${unit} is in the crowd already`);
    const u: Unit = { unit, role, phase, there: null, ate: -1 };
    this.crowd.set(unit, u);
    return u;
  }

  /** the town's people (their units: not its soldiers, not its carts) */
  units(): number[] {
    return this.of('person').map((u) => u.unit);
  }

  soldiers(): number[] {
    return this.of('soldier').map((u) => u.unit);
  }

  carts(): number[] {
    return this.of('cart').map((u) => u.unit);
  }

  private of(role: Role): Unit[] {
    return [...this.crowd.values()].filter((u) => u.role === role);
  }

  private count(): Crowd {
    const c: Crowd = { people: 0, soldiers: 0, carts: 0 };
    for (const u of this.crowd.values()) {
      if (u.role === 'person') c.people++;
      else if (u.role === 'soldier') c.soldiers++;
      else c.carts++;
    }
    return c;
  }

  /** a newcomer asked for can't come now (nowhere it could walk in from): the next `room` event asks again */
  turnedAway(): void {
    this.calling = false;
  }

  /** a unit taken out of its round by the game (the defence posts a soldier): the routine leaves it be */
  away(unit: number): void {
    const u = this.crowd.get(unit);
    if (!u) return;
    this.drop(u);
    u.away = true;
    u.phase = { p: 'idle' };
    u.there = null;
    u.sent = undefined;
  }

  /** a unit given back to its round: a soldier musters, a person starts its day over */
  back(unit: number): void {
    const u = this.crowd.get(unit);
    if (!u?.away) return;
    u.away = false;
    if (u.role === 'soldier') this.muster(u);
    else if (u.role === 'cart') this.toPile(u);
    else this.start(u);
  }

  /** what a unit has in hand: a builder's load, a batch's goods on their way, goods carried home */
  holding(unit: number): Goods {
    const ph = this.crowd.get(unit)?.phase;
    if (!ph) return {};
    if (ph.p === 'toSite' || ph.p === 'working') return { [ph.load.good]: ph.load.amount };
    if (ph.p === 'carry' || ph.p === 'back') return { ...ph.goods };
    return {};
  }

  /** the pile a cart rides for, or brings a load back from (null: none) */
  cartPile(unit: number): number | null {
    const ph = this.crowd.get(unit)?.phase;
    return ph && (ph.p === 'out' || ph.p === 'back') ? ph.pile : null;
  }

  /** the people in at home while raiders are about */
  inside(): number[] {
    return [...this.crowd.values()].filter((u) => u.phase.p === 'inside').map((u) => u.unit);
  }

  /** a unit's phase now (tests, the follow card) */
  phaseOf(unit: number): Phase['p'] | null {
    return this.crowd.get(unit)?.phase.p ?? null;
  }

  /** a person's job slot now (null: none) */
  jobSlot(unit: number): JobSlot | null {
    return this.slot(unit);
  }

  /** who's in the crowd */
  crowdNow(): Crowd {
    return this.count();
  }

  /** a person's job now (its slot's key), or none */
  jobOf(unit: number): string | null {
    return this.board.jobOf(unit);
  }

  /** What happened: each event moves its unit on. */
  on(e: LifeEvent): void {
    if (e.type === 'lost') throw new Error(`town life: ${e.count} agent events lost (the ring overflowed) — a unit may wait for an arrival it never hears of`);
    if (e.type === 'stores' || e.type === 'sites') {
      for (const u of this.crowd.values()) {
        if (u.phase.p === 'waitLoad' || (u.phase.p === 'waitBatch' && e.type === 'stores')) this.arrived(u, 'stores', u.there?.at ?? [0, 0], true);
      }
      return this.settleOwed();
    }
    if (e.type === 'spot') {
      for (const u of this.crowd.values()) {
        const ph = u.phase;
        if (ph.p === 'waitSpot' && this.slot(u.unit)?.structure === e.structure) this.arrived(u, this.legOf(u), ph.at, true);
      }
      return this.settleOwed();
    }
    if (e.type === 'pile') {
      for (const u of this.crowd.values()) if (u.phase.p === 'park') this.toPile(u);
      return this.settleOwed();
    }
    if (e.type === 'room') return this.callNewcomer();
    if (e.type === 'shelter') {
      if (e.on === this.sheltering) return;
      this.sheltering = e.on;
      for (const u of this.crowd.values()) {
        if (u.role !== 'person' || u.away) continue;
        if (e.on) {
          // (goods carried home go in; a load or a batch goes back)
          if (u.phase.p === 'carry') this.work.deliver(u.phase.goods, null);
          this.drop(u);
          this.set(u, { p: 'shelter' }, 'home');
        } else this.start(u);
      }
      return this.settleOwed();
    }
    const u = this.crowd.get(e.unit);
    if (!u) return;
    if (e.type === 'death') return this.died(u);
    if (u.away) return;
    const ph = u.phase;
    if (e.type === 'arrived') {
      u.there = { leg: e.leg, to: e.to, at: e.at };
      this.arrived(u, e.leg, e.at, false, e.to);
      return this.settleOwed();
    }
    if (e.type === 'dug' && ph.p === 'digging') {
      if (e.amount > 0) return this.carryHome(u, this.work.dugGoods(e.amount));
      // (nothing left to dig where it stood: to the next spot — wherever that is now, it's told)
      return this.toWork(u, true);
    }
    if (e.type === 'felled' && ph.p === 'felling') {
      if (e.logs > 0) return this.carryHome(u, { log: e.logs });
      // (the tree was gone: to the next)
      return this.toWork(u, true);
    }
  }

  /** what a unit held goes back (a load, a batch, a pile's claim) — it's gone, or taken out of its round */
  private drop(u: Unit): void {
    const ph = u.phase;
    if (ph.p === 'toSite' || ph.p === 'working') this.work.giveBack(ph.block, ph.load);
    if (ph.p === 'toBatch' || ph.p === 'batching') this.work.dropBatch(u.unit);
    // (a cart gone on its way out: its claim ends — the goods stay on the pile for another)
    if (ph.p === 'out') this.work.unclaim(u.unit);
    if (ph.p === 'toSite' || ph.p === 'working' || ph.p === 'toBatch' || ph.p === 'batching' || ph.p === 'carry' || ph.p === 'back') this.order({ unit: u.unit, carry: null });
    u.phase = { p: 'idle' };
  }

  /** a unit gone: what it held goes back; a soldier's bed frees, a person's room */
  private died(u: Unit): void {
    this.crowd.delete(u.unit);
    this.drop(u);
    if (u.role === 'soldier') {
      // (a bed in the barracks free: a recruit waiting for one may start)
      for (const w of this.crowd.values()) if (w.phase.p === 'waitBatch') this.arrived(w, 'stores', w.there?.at ?? [0, 0], true);
      this.settleOwed();
    }
    if (u.role === 'person') this.callNewcomer();
  }

  /** a newcomer, when the town has room for one and none is on its way in */
  private callNewcomer(): void {
    if (this.calling || this.sheltering || [...this.crowd.values()].some((u) => u.phase.p === 'arriving')) return;
    if (!this.work.mayArrive(this.count())) return;
    this.calling = true;
    this.order({ newcomer: true });
  }

  /**
   * Sim seconds on: the job board's turn (people whose job changed start over), the phases that take time count down,
   * the soldiers' morning muster.
   * The orders for the wiring since the last call.
   */
  tick(dt: number): Order[] {
    const dayWas = this.day();
    this.t += dt;
    const slots = (this.slotsNow = this.work.slots(this.count()));
    // (those holding something keep their job first: a batch, a load, goods in hand aren't dropped for one who has none)
    const holding = (u: Unit) => (HOLDING.has(u.phase.p) ? 0 : 1);
    const people = this.of('person')
      .filter((u) => u.phase.p !== 'arriving' && !u.away)
      .sort((a, b) => holding(a) - holding(b))
      .map((u) => u.unit);
    const changed = this.board.assign(people, slots);
    // (sheltering: the new jobs wait until they come out)
    if (!this.sheltering) for (const id of changed) this.start(this.crowd.get(id)!);
    const morning = this.day() !== dayWas;
    for (const u of this.crowd.values()) {
      const ph = u.phase;
      if (u.away || ph.p === 'shelter' || ph.p === 'inside') continue;
      if (u.role === 'soldier') {
        if (ph.p === 'drill') {
          ph.t -= dt;
          if (ph.t <= 0) this.set(u, { p: 'march' }, 'post');
        } else if (morning && ph.p !== 'muster') this.muster(u);
        continue;
      }
      if (ph.p === 'idle') this.start(u);
      else if (ph.p === 'rest') {
        if (this.dayFrac() < REST_FROM) this.start(u);
      } else if (ph.p === 'eating') {
        ph.t -= dt;
        if (ph.t <= 0) {
          u.ate = this.day();
          this.start(u);
        }
      } else if (ph.p === 'working') {
        ph.t -= dt;
        if (ph.t <= 0) {
          this.work.workIn(ph.block, ph.load);
          this.order({ unit: u.unit, carry: null });
          u.phase = { p: 'idle' };
          this.start(u);
        }
      } else if (ph.p === 'gather') {
        ph.t -= dt;
        if (ph.t <= 0) this.carryHome(u, ph.goods);
      } else if (ph.p === 'batching') {
        ph.t -= dt;
        if (ph.t <= 0) this.batchDone(u);
      }
    }
    this.settleOwed();
    return this.orders.splice(0);
  }

  /**
   * Each unit's last leg since the orders went out is what the agents will follow: one sent on the leg (and target) it's
   * already at the end of is there (the agents tell an arrival once — their latch holds while it follows the same
   * field), so it's told now; one sent on another isn't there any more.
   */
  private settleOwed(): void {
    for (let round = 0; ; round++) {
      const owed: Unit[] = [];
      for (const u of this.crowd.values()) {
        const go = u.sent;
        if (go === undefined || u.away) continue;
        u.sent = undefined;
        if (go === null) continue;
        if (u.there?.leg === go.leg && sameTo(u.there.to, go.to)) owed.push(u);
        else u.there = null;
      }
      if (!owed.length) return;
      if (round > 8) throw new Error('town life: a unit sent where it already is, over and over');
      for (const u of owed) this.arrived(u, u.there!.leg, u.there!.at, false, u.there!.to);
    }
  }

  private order(o: Order): void {
    this.orders.push(o);
  }

  private set(u: Unit, phase: Phase, go: Leg | null, to?: To, again = false): void {
    u.phase = phase;
    u.sent = go === null ? null : { leg: go, to };
    const o: Order = to === undefined ? { unit: u.unit, go } : { unit: u.unit, go, to };
    if (again) o.again = true;
    this.order(o);
  }

  /** the leg a worker's job takes it to */
  private legOf(u: Unit): Leg {
    const k = this.slot(u.unit)?.kind;
    return k === 'farm' ? 'farm' : k === 'quarry' ? 'quarry' : k === 'blacksmith' ? 'smithy' : k === 'barracks' ? 'barracks' : 'fell';
  }

  private slot(unit: number): JobSlot | null {
    const key = this.board.jobOf(unit);
    if (!key) return null;
    this.slotsNow ??= this.work.slots(this.count());
    return this.slotsNow.find((s) => s.key === key) ?? null;
  }

  private day(): number {
    return Math.floor(this.t / this.work.daySec);
  }

  private dayFrac(): number {
    return (this.t / this.work.daySec) % 1;
  }

  /** a person starting over: home to rest at the day's end, a meal at midday, else its job's first leg, or home */
  private start(u: Unit): void {
    // (what's in hand goes back where it came from: the job changed under it)
    const ph = u.phase;
    if (ph.p === 'toSite' || ph.p === 'working') this.work.giveBack(ph.block, ph.load);
    if (ph.p === 'toBatch' || ph.p === 'batching') {
      this.work.dropBatch(u.unit);
      this.order({ unit: u.unit, carry: null });
    }
    if (ph.p === 'carry') this.work.deliver(ph.goods, null);
    if (this.dayFrac() >= REST_FROM) return this.set(u, { p: 'rest' }, 'home');
    if (this.dayFrac() >= EAT_FROM && u.ate !== this.day()) return this.set(u, { p: 'toEat' }, 'stores');
    const s = this.slot(u.unit);
    if (!s) return this.set(u, { p: 'home' }, 'home');
    if (s.kind === 'build') return this.set(u, { p: 'toStores' }, 'stores');
    if (s.kind === 'blacksmith' || s.kind === 'barracks') return this.set(u, { p: 'toFetch' }, 'stores');
    this.toWork(u);
  }

  /** to its job's work; `again`: its spot there is gone — not there any more, wherever it stands */
  private toWork(u: Unit, again = false): void {
    const s = this.slot(u.unit);
    if (!s || s.structure === null) return this.start(u);
    if (again) u.there = null;
    this.set(u, { p: 'toWork' }, this.legOf(u), undefined, again);
  }

  /** goods home: left on the structure's pile for a cart when the town says so (a long haul), else carried to the stores */
  private carryHome(u: Unit, goods: Goods): void {
    const s = this.slot(u.unit);
    if (s?.structure != null && this.work.pile(s.structure, goods, this.count())) {
      this.order({ unit: u.unit, carry: null });
      return this.toWork(u);
    }
    this.order({ unit: u.unit, carry: lookOf(goods) });
    this.set(u, { p: 'carry', goods }, 'stores');
  }

  /** a batch worked at its structure: a smith carries its goods home; a recruit is a soldier now */
  private batchDone(u: Unit): void {
    const out = this.work.finishBatch(u.unit);
    if (out !== 'soldier') return this.carryHome(u, out);
    this.order({ unit: u.unit, become: 'soldier' });
    u.role = 'soldier';
    this.muster(u);
    // (one person fewer: room for a newcomer)
    this.callNewcomer();
  }

  private muster(u: Unit): void {
    this.set(u, { p: 'muster' }, 'barracks');
  }

  /** a cart without a load: out to the pile the town gives it, or parked until one has goods */
  private toPile(u: Unit): void {
    const pile = this.work.pileFor(u.unit);
    if (pile !== null) return this.set(u, { p: 'out', pile }, 'pile', pile);
    if (u.phase.p !== 'park') this.set(u, { p: 'park' }, null);
  }

  private arrived(u: Unit, leg: Leg, at: V2, again = false, to?: To): void {
    const ph = u.phase;
    const unit = u.unit;
    // ---- carts
    if (u.role === 'cart') {
      if (ph.p === 'out' && leg === 'pile' && to === ph.pile) {
        const goods = this.work.loadPile(unit, ph.pile);
        const look = lookOf(goods);
        if (!look) return this.toPile(u);
        this.order({ unit, carry: look });
        return this.set(u, { p: 'back', goods, pile: ph.pile }, 'stores');
      }
      if (ph.p === 'back' && leg === 'stores') {
        this.work.deliver(ph.goods, ph.pile);
        this.order({ unit, carry: null });
        return this.toPile(u);
      }
      return;
    }
    // ---- soldiers
    if (u.role === 'soldier') {
      if (ph.p === 'muster' && leg === 'barracks') return this.set(u, { p: 'drill', t: this.work.drillSec }, null);
      if (ph.p === 'march' && leg === 'post') {
        const p = this.work.wallPoint(at, null);
        // (no wall to walk: it stands guard at the stairs until the morning's muster)
        if (!p) return this.set(u, { p: 'guard' }, null);
        return this.set(u, { p: 'patrol', at: p, walked: 0 }, 'wall', p);
      }
      if (ph.p === 'patrol' && leg === 'wall' && sameTo(to, ph.at)) {
        const walked = ph.walked + 1;
        const next = walked < this.work.patrolPoints ? this.work.wallPoint(at, ph.at) : null;
        if (!next) return this.muster(u);
        return this.set(u, { p: 'patrol', at: next, walked }, 'wall', next);
      }
      return;
    }
    // ---- people
    if ((ph.p === 'toStores' || (again && ph.p === 'waitLoad')) && leg === 'stores') {
      const job = this.work.nextLoad();
      // (nothing to bring: it waits by the stores until they or the sites change)
      if (!job) {
        if (ph.p !== 'waitLoad') this.set(u, { p: 'waitLoad' }, null);
        return;
      }
      this.order({ unit, carry: job.load.good });
      return this.set(u, { p: 'toSite', block: job.block, load: job.load }, 'site');
    }
    if (ph.p === 'toSite' && leg === 'site') {
      const b = this.work.siteAt(at, ph.load, ph.block);
      if (!b) {
        this.work.giveBack(ph.block, ph.load);
        this.order({ unit, carry: null });
        return this.set(u, { p: 'toStores' }, 'stores');
      }
      return this.set(u, { p: 'working', block: b, load: ph.load, t: WORK_S }, null);
    }
    if ((ph.p === 'toFetch' || (again && ph.p === 'waitBatch')) && leg === 'stores') {
      const s = this.slot(unit);
      if (!s || s.structure === null || (s.kind !== 'blacksmith' && s.kind !== 'barracks')) return this.start(u);
      const batch = this.work.startBatch(unit, s.kind, s.structure, this.count());
      // (nothing to start: it waits by the stores until they change, or a soldier's bed frees)
      if (!batch) {
        if (ph.p !== 'waitBatch') this.set(u, { p: 'waitBatch' }, null);
        return;
      }
      this.order({ unit, carry: lookOf(batch.goods) });
      return this.set(u, { p: 'toBatch', seconds: batch.seconds }, this.legOf(u));
    }
    if (ph.p === 'toBatch' && (leg === 'smithy' || leg === 'barracks')) {
      this.order({ unit, carry: null });
      return this.set(u, { p: 'batching', t: ph.seconds }, null);
    }
    if (ph.p === 'toWork' || (again && ph.p === 'waitSpot')) {
      const s = this.slot(unit);
      if (!s || s.structure === null) return this.start(u);
      const spot = this.work.workSpot(s.kind, s.structure, at);
      if (!spot) {
        if (ph.p !== 'waitSpot') this.set(u, { p: 'waitSpot', at }, null);
        return;
      }
      if (s.kind === 'farm') {
        const r = this.work.reap(s.structure, spot);
        return this.set(u, { p: 'gather', goods: r.goods, t: r.seconds }, null);
      }
      if (s.kind === 'quarry') {
        this.order({ unit, dig: spot });
        return this.set(u, { p: 'digging' }, null);
      }
      this.order({ unit, fell: spot });
      return this.set(u, { p: 'felling' }, null);
    }
    if (ph.p === 'carry' && leg === 'stores') {
      this.work.deliver(ph.goods, this.slot(unit)?.structure ?? null);
      this.order({ unit, carry: null });
      // (on with the tick: after the board's turn, as what the board says then)
      u.phase = { p: 'idle' };
      return;
    }
    if (ph.p === 'shelter' && leg === 'home') return this.set(u, { p: 'inside' }, null);
    if (ph.p === 'arriving' && leg === 'home') {
      // (in: the job board's from the next tick; the next newcomer may come)
      u.phase = { p: 'idle' };
      return this.callNewcomer();
    }
    if (ph.p === 'home' && leg === 'home') return this.set(u, { p: 'home' }, null);
    if (ph.p === 'rest' && leg === 'home') return this.set(u, { p: 'rest' }, null);
    if (ph.p === 'toEat' && leg === 'stores') return this.set(u, { p: 'eating', t: EAT_S }, null);
  }
}
