// ---- units/agent-units.ts ---------------------------------------------------------
// The Units contract (api/contracts/units.ts) on the GPU agents (src/agents; round 88). Units walk the
// agents' surfaces by shared fields; what's per unit (its job, faction, health in the contract's terms,
// whom it's after) lives here on the CPU and is turned into groups, fields, targets and hits each sync.
//  - Jobs are fields (docs/AGENTS.md): units with the same goal follow one field. Standing (idle, guard at
//    its post) is a group that follows none. Going somewhere (go, patrol, follow, flee, back to a post, an
//    attack on someone far) takes one of GOALS shared goal fields, keyed by where (two cells); when all are
//    busy a unit waits standing until one frees. 'work' is the settlements' (Routine): their workers'
//    rounds between homes, jobs and stores on fields of their own.
//  - Fighting: a hostile unit (a hostile kind on the GPU) wanders where it is; when an actor or a unit of
//    another faction comes within its sight it joins the hunt: the hunting group follows the targets' field
//    (agents.setTargets: the nearest TARGETS to the hunters), and the GPU swings at what's in reach — its
//    blows come back as swing events, turned here into damage on whoever was hit (an actor's `hurt`, a
//    unit's agents.hit). A unit that isn't hostile but is ordered to attack, or a guard with a hostile in
//    sight, closes in on the foes' field and strikes (CPU: in reach, every STRIKE s, a hit with a knock).
//  - Health is the contract's (default 3); the GPU's hp is HPK times it. Deaths come back as death events.
//  - (LW1) Raised: with the trait system on the agents a fallen unit lies as a corpse, and a raise effect can stand it up
//    again (a 'raised' event: the same GPU id) in the raiser's group. It's alive again here, keeps its role, and is
//    `bound`: the raiser's, not this layer's to order — it neither takes jobs nor hunts until the game orders it.
// Window coordinates (x cells, y world units, z the ground) as the world API's.
import type { Actor, AreaHit, SpawnOpts, UnitId, UnitJob, UnitView, Units, V2, V3 } from '../api/contracts/units';
import type { FactionId } from '../api/contracts/world';
import type { Agents, AgentEvent, AgentState, Target } from '../agents/agents';
import type { PickAsk } from '../agents/pick';
import { MAT } from '../world/materials';
import { timed } from '../gpu/cpustat';
import { ACTOR, NO_FACTION, type CombatSpec } from '../agents/notice';
import { cellPos } from '../world/lattice';

/** GPU hit points per contract health point */
const HPK = 3;
/** shared goal fields (agents fields 9..11), their groups (2..4) */
const GOALS = 3;
/** the agents' fields: the settlements' rounds (0-6: life.ts), the hunt's targets, the defenders' foes, goals */
export const F = { farm: 0, fell: 1, quarry: 2, home: 3, store: 4, pile: 5, site: 6, targets: 7, foes: 8, goal0: 9 } as const;
/** groups: striking (standing, at work), standing, goals 2-4, closing on foes, hunting, loafing; 8-15 the rounds */
export const G = { strike: 0, stand: 1, goal0: 2, foes: 5, hunt: 6, wander: 7 } as const;
/** a town's people's legs (agents groups 8..15; resting at home is the units' standing group) — round 88's rounds, the
 *  one crowd's (town/life.ts legs) since round 128o */
export const R = { toFarm: 8, toFell: 9, toQuarry: 10, working: 11, toStore: 12, toPile: 13, toSite: 14, toHome: 15 } as const;
/**
 * (round 128l, m4) The fortress's own groups past R (agents MAX_GROUPS 24): the legs to the smithy and the barracks, the
 * soldiers' march to the wall's stairs, the carts' rides (each to its own pile: cart0 .. cart0 + 2). They ride the road
 * graph only (Agents.ride: no fields of their own); a leg whose goals no road reaches waits where it is.
 */
export const R4 = { toSmith: 16, toBarracks: 17, toPost: 18, cart0: 19 } as const;
/** (merge123, LW1-1) the group a raise effect stands the fallen up in (contracts/traits.ts raise `group`): standing,
 *  bound to their raiser until the game orders them (the play hero's: follow it) */
export const RAISED_GROUP = G.stand;
/** agents' kinds (0 worker, 1 raider, 2 ogre are the defaults the others use) */
const K = { worker: 0, guard: 3, character: 4, raider: 5, shambler: 6, cart: 7 } as const;

/**
 * (round 128l, m4) A cart's look: a wooden bed on four dark wheels with a driver's seat at the front (voxels of 0.25 cells
 * round its feet). Behaviour first — the user's art push comes after.
 */
function cartModel(): [number, number, number, number][] {
  const v: [number, number, number, number][] = [];
  for (let x = -4; x <= 3; x++)
    for (let y = -2; y <= 2; y++) {
      v.push([x, y, 2, MAT.Wood]);
      if (x === -4 || x === 3 || y === -2 || y === 2) v.push([x, y, 3, MAT.Wood]);
    }
  for (const [x, y] of [[-3, -3], [-3, 3], [2, -3], [2, 3]]) for (const z of [0, 1, 2]) v.push([x, y, z, MAT.Basalt]);
  for (let z = 3; z <= 5; z++) v.push([4, 0, z, MAT.Flower]);
  return v;
}
/**
 * (round 128l, m4: the attack wave; main: "at play zoom I can't see the raiders") A raider's look: bigger than a
 * villager, a red tunic, a dark hood and a lit torch held up (its flame glows: lava), so a wave reads at the phone's
 * play zoom. Voxels of 0.25 cells round its feet, x forward.
 */
function raiderModel(): [number, number, number, number][] {
  const v: [number, number, number, number][] = [];
  for (const y of [-1, 1]) for (let z = 0; z <= 2; z++) v.push([0, y, z, MAT.Basalt]);
  for (let x = -1; x <= 0; x++) for (let y = -1; y <= 1; y++) for (let z = 3; z <= 5; z++) v.push([x, y, z, MAT.Tile]);
  for (const [x, y] of [[-1, 0], [0, 0], [-1, -1], [0, -1]]) for (const z of [6, 7]) v.push([x, y, z, MAT.Obsidian]);
  // the torch arm: up on the right, a stick, the flame
  for (const z of [4, 5]) v.push([1, 2, z, MAT.Tile]);
  for (const z of [6, 7, 8]) v.push([1, 2, z, MAT.Log]);
  for (const z of [9, 10]) v.push([1, 2, z, MAT.Lava]);
  return v;
}
const TARGETS = 8;
const REACH = 1.5;
const STRIKE = 1.0;
const LEASH = 28;
/** (round 128p) the rules' height limit: two farther apart in height don't fight (one up on the wall-walk) */
const HEIGHT_LIMIT = 1.6;
/** the agents' unit slots (agents.ts MAX_UNITS): a GPU id's slot */
const MAX_SLOT = 8192;
/** how near a goal counts as there */
const THERE = 1.6;

/** A settlement's worker rounds: the settlements take units with a 'work' job whose `settlement` they run. */
export interface Routine {
  /** whether it runs this unit's work (its settlement is live) */
  takes(u: UnitRec): boolean;
  /** each sync: move it on (agents.regroup through `units.regroup`) */
  step(u: UnitRec, dt: number): void;
  /** it stopped working (another order, death, removal) */
  drop(u: UnitRec): void;
  /**
   * (round 128o, DA-A6) it arrived (the agents' `arrived` event): at the end of the field it follows (`field`), or at its
   * group's ride's goal (`ride`: the group); where it stands then
   */
  arrived?(u: UnitRec, e: { field?: number; ride?: number; at: V3 }): void;
  /** (DA-A6) events the agents' ring dropped (it overflowed): a unit may never hear of its arrival */
  lost?(count: number): void;
}

export interface UnitRec {
  v: UnitView;
  gpu: number;
  sight: number;
  damage: number;
  group: number;
  /** what it's after (a unit or an actor), and since when it noticed */
  target: UnitId | string | null;
  /** (round 128p) how near the nearest hostile hunting it is (Infinity: none; the GPU's — agents/notice.ts) */
  hunted?: number;
  cool: number;
  /** the goal key it holds */
  goal: string | null;
  /** the routine's own state */
  work?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  patrolAt?: V2;
  seenState?: AgentState['state'];
  /** (LW1) raised into this group: the raiser's (no jobs, no hunt here until it's ordered) */
  bound?: number;
}

const COLOURS = ['#7c8a96', '#b0583a', '#5d8a4a', '#b89a4a', '#6a5a9a', '#4a8a8a'];

export class AgentUnits implements Units {
  readonly died: ((u: UnitView, by: UnitId | string | null) => void)[] = [];
  readonly hurt: ((u: UnitView, damage: number, by: UnitId | string | null) => void)[] = [];
  readonly noticed: ((u: UnitView, target: UnitId | string) => void)[] = [];
  /** (LW1) a fallen unit raised (the trait system's raise): alive again, bound to `group` */
  readonly raised: ((u: UnitView, group: number) => void)[] = [];
  readonly recs = new Map<UnitId, UnitRec>();
  /** (LW1) the fallen by their GPU id: a corpse may rise */
  private fallen = new Map<number, UnitId>();
  private byGpu = new Map<number, UnitId>();
  private actors: Actor[] = [];
  private next = 1;
  private syncing: Promise<void> | null = null;
  private lastSync = 0;
  private goals: ({ key: string; at: V2 } | null)[] = Array.from({ length: GOALS }, () => null);
  /** the targets as last handed to the GPU (swing events name them by index) */
  private targetsNow: (UnitId | string)[] = [];
  private targetsPrev: (UnitId | string)[] = [];
  /** our hits: who struck */
  private hitBy = new Map<number, UnitId | string | null>();
  private factionCol = new Map<string, string>();
  routine: Routine | null = null;
  /**
   * (round 128l, m4: the attack wave) whether `u` may take on `foe` (null: anyone in sight). The game's rule over who
   * can reach whom: the fortress's raiders don't hunt people behind a shut wall or up on the wall-walk, and its archers
   * hold their places and shoot instead of closing in. Asked of hostiles noticing and of defenders choosing.
   */
  /**
   * (round 128p, DA-B22 (c)(3): the rule as data, not a callback — the GPU chooses who fights whom, agents/notice.ts)
   * The game's rules over who may take on whom: on — the posted (an archer on the wall) take no one on; where a raider
   * is involved neither side may be one in at home or a cart, nor stand more than HEIGHT_LIMIT above the other, nor on
   * the other side of the wall (`sideAt`: a column's side, the same number on the same side) unless it's `open`.
   * Null: off — any hostile and any peaceful one of another faction.
   */
  fightRules(r: { open: boolean; sideAt: (x: number, y: number) => number } | null): void {
    this.rules = r;
    this.agents.notice.setRules({ on: r !== null, open: r?.open ?? false, heightLimit: HEIGHT_LIMIT, leash: LEASH });
    this.uploadSides();
  }
  /** (round 128p) who neither fights nor is fought while the rules are on (in at home), and who holds its post */
  fightFlags(noFight: Iterable<UnitId>, posted: Iterable<UnitId>): void {
    this.noFight = new Set(noFight);
    this.posted = new Set(posted);
  }
  private rules: { open: boolean; sideAt: (x: number, y: number) => number } | null = null;
  private noFight = new Set<UnitId>();
  private posted = new Set<UnitId>();
  private sideMap: Uint32Array | null = null;
  private factionNo = new Map<FactionId, number>();
  /** each unit's combat word as last written (by GPU id): written again only when it changes */
  private combatKey = new Map<number, string>();
  /** live units at the last sync, and how long that sync took to come back (ms) */
  stats = { units: 0, hunting: 0, syncMs: 0, syncs: 0 };

  constructor(readonly agents: Agents) {
    agents.defineKind(K.guard, { name: 'guard', height: 1.45, mass: 1.2, hp: 10, speed: 2.7, colours: { torso: MAT.Steel, head: MAT.Steel } });
    agents.defineKind(K.character, { name: 'character', height: 1.4, mass: 1, hp: 10, speed: 2.5, colours: { torso: MAT.Brick, legs: MAT.Wood } });
    agents.defineKind(K.raider, { name: 'raider', height: 1.6, mass: 1, hp: 10, speed: 3.1, reach: 1.35, damage: 1, swingPeriod: 1.1, notice: 160, colours: { torso: MAT.Tile, legs: MAT.Basalt, head: MAT.Obsidian }, model: { voxels: raiderModel(), voxel: 0.25 } });
    agents.defineKind(K.shambler, { name: 'shambler', height: 1.4, mass: 1, hp: 10, speed: 1.5, reach: 1.1, damage: 1, swingPeriod: 1.6, notice: 50, colours: { torso: MAT.Bone, legs: MAT.Ash, head: MAT.Bone } });
    // (round 88: people a third of a storey tall, in a yellow tunic — at the phone's half resolution a 1-cell figure
    // in canvas was lost against plaster and grass)
    agents.defineKind(K.worker, { name: 'worker', height: 1.4, mass: 1, hp: 10, speed: 2.4, colours: { torso: MAT.Flower, legs: MAT.Wood, head: MAT.Sand } });
    // (round 128l, m4) the fortress's carts: slower than a walker, heavier, a load of CART_LOAD
    agents.defineKind(K.cart, { name: 'cart', height: 1.2, mass: 4, hp: 20, speed: 1.7, model: { voxels: cartModel(), voxel: 0.25 } });
    agents.follow(G.stand, -1);
    agents.follow(G.strike, -1);
    agents.workPose(G.strike, true);
    agents.follow(G.wander, -1);
    agents.follow(G.foes, F.foes);
    agents.follow(G.hunt, F.targets);
    for (let i = 0; i < GOALS; i++) agents.follow(G.goal0 + i, F.goal0 + i);
  }

  // ---- the contract -------------------------------------------------------------------------------

  spawn(kind: string, at: V2, faction: FactionId | null, o: SpawnOpts = {}): UnitId {
    const id = this.next++;
    const hp = o.health ?? 3;
    const hostile = !!o.hostile;
    const v: UnitView = {
      id,
      kind,
      role: o.role ?? kind,
      name: o.name,
      character: o.character,
      settlement: o.settlement,
      faction,
      at: [at[0], at[1], 0],
      heading: Math.PI / 2,
      health: hp,
      maxHealth: hp,
      hostile,
      alive: true,
      job: o.job ?? { kind: 'guard', at: [at[0], at[1]] },
      state: 'idle',
      colour: o.colour ?? this.colourOf(faction),
    };
    const u: UnitRec = { v, gpu: -1, sight: o.sight ?? 10, damage: o.damage ?? 1, group: -1, target: null, cool: 0, goal: null };
    u.gpu = this.place(u, at, (o.speed ?? 3) < 2.2);
    this.recs.set(id, u);
    this.assign(u);
    return id;
  }

  get(id: UnitId): UnitView | null {
    const u = this.recs.get(id);
    return u ? this.view(u) : null;
  }

  query(near: V2, radius: number, opts: { faction?: FactionId | null; hostile?: boolean; dead?: boolean } = {}): UnitView[] {
    const out: [number, UnitView][] = [];
    for (const u of this.recs.values()) {
      if (!u.v.alive && !opts.dead) continue;
      if (opts.faction !== undefined && u.v.faction !== opts.faction) continue;
      if (opts.hostile !== undefined && u.v.hostile !== opts.hostile) continue;
      const d = Math.hypot(u.v.at[0] - near[0], u.v.at[1] - near[1]);
      if (d <= radius) out.push([d, this.view(u)]);
    }
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  byCharacter(character: string): UnitView | null {
    for (const u of this.recs.values()) if (u.v.character === character) return this.view(u);
    return null;
  }

  order(who: UnitId | UnitId[], job: UnitJob): void {
    for (const id of Array.isArray(who) ? who : [who]) {
      const u = this.recs.get(id);
      if (!u || !u.v.alive) continue;
      if (u.v.job.kind === 'work' && job.kind !== 'work') this.routine?.drop(u);
      // (an order takes a raised unit back from its raiser)
      u.bound = undefined;
      u.v.job = job;
      u.target = job.kind === 'attack' ? job.target : null;
      this.releaseGoal(u);
      this.assign(u);
    }
  }

  setHostile(id: UnitId, hostile: boolean): void {
    const u = this.recs.get(id);
    if (!u || u.v.hostile === hostile || !u.v.alive) return;
    // (a hostile kind on the GPU is another kind: put it there again as one, where it stands, as hurt as it was)
    u.v.hostile = hostile;
    this.byGpu.delete(u.gpu);
    this.agents.remove([u.gpu]);
    u.gpu = this.place(u, [u.v.at[0], u.v.at[1]], false);
    u.group = -1;
    this.assign(u);
  }

  hit(id: UnitId, damage: number, by: UnitId | string | null): void {
    const u = this.recs.get(id);
    if (!u || !u.v.alive) return;
    // (no group filter: a regroup in flight would miss it; small enough to be the one standing there)
    const hid = this.agents.hit({ x: u.v.at[0], y: u.v.at[1], z: u.v.at[2] + 0.5, radius: 0.45, damage: damage * HPK });
    this.hitBy.set(hid, by);
  }

  /** (round 117, play) the agents hold this many at once (agents.ts MAX_HOLDS) */
  readonly maxHeld = 8;

  /** (round 117, play) a blow over an area with a shove and a throw: Agents.hit, its id remembered for `by` */
  strike(h: AreaHit, by: UnitId | string | null): void {
    const hid = this.agents.hit({
      x: h.at[0],
      y: h.at[1],
      z: h.z,
      radius: h.radius,
      damage: h.damage * HPK,
      push: h.push,
      dir: h.dir,
      lift: h.lift,
      // (the agents' cone is its full angle in degrees; ours radians either side)
      cone: h.cone === undefined ? undefined : (h.cone * 2 * 180) / Math.PI,
      axis: h.axis ?? (h.cone !== undefined && !h.dir ? [1, 0] : undefined),
      stun: h.stun,
      fire: h.fire,
    });
    this.hitBy.set(hid, by);
  }

  /** (round 117, play) held at `at` (its feet) by its agent */
  hold(id: UnitId, at: V3): boolean {
    const u = this.recs.get(id);
    if (!u || !u.v.alive) return false;
    return this.agents.hold(u.gpu, at[0], at[1], at[2]);
  }

  /** (round 117, play) let go at `vel` (or thrown, if it wasn't held) */
  release(id: UnitId, vel?: V3): void {
    const u = this.recs.get(id);
    if (!u) return;
    if (vel) this.agents.launch(u.gpu, vel);
    else this.agents.release(u.gpu);
  }

  remove(id: UnitId): void {
    const u = this.recs.get(id);
    if (!u) return;
    if (u.v.job.kind === 'work') this.routine?.drop(u);
    this.releaseGoal(u);
    if (u.v.alive) this.agents.remove([u.gpu]);
    this.byGpu.delete(u.gpu);
    this.recs.delete(id);
  }

  watch(actor: Actor): void {
    if (!this.actors.includes(actor)) this.actors.push(actor);
  }

  /**
   * (round 128p, DA-B22 (c)(2)) Of the units `among`, the one drawn nearest a tap (`ask`: the camera's matrix and
   * viewport, the tap, the radius in pixels, the figure's middle over its feet), or null — on the GPU (Agents.pick).
   */
  async pickAt(among: readonly UnitId[], ask: PickAsk): Promise<UnitId | null> {
    const gpu: number[] = [];
    const ids: UnitId[] = [];
    for (const id of among) {
      const u = this.recs.get(id);
      if (!u || !u.v.alive) continue;
      gpu.push(u.gpu);
      ids.push(id);
    }
    const g = await this.agents.pick(gpu, ask);
    return g === null ? null : ids[gpu.indexOf(g)];
  }

  /** (round 128p) the side map the rules hold, on the GPU: every window column's side (uploaded when it changes) */
  private uploadSides(): void {
    const r = this.rules;
    if (!r) {
      this.sideMap = null;
      this.agents.notice.setSides(null);
      return;
    }
    const { w, h } = this.agents.dims;
    const map = new Uint32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [px, py] = cellPos(x, y);
        map[y * w + x] = r.sideAt(px, py);
      }
    const old = this.sideMap;
    if (old && old.length === map.length && old.every((v, i) => v === map[i])) return;
    this.sideMap = map;
    this.agents.notice.setSides(map);
  }

  /** (round 128p) a unit's part in the fighting, as the GPU's rules read it (agents/notice.ts) */
  private combatOf(u: UnitRec): CombatSpec {
    let faction = NO_FACTION;
    if (u.v.faction !== null) {
      let n = this.factionNo.get(u.v.faction);
      if (n === undefined) {
        n = this.factionNo.size;
        if (n >= NO_FACTION) throw new Error(`units: more than ${NO_FACTION} factions`);
        this.factionNo.set(u.v.faction, n);
      }
      faction = n;
    }
    const j = u.v.job;
    const looks = u.v.hostile || u.v.role === 'guard';
    return {
      faction,
      hostile: u.v.hostile,
      guard: u.v.role === 'guard',
      noFight: this.noFight.has(u.v.id) || u.v.role === 'cart',
      posted: this.posted.has(u.v.id),
      raider: u.v.role === 'raider',
      bound: u.bound !== undefined || !u.v.alive,
      sight: looks ? u.sight : 0,
      home: !u.v.hostile && j.kind === 'guard' ? j.at : null,
    };
  }

  /** (round 128p) its combat word written if it changed */
  private syncCombat(u: UnitRec): void {
    const c = this.combatOf(u);
    const key = JSON.stringify(c);
    if (this.combatKey.get(u.gpu) === key) return;
    this.combatKey.set(u.gpu, key);
    this.agents.notice.set(u.gpu % MAX_SLOT, c);
  }

  /** (round 128p) a target code (agents/notice.ts) as the game's target */
  private targetOf(code: number): UnitId | string | null {
    if (!code) return null;
    if (code & ACTOR) return this.actorsSent[code & ~ACTOR]?.id ?? null;
    return this.byGpu.get(code - 1) ?? null;
  }

  /** (round 128p) the game's target as a code, or null when it isn't one the GPU knows */
  private codeOf(t: UnitId | string): number | null {
    if (typeof t === 'string') {
      const i = this.actorsSent.findIndex((a) => a.id === t);
      return i >= 0 ? (ACTOR | i) >>> 0 : null;
    }
    const u = this.recs.get(t);
    return u && u.v.alive ? u.gpu + 1 : null;
  }
  /** the actors as handed to the GPU this frame (a target code's index) */
  private actorsSent: Actor[] = [];

  shift(dx: number, dy: number, _dz: number): void {
    // (the agents move their own units on the GPU; what's kept here in window coordinates moves with them)
    const m = (p: V2): V2 => [p[0] - dx, p[1] - dy];
    for (const u of this.recs.values()) {
      u.v.at = [u.v.at[0] - dx, u.v.at[1] - dy, u.v.at[2]];
      const j = u.v.job;
      if (j.kind === 'guard') u.v.job = { ...j, at: m(j.at) };
      else if (j.kind === 'go') u.v.job = { ...j, to: m(j.to) };
      else if (j.kind === 'patrol') u.v.job = { ...j, around: m(j.around) };
      else if (j.kind === 'flee') u.v.job = { ...j, from: m(j.from) };
      else if (j.kind === 'work') u.v.job = { ...j, at: m(j.at) };
      if (u.patrolAt) u.patrolAt = m(u.patrolAt);
    }
    for (const g of this.goals) if (g) g.at = m(g.at);
    this.reseedGoals();
    // (round 128p: the side map is the window's columns: made again where the window now lies)
    this.uploadSides();
    this.combatKey.clear();
  }

  update(dt: number): void {
    if (this.syncing) return;
    const t0 = performance.now();
    this.syncing = this.agents.sync().then(({ units, events, dropped }) => {
      const sdt = this.lastSync ? Math.min(0.5, (performance.now() - this.lastSync) / 1000) : dt;
      this.lastSync = performance.now();
      this.stats.syncMs = +(performance.now() - t0).toFixed(1);
      this.stats.syncs++;
      timed('units', () => {
        if (dropped && this.routine?.lost) this.routine.lost(dropped);
        this.absorb(units, events);
        this.think(sdt);
      });
      this.syncing = null;
    });
  }

  // ---- for the settlements' routine -----------------------------------------------------------------

  /** move a unit to a group (the routine's own, 8..15) */
  regroup(u: UnitRec, g: number): void {
    if (u.group === g) return;
    u.group = g;
    this.agents.regroup(u.gpu, g);
  }

  /**
   * (round 128o, DA-A6) A unit's role changes where it stands (a recruit drilled: a soldier) — its kind on the GPU with
   * it: put there again as the new kind, at full health.
   */
  restyle(id: UnitId, role: string, o: { health?: number; damage?: number } = {}): void {
    const u = this.recs.get(id);
    if (!u || !u.v.alive) return;
    u.v.role = role;
    if (o.health !== undefined) u.v.health = u.v.maxHealth = o.health;
    if (o.damage !== undefined) u.damage = o.damage;
    const g = u.group;
    this.byGpu.delete(u.gpu);
    this.agents.remove([u.gpu]);
    u.gpu = this.place(u, [u.v.at[0], u.v.at[1]], false);
    u.group = -1;
    this.regroup(u, g < 0 ? G.stand : g);
  }

  /**
   * (DA-A6) A working unit's goal (its routine's: a soldier's wall point): one of the shared goal fields seeded at `at`,
   * its group returned for the routine to put it in; null `at` lets it go. Null back: every goal field is held.
   */
  goalGroup(u: UnitRec, at: V2 | null): number | null {
    if (!at) {
      this.releaseGoal(u);
      return null;
    }
    const i = this.holdGoal(u, at);
    return i === null ? null : G.goal0 + i;
  }

  /** (DA-A6) its arrival latch let go: it's told when it's at its leg's end, even where it was told it last (Agents.rearm) */
  rearm(u: UnitRec): void {
    this.agents.rearm(u.gpu);
  }

  /** a unit's carried load (shown over its head), or none */
  carry(u: UnitRec, what: string | null, amount = 0.35): void {
    // (a new load replaces what it held: dropped from the hands, not onto the ground)
    this.agents.unload(u.gpu);
    if (what) this.agents.carry(u.gpu, what, amount);
  }

  // ---- insides ------------------------------------------------------------------------------------------

  private colourOf(f: FactionId | null): string {
    if (!f) return COLOURS[0];
    let c = this.factionCol.get(f);
    if (!c) this.factionCol.set(f, (c = COLOURS[(this.factionCol.size + 1) % COLOURS.length]));
    return c;
  }

  private kindOf(u: UnitRec, slow: boolean): number {
    if (u.v.hostile) return slow || u.v.role.includes('dead') ? K.shambler : K.raider;
    if (u.v.role === 'guard') return K.guard;
    if (u.v.role === 'cart') return K.cart;
    if (u.v.name || u.v.character) return K.character;
    return K.worker;
  }

  private place(u: UnitRec, at: V2, slow: boolean): number {
    const [gpu] = this.agents.spawn(1, at[0], at[1], { group: G.stand, kind: this.kindOf(u, slow), spread: 0.3, hp: Math.max(u.v.health, 0.1) * HPK });
    this.byGpu.set(gpu, u.v.id);
    u.group = G.stand;
    return gpu;
  }

  private view(u: UnitRec): UnitView {
    return { ...u.v, at: [...u.v.at] as V3, job: structuredClone(u.v.job) };
  }

  /** where a unit's job sends it now (null: it stands where it is) */
  private goalOf(u: UnitRec): V2 | null {
    const j = u.v.job;
    const at: V2 = [u.v.at[0], u.v.at[1]];
    const far = (p: V2, d: number) => Math.hypot(p[0] - at[0], p[1] - at[1]) > d;
    switch (j.kind) {
      case 'idle':
      case 'work':
        return null;
      case 'guard':
        return far(j.at, j.radius ?? THERE) ? j.at : null;
      case 'go':
        return far(j.to, THERE) ? j.to : null;
      case 'patrol': {
        if (!u.patrolAt || !far(u.patrolAt, THERE)) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * j.radius;
          u.patrolAt = [j.around[0] + Math.cos(a) * r, j.around[1] + Math.sin(a) * r];
        }
        // (patrols share their circle's middle as a goal: round enough to read as a walk)
        return u.patrolAt;
      }
      case 'flee': {
        const dx = at[0] - j.from[0];
        const dy = at[1] - j.from[1];
        const d = Math.hypot(dx, dy) || 1;
        return d > 30 ? null : [at[0] + (dx / d) * 18, at[1] + (dy / d) * 18];
      }
      case 'follow':
      case 'attack': {
        const p = this.posOf(j.target);
        if (!p) return null;
        return far([p[0], p[1]], j.kind === 'follow' ? (j.distance ?? 2.5) : REACH * 0.8) ? [p[0], p[1]] : null;
      }
    }
  }

  private posOf(t: UnitId | string): V3 | null {
    if (typeof t === 'string') {
      const a = this.actors.find((x) => x.id === t);
      return a && a.alive() ? a.position() : null;
    }
    const u = this.recs.get(t);
    return u && u.v.alive ? u.v.at : null;
  }

  /** take a goal field for `at` (shared by key), or null when all are held elsewhere */
  private holdGoal(u: UnitRec, at: V2): number | null {
    const key = `${Math.round(at[0] / 2)},${Math.round(at[1] / 2)}`;
    if (u.goal) {
      const i = this.goals.findIndex((g) => g?.key === u.goal);
      if (i >= 0 && u.goal === key) return i;
      this.releaseGoal(u);
    }
    let i = this.goals.findIndex((g) => g?.key === key);
    if (i < 0) {
      i = this.goals.findIndex((g) => !g || ![...this.recs.values()].some((r) => r.goal === g.key));
      if (i < 0) return null;
      this.goals[i] = { key, at };
      this.reseedGoals();
    }
    u.goal = key;
    return i;
  }

  private releaseGoal(u: UnitRec): void {
    if (!u.goal) return;
    const key = u.goal;
    u.goal = null;
    if (![...this.recs.values()].some((r) => r.goal === key)) {
      const i = this.goals.findIndex((g) => g?.key === key);
      if (i >= 0) {
        this.goals[i] = null;
        this.reseedGoals();
      }
    }
  }

  private reseedGoals(): void {
    this.goals.forEach((g, i) => this.agents.seed(F.goal0 + i, g ? [{ x: g.at[0], y: g.at[1] }] : []));
  }

  /** a unit's group from its job (fighting aside) */
  private assign(u: UnitRec): void {
    if (!u.v.alive) return;
    if (u.v.job.kind === 'work' && this.routine?.takes(u)) return;
    const goal = this.goalOf(u);
    if (!goal) {
      this.releaseGoal(u);
      this.regroup(u, u.v.hostile ? G.wander : G.stand);
      u.v.state = 'idle';
      return;
    }
    const i = this.holdGoal(u, goal);
    if (i === null) {
      this.regroup(u, G.stand);
      u.v.state = 'idle';
      return;
    }
    // (a moving goal — someone followed or attacked — moves its field with it)
    const g = this.goals[i]!;
    if (Math.hypot(g.at[0] - goal[0], g.at[1] - goal[1]) > 1) {
      g.at = goal;
      this.reseedGoals();
    }
    this.regroup(u, G.goal0 + i);
    u.v.state = 'walk';
  }

  private absorb(units: AgentState[], events: AgentEvent[]): void {
    let n = 0;
    for (const s of units) {
      const id = this.byGpu.get(s.id);
      if (id === undefined) continue;
      const u = this.recs.get(id)!;
      u.v.at = [s.x, s.y, s.z];
      u.v.heading = s.heading;
      u.v.health = s.hp / HPK;
      u.seenState = s.state;
      // (round 128p: whom it's after — the GPU's choice, agents/notice.ts)
      u.target = this.targetOf(s.target);
      u.hunted = s.hunted;
      if (s.state === 'swing') u.v.state = 'swing';
      else if (s.state === 'tumble') u.v.state = 'hurt';
      else if (s.state === 'chase') u.v.state = 'chase';
      else if (u.v.state === 'swing' || u.v.state === 'hurt') u.v.state = u.group === G.stand || u.group === G.wander ? 'idle' : 'walk';
      n++;
    }
    this.stats.units = n;
    for (const e of events) {
      if (e.type === 'swing') {
        const att = this.byGpu.get(e.id);
        const a = att !== undefined ? this.recs.get(att) : undefined;
        const t = this.targetsNow[e.target] ?? this.targetsPrev[e.target];
        if (!a || t === undefined) continue;
        if (typeof t === 'string') {
          const actor = this.actors.find((x) => x.id === t);
          if (actor && actor.alive()) actor.hurt(a.damage, this.view(a));
        } else this.hit(t, a.damage, a.v.id);
      } else if (e.type === 'hurt') {
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u) continue;
        const by = typeof e.hit === 'number' ? (this.hitBy.get(e.hit) ?? null) : null;
        for (const f of this.hurt) f(this.view(u), e.damage / HPK, by);
        // (struck by someone: a guard or a worker on guard turns on it — given it on the GPU, round 128p)
        if (by !== null && !u.v.hostile && u.target === null && typeof by === 'number' && this.recs.get(by)?.v.hostile) {
          u.target = by;
          const code = this.codeOf(by);
          if (code !== null) this.agents.notice.aim(u.gpu % MAX_SLOT, code);
        }
      } else if (e.type === 'death') {
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u) continue;
        u.v.alive = false;
        u.v.state = 'dead';
        u.v.health = 0;
        this.byGpu.delete(e.id);
        this.fallen.set(e.id, u.v.id);
        if (u.v.job.kind === 'work') this.routine?.drop(u);
        this.releaseGoal(u);
        const by = typeof e.by === 'number' ? (this.hitBy.get(e.by) ?? null) : null;
        for (const f of this.died) f(this.view(u), by);
      } else if (e.type === 'raised') {
        const id = this.fallen.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        this.fallen.delete(e.id);
        if (!u) continue;
        u.v.alive = true;
        u.v.state = 'idle';
        u.v.job = { kind: 'idle' };
        u.target = null;
        u.group = e.group;
        u.bound = e.group;
        // (merge123) the raised are their raiser's: a raider stood up by the hero's lich no longer hunts the hero
        u.v.hostile = false;
        this.byGpu.set(e.id, u.v.id);
        for (const f of this.raised) f(this.view(u), e.group);
      } else if (e.type === 'noticed') {
        // (round 128p: a hostile took a new target, on the GPU)
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        const t = this.targetOf(e.target);
        if (u && t !== null) for (const f of this.noticed) f(this.view(u), t);
      } else if (e.type === 'decayed') this.fallen.delete(e.id);
      else if (e.type === 'arrived') {
        // (round 128o, DA-A6) a working unit's arrival: its routine's
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u || !u.v.alive || u.v.job.kind !== 'work' || !this.routine?.arrived) continue;
        this.routine.arrived(u, { field: e.field, ride: e.ride, at: [e.x, e.y, e.z] });
      }
    }
    // (the dead are kept for `query({ dead: true })` a while, then forgotten)
    if (this.recs.size > 600) for (const [id, u] of this.recs) if (!u.v.alive) this.recs.delete(id);
    if (this.fallen.size > 600) for (const [g, id] of this.fallen) if (!this.recs.has(id)) this.fallen.delete(g);
  }

  /**
   * who's hunting whom; who's striking; the jobs' groups. (Round 128p, DA-B22 (c)(3): who takes on whom is the GPU's —
   * agents/notice.ts, each unit's target in its state, the rules as data — not a search here over every unit.)
   */
  private think(dt: number): void {
    // (LW1: the raised are their raiser's — not hunted for here, nor given jobs)
    const live = [...this.recs.values()].filter((u) => u.v.alive && u.bound === undefined);
    for (const u of this.recs.values()) if (u.v.alive) this.syncCombat(u);
    // (the actors this frame: whom hostiles may hunt beside the units)
    this.actorsSent = this.actors.slice(0, 8);
    this.agents.notice.setActors(this.actorsSent.map((a) => ({ at: a.alive() ? a.position() : null, faction: a.faction !== null ? (this.factionNo.get(a.faction) ?? NO_FACTION) : NO_FACTION })));
    const hostiles = live.filter((u) => u.v.hostile);
    const d2 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    // hostiles: hunt what the GPU gave them; else their work, wandering
    let hunting = 0;
    for (const h of hostiles) {
      if (h.v.job.kind === 'attack') {
        if (!this.posOf(h.v.job.target)) h.v.job = { kind: 'idle' };
      }
      if (h.target !== null && !this.posOf(h.target)) h.target = null;
      if (h.target !== null) {
        this.releaseGoal(h);
        this.regroup(h, G.hunt);
        hunting++;
      } else if (h.v.job.kind === 'work' && this.routine?.takes(h)) this.routine.step(h, dt);
      else if (h.group === G.hunt) this.assign(h);
      else if (h.group === G.stand || h.group === G.wander || (h.group >= G.goal0 && h.group < G.goal0 + GOALS)) this.assign(h);
    }
    this.stats.hunting = hunting;
    // the hunted: the nearest TARGETS to their hunters — the hunters' targets and whoever they may fight within their
    // sight, as the GPU marked them (u.hunted, agents/notice.ts); an actor hunted, by its hunter's distance
    const hunters = hostiles.filter((h) => h.target !== null);
    const cand = new Map<UnitId | string, number>();
    for (const u of live) if (u.hunted !== undefined && u.hunted < Infinity && hunters.length) cand.set(u.v.id, u.hunted);
    for (const h of hunters) {
      const t = h.target!;
      if (typeof t !== 'string') continue;
      const p = this.posOf(t);
      if (p) cand.set(t, Math.min(cand.get(t) ?? Infinity, d2(p, h.v.at)));
    }
    const chosen = [...cand.entries()].sort((a, b) => a[1] - b[1]).slice(0, TARGETS).map((e) => e[0]);
    this.targetsPrev = this.targetsNow;
    this.targetsNow = chosen;
    const targets: Target[] = [];
    for (const t of chosen) {
      const p = this.posOf(t)!;
      targets.push({ x: p[0], y: p[1], z: p[2], radius: 0.4, height: 1.1 });
    }
    this.agents.setTargets(targets, hunters.length ? F.targets : -1);
    if (!hunters.length) this.agents.seed(F.targets, []);
    // defenders: guards with a hostile in sight, units ordered to attack, anyone struck — their targets the GPU's: close
    // in and strike
    const foes: V2[] = [];
    for (const u of live) {
      if (u.v.hostile) continue;
      const j = u.v.job;
      // (an order to attack: given on the GPU until it holds, and kept there while the rules allow)
      if (j.kind === 'attack') {
        if (!this.posOf(j.target)) {
          u.v.job = { kind: 'idle' };
          u.target = null;
          this.assign(u);
          continue;
        }
        if (u.target !== j.target) {
          const code = this.codeOf(j.target);
          if (code !== null) this.agents.notice.aim(u.gpu % MAX_SLOT, code);
        }
      }
      if (u.target === null) {
        // (let go — out of its leash, out of reach of the rules — back to its job)
        if (u.group === G.foes || u.group === G.strike) this.assign(u);
        continue;
      }
      const p = this.posOf(u.target);
      if (!p) {
        u.target = null;
        this.assign(u);
        continue;
      }
      u.cool -= dt;
      const d = d2(p, u.v.at);
      if (d < REACH) {
        this.regroup(u, G.strike);
        u.v.state = 'swing';
        if (u.cool <= 0) {
          u.cool = STRIKE;
          const dx = p[0] - u.v.at[0];
          const dy = p[1] - u.v.at[1];
          if (typeof u.target === 'number') {
            const t = this.recs.get(u.target)!;
            const hid = this.agents.hit({ x: p[0], y: p[1], z: p[2] + 0.5, radius: 0.5, damage: u.damage * HPK, push: 4, dir: [dx, dy], groups: [t.group] });
            this.hitBy.set(hid, u.v.id);
          } else {
            const a = this.actors.find((x) => x.id === u.target);
            a?.hurt(u.damage, this.view(u));
          }
        }
      } else {
        foes.push([p[0], p[1]]);
        this.releaseGoal(u);
        this.regroup(u, G.foes);
        u.v.state = 'chase';
      }
    }
    this.agents.seed(F.foes, foes.slice(0, 6).map(([x, y]) => ({ x, y })));
    // workers and the rest: their jobs
    for (const u of live) {
      if (u.v.hostile || u.target !== null) continue;
      if (u.v.job.kind === 'work' && this.routine?.takes(u)) this.routine.step(u, dt);
      else this.assign(u);
    }
  }
}
