// The fortress's builders (fortress slice 1, milestone 2: "workers build the plan"). Adapted from settle/life.ts's
// phase machine: a builder walks to the warehouse heap, takes a load out of the stores (wood or stone: what the next
// block still lacks), carries it to that block and works it in; when a block's whole cost is in it stands (Town.add:
// drawn whole, no longer see-through). Blocks go up in BuildCrew's order (agents/buildcrew.ts buildOrder: lowest
// first, then nearest the heap). The walking is the agents' (units/agent-units.ts): the heap and the sites are two
// shared fields — the heap (F.pile), and the blocks that still lack stone (F.site) or wood (F.store: a field a good, so
// a builder carrying stone isn't led to the nearest block that only wants wood and stuck there) — the legs life.ts's
// groups (R.toPile, R.toSite, R.toStore, R.working).
//
// It runs the pinned settlement's units in place of a SettlementLife (Settlements.pin(id, true)): the two share those
// fields and groups (FORTRESS_SLICE1 correction 1), so they never run together.
import type { Good, Goods } from '../api/contracts/fortress';
import type { FactionId } from '../api/contracts/world';
import type { UnitId, V2 } from '../api/contracts/units';
import { buildOrder } from '../agents/buildcrew';
import type { FieldReader } from '../agents/fieldreader';
import type { Block } from '../build/town';
import { R } from '../settle/life';
import { F, G, type AgentUnits, type Routine, type UnitRec } from '../units/agent-units';
import { DEFS } from './defs';
import type { Fortress } from './fortress';
import { BuildBook, type Load } from './work';

/** goods a builder carries a trip */
export const LOAD = 3;
/** seconds working a load in */
const WORK_S = 1.5;
/** how near the heap counts as there (world units) */
const THERE = 2.4;
/** how near a block's middle a builder works it in (it stands outside the cell: a cell is ~5 across) */
const REACH = 5;
/** blocks seeded as sites at once (the builders' field leads to the nearest) */
const SITES = 6;
/**
 * (round 128d, FT-20) sim seconds a block's stands stay out of the heap's field before it counts as unreachable (the
 * field fills outward from the heap a few sweeps a tick: a far site is out of it for a moment at first)
 */
const CUT_OFF_S = 8;

export interface FortressLifeIO {
  units: AgentUnits;
  fort: Fortress;
  /** the settlement whose people they are */
  settlement: string;
  faction: FactionId | null;
  /** the warehouse heap, window coordinates now */
  heap(): V2;
  /** the stores now */
  stores(): Goods;
  /** goods taken out of the stores (negative: put back) */
  take(good: Good, amount: number): void;
}

type Phase = 'idle' | 'toPile' | 'toSite' | 'working';
interface Work {
  phase: Phase;
  t: number;
  job?: Block;
  load?: Load | null;
}

export class FortressLife implements Routine {
  readonly ids: UnitId[] = [];
  readonly book: BuildBook;
  /** loads brought, blocks built, waits at the heap with nothing to take */
  readonly stats = { trips: 0, built: 0, starved: 0 };
  private seeded = '';
  private order: Block[] = [];
  private orderAt = -1;
  private t = 0;
  /** (FT-20) the heap's field read back: which sites a builder can walk to from the heap */
  private reach: FieldReader;
  private reachAt = 0;
  /** per block (cell:level) still to build, the sim time it was first found out of the heap's field */
  private outSince = new Map<string, number>();

  constructor(
    private io: FortressLifeIO,
    builders: number,
  ) {
    const fort = io.fort;
    this.book = new BuildBook((b) => DEFS[fort.plan.typeAt(b.cell) ?? 'house'].cost);
    const { units } = io;
    units.routine = this;
    const A = units.agents;
    A.follow(R.toPile, F.pile);
    A.follow(R.toSite, F.site);
    A.follow(R.toStore, F.store);
    A.follow(R.working, -1);
    A.workPose(R.working, true);
    this.reach = A.reader(F.pile).start(500);
    const h = io.heap();
    for (let i = 0; i < builders; i++) {
      const at: V2 = [h[0] + Math.cos(i * 2.4) * 4, h[1] + Math.sin(i * 2.4) * 4];
      const id = units.spawn('villager', at, io.faction, { settlement: io.settlement, role: 'builder', health: 3, job: { kind: 'work', at, what: 'builder' } });
      this.ids.push(id);
      units.recs.get(id)!.work = { phase: 'idle', t: 0.5 + i * 0.4 } satisfies Work;
    }
  }

  takes(u: UnitRec): boolean {
    return u.v.settlement === this.io.settlement && u.v.job.kind === 'work';
  }

  drop(u: UnitRec): void {
    // (its load is lost with it — the agents drop it on the ground where it fell — but no longer on its way)
    const w = u.work as Work | undefined;
    if (w?.load && w.job) this.book.giveBack(w.job, w.load, {});
    this.io.units.carry(u, null);
    u.work = undefined;
  }

  dispose(): void {
    this.reach.stop();
    for (const id of this.ids) this.io.units.remove(id);
    if (this.io.units.routine === this) this.io.units.routine = null;
    for (const f of [F.pile, F.site, F.store]) this.io.units.agents.seed(f, []);
  }

  /** The blocks still to build, in order (buildOrder from the heap: lowest first, then nearest). */
  todo(): Block[] {
    if (this.orderAt !== this.t) {
      this.orderAt = this.t;
      const f = this.io.fort;
      const [hx, hy] = f.toBox(...this.io.heap());
      this.order = buildOrder(f.town, [hx, hy])
        .filter((d) => !d.down)
        .map((d) => d.block);
    }
    return this.order;
  }

  /** each frame (sim time): the fields seeded; (round 128e) what the builders are doing, for the bar */
  update(dt: number): void {
    this.t += dt;
    this.checkReach();
    this.reseed();
    const crew = { builders: 0, toStores: 0, carrying: 0, working: 0, waiting: 0 };
    for (const id of this.ids) {
      const u = this.io.units.recs.get(id);
      if (!u?.v.alive) continue;
      crew.builders++;
      const p = (u.work as Work | undefined)?.phase ?? 'idle';
      if (p === 'toPile') crew.toStores++;
      else if (p === 'toSite') crew.carrying++;
      else if (p === 'working') crew.working++;
      else crew.waiting++;
    }
    this.io.fort.crew = crew;
  }

  /**
   * (round 128e, FT-49) Where to look when the builders start: between the stores and the first block they'll build,
   * and how far apart those are (window world).
   */
  focus(): { at: V2; span: number } {
    const h = this.io.heap();
    const b = this.sites()[0] ?? this.todo()[0];
    if (!b) return { at: h, span: 0 };
    const [x, y] = this.io.fort.centre(b.cell);
    return { at: [(h[0] + x) / 2, (h[1] + y) / 2], span: Math.hypot(x - h[0], y - h[1]) };
  }

  /**
   * (round 128d, FT-20) The blocks no builder can walk to from the heap: none of its stands is in the heap's field (deep
   * water is no way to a walker — agents.wgsl DEEP — and a cliff too high none either) for CUT_OFF_S. They're left out
   * of the sites (a builder isn't sent with a load it can't bring) and the bar says so (Fortress.cutOff).
   */
  unreachable(): Block[] {
    return this.todo().filter((b) => this.isCutOff(b));
  }

  private isCutOff(b: Block): boolean {
    const since = this.outSince.get(`${b.cell}:${b.level}`);
    return since !== undefined && this.t - since >= CUT_OFF_S;
  }

  private checkReach(): void {
    if (!this.reach.readAt || this.reach.readAt === this.reachAt) return;
    this.reachAt = this.reach.readAt;
    const keep = new Map<string, number>();
    for (const b of this.todo()) {
      const k = `${b.cell}:${b.level}`;
      const ok = this.standsFor(b).some(([x, y]) => isFinite(this.reach.sample(x, y)?.dist ?? Infinity));
      if (!ok) keep.set(k, this.outSince.get(k) ?? this.t);
    }
    this.outSince = keep;
    const n = this.unreachable().length;
    if (n !== this.io.fort.cutOff) this.io.fort.setCutOff(n);
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

  private reseed(): void {
    const h = this.io.heap();
    const stone = this.sitesFor('stone').flatMap((b) => this.standsFor(b));
    const wood = this.sitesFor('log').flatMap((b) => this.standsFor(b));
    const r = (v: V2[]) => v.map((p) => p.map(Math.round));
    const key = JSON.stringify([h.map(Math.round), r(stone), r(wood)]);
    if (key === this.seeded) return;
    this.seeded = key;
    const A = this.io.units.agents;
    A.seed(F.pile, [{ x: h[0], y: h[1] }]);
    A.seed(F.site, stone.slice(0, 16).map(([x, y]) => ({ x, y })));
    A.seed(F.store, wood.slice(0, 16).map(([x, y]) => ({ x, y })));
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

  step(u: UnitRec, dt: number): void {
    const w = (u.work ??= { phase: 'idle', t: 1 } satisfies Work) as Work;
    const U = this.io.units;
    const f = this.io.fort;
    const at: V2 = [u.v.at[0], u.v.at[1]];
    const go = (g: number) => {
      U.regroup(u, g);
      u.v.state = 'walk';
    };
    switch (w.phase) {
      case 'idle':
        U.regroup(u, G.stand);
        u.v.state = 'idle';
        w.t -= dt;
        if (w.t <= 0 && f.mode === 'build' && this.sites().length) w.phase = 'toPile';
        break;
      case 'toPile': {
        go(R.toPile);
        const h = this.io.heap();
        if (Math.hypot(h[0] - at[0], h[1] - at[1]) > THERE) break;
        const j = this.nextJob();
        if (!j) {
          // (nothing to build, or nothing it lacks in the stores: wait by the heap)
          if (this.sites().length) this.stats.starved++;
          Object.assign(w, { phase: 'idle', t: 3 });
          break;
        }
        w.job = j.b;
        w.load = j.load;
        U.carry(u, j.load.good === 'log' ? 'log' : 'stone', Math.max(0.2, Math.min(0.6, j.load.amount / 6)));
        w.phase = 'toSite';
        break;
      }
      case 'toSite': {
        const job = w.job!;
        const good = w.load!.good;
        go(good === 'log' ? R.toStore : R.toSite);
        // (the good's field leads to the nearest site lacking it: work on whichever block it came to)
        let here: Block | null = null;
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
          w.job = here;
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
    }
  }

  /** a load worked into its block (the block stands when its cost is in), or given back */
  private unload(u: UnitRec, w: Work, work: boolean): void {
    const b = w.job!;
    const load = w.load!;
    this.io.units.carry(u, null);
    w.load = null;
    w.job = undefined;
    w.phase = 'toPile';
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
    }
  }
}
