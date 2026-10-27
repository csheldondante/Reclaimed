// Falling pieces in the columns' own format (round 86). The user, testing on the phone: "The actual collum has a
// long delay and then converts to voxels before collapsing. I strongly recommend we simulate as voxels but split the
// mesh and have the rock column fall" — and before (round 83): "is there a reason we don't use the column format for
// all the voxel based free bodies". Pieces only ever fell straight down (bodies.ts, round 21: no tumbling), so a
// piece is its runs, column by column, and an offset: while it falls its runs are written into the window's columns
// at that offset every frame — the field mesh meshes it as the ground it was (the same look, the same shading, the
// hybrid's voxel chunks), split from the ground under it, moving smoothly (the intervals' heights are fractional).
// No cube draw, no projection, no copy written back when it lands: it is the ground already.
//
// The CPU's copy of the layers (what the integrity system judges and the pieces fall onto) holds every column
// without the pieces falling in it (`base`); the GPU's columns are base + the pieces at their offsets. A column a
// piece falls through is the pieces' while they fall: what the sim does there meanwhile is written over.

import { MATERIALS, MatState } from '../world/materials';
import type { Interval } from '../world/layout';

/** one column of a piece: its runs (world z, where it broke free) */
export interface ColPiece {
  x: number;
  y: number;
  ivs: Interval[];
}

export interface FallingBody {
  id: number;
  cols: ColPiece[];
  /** its columns by key (y · 65536 + x) */
  colAt: Map<number, ColPiece>;
  /** how far it has fallen (cells, ≤ 0) */
  dz: number;
  /** its speed (cells/s, ≤ 0: it only falls) */
  vz: number;
  age: number;
  /** cells of it */
  cells: number;
  /** the columns it covers: x0, y0, x1, y1 (cells, inclusive) */
  box: [number, number, number, number];
  /** what it is mostly made of */
  mat: number;
}

/** A piece that came down: where it hit first (column x, y; z its bottom there) and how fast. */
export interface Landing {
  body: FallingBody;
  speed: number;
  at: [number, number, number];
}

// the feel (bodies.ts, rounds 20–21: low gravity with air drag and a top speed — "fall more slowly… feel bigger")
const G = 10; // cells/s²
const AIR_DRAG = 0.35; // 1/s
const MAX_V = 4; // cells/s
/** pieces land regardless after this long (s) */
const MAX_AGE = 24;

const key = (x: number, y: number) => y * 65536 + x;
const loose = (m: number) => MATERIALS[m]?.state === MatState.Granular;

/** a column's intervals with the ranges [z0, z1) taken out */
export function subtract(col: Interval[], cut: { z0: number; z1: number }[]): Interval[] {
  let out = col;
  for (const c of cut) {
    const next: Interval[] = [];
    for (const iv of out) {
      if (iv.z1 <= c.z0 + 1e-4 || iv.z0 >= c.z1 - 1e-4) next.push(iv);
      else {
        if (iv.z0 < c.z0 - 1e-4) next.push({ ...iv, z1: c.z0 });
        if (iv.z1 > c.z1 + 1e-4) next.push({ ...iv, z0: c.z1 });
      }
    }
    out = next;
  }
  return out;
}

export class ColumnBodies {
  list: FallingBody[] = [];
  /** per column: what it holds without the pieces falling in it */
  private base = new Map<number, Interval[]>();
  /** per column: the pieces with runs there */
  private users = new Map<number, FallingBody[]>();
  private nextId = 1;

  constructor(
    /** the CPU copy's column */
    private readCpu: (x: number, y: number) => Interval[],
    /** write a column to the CPU copy only */
    private writeCpu: (x: number, y: number, col: Interval[]) => void,
    /** write a column to the GPU only */
    private writeGpuCol: (x: number, y: number, col: Interval[]) => void,
    /** (round 87) the window's top (window z): what of a piece lands above it goes back above the window */
    private zTop = Infinity,
    /** ... through this (Streamer.outside): a column's runs over zTop, window z */
    private putAbove?: (x: number, y: number, ivs: Interval[]) => void,
  ) {}

  /**
   * A piece breaks free: its runs (whole runs, fractional ends kept) come out of the CPU copy — the GPU's columns
   * keep them, at offset 0 — with the loose ground lying on them (it rides down on the piece).
   */
  spawn(cols: ColPiece[]): FallingBody | null {
    const byCol = new Map<number, ColPiece>();
    for (const c of cols) {
      const k = key(c.x, c.y);
      const e = byCol.get(k);
      if (e) e.ivs.push(...c.ivs.map((iv) => ({ ...iv })));
      else byCol.set(k, { x: c.x, y: c.y, ivs: c.ivs.map((iv) => ({ ...iv })) });
    }
    if (!byCol.size) return null;
    const b: FallingBody = { id: this.nextId++, cols: [], colAt: new Map(), dz: 0, vz: 0, age: 0, cells: 0, box: [Infinity, Infinity, -Infinity, -Infinity], mat: 0 };
    const mats = new Map<number, number>();
    for (const [k, c] of byCol) {
      const cur = this.base.get(k) ?? this.readCpu(c.x, c.y);
      // (the loose ground lying on its runs goes with it)
      const sorted = [...cur].sort((a, b) => a.z0 - b.z0);
      for (const iv of [...c.ivs]) {
        let top = iv.z1;
        for (const o of sorted)
          if (loose(o.mat) && Math.abs(o.z0 - top) < 1e-3 && !c.ivs.some((x) => Math.abs(x.z0 - o.z0) < 1e-3)) {
            c.ivs.push({ ...o });
            top = o.z1;
          }
      }
      c.ivs.sort((a, b) => a.z0 - b.z0);
      const base = subtract(cur, c.ivs);
      this.base.set(k, base);
      this.writeCpu(c.x, c.y, base);
      const u = this.users.get(k) ?? [];
      u.push(b);
      this.users.set(k, u);
      b.cols.push(c);
      b.colAt.set(k, c);
      for (const iv of c.ivs) {
        const n = iv.z1 - iv.z0;
        b.cells += n;
        mats.set(iv.mat, (mats.get(iv.mat) ?? 0) + n);
      }
      b.box = [Math.min(b.box[0], c.x), Math.min(b.box[1], c.y), Math.max(b.box[2], c.x), Math.max(b.box[3], c.y)];
    }
    let most = -1;
    for (const [m, n] of mats) if (n > most) [b.mat, most] = [m, n];
    this.list.push(b);
    return b;
  }

  /** the top of what holds a run whose bottom is at z in column k: the base's, or another piece's (not b's) */
  private support(k: number, z: number, b: FallingBody): number {
    let s = 0;
    for (const iv of this.base.get(k) ?? []) if (iv.z1 <= z + 1e-3) s = Math.max(s, iv.z1);
    for (const o of this.users.get(k) ?? []) {
      if (o === b) continue;
      const c = o.colAt.get(k);
      if (c) for (const iv of c.ivs) if (iv.z1 + o.dz <= z + 1e-3) s = Math.max(s, iv.z1 + o.dz);
    }
    return s;
  }

  /** Every piece falls a step (its runs written at their new heights, when `write`: the phone writes every other frame); what came down this step is returned (still in the list: `commit` it). */
  update(dt: number, write = true): Landing[] {
    const landed: Landing[] = [];
    if (!this.list.length) return landed;
    const touched = new Set<number>();
    for (const b of this.list) {
      b.age += dt;
      const v = Math.max(-MAX_V, (b.vz - G * dt) * Math.exp(-AIR_DRAG * dt));
      // the gap under it: the least over its runs
      let gap = Infinity;
      let at: [number, number, number] = [0, 0, 0];
      for (const c of b.cols) {
        const k = key(c.x, c.y);
        for (const iv of c.ivs) {
          const z = iv.z0 + b.dz;
          const g = Math.max(0, z - this.support(k, z, b));
          if (g < gap) {
            gap = g;
            at = [c.x, c.y, z];
          }
        }
      }
      const move = -v * dt;
      if (move >= gap || b.age > MAX_AGE) {
        b.dz -= Math.min(gap, move);
        at[2] -= Math.min(gap, move);
        landed.push({ body: b, speed: -v, at });
      } else {
        b.dz -= move;
        b.vz = v;
      }
      for (const c of b.cols) touched.add(key(c.x, c.y));
    }
    if (write) for (const k of touched) this.writeGpu(k);
    return landed;
  }

  /** column k on the GPU: its base and every piece in it at its offset */
  private writeGpu(k: number): void {
    const x = k % 65536;
    const y = Math.floor(k / 65536);
    const col = [...(this.base.get(k) ?? [])];
    for (const o of this.users.get(k) ?? []) {
      const c = o.colAt.get(k);
      // (what of it is over the window's top isn't the window's: drawn again once it falls into it)
      if (c) for (const iv of c.ivs) if (iv.z0 + o.dz < this.zTop) col.push({ z0: iv.z0 + o.dz, z1: Math.min(iv.z1 + o.dz, this.zTop), mat: iv.mat });
    }
    col.sort((a, b) => a.z0 - b.z0);
    this.writeGpuCol(x, y, col);
  }

  /** A piece that came down is ground again: its runs (as they are now — the impact may have taken some) into its columns, the CPU's copy too. */
  commit(b: FallingBody): void {
    this.list = this.list.filter((o) => o !== b);
    for (const c of b.cols) {
      const k = key(c.x, c.y);
      const base = [...(this.base.get(k) ?? this.readCpu(c.x, c.y))];
      const over: Interval[] = [];
      for (const iv of c.ivs) {
        if (iv.z1 - iv.z0 <= 1e-3) continue;
        const z0 = iv.z0 + b.dz;
        const z1 = iv.z1 + b.dz;
        if (z0 < this.zTop) base.push({ z0, z1: Math.min(z1, this.zTop), mat: iv.mat });
        if (z1 > this.zTop + 1e-3) over.push({ z0: Math.max(z0, this.zTop), z1, mat: iv.mat });
      }
      if (over.length) this.putAbove?.(c.x, c.y, over);
      base.sort((a, b) => a.z0 - b.z0);
      const u = (this.users.get(k) ?? []).filter((o) => o !== b);
      this.base.set(k, base);
      this.users.set(k, u);
      this.writeCpu(c.x, c.y, base);
      this.writeGpu(k);
      if (!u.length) {
        this.users.delete(k);
        this.base.delete(k);
      }
    }
  }

  /**
   * The CPU's copy was read back again: the columns pieces are falling through came back with them in at some
   * offset — they're the base again (what the GPU holds there is ours anyway).
   */
  restoreCpu(): void {
    for (const [k, base] of this.base) this.writeCpu(k % 65536, Math.floor(k / 65536), base);
  }

  /** Forget every piece (the window moved, or its columns were all written again): what the GPU has stays. */
  clear(): FallingBody[] {
    const was = this.list;
    this.list = [];
    this.base.clear();
    this.users.clear();
    return was;
  }
}
