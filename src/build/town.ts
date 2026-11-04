// The town (round 65, docs/DECISIONS.md: "a townscraper inspired grid and
// building system"; "you place, it appears"): blocks on the irregular grid
// (towngrid.ts), a cell and a level each. What stands is worked out from the
// blocks, Townscaper's way — the walls, floors, roofs and arches pick
// themselves from the neighbours:
//  * a block is a room LEVEL_H high: a floor, walls on its sides with no
//    block beside it (a window in each long enough, a door on the ground
//    floor), open to the blocks beside it (they're one building);
//  * the top of a stack is roofed: a hip roof rising from its open sides,
//    up toward a taller neighbour's wall, carrying on over a neighbour's
//    roof at its level (one roof over a row);
//  * a block over nothing stands on pillars at its corners, arched between;
//  * a cell's ground floor sits on the highest ground under it (or a
//    neighbour's floor, if that's no lower and less than a level higher, so
//    a building's rooms line up), on a stone foundation down to the ground.
// What stands is real matter (townstamp.wgsl): intervals in the columns.
//
// (round 128d) A cell's blocks are runs of levels (build/runs.ts: [lo, hi) with an owner and a type), built and planned
// kept apart: no level cap (it was a bit a level in a byte, 8). What limits a stamped town's height is the window's z
// ceiling (TownIO.zMax: add and plan refuse a block whose roof would reach it); the fortress isn't stamped (zMax
// Infinity). A level may be empty under a block (a gap): it stands on pillars at its corners, arched between.
import { TownGrid, type CellGrid, type TownGridOpts } from './towngrid';
import { MAT } from '../world/materials';
import { cellAt, cellPos } from '../world/lattice';
import type { ColumnStamp } from '../sim/systems';
import { CellRuns } from './runs';

export const LEVEL_H = 4;
const SLAB = 0.5;
/** a column this near an open side is wall */
const WALL = 1.0;
const ROOF_SLOPE = 0.75;
const ROOF_RISE = 3.5;
const ROOF_T = 0.6;
/** a column this near a corner of a block over nothing is a pillar */
const PILLAR = 1.3;
const ARCH = 1.4;

export interface TownIO {
  /** the top of the ground (open sky's floor) at a column */
  ground(col: number): number;
  stamp(stamps: ColumnStamp[]): void;
  zMax: number;
}

export interface Block {
  cell: number;
  level: number;
}

type Iv = { z0: number; z1: number; mat: number };

export class Town {
  readonly grid: CellGrid;
  /** per cell the blocks that stand: runs of levels (owner, type: the caller's — the fortress's structure and type) */
  readonly built: CellRuns;
  /**
   * per cell the blocks planned: what a building crew builds toward
   * (agents/buildcrew.ts). Placing or taking away a block outright changes
   * the plan with it; `plan` alone changes only the plan.
   */
  readonly plans: CellRuns;
  /** per cell its ground floor (NaN: no blocks, built or planned) */
  readonly base: Float32Array;
  /** per column the top of what the town last put there (0: nothing) */
  private builtTop: Float32Array;
  /** per column the floor its span started at */
  private builtLo: Float32Array;
  wallMat: number = MAT.Plaster;
  roofMat: number = MAT.Tile;

  /** `opts`: Townscaper's grid's, or a grid already made (round 88: the settlements' generators) */
  constructor(readonly w: number, readonly h: number, private io: TownIO, opts: TownGridOpts | { grid: CellGrid } = {}) {
    this.grid = 'grid' in opts ? opts.grid : new TownGrid(w, h, opts);
    this.built = new CellRuns(this.grid.count);
    this.plans = new CellRuns(this.grid.count);
    this.base = new Float32Array(this.grid.count).fill(NaN);
    this.builtTop = new Float32Array(w * h);
    this.builtLo = new Float32Array(w * h);
  }

  has(c: number, level: number): boolean {
    return this.built.has(c, level);
  }

  /** Whether a block is planned at level L of c. */
  planned(c: number, level: number): boolean {
    return this.plans.has(c, level);
  }

  /** Whether level L of c stands or is planned. */
  occupied(c: number, level: number): boolean {
    return this.built.has(c, level) || this.plans.has(c, level);
  }

  /**
   * Plan a block (on) or its taking down (off), leaving what stands as it is; false if it can't be. `owner`, `type`:
   * the caller's (its run's: build/runs.ts).
   */
  plan(c: number, level: number, on: boolean, owner = 0, type = 0): boolean {
    if (c < 0 || c >= this.grid.count || !(level >= 0) || this.planned(c, level) === on) return false;
    if (on) {
      const b = Number.isNaN(this.base[c]) ? this.groundFloor(c) : this.base[c];
      if (!this.fits(b, level)) return false;
      this.base[c] = b;
      this.plans.set(c, level, owner, type);
    } else {
      this.plans.clear(c, level);
      if (!this.plans.any(c) && !this.built.any(c)) this.base[c] = NaN;
    }
    return true;
  }

  /** The difference between the plan and what stands: blocks to add, blocks to take down (each cell bottom up). */
  delta(): (Block & { add: boolean })[] {
    const out: (Block & { add: boolean })[] = [];
    for (let c = 0; c < this.grid.count; c++) {
      if (!this.plans.any(c) && !this.built.any(c)) continue;
      const add = CellRuns.minus(this.plans, this.built, c);
      const down = CellRuns.minus(this.built, this.plans, c);
      let i = 0;
      let j = 0;
      while (i < add.length || j < down.length)
        if (j >= down.length || (i < add.length && add[i] < down[j])) out.push({ cell: c, level: add[i++], add: true });
        else out.push({ cell: c, level: down[j++], add: false });
    }
    return out;
  }

  /** The highest level in c (-1: none). */
  top(c: number): number {
    return this.built.top(c);
  }

  /** The highest level built or planned in c (-1: none). */
  topPlanned(c: number): number {
    return Math.max(this.built.top(c), this.plans.top(c));
  }

  blocks(): Block[] {
    const out: Block[] = [];
    for (let c = 0; c < this.grid.count; c++) for (const l of this.built.each(c)) out.push({ cell: c, level: l });
    return out;
  }

  /** Whether a block at `level` over a ground floor at `b` fits under the window's ceiling (its roof too). */
  private fits(b: number, level: number): boolean {
    return b + (level + 1) * LEVEL_H + ROOF_T + ROOF_RISE <= this.io.zMax - 2;
  }

  /** Where level L of cell c starts (its floor). */
  floorZ(c: number, level: number): number {
    return this.base[c] + level * LEVEL_H;
  }

  /** Add a block; false if it can't go there (off the grid, taken, too high for the window). */
  add(c: number, level: number, owner = 0, type = 0): boolean {
    if (c < 0 || c >= this.grid.count || !(level >= 0) || this.has(c, level)) return false;
    const b = Number.isNaN(this.base[c]) ? this.groundFloor(c) : this.base[c];
    if (!this.fits(b, level)) return false;
    this.base[c] = b;
    this.built.set(c, level, owner, type);
    if (!this.plans.has(c, level)) this.plans.set(c, level, owner, type);
    this.restamp(c);
    return true;
  }

  remove(c: number, level: number): boolean {
    if (!this.has(c, level)) return false;
    this.built.clear(c, level);
    this.plans.clear(c, level);
    this.restamp(c);
    if (!this.built.any(c) && !this.plans.any(c)) this.base[c] = NaN;
    return true;
  }

  /** Several at once (one stamp of the columns they touch). */
  set(blocks: Block[], on: boolean): void {
    const touched = new Set<number>();
    for (const { cell: c, level } of blocks) {
      if (c < 0 || c >= this.grid.count || !(level >= 0)) continue;
      if (on && !this.has(c, level)) {
        if (Number.isNaN(this.base[c])) this.base[c] = this.groundFloor(c);
        this.built.set(c, level);
        if (!this.plans.has(c, level)) this.plans.set(c, level);
        touched.add(c);
      } else if (!on && this.has(c, level)) {
        this.built.clear(c, level);
        this.plans.clear(c, level);
        touched.add(c);
      }
    }
    this.restampCells(touched);
    for (const c of touched) if (!this.built.any(c) && !this.plans.any(c)) this.base[c] = NaN;
  }

  /** A new cell's ground floor: over the highest ground under it; a neighbour's, if that lines up. */
  private groundFloor(c: number): number {
    let g = 0;
    for (const col of this.grid.columns[c]) g = Math.max(g, this.io.ground(col));
    const own = Math.ceil((g + 0.2) * 2) / 2;
    let best = own;
    let bestD = Infinity;
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[c * 4 + e];
      if (n < 0 || Number.isNaN(this.base[n])) continue;
      const d = this.base[n] - own;
      if (d >= 0 && d < LEVEL_H && d < bestD) {
        best = this.base[n];
        bestD = d;
      }
    }
    return best;
  }

  /** Rewrite the columns of c and its neighbours (their walls and roofs depend on it). */
  private restamp(c: number): void {
    this.restampCells(new Set([c]));
  }

  private restampCells(cells: Set<number>): void {
    const all = new Set<number>();
    for (const c of cells) {
      all.add(c);
      for (let e = 0; e < 4; e++) {
        const n = this.grid.nbr[c * 4 + e];
        if (n >= 0) all.add(n);
      }
    }
    const stamps: ColumnStamp[] = [];
    for (const c of all) {
      for (const col of this.grid.columns[c]) {
        const s = this.columnStamp(c, col);
        if (s) stamps.push(s);
      }
    }
    if (stamps.length) this.io.stamp(stamps);
  }

  /** The stamp for column `col` of cell c (null: the town has nothing to do there). */
  private columnStamp(c: number, col: number): ColumnStamp | null {
    const was = this.builtTop[col];
    if (!this.built.any(c)) {
      if (!was) return null;
      // (all gone: clear what the town had there)
      this.builtTop[col] = 0;
      return { col, lo: this.builtLo[col], hi: was, foundation: false, design: [] };
    }
    const design = this.design(c, col);
    const top = design.length ? design[design.length - 1].z1 : this.base[c];
    const lo = was ? Math.min(this.builtLo[col], this.base[c]) : this.base[c];
    const hi = Math.max(top, was);
    this.builtTop[col] = top;
    this.builtLo[col] = this.base[c];
    return { col, lo, hi, foundation: true, design };
  }

  /** What stands in column `col` of cell c, bottom up (from the floor of its ground level). */
  design(c: number, col: number): Iv[] {
    const g = this.grid;
    const [x, y] = cellPos(col % this.w, Math.floor(col / this.w));
    const ivs: Iv[] = [];
    const push = (z0: number, z1: number, mat: number) => {
      if (z1 - z0 > 0.01) ivs.push({ z0, z1, mat });
    };
    const ed: [number, number][] = [0, 1, 2, 3].map((e) => g.edgeDist(c, e, x, y));
    // distance to the nearest corner
    let dc = Infinity;
    for (let k = 0; k < 4; k++) {
      const [cx, cy] = g.corner(c, k);
      dc = Math.min(dc, Math.hypot(x - cx, y - cy));
    }
    const door = this.doorEdge(c);
    for (const L of [...this.built.each(c)]) {
      const z0 = this.floorZ(c, L);
      const z1 = z0 + LEVEL_H;
      // over nothing: pillars at the corners, arches between
      if (L > 0 && !this.has(c, L - 1)) {
        let below = L - 1;
        while (below >= 0 && !this.has(c, below)) below--;
        const zb = below >= 0 ? this.floorZ(c, below) + LEVEL_H : this.base[c];
        if (dc < PILLAR) push(zb, z0, this.wallMat);
        else {
          const dEdge = Math.min(...ed.map(([d]) => d));
          const drop = ARCH * (1 - Math.min(dEdge / 2.5, 1)) ** 2;
          push(z0 - drop, z0, this.wallMat);
        }
      }
      // the open sides at this level: walls
      let wallE = -1;
      let wallD = Infinity;
      for (let e = 0; e < 4; e++) {
        const n = g.nbr[c * 4 + e];
        if (this.has(n, L) && Math.abs(this.floorZ(n, L) - z0) < 0.01) continue;
        if (ed[e][0] < wallD) {
          wallD = ed[e][0];
          wallE = e;
        }
      }
      if (wallE >= 0 && wallD < WALL) {
        // a window (or a door, on the ground floor) in the middle of a side long enough
        const t = ed[wallE][1];
        const [ax, ay] = g.corner(c, wallE);
        const [bx, by] = g.corner(c, wallE + 1);
        const len = Math.hypot(bx - ax, by - ay);
        const half = 0.5 * Math.min(1.8, len * 0.35) / len;
        let o0 = 0;
        let o1 = 0;
        if (len > 3.2 && Math.abs(t - 0.5) < half && dc > 1.2) {
          if (L === 0 && wallE === door) [o0, o1] = [z0 + SLAB, z0 + 2.9];
          else [o0, o1] = [z0 + 1.5, z0 + 2.9];
        }
        if (o1 > o0) {
          push(z0, o0, this.wallMat);
          push(o1, z1, this.wallMat);
        } else push(z0, z1, this.wallMat);
      } else push(z0, z0 + SLAB, this.wallMat);
      // the top of a stack: a roof
      if (!this.has(c, L + 1)) {
        let d = Infinity;
        for (let e = 0; e < 4; e++) {
          const n = g.nbr[c * 4 + e];
          // (a taller neighbour: the roof leans up to its wall; one roofed
          // at this level: the roof carries on over it)
          if (this.has(n, L) && Math.abs(this.floorZ(n, L) - z0) < 0.01) continue;
          d = Math.min(d, ed[e][0]);
        }
        push(z1, z1 + ROOF_T + Math.min(d * ROOF_SLOPE, ROOF_RISE), this.roofMat);
      }
    }
    // (sorted; touching pieces of one material are one)
    ivs.sort((a, b) => a.z0 - b.z0);
    const out: Iv[] = [];
    for (const iv of ivs) {
      const last = out[out.length - 1];
      if (last && iv.z0 < last.z1 - 1e-3) {
        // (an arch hangs into the room under it, a floor into an arch: the higher piece wins its overlap)
        last.z1 = iv.z0;
        if (last.z1 - last.z0 < 0.01) out.pop();
      }
      const prev = out[out.length - 1];
      if (prev && prev.mat === iv.mat && Math.abs(prev.z1 - iv.z0) < 1e-3) prev.z1 = iv.z1;
      else out.push({ ...iv });
    }
    return out;
  }

  /** The side of c's ground floor with its door: the open side whose middle is lowest outside (else the first open one). */
  private doorEdge(c: number): number {
    let best = -1;
    let bz = Infinity;
    const g = this.grid;
    for (let e = 0; e < 4; e++) {
      const n = g.nbr[c * 4 + e];
      if (this.has(n, 0)) continue;
      const [ax, ay] = g.corner(c, e);
      const [bx, by] = g.corner(c, e + 1);
      // (a step out from the middle of the side)
      const [cx, cy] = g.centre(c);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const ox = mx + (mx - cx) * 0.3;
      const oy = my + (my - cy) * 0.3;
      const oc = g.cellAtWorld(ox, oy);
      const col = this.columnAtWorld(ox, oy);
      const z = col >= 0 ? this.io.ground(col) + (this.has(oc, 0) ? 99 : 0) : 99;
      if (z < bz) {
        bz = z;
        best = e;
      }
    }
    return best;
  }

  private columnAtWorld(x: number, y: number): number {
    const [k, r] = cellAt(x, y);
    if (r < 0 || k < 0 || r >= this.h || k >= this.w) return -1;
    return r * this.w + k;
  }

  /**
   * Where a press lands (Townscaper's way): on a roof, a block on top; on a
   * wall, one beside it across that side at its level; on the ground, one on
   * the ground floor. `remove`: the block pressed on. Null: nothing there.
   * `plan`: the planned blocks count as standing (a plan's stacks grow on
   * top of what's planned; its removals are of what's planned or stands).
   */
  pickBlock(col: number, z: number, remove: boolean, plan = false): Block | null {
    const c = this.grid.cellOf[col];
    if (c < 0) return null;
    const has = (n: number, l: number) => n >= 0 && (plan ? this.occupied(n, l) : this.has(n, l));
    const t = plan ? this.topPlanned(c) : this.top(c);
    if (t < 0 || z < this.base[c] - 0.3) return remove ? null : { cell: c, level: 0 };
    const L = Math.max(0, Math.min(t, Math.floor((z - this.base[c]) / LEVEL_H)));
    const onRoof = z >= this.floorZ(c, this.top(c) < 0 ? 0 : this.top(c)) + LEVEL_H - 0.3;
    if (remove) return { cell: c, level: onRoof || plan ? t : L };
    if (onRoof || (plan && !this.built.any(c))) return { cell: c, level: t + 1 };
    // a wall: the side nearest the column
    const [x, y] = cellPos(col % this.w, Math.floor(col / this.w));
    let be = -1;
    let bd = Infinity;
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[c * 4 + e];
      if (n < 0 || has(n, L)) continue;
      const [d] = this.grid.edgeDist(c, e, x, y);
      if (d < bd) {
        bd = d;
        be = e;
      }
    }
    if (be < 0) return { cell: c, level: t + 1 };
    return { cell: this.grid.nbr[c * 4 + be], level: L };
  }
}
