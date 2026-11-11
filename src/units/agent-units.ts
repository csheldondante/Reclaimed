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
//    sight, closes in on the foes' field and strikes. (U2 round 5, DA-B32: every blow between units is the GPU's —
//    the striker's step adds it to its target's accumulator, the target's step applies it naming the striker, and a
//    unit struck with no target turns on who struck it; the foes' field is seeded on the GPU from the defenders'
//    targets. Only a blow at an actor — the hero, the CPU's — comes back as a swing event.)
//  - (U2 round 5) Place orders: spawnAt / orderGroup name a town place by indices; the GPU resolves it (orders.wgsl)
//    and tells arrived / orderFailed per group.
//  - Health is the contract's (default 3); the GPU's hp is HPK times it. Deaths come back as death events.
//  - (LW1) Raised: with the trait system on the agents a fallen unit lies as a corpse, and a raise effect can stand it up
//    again (a 'raised' event: the same GPU id) in the raiser's group. It's alive again here, keeps its role, and is
//    `bound`: the raiser's, not this layer's to order — it neither takes jobs nor hunts until the game orders it.
// Window coordinates (x cells, y world units, z the ground) as the world API's.
import type { Actor, AreaHit, OrderFailure, PlaceRef, SpawnAtOpts, SquadOrder, SeenUnit, SpawnOpts, UnitId, UnitJob, UnitView, Units, V2, V3 } from '../api/contracts/units';
import type { FactionId } from '../api/contracts/world';
import type { GroupId } from '../api/contracts/inhabitants';
import { ORDER_ALTS, orderColourGroup, type Agents, type OrderPlace, type AgentEvent, type AgentState, type HuntCandidate, type OrderRecord, type Target } from '../agents/agents';
import type { PickAsk } from '../agents/pick';
import { MAT } from '../world/materials';
import { timed } from '../gpu/cpustat';
import { OrderFields } from '../agents/fieldseam';
import { ACTOR, NO_FACTION, type CombatSpec } from '../agents/notice';
import { urlFlags } from '../flags';

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
const K = { worker: 0, soldier: 1, guard: 3, character: 4, raider: 5, shambler: 6, cart: 7 } as const;

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
/** units.wgsl / agents.ts BY_UNIT: a hurt's or a death's hit with this bit is a unit's id (its arrow, FC12 stage 2) */
const BY_UNIT = 0x40000000;
/** (U2, UNIT_MINDS_U2.md §5: the riskiest part, measured) ?huntgpu=1: the hunt field seeded on the GPU from every
 *  hostile's target (Agents.gpuHunt) — the actors' targets still seeded here; off: the TARGETS nearest, as before */
const HUNT_GPU = typeof location !== 'undefined' && urlFlags().get('huntgpu') === '1';
const REACH = 1.5;
const LEASH = 28;
/** (U2 round 5, DA-B32) a peaceful fighter's blow on the GPU (its kind's): reach (cells), damage (GPU hp: a contract
 *  health point), the swing's period (s) — the CPU's strike's were REACH, the unit's damage, STRIKE 1 s */
const MELEE = { reach: 1.35, damage: HPK, swingPeriod: 1.0 } as const;
/** orders.wgsl group kinds */
const OK = { none: 0, stand: 1, go: 2, guard: 3, attack: 4, drill: 5, man: 6, march: 7 } as const;
/** townplace.wgsl statuses as the contract's reasons; (round 6) a gate's (orders.wgsl FAIL_GATE | routeread GATE_*) */
const WHY: Record<number, OrderFailure> = { 1: 'none', 2: 'rising', 3: 'water', 4: 'no-town', 0x11: 'none', 0x12: 'rising', 0x13: 'water', 0x14: 'failed' };
/** (round 6) formations' spacing (cells), a man's post spacing, a man order's most run fields */
const FORM_SPACING = 1.2;
const POST_SPACING = 3;
const MAN_FIELDS = 3;

/** (U2 round 5) an order group: its slot on the GPU (orders.wgsl), its members, its order, the field it holds */
interface OrderGroup {
  id: GroupId;
  members: Set<UnitId>;
  order: SquadOrder | null;
  /** (round 6, Track A's ask) its spawn not yet resolved on the GPU (no `spawned` or failure read): orders wait in
   *  `held`, sent once it stands — an order sent at once took the spawn's record, and a spawn at a missing place stood
   *  at the order's */
  spawning: boolean;
  held: SquadOrder | null;
  /** (round 6) a march that leaves: members gone out of the window, and left(g) told */
  gone: number;
  leftTold: boolean;
  /** the spawn's place (the record's while it stands) */
  at: PlaceRef;
  /** the GPU order's serial now, and the spawn's (a failure of the spawn: none made) */
  serial: number;
  spawnSerial: number;
}
/** one ref by indices (orders.wgsl's): a named place or a lot */
const placeOf = (p: PlaceRef): OrderPlace => ({ town: p.town, place: 'place' in p ? { name: p.place } : { district: p.district, lotKind: p.kind, rank: p.rank } });
/**
 * (U2 round 5b) A PlaceRef's chain as the GPU's alternatives: the ref, its `else`, its `else`'s `else` — each with its
 * `also`. Deeper than ORDER_ALTS, or an `also` with an `else` or `also` of its own, throws here (the call's).
 */
function placeChain(p: PlaceRef): OrderRecord['alts'] {
  const alts: OrderRecord['alts'] = [];
  for (let q: PlaceRef | undefined = p; q; q = q.else) {
    if (alts.length === ORDER_ALTS) throw new Error(`units: a place's else chain is ${ORDER_ALTS} deep at most`);
    if (q.also && (q.also.else || q.also.also)) throw new Error("units: a place's also has no else or also of its own");
    alts.push({ at: placeOf(q), also: q.also ? placeOf(q.also) : undefined });
  }
  return alts;
}
const placeKey = (p: PlaceRef): string => JSON.stringify(placeChain(p));
/** (round 128p) the rules' height limit: two farther apart in height don't fight (one up on the wall-walk) */
const HEIGHT_LIMIT = 1.6;
/** the agents' unit slots (agents.ts MAX_UNITS): a GPU id's slot */
const MAX_SLOT = 8192;
/** how near a goal counts as there */
const THERE = 1.6;
/** (round 128p) a goal's key: its place to two cells — goals that near share a field (holdGoal), and an arrival there
 *  is the job's end (goalOf) */
const goalKey = (p: V2): string => `${Math.round(p[0] / 2)},${Math.round(p[1] / 2)}`;

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
  cool: number;
  /** the goal key it holds */
  goal: string | null;
  /** (round 128p, DA-B22 (c)(4)) the goal key it was told it arrived at (the agents' `arrived` on its goal field): it
   *  stands there — no position read to tell */
  arrived?: string;
  /** (round 128p) its side of the wall as last told (the side map's number: fightRules) */
  side?: number;
  /** the routine's own state */
  work?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  patrolAt?: V2;
  seenState?: AgentState['state'];
  /** (LW1) raised into this group: the raiser's (no jobs, no hunt here until it's ordered) */
  bound?: number;
  /** (U2 round 5) its order group's slot (spawnAt): its walk is the group's order, not a job here */
  order?: number;
}

const COLOURS = ['#7c8a96', '#b0583a', '#5d8a4a', '#b89a4a', '#6a5a9a', '#4a8a8a'];

export class AgentUnits implements Units {
  readonly died: ((u: UnitView, by: UnitId | string | null) => void)[] = [];
  readonly hurt: ((u: UnitView, damage: number, by: UnitId | string | null) => void)[] = [];
  readonly noticed: ((u: UnitView, target: UnitId | string) => void)[] = [];
  /** (U2 round 5) a group's living members all at its order's place; a group's order failed */
  readonly arrived: ((g: GroupId) => void)[] = [];
  readonly orderFailed: ((g: GroupId, why: OrderFailure) => void)[] = [];
  readonly left: ((g: GroupId) => void)[] = [];
  /** (round 6) a town slot's routes (LivingTowns.routeRead(site).buffer), for man and march */
  private routesFor: ((town: number) => GPUBuffer | null) | null = null;
  /** the town whose routes are bound, while a man or march holds them */
  private routesTown: number | null = null;
  private groups: (OrderGroup | null)[];
  /** (round 6) groups whose spawn failed, and why: their orders fail the same (the failure sticks) */
  private failedGroups = new Map<GroupId, OrderFailure>();
  /** (round 6) the order groups' fields: the one seam to them (round 7 pages them) */
  private fields: OrderFields;
  private nextGroup = 1;
  /** failures found on the CPU (no field free), told at the next sync with the GPU's */
  private failsNow: [GroupId, OrderFailure][] = [];
  /** (U2 round 5) a town's box in the window (its scope kept round an order there): the town contracts' */
  private townArea: ((town: number) => readonly (readonly [number, number])[] | null) | null = null;
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
   * the other side of the wall unless it's `open` (the side map: the GPU's, Track A's town contracts — U2 round 5, no
   * CPU side path). Null: off — any hostile and any peaceful one of another faction.
   */
  fightRules(r: { open: boolean } | null): void {
    this.agents.notice.setRules({ on: r !== null, open: r?.open ?? false, heightLimit: HEIGHT_LIMIT, leash: LEASH });
  }
  /** (round 128p) who neither fights nor is fought while the rules are on (in at home), and who holds its post */
  fightFlags(noFight: Iterable<UnitId>, posted: Iterable<UnitId>): void {
    this.noFight = new Set(noFight);
    this.posted = new Set(posted);
  }
  private noFight = new Set<UnitId>();
  private posted = new Set<UnitId>();
  private factionNo = new Map<FactionId, number>();
  /** each unit's combat word as last written (by GPU id): written again only when it changes */
  private combatKey = new Map<number, string>();
  /** live units at the last sync, and how long that sync took to come back (ms) */
  stats = { units: 0, hunting: 0, syncMs: 0, syncs: 0 };

  /** (U2) the hunt field's seeds the GPU's (Agents.gpuHunt): ?huntgpu=1, or a test's; the field bench toggles it (with
   *  Agents.huntOn) */
  huntGpu: boolean;

  constructor(
    readonly agents: Agents,
    o: { huntGpu?: boolean } = {},
  ) {
    this.huntGpu = o.huntGpu ?? HUNT_GPU;
    this.fields = new OrderFields(agents);
    this.groups = Array.from({ length: agents.orderGroups }, () => null);
    if (this.huntGpu) agents.gpuHunt(F.targets);
    // (U2 round 5, DA-B32: the defenders' foes seeded on the GPU — the peaceful fighters' targets)
    agents.gpuFoes(F.foes);
    // (DA-B32: every kind that may fight back has a blow of its own on the GPU — MELEE; the hostile kinds' damage in GPU
    // hp, a contract health point a blow, as the CPU's swing turned into a hit was)
    // (round 6, Track A's ask: a soldier's pace 3.2 — a kind of its own, the slot the agents' default raider had)
    agents.defineKind(K.soldier, { name: 'soldier', height: 1.45, mass: 1.2, hp: 10, speed: 3.2, ...MELEE, colours: { torso: MAT.Steel, head: MAT.Steel } });
    agents.defineKind(K.guard, { name: 'guard', height: 1.45, mass: 1.2, hp: 10, speed: 2.7, ...MELEE, colours: { torso: MAT.Steel, head: MAT.Steel } });
    agents.defineKind(K.character, { name: 'character', height: 1.4, mass: 1, hp: 10, speed: 2.5, ...MELEE, colours: { torso: MAT.Brick, legs: MAT.Wood } });
    agents.defineKind(K.raider, { name: 'raider', height: 1.6, mass: 1, hp: 10, speed: 3.4, reach: 1.35, damage: HPK, swingPeriod: 1.1, notice: 160, colours: { torso: MAT.Tile, legs: MAT.Basalt, head: MAT.Obsidian }, model: { voxels: raiderModel(), voxel: 0.25 } });
    agents.defineKind(K.shambler, { name: 'shambler', height: 1.4, mass: 1, hp: 10, speed: 1.5, reach: 1.1, damage: HPK, swingPeriod: 1.6, notice: 50, colours: { torso: MAT.Bone, legs: MAT.Ash, head: MAT.Bone } });
    // (round 88: people a third of a storey tall, in a yellow tunic — at the phone's half resolution a 1-cell figure
    // in canvas was lost against plaster and grass)
    agents.defineKind(K.worker, { name: 'worker', height: 1.4, mass: 1, hp: 10, speed: 2.4, ...MELEE, colours: { torso: MAT.Flower, legs: MAT.Wood, head: MAT.Sand } });
    // (round 128l, m4) the fortress's carts: slower than a walker, heavier, a load of CART_LOAD
    agents.defineKind(K.cart, { name: 'cart', height: 1.2, mass: 4, hp: 20, speed: 1.7, model: { voxels: cartModel(), voxel: 0.25 } });
    agents.follow(G.stand, -1);
    agents.follow(G.strike, -1);
    agents.workPose(G.strike, true);
    agents.follow(G.wander, -1);
    agents.follow(G.foes, F.foes);
    agents.follow(G.hunt, F.targets);
    for (let i = 0; i < GOALS; i++) agents.follow(G.goal0 + i, F.goal0 + i);
    // (round 128p, DA-B22 (c)(4): arriving at a goal told by the GPU — the jobs that went somewhere stand there)
    for (let i = 0; i < GOALS; i++) agents.arrivals(F.goal0 + i, THERE, THERE * 2);
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

  // ---- (U2 round 5) place orders: a town place by indices, resolved on the GPU (orders.wgsl) ----------------------

  /**
   * The town contracts' place table (TownContractsApi.places) and, for each town slot, a few points round it in the
   * window (the agents' scope kept there while a group is ordered in it — the fields reach no farther than the scope).
   */
  usePlaces(places: GPUBuffer, townArea: ((town: number) => readonly (readonly [number, number])[] | null) | null = null, routesFor: ((town: number) => GPUBuffer | null) | null = null): void {
    this.agents.usePlaces(places);
    this.townArea = townArea;
    this.routesFor = routesFor;
  }

  spawnAt(kind: string, faction: FactionId | null, at: PlaceRef, n: number, opts: SpawnAtOpts = {}): GroupId {
    if (!this.agents.placesIn) throw new Error('units.spawnAt: no town place table yet (usePlaces)');
    const chain = placeChain(at);
    const slot = this.groups.findIndex((g) => g === null);
    if (slot < 0) {
      // (Track A's ask: no throw — a group id, no units, and orderFailed(g, 'pool-full'), sticking)
      const gid = this.nextGroup++;
      this.failedGroups.set(gid, 'pool-full');
      this.failsNow.push([gid, 'pool-full']);
      return gid;
    }
    const health = opts.health ?? 3;
    const g: OrderGroup = { id: this.nextGroup++, members: new Set(), order: null, spawning: true, held: null, gone: 0, leftTold: false, at, serial: 0, spawnSerial: 0 };
    this.groups[slot] = g;
    // (it stands at its place until ordered: the GPU resolves the place for the spawn, and tells a failure)
    g.spawnSerial = g.serial = this.agents.order(slot, { kind: OK.stand, alts: chain, field: -1 });
    this.keepTown(slot, at.town);
    const hostile = kind === 'raider' || kind === 'shambler' || kind.includes('dead');
    const recs: UnitRec[] = [];
    for (let i = 0; i < n; i++) {
      const v: UnitView = {
        id: this.next++,
        kind,
        role: kind,
        faction,
        at: null,
        heading: Math.PI / 2,
        health,
        maxHealth: health,
        hostile,
        alive: true,
        job: { kind: 'idle' },
        state: 'idle',
        colour: this.colourOf(faction),
      };
      recs.push({ v, gpu: -1, sight: opts.sight ?? 10, damage: opts.damage ?? 1, group: orderColourGroup(slot), target: null, cool: 0, goal: null, order: slot });
    }
    const slow = kind === 'shambler' || (opts.speed !== undefined && opts.speed < 2.2);
    const gpu = this.agents.spawnAt(n, slot, { kind: this.kindOf(recs[0] ?? ({ v: { hostile, role: kind } } as UnitRec), slow), hp: Math.max(health, 0.1) * HPK });
    recs.forEach((u, i) => {
      u.gpu = gpu[i];
      this.byGpu.set(u.gpu, u.v.id);
      this.recs.set(u.v.id, u);
      g.members.add(u.v.id);
    });
    return g.id;
  }

  orderGroup(id: GroupId, o: SquadOrder): void {
    // (a group whose spawn failed: its orders fail the same)
    const dead = this.failedGroups.get(id);
    if (dead) {
      this.failsNow.push([id, dead]);
      return;
    }
    const slot = this.groups.findIndex((g) => g?.id === id);
    if (slot < 0) return;
    const g = this.groups[slot]!;
    // (its spawn not resolved yet: the order waits for it — the latest one)
    if (g.spawning) {
      g.held = o;
      return;
    }
    const routed = o.kind === 'man' || o.kind === 'march';
    // (round 6: man and march read their town's routes — one town's bound at a time)
    if (routed) {
      const buf = this.routesFor?.(o.town) ?? null;
      if (!buf) {
        this.failsNow.push([id, 'no-town']);
        return;
      }
      const busy = this.routesTown !== null && this.routesTown !== o.town && this.groups.some((x, i) => i !== slot && x?.order && (x.order.kind === 'man' || x.order.kind === 'march'));
      if (busy) {
        this.failsNow.push([id, 'busy']);
        return;
      }
      this.agents.useRoutes(buf);
      this.routesTown = o.town;
    }
    const key = routed ? (o.kind === 'man' ? `man:${o.town}:${o.side ?? '*'}` : `march:${o.town}:${o.gate}`) : placeKey(o.at);
    const want = o.kind === 'man' ? MAN_FIELDS : 1;
    // (its fields through the seam (agents/fieldseam.ts): a field a key — shared with any group ordered to the same one;
    // a man order a field a wall run, as many as are free up to MAN_FIELDS; none free — the order isn't sent)
    const fields = this.fields.fieldFor(slot, key, want);
    // (or the field pages ran out: the pool refused a page — the visible error is Agents', this order isn't sent)
    if (!fields || this.agents.fieldPagesRefused > 0) {
      this.failsNow.push([id, 'pool-full']);
      return;
    }
    g.order = o;
    g.gone = 0;
    g.leftTold = false;
    const formation = o.kind === 'man' ? 0 : 'formation' in o && o.formation ? (o.formation === 'line' ? 2 : 1) : o.kind === 'march' ? 1 : 0;
    const rec: OrderRecord = { kind: OK[o.kind], alts: routed ? [] : placeChain(o.at), field: fields[0], formation, spacing: o.kind === 'man' ? POST_SPACING : FORM_SPACING };
    if (o.kind === 'man') {
      rec.gate = o.side;
      rec.runFields = fields;
    } else if (o.kind === 'march') {
      rec.gate = o.gate;
      rec.leave = !!o.leave;
    }
    g.serial = this.agents.order(slot, rec);
    this.keepTown(slot, o.kind === 'man' || o.kind === 'march' ? o.town : o.at.town);
    // (an attack order turns the group hostile, a guard order makes it look: their combat words, at the next think)
  }

  members(id: GroupId): UnitId[] {
    const g = this.groups.find((x) => x?.id === id);
    return g ? [...g.members].filter((m) => this.recs.get(m)?.v.alive) : [];
  }

  /** the agents' scope kept round the town an order group is at (its fields reach no farther than the scope) */
  private keepTown(slot: number, town: number): void {
    const pts = this.townArea?.(town);
    this.agents.keepInScope(`order${slot}`, pts ?? []);
  }

  private freeGroup(slot: number): void {
    const g = this.groups[slot];
    if (!g) return;
    for (const id of g.members) {
      const u = this.recs.get(id);
      if (u) u.order = undefined;
    }
    this.groups[slot] = null;
    this.fields.release(slot);
    this.agents.order(slot, { kind: OK.none, alts: [{ at: { town: 0, place: { name: 0 } } }], field: -1 });
    this.agents.keepInScope(`order${slot}`, []);
    // (round 6: the routes let go with the last man or march)
    if (!this.groups.some((x) => x?.order && (x.order.kind === 'man' || x.order.kind === 'march'))) this.routesTown = null;
  }

  /** a unit given a job of its own leaves its order group */
  private leaveGroup(u: UnitRec): void {
    if (u.order === undefined) return;
    this.groups[u.order]?.members.delete(u.v.id);
    u.order = undefined;
  }

  get(id: UnitId): UnitView | null {
    const u = this.recs.get(id);
    return u ? this.view(u) : null;
  }

  /**
   * (round 128p, DA-B22 (c)(4)) Asked of the GPU (Agents.near: the live units within the radius, with where they stand);
   * the dead by where they fell (their death event's place)
   */
  async query(near: V2, radius: number, opts: { faction?: FactionId | null; hostile?: boolean; dead?: boolean } = {}): Promise<SeenUnit[]> {
    const keep = (u: UnitRec) => (opts.faction === undefined || u.v.faction === opts.faction) && (opts.hostile === undefined || u.v.hostile === opts.hostile);
    const out: [number, SeenUnit][] = [];
    // (one faction's: looked for on the GPU among its units only — its combat words; NO_FACTION for none)
    const fac = opts.faction === undefined ? null : opts.faction === null ? NO_FACTION : (this.factionNo.get(opts.faction) ?? -1);
    for (const f of fac === -1 ? [] : await this.agents.near(near[0], near[1], radius, fac)) {
      const id = this.byGpu.get(f.id);
      const u = id !== undefined ? this.recs.get(id) : undefined;
      if (!u || !u.v.alive || !keep(u)) continue;
      out.push([Math.hypot(f.x - near[0], f.y - near[1]), { ...this.view(u), at: [f.x, f.y, f.z] }]);
    }
    if (opts.dead)
      for (const u of this.recs.values()) {
        const at = u.v.at;
        if (u.v.alive || !at || !keep(u)) continue;
        const d = Math.hypot(at[0] - near[0], at[1] - near[1]);
        if (d <= radius) out.push([d, { ...this.view(u), at: [at[0], at[1], at[2]] }]);
      }
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  /**
   * (round 128p, DA-B22 (c)(4)) Keep these units' positions read each frame until released (counted: each observer
   * releases its own). Everything else is events and queries.
   */
  observe(ids: UnitId | readonly UnitId[]): () => void {
    const list = typeof ids === 'number' ? [ids] : [...ids];
    for (const id of list) this.observers.set(id, (this.observers.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const id of list) {
        const n = (this.observers.get(id) ?? 0) - 1;
        if (n > 0) this.observers.set(id, n);
        else this.observers.delete(id);
      }
    };
  }
  /** (round 128p) a unit's side of the wall as the GPU last told it (the side map's number), or null: not told */
  sideOf(id: UnitId): number | null {
    return this.recs.get(id)?.side ?? null;
  }

  /** (round 128p) the observed by the game (observe), and by this layer for what it still does on the CPU (strikes,
   *  fleeing, following): their positions read each sync */
  private observers = new Map<UnitId, number>();
  private auto = new Set<UnitId>();

  byCharacter(character: string): UnitView | null {
    for (const u of this.recs.values()) if (u.v.character === character) return this.view(u);
    return null;
  }

  order(who: UnitId | UnitId[], job: UnitJob): void {
    for (const id of Array.isArray(who) ? who : [who]) {
      const u = this.recs.get(id);
      if (!u || !u.v.alive) continue;
      if (u.v.job.kind === 'work' && job.kind !== 'work') this.routine?.drop(u);
      // (an order takes a raised unit back from its raiser, and one from its order group)
      u.bound = undefined;
      this.leaveGroup(u);
      u.v.job = job;
      u.target = job.kind === 'attack' ? job.target : null;
      u.arrived = undefined;
      u.patrolAt = undefined;
      this.releaseGoal(u);
      this.assign(u);
    }
  }

  setHostile(id: UnitId, hostile: boolean): void {
    const u = this.recs.get(id);
    if (!u || u.v.hostile === hostile || !u.v.alive) return;
    // (a hostile kind on the GPU is another kind: made one where it stands, as hurt as it was — round 128p: in place)
    u.v.hostile = hostile;
    this.agents.rekind(u.gpu, this.kindOf(u, false));
    this.assign(u);
  }

  hit(id: UnitId, damage: number, by: UnitId | string | null): void {
    const u = this.recs.get(id);
    if (!u || !u.v.alive) return;
    // (round 128p: a hit on that one unit, wherever it stands — no position read for it)
    const hid = this.agents.hit({ unit: u.gpu, x: 0, y: 0, radius: 0, damage: damage * HPK });
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
    // (U2 round 5: a group ordered to attack is hostile to anything on the way and there)
    const og = u.order !== undefined ? this.groups[u.order] : null;
    const hostile = u.v.hostile || og?.order?.kind === 'attack';
    const looks = hostile || u.v.role === 'guard' || u.v.role === 'soldier' || og?.order?.kind === 'guard';
    return {
      faction,
      hostile,
      guard: u.v.role === 'guard' || u.v.role === 'soldier' || og?.order?.kind === 'guard',
      noFight: this.noFight.has(u.v.id) || u.v.role === 'cart',
      posted: this.posted.has(u.v.id),
      raider: u.v.role === 'raider',
      bound: u.bound !== undefined || !u.v.alive,
      sight: looks ? u.sight : 0,
      home: !hostile && j.kind === 'guard' && u.order === undefined ? j.at : null,
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
  /** (round 128p) the hunt's nearest candidates as the last sync read them (notice.wgsl huntTop) */
  private hunt: HuntCandidate[] = [];
  /** the actors as handed to the GPU this frame (a target code's index) */
  private actorsSent: Actor[] = [];

  shift(dx: number, dy: number, _dz: number): void {
    // (the agents move their own units on the GPU; what's kept here in window coordinates moves with them)
    const m = (p: V2): V2 => [p[0] - dx, p[1] - dy];
    for (const u of this.recs.values()) {
      if (u.v.at) u.v.at = [u.v.at[0] - dx, u.v.at[1] - dy, u.v.at[2]];
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
    this.combatKey.clear();
  }

  update(dt: number): void {
    if (this.syncing) return;
    const t0 = performance.now();
    // (round 128p, DA-B22 (c)(1): only the observed units read — the game's and this layer's own; the rest is events)
    const watch: number[] = [];
    for (const id of new Set([...this.observers.keys(), ...this.auto])) {
      const u = this.recs.get(id);
      if (u && u.v.alive) watch.push(u.gpu);
    }
    this.syncing = this.agents.sync({ watch }).then(({ units, events, dropped, hunt }) => {
      this.hunt = hunt;
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
    // (round 128p: made the new kind where it stands, at full health — not removed and placed again)
    this.agents.rekind(u.gpu, this.kindOf(u, false), Math.max(u.v.health, 0.1) * HPK);
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
    if (u.v.role === 'soldier') return K.soldier;
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
    const at = u.v.at;
    return { ...u.v, at: at ? [at[0], at[1], at[2]] : null, job: structuredClone(u.v.job) };
  }

  /**
   * where a unit's job sends it now (null: it stands where it is). (Round 128p, DA-B22 (c)(4): going somewhere — a post,
   * a place, a patrol's next point — ends when the GPU says it arrived (`arrived` on its goal field: u.arrived), not by
   * reading where it is; fleeing and following read the observed)
   */
  private goalOf(u: UnitRec): V2 | null {
    const j = u.v.job;
    const there = (p: V2) => u.arrived === goalKey(p);
    switch (j.kind) {
      case 'idle':
      case 'work':
        return null;
      case 'guard':
        return there(j.at) ? null : j.at;
      case 'go':
        return there(j.to) ? null : j.to;
      case 'patrol': {
        if (!u.patrolAt || there(u.patrolAt)) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * j.radius;
          u.patrolAt = [j.around[0] + Math.cos(a) * r, j.around[1] + Math.sin(a) * r];
        }
        // (patrols share their circle's middle as a goal: round enough to read as a walk)
        return u.patrolAt;
      }
      case 'flee': {
        // (observed while it flees: this.auto)
        const at = u.v.at;
        if (!at) return null;
        const dx = at[0] - j.from[0];
        const dy = at[1] - j.from[1];
        const d = Math.hypot(dx, dy) || 1;
        return d > 30 ? null : [at[0] + (dx / d) * 18, at[1] + (dy / d) * 18];
      }
      case 'follow':
      case 'attack': {
        // (it and its target observed: this.auto)
        const p = this.posOf(j.target);
        if (!p) return null;
        const at = u.v.at;
        if (!at) return [p[0], p[1]];
        return Math.hypot(p[0] - at[0], p[1] - at[1]) > (j.kind === 'follow' ? (j.distance ?? 2.5) : REACH * 0.8) ? [p[0], p[1]] : null;
      }
    }
  }

  /** a target still in play: a living unit, or an actor alive */
  private alive(t: UnitId | string): boolean {
    if (typeof t === 'string') return !!this.actors.find((x) => x.id === t)?.alive();
    return !!this.recs.get(t)?.v.alive;
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
    const key = goalKey(at);
    // (round 128p: a new goal — its arrival told afresh)
    if (u.goal !== key && u.arrived !== undefined) {
      u.arrived = undefined;
      this.agents.rearm(u.gpu);
    }
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

  /** who a hurt or a death names: a hit of ours (its id), or (FC12 stage 2) a unit's arrow (BY_UNIT | its GPU id) */
  private byOf(n: number): UnitId | string | null {
    if (n >= BY_UNIT && n < BY_UNIT * 2) return this.byGpu.get(n - BY_UNIT) ?? null;
    return this.hitBy.get(n) ?? null;
  }

  private absorb(units: AgentState[], events: AgentEvent[]): void {
    let n = 0;
    // (round 128p, DA-B22 (c)(4): where a unit stands is known only for the observed read now — the rest not read: null,
    // never what it was; the dead keep where they fell)
    for (const u of this.recs.values()) if (u.v.alive) u.v.at = null;
    for (const s of units) {
      const id = this.byGpu.get(s.id);
      if (id === undefined) continue;
      const u = this.recs.get(id)!;
      u.v.at = [s.x, s.y, s.z];
      u.v.heading = s.heading;
      u.v.health = s.hp / HPK;
      u.seenState = s.state;
      // (round 128p: whom it's after — the GPU's choice, agents/notice.ts)
      if (s.state === 'swing') u.v.state = 'swing';
      else if (s.state === 'tumble') u.v.state = 'hurt';
      else if (s.state === 'chase') u.v.state = 'chase';
      else if (u.v.state === 'swing' || u.v.state === 'hurt') u.v.state = u.group === G.stand || u.group === G.wander ? 'idle' : 'walk';
      n++;
    }
    this.stats.units = n;
    for (const e of events) {
      if (e.type === 'swing') {
        // (U2 round 5, DA-B32: a blow at a unit lands on the GPU — its accumulator; only an actor's is the CPU's)
        const att = this.byGpu.get(e.id);
        const a = att !== undefined ? this.recs.get(att) : undefined;
        const t = this.targetsNow[e.target] ?? this.targetsPrev[e.target];
        if (!a || typeof t !== 'string') continue;
        const actor = this.actors.find((x) => x.id === t);
        // (where it swung from: the swing's event)
        if (actor && actor.alive()) actor.hurt(a.damage, { ...this.view(a), at: [e.x, e.y, e.z] });
      } else if (e.type === 'left') {
        // (round 6: out of the window on a march that leaves — no death; the group's left(g) once its last is gone)
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        this.byGpu.delete(e.id);
        if (!u) continue;
        u.v.alive = false;
        u.v.state = 'dead';
        u.v.at = [e.x, e.y, e.z];
        const g = u.order !== undefined ? this.groups[u.order] : null;
        if (g) {
          g.gone++;
          if (!g.leftTold && ![...g.members].some((m) => this.recs.get(m)?.v.alive)) {
            g.leftTold = true;
            for (const f of this.left) f(g.id);
          }
        }
      } else if (e.type === 'groupArrived') {
        const g = this.groups[e.group];
        if (g && g.order && e.serial === g.serial) for (const f of this.arrived) f(g.id);
      } else if (e.type === 'spawned') {
        // (round 6: the spawn stands — the order held back for it now sent)
        const g = this.groups[e.group];
        if (!g || !g.spawning || e.serial !== g.spawnSerial) continue;
        g.spawning = false;
        const held = g.held;
        g.held = null;
        if (held) this.orderGroup(g.id, held);
      } else if (e.type === 'orderFailed') {
        const g = this.groups[e.group];
        if (!g) continue;
        if (e.spawn) {
          // (its spawn's place wasn't valid: none made — their slots freed, their records gone, the group let go and
          // its failure sticking: an order held for it, or sent later, fails the same. Only the spawn's own failure: the
          // stand order's place failing later, after they were made, removes nobody)
          if (e.serial !== g.spawnSerial) continue;
          const why = WHY[e.status] ?? 'none';
          for (const id of g.members) this.remove(id);
          g.members.clear();
          g.held = null;
          this.failedGroups.set(g.id, why);
          this.freeGroup(e.group);
          for (const f of this.orderFailed) f(g.id, why);
          continue;
        } else if (e.serial !== g.serial || g.serial === g.spawnSerial) continue;
        for (const f of this.orderFailed) f(g.id, WHY[e.status] ?? 'none');
      } else if (e.type === 'hurt') {
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u) continue;
        const by = typeof e.hit === 'number' ? this.byOf(e.hit) : null;
        // (round 128p: its health followed by its hurts — an unobserved unit's record isn't read)
        u.v.health = Math.max(0, u.v.health - e.damage / HPK);
        for (const f of this.hurt) f(this.view(u), e.damage / HPK, by);
        // (struck by a unit, it turns on it on the GPU — DA-B32, units.wgsl; its noticed event tells us)
      } else if (e.type === 'death') {
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u) continue;
        u.v.alive = false;
        u.v.state = 'dead';
        u.v.health = 0;
        // (round 128p: where it fell, from its death event)
        u.v.at = [e.x, e.y, e.z];
        this.byGpu.delete(e.id);
        this.fallen.set(e.id, u.v.id);
        if (u.v.job.kind === 'work') this.routine?.drop(u);
        this.releaseGoal(u);
        const by = typeof e.by === 'number' ? this.byOf(e.by) : null;
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
        // (round 128p: a unit took a target, or let one go (0), on the GPU — whom each is after followed by these, not
        // read from every unit; the game's `noticed` told of a hostile's new one)
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u) continue;
        const t = this.targetOf(e.target);
        u.target = t;
        if (t !== null && u.v.hostile) for (const f of this.noticed) f(this.view(u), t);
      } else if (e.type === 'side') {
        // (round 128p: its side of the wall, told when it changes)
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (u) u.side = e.side;
      } else if (e.type === 'decayed') this.fallen.delete(e.id);
      else if (e.type === 'arrived') {
        const id = this.byGpu.get(e.id);
        const u = id !== undefined ? this.recs.get(id) : undefined;
        if (!u || !u.v.alive) continue;
        // (round 128p, DA-B22 (c)(4): at its goal — a post, a place, a patrol's point: its job stands it there)
        const gi = e.field !== undefined ? e.field - F.goal0 : -1;
        if (gi >= 0 && gi < GOALS) {
          if (u.goal !== null && this.goals[gi]?.key === u.goal) {
            u.arrived = u.goal;
          }
          continue;
        }
        // (round 128o, DA-A6) a working unit's arrival: its routine's
        if (u.v.job.kind !== 'work' || !this.routine?.arrived) continue;
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
    // (round 128p, DA-B22 (c)(4): what this layer still does on the CPU reads the few it does it to — a defender's
    // strike (it and its target, till strikes are the GPU's: BACKLOG DA-B32), fleeing, following and attacking by
    // order (it and whom): observed, read from the next sync)
    this.auto.clear();
    for (const u of live) {
      const j = u.v.job;
      // (U2 round 5, DA-B32: a defender and its target aren't read for its strikes — they're the GPU's)
      const t = j.kind === 'follow' || j.kind === 'attack' ? j.target : null;
      if (t !== null || j.kind === 'flee') this.auto.add(u.v.id);
      if (typeof t === 'number') this.auto.add(t);
    }
    // (U2 round 5: order groups — a group whose members are all gone lets its slot, field and seed go)
    this.groups.forEach((g, i) => {
      if (g && ![...g.members].some((id) => this.recs.get(id)?.v.alive)) this.freeGroup(i);
    });
    for (const [g, why] of this.failsNow.splice(0)) for (const f of this.orderFailed) f(g, why);
    // hostiles: hunt what the GPU gave them; else their work, wandering
    let hunting = 0;
    for (const h of hostiles) {
      if (h.v.job.kind === 'attack') {
        if (!this.alive(h.v.job.target)) h.v.job = { kind: 'idle' };
      }
      if (h.target !== null && !this.alive(h.target)) h.target = null;
      // (U2 round 5: an ordered one walks its order, chasing what it sees on the GPU)
      if (h.order !== undefined) continue;
      if (h.target !== null) {
        this.releaseGoal(h);
        this.regroup(h, G.hunt);
        hunting++;
      } else if (h.v.job.kind === 'work' && this.routine?.takes(h)) this.routine.step(h, dt);
      else if (h.group === G.hunt) this.assign(h);
      else if (h.group === G.stand || h.group === G.wander || (h.group >= G.goal0 && h.group < G.goal0 + GOALS)) this.assign(h);
    }
    this.stats.hunting = hunting;
    // the hunted: the nearest TARGETS to their hunters — the actors hunted first, then the units the GPU ranked
    // (the hunters' targets and whoever they may fight within their sight, nearest first: notice.wgsl huntTop) with
    // where they stood as it ranked them, read in the sync — no unit's position read for it
    const hunters = hostiles.filter((h) => h.target !== null);
    const chosen: (UnitId | string)[] = [];
    const targets: Target[] = [];
    if (hunters.length) {
      for (const t of new Set(hunters.flatMap((h) => (h.target === null ? [] : [h.target])))) {
        if (typeof t !== 'string' || chosen.length >= TARGETS) continue;
        const p = this.posOf(t);
        if (!p) continue;
        chosen.push(t);
        targets.push({ x: p[0], y: p[1], z: p[2], radius: 0.4, height: 1.1 });
      }
      for (const c of this.hunt) {
        const id = this.byGpu.get(c.id);
        if (id === undefined || chosen.length >= TARGETS) continue;
        chosen.push(id);
        targets.push({ x: c.x, y: c.y, z: c.z, radius: 0.4, height: 1.1 });
      }
    }
    this.targetsPrev = this.targetsNow;
    this.targetsNow = chosen;
    if (this.huntGpu) {
      // (U2: the units' targets are the GPU's seeds; the actors' — the CPU's positions — seeded here)
      this.agents.setTargets(targets, -1);
      const acts = chosen.flatMap((c, i) => (typeof c === 'string' ? [targets[i]] : []));
      this.agents.seed(F.targets, hunters.length ? acts : []);
    } else {
      this.agents.setTargets(targets, hunters.length ? F.targets : -1);
      if (!hunters.length) this.agents.seed(F.targets, []);
    }
    // defenders: guards with a hostile in sight, units ordered to attack, anyone struck — their targets the GPU's: they
    // close in on the foes' field (seeded on the GPU from their targets) and strike on the GPU (DA-B32)
    for (const u of live) {
      if (u.v.hostile || u.order !== undefined) continue;
      const j = u.v.job;
      // (an order to attack: given on the GPU until it holds, and kept there while the rules allow)
      if (j.kind === 'attack') {
        if (!this.alive(j.target)) {
          u.v.job = { kind: 'idle' };
          u.target = null;
          this.assign(u);
          continue;
        }
        if (u.target !== j.target) {
          const code = this.codeOf(j.target);
          // (an order: told of it — hunted where it is, seen or not: U2 §9f)
          if (code !== null) this.agents.tell(u.gpu % MAX_SLOT, code);
        }
      }
      if (u.target === null) {
        // (let go — out of its leash, out of reach of the rules — back to its job)
        if (u.group === G.foes || u.group === G.strike) this.assign(u);
        continue;
      }
      if (!this.alive(u.target)) {
        u.target = null;
        this.assign(u);
        continue;
      }
      if (u.group !== G.foes) {
        this.releaseGoal(u);
        this.regroup(u, G.foes);
      }
    }
    // workers and the rest: their jobs
    for (const u of live) {
      if (u.v.hostile || u.target !== null || u.order !== undefined) continue;
      if (u.v.job.kind === 'work' && this.routine?.takes(u)) this.routine.step(u, dt);
      else this.assign(u);
    }
  }
}
