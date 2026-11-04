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
// The registry sees these instances through the StaticSet below: anchored to their grid (a slide moves nothing on the
// CPU but where the grid lies), judged by a read of the columns only where their land was written before the read was
// asked (the region's epoch here, the registry's epoch counter), never orphans.
import type { ColumnApply, GpuColumns, GridClaimJob } from '../game/colapply';
import { freeSpans, type ExternalCol, type ExternalInstance, type ExternalRegistry, type OwnerId, type StaticSet } from './external';
import { ROW_H } from '../world/lattice';
import { readColumn, type Interval, type PackedWorld } from '../world/layout';
import { MAT } from '../world/materials';

/** a thing of a static grid: its key in the grid (a building's index, a structure's id), its spans in the grid's frame */
export interface StaticThing {
  key: number;
  /** column spans: x, y the grid's local columns; z0, z1 in the grid's z (window z = z + place().dz) */
  cols: ExternalCol[];
  /** what its cells become when it's let go (not to air) */
  fallback: number;
}

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
  /** the window's world origin (columns, rows) */
  origin: () => [number, number];
  /** the regions a slide is bringing in and hasn't written (local corners): their places hold the land that left */
  unwritten: () => [number, number][];
  /** the window's columns held (a warp, a restore under way): edits wait for the land, which brings the claims */
  held: () => boolean;
  /** the hybrid's chunks over claimed columns (window world units): drawn as voxels */
  touched?: (x0: number, y0: number, x1: number, y1: number) => void;
  /** an edit's new claims in window box [x0, x1) × [y0, y1) (cells, rows): their chunks touched, not woken (a claim is
   *  quiet: sim/sleep.ts touch — the surface and the mesh look at it again, the ground's systems stay asleep) */
  quiet?: (x0: number, y0: number, x1: number, y1: number) => void;
}

/** the static instances' ids, apart from the registry's own (it counts up from 1) */
const ID_BASE = 1 << 30;

class StaticInstance implements ExternalInstance {
  readonly free = true;
  private at = '';
  private cached: ExternalCol[] = [];
  constructor(
    readonly id: number,
    readonly owner: OwnerId,
    readonly fallback: number,
    readonly key: number,
    readonly sig: string,
    readonly local: ExternalCol[],
    readonly grid: StaticGrid,
    public epoch: number,
  ) {}

  /** its spans in the window's frame now (out of the window too) */
  get cols(): ExternalCol[] {
    const p = this.grid.place();
    const k = `${p.dx},${p.dy},${p.dz}`;
    if (k !== this.at) {
      this.at = k;
      this.cached = this.local.map((c) => ({ x: c.x + p.dx, y: c.y + p.dy, z0: c.z0 + p.dz, z1: c.z1 + p.dz }));
    }
    return this.cached;
  }
}

/** A static grid: its place in the window, its things, its spans' buffer on the GPU. */
export class StaticGrid {
  readonly things = new Map<number, StaticInstance>();
  /** local column key → the instances with a span there, in the grid's order */
  readonly byCol = new Map<number, StaticInstance[]>();
  /** its things' local bounds [x0, y0, x1, y1) (columns) */
  bounds: [number, number, number, number] = [0, 0, 0, 0];
  buf: GPUBuffer | null = null;
  nCols = 0;
  /** the buffer is out of date with `things` */
  stale = true;
  constructor(
    readonly name: string,
    readonly owner: OwnerId,
    readonly place: () => GridPlace,
  ) {}
}

const colKey = (x: number, y: number) => (y + 32768) * 65536 + (x + 32768);

export class StaticClaims implements StaticSet {
  private grids: StaticGrid[] = [];
  private byId = new Map<number, StaticInstance>();
  private nextId = ID_BASE;
  /** world region key → the registry's epoch when its land (and claims) were written */
  private written = new Map<string, number>();
  /** grids whose claims over the window's written land are owed (an edit while the columns were held) */
  private owed = new Set<StaticGrid>();
  readonly stats = { grids: 0, things: 0, columns: 0, regions: 0, passes: 0, edits: 0, ms: 0, lastMs: 0, uploadKB: 0 };

  constructor(private io: StaticClaimsIO) {}

  /** A static grid (claimed in the order made: a later grid's spans over an earlier's are buried in them). */
  grid(name: string, owner: OwnerId, place: () => GridPlace): StaticGrid {
    const g = new StaticGrid(name, owner, place);
    this.grids.push(g);
    this.stats.grids = this.grids.length;
    return g;
  }

  /** a grid gone (a settlement dropped): its things let go where they lie (to air), its buffer freed */
  remove(g: StaticGrid): void {
    this.set(g, []);
    g.buf?.destroy();
    g.buf = null;
    this.grids = this.grids.filter((x) => x !== g);
    this.owed.delete(g);
    this.stats.grids = this.grids.length;
  }

  /**
   * The grid's things are these now: unchanged ones keep their instance; changed and gone ones are let go where they lie
   * in the window (to air: the owner draws what stands there); new ones are claimed over the window's written land.
   * Returns each thing's instance by key.
   */
  set(g: StaticGrid, things: StaticThing[]): Map<number, ExternalInstance> {
    const reg = this.io.registry();
    const want = new Map<number, { t: StaticThing; sig: string }>();
    for (const t of things) {
      const cols = t.cols.filter((c) => c.z1 - c.z0 >= 0.05);
      if (!cols.length) continue;
      want.set(t.key, { t: { ...t, cols }, sig: `${t.fallback}|` + cols.map((c) => `${c.x},${c.y},${c.z0.toFixed(3)},${c.z1.toFixed(3)}`).join(';') });
    }
    let changed = false;
    const fresh: StaticInstance[] = [];
    for (const [key, inst] of [...g.things]) {
      if (want.get(key)?.sig === inst.sig) continue;
      // (the registry's release: let go where it lies in the window — it calls drop, which takes it out of the grid)
      if (reg) reg.release(inst.id, true);
      else this.drop(inst);
      changed = true;
    }
    for (const [key, { t, sig }] of want) {
      if (g.things.has(key)) continue;
      const inst = new StaticInstance(this.nextId++, g.owner, t.fallback, key, sig, t.cols.map((c) => ({ ...c })), g, reg ? ++reg.epoch : 0);
      g.things.set(key, inst);
      this.byId.set(inst.id, inst);
      fresh.push(inst);
      changed = true;
    }
    if (changed) {
      this.index(g);
      g.stale = true;
      this.stats.edits++;
      this.claimWritten(g);
      if (this.io.quiet && !this.io.held())
        for (const inst of fresh) {
          const cs = this.releasable(inst);
          if (!cs.length) continue;
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (const c of cs) {
            x0 = Math.min(x0, c.x);
            y0 = Math.min(y0, c.y);
            x1 = Math.max(x1, c.x + 1);
            y1 = Math.max(y1, c.y + 1);
          }
          this.io.quiet(x0, y0, x1, y1);
        }
    }
    this.count();
    return new Map([...g.things].map(([k, i]) => [k, i]));
  }

  /**
   * (the streamer's onWritten) Window rectangle [lx, lx + w) × [ly, ly + h) was just written with arriving land: every
   * grid's columns there claimed where free, on the GPU, in the same frame (before anything reads it).
   */
  landWritten(lx: number, ly: number, w: number, h: number): void {
    const t0 = performance.now();
    const reg = this.io.registry();
    const e = reg ? ++reg.epoch : 0;
    const { R } = this.io;
    const [ox, oy] = this.io.origin();
    for (let y = ly; y < ly + h; y += R) for (let x = lx; x < lx + w; x += R) this.written.set(this.regionKey(ox + x, oy + y), e);
    this.stats.regions++;
    const jobs = this.jobsOver(lx, ly, lx + w, ly + h);
    if (jobs.length) {
      this.io.apply().claimGrids(this.io.columns(), jobs, [[lx, ly, lx + w, ly + h]]);
      this.stats.passes += jobs.length;
      this.touchOver(jobs, [[lx, ly, lx + w, ly + h]]);
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

  // ---- StaticSet (the registry's view) ----------------------------------------------------------------------------

  instances(): Iterable<ExternalInstance> {
    return this.byId.values();
  }

  get(id: number): ExternalInstance | undefined {
    return this.byId.get(id);
  }

  at(x: number, y: number): ExternalInstance[] {
    let out: ExternalInstance[] | null = null;
    for (const g of this.grids) {
      const p = g.place();
      const l = g.byCol.get(colKey(x - p.dx, y - p.dy));
      if (l) (out ??= []).push(...l);
    }
    return out ?? [];
  }

  judged(x: number, y: number, asOf: number): boolean {
    const { R } = this.io;
    const lx = Math.floor(x / R) * R;
    const ly = Math.floor(y / R) * R;
    if (this.io.unwritten().some(([ux, uy]) => ux === lx && uy === ly)) return false;
    const [ox, oy] = this.io.origin();
    return (this.written.get(this.regionKey(ox + lx, oy + ly)) ?? 0) <= asOf;
  }

  inWindow(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.io.dims.w && y < this.io.dims.h;
  }

  drop(inst: ExternalInstance): void {
    const si = this.byId.get(inst.id);
    if (!si) return;
    this.byId.delete(si.id);
    const g = si.grid;
    if (g.things.get(si.key) === si) g.things.delete(si.key);
    this.index(g);
    g.stale = true;
    this.count();
  }

  releasable(inst: ExternalInstance): ExternalCol[] {
    const { R } = this.io;
    const un = this.io.unwritten();
    return inst.cols.filter((c) => this.inWindow(c.x, c.y) && !un.some(([ux, uy]) => c.x >= ux && c.x < ux + R && c.y >= uy && c.y < uy + R));
  }

  // ---- inside ----------------------------------------------------------------------------------------------------

  private regionKey(wx: number, wy: number): string {
    const { R } = this.io;
    return `${Math.floor(wx / R)},${Math.floor(wy / R)}`;
  }

  /** a grid's things claimed over the window's written land now (an edit) — owed till the columns aren't held */
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
  }

  /** the grids overlapping a window rectangle, as claim jobs (their buffers made where stale) */
  private jobsOver(x0: number, y0: number, x1: number, y1: number): (GridClaimJob & { g: StaticGrid })[] {
    const out: (GridClaimJob & { g: StaticGrid })[] = [];
    for (const g of this.grids) {
      if (!g.things.size) continue;
      const p = g.place();
      const [bx0, by0, bx1, by1] = g.bounds;
      if (x1 <= bx0 + p.dx || x0 >= bx1 + p.dx || y1 <= by0 + p.dy || y0 >= by1 + p.dy) continue;
      const j = this.job(g);
      if (j) out.push(j);
    }
    return out;
  }

  private job(g: StaticGrid): (GridClaimJob & { g: StaticGrid }) | null {
    if (g.stale) this.upload(g);
    if (!g.buf || !g.nCols) return null;
    const p = g.place();
    return { g, buf: g.buf, nCols: g.nCols, gx: p.dx, gy: p.dy, gz: p.dz };
  }

  /** the grid's columns and spans to its buffer (ColumnApply.claimGrids' layout): its things' spans in the grid's order */
  private upload(g: StaticGrid): void {
    g.stale = false;
    // (a column's spans in the grid's order: its things in order, each thing's spans there in order)
    const cols = new Map<number, ExternalCol[]>();
    const aux = new Map<ExternalCol, number>();
    let nSpans = 0;
    for (const inst of g.things.values())
      for (const c of inst.local) {
        const k = colKey(c.x, c.y);
        const l = cols.get(k);
        if (l) l.push(c);
        else cols.set(k, [c]);
        aux.set(c, inst.fallback & 0xff);
        nSpans++;
      }
    g.nCols = cols.size;
    if (!cols.size) return;
    const words = new Uint32Array(cols.size * 4 + nSpans * 4);
    const fw = new Float32Array(words.buffer);
    const iw = new Int32Array(words.buffer);
    let s = 0;
    const spanBase = cols.size * 4;
    let i = 0;
    for (const l of cols.values()) {
      const first = s;
      for (const c of l) {
        fw[spanBase + s * 4] = c.z0;
        fw[spanBase + s * 4 + 1] = c.z1;
        words[spanBase + s * 4 + 2] = aux.get(c)!;
        s++;
      }
      iw[i * 4] = l[0].x;
      iw[i * 4 + 1] = l[0].y;
      words[i * 4 + 2] = first;
      words[i * 4 + 3] = s - first;
      i++;
    }
    if (!g.buf || g.buf.size < words.byteLength) {
      g.buf?.destroy();
      g.buf = this.io.device.createBuffer({ label: `static claims ${g.name}`, size: Math.max(256, words.byteLength * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    this.io.device.queue.writeBuffer(g.buf, 0, words);
    this.stats.uploadKB += words.byteLength / 1024;
  }

  /** the grid's column index and bounds made again from its things */
  private index(g: StaticGrid): void {
    g.byCol.clear();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const inst of g.things.values())
      for (const c of inst.local) {
        const k = colKey(c.x, c.y);
        const l = g.byCol.get(k);
        if (!l) g.byCol.set(k, [inst]);
        else if (l[l.length - 1] !== inst) l.push(inst);
        x0 = Math.min(x0, c.x);
        y0 = Math.min(y0, c.y);
        x1 = Math.max(x1, c.x + 1);
        y1 = Math.max(y1, c.y + 1);
      }
    g.bounds = g.byCol.size ? [x0, y0, x1, y1] : [0, 0, 0, 0];
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

  private count(): void {
    let n = 0;
    let c = 0;
    for (const g of this.grids) {
      n += g.things.size;
      c += g.byCol.size;
    }
    this.stats.things = n;
    this.stats.columns = c;
  }

  /**
   * (scripts: staticclaims.mjs) The GPU's columns (the layers read back whole) against the static things: every column of
   * one in the window, on written land, is External or ground over each of its spans (claimed, or buried where ground
   * was); and the External cells in the window that no claim covers (orphans to be).
   */
  audit(slots: Uint32Array, packed: PackedWorld): { checked: number; held: number; missing: { x: number; y: number; id: number; col: Interval[] }[]; external: number; unclaimed: number } {
    const reg = this.io.registry();
    const out = { checked: 0, held: 0, missing: [] as { x: number; y: number; id: number; col: Interval[] }[], external: 0, unclaimed: 0 };
    for (const inst of this.byId.values())
      for (const c of inst.cols) {
        if (!this.inWindow(c.x, c.y) || !this.judged(c.x, c.y, Infinity)) continue;
        out.checked++;
        const col = readColumn(packed, slots, c.x, c.y);
        if (freeSpans(col, c.z0, c.z1).length === 0) out.held++;
        else if (out.missing.length < 12) out.missing.push({ x: c.x, y: c.y, id: inst.id, col });
      }
    const claimed = reg?.claimedSpans() ?? new Map<number, { z0: number; z1: number }[]>();
    const { w, h } = this.io.dims;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!this.judged(x, y, Infinity)) continue;
        const col = readColumn(packed, slots, x, y);
        const mine = claimed.get(y * 65536 + x) ?? [];
        for (const iv of col) {
          if (iv.mat !== MAT.External) continue;
          out.external++;
          if (!mine.some((s) => s.z0 < iv.z1 - 1e-3 && s.z1 > iv.z0 + 1e-3)) out.unclaimed++;
        }
      }
    return out;
  }

  dispose(): void {
    for (const g of this.grids) g.buf?.destroy();
    this.grids = [];
    this.byId.clear();
  }
}

/** (tests) the spans of a static grid's column as claimGrid takes them: its things in the grid's order */
export function gridColumnSpans(g: StaticGrid, x: number, y: number): { z0: number; z1: number; aux: number }[] {
  const out: { z0: number; z1: number; aux: number }[] = [];
  for (const inst of g.things.values()) for (const c of inst.local) if (c.x === x && c.y === y) out.push({ z0: c.z0, z1: c.z1, aux: inst.fallback & 0xff });
  return out;
}
