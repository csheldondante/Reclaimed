// The settlements system (round 88; docs/SYSTEMS.md systems 3, 6 and 12): every atlas site a Settlement
// record (the contract the city game will edit), realised as land arrives and lived in near the player.
//  - Atlas scale: the records from the world wiki (ids, names, realms: records.ts); their stores go on by
//    their rates while nobody's there (advance).
//  - Arrival: when a region of a settlement's box is first made, the settlement is planned once (plan.ts, on
//    the raw ground of its box: deterministic, ~10 ms) and its columns are stamped into that region's land
//    (Atlas.stampHooks: atlas/stamps.ts) — buildings, walls, the plaza, fields, the camp — so the streamer freezes and thaws
//    them like any land, and every system (water, fire, collapse, agents' surfaces) sees real matter.
//  - Play: the settlement nearest the camera inside the window comes to life (life.ts) — its workers and
//    guards and its camp's raiders as units (units/agent-units.ts on the GPU agents) — and goes back to its
//    rates when it leaves.
// API (window.reclaimed.settlements): near(at, r), settlement(id), all(), live(), raid(id), units (Units),
// events built / died / raided. Positions in a record are world units (atlas x, y); `toWindow`/`toWorld` turn
// them into the window's (the units' and the world API's).
import type { Settlement } from '../api/contracts/settlement';
import type { Instance } from '../api/contracts/recipe';
import type { RegionId } from '../api/contracts/world';
import type { UnitView, UnitId, V2 } from '../api/contracts/units';
import { MemoryDiplomacy } from '../api/contracts/diplomacy-memory';
import type { Agreement } from '../api/contracts/diplomacy';
import type { FactStore } from '../api/contracts/facts';
import type { AtlasEvent } from '../api/contracts/world';
import type { Atlas } from '../atlas/atlas';
import type { StampOps } from '../atlas/stamps';
import { GPUGEN } from '../atlas/finish';
import { GrowthField } from './field';
import { ROW_H } from '../world/lattice';
import { atlasFacts } from '../gm/atlas-facts';
import { buildWiki, type WorldWiki } from '../gm/wiki';
import { recordsFrom, type SettlementSeed } from './records';
import { planSettlement, type Iv, type SettlementPlan } from './plan';
import { MAT } from '../world/materials';
import { SettlementLife, type LiveSite, type LiveSpot, type RaidOutcome } from './life';
import { BUILT_V, FIELD_CELL, levelsOfStructure, rasterColumns, type SiteSpec } from './plan';
import { derive } from '../api/contracts/compose';
import { catalogue } from './catalogue';
import type { AgentUnits } from '../units/agent-units';
import { timed } from '../gpu/cpustat';
import { waysNear } from '../atlas/ways';
import type { SurfaceStamp } from '../atlas/bake';
import { rasterPlan, stampMatch } from './raster';
import type { ExactPlanDone, ExactPlanJob, FarPlanDone, FarPlanInit, FarPlanJob } from './plan-worker';
import { Fleet, shipRoutes } from './ships';
import { assertEntered, keepReach, placeBuilding } from '../structures/place';
import { typeIndex } from '../build/plan';
import { TownSite, type SiteData } from '../build/site';

const T = 64;
/** a game day (s): the stores' rates are a day's */
export const DAY_S = 600;

export interface SettlementEvents {
  /** a settlement realised (its land came in the first time): buildings, ms */
  built: ((s: Settlement, info: { buildings: number; ms: number; house?: string }) => void)[];
  /** one of its people died (the unit, what killed it) */
  died: ((s: Settlement, u: UnitView, by: UnitId | string | null) => void)[];
  /** a raid on it ended */
  raided: ((s: Settlement, outcome: RaidOutcome, losses: Record<string, number>) => void)[];
}

/** what play gives the system: the window, the units, the trees */
export interface LiveIO {
  units: AgentUnits;
  /** the window's world origin (cells, rows) and size */
  origin(): [number, number];
  dims: { w: number; h: number };
  /** where the camera looks (window) */
  focus(): V2;
  trees(at: V2, r: number): V2[];
  /** fell the tree there: the logs it makes (0: none stood there) */
  fell(at: V2): Promise<number>;
  /** the ground, exactly (the world API's terrain.take / put) */
  take(at: V2, amount: number): Promise<{ material: string; amount: number }>;
  put(at: V2, material: string, amount: number): Promise<number>;
  /** bumped as the window moves */
  epoch(): number;
  /** the ground's heights are in at a window point */
  ready(at: V2): boolean;
  /** how many of its people may be out at once (the tier's budget) */
  budget: number;
}

/** (round 94) what the bake gives the far plans: the atlas's rough ground over a box (null: not ready yet), where the
 *  camera is (world units), the reach (world units) within which settlements are planned for it */
export interface FarIO {
  rough(x0: number, y0: number, w: number, h: number): Promise<{ ground: Float32Array; water: Float32Array; top: Uint8Array; veg: Float32Array } | null>;
  camera(): V2;
  radius: number;
}

export class Settlements {
  readonly wiki: WorldWiki;
  readonly seeds: SettlementSeed[];
  /** (round 119) a building's storeys changed in play (a site raised, finished): the view shows it */
  readonly onRaised: ((id: string, building: number) => void)[] = [];
  /** (round 119) a settlement's plan made: the view draws it */
  readonly onPlanned: ((id: string) => void)[] = [];
  private byId = new Map<string, SettlementSeed>();
  private recs = new Map<string, Settlement>();
  private plans = new Map<string, Promise<SettlementPlan>>();
  private done = new Map<string, SettlementPlan>();
  readonly things = new Map<string, Instance>();
  /** what units ask before they mine (rights); (merge124, LW-F10) over the world's fact layer once the system is wired to
   *  the world state (useWorld), so the run, the GM and the units read one diplomacy */
  diplomacy = new MemoryDiplomacy();
  /** the agreements this system makes (moved into the world's facts by useWorld) */
  private agreements: Agreement[] = [];
  /** the world state it realises, once wired (useWorld) */
  private world: { facts: FactStore; onEvent: ((e: AtlasEvent) => void)[] } | null = null;
  private listener: ((e: AtlasEvent) => void) | null = null;
  readonly events: SettlementEvents = { built: [], died: [], raided: [] };
  private cols: number;
  private rows: number;
  /** the ms the records took, and each plan's */
  stats = { recordsMs: 0, planned: 0, planMs: 0, stamped: 0, rawTiles: 0, rawMs: 0, workerPlans: 0, workerMs: 0, reviveMs: 0, fleetMs: 0, routes: 0 };
  /** (round 94) the far plans: how many, the ms (the rough ground's GPU and readback, wall; in the worker the ways, the
   *  plan, the raster), the worker's first message (ms on the main thread), and each exact plan's match with its far
   *  one (IoU of their tops' cover) */
  farStats = { planned: 0, roughMs: 0, waysMs: 0, planMs: 0, rasterMs: 0, initMs: 0, maxPlanMs: 0, match: [] as { id: string; iou: number }[] };
  /** (round 94) the stamps in reach, each time they change (the far land's bake lays them) */
  readonly onStamps: ((list: SurfaceStamp[]) => void)[] = [];
  private farIO: FarIO | null = null;
  private farWorker: Worker | null = null;
  private farBusy = 0;
  private farClock = 0;
  private farWait = new Map<string, (d: FarPlanDone | ExactPlanDone) => void>();
  /** the far plans' stamps, and the exact plans' (once their land has come in: these win) */
  private farStamps = new Map<string, SurfaceStamp>();
  private exactStamps = new Map<string, SurfaceStamp>();
  private lastStamps: SurfaceStamp[] = [];
  /** the live one */
  life: SettlementLife | null = null;
  private io: LiveIO | null = null;
  /** the units in play (the Units contract), once playing */
  get units(): AgentUnits | null {
    return this.io?.units ?? null;
  }
  private clock = 0;
  /** (round 120, runsit) settlements a run left ruined or abandoned: realised charred (setCondition) */
  private charred = new Set<string>();
  private lastAdvance = 0;
  private fleetOf: Fleet | null = null;

  /**
   * (round 120) The sailing ships: routes over the atlas's sea between the ports (ships.ts), charted the first time
   * they're asked for (stats.fleetMs). The GM reads where they are at a time: fleet.at(t, sea).
   */
  get fleet(): Fleet {
    if (this.fleetOf) return this.fleetOf;
    const t0 = performance.now();
    const ports = this.seeds.filter((s) => s.rec.purpose?.kind === 'port').map((s) => ({ id: s.rec.id, at: s.rec.at }));
    const a = this.atlas;
    const routes = shipRoutes(ports, { n: a.p.n, worldW: a.worldW, worldH: a.worldH, ground: a.hmac, sea: a.p.sea });
    this.fleetOf = new Fleet(routes, a.p.seed);
    this.stats.fleetMs = +(performance.now() - t0).toFixed(1);
    this.stats.routes = routes.length;
    return this.fleetOf;
  }

  constructor(private atlas: Atlas) {
    const t0 = performance.now();
    this.wiki = buildWiki(atlasFacts(atlas));
    this.seeds = recordsFrom(this.wiki, atlas.p.seed);
    for (const s of this.seeds) {
      this.byId.set(s.rec.id, s);
      this.recs.set(s.rec.id, s.rec);
    }
    this.cols = atlas.p.cols;
    this.rows = atlas.p.rows;
    // rights: a realm holds land and mineral rights over its settlements' regions; a deal or two with a
    // neighbour's (diplomacy.ts — what units ask before they mine)
    const own = new Map<string, Set<RegionId>>();
    for (const s of this.seeds) if (s.rec.faction) (own.get(s.rec.faction) ?? own.set(s.rec.faction, new Set()).get(s.rec.faction)!).add(s.rec.region);
    for (const [f, regions] of own) {
      const near = new Set<RegionId>(regions);
      for (const r of regions) for (const nb of this.wiki.regions[r]?.neighbours ?? []) if (this.wiki.regions[nb]?.land && (nb * 2654435761) % 5 < 2) near.add(nb);
      this.agreements.push({ id: `${f}:land`, kind: 'land-rights', parties: [{ faction: f }, { faction: f }], where: { regions: [...regions] }, covers: ['settle', 'farm', 'fell', 'build'], since: { run: 0 }, status: 'active', cause: { by: 'world' } });
      this.agreements.push({ id: `${f}:minerals`, kind: 'mineral-rights', parties: [{ faction: f }, { faction: f }], where: { regions: [...near] }, covers: ['stone', 'ore'], share: 1, since: { run: 0 }, status: 'active', cause: { by: 'world' } });
    }
    for (const a of this.agreements) this.diplomacy.agree(a);
    this.stats.recordsMs = +(performance.now() - t0).toFixed(1);
    // (round 102: what's built as stamps — atlas/stamps.ts — the GPU's path and the CPU's build the same from them)
    atlas.stampHooks.push((ops, x0, y0, w, h, spread, plan) => this.stampLand(ops, x0, y0, w, h, spread, plan));
  }

  // ---- the API ---------------------------------------------------------------------------------------

  settlement(id: string): Settlement | null {
    return this.recs.get(id) ?? null;
  }

  all(): Settlement[] {
    return [...this.recs.values()];
  }

  /** the settlements within `radius` (world units) of a world point, nearest first */
  near(at: V2, radius = 400): Settlement[] {
    return this.all()
      .map((s) => [this.dist(s.at, at), s] as const)
      .filter(([d]) => d <= radius)
      .sort((a, b) => a[0] - b[0])
      .map(([, s]) => s);
  }

  /** a settlement's plan, once its land has come in (its town's structures plan, columns, spots: the debug view's) */
  plan(id: string): SettlementPlan | null {
    return this.done.get(id) ?? null;
  }

  /**
   * (round 128g) Plan a settlement now (in the worker, spread over frames), before its land comes in: the view asks for
   * those about to come on screen, so a town is pieces before it's seen — never the far raster's roofs turning into
   * pieces in sight. A plan asked for already, or made, isn't asked again.
   */
  prepare(id: string): void {
    const s = this.byId.get(id);
    if (!s || this.plans.has(id)) return;
    void this.planOf(s, true).catch((e) => console.error(`settlements: ${id}'s plan ahead of the screen failed`, e));
  }

  /**
   * (round 128j, claims at load) The plans of the settlements meeting region (x0, y0, w, h) (world columns, rows), made:
   * the streamer waits for this before writing the region (Streamer.readyFor), so the town's claims are written with its
   * land. Null: none meets it. (Land made here waits for the plan already — its stamps — but land thawed from the pool or
   * loaded from the store didn't.)
   */
  ready(x0: number, y0: number, w: number, h: number): Promise<unknown> | null {
    const ss = this.meeting(x0, y0, w, h);
    if (!ss.length) return null;
    return Promise.all(ss.map((s) => this.planOf(s, true)));
  }

  /** (round 119) the settlements planned so far: their seed (box, civ) and plan — what the view draws */
  plannedAll(): { seed: SettlementSeed; plan: SettlementPlan }[] {
    const out: { seed: SettlementSeed; plan: SettlementPlan }[] = [];
    for (const [id, plan] of this.done) out.push({ seed: this.byId.get(id)!, plan });
    return out;
  }

  /** (the level's ?city=) plan this settlement's town with another tile system or style; before its land comes in */
  override(id: string, spec: Partial<import('../api/contracts/structures').CitySpec>): void {
    const s = this.byId.get(id);
    if (!s) throw new Error(`settlements: no ${id} to override`);
    s.override = spec;
  }

  /** (fortress slice 1) the settlement the player holds as a fortress: live whenever it's in the window, not grown */
  private pinned: string | null = null;

  /**
   * (fortress slice 1) Hold a settlement as the player's fortress: it's the live one whenever its plan is in the
   * window (not the one nearest the view), and it doesn't grow houses of its own (the player builds).
   */
  pin(id: string, ownLife = false): Settlement {
    const s = this.byId.get(id);
    if (!s) throw new Error(`settlements.pin: no settlement ${id}`);
    this.pinned = id;
    this.pinnedOwnLife = ownLife;
    return s.rec;
  }

  /**
   * (round 128d) the pinned settlement's people are run by its holder (the fortress's FortressLife), not a
   * SettlementLife: the two use the same agents' fields and groups (FORTRESS_SLICE1 correction 1), so never both
   */
  private pinnedOwnLife = false;

  get pinnedId(): string | null {
    return this.pinned;
  }

  /** the live settlement, if any */
  live(): Settlement | null {
    return this.life?.rec ?? null;
  }

  /**
   * (round 120, runsit) A planned settlement's places in world units: its middle (the plaza), how far it's built, and
   * its buildings' doors (one a building) — what a run's finale needs (where the dead go, which houses they fire).
   * null: not planned yet (its land hasn't come in).
   */
  places(id: string): { centre: V2; radius: number; doors: { at: V2; ref: string }[] } | null {
    const p = this.done.get(id);
    const s = this.byId.get(id);
    if (!p || !s) return null;
    const ox = s.box.x0;
    const oy = s.box.y0 * ROW_H;
    const seen = new Set<string>();
    const doors: { at: V2; ref: string }[] = [];
    for (const sp of p.spots) {
      if (!sp.ref || seen.has(sp.ref) || !['home', 'store', 'post', 'make'].includes(sp.kind)) continue;
      seen.add(sp.ref);
      doors.push({ at: [sp.at[0] + ox, sp.at[1] + oy], ref: sp.ref });
    }
    return { centre: [p.centre[0] + ox, p.centre[1] + oy], radius: s.rec.radius, doors };
  }

  /**
   * (round 120, runsit) What a run left of a settlement (the world state's word for it, settlement.ts condition). A
   * ruined or abandoned one is charred from now on: its land, made again, has its buildings burned down to stumps and
   * ash (stamp), and no one lives in it. Why here: the settlements system owns how a settlement becomes land; the run
   * only says what happened to it. The user (round 120): "Let it burn down if the player fails".
   */
  setCondition(id: string, c: Settlement['condition']): void {
    const s = this.byId.get(id);
    if (!s) throw new Error(`settlements: no settlement ${id}`);
    s.rec.condition = c;
    const gone = c === 'ruined' || c === 'abandoned';
    if (gone === this.charred.has(id)) return;
    if (gone) {
      this.charred.add(id);
      for (const p of s.rec.people) if (!p.hostile) p.count = 0;
    } else this.charred.delete(id);
    for (const f of this.atlas.stampsChanged) f(s.box.x0, s.box.y0, s.box.w, s.box.h);
  }

  /**
   * (merge124) Wired to a world state (the run's, the level's): its diplomacy is the world's (LW-F10: the rights this
   * system grants live in the world's fact layer, beside every other agreement), and what the world's events do to a
   * settlement is realised here, where the player looks — the condition, the holder, the people, a structure placed,
   * the stores. The world state stays the one owner of those facts; this is how its settlements become land.
   */
  useWorld(w: { facts: FactStore; onEvent: ((e: AtlasEvent) => void)[] }): void {
    if (this.world === w) return;
    if (this.world && this.listener) this.world.onEvent.splice(this.world.onEvent.indexOf(this.listener), 1);
    this.world = w;
    this.diplomacy = new MemoryDiplomacy(w.facts);
    for (const a of this.agreements) this.diplomacy.agree(a);
    this.listener = (e) => this.realise(e);
    w.onEvent.push(this.listener);
  }

  /** an event of the world realised in its settlement (the settlement events; the rest aren't this system's) */
  realise(e: AtlasEvent): void {
    const d = e.detail ?? {};
    const seed = (key: string) => {
      const s = this.byId.get(String(d[key]));
      if (!s) throw new Error(`settlements: ${e.kind} ${e.id} names no settlement of the atlas (${String(d[key])})`);
      return s;
    };
    if (e.kind === 'settlement-condition') this.setCondition(seed('settlement').rec.id, d.condition as Settlement['condition']);
    else if (e.kind === 'settlement-owner') seed('settlement').rec.faction = (d.faction as string | null) ?? null;
    else if (e.kind === 'settlement-stores') {
      const s = seed('settlement').rec;
      const st = (s.stores[String(d.good)] ??= { stock: 0, rate: 0 });
      st.stock = Math.max(0, st.stock + e.magnitude);
      if (typeof d.rate === 'number') st.rate += d.rate;
    } else if (e.kind === 'migrate') {
      // (its people leave as a share of each role and arrive as refugees: the live town spawns who's left. A town not
      // planned yet has no people here — its plan says who lives there — so the move waits for its plan)
      const from = seed('from');
      const to = seed('to');
      const share = Math.max(0, Math.min(1, e.magnitude));
      if (this.done.has(from.rec.id)) this.moveOut(from.rec, to.rec.id, share);
      else (this.leaving.get(from.rec.id) ?? this.leaving.set(from.rec.id, []).get(from.rec.id)!).push({ to: to.rec.id, share });
    } else if (e.kind === 'settlement-building') {
      // (placed directly — no builders: the town's plan is made again with it, its land when the player next looks)
      const s = seed('settlement');
      const id = String(d.building);
      if ((s.placed ??= []).some((p) => p.id === id)) return;
      s.placed.push({ id, name: String(d.name ?? id), use: Array.isArray(d.use) ? (d.use as string[]) : [] });
      // (a town standing in the window isn't planned again under the player's feet — its old walls would come down as
      // rubble: it waits until the window has left it, then its land is made again with the structure)
      if (this.inWindow(s)) this.replan.add(s.rec.id);
      else this.planAgain(s);
    }
  }

  /** (merge124) people the world moved: shares waiting for a town's plan (who lives there), and the refugees each town
   *  took in (kept over its plan: a plan sets its people from its size and purpose) */
  private leaving = new Map<string, { to: string; share: number }[]>();
  private refugees = new Map<string, number>();

  private moveOut(from: Settlement, to: string, share: number): void {
    let moved = 0;
    for (const p of from.people) {
      if (p.hostile) continue;
      const n = Math.round(p.count * share);
      p.count -= n;
      moved += n;
    }
    from.people = from.people.filter((p) => p.count > 0);
    if (!moved) return;
    this.refugees.set(to, (this.refugees.get(to) ?? 0) + moved);
    const t = this.recs.get(to);
    if (t && this.done.has(to)) this.takeIn(t, moved);
  }

  private takeIn(rec: Settlement, n: number): void {
    const r = rec.people.find((p) => p.role === 'refugee');
    if (r) r.count += n;
    else rec.people.push({ role: 'refugee', count: n });
  }

  /** (merge124) settlements to plan again once the window has left them (a structure placed while they stood in it) */
  private replan = new Set<string>();

  private planAgain(s: SettlementSeed): void {
    this.plans.delete(s.rec.id);
    this.done.delete(s.rec.id);
    this.exactStamps.delete(s.rec.id);
    for (const f of this.atlas.stampsChanged) f(s.box.x0, s.box.y0, s.box.w, s.box.h);
  }

  /** whether a settlement's box meets the window (the live land) */
  private inWindow(s: SettlementSeed): boolean {
    if (!this.io) return false;
    const [ox, oy] = this.io.origin();
    const { w, h } = this.io.dims;
    const b = s.box;
    const meets = (a0: number, an: number, b0: number, bn: number, n: number) => this.mod(b0 - a0, n) < an || this.mod(a0 - b0, n) < bn;
    return meets(ox, w, b.x0, b.w, this.cols) && meets(oy, h, b.y0, b.h, this.rows);
  }

  /** send the live settlement's camp on it (false: no camp, or a raid's on) */
  raid(id?: string): boolean {
    if (!this.life || (id && this.life.rec.id !== id)) return false;
    return this.life.startRaid();
  }

  /** (onetown) a planned settlement's town: its one plan, what stands, its grid (the fortress edits the pinned one's) */
  siteOf(id: string): TownSite {
    const p = this.done.get(id);
    if (!p) throw new Error(`settlements: ${id} isn't planned (no town to edit)`);
    return p.site;
  }

  /** world (atlas units) → window, and back */
  toWindow(at: V2): V2 {
    if (!this.io) throw new Error('settlements: not in play');
    const [ox, oy] = this.io.origin();
    const W = this.cols;
    const H = this.rows * ROW_H;
    const wrap = (d: number, n: number) => d - Math.round(d / n) * n;
    return [wrap(at[0] - ox, W), wrap(at[1] - oy * ROW_H, H)];
  }

  toWorld(at: V2): V2 {
    if (!this.io) throw new Error('settlements: not in play');
    const [ox, oy] = this.io.origin();
    return [at[0] + ox, at[1] + oy * ROW_H];
  }

  // ---- arrival ---------------------------------------------------------------------------------------

  private dist(a: V2, b: V2): number {
    const W = this.cols;
    const H = this.rows * ROW_H;
    const dx = Math.abs(a[0] - b[0]) % W;
    const dy = Math.abs(a[1] - b[1]) % H;
    return Math.hypot(Math.min(dx, W - dx), Math.min(dy, H - dy));
  }

  private mod(v: number, n: number): number {
    return ((v % n) + n) % n;
  }

  /** the settlements whose box meets a region's */
  private meeting(x0: number, y0: number, w: number, h: number): SettlementSeed[] {
    const out: SettlementSeed[] = [];
    for (const s of this.seeds) {
      const b = s.box;
      const dx = this.mod(x0 - b.x0, this.cols);
      const dy = this.mod(y0 - b.y0, this.rows);
      const meetX = dx < b.w || this.mod(b.x0 - x0, this.cols) < w;
      const meetY = dy < b.h || this.mod(b.y0 - y0, this.rows) < h;
      if (meetX && meetY) out.push(s);
    }
    return out;
  }

  /** (round 108, TC8: `plan` false — a render-only tile's land — only the plans already made: none started here) */
  private async stampLand(ops: StampOps, x0: number, y0: number, w: number, h: number, spread: boolean, plan = true): Promise<void> {
    for (const s of this.meeting(x0, y0, w, h)) {
      const p = plan ? await this.planOf(s, spread) : this.done.get(s.rec.id);
      if (!p) continue;
      timed('stamp', () => this.stamp(p, s, ops, x0, y0, w, h));
    }
  }

  private planOf(s: SettlementSeed, spread: boolean): Promise<SettlementPlan> {
    let p = this.plans.get(s.rec.id);
    if (!p) {
      p = this.makePlan(s, spread);
      this.plans.set(s.rec.id, p);
    }
    return p;
  }

  private async makePlan(s: SettlementSeed, spread: boolean): Promise<SettlementPlan> {
    if (GPUGEN) return this.workerPlan(s, spread);
    const { box } = s;
    const N = box.w * box.h;
    const ground = new Float32Array(N);
    const water = new Float32Array(N);
    const top = new Uint8Array(N);
    const veg = new Float32Array(N);
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < box.h; ty += T) for (let tx = 0; tx < box.w; tx += T) tiles.push([tx, ty]);
    const lands = await Promise.all(tiles.map(([tx, ty]) => this.atlas.regionLand(box.x0 + tx, box.y0 + ty, T, T, Infinity, spread, true)));
    this.stats.rawTiles += tiles.length;
    tiles.forEach(([tx, ty], k) => {
      const l = lands[k];
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const i = y * T + x;
          const j = (ty + y) * box.w + tx + x;
          const col = l.cols[i];
          ground[j] = col.length ? col[col.length - 1].z1 : 0;
          water[j] = l.water[i];
          veg[j] = l.vegetation[i];
          top[j] = col.length ? col[col.length - 1].mat : 0;
        }
    });
    const plan = timed('plan', () => planSettlement({ ...s, ground, water, top, veg, sea: this.atlas.p.sea, regionAt: (x, y) => this.regionAt(x + s.box.x0, y + s.box.y0 * ROW_H) }));
    // (round 94: its tops for the land past the window — the far plan's stamp gives way to it; how alike they are)
    const st = timed('plan', () => rasterPlan(s.rec.id, rasterColumns(plan, s.civ.look.roof, s.civ.look.foundation), box, ground, top));
    return this.planned(s, plan, st);
  }

  /**
   * (round 102) A settlement's plan made off the main thread (the user: plans "never on the main thread"): its box's
   * raw ground made on the GPU (Atlas.rawGround: the same ground regionLand's raw land has, 16 bytes a column back),
   * planned and rastered in the plan worker (plan-worker.ts), the plan sent back whole and made live here again.
   */
  private async workerPlan(s: SettlementSeed, spread: boolean): Promise<SettlementPlan> {
    const { box } = s;
    const t0 = performance.now();
    const g = await this.atlas.rawGround(box.x0, box.y0, box.w, box.h, spread);
    this.stats.rawTiles += (box.w / T) * (box.h / T);
    this.stats.rawMs += performance.now() - t0;
    const job: ExactPlanJob = { exact: true, id: s.rec.id, seed: s, ...g, sea: this.atlas.p.sea };
    const done = await new Promise<ExactPlanDone>((res) => {
      this.farWait.set(`exact:${s.rec.id}`, res as (d: FarPlanDone | ExactPlanDone) => void);
      this.worker().postMessage(job, [g.ground.buffer, g.water.buffer, g.top.buffer, g.veg.buffer]);
    });
    if (done.error) throw new Error(`settlements: ${s.rec.id}'s plan failed in the worker: ${done.error}`);
    const t1 = performance.now();
    const plan = done.plan;
    // (made live again: its classes' methods, its record the settlement's own; onetown: its town from the site's data)
    Object.setPrototypeOf(plan.field, GrowthField.prototype);
    plan.site = TownSite.fromData(plan.site as unknown as SiteData);
    timed('plan.revive', () => {
      Object.assign(s.rec, plan.rec);
      plan.rec = s.rec;
    });
    this.stats.workerPlans++;
    this.stats.workerMs += done.ms[0] + done.ms[1];
    this.stats.reviveMs += performance.now() - t1;
    return this.planned(s, plan, done.stamp);
  }

  /** a plan made (here or in the worker): its stamp for the far land, its things, its camp, the event */
  private planned(s: SettlementSeed, plan: SettlementPlan, st: SurfaceStamp): SettlementPlan {
    this.exactStamps.set(s.rec.id, st);
    const far = this.farStamps.get(s.rec.id);
    if (far) {
      const iou = +stampMatch(far, st).toFixed(3);
      this.farStats.match.push({ id: s.rec.id, iou });
      console.log(`[farbake] ${s.rec.id} (${s.rec.size}) exact plan vs far plan: IoU ${iou}`);
    }
    for (const [k, t] of plan.things) this.things.set(k, t);
    if (plan.camp) this.recs.set(plan.camp.id, plan.camp);
    this.done.set(s.rec.id, plan);
    // (merge124: the world's moves of people — who left before the plan said who lived here, who came in)
    const took = this.refugees.get(s.rec.id);
    if (took) this.takeIn(s.rec, took);
    for (const m of this.leaving.get(s.rec.id) ?? []) this.moveOut(s.rec, m.to, m.share);
    this.leaving.delete(s.rec.id);
    this.stats.planned++;
    this.stats.planMs += plan.ms;
    for (const f of this.events.built) f(s.rec, { buildings: s.rec.buildings.length, ms: plan.ms });
    for (const f of this.onPlanned) f(s.rec.id);
    // (round 108, TC8: land made over its box before without it — a render-only tile's — is made again)
    for (const f of this.atlas.stampsChanged) f(s.box.x0, s.box.y0, s.box.w, s.box.h);
    return plan;
  }

  /** (round 120, runsit) a column of a burned settlement: what stood is down to its first cell or two, wood and render ash */
  private charColumn(lo: number, ivs: Iv[], k: number): Iv[] {
    const h = (((k * 2654435761) >>> 0) % 1000) / 1000;
    // (walls down to stumps of 1-3.5 cells, the rest of them rubble and ash: a town seen burned, not erased)
    const top = lo + 1 + h * 2.5;
    const out: Iv[] = [];
    for (const v of ivs) {
      if (v.z0 >= top) continue;
      const burnt = v.mat === MAT.Wood || v.mat === MAT.Canvas || v.mat === MAT.Log || v.mat === MAT.Plaster || v.mat === MAT.Tile;
      out.push({ z0: v.z0, z1: Math.min(v.z1, top), mat: burnt ? (h < 0.5 ? MAT.Ash : MAT.Rubble) : v.mat });
    }
    return out;
  }

  /** the plan's columns that fall in this region, as stamps (world z: atlas/stamps.ts PLAN) */
  private stamp(p: SettlementPlan, s: SettlementSeed, ops: StampOps, x0: number, y0: number, w: number, h: number): void {
    const b = s.box;
    const charred = this.charred.has(s.rec.id);
    for (let y = 0; y < h; y++) {
      const ly = this.mod(y0 + y - b.y0, this.rows);
      if (ly >= b.h) continue;
      for (let x = 0; x < w; x++) {
        const lx = this.mod(x0 + x - b.x0, this.cols);
        if (lx >= b.w) continue;
        const cp = p.columns.get(ly * b.w + lx);
        if (!cp) continue;
        // (what stands above the ground there goes; the plan's goes on it — a well's shaft, a quarry's benches: the
        // ground let down; an adit: a gap through it, rock over it)
        ops.plan(y * w + x, cp.lo, charred ? this.charColumn(cp.lo, cp.ivs, ly * b.w + lx) : cp.ivs, cp.bare, cp.cut ?? 0, cp.hole);
        this.stats.stamped++;
      }
    }
  }

  // ---- play ------------------------------------------------------------------------------------------

  /** start living: the level hands over the window and the units */
  play(io: LiveIO): void {
    this.io = io;
    io.units.died.push((u, by) => {
      const s = u.settlement ? this.recs.get(u.settlement) : undefined;
      if (!s) return;
      const p = s.people.find((x) => x.role === u.role);
      if (p && p.count > 0) p.count--;
      for (const f of this.events.died) f(s, u, by);
    });
  }

  /**
   * (round 128d, fortress) A planned settlement's spots in window coordinates now (its heaps, stores, homes); null: not
   * planned yet.
   */
  spotsOf(id: string): LiveSpot[] | null {
    const p = this.done.get(id);
    const s = this.seeds.find((x) => x.rec.id === id);
    return p && s ? this.liveSpots(p, s) : null;
  }

  /** the spots of a plan in window coordinates */
  private liveSpots(p: SettlementPlan, s: SettlementSeed): LiveSpot[] {
    const ox = s.box.x0;
    const oy = s.box.y0 * ROW_H;
    return p.spots.map((sp) => ({ ...sp, w: this.toWindow([sp.at[0] + ox, sp.at[1] + oy]) }));
  }

  /** its houses to build, in window coordinates (the specs themselves: progress is kept on them) */
  private liveSites(p: SettlementPlan, s: SettlementSeed): LiveSite[] {
    const ox = s.box.x0;
    const oy = s.box.y0 * ROW_H;
    const w = (q: V2): V2 => this.toWindow([q[0] + ox, q[1] + oy]);
    return p.sites.map((spec) => ({ spec, door: w(spec.door) }));
  }

  /** a site's levels up (life.ts): its structure's blocks under them built (the plan's Town), the view told */
  private raise(p: SettlementPlan, s: SettlementSeed, site: SiteSpec, storeys: number): void {
    const st = p.site.plan.structure(site.structure);
    if (!st) throw new Error(`settlements: ${s.rec.id}'s site ${site.id} has no structure ${site.structure}`);
    for (const c of st.cells.keys())
      for (const L of p.site.plan.levels.each(c))
        if (L < storeys && !p.site.town.has(c, L) && !p.site.town.add(c, L, st.id, typeIndex(st.type))) throw new Error(`settlements: ${s.rec.id}'s site block ${c}:${L} couldn't stand`);
    for (const f of this.onRaised) f(s.rec.id, site.structure);
  }

  /**
   * The settlement's field a step on, fed by its grain (a step eats a little of it; a hungry town doesn't
   * grow); when nothing is being built, the lot the field is strongest on becomes the next house to build.
   */
  private grow(p: SettlementPlan, s: SettlementSeed): void {
    const rec = s.rec;
    if (rec.id === this.pinned) return;
    const grain = rec.stores.grain;
    const people = rec.people.filter((x) => !x.hostile).reduce((a, x) => a + x.count, 0);
    if (!grain || grain.stock < people * 0.5) return;
    grain.stock -= people * 0.05;
    p.field.step({ rate: 0.22, spread: 0.08, colonise: 0.3 }, 1);
    const pending = p.sites.some((x) => !x.finished);
    if (pending || !p.free.length) return;
    for (const f of p.free) f.v = p.field.at(f.centre[0] / FIELD_CELL, f.centre[1] / FIELD_CELL).v;
    p.free.sort((a, b) => b.v - a.v);
    const next = p.free[0];
    if (next.v < BUILT_V * 0.6) return;
    p.free.shift();
    const id = `${rec.id}:site${p.sites.length}`;
    // (onetown: the house goes into the town's plan as the generator places its own — planned, the builders' work)
    const sid = placeBuilding(p.site, next.building, 0);
    if (sid < 0) return;
    // (round 128o: the town kept walkable and every structure entered, as at its planning — structures/place.ts)
    keepReach(p.site);
    assertEntered(p.site);
    p.sites.push({ id, structure: sid, storeys: levelsOfStructure(p.site, sid), door: next.door });
    for (const f of this.onRaised) f(rec.id, sid);
    rec.needs.push({ kind: 'build', at: [next.door[0] + s.box.x0, next.door[1] + s.box.y0 * ROW_H], ref: id, priority: 2 });
  }

  /** a house finished in play: its Instance and Building on the record; the event */
  private finished(s: SettlementSeed, site: SiteSpec): void {
    const rec = s.rec;
    const [x, y] = [site.door[0] + s.box.x0, site.door[1] + s.box.y0 * ROW_H];
    const room = `${site.id}:room0`;
    const hearth = `${site.id}:fitting0`;
    const owner = { settlement: rec.id, faction: rec.faction ?? undefined };
    this.things.set(site.id, { id: site.id, kind: 'house', material: s.civ.lookMat.wall, condition: 1, owner, place: { in: 'world', region: rec.region, at: [x, y, 0] }, parts: [{ slot: 'room', thing: room }, { slot: 'fitting', thing: hearth }], history: [{ what: 'made', run: 0, by: rec.faction ? { faction: rec.faction } : undefined, note: `built by its builders from the quarry's stone and the woods' logs` }] });
    this.things.set(room, { id: room, kind: 'room', parts: [], condition: 1, owner, place: { in: 'thing', thing: site.id, slot: 'room' }, history: [] });
    this.things.set(hearth, { id: hearth, kind: 'hearth', parts: [], condition: 1, owner, place: { in: 'thing', thing: site.id, slot: 'fitting' }, history: [] });
    const use = derive(catalogue(this.things), site.id).tags.filter((t) => t === 'housing');
    rec.buildings.push({ id: site.id, thing: site.id, grid: rec.grids[0].id, cells: [...(this.done.get(rec.id)?.site.plan.structure(site.structure)?.cells.keys() ?? [])], storeys: site.storeys, use });
    rec.needs = rec.needs.filter((j) => j.ref !== site.id);
    site.finished = true;
    for (const f of this.events.built) f(rec, { buildings: rec.buildings.length, ms: 0, house: site.id });
  }

  /** whether a settlement may mine at a window point (its own region, or mineral rights there) */
  private mayMine(s: Settlement, at: V2): boolean {
    const [wx, wy] = this.toWorld(at);
    const region = this.regionAt(wx, wy);
    if (region === s.region) return true;
    if (!s.faction) return false;
    return this.diplomacy.rights(region, [wx, wy]).some((a) => a.kind === 'mineral-rights' && a.status === 'active' && 'faction' in a.parties[0] && a.parties[0].faction === s.faction);
  }

  regionAt(x: number, y: number): RegionId {
    const a = this.atlas;
    const n = a.p.n;
    const tx = this.mod(Math.floor((x / a.worldW) * n), n);
    const ty = this.mod(Math.floor((y / a.worldH) * n), n);
    return a.regionOf[ty * n + tx];
  }

  // ---- (round 94) the far plans ------------------------------------------------------------------------

  /** Plan the settlements within reach of the camera for the land past the window (one at a time, nearest first). */
  farPlans(io: FarIO): void {
    this.farIO = io;
  }

  /** each frame (whatever the streamer's doing): the next far plan, the stamps in reach to the bake */
  farUpdate(dt: number): void {
    const io = this.farIO;
    if (!io) return;
    this.farClock -= dt;
    if (this.farClock > 0) return;
    this.farClock = 0.2;
    const at = io.camera();
    const near = this.seeds.map((s) => [this.dist(s.rec.at, at), s] as const).filter(([d]) => d <= io.radius * 1.15);
    if (!this.farBusy) {
      let best: SettlementSeed | null = null;
      let bd = io.radius;
      for (const [d, s] of near) {
        const id = s.rec.id;
        if (d < bd && !this.farStamps.has(id) && !this.exactStamps.has(id)) {
          bd = d;
          best = s;
        }
      }
      if (best) void this.farPlan(best, io);
    }
    const list = near.map(([, s]) => this.exactStamps.get(s.rec.id) ?? this.farStamps.get(s.rec.id)).filter((x): x is SurfaceStamp => !!x && x.w > 0);
    if (list.length !== this.lastStamps.length || list.some((x, i) => x !== this.lastStamps[i])) {
      this.lastStamps = list;
      for (const f of this.onStamps) f(list);
    }
  }

  private worker(): Worker {
    if (this.farWorker) return this.farWorker;
    const w = new Worker(new URL('./plan-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FarPlanDone | ExactPlanDone>) => {
      // (round 102: the plan's structured clone is taken here — its cost on the main thread)
      const d = timed('plan.receive', () => e.data);
      const key = 'plan' in d ? `exact:${d.id}` : d.id;
      const f = this.farWait.get(key);
      this.farWait.delete(key);
      f?.(d);
    };
    w.onerror = (e) => {
      throw new Error(`settlements: the far plans' worker failed: ${e.message}`);
    };
    const t0 = performance.now();
    const a = this.atlas;
    const init: FarPlanInit = { init: { regionOf: a.regionOf, n: a.p.n, worldW: a.worldW, worldH: a.worldH } };
    w.postMessage(init);
    this.farStats.initMs = +(performance.now() - t0).toFixed(1);
    this.farWorker = w;
    return w;
  }

  private async farPlan(s: SettlementSeed, io: FarIO): Promise<void> {
    this.farBusy++;
    try {
      const { box } = s;
      const t0 = performance.now();
      const g = await io.rough(box.x0, box.y0, box.w, box.h);
      if (!g) return;
      this.farStats.roughMs += performance.now() - t0;
      const a = this.atlas;
      const ways = waysNear(a.ways, box.x0, box.y0 * ROW_H, box.x0 + box.w + 1, (box.y0 + box.h + 1) * ROW_H, a.worldW, a.worldH);
      const job: FarPlanJob = { id: s.rec.id, seed: s, ...g, sea: a.p.sea, ways };
      const done = await new Promise<FarPlanDone>((res) => {
        this.farWait.set(s.rec.id, res as (d: FarPlanDone | ExactPlanDone) => void);
        this.worker().postMessage(job, [g.ground.buffer, g.water.buffer, g.top.buffer, g.veg.buffer]);
      });
      this.farStamps.set(s.rec.id, done.stamp);
      const F = this.farStats;
      F.planned++;
      F.waysMs += done.ms[0];
      F.planMs += done.ms[1];
      F.rasterMs += done.ms[2];
      F.maxPlanMs = Math.max(F.maxPlanMs, done.ms[1]);
    } finally {
      this.farBusy--;
    }
  }

  /** each frame: the stores' rates, which settlement's alive */
  update(dt: number): void {
    this.clock += dt;
    for (const id of this.replan) {
      const s = this.byId.get(id)!;
      if (this.inWindow(s)) continue;
      this.replan.delete(id);
      this.planAgain(s);
    }
    // (atlas scale: every settlement not in play goes on by its rates, a few times a minute)
    if (this.clock - this.lastAdvance > 10) {
      const days = (this.clock - this.lastAdvance) / DAY_S;
      this.lastAdvance = this.clock;
      for (const s of this.recs.values()) {
        if (s === this.life?.rec) continue;
        for (const st of Object.values(s.stores)) st.stock = Math.max(0, st.stock + st.rate * days);
      }
    }
    const io = this.io;
    if (!io) return;
    // the nearest planned settlement inside the window (a margin in from its edge) is the live one
    const f = io.focus();
    const fw = this.toWorld(f);
    let best: SettlementSeed | null = null;
    let bd = Infinity;
    for (const s of this.seeds) {
      if (!this.done.has(s.rec.id)) continue;
      const d = this.dist(s.rec.at, fw);
      const [wx, wy] = this.toWindow(s.rec.at);
      const m = 40;
      if (wx < m || wy < m || wx > io.dims.w - m || wy > io.dims.h * ROW_H - m) continue;
      if (d < bd || s.rec.id === this.pinned) {
        bd = s.rec.id === this.pinned ? -1 : d;
        best = s;
      }
    }
    if (this.life && this.life.rec.id !== best?.rec.id) {
      this.life.dispose();
      this.life = null;
    }
    if (best && !this.life && !(this.pinnedOwnLife && best.rec.id === this.pinned)) {
      const s = best;
      const p = this.done.get(s.rec.id)!;
      this.life = new SettlementLife(s.rec, p.camp, {
        units: io.units,
        spots: () => this.liveSpots(p, s),
        trees: io.trees,
        fell: io.fell,
        take: io.take,
        put: io.put,
        raise: (site, n) => this.raise(p, s, site, n),
        dims: io.dims,
        epoch: io.epoch,
        ready: io.ready,
        sites: () => this.liveSites(p, s),
        finished: (site) => this.finished(s, site),
        grow: () => this.grow(p, s),
        deliver: (good, n) => {
          const st = (s.rec.stores[good] ??= { stock: 0, rate: 0 });
          st.stock += n;
        },
        mayMine: (at) => this.mayMine(s.rec, at),
      }, io.budget, (outcome, losses) => {
        for (const f of this.events.raided) f(s.rec, outcome, losses);
      });
    }
    this.life?.update(dt);
  }
}
