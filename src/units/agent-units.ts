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
import type { Actor, SpawnOpts, UnitId, UnitJob, UnitView, Units, V2, V3 } from '../api/contracts/units';
import type { FactionId } from '../api/contracts/world';
import type { Agents, AgentEvent, AgentState, Target } from '../agents/agents';
import { MAT } from '../world/materials';
import { timed } from '../gpu/cpustat';

/** GPU hit points per contract health point */
const HPK = 3;
/** shared goal fields (agents fields 9..11), their groups (2..4) */
const GOALS = 3;
/** the agents' fields: the settlements' rounds (0-6: life.ts), the hunt's targets, the defenders' foes, goals */
export const F = { farm: 0, fell: 1, quarry: 2, home: 3, store: 4, pile: 5, site: 6, targets: 7, foes: 8, goal0: 9 } as const;
/** groups: striking (standing, at work), standing, goals 2-4, closing on foes, hunting, loafing; 8-15 the rounds */
export const G = { strike: 0, stand: 1, goal0: 2, foes: 5, hunt: 6, wander: 7 } as const;
/** agents' kinds (0 worker, 1 raider, 2 ogre are the defaults the others use) */
const K = { worker: 0, guard: 3, character: 4, raider: 5, shambler: 6 } as const;
const TARGETS = 8;
const REACH = 1.5;
const STRIKE = 1.0;
const LEASH = 28;
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
  /** live units at the last sync, and how long that sync took to come back (ms) */
  stats = { units: 0, hunting: 0, syncMs: 0, syncs: 0 };

  constructor(readonly agents: Agents) {
    agents.defineKind(K.guard, { name: 'guard', height: 1.45, mass: 1.2, hp: 10, speed: 2.7, colours: { torso: MAT.Steel, head: MAT.Steel } });
    agents.defineKind(K.character, { name: 'character', height: 1.4, mass: 1, hp: 10, speed: 2.5, colours: { torso: MAT.Brick, legs: MAT.Wood } });
    agents.defineKind(K.raider, { name: 'raider', height: 1.45, mass: 1, hp: 10, speed: 3.1, reach: 1.35, damage: 1, swingPeriod: 1.1, notice: 160, colours: { torso: MAT.Brick, legs: MAT.Basalt, head: MAT.Basalt } });
    agents.defineKind(K.shambler, { name: 'shambler', height: 1.4, mass: 1, hp: 10, speed: 1.5, reach: 1.1, damage: 1, swingPeriod: 1.6, notice: 50, colours: { torso: MAT.Bone, legs: MAT.Ash, head: MAT.Bone } });
    // (round 88: people a third of a storey tall, in a yellow tunic — at the phone's half resolution a 1-cell figure
    // in canvas was lost against plaster and grass)
    agents.defineKind(K.worker, { name: 'worker', height: 1.4, mass: 1, hp: 10, speed: 2.4, colours: { torso: MAT.Flower, legs: MAT.Wood, head: MAT.Sand } });
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
      this.release(u);
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

  remove(id: UnitId): void {
    const u = this.recs.get(id);
    if (!u) return;
    if (u.v.job.kind === 'work') this.routine?.drop(u);
    this.release(u);
    if (u.v.alive) this.agents.remove([u.gpu]);
    this.byGpu.delete(u.gpu);
    this.recs.delete(id);
  }

  watch(actor: Actor): void {
    if (!this.actors.includes(actor)) this.actors.push(actor);
  }

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
  }

  update(dt: number): void {
    if (this.syncing) return;
    const t0 = performance.now();
    this.syncing = this.agents.sync().then(({ units, events }) => {
      const sdt = this.lastSync ? Math.min(0.5, (performance.now() - this.lastSync) / 1000) : dt;
      this.lastSync = performance.now();
      this.stats.syncMs = +(performance.now() - t0).toFixed(1);
      this.stats.syncs++;
      timed('units', () => {
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
      this.release(u);
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

  private release(u: UnitRec): void {
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
      this.release(u);
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
        // (struck by someone: a guard or a worker on guard turns on it)
        if (by !== null && !u.v.hostile && u.target === null && typeof by === 'number' && this.recs.get(by)?.v.hostile) u.target = by;
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
        this.release(u);
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
        this.byGpu.set(e.id, u.v.id);
        for (const f of this.raised) f(this.view(u), e.group);
      } else if (e.type === 'decayed') this.fallen.delete(e.id);
    }
    // (the dead are kept for `query({ dead: true })` a while, then forgotten)
    if (this.recs.size > 600) for (const [id, u] of this.recs) if (!u.v.alive) this.recs.delete(id);
    if (this.fallen.size > 600) for (const [g, id] of this.fallen) if (!this.recs.has(id)) this.fallen.delete(g);
  }

  /** who's hunting whom; who's striking; the jobs' groups */
  private think(dt: number): void {
    // (LW1: the raised are their raiser's — not hunted for here, nor given jobs)
    const live = [...this.recs.values()].filter((u) => u.v.alive && u.bound === undefined);
    const hostiles = live.filter((u) => u.v.hostile);
    const enemiesOf = (u: UnitRec) => (x: UnitRec) => x.v.alive && x.v.hostile !== u.v.hostile && (x.v.faction !== u.v.faction || x.v.hostile);
    const d2 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    // hostiles: notice what's in sight; hunt it; give up out of sight
    let hunting = 0;
    for (const h of hostiles) {
      if (h.v.job.kind === 'attack') {
        if (!this.posOf(h.v.job.target)) h.v.job = { kind: 'idle' };
      }
      if (h.target !== null) {
        const p = this.posOf(h.target);
        if (!p || d2(p, h.v.at) > Math.max(h.sight * 2, LEASH)) h.target = null;
      }
      if (h.target === null) {
        let best: UnitId | string | null = null;
        let bd = h.sight;
        for (const a of this.actors) {
          const p = a.alive() ? a.position() : null;
          if (!p || (a.faction !== null && a.faction === h.v.faction)) continue;
          const d = d2(p, h.v.at);
          if (d < bd) {
            bd = d;
            best = a.id;
          }
        }
        for (const x of live) {
          if (!enemiesOf(h)(x)) continue;
          const d = d2(x.v.at, h.v.at);
          if (d < bd) {
            bd = d;
            best = x.v.id;
          }
        }
        if (best !== null) {
          h.target = best;
          for (const f of this.noticed) f(this.view(h), best);
        }
      }
      if (h.target !== null) {
        this.release(h);
        this.regroup(h, G.hunt);
        hunting++;
      } else if (h.group === G.hunt) this.assign(h);
      else if (h.group === G.stand || h.group === G.wander || (h.group >= G.goal0 && h.group < G.goal0 + GOALS)) this.assign(h);
    }
    this.stats.hunting = hunting;
    // the hunted: the nearest targets of the hunters
    const hunters = hostiles.filter((h) => h.target !== null);
    const cand = new Map<UnitId | string, number>();
    for (const h of hunters) {
      const t = h.target!;
      const p = this.posOf(t);
      if (p) cand.set(t, Math.min(cand.get(t) ?? Infinity, d2(p, h.v.at)));
      // (and whoever else of theirs is about: the hunt goes for the nearest)
      for (const x of live) if (enemiesOf(h)(x) && d2(x.v.at, h.v.at) < h.sight) cand.set(x.v.id, Math.min(cand.get(x.v.id) ?? Infinity, d2(x.v.at, h.v.at)));
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
    // defenders: guards with a hostile in sight, units ordered to attack, anyone struck: close in and strike
    const foes: V2[] = [];
    for (const u of live) {
      if (u.v.hostile) continue;
      const j = u.v.job;
      if (j.kind === 'attack') u.target = j.target;
      if (u.target === null && u.v.role === 'guard') {
        let bd = u.sight;
        for (const h of hostiles) {
          const d = d2(h.v.at, u.v.at);
          if (d < bd) {
            bd = d;
            u.target = h.v.id;
          }
        }
      }
      if (u.target === null) continue;
      const p = this.posOf(u.target);
      const home = j.kind === 'guard' ? j.at : null;
      if (!p || (home && Math.hypot(p[0] - home[0], p[1] - home[1]) > LEASH)) {
        u.target = null;
        if (j.kind === 'attack') u.v.job = { kind: 'idle' };
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
        this.release(u);
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
