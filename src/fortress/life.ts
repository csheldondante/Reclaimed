// The fortress's people (fortress slice 1; milestone 2 "workers build the plan", milestone 3 "the economy feeds the
// building"). Adapted from settle/life.ts's phase machine and its IO (take, fell, the trees in reach): every person is a
// unit; a pure JobBoard (economy.ts) gives each one a job from the jobs open (a built block of a farm, quarry or lumber
// camp gives its type's jobs; the builders' while there's something to build), in priority order (defs.ts JOB_ORDER):
//  - builders walk to the warehouse, take a load out of the stores (what the next block still lacks), carry it to that
//    block and work it in; a block stands when its cost is in (Town.add). Blocks go up in BuildCrew's order;
//  - miners walk to the quarry's built cells and dig: the ground itself is taken (terrain take, a real pit that deepens,
//    down to ECON.pitMax under the ground it had); after a load's work they carry stone, a share of it ore, to the
//    warehouse;
//  - woodcutters walk to a tree in their lumber camp's reach (it grows with the camp's size), fell it (the plants'
//    fell: the tree goes) and carry its logs to the warehouse;
//  - grain grows on the farms' built cells (their type's rate); farmers reap it and carry it to the warehouse;
//  - people with no work go home and wait.
// Goods come in only that way: nothing by rates. A load that doesn't fit the stores' room isn't started (the bar says
// the stores are full). People eat grain (ECON.eat a day each). While there's a bed free and grain in the stores, a
// newcomer walks in from the edge of the box, along the roads where there are any. Erase gives back half a built
// block's cost, and all that was brought to a block not yet built (as far as the stores' room takes it).
//
// The walking is the agents' (units/agent-units.ts): each leg a shared field (life.ts's groups): the warehouse (F.pile),
// the blocks lacking stone (F.site) or wood (F.store), the quarry's cells (F.quarry), the trees in reach (F.fell), the
// farms (F.farm), the houses (F.home). Roads cost less to walk in every field (Agents.setRoads, FT-46).
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
import { DEFS, ECON } from './defs';
import { builtBlocks, eaten, fits, grown, JobBoard, jobSlots, mayArrive, putIn, quarryLoad, reachOf, refundOf, workSeconds, type JobKind, type JobSlot } from './economy';
import type { Erased, Fortress } from './fortress';
import { WAY_ROAD } from './ways';
import { BuildBook, type Load } from './work';

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
const TREES_S = 10;
/** the most grain a farm holds ripe: this many days of its growth */
const RIPE_DAYS = 3;

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
  /** trees within r of a point (window coordinates) */
  trees(at: V2, r: number): V2[];
  /** a tree felled: its logs (0: none there) */
  fell(at: V2): Promise<number>;
  /** ground dug out at a point (the world API's terrain take: quiet, sim/sleep.ts touch): how much came */
  dig(at: V2, amount: number): Promise<number>;
  /** the ground's top now at window world (x, y) */
  ground(x: number, y: number): number;
  /** the sim's speed: the units' steps come in wall time (0 while planning) */
  speed(): number;
}

type Phase = 'idle' | 'home' | 'wait' | 'toPile' | 'toSite' | 'working' | 'toWork' | 'gather' | 'lifting' | 'carry';
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
}

/** how deep a quarry's pit may go at d from its middle (see digAt) */
export function pitDepth(d: number): number {
  return Math.max(0, Math.min(ECON.pitMax, ECON.digR + 1.5 - d));
}

/** what a worker carries, drawn */
const LOOK: Partial<Record<Good, string>> = { stone: 'stone', ore: 'stone', log: 'log', grain: 'sand' };

export class FortressLife implements Routine {
  readonly ids: UnitId[] = [];
  readonly book: BuildBook;
  /** loads brought, blocks built, waits at the heap with nothing to take; (milestone 3) trips in, ground dug, trees felled, newcomers, refunds */
  readonly stats = { trips: 0, built: 0, starved: 0, hauled: 0, dug: 0, felled: 0, arrived: 0, refunds: 0 };
  readonly board = new JobBoard();
  /** (scripted checks) where the last trees were felled */
  readonly felledAt: V2[] = [];
  private seeded = '';
  private order: Block[] = [];
  private orderAt = -1;
  private t = 0;
  /** (FT-20) the heap's field read back: which sites a builder can walk to from the heap (and where a newcomer may start) */
  private reach: FieldReader;
  /** (round 128f) the columns the cut-off check last ran on (Fortress.columnsNow), and the cells it found cut off */
  private reachOn: unknown = null;
  private cutCells = new Set<number>();
  private slots: JobSlot[] = [];
  private jobsAt = -1e9;
  private treesAt = -1e9;
  private trees: V2[] = [];
  private arriveAt = 0;
  /** per structure: what its workers brought in, its ripe grain (farms) */
  private made = new Map<number, Goods>();
  private ripe = new Map<number, number>();
  /** per box point (rounded) the ground a miner first found there: the pit's depth is measured from it */
  private firstGround = new Map<string, number>();
  private onErased = (e: Erased) => this.refund(e);

  constructor(
    private io: FortressLifeIO,
    people: number,
  ) {
    const fort = io.fort;
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
    this.reach = A.reader(F.pile).start(500);
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
    return u.v.settlement === this.io.settlement && u.v.job.kind === 'work';
  }

  drop(u: UnitRec): void {
    // (its load is lost with it — the agents drop it on the ground where it fell — but no longer on its way)
    const w = u.work as Work | undefined;
    if (w?.load && w.block) this.book.giveBack(w.block, w.load, {});
    this.io.units.carry(u, null);
    u.work = undefined;
  }

  dispose(): void {
    this.reach.stop();
    const i = this.io.fort.onErased.indexOf(this.onErased);
    if (i >= 0) this.io.fort.onErased.splice(i, 1);
    for (const id of this.ids) this.io.units.remove(id);
    if (this.io.units.routine === this) this.io.units.routine = null;
    for (const f of [F.pile, F.site, F.store, F.quarry, F.fell, F.farm, F.home]) this.io.units.agents.seed(f, []);
    this.io.units.agents.keepInScope('fortress', []);
    this.io.units.agents.setRoads(new Float32Array(0));
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
  }

  /** each frame (sim time): the economy, the jobs, the newcomers, the fields seeded */
  update(dt: number): void {
    this.t += dt;
    const alive = this.people();
    if (alive.length !== this.ids.length) this.ids.splice(0, this.ids.length, ...alive);
    this.checkReach();
    // (round 128i, FT-58: the road shapes stamped on the GPU — again only when the lanes or the box's offset change)
    this.roads();
    if (dt > 0) this.economy(dt);
    if (this.t - this.jobsAt >= JOBS_S) {
      this.jobsAt = this.t;
      this.jobs();
      // (round 128f: the user, "agents seem to not be able to path through the city or farms to buildings at the
      // peripheral") every block still to build kept in the fields' scope: past the box round the units and the seeds
      // every field reads no way, so a block not yet among the sites read cut off, was never a site, never seeded, never
      // in the scope — cut off for good
      this.io.units.agents.keepInScope('fortress', this.todo().flatMap((b) => this.standsFor(b)));
    }
    if (this.t - this.treesAt >= TREES_S) {
      this.treesAt = this.t;
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
    if (this.t >= this.arriveAt && mayArrive(this.ids.length, f.beds(), this.io.stores().grain ?? 0)) {
      const at = this.entry();
      if (at) {
        this.spawn(at, 0);
        this.stats.arrived++;
      }
      this.arriveAt = this.t + ECON.arriveSec;
    }
  }

  /** the JobBoard's turn: people to the jobs open */
  private jobs(): void {
    const f = this.io.fort;
    const building = f.mode === 'build' && this.sites().length > 0;
    this.slots = jobSlots(f.plan, (c, l) => f.town.has(c, l), building);
    const changed = this.board.assign(this.ids, this.slots);
    for (const id of changed) {
      const u = this.io.units.recs.get(id);
      const w = u?.work as Work | undefined;
      if (!w) continue;
      w.job = this.board.jobOf(id);
      // (one carrying finishes the trip first: the next job after it)
      if (!['toSite', 'working', 'lifting', 'carry'].includes(w.phase)) Object.assign(w, { phase: 'idle', t: 0.2 });
    }
  }

  private slot(key: string | null): JobSlot | null {
    return key === null ? null : (this.slots.find((s) => s.key === key) ?? null);
  }

  /** the trees in the lumber camps' reach, nearest each camp first */
  private lookForTrees(): void {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'lumber') continue;
      const n = builtBlocks(f.plan, s, (c, l) => f.town.has(c, l));
      if (!n) continue;
      const cs = [...s.cells.keys()].map((c) => f.centre(c));
      const mid: V2 = [cs.reduce((a, p) => a + p[0], 0) / cs.length, cs.reduce((a, p) => a + p[1], 0) / cs.length];
      const near = this.io.trees(mid, reachOf(n)).sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]));
      out.push(...near.slice(0, 12));
    }
    this.trees = out;
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
   * Where a newcomer starts: in from the edge of the box, as far out as the heap's field reaches (ground a walker can
   * cross to the stores), along the road that reaches farthest out if there are roads, else the first way in.
   */
  private entry(): V2 | null {
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
    for (const a of angles)
      for (let r = half; r >= 16; r -= 4) {
        const x = h[0] + Math.cos(a) * r;
        const y = h[1] + Math.sin(a) * r;
        if (f.cellAt(x, y) < 0) continue;
        const q = this.reach.sample(x, y);
        if (q && Number.isFinite(q.dist)) return [x, y];
      }
    return null;
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
   * sent with a load it can't bring) and the bar says so (Fortress.cutOff). (Round 128f: by the CPU check on the
   * agents' rules — fortress/reach.ts, Fortress.reachMap — not by the heap's GPU field read back: that field fills out
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

  /** (round 128f) each time the columns are read again: the blocks still to build the stores don't reach */
  private checkReach(): void {
    const f = this.io.fort;
    const cols = f.columnsNow();
    if (!cols || cols === this.reachOn) return;
    this.reachOn = cols;
    const m = f.reachMap();
    if (!m) return;
    this.cutCells = new Set(f.todoCells().filter((c) => !f.reachedIn(m, c)));
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

  private homes(): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'house') continue;
      const d = f.doorOf(s.id);
      if (d) out.push(d);
    }
    return [...out, ...this.io.homes()].slice(0, 4);
  }

  private reseed(): void {
    const h = this.heap();
    const stone = this.sitesFor('stone').flatMap((b) => this.standsFor(b));
    const wood = this.sitesFor('log').flatMap((b) => this.standsFor(b));
    const quarry = this.cellsOf('quarry').slice(0, SEEDS);
    const farm = this.cellsOf('farm').slice(0, SEEDS);
    const fell = this.trees.slice(0, SEEDS);
    const homes = this.homes();
    const r = (v: V2[]) => v.map((p) => p.map(Math.round));
    const key = JSON.stringify([h.map(Math.round), r(stone), r(wood), r(quarry), r(farm), r(fell), r(homes)]);
    if (key === this.seeded) return;
    this.seeded = key;
    const A = this.io.units.agents;
    const seed = (f: number, v: V2[]) => A.seed(f, v.map(([x, y]) => ({ x, y })));
    seed(F.pile, [h]);
    seed(F.site, stone.slice(0, 8));
    seed(F.store, wood.slice(0, 8));
    seed(F.quarry, quarry);
    seed(F.farm, farm);
    seed(F.fell, fell);
    seed(F.home, homes);
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
    const dt = dtWall * this.io.speed();
    const w = (u.work ??= { phase: 'idle', t: 1, job: null } satisfies Work) as Work;
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
    const slot = this.slot(w.job);
    switch (w.phase) {
      case 'idle': {
        stand();
        w.t -= dt;
        if (w.t > 0) break;
        if (!slot) w.phase = 'home';
        else if (slot.kind === 'build') w.phase = this.io.fort.mode === 'build' && this.sites().length ? 'toPile' : 'home';
        else {
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
        const spots = kind === 'quarry' ? this.cellsOf('quarry') : kind === 'farm' ? this.cellsOf('farm') : this.trees;
        if (!spots.length) return void Object.assign(w, { phase: 'wait', t: 3 });
        go(kind === 'quarry' ? R.toQuarry : kind === 'farm' ? R.toFarm : R.toFell);
        const spot = spots.find(([x, y]) => Math.hypot(x - at[0], y - at[1]) < AT_SPOT);
        if (!spot) break;
        w.where = spot;
        w.phase = 'gather';
        w.t = kind === 'farm' ? ECON.reapSec : workSeconds(DEFS[kind]);
        w.dig = ECON.digSec * Math.random();
        break;
      }
      case 'gather': {
        U.regroup(u, R.working);
        u.v.state = 'swing';
        w.t -= dt;
        const kind = slot?.kind;
        if (kind === 'quarry' && (w.dig = (w.dig ?? 0) - dt) <= 0) {
          w.dig = ECON.digSec;
          this.digAt(w.where ?? at);
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

  /**
   * A miner's dig: the ground about the spot taken (a real pit). The pit is a bowl its miners can walk out of: at d from
   * its middle it goes no deeper than pitDepth(d) under the ground it had (a metre down a metre in: the agents' step),
   * and never past ECON.pitMax.
   */
  private digAt(spot: V2): void {
    const f = this.io.fort;
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * ECON.digR;
      const x = spot[0] + Math.cos(a) * rr;
      const y = spot[1] + Math.sin(a) * rr;
      // (from the ground as the miners first found it — the same reading as now, so a pit is measured against itself)
      if (f.cellAt(x, y) < 0) continue;
      const [bx, by] = f.toBox(x, y);
      const k = `${Math.round(bx)},${Math.round(by)}`;
      const now = this.io.ground(x, y);
      const first = this.firstGround.get(k) ?? now;
      this.firstGround.set(k, first);
      if (now <= first - pitDepth(rr)) continue;
      void this.io.dig([x, y], ECON.dig).then((n) => {
        if (n > 0) this.stats.dug += n;
      });
      return;
    }
  }

  private carry(u: UnitRec, w: Work, goods: Goods): void {
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
