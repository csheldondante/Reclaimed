// A settlement in play (round 88; "quarry and felling trees, hauling and building … farming and houses to spawn more
// agents"): its people as the one crowd (DA-A6, round 128o: town/life.ts TownLife over settle/work.ts SettleWork, the
// fortress's routine — settle/life.ts's SettlementLife is gone), near the player only. This is the wiring to the agents,
// as fortress/crowd.ts is the fortress's: each leg a shared field (jobs are fields: docs/AGENTS.md), so a town of forty
// costs a few fields, not forty paths:
//  - miners to the quarry: they take the ground itself, exactly (terrain.take), and carry it to the stone heap in the
//    yard (terrain.put): the pit deepens, the heap grows;
//  - woodcutters to the trees in reach: they fell one (plants.fell), carry its logs to the log heap;
//  - builders from the heaps to the house being built: what they bring goes into it, a storey of it every few loads
//    (the settlement's view raises it); a house finished, four more people move in (within the budget);
//  - farmers to the fields and back to the granary with a sheaf (grain into the stores);
//  - guards at their posts (their own job, not the crowd's). Its camp's raiders loaf about their fire until a raid: then
//    they march on the town, the people go home and in (TownLife's shelter), the guards meet them.
// Each person keeps its record's trade (TownLife's `trade`: the job board doesn't move a generated town's people). Out
// of play the stores go on by their rates (settlements.ts).
import type { Settlement } from '../api/contracts/settlement';
import type { UnitId, V2 } from '../api/contracts/units';
import type { FactionId } from '../api/contracts/world';
import { F, G, R, type Routine, type UnitRec } from '../units/agent-units';
import { TownLife, type Leg, type LifeEvent, type Order } from '../town/life';
import { routineOf, type LifeIO, type LiveSpot, type RaidOutcome } from './live';
import { LOAD, LUMBER, SettleWork } from './work';

/** seconds between the field's steps in play */
const GROW_S = 8;
/** (round 128o, DA-B6) the woods looked at again once a sim minute, besides after each fell: they grow back by
 *  succession, which tells the CPU nothing (BACKLOG DA-B21: as a GPU event) */
const WOODS_S = 60;
/** a raid lasts this long before the camp makes off with a quarter of the stores (sim s) */
const RAID_S = 70;
/** seconds a miner's take, a woodcutter's felling */
const DIG_S = 5;
const FELL_S = 7;
/** where a leg ends (the agents' arrival radius on its field, and the radius it has left by): as SettlementLife judged
 *  "there" — 1.9 m from a spot, 2.5 from a heap, the granary, the house's door */
const ARRIVE: [number, number, number][] = [
  [F.farm, 1.9, 4],
  [F.fell, 1.9, 4],
  [F.quarry, 1.9, 4],
  [F.home, 1.9, 4],
  [F.store, 2.5, 5],
  [F.pile, 2.5, 5],
  [F.site, 2.5, 5],
];
const FIELD_OF: Record<number, number> = { [R.toFarm]: F.farm, [R.toFell]: F.fell, [R.toQuarry]: F.quarry, [R.toHome]: F.home, [R.toStore]: F.store, [R.toPile]: F.pile, [R.toSite]: F.site };
/** what a load is drawn as */
const LOOK: Record<string, string> = { stone: 'stone', log: 'log', grain: 'sand' };

interface Task {
  kind: 'dig' | 'fell';
  at: V2;
  t: number;
}

export class SettlementCrowd implements Routine {
  /** the settlement's units out: its people and its guards */
  readonly ids: UnitId[] = [];
  readonly raiders: UnitId[] = [];
  raid: { t: number; at: V2 } | null = null;
  readonly work: SettleWork;
  readonly life: TownLife;
  /** seconds since it came to life */
  t = 0;
  /** ground moved (cells³): out of the quarry, felled, onto the heaps */
  moved = { quarried: 0, felled: 0, heaped: 0, built: 0 };
  /** (the debug overlay) the jobs' spots as last seeded */
  jobs: { farm: V2[]; fell: V2[]; quarry: V2[] } = { farm: [], fell: [], quarry: [] };

  private legs = new Map<UnitId, { leg: Leg; group: number }>();
  /** what each carries: its look's good, and the ground itself (a miner's take, a woodcutter's logs) to put on a heap */
  private load = new Map<UnitId, { good: string; ground: { material: string; amount: number } | null }>();
  private ground = new Map<UnitId, { material: string; amount: number }>();
  private tasks = new Map<UnitId, Task>();
  private inbox: LifeEvent[] = [];
  private trees: V2[] = [];
  private treesFor = '';
  private treesAsked = false;
  private grewAt = 0;
  private seeded = '';
  private calling = false;
  /** the places the legs lead to, as last seeded */
  private granary: V2[] = [];
  private heapAt: V2 | null = null;

  constructor(
    readonly rec: Settlement,
    readonly camp: Settlement | null,
    private io: LifeIO,
    budget: number,
    private onRaid: (outcome: RaidOutcome, losses: Record<string, number>) => void,
  ) {
    this.work = new SettleWork({
      rec,
      spots: io.spots,
      sites: io.sites,
      trees: () => this.trees,
      take: io.take,
      raise: io.raise,
      ready: io.ready,
      finished: io.finished,
      mayMine: io.mayMine,
      out: () => this.ids.filter((id) => this.io.units.get(id)?.alive).length,
      budget,
    });
    this.life = new TownLife(this.work);
    const { units } = io;
    units.routine = this;
    const A = units.agents;
    A.follow(R.toFarm, F.farm);
    A.follow(R.toFell, F.fell);
    A.follow(R.toQuarry, F.quarry);
    A.follow(R.working, -1);
    A.workPose(R.working, true);
    A.follow(R.toStore, F.store);
    A.follow(R.toPile, F.pile);
    A.follow(R.toSite, F.site);
    A.follow(R.toHome, F.home);
    // (rides are the fortress's: a settlement's legs walk their fields)
    for (const g of [R.toPile, R.toHome, R.toFarm]) A.ride(g, null);
    for (const [f, r, leave] of ARRIVE) A.arrivals(f, r, leave);
    const spots = io.spots();
    const posts = spots.filter((s) => s.kind === 'post');
    // (the people, by role, within the budget: guards first so a raid has someone to meet it)
    const roles = rec.people.filter((p) => !p.hostile);
    const total = roles.reduce((s, p) => s + p.count, 0);
    const scale = Math.min(1, budget / Math.max(1, total));
    for (const p of [...roles].sort((a, b) => (a.role === 'guard' ? -1 : b.role === 'guard' ? 1 : 0))) {
      const n = budget <= 0 ? 0 : Math.max(1, Math.round(p.count * scale));
      for (let i = 0; i < n; i++) this.spawnOne(p.role, i, posts);
    }
    if (camp && budget > 0) {
      const at = spots.find((s) => s.kind === 'camp')?.w;
      const n = camp.people.find((p) => p.hostile)?.count ?? 0;
      if (at)
        for (let i = 0; i < Math.min(n, Math.max(3, Math.round(budget / 4))); i++)
          this.raiders.push(units.spawn('raider', [at[0] + Math.cos(i * 2.4) * 3, at[1] + Math.sin(i * 2.4) * 3], camp.faction as FactionId, { settlement: camp.id, role: 'raider', hostile: true, health: 3, damage: 1, sight: 9, job: { kind: 'guard', at, radius: 7 } }));
    }
    this.reseed();
  }

  /** one of the town's people stood up: a guard at its post, or a worker of its trade at home (or `at`: a new house) */
  private spawnOne(role: string, i: number, posts: LiveSpot[], at?: V2): UnitId {
    const { units } = this.io;
    const spots = this.io.spots();
    const homes = spots.filter((s) => s.kind === 'home');
    if (role === 'guard' && posts.length) {
      const post = posts[i % posts.length].w;
      const id = units.spawn('guard', post, this.rec.faction, { settlement: this.rec.id, role: 'guard', health: 5, damage: 1, sight: 16, job: { kind: 'guard', at: post, radius: 1.5 } });
      this.ids.push(id);
      return id;
    }
    const home = at ?? (homes.length ? homes[(this.ids.length * 7 + i) % homes.length].w : (posts[0]?.w ?? spots[0].w));
    const id = units.spawn('villager', home, this.rec.faction, { settlement: this.rec.id, role, health: 3, job: { kind: 'work', at: home, what: role } });
    this.ids.push(id);
    if (!at) this.life.add(id, routineOf(role));
    return id;
  }

  // ---- the agents' side (Routine) ---------------------------------------------------------------------------------

  takes(u: UnitRec): boolean {
    return u.v.settlement === this.rec.id && u.v.job.kind === 'work';
  }

  /** the crowd moves on orders, not steps */
  step(): void {}

  drop(u: UnitRec): void {
    const id = u.v.id;
    this.legs.delete(id);
    this.load.delete(id);
    this.ground.delete(id);
    this.tasks.delete(id);
    this.io.units.carry(u, null);
    if (!u.v.alive || !this.io.units.recs.has(id)) this.inbox.push({ type: 'death', unit: id });
    else this.life.away(id);
  }

  arrived(u: UnitRec, e: { field?: number; ride?: number; at: [number, number, number] }): void {
    const leg = this.legs.get(u.v.id);
    if (!leg || e.field === undefined || e.field !== FIELD_OF[leg.group]) return;
    this.inbox.push({ type: 'arrived', unit: u.v.id, leg: leg.leg, at: [e.at[0], e.at[1]] });
  }

  lost(count: number): void {
    this.inbox.push({ type: 'lost', count });
  }

  // ---- a raid -------------------------------------------------------------------------------------------------------

  /** send the camp on the town: the people go home and in, the guards meet them at their posts */
  startRaid(): boolean {
    if (this.raid || !this.raiders.length) return false;
    const c = this.io.spots().find((s) => s.kind === 'post' && s.ref?.endsWith(':well'))?.w ?? this.io.spots()[0].w;
    this.raid = { t: 0, at: c };
    this.io.units.order(this.raiders, { kind: 'go', to: c });
    this.inbox.push({ type: 'shelter', on: true });
    return true;
  }

  private endRaid(outcome: RaidOutcome): void {
    const losses: Record<string, number> = {};
    if (outcome === 'looted')
      for (const [k, s] of Object.entries(this.rec.stores)) {
        const took = Math.round(s.stock * 0.25);
        s.stock -= took;
        if (took) losses[k] = took;
      }
    const camp = this.io.spots().find((s) => s.kind === 'camp')?.w;
    if (camp) this.io.units.order(this.raiders.filter((id) => this.io.units.get(id)?.alive), { kind: 'guard', at: camp, radius: 7 });
    this.inbox.push({ type: 'shelter', on: false });
    this.raid = null;
    this.onRaid(outcome, losses);
  }

  dispose(): void {
    for (const id of [...this.ids, ...this.raiders]) this.io.units.remove(id);
    if (this.io.units.routine === this) this.io.units.routine = null;
    const A = this.io.units.agents;
    for (const f of [F.farm, F.fell, F.quarry, F.home, F.store, F.pile, F.site]) A.seed(f, []);
    for (const [f] of ARRIVE) A.arrivals(f, 0);
  }

  // ---- each frame -------------------------------------------------------------------------------------------------

  /** each frame (sim seconds, after the units' update): the woods, the town's growth, what happened, the orders */
  update(dt: number): void {
    this.t += dt;
    // (round 128o, DA-B6: the trees asked of the GPU when the settlement's first spot moves, a tree is felled, or a
    // minute passes — the woods grow back; null, the window moved meanwhile: asked again)
    const c = this.io.spots()[0]?.w;
    const key = c ? JSON.stringify([c.map(Math.round), Math.floor(this.t / WOODS_S)]) : '';
    if (c && key !== this.treesFor && !this.treesAsked) {
      this.treesFor = key;
      this.treesAsked = true;
      void this.io.trees(c, Math.max(40, this.rec.radius * 0.9), 30).then((got) => {
        this.treesAsked = false;
        if (got === null) this.treesFor = '';
        else {
          this.trees = got;
          this.work.spotReady(LUMBER);
        }
      });
    }
    // (the settlement grows as a field: every GROW_S while it's fed — new lots become houses to build)
    if (this.t - this.grewAt > GROW_S) {
      this.grewAt = this.t;
      this.io.grow();
    }
    this.runTasks(dt);
    for (const e of this.work.drain()) this.life.on(e);
    for (const e of this.inbox.splice(0)) this.life.on(e);
    for (const o of this.life.tick(dt)) this.apply(o);
    this.newcomer();
    this.reseed();
    if (this.raid) {
      this.raid.t += dt;
      const alive = this.raiders.filter((id) => this.io.units.get(id)?.alive);
      if (!alive.length) this.endRaid('repelled');
      else if (this.raid.t > RAID_S) this.endRaid('looted');
    }
  }

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
      this.goLeg(u, o.go);
      if (o.again) U.rearm(u);
      return;
    }
    if ('carry' in o) {
      if (!o.carry) {
        // (set down: delivered — its ground onto its heap)
        this.heapUp(id);
        this.load.delete(id);
        return U.carry(u, null);
      }
      // (a miner's, a woodcutter's: the ground it took, drawn as itself)
      const ground = this.ground.get(id) ?? null;
      this.ground.delete(id);
      this.load.set(id, { good: o.carry, ground });
      return U.carry(u, ground?.material ?? LOOK[o.carry] ?? 'stone', Math.max(0.2, Math.min(0.6, ground?.amount ?? LOAD)));
    }
    if ('dig' in o) return void this.tasks.set(id, { kind: 'dig', at: o.dig, t: DIG_S * (0.7 + Math.random() * 0.6) });
    if ('fell' in o) return void this.tasks.set(id, { kind: 'fell', at: o.fell, t: FELL_S * (0.7 + Math.random() * 0.6) });
    if ('become' in o) throw new Error(`settlement crowd: no soldiers in a settlement (unit ${id})`);
  }

  /** a unit to its leg's field, or standing (at work: the working group's pose) */
  private goLeg(u: UnitRec, leg: Leg | null): void {
    const U = this.io.units;
    const id = u.v.id;
    if (leg === null) {
      this.legs.delete(id);
      const p = this.life.phaseOf(id);
      const pose = p === 'working' || p === 'gather' || p === 'digging' || p === 'felling';
      U.regroup(u, pose ? R.working : G.stand);
      u.v.state = pose ? 'swing' : 'idle';
      return;
    }
    let g: number;
    switch (leg) {
      case 'stores': {
        // (a sheaf, or a meal: the granary; a builder's fetch, a load of ground or logs: the heaps)
        const grain = this.load.get(id)?.good === 'grain' || this.life.phaseOf(id) === 'toEat';
        g = grain ? (this.granary.length ? R.toStore : R.toPile) : this.heapAt ? R.toPile : R.toStore;
        break;
      }
      case 'site':
        g = R.toSite;
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
      default:
        throw new Error(`settlement crowd: no leg "${leg}" in a settlement`);
    }
    U.regroup(u, g);
    u.v.state = 'walk';
    this.legs.set(id, { leg, group: g });
  }

  /** the takes and fellings under way: worked their seconds, the world asked, the answer to the routine */
  private runTasks(dt: number): void {
    for (const [id, k] of [...this.tasks]) {
      if (!this.io.units.get(id)?.alive) {
        this.tasks.delete(id);
        continue;
      }
      k.t -= dt;
      if (k.t > 0) continue;
      this.tasks.delete(id);
      const at = k.at;
      if (k.kind === 'dig') {
        // (anywhere on the floor about the spot: the pit deepens evenly)
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * 2.2;
        void this.io.take([at[0] + Math.cos(a) * rr, at[1] + Math.sin(a) * rr], LOAD).then((got) => {
          this.moved.quarried += got.amount;
          const ok = got.amount > 0.01;
          if (ok) this.ground.set(id, { material: got.material, amount: got.amount });
          this.inbox.push({ type: 'dug', unit: id, amount: ok ? 1 : 0 });
        });
      } else {
        void this.io.fell(at).then((logs) => {
          this.trees = this.trees.filter((t) => Math.hypot(t[0] - at[0], t[1] - at[1]) > 0.8);
          this.treesFor = '';
          if (logs > 0) {
            this.moved.felled += Math.min(logs, 0.8);
            this.ground.set(id, { material: 'log', amount: Math.min(logs, 0.8) });
          }
          this.inbox.push({ type: 'felled', unit: id, logs: logs > 0 ? 1 : 0 });
        });
      }
    }
  }

  /** a newcomer the routine asked for: one of the trades moving in, out of the house just finished */
  private newcomer(): void {
    if (!this.calling) return;
    this.calling = false;
    const role = this.work.nextComer();
    if (!role) return this.life.turnedAway();
    const homes = this.io.spots().filter((s) => s.kind === 'home');
    const at = this.work.doorWas ?? homes[0]?.w ?? this.io.spots()[0].w;
    const id = this.spawnOne(role, 0, [], at);
    this.life.arrive(id, routineOf(role));
  }

  /** a load of ground set down on its heap (a miner's, a woodcutter's), as it's delivered */
  private heapUp(id: UnitId): void {
    const l = this.load.get(id);
    const heaps = this.work.heaps();
    if (!l?.ground || !heaps.length) return;
    const heap = heaps.find((p) => (l.ground!.material === 'log' ? p.what === 'log' : p.what !== 'log')) ?? heaps[0];
    // (a little off the heap's middle each time: it grows into a mound, not a post)
    const a = Math.random() * Math.PI * 2;
    void this.io.put([heap.w[0] + Math.cos(a) * 0.6, heap.w[1] + Math.sin(a) * 0.6], l.ground.material, l.ground.amount).then((put) => {
      this.moved.heaped += put;
    });
    l.ground = null;
  }

  /** the jobs', homes', stores', heaps' and site's seeds (only when they change) */
  private reseed(): void {
    // (nobody out: nothing seeded, so the agents' pass stays idle)
    if (!this.ids.length) return;
    const spots = this.io.spots();
    const farm = this.work.farms();
    const quarry = this.work.mines();
    const fell = this.trees.slice(0, 10);
    const homes = spots.filter((s) => s.kind === 'home').slice(0, 8).map((s) => s.w);
    const stores = spots.filter((s) => s.kind === 'store').slice(0, 3).map((s) => s.w);
    // (round 128o, B: each heap's foot round it — the reach found the heaps' mounds islands: a mound's top, the ground put
    // on it, is past a walker's step from the ground round it, so a field seeded on top led nobody there)
    const piles = this.work.heaps().flatMap((p) => p.foot);
    const site = this.work.site()?.door ?? null;
    const r = (v: V2[]) => v.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    const key = JSON.stringify([r(farm), r(quarry), r(fell), r(homes), r(stores), r(piles), site && r([site])]);
    if (key === this.seeded) return;
    this.seeded = key;
    this.jobs = { farm, fell, quarry };
    this.granary = stores;
    this.heapAt = piles[0] ?? null;
    const A = this.io.units.agents;
    const seed = (f: number, v: V2[]) => A.seed(f, v.map(([x, y]) => ({ x, y })));
    seed(F.farm, farm);
    seed(F.fell, fell);
    seed(F.quarry, quarry);
    seed(F.home, homes);
    seed(F.store, stores);
    seed(F.pile, piles);
    seed(F.site, site ? [site] : []);
  }

  /** (stats) loads moved, storeys up, houses finished, mines the town may not work */
  get trips(): number {
    return this.work.stats.trips;
  }
  get blocks(): number {
    return this.work.stats.blocks;
  }
  get houses(): number {
    return this.work.stats.houses;
  }
  get denied(): number {
    return this.work.stats.denied;
  }
}
