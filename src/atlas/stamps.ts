// ---- atlas/stamps.ts --------------------------------------------------------
// (round 102, `gpugen`) What's built into a region's land as it's made — the settlements' buildings, walls, fields
// and quarry pits (settle/settlements.ts), a run's stage pieces (story/stage-land.ts) — as a list of operations a
// column, in whole 1/256ths of a cell. The systems that build (Atlas.stampHooks) only say what goes where; the land
// is changed by whichever path makes it: the GPU's (atlas/finish.wgsl, the default) or the CPU's (applyStamps, with
// ?gpugen=0) — the same operations on the same whole numbers, so the same columns. Encoded (encode) as a header of
// two words a column (its first word, its count) and the words:
//   PLAN    [1 | n << 8 | bare << 7 | hole << 6, lo, cut, h0, h1] then n × [z0, z1, mat]: what stands above `lo`
//           goes, the ground let down by `cut`, a gap h0..h1 cut through it, the plan's intervals on it; bare: no plants
//   ADD     [2, dz, mat, mark + 1 (0: none)]: dz of mat laid on the top; the top before it noted as mark `mark`
//   VEGMAX  [3, v (f32 bits)]: the plants at least v
//   BARE    [4]: no plants
import { addTop, lowerTop, type Interval } from '../world/layout';

export const OP = { plan: 1, add: 2, vegMax: 3, bare: 4 } as const;
const Q = 256;
const q = (z: number) => Math.round(z * Q);
const f1 = new Float32Array(1);
const u1 = new Uint32Array(f1.buffer);

export class StampOps {
  /** per column (row-major in the region), its words */
  readonly cols = new Map<number, number[]>();
  /** marks asked for (ADD's), and who's told what they were (the tops, world z) once the land is made */
  marks = 0;
  readonly onMarks: ((m: Float32Array) => void)[] = [];
  constructor(readonly w: number, readonly h: number) {}

  private at(i: number): number[] {
    let c = this.cols.get(i);
    if (!c) this.cols.set(i, (c = []));
    return c;
  }

  /** a settlement plan's column (world z, cells) */
  plan(i: number, lo: number, ivs: { z0: number; z1: number; mat: number }[], bare: boolean, cut = 0, hole?: [number, number]): void {
    const c = this.at(i);
    c.push(OP.plan | (ivs.length << 8) | (bare ? 128 : 0) | (hole ? 64 : 0), q(lo), q(cut), hole ? q(hole[0]) : 0, hole ? q(hole[1]) : 0);
    for (const iv of ivs) c.push(q(iv.z0), q(iv.z1), iv.mat);
  }

  /** dz of mat on the top (cells); `mark`: the top before it is wanted — its mark's index */
  add(i: number, dz: number, mat: number, mark = false): number {
    const m = mark ? this.marks++ : -1;
    this.at(i).push(OP.add, q(dz), mat, m + 1);
    return m;
  }

  vegMax(i: number, v: number): void {
    f1[0] = v;
    this.at(i).push(OP.vegMax, u1[0]);
  }

  bare(i: number): void {
    this.at(i).push(OP.bare);
  }

  get empty(): boolean {
    return this.cols.size === 0;
  }

  /** the header (two words a column: its first word, its count — from the buffer's start) and the words */
  encode(): Uint32Array {
    const N = this.w * this.h;
    let n = 0;
    for (const c of this.cols.values()) n += c.length;
    const out = new Uint32Array(N * 2 + n);
    let o = N * 2;
    for (const [i, c] of [...this.cols].sort((a, b) => a[0] - b[0])) {
      out[i * 2] = o;
      out[i * 2 + 1] = c.length;
      for (const v of c) out[o++] = v >>> 0;
    }
    return out;
  }

  /** the marks made (the tops before each ADD that asked, world z) */
  tell(m: Float32Array): void {
    for (const f of this.onMarks) f(m);
  }
}

/** Run the operations on a region's columns (world z) and plants, as finish.wgsl does: the marks noted in `marks`. */
export function applyStamps(ops: StampOps, land: { cols: Interval[][]; vegetation: Float32Array; surface: Float32Array }, marks: Float32Array): void {
  for (const [i, w] of ops.cols) {
    let col = land.cols[i];
    for (let k = 0; k < w.length; ) {
      const op = w[k] & 63;
      if (op === OP.plan) {
        const n = w[k] >>> 8;
        const bare = (w[k] & 128) !== 0;
        const hole = (w[k] & 64) !== 0;
        const lo = (w[k + 1] | 0) / Q;
        const cut = (w[k + 2] | 0) / Q;
        const h0 = (w[k + 3] | 0) / Q;
        const h1 = (w[k + 4] | 0) / Q;
        k += 5;
        // (what stands above the ground there goes; the plan's goes on it)
        const keep: Interval[] = [];
        for (const iv of col) {
          if (iv.z0 >= lo) continue;
          keep.push(iv.z1 > lo ? { ...iv, z1: lo } : iv);
        }
        // (a well's shaft, a quarry's benches: the ground let down; an adit: a gap through it, rock over it)
        if (cut) lowerTop(keep, cut);
        if (hole)
          for (let j = keep.length - 1; j >= 0; j--) {
            const iv = keep[j];
            if (iv.z1 <= h0 || iv.z0 >= h1) continue;
            const parts: Interval[] = [];
            if (iv.z0 < h0) parts.push({ ...iv, z1: h0 });
            if (iv.z1 > h1) parts.push({ ...iv, z0: h1 });
            keep.splice(j, 1, ...parts);
          }
        for (let j = 0; j < n; j++, k += 3) keep.push({ z0: (w[k] | 0) / Q, z1: (w[k + 1] | 0) / Q, mat: w[k + 2] });
        col = keep;
        if (bare) land.vegetation[i] = 0;
      } else if (op === OP.add) {
        const m = w[k + 3];
        if (m) marks[m - 1] = col.length ? col[col.length - 1].z1 : 0;
        addTop(col, (w[k + 1] | 0) / Q, w[k + 2]);
        k += 4;
      } else if (op === OP.vegMax) {
        u1[0] = w[k + 1];
        land.vegetation[i] = Math.max(land.vegetation[i], f1[0]);
        k += 2;
      } else if (op === OP.bare) {
        land.vegetation[i] = 0;
        k += 1;
      } else throw new Error(`stamps: an unknown operation ${op} at column ${i}`);
    }
    land.cols[i] = col;
    land.surface[i] = col.length ? col[col.length - 1].z1 : 0;
  }
}
