// A settlement in play (round 88; round 89: "quarry and felling trees, hauling and building … farming and houses
// to spawn more agents"): its people as units, near the player only. Each role walks its own round, each leg a
// shared field (jobs are fields: docs/AGENTS.md), so a town of forty costs a few fields, not forty paths:
//  - miners to the quarry: they work the pit's floor (or the adit's forecourt) and carry what they take — the
//    ground itself, taken exactly (terrain.take) — to the stone heap in the yard (terrain.put): the pit deepens,
//    the heap grows;
//  - woodcutters to the trees in reach: they fell one (plants.fell), carry its logs to the log heap;
//  - builders from the heaps to the house being built: what they bring goes into it, and every COST of it a
//    block of the house stands (build/town.ts: walls, floors, a roof, stamped into the columns as they go up);
//    a house finished is a Building with its Instance, and four more people move in (more units, within the
//    budget);
//  - farmers to the fields and back to the granary with a sheaf (grain into the stores);
//  - guards at their posts. Its camp's raiders loaf about their fire until a raid: then they march on the town,
//    workers run home, the guards meet them.
// Out of play the stores go on by their rates (settlements.ts).
import type { Settlement } from '../api/contracts/settlement';
import type { UnitId, V2 } from '../api/contracts/units';
import type { FactionId } from '../api/contracts/world';
import { AgentUnits, F, G, type Routine, type UnitRec } from '../units/agent-units';
import { Town, type TownIO } from '../build/town';
import { LotGrid } from './grids';
import { cellAt } from '../world/lattice';
import type { SiteSpec, Spot } from './plan';

/** the routine's groups (agents groups 8..15; resting at home is the units' standing group) */
export const R = { toFarm: 8, toFell: 9, toQuarry: 10, working: 11, toStore: 12, toPile: 13, toSite: 14, toHome: 15 } as const;
const THERE = 1.9;
/** cells³ a load; what a block of a house takes */
const LOAD = 0.45;
const COST = 1.2;
/** seconds between the field's steps in play */
const GROW_S = 8;

export interface LiveSpot extends Spot {
  /** window coordinates */
  w: V2;
}

/** a house being built, in the window */
export interface LiveSite {
  spec: SiteSpec;
  door: V2;
  poly: V2[];
}

export interface LifeIO {
  units: AgentUnits;
  /** the settlement's spots in window coordinates now */
  spots(): LiveSpot[];
  /** its houses to build, in window coordinates now */
  sites(): LiveSite[];
  /** trees within reach (window coordinates), for the woodcutters */
  trees(at: V2, r: number): V2[];
  fell(at: V2): Promise<number>;
  /** the ground, exactly (world API terrain.take / put) */
  take(at: V2, amount: number): Promise<{ material: string; amount: number }>;
  put(at: V2, material: string, amount: number): Promise<number>;
  /** what a town stamps the window's columns through, and the window's moves (a site's grid is made again) */
  townIO: TownIO;
  dims: { w: number; h: number };
  epoch(): number;
  /** the ground's heights are in (a house is set on them) */
  ready(at: V2): boolean;
  /** goods brought in */
  deliver(good: string, amount: number): void;
  /** a house finished: its record */
  finished(site: SiteSpec): void;
  /** may it mine there (diplomacy's rights) */
  mayMine(at: V2): boolean;
  /** the settlement's field grows a step (as its food allows) and may open a lot to build on */
  grow(): void;
}

export type RaidOutcome = 'repelled' | 'looted';

type Phase = 'home' | 'toWork' | 'working' | 'lifting' | 'toStore' | 'toPile' | 'toSite' | 'toHome' | 'flee';
interface Work {
  phase: Phase;
  t: number;
  where?: V2;
  /** what it carries: a material and how much (ground), or a sheaf (abstract) */
  load?: { material: string; amount: number; real: boolean } | null;
}

const toWorkGroup: Record<string, number> = { farmer: R.toFarm, woodcutter: R.toFell, miner: R.toQuarry, builder: R.toPile };

/** One live settlement (and its camp): who's out, the rounds, the house going up, a raid. */
export class SettlementLife implements Routine {
  readonly ids: UnitId[] = [];
  readonly raiders: UnitId[] = [];
  raid: { t: number; at: V2 } | null = null;
  /** seconds since it came to life; loads moved; blocks built; houses finished */
  t = 0;
  trips = 0;
  blocks = 0;
  houses = 0;
  denied = 0;
  /** ground moved (cells³): out of the quarry, onto the heaps, into houses */
  moved = { quarried: 0, felled: 0, heaped: 0, built: 0 };
  private trees: V2[] = [];
  private treeAt = -1e9;
  private grewAt = 0;
  private seeded = '';
  private site: { town: Town; epoch: number; live: LiveSite; order: { cell: number; level: number }[] } | null = null;
  jobs: { farm: V2[]; fell: V2[]; quarry: V2[] } = { farm: [], fell: [], quarry: [] };
  private homes: V2[] = [];
  private stores: V2[] = [];
  private piles: { what: string; w: V2 }[] = [];
  private pileAt: V2 | null = null;
  private siteDoor: V2 | null = null;

  constructor(
    readonly rec: Settlement,
    readonly camp: Settlement | null,
    private io: LifeIO,
    private budget: number,
    private onRaid: (outcome: RaidOutcome, losses: Record<string, number>) => void,
  ) {
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

  private spawnOne(role: string, i: number, posts: LiveSpot[], at?: V2): void {
    const { units } = this.io;
    const spots = this.io.spots();
    const homes = spots.filter((s) => s.kind === 'home');
    if (role === 'guard' && posts.length) {
      const post = posts[i % posts.length].w;
      this.ids.push(units.spawn('guard', post, this.rec.faction, { settlement: this.rec.id, role: 'guard', health: 5, damage: 1, sight: 16, job: { kind: 'guard', at: post, radius: 1.5 } }));
      return;
    }
    const home = at ?? (homes.length ? homes[(this.ids.length * 7 + i) % homes.length].w : posts[0]?.w ?? spots[0].w);
    const id = units.spawn('villager', home, this.rec.faction, { settlement: this.rec.id, role, health: 3, job: { kind: 'work', at: home, what: role } });
    this.ids.push(id);
    // (they don't all set out at once)
    units.recs.get(id)!.work = { phase: 'home', t: 1 + Math.random() * 8 } satisfies Work;
  }

  takes(u: UnitRec): boolean {
    return u.v.settlement === this.rec.id && u.v.job.kind === 'work';
  }

  drop(u: UnitRec): void {
    this.io.units.carry(u, null);
    u.work = undefined;
  }

  /** send the camp on the town */
  startRaid(): boolean {
    if (this.raid || !this.raiders.length) return false;
    const c = this.io.spots().find((s) => s.kind === 'post' && s.ref?.endsWith(':well'))?.w ?? this.io.spots()[0].w;
    this.raid = { t: 0, at: c };
    this.io.units.order(this.raiders, { kind: 'go', to: c });
    // (everyone home; the guards stay at their posts and meet them there)
    for (const id of this.ids) {
      const u = this.io.units.recs.get(id);
      if (u?.work) (u.work as Work).phase = 'flee';
    }
    return true;
  }

  dispose(): void {
    for (const id of [...this.ids, ...this.raiders]) this.io.units.remove(id);
    if (this.io.units.routine === this) this.io.units.routine = null;
    for (const f of [F.farm, F.fell, F.quarry, F.home, F.store, F.pile, F.site]) this.io.units.agents.seed(f, []);
  }

  /** each frame (after the units' update) */
  update(dt: number): void {
    this.t += dt;
    if (this.t - this.treeAt > 15) {
      this.treeAt = this.t;
      const c = this.io.spots()[0]?.w;
      if (c) this.trees = this.io.trees(c, Math.max(40, this.rec.radius * 0.9)).slice(0, 30);
    }
    // (the settlement grows as a field: every GROW_S while it's fed — new lots become houses to build)
    if (this.t - this.grewAt > GROW_S) {
      this.grewAt = this.t;
      this.io.grow();
    }
    this.siteTown();
    this.reseed();
    if (this.raid) {
      this.raid.t += dt;
      const alive = this.raiders.filter((id) => this.io.units.get(id)?.alive);
      if (!alive.length) this.endRaid('repelled');
      else if (this.raid.t > 70) this.endRaid('looted');
    }
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
    for (const id of this.ids) {
      const u = this.io.units.recs.get(id);
      if (u?.work && (u.work as Work).phase === 'flee') (u.work as Work).phase = 'home';
    }
    this.raid = null;
    this.onRaid(outcome, losses);
  }

  /** the house being built: a town over its lot in the window (made again when the window moves) */
  private siteTown(): void {
    const live = this.io.sites().find((s) => !s.spec.finished);
    if (!live) {
      this.site = null;
      return;
    }
    if (this.site && this.site.live.spec === live.spec && this.site.epoch === this.io.epoch()) {
      this.site.live = live;
      return;
    }
    if (!this.io.ready(live.door)) return;
    const { w, h } = this.io.dims;
    const grid = new LotGrid(w, h, { polys: [live.poly], street: [false] }, 0.6);
    const town = new Town(w, h, this.io.townIO, { grid });
    town.wallMat = live.spec.wall;
    town.roofMat = live.spec.roof;
    const lot = grid.lots[0];
    const order: { cell: number; level: number }[] = [];
    if (lot) for (let L = 0; L < live.spec.storeys; L++) for (const c of lot.inner) order.push({ cell: c, level: L });
    // each cell's floor: set once on the ground as it was before anything stood (kept relative to the ground at
    // the door, which stays open), so a grid made again after the window moves puts the house where it was
    const [dx, dy] = cellAt(live.door[0], live.door[1]);
    const doorZ = this.io.townIO.ground(dy * w + dx);
    const spec = live.spec;
    if (!spec.floors && lot) {
      for (const c of lot.inner) town.plan(c, 0, true);
      spec.floors = lot.inner.map((c) => town.base[c] - doorZ);
      for (const c of lot.inner) town.plan(c, 0, false);
    }
    if (lot && spec.floors) lot.inner.forEach((c, k) => (town.base[c] = doorZ + spec.floors![k]));
    // (what's already up, put back: the same matter stamped again)
    const done = spec.done ?? 0;
    if (done) town.set(order.slice(0, done), true);
    this.site = { town, epoch: this.io.epoch(), live, order };
  }

  /** a builder's load into the house: a block every COST */
  private build(amount: number): void {
    const s = this.site;
    if (!s) return;
    const spec = s.live.spec;
    spec.progress = (spec.progress ?? 0) + amount;
    this.moved.built += amount;
    // (a block's floor is set on the ground's heights: none while they're being read again)
    while (spec.progress >= COST && (spec.done ?? 0) < s.order.length && this.io.ready(s.live.door)) {
      spec.progress -= COST;
      const b = s.order[spec.done ?? 0];
      s.town.add(b.cell, b.level);
      spec.done = (spec.done ?? 0) + 1;
      this.blocks++;
    }
    if ((spec.done ?? 0) >= s.order.length && s.order.length) {
      this.houses++;
      this.io.finished(spec);
      // four more people move in (as many as the budget lets out; the rest are counted)
      const door = s.live.door;
      for (const role of ['builder', 'miner', 'woodcutter', 'farmer']) {
        const p = this.rec.people.find((x) => x.role === role);
        if (p) p.count++;
        else this.rec.people.push({ role, count: 1 });
        if (this.ids.filter((id) => this.io.units.get(id)?.alive).length < this.budget) this.spawnOne(role, 0, [], door);
      }
      this.site = null;
    }
  }

  /** the jobs', homes', stores', heaps' and site's seeds (only when they change) */
  private reseed(): void {
    // (nobody out: nothing seeded, so the agents' pass stays idle)
    if (!this.ids.length) return;
    const spots = this.io.spots();
    const farm = spots.filter((s) => s.kind === 'farm').slice(0, 6).map((s) => s.w);
    const mines = spots.filter((s) => s.kind === 'mine');
    const quarry = mines.filter((m) => this.io.mayMine(m.w)).map((m) => m.w);
    this.denied = mines.length - quarry.length;
    const fell = this.trees.slice(0, 10);
    const homes = spots.filter((s) => s.kind === 'home').slice(0, 8).map((s) => s.w);
    const stores = spots.filter((s) => s.kind === 'store').slice(0, 3).map((s) => s.w);
    this.piles = spots.filter((s) => s.kind === 'pile').map((s) => ({ what: s.what ?? 'stone', w: s.w }));
    const pa = this.piles.length ? ([this.piles.reduce((a, p) => a + p.w[0], 0) / this.piles.length, this.piles.reduce((a, p) => a + p.w[1], 0) / this.piles.length] as V2) : null;
    const site = this.site?.live.door ?? null;
    const r = (v: V2[]) => v.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    const key = JSON.stringify([r(farm), r(quarry), r(fell), r(homes), r(stores), pa && r([pa]), site && r([site])]);
    if (key === this.seeded) return;
    this.seeded = key;
    this.jobs = { farm, fell, quarry };
    this.homes = homes;
    this.stores = stores;
    this.pileAt = pa;
    this.siteDoor = site;
    const A = this.io.units.agents;
    const seed = (f: number, v: V2[]) => A.seed(f, v.map(([x, y]) => ({ x, y })));
    seed(F.farm, farm);
    seed(F.fell, fell);
    seed(F.quarry, quarry);
    seed(F.home, homes);
    seed(F.store, stores);
    seed(F.pile, pa ? [pa] : []);
    seed(F.site, site ? [site] : []);
  }

  private near(list: V2[], at: V2): [V2 | null, number] {
    let best: V2 | null = null;
    let bd = Infinity;
    for (const s of list) {
      const d = Math.hypot(s[0] - at[0], s[1] - at[1]);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return [best, bd];
  }

  step(u: UnitRec, dt: number): void {
    const w = (u.work ??= { phase: 'home', t: 3 } satisfies Work) as Work;
    const at: V2 = [u.v.at[0], u.v.at[1]];
    const U = this.io.units;
    const role = u.v.role;
    const go = (g: number) => {
      U.regroup(u, g);
      u.v.state = 'walk';
    };
    switch (w.phase) {
      case 'home':
        U.regroup(u, G.stand);
        u.v.state = 'idle';
        w.t -= dt;
        if (w.t <= 0) w.phase = 'toWork';
        break;
      case 'toWork': {
        if (role === 'builder') {
          // (nothing to build: they rest)
          if (!this.site || !this.pileAt) return void Object.assign(w, { phase: 'home', t: 8 });
          go(R.toPile);
          if (Math.hypot(this.pileAt[0] - at[0], this.pileAt[1] - at[1]) < THERE + 0.6) {
            w.phase = 'lifting';
            void this.fetch(u, w);
          }
          break;
        }
        const list = role === 'farmer' ? this.jobs.farm : role === 'woodcutter' ? this.jobs.fell : this.jobs.quarry;
        if (!list.length) return void Object.assign(w, { phase: 'home', t: 10 });
        go(toWorkGroup[role] ?? R.toFarm);
        const [s, d] = this.near(list, at);
        if (s && d < THERE) {
          w.phase = 'working';
          w.where = s;
          w.t = (role === 'woodcutter' ? 7 : role === 'miner' ? 5 : 5) * (0.7 + Math.random() * 0.6);
        }
        break;
      }
      case 'working':
        U.regroup(u, R.working);
        u.v.state = 'swing';
        w.t -= dt;
        if (w.t <= 0) {
          w.phase = 'lifting';
          void this.yieldOf(u, w, role);
        }
        break;
      case 'lifting':
        // (waiting on the ground's answer: a frame or two)
        U.regroup(u, R.working);
        break;
      case 'toStore':
      case 'toPile':
      case 'toSite': {
        const g = w.phase === 'toStore' ? R.toStore : w.phase === 'toPile' ? R.toPile : R.toSite;
        go(g);
        const goal = w.phase === 'toStore' ? this.near(this.stores, at) : w.phase === 'toPile' ? [this.pileAt, this.pileAt ? Math.hypot(this.pileAt[0] - at[0], this.pileAt[1] - at[1]) : Infinity] : [this.siteDoor, this.siteDoor ? Math.hypot(this.siteDoor[0] - at[0], this.siteDoor[1] - at[1]) : Infinity];
        if (!goal[0]) return void Object.assign(w, { phase: 'toHome' });
        if ((goal[1] as number) < THERE + 0.6) {
          w.phase = 'lifting';
          void this.unloadAt(u, w);
        }
        break;
      }
      case 'toHome':
      case 'flee': {
        go(R.toHome);
        const [, d] = this.near(this.homes, at);
        if (d < THERE || !this.homes.length) {
          if (w.phase === 'flee') {
            U.regroup(u, G.stand);
            u.v.state = 'idle';
            break;
          }
          w.phase = 'home';
          w.t = 4 + Math.random() * 8;
        }
        break;
      }
    }
  }

  /** what a job gives: ground off the quarry, logs off a tree, a sheaf off the field */
  private async yieldOf(u: UnitRec, w: Work, role: string): Promise<void> {
    const at = w.where ?? [u.v.at[0], u.v.at[1]];
    try {
      if (role === 'miner') {
        // (anywhere on the floor about the spot: the pit deepens evenly)
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * 2.2;
        const got = await this.io.take([at[0] + Math.cos(a) * rr, at[1] + Math.sin(a) * rr], LOAD);
        this.moved.quarried += got.amount;
        if (got.amount > 0.01) this.carry(u, w, { material: got.material, amount: got.amount, real: true }, 'toPile');
        else w.phase = 'toHome';
      } else if (role === 'woodcutter') {
        const logs = await this.io.fell(at);
        this.trees = this.trees.filter((t) => Math.hypot(t[0] - at[0], t[1] - at[1]) > 0.8);
        this.treeAt = Math.min(this.treeAt, this.t - 12);
        if (logs > 0) {
          this.moved.felled += Math.min(logs, 0.8);
          this.carry(u, w, { material: 'log', amount: Math.min(logs, 0.8), real: true }, 'toPile');
        } else w.phase = 'toWork';
      } else {
        this.carry(u, w, { material: 'sand', amount: 0.3, real: false }, 'toStore');
      }
    } finally {
      if (w.phase === 'lifting') w.phase = 'toWork';
    }
  }

  /** a builder takes a load off the higher heap */
  private async fetch(u: UnitRec, w: Work): Promise<void> {
    const heap = this.piles[Math.floor(Math.random() * this.piles.length)];
    if (!heap) return void (w.phase = 'home');
    const got = await this.io.take(heap.w, LOAD);
    if (got.amount > 0.01 && (got.material === 'log' || got.material === 'stone' || got.material === 'rubble' || got.material === 'soil' || got.material === 'sand' || got.material === 'brick')) {
      this.carry(u, w, { material: got.material, amount: got.amount, real: true }, 'toSite');
    } else {
      // (the heaps are bare to the ground — what it took goes back; it waits for the quarry and the woods)
      if (got.amount > 0.01) await this.io.put(heap.w, got.material, got.amount);
      Object.assign(w, { phase: 'home', t: 6 });
    }
  }

  private carry(u: UnitRec, w: Work, load: NonNullable<Work['load']>, then: Phase): void {
    w.load = load;
    this.io.units.carry(u, load.material, Math.max(0.2, Math.min(0.6, load.amount)));
    w.phase = then;
  }

  /** a load set down: on its heap, into the house, into the granary */
  private async unloadAt(u: UnitRec, w: Work): Promise<void> {
    const load = w.load;
    this.io.units.carry(u, null);
    w.load = null;
    this.trips++;
    if (!load) return void (w.phase = 'toWork');
    if (load.real && this.piles.length && (u.v.role === 'miner' || u.v.role === 'woodcutter')) {
      const heap = this.piles.find((p) => (load.material === 'log' ? p.what === 'log' : p.what !== 'log')) ?? this.piles[0];
      // (a little off the heap's middle each time: it grows into a mound, not a post)
      const a = Math.random() * Math.PI * 2;
      const put = await this.io.put([heap.w[0] + Math.cos(a) * 0.6, heap.w[1] + Math.sin(a) * 0.6], load.material, load.amount);
      this.moved.heaped += put;
      this.io.deliver(load.material === 'log' ? 'log' : 'stone', 1);
    } else if (u.v.role === 'builder') {
      this.build(load.amount);
    } else this.io.deliver('grain', 1);
    w.phase = Math.random() < 0.3 ? 'toHome' : 'toWork';
  }
}
