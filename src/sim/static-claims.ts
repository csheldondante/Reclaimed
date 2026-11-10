// Static grids' claims written with the land (round 128j, M128-8 widened; DECISIONS 128j — the user: "Why is the slide
// necessary? If we compute the town and intersect grids can't it load the terrain with the intervals for town already
// stored?" then "Yes. Let's move to paged simulation, sparse 3d chunks, writing claims at load time"; the design
// session: "Static grids at load, moving live").
//
// A town's buildings and the fortress's blocks don't move: each is a *static grid* — a frame (its local column (0, 0)
// somewhere in the window, its z the world's or the window's) and its things (a building, a wall run, a block: one
// External instance each, sim/external.ts) as column spans in that frame. Their spans live on the GPU, a buffer a grid
// (ColumnApply.claimGrids' layout), made again only when the grid's things change. The kernel pass that follows the
// streamer's write of an arriving region (Streamer.onWritten) claims every grid's columns in that region where they're
// free (colapply.wgsl claimGrid) — the land comes in with its town in it: nothing released when a region leaves (its
// claims go with it into the pool and come back with it, the claim again idempotent), nothing claimed again after a
// slide, no waiting for a building to be whole in the window (its columns in the window are claimed, the rest come with
// their land), and nothing mirrored into the CPU's copy of the columns (FT-68: ~5 µs a column on the CPU before).
//
// A change to a grid's things (a storey raised, a block built or erased, a building lost) is a GPU edit too: what changed
// is let go where it lies in the window (the registry's release: the GPU's, colapply.wgsl `release`), the grid's buffer
// is made again and claimed over the window's written land (never over a region still coming in: its place holds the
// land that left until it's frozen).
//
// (citygen M4b) The grids are GPU-owned: a town made by the field generator builds its spans on the GPU (its slot of the
// arena), and the registry sees them through the StaticSet below (gpuOwns, ownedJob, damage) — held by the GPU's orphan
// pass, checked after an edit on the GPU. (Switchover, 2026-11-10: the CPU grids — a thing's spans set from the CPU, its
// StaticInstance in the registry, judged on the CPU — served the old towns and the fortress only, and went with them.)
import type { ColumnApply, GpuColumns, GridClaimJob } from '../game/colapply';
import type { OwnedArenaJob } from './external';
import type { ExternalRegistry, OwnerId, StaticSet } from './external';
import { ROW_H } from '../world/lattice';

/** where a grid lies in the window now: its local column (0, 0) at window column (dx, dy); window z = its z + dz */
export interface GridPlace {
  dx: number;
  dy: number;
  dz: number;
}

export interface StaticClaimsIO {
  device: GPUDevice;
  apply: () => ColumnApply;
  columns: () => GpuColumns;
  registry: () => ExternalRegistry | null;
  dims: { w: number; h: number };
  /** the streamer's region side (columns) */
  R: number;
  /** the regions a slide is bringing in and hasn't written (local corners): their places hold the land that left */
  unwritten: () => [number, number][];
  /** the window's columns held (a warp, a restore under way): edits wait for the land, which brings the claims */
  held: () => boolean;
  /** the hybrid's chunks over claimed columns (window world units): drawn as voxels */
  touched?: (x0: number, y0: number, x1: number, y1: number) => void;
}

/**
 * (citygen M4b) A GPU-owned grid's source: its claim buffer (made on the GPU by its owner — citygen's claim grid, dense:
 * w × h columns, a span each, the span's owner word its key) and what its owner is told: the window rectangles just
 * claimed (`claimed`: e.g. the plants cleared there) and the keys damaged by an edit (`damaged`, owner words; `maxKey`
 * the largest).
 */
export interface OwnedGridSource {
  /** its slot of the arena (StaticClaims.ownedSlot) — its owner writes the grid there */
  slot: OwnedSlot;
  w: number;
  h: number;
  maxKey: number;
  claimed?(rects: [number, number, number, number][], place: GridPlace): void;
  damaged?(keys: number[]): void;
}

/** (M4b) a slot of the GPU-owned grids' arena: its binding (the grid written there) and its index */
export interface OwnedSlot {
  binding: GPUBufferBinding;
  index: number;
}
/** the arena: its table's words at its head (colapply.wgsl ownedSpanOf: a count, then 8 words a grid from word 16),
 *  then OWN_SLOTS slots of OWN_SLOT_BYTES (a city's box — 448 × 448 columns, 8 words each) */
const OWN_HEAD_BYTES = 512;
export const OWN_SLOTS = 4;
export const OWN_SLOT_BYTES = 448 * 448 * 8 * 4;

/** A static grid: its place in the window and its spans' buffer on the GPU (its owner's: OwnedGridSource). */
export class StaticGrid {
  owned!: OwnedGridSource;
  /** its local bounds [x0, y0, x1, y1) (columns) */
  bounds: [number, number, number, number] = [0, 0, 0, 0];
  buf: GPUBufferBinding | null = null;
  nCols = 0;
  constructor(
    readonly name: string,
    readonly owner: OwnerId,
    readonly place: () => GridPlace,
  ) {}
}

export class StaticClaims implements StaticSet {
  private grids: StaticGrid[] = [];
  /** grids whose claims over the window's written land are owed (an edit while the columns were held) */
  private owed = new Set<StaticGrid>();
  readonly stats = { grids: 0, regions: 0, passes: 0, ms: 0, lastMs: 0 };

  constructor(private io: StaticClaimsIO) {}

  /**
   * (citygen M4b) A GPU-owned grid: its spans built on the GPU by its owner (OwnedGridSource), claimed as its land is
   * written like any grid's (claimGrid), held by the orphan pass (ownedJob), checked after an edit (damage). Its
   * columns over the window's written land are claimed now. One at most (the orphan pass reads one).
   */
  gpuGrid(name: string, owner: OwnerId, place: () => GridPlace, src: OwnedGridSource): StaticGrid {
    if (this.arenaUsed[src.slot.index] !== 'taken') throw new Error(`static claims: slot ${src.slot.index} isn't taken`);
    if (src.w * src.h * 32 > OWN_SLOT_BYTES) throw new Error(`static claims: a ${src.w} x ${src.h} grid is past a slot`);
    // (claimed in the order made: a later grid's spans over an earlier's are buried in them)
    const g = new StaticGrid(name, owner, place);
    this.grids.push(g);
    this.stats.grids = this.grids.length;
    this.arenaUsed[src.slot.index] = g;
    g.owned = src;
    g.buf = { ...src.slot.binding, size: src.w * src.h * 32 };
    g.nCols = src.w * src.h;
    g.bounds = [0, 0, src.w, src.h];
    this.claimWritten(g);
    return g;
  }

  private arena: GPUBuffer | null = null;
  private arenaUsed: (StaticGrid | 'taken' | null)[] = new Array(OWN_SLOTS).fill(null);
  /**
   * (M4b) A slot of the GPU-owned grids' arena (made at the first): its owner writes its grid there, then gpuGrid. Null:
   * every slot taken. Its bytes: OWN_SLOT_BYTES.
   */
  ownedSlot(): OwnedSlot | null {
    const k = this.arenaUsed.indexOf(null);
    if (k < 0) return null;
    this.arena ??= this.io.device.createBuffer({ label: 'static claims owned arena', size: OWN_HEAD_BYTES + OWN_SLOTS * OWN_SLOT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.arenaUsed[k] = 'taken';
    return { binding: { buffer: this.arena, offset: OWN_HEAD_BYTES + k * OWN_SLOT_BYTES, size: OWN_SLOT_BYTES }, index: k };
  }
  /** (time-lapse) a GPU-owned grid's spans changed on the GPU (a district risen): claimed again over the window's written
   *  land (claimGrid where free: what grew is taken, nothing let go) */
  reclaim(g: StaticGrid): void {
    this.claimWritten(g);
  }

  /** (M4b) the arena's free slots */
  freeSlots(): number {
    return this.arenaUsed.filter((x) => x === null).length;
  }
  /** (M4b) a slot handed back (its grid removed first, if it had one) */
  freeSlot(s: OwnedSlot): void {
    const g = this.arenaUsed[s.index];
    if (g && g !== 'taken') this.removeOwned(g);
    this.arenaUsed[s.index] = null;
  }

  /** the GPU-owned grids in table order */
  private ownedGrids(): StaticGrid[] {
    return this.grids;
  }
  /** (M4b) the GPU-owned grids as the orphan pass and the damage check read them: the arena and its table now (each
   *  grid's place, size and base; colapply.wgsl ownedSpanOf). Null: none */
  ownedJob(): OwnedArenaJob | null {
    const gs = this.ownedGrids();
    if (!gs.length || !this.arena) return null;
    const t = new Uint32Array(OWN_HEAD_BYTES / 4);
    const ti = new Int32Array(t.buffer);
    const tf = new Float32Array(t.buffer);
    t[0] = gs.length;
    gs.forEach((g, e) => {
      const p = g.place();
      const o = 16 + e * 8;
      ti[o] = p.dx;
      ti[o + 1] = p.dy;
      t[o + 2] = g.owned!.w;
      t[o + 3] = g.owned!.h;
      tf[o + 4] = p.dz;
      t[o + 5] = (g.owned!.slot.binding.offset ?? 0) / 4;
    });
    return { buf: this.arena, table: t };
  }

  /** (M4b) whether window column (x, y) is in a GPU-owned grid's box */
  gpuOwns(x: number, y: number): boolean {
    for (const g of this.grids) {
      const p = g.place();
      if (x >= p.dx && y >= p.dy && x < p.dx + g.owned.w && y < p.dy + g.owned.h) return true;
    }
    return false;
  }

  private damageBusy: Promise<unknown> = Promise.resolve();
  /**
   * (M4b) An edit's boxes (world units, window frame: Integrity's dirty boxes): the GPU-owned grids' claims there checked
   * on the GPU, their owners told the keys damaged (a few words read back, after the edit).
   */
  damage(boxes: [number, number, number, number][]): void {
    const gs = this.ownedGrids();
    gs.forEach((g, e) => {
      if (!g.owned.damaged) return;
      const p = g.place();
      const rects: [number, number, number, number][] = [];
      for (const [x0, y0, x1, y1] of boxes) {
        const r: [number, number, number, number] = [Math.max(Math.floor(x0) - 1, p.dx), Math.max(Math.floor(y0 / ROW_H) - 1, p.dy), Math.min(Math.ceil(x1) + 2, p.dx + g.owned.w), Math.min(Math.ceil(y1 / ROW_H) + 2, p.dy + g.owned.h)];
        if (r[2] > r[0] && r[3] > r[1]) rects.push(r);
      }
      if (!rects.length || this.io.held()) return;
      const job = this.ownedJob()!;
      const src = g.owned;
      this.damageBusy = this.damageBusy
        .then(() => this.io.apply().gridDamage(this.io.columns(), job, e, rects, src.maxKey))
        .then((keys) => keys.length && src.damaged!(keys));
    });
  }

  /**
   * (the streamer's onWritten) Window rectangle [lx, lx + w) × [ly, ly + h) was just written with arriving land: every
   * grid's columns there claimed where free, on the GPU, in the same frame (before anything reads it).
   */
  landWritten(lx: number, ly: number, w: number, h: number): void {
    const t0 = performance.now();
    const reg = this.io.registry();
    if (reg) ++reg.epoch;
    this.stats.regions++;
    const jobs = this.jobsOver(lx, ly, lx + w, ly + h);
    if (jobs.length) {
      this.io.apply().claimGrids(this.io.columns(), jobs, [[lx, ly, lx + w, ly + h]]);
      this.stats.passes += jobs.length;
      this.touchOver(jobs, [[lx, ly, lx + w, ly + h]]);
      for (const j of jobs) j.g.owned.claimed?.([[lx, ly, lx + w, ly + h]], j.g.place());
    }
    this.stats.lastMs = +(performance.now() - t0).toFixed(3);
    this.stats.ms += performance.now() - t0;
  }

  /** each frame: the claims owed by edits made while the window's columns were held */
  frame(): void {
    if (!this.owed.size || this.io.held()) return;
    const gs = [...this.owed];
    this.owed.clear();
    for (const g of gs) this.claimWritten(g);
  }

  // ---- inside ----------------------------------------------------------------------------------------------------

  /** a grid's spans claimed over the window's written land now (an edit) — owed till the columns aren't held */
  private claimWritten(g: StaticGrid): void {
    if (this.io.held()) {
      this.owed.add(g);
      return;
    }
    const { R } = this.io;
    const { w, h } = this.io.dims;
    const p = g.place();
    const [bx0, by0, bx1, by1] = g.bounds;
    const un = this.io.unwritten();
    const rects: [number, number, number, number][] = [];
    for (let ly = 0; ly < h; ly += R)
      for (let lx = 0; lx < w; lx += R) {
        if (lx + R <= bx0 + p.dx || lx >= bx1 + p.dx || ly + R <= by0 + p.dy || ly >= by1 + p.dy) continue;
        if (un.some(([ux, uy]) => ux === lx && uy === ly)) continue;
        rects.push([lx, ly, lx + R, ly + R]);
      }
    const job = this.job(g);
    if (!job || !rects.length) return;
    this.io.apply().claimGrids(this.io.columns(), [job], rects);
    this.stats.passes += rects.length;
    this.touchOver([job], rects);
    g.owned.claimed?.(rects, p);
  }

  /** the grids overlapping a window rectangle, as claim jobs */
  private jobsOver(x0: number, y0: number, x1: number, y1: number): (GridClaimJob & { g: StaticGrid })[] {
    const out: (GridClaimJob & { g: StaticGrid })[] = [];
    for (const g of this.grids) {
      const p = g.place();
      const [bx0, by0, bx1, by1] = g.bounds;
      if (x1 <= bx0 + p.dx || x0 >= bx1 + p.dx || y1 <= by0 + p.dy || y0 >= by1 + p.dy) continue;
      const j = this.job(g);
      if (j) out.push(j);
    }
    return out;
  }

  private job(g: StaticGrid): (GridClaimJob & { g: StaticGrid }) | null {
    if (!g.buf || !g.nCols) return null;
    const p = g.place();
    return { g, buf: g.buf, nCols: g.nCols, gx: p.dx, gy: p.dy, gz: p.dz };
  }

  /** the hybrid's chunks over what was claimed (each grid's bounds within each rectangle) drawn as voxels */
  private touchOver(jobs: { g: StaticGrid; gx: number; gy: number }[], rects: [number, number, number, number][]): void {
    const t = this.io.touched;
    if (!t) return;
    for (const j of jobs) {
      const [bx0, by0, bx1, by1] = j.g.bounds;
      for (const [x0, y0, x1, y1] of rects) {
        const a0 = Math.max(x0, bx0 + j.gx);
        const b0 = Math.max(y0, by0 + j.gy);
        const a1 = Math.min(x1, bx1 + j.gx);
        const b1 = Math.min(y1, by1 + j.gy);
        if (a1 > a0 && b1 > b0) t(a0, b0 * ROW_H, a1, b1 * ROW_H);
      }
    }
  }

  /** (M4b) a GPU-owned grid gone (its town disposed): no longer claimed nor held — its claims left where they lie
   *  become orphans at the next orphan pass (their fallback material) */
  removeOwned(g: StaticGrid): void {
    const k = this.arenaUsed.indexOf(g);
    if (k >= 0) this.arenaUsed[k] = 'taken';
    this.grids = this.grids.filter((x) => x !== g);
    this.owed.delete(g);
    this.stats.grids = this.grids.length;
  }

  dispose(): void {
    this.arena?.destroy();
    this.grids = [];
  }
}
