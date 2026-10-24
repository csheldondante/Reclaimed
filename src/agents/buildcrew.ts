// A building crew (round 65, docs/DECISIONS.md: "a mode where it takes the
// delta of the finished thing you build and the current state then workers
// build it and use resources"): the town's plan (town.ts) against what
// stands gives blocks to build and blocks to take down. Workers fetch a load
// from the pile (bricks, logs, stone: whatever of `materials` lies on top
// there), carry it to a block to build and work it in; when a block has had
// its `cost` it stands (town.add — it appears whole, its walls and roof
// worked out as ever). A block to take down: a worker works at it, it goes,
// and the worker carries `cost` of brick back to the pile. Lowest blocks
// first, nearest the pile first. The walking is the GPU's, as for a Crew:
// three groups (to the pile, at work, to the site) and two fields (the
// pile, the sites).
//
// What a block is worth (`cost`, cells³ of material) is a price, not its
// volume: the town works out the matter a block stands as (often 50+
// cells³ of plaster and tile), and a worker carries `load` a trip.
import type { MaterialName } from '../api/common';
import type { Terrain } from '../api/terrain';
import type { Block, Town } from '../build/town';
import type { Agents, AgentState } from './agents';

export interface BuildCrewDef {
  units: readonly number[];
  /** three free groups: to the pile, at work (standing), to the site */
  groups: readonly [number, number, number];
  /** two free fields: the pile, the sites */
  fields: readonly [number, number];
  town: Town;
  /** where the material is: within `radius` (default 2) of (x, y) */
  pile: { x: number; y: number; radius?: number };
  /** what they build with (default brick, log, stone, sandstone) */
  materials?: readonly MaterialName[];
  /** cells³ a block takes (default 6) */
  cost?: number;
  /** cells³ a worker carries a trip (default 1.5) */
  load?: number;
  /** seconds working a load in, or taking a block down (default 1.5) */
  workTime?: number;
}

type Step = 'toPile' | 'take' | 'toSite' | 'work' | 'home' | 'busy' | 'idle';

interface Worker {
  step: Step;
  t: number;
  /** the block it's carrying to, or taking down */
  job?: Block;
  down?: boolean;
}

/** How near the cell a worker must be to work on its block (cells). */
const REACH = 2;
const SITES = 12;

const key = (b: Block) => b.cell * 8 + b.level;

export class BuildCrew {
  /** what it's done: loads brought (by material), blocks built and taken down, put back on the pile (taken down, or not needed), trips, waits for material at the pile */
  readonly stats = { used: {} as Record<string, number>, built: 0, takenDown: 0, returned: 0, trips: 0, starved: 0 };
  /** per block in the works: material worked in so far */
  readonly progress = new Map<number, number>();
  /** true while the plan and what stands agree */
  done = false;
  private workers = new Map<number, Worker>();
  private seededAt = 0;
  private last = 0;

  constructor(
    private agents: Agents,
    private terrain: Terrain,
    readonly def: BuildCrewDef,
  ) {
    const [gPile, gWork, gSite] = def.groups;
    const [fPile, fSite] = def.fields;
    agents.follow(gPile, fPile);
    agents.follow(gWork, -1);
    agents.follow(gSite, fSite);
    // (round its foot: a pile of solid bricks is a block they can't climb)
    const pr = def.pile.radius ?? 2;
    agents.seed(
      fPile,
      Array.from({ length: 8 }, (_, k) => ({ x: def.pile.x + Math.cos((k * Math.PI) / 4) * (pr + 1), y: def.pile.y + Math.sin((k * Math.PI) / 4) * (pr + 1) })),
    );
    for (const id of def.units) {
      this.workers.set(id, { step: 'toPile', t: 0 });
      agents.regroup(id, gPile);
    }
  }

  private get cost(): number {
    return this.def.cost ?? 6;
  }

  /** What's to do, in order: blocks to build whose level below stands (or the ground), then blocks to take down from the top. */
  todo(): { block: Block; down: boolean }[] {
    const t = this.def.town;
    const [px, py] = [this.def.pile.x, this.def.pile.y];
    const out: { block: Block; down: boolean; d: number }[] = [];
    for (const b of t.delta()) {
      const [cx, cy] = t.grid.centre(b.cell);
      const d = Math.hypot(cx - px, cy - py);
      if (b.add) {
        // (on what stands: the ground, or the block under it; else later)
        if (b.level > 0 && !t.has(b.cell, b.level - 1) && t.planned(b.cell, b.level - 1)) continue;
        out.push({ block: { cell: b.cell, level: b.level }, down: false, d: b.level * 1000 + d });
      } else {
        if (t.has(b.cell, b.level + 1)) continue;
        out.push({ block: { cell: b.cell, level: b.level }, down: true, d: -b.level * 1000 + d });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  private go(id: number, w: Worker, step: Step, group: number): void {
    w.step = step;
    this.agents.regroup(id, group);
  }

  /** Where workers stand to work on block b: just outside the cell's sides open at the ground. */
  private standsFor(b: Block): { x: number; y: number }[] {
    const g = this.def.town.grid;
    const [cx, cy] = g.centre(b.cell);
    const out: { x: number; y: number }[] = [];
    for (let e = 0; e < 4; e++) {
      if (this.def.town.has(g.nbr[b.cell * 4 + e], 0)) continue;
      const [ax, ay] = g.corner(b.cell, e);
      const [bx, by] = g.corner(b.cell, e + 1);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const d = Math.hypot(mx - cx, my - cy) || 1;
      out.push({ x: mx + ((mx - cx) / d) * 1.2, y: my + ((my - cy) / d) * 1.2 });
    }
    return out;
  }

  /** How far (x, y) is from cell c (0 inside). */
  private offCell(c: number, x: number, y: number): number {
    const g = this.def.town.grid;
    if (g.contains(c, x, y)) return 0;
    let d = Infinity;
    for (let e = 0; e < 4; e++) d = Math.min(d, g.edgeDist(c, e, x, y)[0]);
    return d;
  }

  private reseed(): void {
    const sites: { x: number; y: number }[] = [];
    const todo = this.todo();
    for (const { block } of todo) {
      if (sites.length >= SITES) break;
      sites.push(...this.standsFor(block));
    }
    this.done = !todo.length;
    if (sites.length) this.agents.seed(this.def.fields[1], sites.slice(0, 16));
  }

  /** The next block for a worker: the first still to do (several may carry to one). */
  private pick(w: Worker): boolean {
    const next = this.todo()[0];
    if (!next) return false;
    w.job = next.block;
    w.down = next.down;
    return true;
  }

  /** Call each frame with the units a sync gave. */
  update(units: readonly AgentState[]): void {
    const now = performance.now();
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.2) : 0;
    this.last = now;
    const [gPile, gWork, gSite] = this.def.groups;
    if (now - this.seededAt > 1000) {
      this.seededAt = now;
      this.reseed();
    }
    // (at the pile: at its foot)
    const pr = (this.def.pile.radius ?? 2) + 2;
    for (const u of units) {
      const w = this.workers.get(u.id);
      if (!w || w.step === 'busy') continue;
      if (u.state === 'tumble' || u.state === 'held') continue;
      if (w.step === 'idle') {
        // (waiting at an empty pile)
        if (w.t > 0) {
          w.t -= dt;
          continue;
        }
        if (!this.done) this.go(u.id, w, this.agents.carrying(u.id) ? 'toSite' : 'toPile', this.agents.carrying(u.id) ? gSite : gPile);
        continue;
      }
      if (w.step === 'toPile') {
        // (a load still in hand: go and use it)
        if (this.agents.carrying(u.id)) {
          // (nothing to use it on: back on the pile)
          if (this.pick(w)) this.go(u.id, w, 'toSite', gSite);
          else this.go(u.id, w, 'home', gPile);
          continue;
        }
        if (Math.hypot(u.x - this.def.pile.x, u.y - this.def.pile.y) <= pr) {
          // nothing to build: stand by the pile; something to take down: go empty-handed
          if (!this.pick(w)) {
            this.go(u.id, w, 'idle', gWork);
            continue;
          }
          if (w.down) {
            this.go(u.id, w, 'toSite', gSite);
            continue;
          }
          w.step = 'busy';
          this.agents.regroup(u.id, gWork);
          void this.take(u, w);
        }
        continue;
      }
      if (w.step === 'toSite') {
        const b = w.job;
        if (!b) {
          this.go(u.id, w, 'toPile', gPile);
          continue;
        }
        // (the field leads to the nearest of all the sites: work on whichever
        // block of the kind it's after it came to)
        if (this.offCell(b.cell, u.x, u.y) > REACH) {
          const near = this.todo().find((d) => d.down === !!w.down && this.offCell(d.block.cell, u.x, u.y) <= REACH);
          if (near) w.job = near.block;
        }
        if (this.offCell(w.job!.cell, u.x, u.y) <= REACH) {
          w.t = this.def.workTime ?? 1.5;
          this.go(u.id, w, 'work', gWork);
        }
        continue;
      }
      if (w.step === 'work') {
        w.t -= dt;
        if (w.t > 0) continue;
        this.finish(u, w);
        continue;
      }
      if (w.step === 'home' && Math.hypot(u.x - this.def.pile.x, u.y - this.def.pile.y) <= pr) {
        w.step = 'busy';
        this.agents.regroup(u.id, gWork);
        void this.agents.putDown(u.id).then((put) => {
          this.stats.returned += put;
          this.stats.trips++;
          this.go(u.id, w, 'toPile', gPile);
        });
      }
    }
  }

  /** At the pile: take a load of building material off its top (the highest spot); none there, wait. */
  private async take(u: AgentState, w: Worker): Promise<void> {
    const [gPile, gWork, gSite] = this.def.groups;
    const p = this.def.pile;
    const r = p.radius ?? 2;
    let best: [number, number] = [p.x, p.y];
    let bz = -Infinity;
    // (every column of the pile: a spiral about a cell apart)
    const n = Math.ceil((Math.PI * r * r) / 0.6);
    for (let k = 0; k < n; k++) {
      const a = k * 2.39996;
      const rr = r * Math.sqrt((k + 0.5) / n);
      const x = p.x + Math.cos(a) * rr;
      const y = p.y + Math.sin(a) * rr;
      const z = this.terrain.heightAt(x, y) ?? -Infinity;
      if (z > bz && this.usable(this.terrain.materialAt(x, y))) [bz, best] = [z, [x, y]];
    }
    const got = bz > -Infinity ? await this.terrain.take(best[0], best[1], this.def.load ?? 1.5) : { material: '' as MaterialName, amount: 0 };
    if (got.amount > 0 && !this.usable(got.material)) {
      await this.terrain.put(best[0], best[1], got.material, got.amount);
      got.amount = 0;
    }
    if (got.amount <= 0) {
      this.stats.starved++;
      w.t = 2;
      this.go(u.id, w, 'idle', gWork);
      return;
    }
    this.agents.carry(u.id, got.material, got.amount);
    if (this.pick(w)) this.go(u.id, w, 'toSite', gSite);
    else this.go(u.id, w, 'toPile', gPile);
  }

  private usable(m: MaterialName | null): boolean {
    return !!m && (this.def.materials ?? ['brick', 'log', 'stone', 'sandstone']).includes(m);
  }

  private finish(u: AgentState, w: Worker): void {
    const [gPile, , gSite] = this.def.groups;
    const t = this.def.town;
    const b = w.job!;
    w.job = undefined;
    if (w.down) {
      // (still to take down: it goes, and its worth goes back to the pile)
      if (t.has(b.cell, b.level) && !t.planned(b.cell, b.level) && !t.has(b.cell, b.level + 1)) {
        t.remove(b.cell, b.level);
        this.stats.takenDown++;
        this.agents.carry(u.id, 'brick', this.cost);
        this.go(u.id, w, 'home', gPile);
      } else this.go(u.id, w, 'toPile', gPile);
      return;
    }
    const it = this.agents.carrying(u.id);
    // (the plan changed under it, or built already: take the load to the next block)
    if (!it || t.has(b.cell, b.level) || !t.planned(b.cell, b.level)) {
      if (it && this.pick(w)) this.go(u.id, w, 'toSite', gSite);
      else this.go(u.id, w, 'toPile', gPile);
      return;
    }
    const k = key(b);
    const need = this.cost - (this.progress.get(k) ?? 0);
    const used = Math.min(it.amount, need);
    this.agents.unload(u.id);
    if (it.amount - used > 1e-6) this.agents.carry(u.id, it.material, it.amount - used);
    this.stats.used[it.material] = (this.stats.used[it.material] ?? 0) + used;
    this.stats.trips++;
    const had = (this.progress.get(k) ?? 0) + used;
    if (had >= this.cost - 1e-6) {
      this.progress.delete(k);
      if (t.add(b.cell, b.level)) this.stats.built++;
    } else this.progress.set(k, had);
    if (this.agents.carrying(u.id) && this.pick(w)) this.go(u.id, w, 'toSite', gSite);
    else this.go(u.id, w, 'toPile', gPile);
  }

  /** Stop: every worker stands where it is. */
  stop(): void {
    this.done = true;
    for (const [id, w] of this.workers) {
      w.step = 'idle';
      this.agents.regroup(id, this.def.groups[1]);
    }
  }
}
