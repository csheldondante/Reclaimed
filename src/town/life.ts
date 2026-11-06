// One crowd for a town's people, on events (DA-A6, round 128o; DESIGN.md section 11: "One crowd"; "no per-frame CPU copy
// of all units"). The routine that is to replace fortress/life.ts's FortressLife and settle/life.ts's SettlementLife:
// every town's people work its plan's job board (economy.ts jobSlots: a generated town's farms, quarries and lumber camps
// give jobs as the player's do; the builders' slot while there's building), and a person's phase moves only on what
// happens to it — never on a position read back.
//  - In: events (`LifeEvent`) — a leg's arrival (the agents' `arrived` on its field, DA-B2a, or the ride's at a trip's
//    goal), a world operation's answer (dug, felled), a death; the town's own (goods into the stores, the sites changed,
//    a structure's work ready: TownWork's adapter emits them); a lost event (the agents' ring overflowed) is thrown.
//  - Out: orders (`Order`) — the leg a unit follows (its group: a field or a ride), what it carries, a world operation
//    to ask for. The wiring (AgentUnits, the world API) carries them out and turns what comes back into events.
//  - Time: a phase that takes time (working a load in, gathering, eating) counts sim seconds in `tick`; nothing waits on
//    a timer to give up.
// Nothing is polled: a person waiting (at the stores with nothing to bring, at its work with nothing ready) waits for the
// event that changes that. Pure: no GPU, no DOM, no units — tested with scripted event streams (life.test.ts). Every
// town runs it (round 128o: src/town/, its own folder; the fortress's adapter is fortress/townwork.ts).
// This slice: builders, farmers, miners, woodcutters, the people without work. Carts, smiths, recruits, soldiers and the
// newcomers' walk in are the next ones (DEVLOG round 128o, DA-A6's note).
import { JobBoard, type JobKind, type JobSlot, type Load } from './jobs';
import type { Good, Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import type { Block } from '../build/town';

/** the legs a person walks or rides: each the wiring's field or ride group */
export type Leg = 'stores' | 'site' | 'farm' | 'quarry' | 'fell' | 'home';

export type LifeEvent =
  /** a unit got to the end of its leg (where it stands: from the event, never read) */
  | { type: 'arrived'; unit: number; leg: Leg; at: V2 }
  /** a dig answered: how much ground came */
  | { type: 'dug'; unit: number; amount: number }
  /** a felling answered: its logs (0: no tree there any more) */
  | { type: 'felled'; unit: number; logs: number }
  | { type: 'death'; unit: number }
  /** (the town's) goods came into the stores: a builder waiting there may have a load now */
  | { type: 'stores' }
  /** (the town's) the plan's sites changed (planned, erased, cut off or reached again) */
  | { type: 'sites' }
  /** (the town's) a structure has work ready: ripe grain, a tree in reach, a free spot */
  | { type: 'spot'; structure: number }
  /** events the agents' ring dropped (it overflowed): a person may never hear of its arrival */
  | { type: 'lost'; count: number };

export type Order =
  /** follow this leg (null: stand where it is) */
  | { unit: number; go: Leg | null }
  /** carry this (a look: 'stone', 'log', 'grain', 'ore'), or nothing */
  | { unit: number; carry: string | null }
  | { unit: number; dig: V2 }
  | { unit: number; fell: V2 };

/** What the routine asks of the town (the plan, its stores, its sites, its work spots): pure answers. */
export interface TownWork {
  /** the town's day (sim seconds): a person's day — work, a meal at midday, home to rest at its end */
  readonly daySec: number;
  /** the jobs open now, in priority order */
  slots(): JobSlot[];
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
  | { p: 'rest' };

interface Person {
  unit: number;
  phase: Phase;
  /** the leg it last arrived at the end of, and where — until it's sent on another (a unit standing at its field's end
   *  isn't told it's there again: agents' arrivals latch) */
  there: { leg: Leg; at: V2 } | null;
  /** the leg it was sent on since the orders last went out (undefined: none; null: told to stand) */
  sent?: Leg | null;
  /** the day it last ate */
  ate: number;
}

/** the look a load of goods is carried as: its largest good */
function lookOf(goods: Goods): string | null {
  const main = (Object.entries(goods) as [Good, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
  return main ? main[0] : null;
}

export class TownLife {
  private people = new Map<number, Person>();
  private board = new JobBoard();
  private orders: Order[] = [];
  /** sim seconds since it began */
  private t = 0;


  constructor(private work: TownWork) {}

  /** a person of the town (a unit already standing in the world) */
  add(unit: number): void {
    if (this.people.has(unit)) throw new Error(`town life: unit ${unit} is one of its people already`);
    this.people.set(unit, { unit, phase: { p: 'idle' }, there: null, ate: -1 });
  }

  /** the town's people (their units) */
  units(): number[] {
    return [...this.people.keys()];
  }

  /** a person's phase now (tests, the follow card) */
  phaseOf(unit: number): Phase['p'] | null {
    return this.people.get(unit)?.phase.p ?? null;
  }

  /** a person's job now (its slot's key), or none */
  jobOf(unit: number): string | null {
    return this.board.jobOf(unit);
  }

  /** What happened: each event moves its person on. */
  on(e: LifeEvent): void {
    if (e.type === 'lost') throw new Error(`town life: ${e.count} agent events lost (the ring overflowed) — a person may wait for an arrival it never hears of`);
    if (e.type === 'stores' || e.type === 'sites') {
      for (const person of this.people.values()) if (person.phase.p === 'waitLoad') this.arrived(person, 'stores', person.there?.at ?? [0, 0], true);
      return this.settleOwed();
    }
    if (e.type === 'spot') {
      for (const person of this.people.values()) {
        const ph = person.phase;
        if (ph.p === 'waitSpot' && this.slot(person.unit)?.structure === e.structure) this.arrived(person, this.legOf(person), ph.at, true);
      }
      return this.settleOwed();
    }
    const person = this.people.get(e.unit);
    if (!person) return;
    if (e.type === 'death') {
      this.people.delete(e.unit);
      return;
    }
    const ph = person.phase;
    if (e.type === 'arrived') {
      person.there = { leg: e.leg, at: e.at };
      this.arrived(person, e.leg, e.at);
      return this.settleOwed();
    }
    if (e.type === 'dug' && ph.p === 'digging') return this.carryHome(person, this.work.dugGoods(e.amount));
    if (e.type === 'felled' && ph.p === 'felling') {
      if (e.logs > 0) return this.carryHome(person, { log: e.logs });
      // (the tree was gone: to the next)
      return this.toWork(person);
    }
  }

  /**
   * Sim seconds on: the job board's turn (people whose job changed start over), the phases that take time count down.
   * The orders for the wiring since the last call.
   */
  tick(dt: number): Order[] {
    this.t += dt;
    const slots = this.work.slots();
    const changed = this.board.assign(this.units(), slots);
    for (const u of changed) this.start(this.people.get(u)!);
    for (const person of this.people.values()) {
      const ph = person.phase;
      if (ph.p === 'idle') this.start(person);
      else if (ph.p === 'rest') {
        if (this.dayFrac() < REST_FROM) this.start(person);
      } else if (ph.p === 'eating') {
        ph.t -= dt;
        if (ph.t <= 0) {
          person.ate = this.day();
          this.start(person);
        }
      } else if (ph.p === 'working') {
        ph.t -= dt;
        if (ph.t <= 0) {
          this.work.workIn(ph.block, ph.load);
          this.order({ unit: person.unit, carry: null });
          person.phase = { p: 'idle' };
          this.start(person);
        }
      } else if (ph.p === 'gather') {
        ph.t -= dt;
        if (ph.t <= 0) this.carryHome(person, ph.goods);
      }
    }
    this.settleOwed();
    return this.orders.splice(0);
  }

  /**
   * Each person's last leg since the orders went out is what the agents will follow: one sent on the leg it's already at
   * the end of is there (the agents tell an arrival once — their latch holds while it follows the same field), so it's
   * told now; one sent on another isn't there any more.
   */
  private settleOwed(): void {
    for (let round = 0; ; round++) {
      const owed: Person[] = [];
      for (const person of this.people.values()) {
        const go = person.sent;
        if (go === undefined) continue;
        person.sent = undefined;
        if (go === null) continue;
        if (person.there?.leg === go) owed.push(person);
        else person.there = null;
      }
      if (!owed.length) return;
      if (round > 8) throw new Error('town life: a person sent where it already is, over and over');
      for (const person of owed) this.arrived(person, person.there!.leg, person.there!.at);
    }
  }

  private order(o: Order): void {
    this.orders.push(o);
  }

  private set(person: Person, phase: Phase, go: Leg | null): void {
    person.phase = phase;
    person.sent = go;
    this.order({ unit: person.unit, go });
  }

  /** the leg a worker's job takes it to */
  private legOf(person: Person): Leg {
    const s = this.slot(person.unit);
    return s?.kind === 'farm' ? 'farm' : s?.kind === 'quarry' ? 'quarry' : 'fell';
  }

  private slot(unit: number): JobSlot | null {
    const key = this.board.jobOf(unit);
    return key ? (this.work.slots().find((s) => s.key === key) ?? null) : null;
  }

  private day(): number {
    return Math.floor(this.t / this.work.daySec);
  }

  private dayFrac(): number {
    return (this.t / this.work.daySec) % 1;
  }

  /** a person starting over: home to rest at the day's end, a meal at midday, else its job's first leg, or home */
  private start(person: Person): void {
    // (a load in hand goes back where it came from: the job changed under it)
    const ph = person.phase;
    if (ph.p === 'toSite' || ph.p === 'working') this.work.giveBack(ph.block, ph.load);
    if (ph.p === 'carry') this.work.deliver(ph.goods, null);
    if (this.dayFrac() >= REST_FROM) return this.set(person, { p: 'rest' }, 'home');
    if (this.dayFrac() >= EAT_FROM && person.ate !== this.day()) return this.set(person, { p: 'toEat' }, 'stores');
    const s = this.slot(person.unit);
    if (!s) return this.set(person, { p: 'home' }, 'home');
    if (s.kind === 'build') return this.set(person, { p: 'toStores' }, 'stores');
    this.toWork(person);
  }

  private toWork(person: Person): void {
    const s = this.slot(person.unit);
    if (!s || s.structure === null) return this.start(person);
    this.set(person, { p: 'toWork' }, this.legOf(person));
  }

  private carryHome(person: Person, goods: Goods): void {
    this.order({ unit: person.unit, carry: lookOf(goods) });
    this.set(person, { p: 'carry', goods }, 'stores');
  }

  private arrived(person: Person, leg: Leg, at: V2, again = false): void {
    const ph = person.phase;
    const unit = person.unit;
    if ((ph.p === 'toStores' || (again && ph.p === 'waitLoad')) && leg === 'stores') {
      const job = this.work.nextLoad();
      // (nothing to bring: it waits by the stores until they or the sites change)
      if (!job) {
        if (ph.p !== 'waitLoad') this.set(person, { p: 'waitLoad' }, null);
        return;
      }
      this.order({ unit, carry: job.load.good });
      return this.set(person, { p: 'toSite', block: job.block, load: job.load }, 'site');
    }
    if (ph.p === 'toSite' && leg === 'site') {
      const b = this.work.siteAt(at, ph.load, ph.block);
      if (!b) {
        this.work.giveBack(ph.block, ph.load);
        this.order({ unit, carry: null });
        return this.set(person, { p: 'toStores' }, 'stores');
      }
      return this.set(person, { p: 'working', block: b, load: ph.load, t: WORK_S }, null);
    }
    if (ph.p === 'toWork' || (again && ph.p === 'waitSpot')) {
      const s = this.slot(unit);
      if (!s || s.structure === null) return this.start(person);
      const spot = this.work.workSpot(s.kind, s.structure, at);
      if (!spot) {
        if (ph.p !== 'waitSpot') this.set(person, { p: 'waitSpot', at }, null);
        return;
      }
      if (s.kind === 'farm') {
        const r = this.work.reap(s.structure, spot);
        return this.set(person, { p: 'gather', goods: r.goods, t: r.seconds }, null);
      }
      if (s.kind === 'quarry') {
        this.order({ unit, dig: spot });
        return this.set(person, { p: 'digging' }, null);
      }
      this.order({ unit, fell: spot });
      return this.set(person, { p: 'felling' }, null);
    }
    if (ph.p === 'carry' && leg === 'stores') {
      this.work.deliver(ph.goods, this.slot(unit)?.structure ?? null);
      this.order({ unit, carry: null });
      // (on with the tick: after the board's turn, as what the board says then)
      person.phase = { p: 'idle' };
      return;
    }
    if (ph.p === 'home' && leg === 'home') return this.set(person, { p: 'home' }, null);
    if (ph.p === 'rest' && leg === 'home') return this.set(person, { p: 'rest' }, null);
    if (ph.p === 'toEat' && leg === 'stores') return this.set(person, { p: 'eating', t: EAT_S }, null);
  }
}
