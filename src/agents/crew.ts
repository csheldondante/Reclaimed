// A work crew (round 63, docs/AGENTS.md "Crews"): workers that dig or fell
// and carry what they get to a pile, over and over. The brain is on the CPU
// (a state per worker, a few lines each update); the walking is the GPU's:
// three groups (to the job, standing at work, to the pile) and two fields
// (the job's sites, the pile), each worker moved between the groups
// (agents.regroup). Everything taken is ground and goes back as ground
// (terrain.take / put; a tree's logs from plants.fell), so a crew's
// totals add up: `stats`.

import type { MaterialName } from '../api/common';
import type { Plants, Tree } from '../api/plants';
import type { Terrain } from '../api/terrain';
import type { Agents, AgentState } from './agents';

export type CrewJob =
  /** dig the ground within `radius` of (x, y) down `depth` cells (default 2) under its mean top at the start */
  | { kind: 'dig'; x: number; y: number; radius: number; depth?: number }
  /** fell the trees within `radius` of (x, y) */
  | { kind: 'fell'; x: number; y: number; radius: number };

export interface CrewDef {
  /** the workers (a worker kind: it follows its group's field) */
  units: readonly number[];
  /** three free groups: to the job, at work (standing), to the pile */
  groups: readonly [number, number, number];
  /** two free fields: the job's sites, the pile */
  fields: readonly [number, number];
  job: CrewJob;
  /** where they put it all: within `radius` (default 1.5) of (x, y) */
  pile: { x: number; y: number; radius?: number };
  /** made at the pile: loads of `from` are put down as `to`, the same amount (soil → brick: fired) */
  make?: { from: readonly MaterialName[]; to: MaterialName };
  /** cells³ a worker digs a trip (default 0.5) */
  load?: number;
  /** seconds at work: digging a load (default 1.2), felling a tree (default 3) */
  digTime?: number;
  fellTime?: number;
}

type Step = 'toJob' | 'work' | 'toPile' | 'drop' | 'busy' | 'idle';

interface Worker {
  step: Step;
  t: number;
  tree?: Tree;
}

/** How near a worker must be: to a tree it fells, to the pile. */
const REACH = 1.6;

export class Crew {
  /** what it has done: dug (by material), trees felled, logs cut, put on the pile (by material, as put) */
  readonly stats = { dug: {} as Record<string, number>, felled: 0, logs: 0, piled: {} as Record<string, number>, trips: 0 };
  /** true once there's nothing left to dig or fell */
  done = false;
  private workers = new Map<number, Worker>();
  private floor: number | null = null;
  private claimed = new Set<string>();
  private seededAt = 0;
  private last = 0;

  constructor(
    private agents: Agents,
    private terrain: Terrain,
    private plants: Plants | undefined,
    readonly def: CrewDef,
  ) {
    if (def.job.kind === 'fell' && !plants) throw new Error('crew: felling needs the plants module');
    const [gJob, gWork, gPile] = def.groups;
    const [fJob, fPile] = def.fields;
    agents.follow(gJob, fJob);
    agents.follow(gWork, -1);
    agents.follow(gPile, fPile);
    agents.seed(fPile, [{ x: def.pile.x, y: def.pile.y }]);
    for (const id of def.units) {
      this.workers.set(id, { step: 'toJob', t: 0 });
      agents.regroup(id, gJob);
    }
  }

  private go(id: number, w: Worker, step: Step, group: number): void {
    w.step = step;
    this.agents.regroup(id, group);
  }

  /** The job's sites now: where the field leads them (dig: ground still above the floor; fell: the trees). */
  private reseed(): void {
    const j = this.def.job;
    const [fJob] = this.def.fields;
    const sites: { x: number; y: number }[] = [];
    if (j.kind === 'dig') {
      if (this.floor === null) return;
      // a ring of points over the area, those still above the floor
      for (let k = 0; k < 24 && sites.length < 12; k++) {
        const r = j.radius * Math.sqrt((k + 0.5) / 24);
        const a = k * 2.39996;
        const x = j.x + Math.cos(a) * r;
        const y = j.y + Math.sin(a) * r;
        if ((this.terrain.heightAt(x, y) ?? -1) > this.floor + 0.05) sites.push({ x, y });
      }
    } else {
      for (const t of this.plants!.treesNear(j.x, j.y, j.radius)) {
        if (sites.length >= 12) break;
        sites.push({ x: t.x, y: t.y });
      }
      for (const w of this.workers.values()) if (w.tree && sites.length < 12) sites.push({ x: w.tree.x, y: w.tree.y });
    }
    if (!sites.length) {
      this.done = true;
      for (const [id, w] of this.workers) if (w.step === 'toJob') this.go(id, w, 'idle', this.def.groups[1]);
      return;
    }
    this.agents.seed(fJob, sites);
  }

  private claim(w: Worker, u: AgentState): void {
    const j = this.def.job;
    if (j.kind !== 'fell' || w.tree) return;
    const t = this.plants!.treesNear(u.x, u.y, j.radius * 2).find((t) => Math.hypot(t.x - j.x, t.y - j.y) <= j.radius && !this.claimed.has(`${t.cx},${t.cy}`));
    if (!t) return;
    w.tree = t;
    this.claimed.add(`${t.cx},${t.cy}`);
  }

  private unclaim(w: Worker): void {
    if (w.tree) this.claimed.delete(`${w.tree.cx},${w.tree.cy}`);
    w.tree = undefined;
  }

  /** Call each frame with the units a sync gave. */
  update(units: readonly AgentState[]): void {
    const now = performance.now();
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.2) : 0;
    this.last = now;
    const j = this.def.job;
    const [gJob, gWork, gPile] = this.def.groups;
    // (the dig's floor: once the mirror has the ground)
    if (j.kind === 'dig' && this.floor === null) {
      let s = 0;
      let n = 0;
      for (let k = 0; k < 16; k++) {
        const a = k * 2.39996;
        const r = j.radius * Math.sqrt((k + 0.5) / 16);
        const z = this.terrain.heightAt(j.x + Math.cos(a) * r, j.y + Math.sin(a) * r);
        if (z !== null) {
          s += z;
          n++;
        }
      }
      if (!n) return;
      this.floor = s / n - (j.depth ?? 2);
    }
    if (now - this.seededAt > 1000) {
      this.seededAt = now;
      this.reseed();
    }
    const pr = this.def.pile.radius ?? 1.5;
    for (const u of units) {
      const w = this.workers.get(u.id);
      if (!w || w.step === 'busy') continue;
      // (knocked about: it shed its load; it gets up and goes back to work)
      if (u.state === 'tumble' || u.state === 'held') {
        if (w.step === 'toPile' || w.step === 'drop') this.go(u.id, w, 'toJob', gJob);
        continue;
      }
      if (w.step === 'idle') {
        if (!this.done) this.go(u.id, w, 'toJob', gJob);
        continue;
      }
      if (w.step === 'toJob') {
        if (j.kind === 'dig') {
          const inside = Math.hypot(u.x - j.x, u.y - j.y) <= j.radius;
          if (inside && (this.terrain.heightAt(u.x, u.y) ?? -1) > (this.floor ?? 0) + 0.05) {
            w.t = this.def.digTime ?? 1.2;
            this.go(u.id, w, 'work', gWork);
          }
        } else {
          this.claim(w, u);
          if (w.tree && Math.hypot(u.x - w.tree.x, u.y - w.tree.y) <= REACH) {
            w.t = this.def.fellTime ?? 3;
            this.go(u.id, w, 'work', gWork);
          }
        }
        continue;
      }
      if (w.step === 'work') {
        w.t -= dt;
        if (w.t > 0) continue;
        w.step = 'busy';
        void this.finishWork(u, w);
        continue;
      }
      if (w.step === 'toPile') {
        if (!this.agents.carrying(u.id)) {
          this.go(u.id, w, 'toJob', gJob);
          continue;
        }
        if (Math.hypot(u.x - this.def.pile.x, u.y - this.def.pile.y) <= pr) {
          w.step = 'busy';
          this.agents.regroup(u.id, gWork);
          void this.drop(u, w);
        }
      }
    }
    void gPile;
  }

  private async finishWork(u: AgentState, w: Worker): Promise<void> {
    const [gJob, , gPile] = this.def.groups;
    const j = this.def.job;
    if (j.kind === 'dig') {
      const room = (this.terrain.heightAt(u.x, u.y) ?? 0) - (this.floor ?? 0);
      const got = room > 0.02 ? await this.agents.pickUp(u.id, Math.min(this.def.load ?? 0.5, room)) : { material: '', amount: 0 };
      if (got.amount > 0) {
        this.stats.dug[got.material] = (this.stats.dug[got.material] ?? 0) + got.amount;
        this.go(u.id, w, 'toPile', gPile);
      } else this.go(u.id, w, 'toJob', gJob);
      return;
    }
    const t = w.tree!;
    const felled = await this.plants!.fell(t.x, t.y);
    this.unclaim(w);
    if (felled && felled.logs > 0) {
      this.stats.felled++;
      this.stats.logs += felled.logs;
      this.agents.carry(u.id, 'log', felled.logs);
      this.go(u.id, w, 'toPile', gPile);
    } else this.go(u.id, w, 'toJob', gJob);
  }

  private async drop(u: AgentState, w: Worker): Promise<void> {
    const [gJob] = this.def.groups;
    const it = this.agents.carrying(u.id);
    const mk = this.def.make;
    let put = 0;
    let as: MaterialName | undefined = it?.material;
    if (it && mk && mk.from.includes(it.material)) {
      // made into `to` at the pile: the same amount
      this.agents.unload(u.id);
      as = mk.to;
      put = await this.terrain.put(u.x, u.y, mk.to, it.amount);
      if (it.amount - put > 1e-6) this.agents.toss(mk.to, it.amount - put, [u.x, u.y, u.z + 1], [0, 0, 0]);
    } else if (it) {
      put = await this.agents.putDown(u.id);
    }
    if (as && put > 0) this.stats.piled[as] = (this.stats.piled[as] ?? 0) + put;
    this.stats.trips++;
    this.go(u.id, w, this.done ? 'idle' : 'toJob', this.done ? this.def.groups[1] : gJob);
  }

  /** Stop: every worker stands where it is (what they carry, they keep). */
  stop(): void {
    this.done = true;
    for (const [id, w] of this.workers) {
      w.step = 'idle';
      this.agents.regroup(id, this.def.groups[1]);
    }
  }
}
