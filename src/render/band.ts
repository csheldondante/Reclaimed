// The band outside the window (round 79, the user: "Why not stream vertical identical to lateral …
// It will just render different intervals of the same columns right?"). The streamed window holds
// oz .. oz + zMax of every column live (the sim's z: 8 bits for its surface); what lies above and below
// it is kept on the CPU (Streamer.outside, world z). The band packs that into a second layers buffer in
// window z (over zMax above the window, under 0 below it) with its own chunk table, and a second field
// mesh draws it — the same mesher, its samples spanning the world's height, its quads only outside
// [0, zMax). It doesn't tick: frozen, as the regions beside the window are. A cliff taller than the
// window is drawn whole; from a mesa's top the plain far under the window shows.
//
// The seam: the window's mesh doesn't close a run cut at its top (it goes on up — fieldmesh.wgsl
// colDist), and the band's runs cut at the window's edges reach SEAM cells across, so each mesh's field
// is the same either side of the seam and the two meet.

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import { CHUNK, SLOT_WORDS, fitColumn, packColumn, type Interval } from '../world/layout';
import { FieldMesh } from './fieldmesh';

/** slots a column in the band (more are merged: layout.ts fitColumn) */
const BAND_K = 12;
/** how far a run cut at the window's edge reaches into it in the band (cells) */
const SEAM = 6;

export class OutsideBand {
  readonly mesh: FieldMesh;
  readonly chunks: GPUBuffer;
  readonly layers: GPUBuffer;
  private table: Uint32Array;
  /** columns packed at the last update, and how many were merged to fit */
  stats = { columns: 0, runs: 0, fitted: 0, ms: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    profiler: Profiler,
    /** the world's height (the atlas's zTop) */
    zSpan: number,
    /** chunks rebuilt a frame (the quality's meshSlots, at most 3) */
    slots = 3,
  ) {
    const { w, h } = world;
    const cx = w / CHUNK;
    const cy = h / CHUNK;
    this.table = new Uint32Array(cx * cy * 2);
    for (let c = 0; c < cx * cy; c++) this.table.set([c * CHUNK * CHUNK * BAND_K, BAND_K], c * 2);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.chunks = world.buf('band chunks', this.table.byteLength, S);
    device.queue.writeBuffer(this.chunks, 0, this.table);
    this.layers = world.buf('band layers', w * h * BAND_K * SLOT_WORDS * 4, S);
    // (no structures out there: an empty frame table)
    const frames = world.buf('band frames', world.strFrames.size, S);
    const vox = world.buf('band vox', 16, S);
    this.mesh = new FieldMesh(device, world, profiler, true, 2, { name: 'band', chunks: this.chunks, layers: this.layers, frames, vox, zSpan, slots });
  }

  /** What's outside every column (world z, Streamer.outside) packed in window z at oz. */
  update(outside: Interval[][], oz: number, zMax: number): void {
    if (!this.mesh.on) return;
    const t0 = performance.now();
    const { w, h } = this.world;
    const cx = w / CHUNK;
    const all: number[] = [];
    for (let c = 0; c < cx * (h / CHUNK); c++) all.push(c);
    this.stats = { columns: 0, runs: 0, fitted: 0, ms: 0 };
    this.packChunks(outside, oz, zMax, all);
    this.fresh = [];
    this.mesh.setBand(oz, zMax);
    this.oz = oz;
    this.stats.ms = +(performance.now() - t0).toFixed(1);
  }

  /**
   * The window slid sideways (dx, dy columns, whole chunks; round 80): the chunks' pages go with the land
   * (the chunk table, as the streamer's), the ones the land came into are packed fresh from what's outside
   * them — not every column again (30–40 ms on a desktop where the window is off the ground: a phone's hitch).
   */
  shift(dx: number, dy: number): void {
    if (!this.mesh.on) return;
    const { w, h } = this.world;
    const cx = w / CHUNK;
    const cy = h / CHUNK;
    const dcx = dx / CHUNK;
    const dcy = dy / CHUNK;
    const old = this.table.slice();
    const free: number[] = [];
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const ni = i - dcx;
        const nj = j - dcy;
        if (ni < 0 || nj < 0 || ni >= cx || nj >= cy) free.push(old[(j * cx + i) * 2]);
      }
    const fresh: number[] = [];
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const si = i + dcx;
        const sj = j + dcy;
        const c = j * cx + i;
        if (si >= 0 && sj >= 0 && si < cx && sj < cy) this.table[c * 2] = old[(sj * cx + si) * 2];
        else {
          this.table[c * 2] = free.pop()!;
          fresh.push(c);
        }
      }
    this.device.queue.writeBuffer(this.chunks, 0, this.table);
    // (the fresh pages empty until what's outside them is known: packFresh, once the regions are in)
    const empty = new Uint32Array(CHUNK * CHUNK * BAND_K * SLOT_WORDS);
    for (const c of fresh) this.device.queue.writeBuffer(this.layers, this.table[c * 2] * SLOT_WORDS * 4, empty);
    this.mesh.packed();
    this.fresh.push(...fresh);
  }

  /** the chunks a slide brought in, packed (Streamer, once their regions are written) */
  packFresh(outside: Interval[][], zMax: number): void {
    if (!this.mesh.on || !this.fresh.length) return;
    const t0 = performance.now();
    this.stats = { columns: 0, runs: 0, fitted: 0, ms: 0 };
    this.packChunks(outside, this.oz, zMax, this.fresh);
    this.fresh = [];
    this.stats.ms = +(performance.now() - t0).toFixed(1);
  }

  /** (round 87) the chunks holding these columns packed again (what's outside them changed: Streamer.takeAbove) */
  packColumns(outside: Interval[][], oz: number, zMax: number, cols: [number, number][]): void {
    if (!this.mesh.on) return;
    const cx = this.world.w / CHUNK;
    const chunks = new Set<number>();
    for (const [x, y] of cols) chunks.add(Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK));
    this.packChunks(outside, oz, zMax, [...chunks]);
  }

  private fresh: number[] = [];

  /** the window's oz the band is packed at */
  private oz = 0;

  /** chunks (indices) packed into their pages */
  private packChunks(outside: Interval[][], oz: number, zMax: number, chunks: number[]): void {
    const { w } = this.world;
    const cx = w / CHUNK;
    const page = new Uint32Array(CHUNK * CHUNK * BAND_K * SLOT_WORDS);
    for (const c of chunks) {
      page.fill(0);
      const x0 = (c % cx) * CHUNK;
      const y0 = Math.floor(c / cx) * CHUNK;
      for (let ly = 0; ly < CHUNK; ly++)
        for (let lx = 0; lx < CHUNK; lx++) {
          const src = outside[(y0 + ly) * w + x0 + lx];
          if (!src.length) continue;
          const col: Interval[] = src.map((iv) => {
            let z0 = iv.z0 - oz;
            let z1 = iv.z1 - oz;
            // (cut at the window's top or bottom: reaching across the seam)
            if (Math.abs(z0 - zMax) < 1e-3) z0 = zMax - SEAM;
            if (Math.abs(z1) < 1e-3) z1 = SEAM;
            return { z0, z1, mat: iv.mat };
          });
          if (fitColumn(col, BAND_K)) this.stats.fitted++;
          page.set(packColumn(col, BAND_K), (ly * CHUNK + lx) * BAND_K * SLOT_WORDS);
          this.stats.columns++;
          this.stats.runs += col.length;
        }
      this.device.queue.writeBuffer(this.layers, this.table[c * 2] * SLOT_WORDS * 4, page);
      this.mesh.packed();
    }
  }
}
